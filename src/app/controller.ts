import { registerArchiveActions } from "../features/archive/archive-bridge.ts";
import { createAppRuntime } from "./app-runtime.ts";
import { download } from "../features/data-transfer/browser-download.ts";
import { registerCaptureHeaderActions } from "../features/capture/capture-header-bridge.ts";
import { registerCaptureStorageActions } from "../features/capture/capture-storage-bridge.ts";
import {
	EMPTY_CANONICALIZATION_DIALOG_SNAPSHOT,
	getCanonicalizationDialogSnapshot,
	publishCanonicalizationDialogSnapshot,
	registerCanonicalizationDialogActions
} from "../features/capture/canonicalization-bridge.ts";
import { rebuildPreview, visibleByteEntries } from "../features/capture/capture-framing.ts";
import { createCaptureController } from "../features/capture/capture-controller.ts";
import { createDataTransferController } from "../features/data-transfer/data-transfer.ts";
import { publishDialogCommand, registerDialogActions } from "../features/dialogs/dialog-bridge.ts";
import { registerMessageStreamActions } from "../features/message-stream/message-stream-bridge.ts";
import { registerNotesActions } from "../features/notes/notes-bridge.ts";
import { createBeforeUnloadHandler } from "./unload-lifecycle.ts";
import { createSendController, type SendController } from "../features/send/send-controller.ts";
import { createSerialController, type SerialController } from "../features/transport/serial-controller.ts";
import { createSnapshotRuntime } from "./snapshot-runtime.ts";
import { registerSendActions } from "../features/send/send-bridge.ts";
import { registerTransportActions } from "../features/transport/transport-bridge.ts";
import { getViewStateSnapshot } from "../shared/view-state-bridge.ts";
import { applicationStore } from "../shared/application-store.ts";
import type { ArchiveDataLayer } from "../data/archive-data-layer.ts";
import {
	EMPTY_PERSISTENCE_ERROR,
	getPersistenceErrorSnapshot,
	publishPersistenceError,
	registerPersistenceErrorActions
} from "../shared/persistence-error-bridge.ts";

export type ControllerLifecycle = {
	beforeUnload: (event?: { preventDefault: () => void; returnValue?: string }) => void;
};

let initializedController: ControllerLifecycle | undefined;

export function initializeController(options: { archive?: ArchiveDataLayer } = {}): ControllerLifecycle {
	if (initializedController) return initializedController;

	const runtime = createAppRuntime({ archive: options.archive });
	let transport!: SerialController;
	let sendController!: SendController;
	let retrySendPersistence: (() => void) | null = null;
	let openCanonicalizationDialog = (_captureId: string): void => {};
	const snapshots = createSnapshotRuntime({
		capture: runtime.capture,
		getTransport: () => transport,
		getSendController: () => sendController,
		getViewStateSnapshot
	});

	transport = createSerialController({
		capture: runtime.capture,
		state: runtime.state,
		archiveCommands: options.archive?.commands,
		showToast: runtime.showToast,
		publishCaptureHeaderState: snapshots.publishCaptureHeaderState,
		publishFramingToolbarState: snapshots.publishFramingToolbarState,
		publishTransportState: view => applicationStore.send({ type: "transport/view-updated", view }),
		publishTransportWorkflow: event => applicationStore.send(event),
		renderMessages: snapshots.renderMessages,
		stopSendQueue: () => sendController?.stopSendQueue(),
		publishSendState: snapshots.publishSendState,
		publishPersistenceError: error => publishPersistenceError(error ? {
			visible: true,
			captureId: error.captureId,
			message: error.message,
			canRetry: true,
			canExportRecovery: true
		} : EMPTY_PERSISTENCE_ERROR),
		isCanonicalCapture: runtime.isCanonicalCapture,
		isCaptureConversionLocked: runtime.isCaptureConversionLocked,
		recordingWriter: runtime.captureWriter ? {
			startSession: async (captureId, sessionId) => {
				if (!await runtime.ensureCanonicalCapture(captureId)) throw new Error("capture is not canonical");
				await runtime.waitForCaptureWrite(captureId);
				return runtime.captureWriter!.startSession({ captureId, sessionId });
			},
			appendChunk: request => runtime.captureWriter!.appendChunk(request),
			finalizeSession: (captureId, sessionId, expectedDataRevision) =>
				runtime.captureWriter!.finalizeSession({ captureId, sessionId, expectedDataRevision }),
			refreshCapture: runtime.refreshCapture
		} : undefined
	});

	registerPersistenceErrorActions({
		retry: () => {
			if (getPersistenceErrorSnapshot().captureId === null && retrySendPersistence) retrySendPersistence();
			else void transport.retryPersistence();
		},
		exportRecovery: () => {
			const capture = transport.recoveryDocument();
			if (!capture) return;
			download(
				JSON.stringify(capture, null, 2),
				`bus-lens-${String(capture.id ?? "capture")}-recovery.json`,
				"application/json"
			);
		},
		dismiss: () => publishPersistenceError(EMPTY_PERSISTENCE_ERROR)
	});

	sendController = createSendController({
		state: runtime.state,
		capture: runtime.capture,
		transport,
		archiveCommands: options.archive?.commands,
		showToast: runtime.showToast,
		confirm: message => confirm(message),
		publishSendState: snapshots.publishSendState,
		publishSendWorkflow: event => applicationStore.send(event),
		publishPersistenceError: error => {
			if (!error) {
				retrySendPersistence = null;
				publishPersistenceError(EMPTY_PERSISTENCE_ERROR);
				return;
			}
			retrySendPersistence = () => { void sendController.retryPersistence(); };
			publishPersistenceError({
				visible: true,
				captureId: null,
				message: error.message,
				canRetry: error.canRetry,
				canExportRecovery: false
			});
		}
	});

	const captureController = createCaptureController({
		state: runtime.state,
		capture: runtime.capture,
		getActiveId: runtime.getActiveId,
		setActiveId: runtime.setActiveId,
		setSelectedCaptureId: captureId => applicationStore.send({ type: "capture/selected-changed", captureId }),
		trackCaptureWrite: runtime.trackCaptureWrite,
		archiveCommands: options.archive?.commands,
		render: snapshots.render,
		renderMessages: snapshots.renderMessages,
		showToast: runtime.showToast,
		confirm: message => confirm(message),
		transport,
		publishDialogCommand,
		captureWriter: runtime.captureWriter,
		isCanonicalCapture: runtime.isCanonicalCapture,
		waitForCaptureWrite: runtime.waitForCaptureWrite,
		isCaptureConversionLocked: runtime.isCaptureConversionLocked,
		setCaptureStorageStatus: runtime.setCaptureStorageStatus,
		openCanonicalization: captureId => openCanonicalizationDialog(captureId),
		refreshCapture: runtime.refreshCapture,
		reportPersistenceFailure: (captureId, error) => publishPersistenceError({
			visible: true,
			captureId,
			message: error instanceof Error ? error.message : String(error),
			canRetry: false,
			canExportRecovery: false
		})
	});

	let canonicalizationToken = 0;
	let canonicalizationStarting = false;

	function publishCanonicalization(update: Partial<ReturnType<typeof getCanonicalizationDialogSnapshot>>): void {
		publishCanonicalizationDialogSnapshot({ ...getCanonicalizationDialogSnapshot(), ...update });
	}

	function closeCanonicalizationDialog(): void {
		canonicalizationToken += 1;
		canonicalizationStarting = false;
		publishCanonicalizationDialogSnapshot(EMPTY_CANONICALIZATION_DIALOG_SNAPSHOT);
	}

	function openCanonicalization(captureId: string): void {
		const item = runtime.state.captures.find(capture => String(capture.id) === String(captureId));
		if (!item) return;
		const status = runtime.getCaptureStorageStatus(captureId) ?? item.storageStatus;
		if (status === "canonical" || status === "converting") return;
		const token = ++canonicalizationToken;
		publishCanonicalizationDialogSnapshot({
			open: true,
			captureId: String(captureId),
			captureName: String(item.name ?? "Untitled capture"),
			preflight: null,
			job: null,
			loading: true,
			starting: false,
			error: null
		});
		void runtime.getCanonicalizationPreflight(captureId).then(preflight => {
			const recordingActive = transport.isRecording();
			const guardedPreflight = recordingActive
				? {
						...preflight,
						recordingActive: true,
						isRecording: true,
						eligible: false,
						estimatedEligibility: "recording-active" as const,
						error: "Stop recording before converting this capture"
					}
				: preflight;
			if (token !== canonicalizationToken) return;
			publishCanonicalization({ preflight: guardedPreflight, loading: false, error: guardedPreflight.error || null });
		}).catch(error => {
			if (token !== canonicalizationToken) return;
			publishCanonicalization({ loading: false, error: error instanceof Error ? error.message : String(error) });
		});
	}

	openCanonicalizationDialog = openCanonicalization;

	async function downloadLegacyBackup(): Promise<void> {
		const captureId = getCanonicalizationDialogSnapshot().captureId;
		if (!captureId) return;
		try {
			const backup = await runtime.getLegacyBackup(captureId);
			download(backup.documentJson, `bus-lens-${captureId}-legacy.json`, "application/json");
			runtime.showToast(backup.source === "recovery-backup" ? "Recovery JSON downloaded" : "Original JSON downloaded");
		} catch (error) {
			runtime.showToast(`Could not export original JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async function monitorCanonicalization(captureId: string, initialJob: Awaited<ReturnType<typeof runtime.startCanonicalization>>, token: number): Promise<void> {
		let job = initialJob;
		while (job.status === "pending" || job.status === "running") {
			await new Promise(resolve => setTimeout(resolve, 250));
			job = await runtime.getCanonicalizationJob(captureId, job.id);
			if (token === canonicalizationToken) publishCanonicalization({ job, loading: false });
		}

		if (job.status === "completed" && job.verified) {
			runtime.setCaptureStorageStatus(captureId, "canonical");
			await runtime.refreshCapture(captureId);
			snapshots.render();
			runtime.showToast("Capture upgraded; verification passed");
		} else if (job.status === "failed") {
			runtime.setCaptureStorageStatus(captureId, "canonicalization-failed");
			await runtime.refreshCapture(captureId);
			snapshots.render();
			runtime.showToast("Conversion failed; the legacy capture is still available");
		}
		if (token === canonicalizationToken) {
			canonicalizationStarting = false;
			publishCanonicalization({ job, loading: false, starting: false, error: job.error });
		}
	}

	async function startCanonicalization(): Promise<void> {
		const current = getCanonicalizationDialogSnapshot();
		if (!current.captureId || canonicalizationStarting) return;
		const captureId = current.captureId;
		if (transport.isRecording()) {
			publishCanonicalization({
				preflight: current.preflight
					? {
							...current.preflight,
							recordingActive: true,
							isRecording: true,
							eligible: false,
							estimatedEligibility: "recording-active",
							error: "Stop recording before converting this capture"
						}
					: current.preflight,
				error: "Stop recording before converting this capture"
			});
			return;
		}
		const token = canonicalizationToken;
		canonicalizationStarting = true;
		publishCanonicalization({ starting: true, error: null });
		runtime.setCaptureStorageStatus(captureId, "converting");
		snapshots.render();
		try {
			const job = await runtime.startCanonicalization(captureId);
			if (token === canonicalizationToken) publishCanonicalization({ job, loading: false });
			await monitorCanonicalization(captureId, job, token);
		} catch (error) {
			canonicalizationStarting = false;
			try {
				const preflight = await runtime.getCanonicalizationPreflight(captureId);
				runtime.setCaptureStorageStatus(
					captureId,
					preflight.status === "failed"
						? "canonicalization-failed"
						: preflight.status === "canonical"
							? "canonical"
							: preflight.status === "converting"
								? "converting"
								: "legacy-not-canonicalized"
				);
				if (token === canonicalizationToken) publishCanonicalization({ preflight, starting: false, loading: false, error: error instanceof Error ? error.message : String(error) });
			} catch {
				if (token === canonicalizationToken) publishCanonicalization({ starting: false, loading: false, error: error instanceof Error ? error.message : String(error) });
			}
			snapshots.render();
		}
	}

	async function retryCanonicalization(): Promise<void> {
		const current = getCanonicalizationDialogSnapshot();
		if (!current.captureId || canonicalizationStarting) return;
		const token = ++canonicalizationToken;
		publishCanonicalization({ job: null, preflight: null, loading: true, starting: false, error: null });
		try {
			const serverPreflight = await runtime.getCanonicalizationPreflight(current.captureId);
			const preflight = transport.isRecording()
				? {
						...serverPreflight,
						recordingActive: true,
						isRecording: true,
						eligible: false,
						estimatedEligibility: "recording-active" as const,
						error: "Stop recording before converting this capture"
					}
				: serverPreflight;
			if (token !== canonicalizationToken) return;
			publishCanonicalization({ preflight, loading: false });
			if (preflight.eligible) await startCanonicalization();
		} catch (error) {
			if (token === canonicalizationToken) publishCanonicalization({ loading: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	const dataTransferController = createDataTransferController({
		state: runtime.state,
		capture: runtime.capture,
		getActiveId: runtime.getActiveId,
		setActiveId: runtime.setActiveId,
		setSelectedCaptureId: captureId => applicationStore.send({ type: "capture/selected-changed", captureId }),
		archiveCommands: options.archive?.commands,
		render: snapshots.render,
		showToast: runtime.showToast,
		download
	});

	registerTransportActions({
		connect: transport.connect,
		disconnect: transport.disconnect,
		toggleConnection: transport.toggleConnection,
		toggleRecording: transport.toggleRecording
	});

	snapshots.subscribeToViewStateChanges();

	registerCaptureHeaderActions({
		setTitle: captureController.setCaptureTitle,
		commitTitle: captureController.commitCaptureTitle,
		setDescription: captureController.setCaptureDescription,
		commitDescription: captureController.commitCaptureDescription,
		openContext: captureController.publishContextDialog,
		duplicate: captureController.duplicateActiveCapture,
		clearMessages: captureController.clearActiveCaptureMessages,
		deleteCapture: captureController.deleteActiveCapture,
		upgradeStorage: captureController.upgradeActiveCapture
	});

	registerCaptureStorageActions({ upgrade: captureController.upgradeActiveCapture });
	registerCanonicalizationDialogActions({
		close: closeCanonicalizationDialog,
		download: () => { void downloadLegacyBackup(); },
		start: () => { void startCanonicalization(); },
		retry: () => { void retryCanonicalization(); }
	});

	registerArchiveActions({
		selectCapture: captureController.selectArchiveCapture,
		toggleFolder: captureController.toggleArchiveFolder,
		moveCapture: captureController.moveArchiveCapture,
		upgradeCapture: captureController.upgradeCapture,
		duplicateCapture: () => captureController.duplicateActiveCapture(),
		deleteCapture: captureController.deleteArchiveCapture,
		openNewCapture: () => captureController.publishContextDialog(true),
		openExport: () => publishDialogCommand({ type: "export" }),
		saveFolder: captureController.saveFolder,
		deleteFolder: captureController.deleteFolder,
		importFile: dataTransferController.importFile
	});

	registerDialogActions({
		saveContext: captureController.commitContextDraft,
		saveAnnotation: captureController.commitAnnotationDraft,
		deleteAnnotation: captureController.removeAnnotationDraft,
		savePatternRemark: captureController.commitPatternRemarkDraft,
		exportData: dataTransferController.exportData,
		notify: runtime.showToast
	});

	registerSendActions({
		setDraft: sendController.setSendDraft,
		setDelay: sendController.setQueueDelay,
		send: sendController.sendBytes,
		addToQueue: sendController.addDraftToQueue,
		sendQueueItem: sendController.sendQueueItem,
		removeQueueItem: sendController.removeQueueItem,
		loadHistory: sendController.loadHistoryItem,
		replayHistory: sendController.replayHistoryItem,
		runQueue: sendController.runSendQueue,
		stopQueue: sendController.stopSendQueue,
		clearQueue: sendController.clearSendQueue,
		clearHistory: sendController.clearSendHistory
	});

	registerMessageStreamActions({
		openMessageNote: messageId => captureController.publishAnnotationDialog("message", messageId),
		openByteNote: (messageId, position) => captureController.publishAnnotationDialog("byte", `${messageId}:${position}`),
		replayMessage: messageId => {
			const message = runtime.capture()?.messages?.find(item => item.id === messageId);
			if (message) {
				void sendController.transmitBytes(
					Uint8Array.from(visibleByteEntries(message).map(({ value }) => value)),
					"replay"
				);
			}
		},
		openPatternRemark: captureController.publishPatternRemarkDialog,
		hideMessage: messageId => {
			const capture = runtime.capture();
			const message = capture?.messages?.find(item => item.id === messageId);
			if (!capture || !message) return;
			if (capture?.id && runtime.isCaptureConversionLocked(String(capture.id))) {
				runtime.showToast("Capture conversion is in progress; editing is temporarily disabled");
				return;
			}
			const previousHidden = Boolean(message.hidden);
			message.hidden = true;
			if (capture?.id && runtime.isCanonicalCapture(String(capture.id))) {
				const operation = options.archive
					? options.archive.commands.setFrameVisibility({
							captureId: String(capture.id),
							frameId: messageId,
							hidden: true
						})
					: runtime.captureWriter!.setFrameVisibility({
					captureId: String(capture.id),
					frameId: messageId,
					hidden: true
					});
				void operation.then(async result => {
					capture.contentRevision = result.contentRevision;
					if (options.archive) Object.assign(capture, await runtime.refreshCapture(String(capture.id)));
				}).catch(error => {
					message.hidden = previousHidden;
					publishPersistenceError({
						visible: true,
						captureId: String(capture.id),
						message: error instanceof Error ? error.message : String(error),
						canRetry: false,
						canExportRecovery: false
					});
					snapshots.render();
				});
			} else if (options.archive) {
				void options.archive.commands.saveLegacyCapture(capture).catch(error => {
					message.hidden = previousHidden;
					snapshots.render();
					runtime.showToast(`Message could not be hidden: ${error instanceof Error ? error.message : String(error)}`);
				});
			} else runtime.showToast("Archive data layer is unavailable");
			snapshots.render();
			runtime.showToast("Message hidden; captured data was kept");
		},
		hideByte: (messageId, position) => {
			const capture = runtime.capture();
			const message = capture?.messages?.find(item => item.id === messageId);
			if (!capture || !message || position < 0 || position >= message.bytes.length) return;
			if (capture.id && runtime.isCaptureConversionLocked(String(capture.id))) {
				runtime.showToast("Capture conversion is in progress; editing is temporarily disabled");
				return;
			}
			message.hiddenBytes ||= [];
			message.hiddenBytes[position] = true;
			const rawOffset = message.rawOffsets?.[position] ?? message._rawPositions?.[position];
			const rawIndex = capture.byteStream?.findIndex((record, index) => (record.rawOffset ?? index) === rawOffset) ?? -1;
			const previousHidden = rawIndex >= 0 ? Boolean(capture.byteStream?.[rawIndex]?.hidden) : false;
			if (rawIndex >= 0 && capture.byteStream?.[rawIndex]) capture.byteStream[rawIndex].hidden = true;
			rebuildPreview(capture);
			if (capture.id && rawOffset !== undefined && runtime.isCanonicalCapture(String(capture.id))) {
				const operation = options.archive
					? options.archive.commands.setByteVisibility({
							captureId: String(capture.id),
							rawOffset,
							hidden: true
						})
					: runtime.captureWriter!.setByteVisibility({
					captureId: String(capture.id),
					rawOffset,
					hidden: true
					});
				void operation.then(async result => {
					capture.contentRevision = result.contentRevision;
					if (options.archive) Object.assign(capture, await runtime.refreshCapture(String(capture.id)));
				}).catch(error => {
					if (rawIndex >= 0 && capture.byteStream?.[rawIndex]) capture.byteStream[rawIndex].hidden = previousHidden;
					rebuildPreview(capture);
					publishPersistenceError({
						visible: true,
						captureId: String(capture.id),
						message: error instanceof Error ? error.message : String(error),
						canRetry: false,
						canExportRecovery: false
					});
					snapshots.render();
				});
			} else if (options.archive) {
				void options.archive.commands.saveLegacyCapture(capture).catch(error => {
					if (rawIndex >= 0 && capture.byteStream?.[rawIndex]) capture.byteStream[rawIndex].hidden = previousHidden;
					rebuildPreview(capture);
					snapshots.render();
					runtime.showToast(`Byte could not be hidden: ${error instanceof Error ? error.message : String(error)}`);
				});
			} else runtime.showToast("Archive data layer is unavailable");
			snapshots.render();
			runtime.showToast("Byte hidden; captured data was kept");
		},
		beginSection: captureController.startSectionAtByte,
		moveSection: captureController.moveSection,
		deleteSection: captureController.deleteSection,
		setSectionFraming: captureController.setSectionFraming,
		setSectionFrameSize: (sectionId, value) => captureController.setSectionFrameSize(sectionId, Number(value)),
		setSectionFramingMode: captureController.setSectionFramingMode,
		setSectionFrameMarker: captureController.setSectionFrameMarker,
		setSectionMarkerPosition: captureController.setSectionMarkerPosition,
		setSectionFrameTimeGap: captureController.setSectionFrameTimeGap,
		setSectionCollapse: captureController.setSectionCollapse,
		setSectionCollapsed: captureController.setSectionCollapsed
	});

	registerNotesActions({ addSequenceNote: captureController.addSequenceNote });

	const lifecycle: ControllerLifecycle = {
		beforeUnload: createBeforeUnloadHandler({
			beginUnload: runtime.beginUnload,
			flushLiveBytes: transport.flushLiveBytes,
			hasUnacknowledgedBytes: transport.hasUnacknowledgedBytes,
			getPort: transport.getPort,
			disconnect: transport.disconnect
		})
	};
	initializedController = lifecycle;
	snapshots.render();
	void runtime.ready.then(() => snapshots.render());
	return lifecycle;
}

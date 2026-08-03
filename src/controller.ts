import { registerArchiveActions } from "./archive-bridge.ts";
import { createAppRuntime } from "./app-runtime.ts";
import { download } from "./browser-download.ts";
import { registerCaptureHeaderActions } from "./capture-header-bridge.ts";
import { rebuildPreview, visibleByteEntries } from "./capture-framing.ts";
import { createCaptureController } from "./capture-controller.ts";
import { createDataTransferController } from "./data-transfer.ts";
import { publishDialogCommand, registerDialogActions } from "./dialog-bridge.ts";
import { registerFramingToolbarActions } from "./framing-toolbar-bridge.ts";
import { registerMessageStreamActions } from "./message-stream-bridge.ts";
import { registerNotesActions } from "./notes-bridge.ts";
import { createBeforeUnloadHandler } from "./unload-lifecycle.ts";
import { createSendController, type SendController } from "./send-controller.ts";
import { createSerialController, type SerialController } from "./serial-controller.ts";
import { createSnapshotRuntime } from "./snapshot-runtime.ts";
import { registerSendActions } from "./send-bridge.ts";
import { registerTransportActions } from "./transport-bridge.ts";
import { getViewStateSnapshot } from "./view-state-bridge.ts";

export type ControllerLifecycle = {
	beforeUnload: () => void;
};

let initializedController: ControllerLifecycle | undefined;

export function initializeController(): ControllerLifecycle {
	if (initializedController) return initializedController;

	const runtime = createAppRuntime();
	let transport!: SerialController;
	let sendController!: SendController;
	const snapshots = createSnapshotRuntime({
		state: runtime.state,
		capture: runtime.capture,
		getActiveId: runtime.getActiveId,
		getTransport: () => transport,
		getSendController: () => sendController,
		getViewStateSnapshot
	});

	transport = createSerialController({
		capture: runtime.capture,
		state: runtime.state,
		saveState: runtime.saveState,
		showToast: runtime.showToast,
		publishCaptureHeaderState: snapshots.publishCaptureHeaderState,
		publishFramingToolbarState: snapshots.publishFramingToolbarState,
		publishAnalysisState: snapshots.publishAnalysisState,
		publishNotesState: snapshots.publishNotesState,
		renderMessages: snapshots.renderMessages,
		isPatternsPanelActive: () => getViewStateSnapshot().activePanel === "patterns",
		stopSendQueue: () => sendController?.stopSendQueue(),
		publishSendState: snapshots.publishSendState
	});

	sendController = createSendController({
		state: runtime.state,
		capture: runtime.capture,
		transport,
		saveState: runtime.saveState,
		showToast: runtime.showToast,
		confirm: message => confirm(message),
		publishSendState: snapshots.publishSendState
	});

	const captureController = createCaptureController({
		state: runtime.state,
		capture: runtime.capture,
		getActiveId: runtime.getActiveId,
		setActiveId: runtime.setActiveId,
		saveState: runtime.saveState,
		render: snapshots.render,
		renderMessages: snapshots.renderMessages,
		showToast: runtime.showToast,
		confirm: message => confirm(message),
		transport,
		publishArchiveState: snapshots.publishArchiveState,
		publishCaptureHeaderState: snapshots.publishCaptureHeaderState,
		publishNotesState: snapshots.publishNotesState,
		publishDialogCommand
	});

	const dataTransferController = createDataTransferController({
		state: runtime.state,
		capture: runtime.capture,
		getActiveId: runtime.getActiveId,
		setActiveId: runtime.setActiveId,
		saveState: () => runtime.saveState(),
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
		deleteCapture: captureController.deleteActiveCapture
	});

	registerArchiveActions({
		selectCapture: captureController.selectArchiveCapture,
		toggleFolder: captureController.toggleArchiveFolder,
		moveCapture: captureController.moveArchiveCapture,
		openNewCapture: () => captureController.publishContextDialog(true),
		openExport: () => publishDialogCommand({ type: "export" }),
		saveFolder: captureController.saveFolder,
		deleteFolder: captureController.deleteFolder,
		importFile: dataTransferController.importFile
	});

	registerFramingToolbarActions({
		updateSettings: captureController.updateFramingSettings,
		openSections: captureController.publishSectionsDialog
	});

	registerDialogActions({
		saveContext: captureController.commitContextDraft,
		saveSections: captureController.commitSectionsDraft,
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
			if (!message) return;
			message.hidden = true;
			runtime.saveState({ immediate: true });
			snapshots.render();
			runtime.showToast("Message hidden; captured data was kept");
		},
		hideByte: (messageId, position) => {
			const capture = runtime.capture();
			const message = capture?.messages?.find(item => item.id === messageId);
			if (!capture || !message || position < 0 || position >= message.bytes.length) return;
			message.hiddenBytes ||= [];
			message.hiddenBytes[position] = true;
			const rawIndex = message._rawPositions?.[position] ?? -1;
			if (rawIndex >= 0 && capture.byteStream?.[rawIndex]) capture.byteStream[rawIndex].hidden = true;
			rebuildPreview(capture);
			runtime.saveState({ immediate: true });
			snapshots.render();
			runtime.showToast("Byte hidden; captured data was kept");
		},
		beginSection: captureController.startSectionAtByte,
		setSectionFrameSize: (sectionId, value) => captureController.setSectionFrameSize(sectionId, Number(value)),
		setSectionCollapse: captureController.setSectionCollapse
	});

	registerNotesActions({ addSequenceNote: captureController.addSequenceNote });

	const lifecycle: ControllerLifecycle = {
		beforeUnload: createBeforeUnloadHandler({
			flushLiveBytes: transport.flushLiveBytes,
			persistState: runtime.persistState,
			getPort: transport.getPort,
			disconnect: transport.disconnect
		})
	};
	initializedController = lifecycle;
	snapshots.render();
	return lifecycle;
}

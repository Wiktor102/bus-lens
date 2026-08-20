import type { SendSettings, StoredFolder } from "../../shared/app-state.ts";
import type { ArchiveIndex } from "../../persistence/archive-client.ts";
import type { ArchiveCommands } from "../../data/archive-data-layer.ts";
import type { ApplicationEvent, RecordingWorkflowState, TransportViewState } from "../../shared/application-store.ts";
import { recordReceivedByte } from "../capture/capture-summary.ts";
import {
	appendLivePreview,
	bumpCaptureProjectionGeneration,
	rebuildPreview,
	type Capture
} from "../capture/capture-framing.ts";
import type { MessageStreamDeriveOptions } from "../message-stream/message-stream.ts";
import {
	CaptureAppendQueue,
	type AppendCaptureChunkRequest,
	type AppendCaptureChunkResponse,
	type CaptureAppendBoundary
} from "./capture-append-queue.ts";

// A capture remains useful at this size while still fitting comfortably in browser storage.
export const MAX_CAPTURE_BYTES = 50_000;
const LIVE_REFRESH_MS = 120;

export type SerialPortLike = {
	readable?: ReadableStream<Uint8Array> | null;
	writable?: WritableStream<Uint8Array> | null;
	open: (options: { baudRate: number }) => Promise<void>;
	close: () => Promise<void>;
};

export type DisconnectOptions = {
	persist?: boolean;
};

export type SerialProvider = {
	requestPort: () => Promise<SerialPortLike>;
};

type TransportWorkflowEvent = Extract<
	ApplicationEvent,
	{
		type:
			| "transport/connection-started"
			| "transport/connection-succeeded"
			| "transport/connection-failed"
			| "transport/recording-starting"
			| "transport/recording-started"
			| "transport/recording-finalizing"
			| "transport/recording-finalized"
			| "transport/recording-failed"
	}
>;

export type SerialControllerDependencies = {
	capture: () => Capture | undefined;
	/** Test-only compatibility input; production reads come from the archive layer. */
	state?: SerialCompatibilityState;
	getArchiveIndex?: () => ArchiveIndex | undefined;
	getSettings?: () => SendSettings | undefined;
	getCapture?: (captureId: string) => Capture | undefined;
	archiveCommands?: ArchiveCommands;
	showToast: (message: string) => void;
	publishCaptureHeaderState?: (capture?: Capture) => void;
	publishFramingToolbarState: (capture?: Capture) => void;
	publishTransportState?: (state: TransportViewState) => void;
	publishTransportWorkflow?: (event: TransportWorkflowEvent) => void;
	renderMessages: (options?: MessageStreamDeriveOptions) => void;
	stopSendQueue: () => void;
	publishSendState?: () => void;
	serial?: SerialProvider;
	recordingWriter?: {
		startSession: (captureId: string, sessionId: string) => Promise<CaptureAppendBoundary>;
		appendChunk: (request: AppendCaptureChunkRequest) => Promise<AppendCaptureChunkResponse>;
		finalizeSession: (captureId: string, sessionId: string, expectedDataRevision: number) => Promise<unknown>;
		refreshCapture?: (captureId: string) => Promise<Capture>;
	};
	/** Wait for direct capture commands already in the runtime write barrier. */
	waitForCaptureWrite?: (captureId: string) => Promise<void>;
	/** Wait for client-side capture commands already accepted before stopping. */
	waitForCaptureWrites?: (captureId: string) => Promise<void>;
	/** Include finalization in the app-wide capture write barrier. */
	trackCaptureWrite?: (captureId: string, write: Promise<unknown>) => void;
	isCanonicalCapture?: (captureId: string) => boolean;
	isCaptureConversionLocked?: (captureId: string) => boolean;
	publishPersistenceError?: (error: { captureId: string; message: string } | null) => void;
};

type SerialCompatibilityState = {
	activeId?: string | null;
	unfiledCollapsed?: boolean;
	captures?: Capture[];
	folders?: StoredFolder[];
	sendSettings?: Partial<SendSettings>;
};

type PendingLiveSegment = {
	captureId?: string;
	values: number[];
	timestamp: number;
	direction: string;
	sessionId?: string;
};

type SerialError = {
	name?: string;
	message?: string;
};

function serialProvider(): SerialProvider | undefined {
	return (globalThis as typeof globalThis & { navigator?: { serial?: SerialProvider } }).navigator?.serial;
}

export function createSerialController(dependencies: SerialControllerDependencies) {
	let port: SerialPortLike | null = null;
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	let recording = false;
	let recordingSessionId: string | null = null;
	let recordingCaptureId: string | null = null;
	let canonicalRecording = false;
	let readAbort = false;
	let pendingLiveSegments: PendingLiveSegment[] = [];
	let liveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let persistenceError: { captureId: string; error: unknown } | null = null;
	let legacyWrite: Promise<void> = Promise.resolve();
	let stopPromise: Promise<void> | null = null;
	let startPromise: Promise<void> | null = null;
	let recordingWorkflow: RecordingWorkflowState["status"] = "idle";
	const appendQueue = dependencies.recordingWriter
		? new CaptureAppendQueue(
				{ appendChunk: request => dependencies.recordingWriter!.appendChunk(request) },
				{
					onPersistentError: (captureId, error) => handlePersistenceFailure(captureId, error),
					onBackpressureChange: (_captureId, active) => {
						if (!active) publishState();
					}
				}
			)
		: null;

	function archiveIndex() {
		const current = dependencies.getArchiveIndex?.();
		return current || {
			activeId: dependencies.state?.activeId ?? (dependencies.capture()?.id ? String(dependencies.capture()?.id) : null),
			unfiledCollapsed: Boolean(dependencies.state?.unfiledCollapsed),
			captures: (dependencies.state?.captures || []).map((capture, position) => ({ id: String(capture.id), folderId: capture.folderId ?? null, position })),
			folders: (dependencies.state?.folders || []).map((folder, position) => ({ id: String(folder.id), position }))
		};
	}

	function persistLiveCapture(capture: Capture | undefined): Promise<void> {
		if (!capture) return Promise.resolve();
		if (dependencies.archiveCommands) {
			const write = dependencies.archiveCommands.saveLegacyCapture(capture);
			legacyWrite = write.catch(() => {});
			void write.catch(error => dependencies.showToast(`Capture persistence failed: ${error instanceof Error ? error.message : String(error)}`));
			return write;
		}
		return Promise.resolve();
	}

	function persistArchiveIndex(): void {
		if (dependencies.archiveCommands) {
			void dependencies.archiveCommands.persistArchiveIndex(archiveIndex()).catch(error => dependencies.showToast(`Archive index could not be saved: ${error instanceof Error ? error.message : String(error)}`));
		}
	}

	function persistSettings(settings = dependencies.getSettings?.() || dependencies.state?.sendSettings || {}): void {
		if (dependencies.archiveCommands) {
			void dependencies.archiveCommands.saveSettings(settings).catch(error => dependencies.showToast(`Settings could not be saved: ${error instanceof Error ? error.message : String(error)}`));
		}
	}

	function captureById(captureId: string | undefined): Capture | undefined {
		if (!captureId) return dependencies.capture();
		return dependencies.getCapture?.(captureId) || dependencies.state?.captures?.find(capture => String(capture.id) === captureId);
	}

	function handlePersistenceFailure(captureId: string, error: unknown): void {
		persistenceError = { captureId, error };
		recording = false;
		const message = error instanceof Error ? error.message : String(error);
		const capture = captureById(captureId);
		if (capture) capture.lifecycle = "failed";
		publishTransportWorkflow({ type: "transport/recording-failed", error: message, canRetry: true });
		dependencies.publishPersistenceError?.({ captureId, message });
		dependencies.showToast("Capture persistence paused — retry or export JSON recovery");
		publishState();
	}

	function publishTransportWorkflow(event: TransportWorkflowEvent): void {
		switch (event.type) {
			case "transport/recording-starting":
				recordingWorkflow = "starting";
				break;
			case "transport/recording-started":
				recordingWorkflow = "recording";
				break;
			case "transport/recording-finalizing":
				recordingWorkflow = "finalizing";
				break;
			case "transport/recording-finalized":
				recordingWorkflow = "finalized";
				break;
			case "transport/recording-failed":
				recordingWorkflow = "failed";
				break;
		}
		dependencies.publishTransportWorkflow?.(event);
		if (event.type.startsWith("transport/recording-")) {
			const capture = recordingCaptureId ? captureById(recordingCaptureId) : dependencies.capture();
			dependencies.publishFramingToolbarState(capture);
			dependencies.renderMessages({ live: recording });
		}
	}

	function isConnected() {
		return Boolean(port);
	}

	function getPort() {
		return port;
	}

	function isRecording() {
		return recording;
	}

	function isCaptureMutationLocked(captureId: string): boolean {
		return recordingCaptureId === String(captureId) &&
			(recordingWorkflow === "starting" || recordingWorkflow === "finalizing" || recordingWorkflow === "failed");
	}

	function isCaptureFinalizing(captureId: string): boolean {
		return recordingCaptureId === String(captureId) && recordingWorkflow === "finalizing";
	}

	function publishState() {
		const connected = isConnected();
		const activeCapture = dependencies.capture();
		const starting = recordingWorkflow === "starting";
		const finalizing = recordingWorkflow === "finalizing";
		const failed = Boolean(persistenceError) || (recordingWorkflow === "failed" && Boolean(recordingCaptureId));
		const conversionLocked = Boolean(
			!recording &&
			activeCapture?.id &&
			dependencies.isCaptureConversionLocked?.(String(activeCapture.id))
		);
		const view: TransportViewState = {
			connected,
			recording,
			recordingCaptureId,
			connectionLabel: connected ? "Port connected" : "Disconnected",
			connectLabel: connected ? "Disconnect" : "Connect port",
			recordLabel: failed ? "Save failed" : finalizing ? "Saving…" : starting ? "Starting…" : recording ? "Stop capture" : "Start capture",
			recordDisabled: !connected || !activeCapture || conversionLocked || starting || finalizing || failed || Boolean(recordingSessionId && !recording)
		};
		dependencies.publishTransportState?.(view);
		dependencies.publishSendState?.();
	}

	let projectionRefresh: Promise<void> = Promise.resolve();

	function refreshCaptureProjection(captureId: string, applyToRuntime = false): Promise<void> {
		const refreshCapture = dependencies.recordingWriter?.refreshCapture;
		if (!refreshCapture) return Promise.resolve();
		const next = projectionRefresh.catch(() => {}).then(async () => {
			const refreshed = await refreshCapture(captureId);
			if (applyToRuntime) {
				const capture = captureById(captureId);
				if (capture) {
					Object.assign(capture, refreshed);
					bumpCaptureProjectionGeneration(capture);
				}
			}
		});
		projectionRefresh = next.catch(() => {});
		return next;
	}

	function trimCapture(capture: Capture) {
		const rollingCapture = capture as Capture & { rollingBuffer?: boolean };
		const excess = (capture.byteStream?.length || 0) - MAX_CAPTURE_BYTES;
		if (excess <= 0) return false;
		const firstRollover = !rollingCapture.rollingBuffer;
		rollingCapture.rollingBuffer = true;
		const firstRetainedOffset = capture.byteStream![excess]?.rawOffset ?? excess;
		capture.byteStream!.splice(0, excess);
		const sections = capture.frameSections || [];
		const activeSection = sections
			.filter(section => (section.start ?? 0) <= firstRetainedOffset)
			.at(-1);
		capture.frameSections = [
			...(activeSection ? [{ ...activeSection, start: firstRetainedOffset }] : []),
			...sections.filter(section => (section.start ?? 0) > firstRetainedOffset)
		];
		// Message IDs are derived from stream positions, so old message-specific notes
		// cannot safely be attached after the oldest portion rolls off.
		capture.annotations = {};
		capture.notes = (capture.notes || []).filter(note => note.type !== "sequence");
		return firstRollover;
	}

	function flushLiveBytes() {
		liveRefreshTimer = null;
		if (!pendingLiveSegments.length) return;
		const pendingSegments = pendingLiveSegments;
		pendingLiveSegments = [];
		const captureId = pendingSegments[0]?.captureId;
		const capture = captureById(captureId);
		if (!capture) return;
		const sessionsById = new Map((capture.captureSessions || []).map(session => [session.id, session]));
		let nextRawOffset = capture.nextRawOffset ?? Math.max(0, ...(capture.byteStream || []).map((record, index) => (record.rawOffset ?? index) + 1));
		const previousByteStreamLength = capture.byteStream!.length;
		for (const segment of pendingSegments) {
			for (const value of segment.values) {
				capture.byteStream!.push({
					value,
					timestamp: segment.timestamp,
					direction: segment.direction,
					sessionId: segment.sessionId,
					rawOffset: nextRawOffset++
				});
				if (segment.direction !== "tx") {
					recordReceivedByte(segment.sessionId ? sessionsById.get(segment.sessionId) : undefined, segment.timestamp);
				}
			}
		}
		capture.nextRawOffset = nextRawOffset;
		if (canonicalRecording && captureId && appendQueue && recordingSessionId && captureId === recordingCaptureId) {
			for (const segment of pendingSegments) {
				appendQueue.enqueue(captureId, {
					timestamp: segment.timestamp,
					direction: segment.direction === "tx" ? "tx" : "rx",
					bytes: segment.values
				});
			}
			void appendQueue.flush(captureId).catch(() => {
				// The queue retains the rejected batch and publishes a persistent error.
			});
		}
		const trimmed = trimCapture(capture);
		const incrementallyRebuilt = !trimmed && appendLivePreview(capture, previousByteStreamLength);
		if (!incrementallyRebuilt) rebuildPreview(capture);
		if (!canonicalRecording) persistLiveCapture(capture);
		dependencies.publishCaptureHeaderState?.(capture);
		dependencies.publishFramingToolbarState(capture);
		dependencies.renderMessages({ live: recording });
		if (trimmed) dependencies.showToast(`Capture limit reached; keeping the newest ${MAX_CAPTURE_BYTES.toLocaleString()} bytes`);
	}

	function queueLiveBytes(bytes: Iterable<number>, direction: string) {
		const values = [...bytes];
		if (!values.length) return;
		const timestamp = performance.timeOrigin + performance.now();
		pendingLiveSegments.push({
			captureId: recordingCaptureId ?? (dependencies.capture()?.id ? String(dependencies.capture()?.id) : undefined),
			values,
			timestamp,
			direction,
			sessionId: recordingSessionId || undefined
		});
		if (!liveRefreshTimer) liveRefreshTimer = setTimeout(flushLiveBytes, LIVE_REFRESH_MS);
	}

	function ingestChunk(bytes: Uint8Array) {
		queueLiveBytes(bytes, "rx");
	}

	async function readSerialLoop() {
		while (port?.readable && !readAbort) {
			reader = port.readable.getReader();
			try {
				while (true) {
					if (recordingCaptureId && appendQueue?.isBackpressured(recordingCaptureId)) {
						try {
							await appendQueue.drain(recordingCaptureId);
						} catch {
							break;
						}
					}
					const { value, done } = await reader.read();
					if (done) break;
					if (recording && value) ingestChunk(value);
				}
			} catch (error) {
				if (!readAbort) dependencies.showToast(`Read error: ${(error as SerialError).message}`);
			} finally {
				try {
					reader.releaseLock();
				} catch {}
				reader = null;
			}
		}
	}

	async function connect() {
		const serial = dependencies.serial || serialProvider();
		if (!serial) {
			publishTransportWorkflow({
				type: "transport/connection-failed",
				error: "Web Serial requires Chrome or Edge on localhost",
				canRetry: false
			});
			dependencies.showToast("Web Serial requires Chrome or Edge on localhost");
			return;
		}
		if (port) {
			await disconnect();
			return;
		}
		publishTransportWorkflow({ type: "transport/connection-started", startedAt: Date.now() });
		try {
			port = await serial.requestPort();
			const baudRate = dependencies.capture()?.baudRate || dependencies.getSettings?.()?.baudRate || dependencies.state?.sendSettings?.baudRate || 115200;
			await port.open({ baudRate });
			const settings = dependencies.getSettings?.() || dependencies.state?.sendSettings || {};
			persistSettings({ ...settings, baudRate });
			readAbort = false;
			publishState();
			publishTransportWorkflow({ type: "transport/connection-succeeded", completedAt: Date.now() });
			void readSerialLoop();
		} catch (error) {
			port = null;
			publishState();
			const serialError = error as SerialError;
			publishTransportWorkflow({
				type: "transport/connection-failed",
				error: serialError.message || String(error),
				canRetry: true
			});
			dependencies.showToast(
				serialError.name === "NotFoundError"
					? "No serial port selected"
					: `Serial error: ${serialError.message}`
			);
		}
	}

	async function disconnect({ persist = true }: DisconnectOptions = {}) {
		publishTransportWorkflow({ type: "transport/connection-started", startedAt: Date.now() });
		const hadRecording = Boolean(recording || recordingSessionId);
		if (!persist) {
			flushLiveBytes();
			recording = false;
		} else if (recording || recordingSessionId) {
			await stopRecording({ notify: false, persist: true });
		} else {
			flushLiveBytes();
		}
		if (persist && !hadRecording) {
			persistArchiveIndex();
			persistSettings();
		}
		readAbort = true;
		dependencies.stopSendQueue();
		try {
			await reader?.cancel();
			reader?.releaseLock();
			await port?.close();
		} catch {}
		reader = null;
		port = null;
		publishState();
		publishTransportWorkflow({ type: "transport/connection-succeeded", completedAt: Date.now() });
	}

	function stopRecording({ notify = false, persist = true } = {}): Promise<void> {
		if (stopPromise) return stopPromise;
		if (!recording && !recordingSessionId) return Promise.resolve();
		const captureId = recordingCaptureId;
		const sessionId = recordingSessionId;
		publishTransportWorkflow({ type: "transport/recording-finalizing", startedAt: Date.now() });
		recording = false;
		flushLiveBytes();
		const stopping = (async () => {
			if (captureId) await dependencies.waitForCaptureWrite?.(captureId);
			if (captureId) await dependencies.waitForCaptureWrites?.(captureId);
			if (canonicalRecording && captureId && sessionId && appendQueue && dependencies.recordingWriter) {
				await appendQueue.drain(captureId);
				const boundary = appendQueue.boundary(captureId);
				await dependencies.recordingWriter.finalizeSession(captureId, sessionId, boundary.dataRevision);
				await refreshCaptureProjection(captureId, true);
			} else if (persist) {
				const capture = captureById(captureId ?? undefined);
				if (capture) capture.lifecycle = "finalized";
				await legacyWrite;
				await persistLiveCapture(capture);
				if (captureId) await refreshCaptureProjection(captureId, true);
			}
			const finalizedCapture = captureById(captureId ?? undefined);
			if (finalizedCapture) finalizedCapture.lifecycle = "finalized";
			recordingSessionId = null;
			recordingCaptureId = null;
			canonicalRecording = false;
			persistenceError = null;
			dependencies.publishPersistenceError?.(null);
			publishTransportWorkflow({ type: "transport/recording-finalized", completedAt: Date.now() });
			publishState();
			if (notify) dependencies.showToast("Capture finalized and stored");
		})().catch(error => {
			if (captureId) handlePersistenceFailure(captureId, error);
			throw error;
		}).finally(() => {
			stopPromise = null;
			publishState();
		});
		stopPromise = stopping;
		if (captureId) dependencies.trackCaptureWrite?.(captureId, stopping);
		publishState();
		return stopping;
	}

	function toggleRecording(): Promise<void> {
		const capture = dependencies.capture();
		if (!capture) {
			dependencies.showToast("Create a capture before starting capture");
			return Promise.resolve();
		}
		if (recording) {
			return stopRecording({ notify: true });
		}
		if (startPromise || stopPromise || recordingSessionId || persistenceError) {
			dependencies.showToast("Capture is still being saved; use the recovery controls before recording again");
			return Promise.resolve();
		}
		if (dependencies.isCaptureConversionLocked?.(String(capture.id))) {
			dependencies.showToast("Capture conversion is in progress; recording is temporarily disabled");
			return Promise.resolve();
		}
		if (startPromise) return startPromise;
		const captureId = String(capture.id ?? "");
		const sessionId = crypto.randomUUID();
		recordingCaptureId = captureId;
		publishTransportWorkflow({ type: "transport/recording-starting", startedAt: Date.now() });
		publishState();
		const starting = (async () => {
			canonicalRecording = Boolean(
				dependencies.recordingWriter &&
				appendQueue &&
				(dependencies.isCanonicalCapture?.(captureId) ?? true)
			);
			if (canonicalRecording && dependencies.recordingWriter && appendQueue) {
				const boundary = await dependencies.recordingWriter.startSession(captureId, sessionId);
				appendQueue.start(captureId, boundary);
			}
			const session = { id: sessionId };
			capture.captureSessions ||= [];
			capture.captureSessions.push(session);
			capture.lifecycle = "recording";
			recordingCaptureId = captureId;
			recordingSessionId = session.id;
			recording = true;
			persistenceError = null;
			dependencies.publishPersistenceError?.(null);
			if (!canonicalRecording) await persistLiveCapture(capture);
			publishTransportWorkflow({ type: "transport/recording-started", startedAt: Date.now() });
			publishState();
			dependencies.publishCaptureHeaderState?.(capture);
			void refreshCaptureProjection(captureId).catch(error => {
				console.error(`Could not refresh recording capture ${captureId}`, error);
			});
			dependencies.showToast("Capture started");
		})().catch(error => {
			recording = false;
			recordingSessionId = null;
			recordingCaptureId = null;
			canonicalRecording = false;
			publishTransportWorkflow({ type: "transport/recording-failed", error: error instanceof Error ? error.message : String(error), canRetry: true });
			publishState();
			dependencies.showToast(`Capture could not start: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}).finally(() => {
			startPromise = null;
			publishState();
		});
		startPromise = starting;
		publishState();
		return starting;
	}

	async function retryPersistence(): Promise<void> {
		if (!persistenceError) return;
		const captureId = persistenceError.captureId;
		if (appendQueue) await appendQueue.retry(captureId);
		persistenceError = null;
		dependencies.publishPersistenceError?.(null);
		await stopRecording({ notify: true });
	}

	function recoveryDocument(): Capture | undefined {
		const captureId = persistenceError?.captureId ?? recordingCaptureId ?? undefined;
		const capture = captureById(captureId);
		return capture ? JSON.parse(JSON.stringify(capture)) as Capture : undefined;
	}

	async function toggleConnection() {
		if (port) await disconnect();
		else await connect();
	}

	return {
		connect,
		disconnect,
		toggleConnection,
		toggleRecording,
		stopRecording,
		flushLiveBytes,
		queueLiveBytes,
		getPort,
		isConnected,
		isRecording,
		isCaptureMutationLocked,
		isCaptureFinalizing,
		getRecordingWorkflow: () => recordingWorkflow,
		getRecordingCaptureId: () => recordingCaptureId,
		hasUnacknowledgedBytes: () => appendQueue?.hasUnacknowledgedBytes() ?? false,
		getPersistenceError: () => persistenceError?.error ?? null,
		retryPersistence,
		recoveryDocument,
		publishState
	};
}

export type SerialController = ReturnType<typeof createSerialController>;

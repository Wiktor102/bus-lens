import { publishTransportSnapshot } from "./transport-bridge.ts";
import type { AppState } from "../../shared/app-state.ts";
import { recordReceivedByte } from "../capture/capture-summary.ts";
import { rebuildPreview, type Capture } from "../capture/capture-framing.ts";
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

export type SerialControllerDependencies = {
	capture: () => Capture | undefined;
	state: AppState;
	saveState: (options?: { immediate?: boolean }) => void;
	showToast: (message: string) => void;
	publishCaptureHeaderState: () => void;
	publishFramingToolbarState: (capture?: Capture) => void;
	publishAnalysisState: (capture?: Capture) => void;
	publishNotesState: (capture?: Capture) => void;
	renderMessages: () => void;
	isPatternsPanelActive?: () => boolean;
	stopSendQueue: () => void;
	publishSendState?: () => void;
	serial?: SerialProvider;
	recordingWriter?: {
		startSession: (captureId: string, sessionId: string) => Promise<CaptureAppendBoundary>;
		appendChunk: (request: AppendCaptureChunkRequest) => Promise<AppendCaptureChunkResponse>;
		finalizeSession: (captureId: string, sessionId: string, expectedDataRevision: number) => Promise<unknown>;
		refreshCapture?: (captureId: string) => Promise<Capture>;
	};
	publishPersistenceError?: (error: { captureId: string; message: string } | null) => void;
};

type PendingLiveByte = {
	captureId?: string;
	value: number;
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
	let readAbort = false;
	let pendingLiveBytes: PendingLiveByte[] = [];
	let liveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let persistenceError: { captureId: string; error: unknown } | null = null;
	let stopPromise: Promise<void> | null = null;
	let startPromise: Promise<void> | null = null;
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

	function captureById(captureId: string | undefined): Capture | undefined {
		if (!captureId) return dependencies.capture();
		return dependencies.state.captures.find(capture => String(capture.id) === captureId) as Capture | undefined;
	}

	function handlePersistenceFailure(captureId: string, error: unknown): void {
		persistenceError = { captureId, error };
		recording = false;
		const message = error instanceof Error ? error.message : String(error);
		dependencies.publishPersistenceError?.({ captureId, message });
		dependencies.showToast("Capture persistence paused — retry or export JSON recovery");
		publishState();
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

	function publishState() {
		const connected = isConnected();
		publishTransportSnapshot({
			connected,
			recording,
			connectionLabel: connected ? "Port connected" : "Disconnected",
			connectLabel: connected ? "Disconnect" : "Connect port",
			recordLabel: recording ? "Stop capture" : "Start capture",
			recordDisabled: !connected || !dependencies.capture()
		});
		dependencies.publishSendState?.();
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
		if (!pendingLiveBytes.length) return;
		const captureId = pendingLiveBytes[0]?.captureId;
		const capture = captureById(captureId);
		if (!capture) {
			pendingLiveBytes = [];
			return;
		}
		const sessionsById = new Map((capture.captureSessions || []).map(session => [session.id, session]));
		let nextRawOffset = capture.nextRawOffset ?? Math.max(0, ...(capture.byteStream || []).map((record, index) => (record.rawOffset ?? index) + 1));
		for (const record of pendingLiveBytes) {
			capture.byteStream!.push({ ...record, rawOffset: nextRawOffset++ });
			if (record.direction !== "tx") {
				recordReceivedByte(
					record.sessionId ? sessionsById.get(record.sessionId) : undefined,
					record.timestamp
				);
			}
		}
		capture.nextRawOffset = nextRawOffset;
		if (captureId && appendQueue && recordingSessionId && captureId === recordingCaptureId) {
			for (const record of pendingLiveBytes) {
				appendQueue.enqueue(captureId, {
					timestamp: record.timestamp,
					direction: record.direction === "tx" ? "tx" : "rx",
					bytes: [record.value]
				});
			}
			void appendQueue.flush(captureId).catch(() => {
				// The queue retains the rejected batch and publishes a persistent error.
			});
		}
		pendingLiveBytes = [];
		const trimmed = trimCapture(capture);
		rebuildPreview(capture);
		if (!dependencies.recordingWriter) dependencies.saveState();
		dependencies.publishCaptureHeaderState();
		dependencies.publishFramingToolbarState(capture);
		dependencies.renderMessages();
		if (dependencies.isPatternsPanelActive?.()) dependencies.publishAnalysisState(capture);
		if (trimmed) dependencies.publishNotesState(capture);
		if (trimmed) dependencies.showToast(`Capture limit reached; keeping the newest ${MAX_CAPTURE_BYTES.toLocaleString()} bytes`);
	}

	function queueLiveBytes(bytes: Iterable<number>, direction: string) {
		const timestamp = performance.timeOrigin + performance.now();
		for (const value of bytes) {
			pendingLiveBytes.push({
				captureId: recordingCaptureId ?? (dependencies.capture()?.id ? String(dependencies.capture()?.id) : undefined),
				value,
				timestamp,
				direction,
				sessionId: recordingSessionId || undefined
			});
		}
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
			dependencies.showToast("Web Serial requires Chrome or Edge on localhost");
			return;
		}
		if (port) {
			await disconnect();
			return;
		}
		try {
			port = await serial.requestPort();
			const baudRate = dependencies.capture()?.baudRate || dependencies.state.sendSettings?.baudRate || 115200;
			await port.open({ baudRate });
			dependencies.state.sendSettings ||= {};
			dependencies.state.sendSettings.baudRate = baudRate;
			dependencies.saveState();
			readAbort = false;
			publishState();
			void readSerialLoop();
		} catch (error) {
			port = null;
			publishState();
			const serialError = error as SerialError;
			dependencies.showToast(
				serialError.name === "NotFoundError"
					? "No serial port selected"
					: `Serial error: ${serialError.message}`
			);
		}
	}

	async function disconnect({ persist = true }: DisconnectOptions = {}) {
		if (recording || recordingSessionId) await stopRecording({ notify: false, persist });
		else flushLiveBytes();
		if (persist && !dependencies.recordingWriter) dependencies.saveState({ immediate: true });
		readAbort = true;
		dependencies.stopSendQueue();
		try {
			await reader?.cancel();
			reader?.releaseLock();
			await port?.close();
		} catch {}
		reader = null;
		port = null;
		dependencies.publishCaptureHeaderState();
		publishState();
	}

	function stopRecording({ notify = false, persist = true } = {}): Promise<void> {
		if (stopPromise) return stopPromise;
		if (!recording && !recordingSessionId) return Promise.resolve();
		const captureId = recordingCaptureId;
		const sessionId = recordingSessionId;
		recording = false;
		flushLiveBytes();
		stopPromise = (async () => {
			if (captureId && sessionId && appendQueue && dependencies.recordingWriter) {
				await appendQueue.drain(captureId);
				const boundary = appendQueue.boundary(captureId);
				await dependencies.recordingWriter.finalizeSession(captureId, sessionId, boundary.dataRevision);
				if (dependencies.recordingWriter.refreshCapture) {
					const refreshed = await dependencies.recordingWriter.refreshCapture(captureId);
					const capture = captureById(captureId);
					if (capture) Object.assign(capture, refreshed);
				}
			} else if (persist) {
				dependencies.saveState({ immediate: true });
			}
			recordingSessionId = null;
			recordingCaptureId = null;
			persistenceError = null;
			dependencies.publishPersistenceError?.(null);
			dependencies.publishCaptureHeaderState();
			publishState();
			if (notify) dependencies.showToast("Capture finalized and stored");
		})().catch(error => {
			if (captureId) handlePersistenceFailure(captureId, error);
			throw error;
		}).finally(() => {
			stopPromise = null;
		});
		return stopPromise;
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
		if (startPromise) return startPromise;
		const captureId = String(capture.id ?? "");
		const sessionId = crypto.randomUUID();
		startPromise = (async () => {
			if (dependencies.recordingWriter && appendQueue) {
				const boundary = await dependencies.recordingWriter.startSession(captureId, sessionId);
				appendQueue.start(captureId, boundary);
			}
			const session = { id: sessionId };
			capture.captureSessions ||= [];
			capture.captureSessions.push(session);
			recordingCaptureId = captureId;
			recordingSessionId = session.id;
			recording = true;
			persistenceError = null;
			dependencies.publishPersistenceError?.(null);
			if (!dependencies.recordingWriter) dependencies.saveState();
			dependencies.publishCaptureHeaderState();
			publishState();
			dependencies.showToast("Capture started");
		})().catch(error => {
			handlePersistenceFailure(captureId, error);
			throw error;
		}).finally(() => {
			startPromise = null;
		});
		return startPromise;
	}

	async function retryPersistence(): Promise<void> {
		if (!persistenceError || !appendQueue) return;
		const captureId = persistenceError.captureId;
		persistenceError = null;
		dependencies.publishPersistenceError?.(null);
		await appendQueue.retry(captureId);
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
		hasUnacknowledgedBytes: () => appendQueue?.hasUnacknowledgedBytes() ?? false,
		getPersistenceError: () => persistenceError?.error ?? null,
		retryPersistence,
		recoveryDocument,
		publishState
	};
}

export type SerialController = ReturnType<typeof createSerialController>;

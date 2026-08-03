import { publishTransportSnapshot } from "./transport-bridge.ts";
import type { AppState } from "./app-state.ts";
import { recordReceivedByte } from "./capture-summary.ts";
import { rebuildPreview, type Capture } from "./capture-framing.ts";

// A capture remains useful at this size while still fitting comfortably in browser storage.
export const MAX_CAPTURE_BYTES = 50_000;
const LIVE_REFRESH_MS = 120;

export type SerialPortLike = {
	readable?: ReadableStream<Uint8Array> | null;
	writable?: WritableStream<Uint8Array> | null;
	open: (options: { baudRate: number }) => Promise<void>;
	close: () => Promise<void>;
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
};

type PendingLiveByte = {
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
	let readAbort = false;
	let pendingLiveBytes: PendingLiveByte[] = [];
	let liveRefreshTimer: ReturnType<typeof setTimeout> | null = null;

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
		capture.byteStream!.splice(0, excess);
		capture.frameSections = (capture.frameSections || [])
			.filter(section => section.start! >= excess)
			.map(section => ({ ...section, start: section.start! - excess }));
		// Message IDs are derived from stream positions, so old message-specific notes
		// cannot safely be attached after the oldest portion rolls off.
		capture.annotations = {};
		capture.notes = (capture.notes || []).filter(note => note.type !== "sequence");
		return firstRollover;
	}

	function flushLiveBytes() {
		liveRefreshTimer = null;
		if (!pendingLiveBytes.length) return;
		const capture = dependencies.capture();
		if (!capture) {
			pendingLiveBytes = [];
			return;
		}
		const sessionsById = new Map((capture.captureSessions || []).map(session => [session.id, session]));
		for (const record of pendingLiveBytes) {
			capture.byteStream!.push(record);
			if (record.direction !== "tx") {
				recordReceivedByte(
					record.sessionId ? sessionsById.get(record.sessionId) : undefined,
					record.timestamp
				);
			}
		}
		pendingLiveBytes = [];
		const trimmed = trimCapture(capture);
		rebuildPreview(capture);
		dependencies.saveState();
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

	async function disconnect() {
		flushLiveBytes();
		recording = false;
		recordingSessionId = null;
		dependencies.saveState({ immediate: true });
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

	function stopRecording({ notify = false } = {}) {
		if (!recording) return;
		flushLiveBytes();
		recording = false;
		recordingSessionId = null;
		dependencies.saveState({ immediate: true });
		dependencies.publishCaptureHeaderState();
		publishState();
		if (notify) dependencies.showToast("Capture saved locally");
	}

	function toggleRecording() {
		const capture = dependencies.capture();
		if (!capture) {
			dependencies.showToast("Create a capture before starting capture");
			return;
		}
		if (recording) {
			stopRecording({ notify: true });
			return;
		}
		const session = { id: crypto.randomUUID() };
		capture.captureSessions ||= [];
		capture.captureSessions.push(session);
		recordingSessionId = session.id;
		recording = true;
		dependencies.saveState();
		dependencies.publishCaptureHeaderState();
		publishState();
		dependencies.showToast("Capture started");
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
		publishState
	};
}

export type SerialController = ReturnType<typeof createSerialController>;

import {
	MAX_SEND_HISTORY,
	type AppState,
	type SendHistoryEntry,
	type SendQueueEntry,
	type SendSettings
} from "../../shared/app-state.ts";
import { hexByte, type Capture } from "../capture/capture-framing.ts";
import type { SerialController } from "../transport/serial-controller.ts";

export type SendControllerStatus = {
	sendInFlight: boolean;
	queueRunning: boolean;
	stopQueueRequested: boolean;
};

export type SendControllerDependencies = {
	state: AppState;
	capture: () => Capture | undefined;
	transport: Pick<SerialController, "getPort" | "isRecording" | "queueLiveBytes">;
	saveState: (options?: { immediate?: boolean }) => void;
	showToast: (message: string) => void;
	confirm: (message: string) => boolean;
	publishSendState: () => void;
	generateId?: () => string;
	now?: () => number;
};

type ReadySendState = AppState & {
	sendHistory: SendHistoryEntry[];
	sendQueue: SendQueueEntry[];
	sendSettings: SendSettings;
};

export function createSendController(dependencies: SendControllerDependencies) {
	const state = dependencies.state as ReadySendState;
	const generateId = dependencies.generateId || (() => crypto.randomUUID());
	const now = dependencies.now || (() => Date.now());
	let sendInFlight = false;
	let queueRunning = false;
	let stopQueueRequested = false;
	let queueDelayTimer: ReturnType<typeof setTimeout> | null = null;
	let queueDelayResolve: (() => void) | null = null;

	function getStatus(): SendControllerStatus {
		return {
			sendInFlight,
			queueRunning,
			stopQueueRequested
		};
	}

	function recordSend(bytes: Iterable<number>, { origin, ok, error = "" }: { origin: string; ok: boolean; error?: string }) {
		const entry = {
			id: generateId(),
			timestamp: now(),
			bytes: [...bytes],
			origin,
			ok,
			error,
			captureId: ok && dependencies.transport.isRecording() ? dependencies.capture()?.id || null : null
		};
		state.sendHistory.unshift(entry);
		state.sendHistory = state.sendHistory.slice(0, MAX_SEND_HISTORY);
		dependencies.saveState({ immediate: true });
	}

	async function transmitBytes(bytes: Uint8Array, origin = "manual") {
		if (!bytes?.length) return false;
		const port = dependencies.transport.getPort();
		if (!port?.writable) {
			dependencies.showToast("Connect a writable serial port first");
			return false;
		}
		if (sendInFlight) {
			dependencies.showToast("A message is already being sent");
			return false;
		}
		sendInFlight = true;
		dependencies.publishSendState();
		try {
			const writer = port.writable.getWriter();
			try {
				await writer.write(bytes);
			} finally {
				writer.releaseLock();
			}
			if (dependencies.transport.isRecording() && dependencies.capture()) {
				dependencies.transport.queueLiveBytes(bytes, "tx");
			}
			recordSend(bytes, { origin, ok: true });
			dependencies.showToast(`${bytes.length} byte${bytes.length === 1 ? "" : "s"} sent to RS-485`);
			return true;
		} catch (error) {
			const message = (error as { message: string }).message;
			recordSend(bytes, { origin, ok: false, error: message });
			dependencies.showToast(`Send failed: ${message}`);
			return false;
		} finally {
			sendInFlight = false;
			dependencies.publishSendState();
		}
	}

	async function sendBytes(bytes: readonly number[]) {
		if (!bytes?.length) return false;
		const sent = await transmitBytes(Uint8Array.from(bytes), "manual");
		if (!sent) return false;
		state.sendSettings.draft = "";
		dependencies.saveState();
		dependencies.publishSendState();
		return true;
	}

	function addDraftToQueue(bytes: readonly number[]) {
		if (!bytes?.length) return false;
		state.sendQueue.push({
			id: generateId(),
			bytes: [...bytes],
			createdAt: now()
		});
		state.sendSettings.draft = "";
		dependencies.saveState();
		dependencies.publishSendState();
		dependencies.showToast("Message added to transmit queue");
		return true;
	}

	function setSendDraft(value: string) {
		state.sendSettings.draft = String(value);
		dependencies.saveState();
		dependencies.publishSendState();
	}

	function setQueueDelay(value: number) {
		state.sendSettings.delayMs = Math.max(0, Math.min(600_000, Number(value) || 0));
		dependencies.saveState({ immediate: true });
		dependencies.publishSendState();
	}

	function sendQueueItem(id: string) {
		const item = state.sendQueue.find(entry => entry.id === id);
		if (item) void transmitBytes(Uint8Array.from(item.bytes as number[]), "manual");
	}

	function removeQueueItem(id: string) {
		state.sendQueue = state.sendQueue.filter(item => item.id !== id);
		dependencies.saveState();
		dependencies.publishSendState();
	}

	function loadHistoryItem(id: string) {
		const item = state.sendHistory.find(entry => entry.id === id);
		if (!item) return null;
		const draft = (item.bytes as number[]).map(hexByte).join(" ");
		state.sendSettings.draft = draft;
		dependencies.saveState();
		dependencies.publishSendState();
		return draft;
	}

	function replayHistoryItem(id: string) {
		const item = state.sendHistory.find(entry => entry.id === id);
		if (item) void transmitBytes(Uint8Array.from(item.bytes as number[]), "replay");
	}

	function stopSendQueue() {
		stopQueueRequested = true;
		queueDelayResolve?.();
		dependencies.publishSendState();
	}

	function clearSendQueue() {
		if (!state.sendQueue.length || queueRunning) return;
		if (!dependencies.confirm("Clear every message from the transmit queue?")) return;
		state.sendQueue = [];
		dependencies.saveState({ immediate: true });
		dependencies.publishSendState();
	}

	function clearSendHistory() {
		if (!state.sendHistory.length) return;
		if (!dependencies.confirm("Clear the separate local send history? Captured TX bytes will remain in captures.")) return;
		state.sendHistory = [];
		dependencies.saveState({ immediate: true });
		dependencies.publishSendState();
	}

	function waitForQueueDelay(ms: number) {
		return new Promise<void>(resolve => {
			const finish = () => {
				if (queueDelayTimer) clearTimeout(queueDelayTimer);
				queueDelayTimer = null;
				queueDelayResolve = null;
				resolve();
			};
			queueDelayResolve = finish;
			queueDelayTimer = setTimeout(finish, ms);
		});
	}

	async function runSendQueue() {
		if (queueRunning || sendInFlight || !dependencies.transport.getPort()?.writable || !state.sendQueue.length) return;
		queueRunning = true;
		stopQueueRequested = false;
		dependencies.publishSendState();
		const queued = [...state.sendQueue];
		let completed = 0;
		try {
			for (let index = 0; index < queued.length; index++) {
				if (stopQueueRequested || !dependencies.transport.getPort()?.writable) break;
				const sent = await transmitBytes(Uint8Array.from(queued[index].bytes as number[]), "queue");
				if (!sent) break;
				completed++;
				state.sendQueue = state.sendQueue.filter(item => item.id !== queued[index].id);
				dependencies.saveState({ immediate: true });
				dependencies.publishSendState();
				if (index < queued.length - 1 && !stopQueueRequested) {
					await waitForQueueDelay(state.sendSettings.delayMs);
				}
			}
		} finally {
			queueRunning = false;
			stopQueueRequested = false;
			dependencies.publishSendState();
			if (completed) {
				dependencies.showToast(`Queue sent ${completed} message${completed === 1 ? "" : "s"}`);
			}
		}
	}

	return {
		getStatus,
		transmitBytes,
		sendBytes,
		addDraftToQueue,
		setSendDraft,
		setQueueDelay,
		sendQueueItem,
		removeQueueItem,
		loadHistoryItem,
		replayHistoryItem,
		stopSendQueue,
		clearSendQueue,
		clearSendHistory,
		runSendQueue
	};
}

export type SendController = ReturnType<typeof createSendController>;

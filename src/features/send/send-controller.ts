import {
	MAX_SEND_HISTORY,
	type AppState,
	type SendHistoryEntry,
	type SendQueueEntry,
	type SendSettings
} from "../../shared/app-state.ts";
import { hexByte, type Capture } from "../capture/capture-framing.ts";
import type { SerialController } from "../transport/serial-controller.ts";
import type { ArchiveCommands } from "../../data/archive-data-layer.ts";

export type SendControllerStatus = {
	sendInFlight: boolean;
	queueRunning: boolean;
	stopQueueRequested: boolean;
};

export type SendControllerDependencies = {
	state: AppState;
	capture: () => Capture | undefined;
	transport: Pick<SerialController, "getPort" | "isRecording" | "queueLiveBytes">;
	archiveCommands?: ArchiveCommands;
	showToast: (message: string) => void;
	confirm: (message: string) => boolean;
	publishSendState: () => void;
	publishPersistenceError?: (error: { message: string; canRetry: boolean } | null) => void;
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
	let retryOperation: (() => Promise<void>) | null = null;
	let settingsPersistTimer: ReturnType<typeof setTimeout> | null = null;
	let settingsWriteInFlight: Promise<void> | null = null;
	let pendingSettingsWrite: { desired: SendSettings; previous: SendSettings } | null = null;

	function reportPersistenceFailure(error: unknown, retry: () => Promise<void>): void {
		retryOperation = retry;
		const message = error instanceof Error ? error.message : String(error);
		dependencies.publishPersistenceError?.({ message, canRetry: true });
		dependencies.showToast(`Archive persistence failed: ${message}`);
	}

	function clearPersistenceFailure(): void {
		retryOperation = null;
		dependencies.publishPersistenceError?.(null);
	}

	async function retryPersistence(): Promise<void> {
		const retry = retryOperation;
		if (!retry) return;
		retryOperation = null;
		try {
			await retry();
			clearPersistenceFailure();
		} catch (error) {
			reportPersistenceFailure(error, retry);
		}
	}

	function getStatus(): SendControllerStatus {
		return {
			sendInFlight,
			queueRunning,
			stopQueueRequested
		};
	}

	async function writeSettings(desired: SendSettings, previous: SendSettings): Promise<void> {
		if (!dependencies.archiveCommands) return;
		try {
			await dependencies.archiveCommands.saveSettings(desired);
			clearPersistenceFailure();
		} catch (error) {
			if (state.sendSettings.delayMs === desired.delayMs) state.sendSettings.delayMs = previous.delayMs;
			if (state.sendSettings.draft === desired.draft) state.sendSettings.draft = previous.draft;
			if (state.sendSettings.baudRate === desired.baudRate) state.sendSettings.baudRate = previous.baudRate;
			dependencies.publishSendState();
			reportPersistenceFailure(error, async () => {
				Object.assign(state.sendSettings, desired);
				dependencies.publishSendState();
				await writeSettings(desired, previous);
			});
			throw error;
		}
	}

	function flushPendingSettings(): void {
		if (settingsWriteInFlight || !pendingSettingsWrite) return;
		const pending = pendingSettingsWrite;
		pendingSettingsWrite = null;
		const write = writeSettings(pending.desired, pending.previous);
		settingsWriteInFlight = write;
		void write.then(
			() => {
				settingsWriteInFlight = null;
				flushPendingSettings();
			},
			() => {
				settingsWriteInFlight = null;
				flushPendingSettings();
			}
		);
	}

	function persistSettings(previous: SendSettings, immediate = false): void {
		if (!dependencies.archiveCommands) return;
		pendingSettingsWrite = {
			desired: { ...state.sendSettings },
			previous: pendingSettingsWrite?.previous || previous
		};
		if (immediate) {
			if (settingsPersistTimer) clearTimeout(settingsPersistTimer);
			settingsPersistTimer = null;
			flushPendingSettings();
			return;
		}
		if (settingsPersistTimer === null) {
			settingsPersistTimer = setTimeout(() => {
				settingsPersistTimer = null;
				flushPendingSettings();
			}, 75);
		}
	}

	function persistQueueItem(item: SendQueueEntry, position: number): Promise<void> {
		return dependencies.archiveCommands ? dependencies.archiveCommands.saveQueueItem(item, position) : Promise.resolve();
	}

	function persistHistoryItem(item: SendHistoryEntry, previous: SendHistoryEntry[]): void {
		if (!dependencies.archiveCommands) return;
		void dependencies.archiveCommands.saveHistoryItem(item).then(() => {
			clearPersistenceFailure();
		}).catch(error => {
			state.sendHistory = previous;
			dependencies.publishSendState();
			reportPersistenceFailure(error, async () => {
				if (!state.sendHistory.some(candidate => candidate.id === item.id)) {
					state.sendHistory = [item, ...state.sendHistory].slice(0, MAX_SEND_HISTORY);
					dependencies.publishSendState();
				}
				await dependencies.archiveCommands!.saveHistoryItem(item);
				clearPersistenceFailure();
			});
		});
	}

	function deleteQueueItem(item: SendQueueEntry, restoreIndex = 0): void {
		if (!item.id) return;
		if (dependencies.archiveCommands) {
			void dependencies.archiveCommands.deleteQueueItem(item.id).then(() => {
				clearPersistenceFailure();
			}).catch(error => {
				if (!state.sendQueue.some(candidate => candidate.id === item.id)) {
					state.sendQueue.splice(Math.min(restoreIndex, state.sendQueue.length), 0, item);
				}
				dependencies.publishSendState();
				reportPersistenceFailure(error, async () => {
					state.sendQueue = state.sendQueue.filter(candidate => candidate.id !== item.id);
					dependencies.publishSendState();
					await dependencies.archiveCommands!.deleteQueueItem(item.id!);
					clearPersistenceFailure();
				});
			});
		}
	}

	function deleteHistoryItem(item: SendHistoryEntry, restoreIndex = 0): void {
		const id = typeof item.id === "string" ? item.id : "";
		if (!id) return;
		if (dependencies.archiveCommands) {
			void dependencies.archiveCommands.deleteHistoryItem(id).then(() => {
				clearPersistenceFailure();
			}).catch(error => {
				if (!state.sendHistory.some(candidate => candidate.id === id)) {
					state.sendHistory.splice(Math.min(restoreIndex, state.sendHistory.length), 0, item);
				}
				dependencies.publishSendState();
				reportPersistenceFailure(error, async () => {
					state.sendHistory = state.sendHistory.filter(candidate => candidate.id !== id);
					dependencies.publishSendState();
					await dependencies.archiveCommands!.deleteHistoryItem(id);
					clearPersistenceFailure();
				});
			});
		}
	}

	function recordSend(bytes: Iterable<number>, { origin, ok, error = "" }: { origin: string; ok: boolean; error?: string }) {
		const previousHistory = [...state.sendHistory];
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
		persistHistoryItem(entry, previousHistory);
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
		const previousSettings = { ...state.sendSettings };
		state.sendSettings.draft = "";
		persistSettings(previousSettings, true);
		dependencies.publishSendState();
		return true;
	}

	function addDraftToQueue(bytes: readonly number[]) {
		if (!bytes?.length) return false;
		const item: SendQueueEntry = {
			id: generateId(),
			bytes: [...bytes],
			createdAt: now()
		};
		const position = state.sendQueue.length;
		const previousSettings = { ...state.sendSettings };
		state.sendQueue.push(item);
		state.sendSettings.draft = "";
		void persistQueueItem(item, position).then(() => {
			clearPersistenceFailure();
		}).catch(error => {
			state.sendQueue = state.sendQueue.filter(candidate => candidate.id !== item.id);
			dependencies.publishSendState();
			reportPersistenceFailure(error, async () => {
				if (!state.sendQueue.some(candidate => candidate.id === item.id)) {
					state.sendQueue.splice(Math.min(position, state.sendQueue.length), 0, item);
					dependencies.publishSendState();
				}
				await persistQueueItem(item, position);
				clearPersistenceFailure();
			});
		});
		persistSettings(previousSettings, true);
		dependencies.publishSendState();
		dependencies.showToast("Message added to transmit queue");
		return true;
	}

	function setSendDraft(value: string) {
		const previousSettings = { ...state.sendSettings };
		state.sendSettings.draft = String(value);
		persistSettings(previousSettings);
		dependencies.publishSendState();
	}

	function setQueueDelay(value: number) {
		const previousSettings = { ...state.sendSettings };
		state.sendSettings.delayMs = Math.max(0, Math.min(600_000, Number(value) || 0));
		persistSettings(previousSettings);
		dependencies.publishSendState();
	}

	function sendQueueItem(id: string) {
		const item = state.sendQueue.find(entry => entry.id === id);
		if (item) void transmitBytes(Uint8Array.from(item.bytes as number[]), "manual");
	}

	function removeQueueItem(id: string) {
		const removed = state.sendQueue.find(item => item.id === id);
		const restoreIndex = state.sendQueue.findIndex(item => item.id === id);
		state.sendQueue = state.sendQueue.filter(item => item.id !== id);
		if (removed) deleteQueueItem(removed, restoreIndex);
		dependencies.publishSendState();
	}

	function loadHistoryItem(id: string) {
		const item = state.sendHistory.find(entry => entry.id === id);
		if (!item) return null;
		const draft = (item.bytes as number[]).map(hexByte).join(" ");
		const previousSettings = { ...state.sendSettings };
		state.sendSettings.draft = draft;
		persistSettings(previousSettings, true);
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
		const removed = [...state.sendQueue];
		state.sendQueue = [];
		removed.forEach((item, index) => deleteQueueItem(item, index));
		dependencies.publishSendState();
	}

	function clearSendHistory() {
		if (!state.sendHistory.length) return;
		if (!dependencies.confirm("Clear the separate local send history? Captured TX bytes will remain in captures.")) return;
		const removed = [...state.sendHistory];
		state.sendHistory = [];
		removed.forEach((item, index) => deleteHistoryItem(item, index));
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
				const removed = queued[index];
				state.sendQueue = state.sendQueue.filter(item => item.id !== removed.id);
				deleteQueueItem(removed, index);
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
		runSendQueue,
		retryPersistence
	};
}

export type SendController = ReturnType<typeof createSendController>;

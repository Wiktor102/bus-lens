import {
	MAX_SEND_HISTORY,
	type SendHistoryEntry,
	type SendQueueEntry,
	type SendSettings
} from "../../shared/app-state.ts";
import type { Capture } from "../capture/capture-framing.ts";
import type { SerialController } from "../transport/serial-controller.ts";
import type { ArchiveCommands } from "../../data/archive-data-layer.ts";
import type { ApplicationEvent } from "../../shared/application-store.ts";
import type { DialogCommandInput } from "../dialogs/dialog-model.ts";

export type SendControllerStatus = {
	sendInFlight: boolean;
	queueRunning: boolean;
	stopQueueRequested: boolean;
};

type SendWorkflowEvent = Extract<
	ApplicationEvent,
	{ type: "send/started" | "send/succeeded" | "send/failed" | "queue/started" | "queue/succeeded" | "queue/failed" }
>;

type SendCompatibilityState = {
	sendHistory?: SendHistoryEntry[];
	sendQueue?: SendQueueEntry[];
	sendSettings?: Partial<SendSettings>;
};

export type SendControllerDependencies = {
	/** Test-only compatibility input; production reads come from TanStack Query. */
	state?: SendCompatibilityState;
	getQueue?: () => readonly SendQueueEntry[] | undefined;
	getHistory?: () => readonly SendHistoryEntry[] | undefined;
	getSettings?: () => SendSettings | undefined;
	capture: () => Capture | undefined;
	transport: Pick<SerialController, "getPort" | "isRecording" | "queueLiveBytes">;
	archiveCommands?: ArchiveCommands;
	showToast: (message: string) => void;
	publishDialogCommand: (command: DialogCommandInput) => void;
	publishSendState: () => void;
	publishSendWorkflow?: (event: SendWorkflowEvent) => void;
	publishPersistenceError?: (error: { message: string; canRetry: boolean } | null) => void;
	generateId?: () => string;
	now?: () => number;
};

const defaultSettings: SendSettings = { delayMs: 100, draft: "", baudRate: 115200 };

export function createSendController(dependencies: SendControllerDependencies) {
	const compatibilityState = dependencies.state;
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

	function settings(): SendSettings {
		return {
			...defaultSettings,
			...(dependencies.getSettings?.() || compatibilityState?.sendSettings || {})
		};
	}

	function queue(): readonly SendQueueEntry[] {
		return dependencies.getQueue?.() || compatibilityState?.sendQueue || [];
	}

	function history(): readonly SendHistoryEntry[] {
		return dependencies.getHistory?.() || compatibilityState?.sendHistory || [];
	}

	function replaceSettings(next: SendSettings): void {
		if (compatibilityState) compatibilityState.sendSettings = { ...next };
	}

	function replaceQueue(next: SendQueueEntry[]): void {
		if (compatibilityState) compatibilityState.sendQueue = next;
	}

	function replaceHistory(next: SendHistoryEntry[]): void {
		if (compatibilityState) compatibilityState.sendHistory = next;
	}

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
		return { sendInFlight, queueRunning, stopQueueRequested };
	}

	async function writeSettings(desired: SendSettings, previous: SendSettings): Promise<void> {
		if (!dependencies.archiveCommands) return;
		try {
			await dependencies.archiveCommands.saveSettings(desired);
			clearPersistenceFailure();
		} catch (error) {
			if (compatibilityState) replaceSettings(previous);
			dependencies.publishSendState();
			reportPersistenceFailure(error, async () => {
				replaceSettings(desired);
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
			desired: settings(),
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
			if (compatibilityState) replaceHistory(previous);
			dependencies.publishSendState();
			reportPersistenceFailure(error, async () => {
				if (compatibilityState && !history().some(candidate => candidate.id === item.id)) {
					replaceHistory([item, ...history()].slice(0, MAX_SEND_HISTORY));
					dependencies.publishSendState();
				}
				await dependencies.archiveCommands!.saveHistoryItem(item);
				clearPersistenceFailure();
			});
		});
	}

	function deleteQueueItem(item: SendQueueEntry, restoreIndex = 0): void {
		if (!item.id || !dependencies.archiveCommands) return;
		void dependencies.archiveCommands.deleteQueueItem(item.id).then(() => {
			clearPersistenceFailure();
		}).catch(error => {
			if (compatibilityState && !queue().some(candidate => candidate.id === item.id)) {
				const restored = [...queue()];
				restored.splice(Math.min(restoreIndex, restored.length), 0, item);
				replaceQueue(restored);
			}
			dependencies.publishSendState();
			reportPersistenceFailure(error, async () => {
				if (compatibilityState) replaceQueue(queue().filter(candidate => candidate.id !== item.id));
				dependencies.publishSendState();
				await dependencies.archiveCommands!.deleteQueueItem(item.id!);
				clearPersistenceFailure();
			});
		});
	}

	function deleteHistoryItem(item: SendHistoryEntry, restoreIndex = 0): void {
		const id = typeof item.id === "string" ? item.id : "";
		if (!id || !dependencies.archiveCommands) return;
		void dependencies.archiveCommands.deleteHistoryItem(id).then(() => {
			clearPersistenceFailure();
		}).catch(error => {
			if (compatibilityState && !history().some(candidate => candidate.id === id)) {
				const restored = [...history()];
				restored.splice(Math.min(restoreIndex, restored.length), 0, item);
				replaceHistory(restored);
			}
			dependencies.publishSendState();
			reportPersistenceFailure(error, async () => {
				if (compatibilityState) replaceHistory(history().filter(candidate => candidate.id !== id));
				dependencies.publishSendState();
				await dependencies.archiveCommands!.deleteHistoryItem(id);
				clearPersistenceFailure();
			});
		});
	}

	function recordSend(bytes: Iterable<number>, { origin, ok, error = "" }: { origin: string; ok: boolean; error?: string }): void {
		const previousHistory = [...history()];
		const entry: SendHistoryEntry = {
			id: generateId(),
			timestamp: now(),
			bytes: [...bytes],
			origin,
			ok,
			error,
			captureId: ok && dependencies.transport.isRecording() ? dependencies.capture()?.id || null : null
		};
		replaceHistory([entry, ...previousHistory].slice(0, MAX_SEND_HISTORY));
		persistHistoryItem(entry, previousHistory);
	}

	async function transmitBytes(bytes: Uint8Array, origin = "manual"): Promise<boolean> {
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
		dependencies.publishSendWorkflow?.({ type: "send/started", startedAt: now() });
		sendInFlight = true;
		dependencies.publishSendState();
		try {
			const writer = port.writable.getWriter();
			try {
				await writer.write(bytes);
			} finally {
				writer.releaseLock();
			}
			if (dependencies.transport.isRecording() && dependencies.capture()) dependencies.transport.queueLiveBytes(bytes, "tx");
			recordSend(bytes, { origin, ok: true });
			dependencies.showToast(`${bytes.length} byte${bytes.length === 1 ? "" : "s"} sent to RS-485`);
			dependencies.publishSendWorkflow?.({ type: "send/succeeded", completedAt: now() });
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			recordSend(bytes, { origin, ok: false, error: message });
			dependencies.publishSendWorkflow?.({ type: "send/failed", error: message, canRetry: false });
			dependencies.showToast(`Send failed: ${message}`);
			return false;
		} finally {
			sendInFlight = false;
			dependencies.publishSendState();
		}
	}

	async function sendBytes(bytes: readonly number[]): Promise<boolean> {
		if (!bytes?.length) return false;
		const sent = await transmitBytes(Uint8Array.from(bytes), "manual");
		if (!sent) return false;
		const previousSettings = settings();
		replaceSettings({ ...previousSettings, draft: "" });
		persistSettings(previousSettings, true);
		dependencies.publishSendState();
		return true;
	}

	function addDraftToQueue(bytes: readonly number[]): boolean {
		if (!bytes?.length) return false;
		const item: SendQueueEntry = { id: generateId(), bytes: [...bytes], createdAt: now() };
		const position = queue().length;
		const previousSettings = settings();
		replaceQueue([...queue(), item]);
		replaceSettings({ ...previousSettings, draft: "" });
		void persistQueueItem(item, position).then(() => clearPersistenceFailure()).catch(error => {
			if (compatibilityState) replaceQueue(queue().filter(candidate => candidate.id !== item.id));
			dependencies.publishSendState();
			reportPersistenceFailure(error, async () => {
				if (compatibilityState && !queue().some(candidate => candidate.id === item.id)) replaceQueue([...queue(), item]);
				dependencies.publishSendState();
				await persistQueueItem(item, position);
				clearPersistenceFailure();
			});
		});
		persistSettings(previousSettings, true);
		dependencies.publishSendState();
		dependencies.showToast("Message added to transmit queue");
		return true;
	}

	function setSendDraft(value: string): void {
		const previous = settings();
		replaceSettings({ ...previous, draft: String(value) });
		persistSettings(previous);
		dependencies.publishSendState();
	}

	function setQueueDelay(value: number): void {
		const previous = settings();
		replaceSettings({ ...previous, delayMs: Math.max(0, Math.min(600_000, Number(value) || 0)) });
		persistSettings(previous);
		dependencies.publishSendState();
	}

	function sendQueueItem(id: string): void {
		const item = queue().find(entry => entry.id === id);
		if (item) void transmitBytes(Uint8Array.from(item.bytes as number[]), "manual");
	}

	function removeQueueItem(id: string): void {
		const removed = queue().find(item => item.id === id);
		const restoreIndex = queue().findIndex(item => item.id === id);
		if (compatibilityState) replaceQueue(queue().filter(item => item.id !== id));
		if (removed) deleteQueueItem(removed, restoreIndex);
		dependencies.publishSendState();
	}

	function replayHistoryItem(id: string): void {
		const item = history().find(entry => entry.id === id);
		if (item) void transmitBytes(Uint8Array.from(item.bytes as number[]), "replay");
	}

	function stopSendQueue(): void {
		stopQueueRequested = true;
		queueDelayResolve?.();
		dependencies.publishSendState();
	}

	function requestClearSendQueue(): void {
		if (!queue().length || queueRunning) return;
		dependencies.publishDialogCommand({
			type: "confirmation",
			eyebrow: "Transmit queue",
			title: "Clear transmit queue?",
			message: "Every queued message will be removed before it is sent.",
			detail: "Captured TX bytes are not affected by this action.",
			confirmLabel: "Clear queue",
			action: { type: "send/clear-queue" }
		});
	}

	function clearSendQueue(): void {
		if (!queue().length || queueRunning) return;
		const removed = [...queue()];
		if (compatibilityState) replaceQueue([]);
		removed.forEach((item, index) => deleteQueueItem(item, index));
		dependencies.publishSendState();
	}

	function requestClearSendHistory(): void {
		if (!history().length) return;
		dependencies.publishDialogCommand({
			eyebrow: "Transmit history",
			type: "confirmation",
			title: "Clear send history?",
			message: "The local record of sent messages will be removed.",
			detail: "Captured TX bytes will remain in captures.",
			confirmLabel: "Clear history",
			action: { type: "send/clear-history" }
		});
	}

	function clearSendHistory(): void {
		if (!history().length) return;
		const removed = [...history()];
		if (compatibilityState) replaceHistory([]);
		removed.forEach((item, index) => deleteHistoryItem(item, index));
		dependencies.publishSendState();
	}

	function waitForQueueDelay(ms: number): Promise<void> {
		return new Promise(resolve => {
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

	async function runSendQueue(): Promise<void> {
		if (queueRunning || sendInFlight || !dependencies.transport.getPort()?.writable || !queue().length) return;
		queueRunning = true;
		stopQueueRequested = false;
		dependencies.publishSendWorkflow?.({ type: "queue/started", startedAt: now() });
		dependencies.publishSendState();
		const queued = [...queue()];
		let completed = 0;
		let queueFailure: string | null = null;
		let queueCanRetry = false;
		try {
			for (let index = 0; index < queued.length; index++) {
				if (stopQueueRequested) {
					queueFailure = "Queue stopped";
					queueCanRetry = true;
					break;
				}
				if (!dependencies.transport.getPort()?.writable) {
					queueFailure = "Queue stopped because the serial port is unavailable";
					queueCanRetry = true;
					break;
				}
				const sent = await transmitBytes(Uint8Array.from(queued[index].bytes as number[]), "queue");
				if (!sent) {
					queueFailure = "A queued message could not be sent";
					break;
				}
				completed++;
				const removed = queued[index];
				if (compatibilityState) replaceQueue(queue().filter(item => item.id !== removed.id));
				deleteQueueItem(removed, index);
				dependencies.publishSendState();
				if (index < queued.length - 1 && !stopQueueRequested) await waitForQueueDelay(settings().delayMs);
			}
		} catch (error) {
			queueFailure = error instanceof Error ? error.message : String(error);
			queueCanRetry = false;
			throw error;
		} finally {
			queueRunning = false;
			stopQueueRequested = false;
			dependencies.publishSendState();
			if (queueFailure) dependencies.publishSendWorkflow?.({ type: "queue/failed", error: queueFailure, canRetry: queueCanRetry });
			else dependencies.publishSendWorkflow?.({ type: "queue/succeeded", completedAt: now() });
			if (completed) dependencies.showToast(`Queue sent ${completed} message${completed === 1 ? "" : "s"}`);
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
		replayHistoryItem,
		stopSendQueue,
		requestClearSendQueue,
		clearSendQueue,
		requestClearSendHistory,
		clearSendHistory,
		runSendQueue,
		retryPersistence
	};
}

export type SendController = ReturnType<typeof createSendController>;

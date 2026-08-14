import { createExternalStore } from "../../shared/external-store.ts";
import type { SendSnapshot } from "./send.ts";

/** Live transport state only; queue/history/settings are Query-owned. */
export type SendRuntimeSnapshot = Pick<
	SendSnapshot,
	"connected" | "recording" | "sendInFlight" | "queueRunning" | "stopQueueRequested"
>;

const EMPTY_SEND_RUNTIME_SNAPSHOT: SendRuntimeSnapshot = {
	connected: false,
	recording: false,
	sendInFlight: false,
	queueRunning: false,
	stopQueueRequested: false
};

export type SendActions = {
	setDraft: (value: string) => void;
	setDelay: (value: number) => void;
	send: (bytes: readonly number[]) => Promise<boolean>;
	addToQueue: (bytes: readonly number[]) => boolean;
	sendQueueItem: (id: string) => void;
	removeQueueItem: (id: string) => void;
	loadHistory: (id: string) => string | null;
	replayHistory: (id: string) => void;
	runQueue: () => Promise<void>;
	stopQueue: () => void;
	clearQueue: () => void;
	clearHistory: () => void;
};

const noopActions: SendActions = {
	setDraft: () => {},
	setDelay: () => {},
	send: async () => false,
	addToQueue: () => false,
	sendQueueItem: () => {},
	removeQueueItem: () => {},
	loadHistory: () => null,
	replayHistory: () => {},
	runQueue: async () => {},
	stopQueue: () => {},
	clearQueue: () => {},
	clearHistory: () => {}
};

const sendStore = createExternalStore<SendRuntimeSnapshot, SendActions>(EMPTY_SEND_RUNTIME_SNAPSHOT, noopActions);

export const getSendSnapshot = sendStore.getSnapshot;
export const subscribeToSend = sendStore.subscribe;
export const publishSendRuntimeSnapshot = sendStore.publish;
export const registerSendActions = sendStore.registerActions;
export const getSendActions = sendStore.getActions;

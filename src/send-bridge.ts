import { createExternalStore } from "./external-store.ts";
import { EMPTY_SEND_SNAPSHOT, type SendSnapshot } from "./send.ts";

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

const sendStore = createExternalStore<SendSnapshot, SendActions>(EMPTY_SEND_SNAPSHOT, noopActions);

export const getSendSnapshot = sendStore.getSnapshot;
export const subscribeToSend = sendStore.subscribe;
export const publishSendSnapshot = sendStore.publish;
export const registerSendActions = sendStore.registerActions;
export const getSendActions = sendStore.getActions;

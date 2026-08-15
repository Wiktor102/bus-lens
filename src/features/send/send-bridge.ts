import { applicationStore } from "../../shared/application-store.ts";

/** Typed command actions; queue/history data remains Query-owned. */
export type SendActions = {
	setDraft: (value: string) => void;
	setDelay: (value: number) => void;
	send: (bytes: readonly number[]) => Promise<boolean>;
	addToQueue: (bytes: readonly number[]) => boolean;
	sendQueueItem: (id: string) => void;
	removeQueueItem: (id: string) => void;
	replayHistory: (id: string) => void;
	runQueue: () => Promise<void>;
	stopQueue: () => void;
	clearQueue: () => void;
	clearHistory: () => void;
};

const actions: SendActions = {
	setDraft: value => applicationStore.sendCommand({ type: "send/set-draft", value }),
	setDelay: value => applicationStore.sendCommand({ type: "send/set-delay", value }),
	send: bytes => new Promise(resolve => {
		applicationStore.sendCommand({ type: "send/send", bytes: [...bytes], respond: resolve });
	}),
	addToQueue: bytes => {
		if (!bytes.length) return false;
		applicationStore.sendCommand({ type: "send/add-to-queue", bytes: [...bytes] });
		return true;
	},
	sendQueueItem: id => applicationStore.sendCommand({ type: "send/send-queue-item", id }),
	removeQueueItem: id => applicationStore.sendCommand({ type: "send/remove-queue-item", id }),
	replayHistory: id => applicationStore.sendCommand({ type: "send/replay-history", id }),
	runQueue: async () => { applicationStore.sendCommand({ type: "send/run-queue" }); },
	stopQueue: () => applicationStore.sendCommand({ type: "send/stop-queue" }),
	clearQueue: () => applicationStore.sendCommand({ type: "send/clear-queue" }),
	clearHistory: () => applicationStore.sendCommand({ type: "send/clear-history" })
};

export const getSendActions = (): SendActions => actions;

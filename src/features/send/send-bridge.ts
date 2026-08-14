/**
 * Compatibility action registry for the send controls.
 *
 * Live send and queue status is owned by the application store; queue/history
 * data remains Query-owned.
 */
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

let actions: SendActions = noopActions;

export const registerSendActions = (next: SendActions): void => {
	actions = next;
};
export const getSendActions = (): SendActions => actions;

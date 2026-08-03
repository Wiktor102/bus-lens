import { createExternalStore } from "../../shared/external-store.ts";
import {
	EMPTY_MESSAGE_STREAM_SNAPSHOT,
	type MessageStreamSnapshot
} from "./message-stream.ts";

export type MessageStreamTarget = {
	messageId: string;
	position: number | null;
};

export type MessageStreamActions = {
	openMessageNote: (messageId: string) => void;
	openByteNote: (messageId: string, position: number) => void;
	replayMessage: (messageId: string) => void;
	openPatternRemark: (patternId: string) => void;
	hideMessage: (messageId: string) => void;
	hideByte: (messageId: string, position: number) => void;
	beginSection: (messageId: string, position: number) => void;
	setSectionFrameSize: (sectionId: string, value: string) => void;
	setSectionCollapse: (sectionId: string, collapseRuns: boolean) => void;
};

const noopActions: MessageStreamActions = {
	openMessageNote: () => {},
	openByteNote: () => {},
	replayMessage: () => {},
	openPatternRemark: () => {},
	hideMessage: () => {},
	hideByte: () => {},
	beginSection: () => {},
	setSectionFrameSize: () => {},
	setSectionCollapse: () => {}
};

const messageStreamStore = createExternalStore<MessageStreamSnapshot, MessageStreamActions>(
	EMPTY_MESSAGE_STREAM_SNAPSHOT,
	noopActions
);

export const getMessageStreamSnapshot = messageStreamStore.getSnapshot;
export const subscribeToMessageStream = messageStreamStore.subscribe;
export const publishMessageStreamSnapshot = messageStreamStore.publish;
export const registerMessageStreamActions = messageStreamStore.registerActions;
export const getMessageStreamActions = messageStreamStore.getActions;

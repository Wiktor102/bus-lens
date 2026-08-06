import { createExternalStore } from "../../shared/external-store.ts";
import {
	EMPTY_MESSAGE_STREAM_SNAPSHOT,
	type MessageStreamSnapshot
} from "./message-stream.ts";
import type { SectionMoveAction } from "../capture/section-repositioning.ts";
import type { SectionFramingUpdate } from "../capture/capture-framing.ts";

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
	moveSection: (sectionId: string, action: SectionMoveAction) => void;
	deleteSection: (sectionId: string) => void;
	setSectionFraming: (sectionId: string, update: SectionFramingUpdate) => void;
	setSectionFrameSize: (sectionId: string, value: string) => void;
	setSectionFramingMode: (sectionId: string, value: string) => void;
	setSectionFrameMarker: (sectionId: string, value: string) => void;
	setSectionMarkerPosition: (sectionId: string, value: string) => void;
	setSectionFrameTimeGap: (sectionId: string, value: string) => void;
	setSectionCollapse: (sectionId: string, collapseRuns: boolean) => void;
	setSectionCollapsed: (sectionId: string, collapsed: boolean) => void;
};

const noopActions: MessageStreamActions = {
	openMessageNote: () => {},
	openByteNote: () => {},
	replayMessage: () => {},
	openPatternRemark: () => {},
	hideMessage: () => {},
	hideByte: () => {},
	beginSection: () => {},
	moveSection: () => {},
	deleteSection: () => {},
	setSectionFraming: () => {},
	setSectionFrameSize: () => {},
	setSectionFramingMode: () => {},
	setSectionFrameMarker: () => {},
	setSectionMarkerPosition: () => {},
	setSectionFrameTimeGap: () => {},
	setSectionCollapse: () => {},
	setSectionCollapsed: () => {}
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

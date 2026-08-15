import type { SectionMoveAction } from "../capture/section-repositioning.ts";
import type { SectionFramingUpdate } from "../capture/capture-framing.ts";
import { applicationStore } from "../../shared/application-store.ts";

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

/** Typed command actions; message stream snapshots are application-store owned. */
const actions: MessageStreamActions = {
	openMessageNote: messageId => applicationStore.sendCommand({ type: "message/open-note", messageId }),
	openByteNote: (messageId, position) => applicationStore.sendCommand({ type: "message/open-byte-note", messageId, position }),
	replayMessage: messageId => applicationStore.sendCommand({ type: "message/replay", messageId }),
	openPatternRemark: patternId => applicationStore.sendCommand({ type: "message/open-pattern-remark", patternId }),
	hideMessage: messageId => applicationStore.sendCommand({ type: "message/hide", messageId }),
	hideByte: (messageId, position) => applicationStore.sendCommand({ type: "message/hide-byte", messageId, position }),
	beginSection: (messageId, position) => applicationStore.sendCommand({ type: "message/begin-section", messageId, position }),
	moveSection: (sectionId, action) => applicationStore.sendCommand({ type: "message/move-section", sectionId, action }),
	deleteSection: sectionId => applicationStore.sendCommand({ type: "message/delete-section", sectionId }),
	setSectionFraming: (sectionId, update) => applicationStore.sendCommand({ type: "message/set-section-framing", sectionId, update }),
	setSectionFrameSize: (sectionId, value) => applicationStore.sendCommand({ type: "message/set-section-frame-size", sectionId, value }),
	setSectionFramingMode: (sectionId, value) => applicationStore.sendCommand({ type: "message/set-section-framing-mode", sectionId, value }),
	setSectionFrameMarker: (sectionId, value) => applicationStore.sendCommand({ type: "message/set-section-frame-marker", sectionId, value }),
	setSectionMarkerPosition: (sectionId, value) => applicationStore.sendCommand({ type: "message/set-section-marker-position", sectionId, value }),
	setSectionFrameTimeGap: (sectionId, value) => applicationStore.sendCommand({ type: "message/set-section-frame-time-gap", sectionId, value }),
	setSectionCollapse: (sectionId, collapseRuns) => applicationStore.sendCommand({ type: "message/set-section-collapse", sectionId, collapseRuns }),
	setSectionCollapsed: (sectionId, collapsed) => applicationStore.sendCommand({ type: "message/set-section-collapsed", sectionId, collapsed })
};

export const getMessageStreamActions = (): MessageStreamActions => actions;

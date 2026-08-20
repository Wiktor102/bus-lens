import { applicationStore } from "../../shared/application-store.ts";

export type CaptureHeaderActions = {
	setTitle: (value: string) => void;
	commitTitle: (value: string) => void;
	setDescription: (value: string) => void;
	commitDescription: (value: string) => void;
	openContext: () => void;
	duplicate: () => void;
	clearMessages: () => void;
	deleteCapture: () => void;
	upgradeStorage: () => void;
};

/** Typed command actions; header data is derived from query state. */
const actions: CaptureHeaderActions = {
	setTitle: value => applicationStore.sendCommand({ type: "capture/set-title", value }),
	commitTitle: value => applicationStore.sendCommand({ type: "capture/commit-title", value }),
	setDescription: value => applicationStore.sendCommand({ type: "capture/set-description", value }),
	commitDescription: value => applicationStore.sendCommand({ type: "capture/commit-description", value }),
	openContext: () => applicationStore.sendCommand({ type: "capture/open-context" }),
	duplicate: () => applicationStore.sendCommand({ type: "capture/duplicate" }),
	clearMessages: () => applicationStore.sendCommand({ type: "capture/clear-messages" }),
	deleteCapture: () => applicationStore.sendCommand({ type: "capture/delete-active" }),
	upgradeStorage: () => applicationStore.sendCommand({ type: "capture/upgrade-active" })
};

export const getCaptureHeaderActions = (): CaptureHeaderActions => actions;

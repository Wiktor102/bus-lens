import { createExternalStore } from "../../shared/external-store.ts";
import { EMPTY_CAPTURE_HEADER_SNAPSHOT, type CaptureHeaderSnapshot } from "./capture-header.ts";

export type CaptureHeaderActions = {
	setTitle: (value: string) => void;
	commitTitle: (value: string) => void;
	setDescription: (value: string) => void;
	commitDescription: (value: string) => void;
	openContext: () => void;
	duplicate: () => void;
	clearMessages: () => void;
	deleteCapture: () => void;
};

const noopActions: CaptureHeaderActions = {
	setTitle: () => {},
	commitTitle: () => {},
	setDescription: () => {},
	commitDescription: () => {},
	openContext: () => {},
	duplicate: () => {},
	clearMessages: () => {},
	deleteCapture: () => {}
};

const captureHeaderStore = createExternalStore<CaptureHeaderSnapshot, CaptureHeaderActions>(
	EMPTY_CAPTURE_HEADER_SNAPSHOT,
	noopActions
);

export const getCaptureHeaderSnapshot = captureHeaderStore.getSnapshot;
export const subscribeToCaptureHeader = captureHeaderStore.subscribe;
export const publishCaptureHeaderSnapshot = captureHeaderStore.publish;
export const registerCaptureHeaderActions = captureHeaderStore.registerActions;
export const getCaptureHeaderActions = captureHeaderStore.getActions;

import { createExternalStore } from "../../shared/external-store.ts";
import type { CanonicalizationJob, CanonicalizationPreflight } from "../../persistence/archive-client.ts";

export type CanonicalizationDialogSnapshot = {
	open: boolean;
	captureId: string | null;
	captureName: string;
	preflight: CanonicalizationPreflight | null;
	job: CanonicalizationJob | null;
	loading: boolean;
	starting: boolean;
	error: string | null;
};

export type CanonicalizationDialogActions = {
	close: () => void;
	download: () => void;
	start: () => void;
	retry: () => void;
};

const emptySnapshot: CanonicalizationDialogSnapshot = {
	open: false,
	captureId: null,
	captureName: "",
	preflight: null,
	job: null,
	loading: false,
	starting: false,
	error: null
};

const store = createExternalStore<CanonicalizationDialogSnapshot, CanonicalizationDialogActions>(emptySnapshot, {
	close: () => {},
	download: () => {},
	start: () => {},
	retry: () => {}
});

export const getCanonicalizationDialogSnapshot = store.getSnapshot;
export const subscribeToCanonicalizationDialog = store.subscribe;
export const publishCanonicalizationDialogSnapshot = store.publish;
export const registerCanonicalizationDialogActions = store.registerActions;
export const getCanonicalizationDialogActions = store.getActions;
export const EMPTY_CANONICALIZATION_DIALOG_SNAPSHOT = emptySnapshot;

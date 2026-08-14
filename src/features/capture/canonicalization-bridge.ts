import {
	applicationStore,
	EMPTY_CANONICALIZATION_STATE,
	selectCanonicalization,
	type ApplicationState,
	type CanonicalizationState
} from "../../shared/application-store.ts";

/**
 * Compatibility surface for older feature callers. The application store owns
 * the canonicalization snapshot; this module no longer keeps a second store.
 */
export type CanonicalizationDialogSnapshot = CanonicalizationState;

export type CanonicalizationDialogActions = {
	close: () => void;
	download: () => void;
	start: () => void;
	retry: () => void;
};

export const EMPTY_CANONICALIZATION_DIALOG_SNAPSHOT: CanonicalizationDialogSnapshot = EMPTY_CANONICALIZATION_STATE;

let actions: CanonicalizationDialogActions = {
	close: () => {},
	download: () => {},
	start: () => {},
	retry: () => {}
};

let lastSnapshot: CanonicalizationDialogSnapshot | undefined;
let lastState: ApplicationState["canonicalization"] | undefined;

export function getCanonicalizationDialogSnapshot(): CanonicalizationDialogSnapshot {
	const state = applicationStore.select(selectCanonicalization);
	if (state !== lastState) {
		lastState = state;
		lastSnapshot = state;
	}
	return lastSnapshot || state;
}

export const subscribeToCanonicalizationDialog = applicationStore.subscribe;

export function publishCanonicalizationDialogSnapshot(snapshot: Partial<CanonicalizationDialogSnapshot>): void {
	applicationStore.send({ type: "canonicalization/changed", update: snapshot });
}

export const registerCanonicalizationDialogActions = (next: CanonicalizationDialogActions): void => {
	actions = next;
};
export const getCanonicalizationDialogActions = (): CanonicalizationDialogActions => actions;

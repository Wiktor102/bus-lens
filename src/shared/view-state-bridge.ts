import { createExternalStore } from "./external-store.ts";
import { EMPTY_VIEW_STATE_SNAPSHOT, type ViewStateSnapshot } from "./view-state.ts";

const viewStateStore = createExternalStore<ViewStateSnapshot, Record<never, never>>(
	EMPTY_VIEW_STATE_SNAPSHOT,
	{}
);

export const getViewStateSnapshot = viewStateStore.getSnapshot;
export const subscribeToViewState = viewStateStore.subscribe;
export const publishViewStateSnapshot = viewStateStore.publish;

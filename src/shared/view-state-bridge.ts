import {
	applicationStore,
	selectViewState
} from "./application-store.ts";
import type { ViewStateSnapshot } from "./view-state.ts";

/**
 * Temporary compatibility surface for the snapshot runtime and feature
 * bridges. New client state must enter through the application store events.
 */
export const getViewStateSnapshot = (): ViewStateSnapshot => applicationStore.select(selectViewState);
export const subscribeToViewState = applicationStore.subscribe;
export function publishViewStateSnapshot(snapshot: ViewStateSnapshot): void {
	applicationStore.send({ type: "view/replaced", viewState: snapshot });
}

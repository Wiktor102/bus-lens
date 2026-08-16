import {
	createApplicationStore,
	type ApplicationStore
} from "../shared/application-store.ts";
import { EMPTY_VIEW_STATE_SNAPSHOT } from "../shared/view-state.ts";

/** Create an isolated event store for a test. */
export function createTestApplicationStore() {
	return createApplicationStore({ ...EMPTY_VIEW_STATE_SNAPSHOT });
}

export type TestApplicationStore = ApplicationStore;

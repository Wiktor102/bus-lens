import {
	applicationStore,
	EMPTY_PERSISTENCE_ERROR as EMPTY_APPLICATION_PERSISTENCE_ERROR,
	selectPersistenceError,
	type PersistenceErrorState
} from "./application-store.ts";

export type PersistenceErrorSnapshot = PersistenceErrorState;

export type PersistenceErrorActions = {
	retry: () => void;
	exportRecovery: () => void;
	dismiss: () => void;
};

export const EMPTY_PERSISTENCE_ERROR: PersistenceErrorSnapshot = EMPTY_APPLICATION_PERSISTENCE_ERROR;

let lastState: PersistenceErrorSnapshot | undefined;
let lastSnapshot: PersistenceErrorSnapshot | undefined;

/** Compatibility surface; persistence error state is owned by applicationStore. */
export function getPersistenceErrorSnapshot(): PersistenceErrorSnapshot {
	const state = applicationStore.select(selectPersistenceError);
	if (state !== lastState) {
		lastState = state;
		lastSnapshot = state;
	}
	return lastSnapshot || state;
}

export const subscribeToPersistenceError = applicationStore.subscribe;
export function publishPersistenceError(state: PersistenceErrorSnapshot): void {
	applicationStore.send({ type: "persistence-error/changed", state });
}
const actions: PersistenceErrorActions = {
	retry: () => applicationStore.sendCommand({ type: "persistence/retry" }),
	exportRecovery: () => applicationStore.sendCommand({ type: "persistence/export-recovery" }),
	dismiss: () => applicationStore.sendCommand({ type: "persistence/dismiss" })
};
export const getPersistenceErrorActions = (): PersistenceErrorActions => actions;

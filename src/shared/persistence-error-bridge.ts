import { createExternalStore } from "./external-store.ts";

export type PersistenceErrorSnapshot = {
	visible: boolean;
	captureId: string | null;
	message: string;
	canRetry: boolean;
	canExportRecovery: boolean;
};

export type PersistenceErrorActions = {
	retry: () => void;
	exportRecovery: () => void;
	dismiss: () => void;
};

export const EMPTY_PERSISTENCE_ERROR: PersistenceErrorSnapshot = {
	visible: false,
	captureId: null,
	message: "",
	canRetry: false,
	canExportRecovery: false
};

const store = createExternalStore<PersistenceErrorSnapshot, PersistenceErrorActions>(
	EMPTY_PERSISTENCE_ERROR,
	{ retry: () => {}, exportRecovery: () => {}, dismiss: () => {} }
);

export const getPersistenceErrorSnapshot = store.getSnapshot;
export const subscribeToPersistenceError = store.subscribe;
export const publishPersistenceError = store.publish;
export const registerPersistenceErrorActions = store.registerActions;
export const getPersistenceErrorActions = store.getActions;

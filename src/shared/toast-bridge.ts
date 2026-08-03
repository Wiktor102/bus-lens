import { createExternalStore } from "./external-store.ts";

export type ToastSnapshot = {
	message: string;
	visible: boolean;
};

export const EMPTY_TOAST_SNAPSHOT: ToastSnapshot = { message: "", visible: false };

const toastStore = createExternalStore<ToastSnapshot, Record<string, never>>(EMPTY_TOAST_SNAPSHOT, {});

export const getToastSnapshot = toastStore.getSnapshot;
export const subscribeToToast = toastStore.subscribe;
export const publishToastSnapshot = toastStore.publish;

import { createExternalStore } from "../../shared/external-store.ts";
import {
	captureStorageLabel,
	captureStorageLocked,
	type CaptureStorageUiStatus
} from "./capture-storage.ts";

export type CaptureStorageSnapshot = {
	captureId: string | null;
	status: CaptureStorageUiStatus | null;
	label: "LEGACY" | "CONVERTING" | "CANONICAL" | "CONVERSION FAILED" | null;
	locked: boolean;
	canUpgrade: boolean;
};

export type CaptureStorageActions = {
	upgrade: () => void;
};

const emptySnapshot: CaptureStorageSnapshot = {
	captureId: null,
	status: null,
	label: null,
	locked: false,
	canUpgrade: false
};

const storageStore = createExternalStore<CaptureStorageSnapshot, CaptureStorageActions>(emptySnapshot, {
	upgrade: () => {}
});

export const getCaptureStorageSnapshot = storageStore.getSnapshot;
export const subscribeToCaptureStorage = storageStore.subscribe;
export const publishCaptureStorageSnapshot = storageStore.publish;
export const registerCaptureStorageActions = storageStore.registerActions;
export const getCaptureStorageActions = storageStore.getActions;

export function captureStorageSnapshot(captureId: string | null, status: unknown): CaptureStorageSnapshot {
	if (!captureId) return emptySnapshot;
	const normalized = status === null || status === undefined ? "legacy" : (
		status === "canonical" ? "canonical" : status === "converting" ? "converting" : status === "canonicalization-failed" ? "failed" : "legacy"
	) as CaptureStorageUiStatus;
	return {
		captureId,
		status: normalized,
		label: captureStorageLabel(normalized),
		locked: captureStorageLocked(normalized),
		canUpgrade: normalized === "legacy" || normalized === "failed"
	};
}

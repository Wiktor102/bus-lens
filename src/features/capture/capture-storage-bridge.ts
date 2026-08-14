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

let actions: CaptureStorageActions = { upgrade: () => {} };

/** Compatibility action registry; storage status is derived from query data. */
export const registerCaptureStorageActions = (next: CaptureStorageActions): void => {
	actions = next;
};
export const getCaptureStorageActions = (): CaptureStorageActions => actions;

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

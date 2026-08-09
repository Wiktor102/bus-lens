export type CaptureStorageUiStatus = "legacy" | "converting" | "canonical" | "failed";

export function captureStorageUiStatus(status: unknown): CaptureStorageUiStatus {
	if (status === "canonical") return "canonical";
	if (status === "converting") return "converting";
	if (status === "canonicalization-failed" || status === "failed") return "failed";
	return "legacy";
}

export function captureStorageLabel(status: CaptureStorageUiStatus): "LEGACY" | "CONVERTING" | "CANONICAL" | "CONVERSION FAILED" {
	if (status === "canonical") return "CANONICAL";
	if (status === "converting") return "CONVERTING";
	if (status === "failed") return "CONVERSION FAILED";
	return "LEGACY";
}

export function captureStorageLocked(status: CaptureStorageUiStatus): boolean {
	return status === "converting";
}

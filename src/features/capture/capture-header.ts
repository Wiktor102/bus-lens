import {
	countDistinctMessageSignatures,
	countCapturedRawBytes,
	normalizeDescription,
	sumRecordingSessionDurations
} from "./capture-summary.ts";
import { visibleMessages, type Capture } from "./capture-framing.ts";

export type CaptureHeaderMetadata =
	| { kind: "chip"; label: string; value: string }
	| { kind: "message"; value: string };

export type CaptureHeaderSummary = {
	messages: string;
	unique: string;
	captureLength: string;
	capturedBytes: string;
};

export type CaptureHeaderSnapshot = {
	captureId: string | null;
	hasCapture: boolean;
	title: string;
	description: string;
	stateText: "EMPTY" | "SAVED" | "STARTING" | "FINALIZING" | "SAVE FAILED" | "● LIVE";
	live: boolean;
	metadata: CaptureHeaderMetadata[];
	summary: CaptureHeaderSummary;
};

export type CaptureHeaderRuntimeSnapshot = Pick<CaptureHeaderSnapshot, "captureId" | "summary">;
export type CaptureHeaderWorkflow = "starting" | "recording" | "finalizing" | "finalized" | "failed";

const EMPTY_HEADER_SUMMARY: CaptureHeaderSummary = {
	messages: "0",
	unique: "0",
	captureLength: "0 s",
	capturedBytes: "0 B"
};

export const EMPTY_CAPTURE_HEADER_SNAPSHOT: CaptureHeaderSnapshot = {
	captureId: null,
	hasCapture: false,
	title: "No captures yet",
	description: "",
	stateText: "EMPTY",
	live: false,
	metadata: [{ kind: "message", value: "Use the new-capture button to create a capture, or import an existing dump." }],
	summary: EMPTY_HEADER_SUMMARY
};

export function normalizeCaptureTitle(value: unknown) {
	return normalizeDescription(value) || "Untitled capture";
}

export function normalizeCaptureDescription(value: unknown) {
	return normalizeDescription(value);
}

export function formatCaptureDuration(milliseconds: number) {
	if (!milliseconds) return "0 s";
	if (milliseconds >= 3_600_000)
		return `${Math.floor(milliseconds / 3_600_000)} h ${Math.floor((milliseconds % 3_600_000) / 60_000)} min`;
	if (milliseconds >= 60_000) return `${Math.floor(milliseconds / 60_000)} min ${Math.floor((milliseconds % 60_000) / 1_000)} s`;
	if (milliseconds >= 1_000) return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 0 : 1)} s`;
	return `${Math.round(milliseconds)} ms`;
}

export function deriveCaptureHeaderSnapshot(
	capture: Capture | undefined,
	recording = false,
	workflow?: CaptureHeaderWorkflow
): CaptureHeaderSnapshot {
	if (!capture) return EMPTY_CAPTURE_HEADER_SNAPSHOT;

	const messages = visibleMessages(capture);
	const metadata: CaptureHeaderMetadata[] = [];
	if (capture.view) metadata.push({ kind: "chip", label: "VIEW", value: String(capture.view) });
	for (const parameter of Array.isArray(capture.params) ? capture.params : []) {
		const item = parameter as { key?: unknown; value?: unknown };
		metadata.push({
			kind: "chip",
			label: String(item.key ?? "").toUpperCase(),
			value: String(item.value ?? "")
		});
	}

	const live = workflow ? workflow === "recording" : recording;
	const stateText = workflow === "starting"
		? "STARTING"
		: workflow === "finalizing"
			? "FINALIZING"
			: workflow === "failed"
				? "SAVE FAILED"
				: live
					? "● LIVE"
					: "SAVED";
	return {
		captureId: String(capture.id),
		hasCapture: true,
		title: String(capture.name ?? ""),
		description: String(capture.description ?? ""),
		stateText,
		live,
		metadata,
		summary: {
			messages: messages.length.toLocaleString(),
			unique: countDistinctMessageSignatures(messages).toLocaleString(),
			captureLength: formatCaptureDuration(sumRecordingSessionDurations(capture.captureSessions)),
			capturedBytes: `${countCapturedRawBytes(capture.byteStream).toLocaleString()} B`
		}
	};
}

/**
 * Live bytes stay outside Query, so only the volatile summary is merged from
 * the runtime publication. Metadata and capture identity remain Query-owned.
 */
export function mergeCaptureHeaderRuntimeStats(
	snapshot: CaptureHeaderSnapshot,
	liveSnapshot: CaptureHeaderRuntimeSnapshot
): CaptureHeaderSnapshot {
	if (!snapshot.captureId || snapshot.captureId !== liveSnapshot.captureId) return snapshot;
	return { ...snapshot, summary: liveSnapshot.summary };
}

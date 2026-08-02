import { frameWidth, hexByte, markerBytes, type Capture } from "./capture-framing.ts";

export type FramingMode = "length" | "sections" | "marker" | "time";
export type MarkerPosition = "start" | "end";

export type FramingToolbarVisibility = {
	frameLength: boolean;
	sectionsButton: boolean;
	markerControls: boolean;
	timeControls: boolean;
	collapseControl: boolean;
};

export type FramingToolbarSnapshot = {
	captureId: string | null;
	disabled: boolean;
	frameSizeLabel: string;
	framingMode: FramingMode;
	frameSize: number;
	markerDraft: string;
	markerPosition: MarkerPosition;
	frameTimeGap: number;
	visibility: FramingToolbarVisibility;
};

export type FramingSettingsUpdate = {
	previewMode?: FramingMode;
	frameSize?: string | number;
	frameMarker?: string;
	markerPosition?: MarkerPosition;
	frameTimeGap?: string | number;
};

export const EMPTY_FRAMING_TOOLBAR_SNAPSHOT: FramingToolbarSnapshot = {
	captureId: null,
	disabled: true,
	frameSizeLabel: "—",
	framingMode: "length",
	frameSize: 3,
	markerDraft: "",
	markerPosition: "start",
	frameTimeGap: 5,
	visibility: {
		frameLength: true,
		sectionsButton: false,
		markerControls: false,
		timeControls: false,
		collapseControl: true
	}
};

export function selectFramingToolbarSnapshot(
	capture: Capture | null | undefined
): FramingToolbarSnapshot {
	if (!capture) return EMPTY_FRAMING_TOOLBAR_SNAPSHOT;
	const framingMode = String(capture.previewMode || "length") as FramingMode;
	return {
		captureId: capture.id || null,
		disabled: false,
		frameSizeLabel: selectFrameSizeLabel(capture),
		framingMode,
		frameSize: capture.frameSize || 3,
		markerDraft: String(capture.frameMarker || ""),
		markerPosition: String(capture.markerPosition || "start") as MarkerPosition,
		frameTimeGap: capture.frameTimeGap || 5,
		visibility: {
			frameLength: framingMode === "length",
			sectionsButton: framingMode === "sections",
			markerControls: framingMode === "marker",
			timeControls: framingMode === "time",
			collapseControl: framingMode !== "sections"
		}
	};
}

export function selectFrameSizeLabel(capture: Capture | null | undefined): string {
	if (!capture) return "—";
	const framingMode = String(capture.previewMode || "length");
	const frameSize = capture.frameSize || 3;
	const width = frameWidth(capture);
	return framingMode === "length"
		? `${frameSize} BYTE${frameSize === 1 ? "" : "S"}`
		: framingMode === "sections"
			? `${capture.frameSections?.length || 0} SECTION${capture.frameSections?.length === 1 ? "" : "S"} · UP TO ${width} BYTES`
			: framingMode === "marker" && !capture.frameMarker
				? "MARKER PENDING"
				: `VARIABLE · UP TO ${width} BYTE${width === 1 ? "" : "S"}`;
}

export function applyFramingSettings(capture: Capture, update: FramingSettingsUpdate): void {
	if (update.previewMode !== undefined) capture.previewMode = update.previewMode;
	if (update.frameSize !== undefined) {
		capture.frameSize = Math.max(1, Math.min(1024, +update.frameSize || 3));
	}
	if (update.frameMarker !== undefined) {
		const marker = markerBytes(update.frameMarker);
		capture.markerConfigured = marker.length > 0;
		capture.frameMarker = marker.map(hexByte).join(" ");
	}
	if (update.markerPosition !== undefined) capture.markerPosition = update.markerPosition;
	if (update.frameTimeGap !== undefined) {
		capture.frameTimeGap = Math.max(0.01, +update.frameTimeGap || 5);
	}
}

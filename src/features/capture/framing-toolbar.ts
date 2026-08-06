import { type Capture } from "./capture-framing.ts";

export type FramingToolbarSnapshot = {
	captureId: string | null;
	disabled: boolean;
	frameSizeLabel: string;
	sectionsButton: boolean;
};

export const EMPTY_FRAMING_TOOLBAR_SNAPSHOT: FramingToolbarSnapshot = {
	captureId: null,
	disabled: true,
	frameSizeLabel: "—",
	sectionsButton: false
};

export function selectFramingToolbarSnapshot(
	capture: Capture | null | undefined
): FramingToolbarSnapshot {
	if (!capture) return EMPTY_FRAMING_TOOLBAR_SNAPSHOT;
	return {
		captureId: capture.id || null,
		disabled: false,
		frameSizeLabel: selectFrameSizeLabel(capture),
		sectionsButton: true
	};
}

export function selectFrameSizeLabel(capture: Capture | null | undefined): string {
	if (!capture) return "—";
	const count = capture.frameSections?.length || 1;
	return `${count} SECTION${count === 1 ? "" : "S"} · INDEPENDENT LENGTHS`;
}

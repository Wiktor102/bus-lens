import assert from "node:assert/strict";
import test from "node:test";
import {
	EMPTY_FRAMING_TOOLBAR_SNAPSHOT,
	selectFrameSizeLabel,
	selectFramingToolbarSnapshot
} from "../src/features/capture/framing-toolbar.ts";
import { normalizeSections, rebuildPreview, type Capture } from "../src/features/capture/capture-framing.ts";

function capture(values: number[] = []): Capture {
	return {
		id: "capture-1",
		previewMode: "length",
		frameSize: 3,
		markerConfigured: false,
		frameMarker: "",
		markerPosition: "start",
		frameTimeGap: 5,
		byteStream: values.map((value, timestamp) => ({ value, timestamp })),
		messages: [],
		notes: []
	} as Capture;
}

test("selects section framing summary without global framing settings", () => {
	assert.deepEqual(selectFramingToolbarSnapshot(undefined), EMPTY_FRAMING_TOOLBAR_SNAPSHOT);

	const current = capture();
	current.frameSections = [
		{ id: "header", start: 0, frameSize: 2 },
		{ id: "payload", start: 2, frameSize: 8 }
	];

	assert.deepEqual(selectFramingToolbarSnapshot(current), {
		captureId: "capture-1",
		disabled: false,
		frameSizeLabel: "2 SECTIONS · INDEPENDENT LENGTHS"
	});
});

test("selects a section label instead of a global frame-size label", () => {
	const current = capture([1, 2, 3]);
	rebuildPreview(current);
	assert.equal(selectFrameSizeLabel(current), "1 SECTION · INDEPENDENT LENGTHS");

	current.frameSections = [
		{ id: "header", start: 0, frameSize: 1 },
		{ id: "payload", start: 1, frameSize: 2 }
	];
	normalizeSections(current);
	assert.equal(selectFrameSizeLabel(current), "2 SECTIONS · INDEPENDENT LENGTHS");
});

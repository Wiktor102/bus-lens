import assert from "node:assert/strict";
import test from "node:test";
import {
	applyFramingSettings,
	EMPTY_FRAMING_TOOLBAR_SNAPSHOT,
	selectFrameSizeLabel,
	selectFramingToolbarSnapshot
} from "../src/framing-toolbar.ts";
import { normalizeSections, rebuildPreview, type Capture } from "../src/capture-framing.ts";

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

test("selects framing controls and visibility from the active capture", () => {
	assert.deepEqual(selectFramingToolbarSnapshot(undefined), EMPTY_FRAMING_TOOLBAR_SNAPSHOT);

	const current = capture();
	current.previewMode = "sections";
	current.frameSize = 8;
	current.frameSections = [
		{ id: "header", start: 0, frameSize: 2 },
		{ id: "payload", start: 2, frameSize: 8 }
	];

	assert.deepEqual(selectFramingToolbarSnapshot(current), {
		captureId: "capture-1",
		disabled: false,
		frameSizeLabel: "2 SECTIONS · UP TO 0 BYTES",
		framingMode: "sections",
		frameSize: 8,
		markerDraft: "",
		markerPosition: "start",
		frameTimeGap: 5,
		visibility: {
			frameLength: false,
			sectionsButton: true,
			markerControls: false,
			timeControls: false,
			collapseControl: false
		}
	});
});

test("selects the existing frame-size label for each framing mode", () => {
	const current = capture([1, 2, 3]);
	current.frameSize = 1;
	rebuildPreview(current);
	assert.equal(selectFrameSizeLabel(current), "1 BYTE");

	current.previewMode = "marker";
	assert.equal(selectFrameSizeLabel(current), "MARKER PENDING");

	current.previewMode = "time";
	assert.equal(selectFrameSizeLabel(current), "VARIABLE · UP TO 1 BYTE");

	current.previewMode = "sections";
	current.frameSections = [
		{ id: "header", start: 0, frameSize: 1 },
		{ id: "payload", start: 1, frameSize: 2 }
	];
	normalizeSections(current);
	assert.equal(selectFrameSizeLabel(current), "2 SECTIONS · UP TO 1 BYTES");
});

test("applies structured framing settings with the existing normalization rules", () => {
	const current = capture([0xaa, 0x55, 0x01]);

	applyFramingSettings(current, {
		previewMode: "marker",
		frameSize: "2048",
		frameMarker: "aa 55",
		markerPosition: "end",
		frameTimeGap: "0.001"
	});

	assert.equal(current.previewMode, "marker");
	assert.equal(current.frameSize, 1024);
	assert.equal(current.markerConfigured, true);
	assert.equal(current.frameMarker, "AA 55");
	assert.equal(current.markerPosition, "end");
	assert.equal(current.frameTimeGap, 0.01);

	applyFramingSettings(current, { frameSize: "", frameMarker: "", frameTimeGap: "" });
	assert.equal(current.frameSize, 3);
	assert.equal(current.markerConfigured, false);
	assert.equal(current.frameMarker, "");
	assert.equal(current.frameTimeGap, 5);
});

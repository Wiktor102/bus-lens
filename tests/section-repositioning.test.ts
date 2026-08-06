import assert from "node:assert/strict";
import test from "node:test";
import { rebuildPreview, type Capture } from "../src/features/capture/capture-framing.ts";
import { createCaptureController } from "../src/features/capture/capture-controller.ts";
import type { AppState } from "../src/shared/app-state.ts";
import {
	getSectionMoveAvailability,
	getSectionMoveTarget,
	moveSection
} from "../src/features/capture/section-repositioning.ts";

function capture(): Capture {
	const current = {
		id: "capture-1",
		frameSize: 3,
		byteStream: Array.from({ length: 20 }, (_, value) => ({ value, timestamp: value })),
		messages: [],
		notes: [],
		frameSections: [
			{ id: "header", start: 0, frameSize: 3, collapseRuns: true },
			{ id: "payload", start: 8, frameSize: 2, collapseRuns: false },
			{ id: "tail", start: 16, frameSize: 4, collapseRuns: true }
		]
	} as Capture;
	rebuildPreview(current);
	return current;
}

test("moves a section one raw byte before its current start", () => {
	const current = capture();

	assert.equal(getSectionMoveTarget(current, "payload", "byte-before"), 7);
	assert.equal(moveSection(current, "payload", "byte-before"), true);
	assert.equal(current.frameSections?.find(section => section.id === "payload")?.start, 7);
});

test("moves a section one raw byte after its current start", () => {
	const current = capture();

	assert.equal(getSectionMoveTarget(current, "payload", "byte-after"), 9);
	assert.equal(moveSection(current, "payload", "byte-after"), true);
	assert.equal(current.frameSections?.find(section => section.id === "payload")?.start, 9);
});

test("moves before to the previous section's last framed message boundary", () => {
	const current = capture();

	assert.equal(getSectionMoveTarget(current, "payload", "message-before"), 6);
	assert.equal(moveSection(current, "payload", "message-before"), true);
	assert.equal(current.frameSections?.find(section => section.id === "payload")?.start, 6);
});

test("moves after to the selected section's next framed message boundary", () => {
	const current = capture();

	assert.equal(getSectionMoveTarget(current, "payload", "message-after"), 10);
	assert.equal(moveSection(current, "payload", "message-after"), true);
	assert.deepEqual(
		current.frameSections?.map(section => ({
			id: section.id,
			start: section.start,
			framingMode: section.framingMode,
			frameSize: section.frameSize,
			frameMarker: section.frameMarker,
			markerPosition: section.markerPosition,
			frameTimeGap: section.frameTimeGap,
			collapseRuns: section.collapseRuns,
			collapsed: section.collapsed
		})),
		[
			{
				id: "header",
				start: 0,
				framingMode: "length",
				frameSize: 3,
				frameMarker: "",
				markerPosition: "start",
				frameTimeGap: 5,
				collapseRuns: true,
				collapsed: false
			},
			{
				id: "payload",
				start: 10,
				framingMode: "length",
				frameSize: 2,
				frameMarker: "",
				markerPosition: "start",
				frameTimeGap: 5,
				collapseRuns: false,
				collapsed: false
			},
			{
				id: "tail",
				start: 16,
				framingMode: "length",
				frameSize: 4,
				frameMarker: "",
				markerPosition: "start",
				frameTimeGap: 5,
				collapseRuns: true,
				collapsed: false
			}
		]
	);
});

test("disables movement at capture and neighboring section boundaries", () => {
	const current = capture();

	assert.deepEqual(getSectionMoveAvailability(current, "header"), {
		"byte-before": false,
		"byte-after": true,
		"message-before": false,
		"message-after": true
	});
	assert.deepEqual(getSectionMoveAvailability(current, "tail"), {
		"byte-before": true,
		"byte-after": true,
		"message-before": true,
		"message-after": false
	});
});

test("new sections inherit the preceding section's framing settings", () => {
	const current = {
		id: "capture-inherit",
		frameSize: 3,
		byteStream: [0xaa, 1, 2, 3].map((value, timestamp) => ({ value, timestamp })),
		messages: [],
		notes: [],
		frameSections: [
			{
				id: "first",
				start: 0,
				framingMode: "marker",
				frameSize: 7,
				frameMarker: "AA",
				markerPosition: "end",
				frameTimeGap: 17,
				collapseRuns: true
			}
		]
	} as Capture;
	rebuildPreview(current);
	const sourceMessage = current.messages[1];
	assert.ok(sourceMessage?.id);

	const controller = createCaptureController({
		state: { captures: [current], folders: [] } as AppState,
		capture: () => current,
		getActiveId: () => current.id,
		setActiveId: () => {},
		saveState: () => {},
		render: () => {},
		renderMessages: () => {},
		showToast: () => {},
		confirm: () => true,
		transport: { isRecording: () => false, stopRecording: () => {} },
		publishArchiveState: () => {},
		publishCaptureHeaderState: () => {},
		publishNotesState: () => {},
		publishDialogCommand: () => {}
	});
	controller.startSectionAtByte(sourceMessage.id!, 0);

	assert.deepEqual(current.frameSections?.map(section => ({
		id: section.id,
		framingMode: section.framingMode,
		frameSize: section.frameSize,
		frameMarker: section.frameMarker,
		markerPosition: section.markerPosition,
		frameTimeGap: section.frameTimeGap,
		collapseRuns: section.collapseRuns
	})), [
		{
			id: "first",
			framingMode: "marker",
			frameSize: 7,
			frameMarker: "AA",
			markerPosition: "end",
			frameTimeGap: 17,
			collapseRuns: true
		},
		{
			id: current.frameSections?.[1]?.id,
			framingMode: "marker",
			frameSize: 7,
			frameMarker: "AA",
			markerPosition: "end",
			frameTimeGap: 17,
			collapseRuns: true
		}
	]);
});

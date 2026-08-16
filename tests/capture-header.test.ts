import assert from "node:assert/strict";
import test from "node:test";
import {
	EMPTY_CAPTURE_HEADER_SNAPSHOT,
	deriveCaptureHeaderSnapshot,
	mergeCaptureHeaderRuntimeStats,
	normalizeCaptureDescription,
	normalizeCaptureTitle
} from "../src/features/capture/capture-header.ts";
import type { Capture } from "../src/features/capture/capture-framing.ts";

test("derives a compact header snapshot without publishing capture bytes", () => {
	const snapshot = deriveCaptureHeaderSnapshot(
		{
			id: "capture-1",
			name: "  Speed   capture ",
			description: "A useful description",
			view: "Overview",
			params: [
				{ key: "Speed", value: "1" },
				{ key: "Mode", value: "auto" }
			],
			messages: [
				{ id: "visible", bytes: [0xc2, 0x08], timestamp: 1 },
				{ id: "hidden", bytes: [0xc2, 0x08], timestamp: 2, hidden: true },
				{ id: "other", bytes: [0xc2, 0x00], timestamp: 3 }
			],
			byteStream: [
				{ value: 0xc2, timestamp: 1, direction: "rx" },
				{ value: 0x08, timestamp: 1, direction: "rx" },
				{ value: 0xff, timestamp: 2, direction: "tx" }
			],
			captureSessions: [{ id: "session", firstReceivedAt: 100, lastReceivedAt: 1_100 }]
		} as Capture,
		true
	);

	assert.deepEqual(snapshot, {
		captureId: "capture-1",
		hasCapture: true,
		title: "  Speed   capture ",
		description: "A useful description",
		stateText: "● LIVE",
		live: true,
		metadata: [
			{ kind: "chip", label: "VIEW", value: "Overview" },
			{ kind: "chip", label: "SPEED", value: "1" },
			{ kind: "chip", label: "MODE", value: "auto" }
		],
		summary: {
			messages: "2",
			unique: "2",
			captureLength: "1.0 s",
			capturedBytes: "2 B"
		}
	});
	assert.equal("byteStream" in snapshot, false);
});

test("uses the empty header snapshot when no capture is selected", () => {
	assert.deepEqual(deriveCaptureHeaderSnapshot(undefined), EMPTY_CAPTURE_HEADER_SNAPSHOT);
});

test("merges live stats only when the runtime publication targets the selected capture", () => {
	const selected = deriveCaptureHeaderSnapshot({ id: "selected", byteStream: [], messages: [] } as Capture);
	const live = deriveCaptureHeaderSnapshot({
		id: "selected",
		byteStream: [{ value: 0xaa, timestamp: 1, direction: "rx" }],
		messages: [{ id: "message", bytes: [0xaa], timestamp: 1 }]
	} as Capture, true);
	const other = deriveCaptureHeaderSnapshot({ id: "other", byteStream: [], messages: [] } as Capture, true);

	assert.equal(mergeCaptureHeaderRuntimeStats(selected, live).summary.capturedBytes, "1 B");
	assert.equal(mergeCaptureHeaderRuntimeStats(selected, other), selected);
});

test("normalizes title and description drafts at blur time", () => {
	assert.equal(normalizeCaptureTitle("  New\n capture  "), "New capture");
	assert.equal(normalizeCaptureTitle("\n\t"), "Untitled capture");
	assert.equal(normalizeCaptureDescription("  Keep\n this  "), "Keep this");
});

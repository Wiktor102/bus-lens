import assert from "node:assert/strict";
import test from "node:test";
import { materializeFramesFromStream } from "../server/canonical.ts";

test("materializes large one-byte frames without rescanning the source stream", () => {
	const stream = Array.from({ length: 50_000 }, (_, rawOffset) => ({
		rawOffset,
		value: rawOffset & 0xff,
		timestamp: rawOffset,
		direction: rawOffset % 2 === 0 ? "rx" : "tx"
	}));
	// The old implementation called stream.find once per output field. Make
	// that accidental O(n²) path fail immediately instead of relying on timing.
	stream.find = (() => {
		throw new Error("materialization must not rescan the source stream");
	}) as typeof stream.find;

	let nextId = 0;
	const frames = materializeFramesFromStream(
		stream,
		[
			{
				id: "section",
				start: 0,
				framingMode: "length",
				frameSize: 1,
				frameMarker: "",
				markerPosition: "start",
				frameTimeGap: 5,
				collapseRuns: false,
				collapsed: false
			}
		],
		() => `frame-${nextId++}`
	);

	assert.equal(frames.length, 50_000);
	assert.deepEqual(frames[0], {
		id: "frame-0",
		ordinal: 0,
		sectionId: "section",
		rawOffsets: [0],
		bytes: [0],
		timestamps: [0],
		directions: ["rx"],
		hidden: false,
		signature: "00"
	});
	assert.deepEqual(frames.at(-1), {
		id: "frame-49999",
		ordinal: 49_999,
		sectionId: "section",
		rawOffsets: [49_999],
		bytes: [49_999 & 0xff],
		timestamps: [49_999],
		directions: ["tx"],
		hidden: false,
		signature: "4F"
	});
});

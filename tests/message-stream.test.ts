import assert from "node:assert/strict";
import test from "node:test";
import { deriveMessageStreamSnapshot } from "../src/features/message-stream/message-stream.ts";
import { EMPTY_VIEW_STATE_SNAPSHOT } from "../src/shared/view-state.ts";
import { appendLivePreview, normalizeCapture, rebuildPreview, type Capture } from "../src/features/capture/capture-framing.ts";

function idFactory(prefix = "generated") {
	let count = 0;
	return () => `${prefix}-${++count}`;
}

function sectionedCapture(): Capture {
	const current = {
		id: "capture-1",
		frameSize: 2,
		byteStream: [0xaa, 1, 0xaa, 2, 0xaa, 3, 0xaa, 4].map((value, timestamp) => ({ value, timestamp })),
		messages: [],
		notes: [],
		annotations: {},
		frameSections: [
			{ id: "header", start: 0, frameSize: 2, collapseRuns: false, collapsed: true },
			{ id: "payload", start: 4, frameSize: 2, collapseRuns: true }
		]
	} as Capture;
	rebuildPreview(current, idFactory("message"));
	return current;
}

function entrySummary(snapshot: ReturnType<typeof deriveMessageStreamSnapshot>): string[] {
	return snapshot.entries.map(entry =>
		entry.type === "section" ? `section:${entry.section.id}` : `message:${entry.row._originalStart}`
	);
}

test("normalizes section collapse state with a safe legacy default", () => {
	const current = sectionedCapture();
	current.frameSections![0].collapsed = true;
	delete current.frameSections![1].collapsed;

	normalizeCapture(current, idFactory("normalized"));

	assert.deepEqual(
		current.frameSections?.map(section => ({ id: section.id, collapseRuns: section.collapseRuns, collapsed: section.collapsed })),
		[
			{ id: "header", collapseRuns: false, collapsed: true },
			{ id: "payload", collapseRuns: true, collapsed: false }
		]
	);
});

test("derives section headers and message visibility without changing stream calculations", () => {
	const current = sectionedCapture();
	const snapshot = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);

	assert.deepEqual(snapshot.matchingRows.map(row => row._originalStart), [0, 1, 2, 3]);
	assert.deepEqual(entrySummary(snapshot), ["section:header", "section:payload", "message:2", "message:3"]);
	assert.equal(snapshot.frames.length, snapshot.matchingRows.length);
	assert.equal(snapshot.countsByPosition[0].get(0xaa), 4);
	assert.equal(snapshot.visibleCount, "4 rows");
	assert.equal(snapshot.entries.find(entry => entry.type === "section" && entry.section.id === "header")?.section.frameSize, 2);
	assert.equal(current.messages.length, 4);
	assert.equal(current.frameSections?.[1].collapseRuns, true);
	assert.notStrictEqual(snapshot.matchingRows[0].bytes, current.messages[0].bytes);
	assert.notStrictEqual(snapshot.matchingRows[0].rawOffsets, current.messages[0].rawOffsets);
	assert.strictEqual(snapshot.matchingRows[0]._runMessages[0].bytes, snapshot.matchingRows[0].bytes);

	current.frameSections![0].collapsed = false;
	const expanded = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	assert.deepEqual(entrySummary(expanded), [
		"section:header",
		"message:0",
		"message:1",
		"section:payload",
		"message:2",
		"message:3"
	]);
});

test("keeps a collapsed section header visible when filtering matches its messages", () => {
	const current = sectionedCapture();
	const snapshot = deriveMessageStreamSnapshot(current, {
		...EMPTY_VIEW_STATE_SNAPSHOT,
		filterQuery: "AA 01"
	});

	assert.equal(snapshot.matchingRows.length, 1);
	assert.deepEqual(entrySummary(snapshot), ["section:header"]);
	assert.equal(snapshot.hasMatchingRows, true);
});

test("copies per-section framing settings into the section snapshot", () => {
	const current = sectionedCapture();
	current.frameSections![0] = {
		...current.frameSections![0],
		framingMode: "marker",
		frameMarker: "AA 55",
		markerPosition: "end",
		frameTimeGap: 12
	};
	normalizeCapture(current, idFactory("snapshot"));

	const snapshot = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	const section = snapshot.entries.find(entry => entry.type === "section" && entry.section.id === "header");
	assert.equal(section?.type, "section");
	if (section?.type !== "section") return;
	assert.deepEqual(
		{
			framingMode: section.section.framingMode,
			frameMarker: section.section.frameMarker,
			markerPosition: section.section.markerPosition,
			frameTimeGap: section.section.frameTimeGap
		},
		{ framingMode: "marker", frameMarker: "AA 55", markerPosition: "end", frameTimeGap: 12 }
	);
});

test("keeps a pending marker section header and marker prompt visible while it has no messages", () => {
	const current = sectionedCapture();
	current.frameSections = [{
		id: "pending",
		start: 0,
		framingMode: "marker",
		frameMarker: "",
		markerPosition: "start"
	}];
	rebuildPreview(current, idFactory("pending"));

	const snapshot = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	assert.equal(snapshot.matchingRows.length, 0);
	assert.deepEqual(
		snapshot.entries.map(entry => entry.type === "section" ? entry.section.id : entry.type),
		["pending", "marker-prompt"]
	);
});

test("marks retained projections as a durable tail instead of a complete capture", () => {
	const current = sectionedCapture();
	current.retainedStartOffset = 25;
	current.isRetainedTail = true;
	current.byteCount = 50_025;

	const snapshot = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);

	assert.equal(snapshot.retainedTail, true);
	assert.equal(snapshot.durableByteCount, 50_025);
});

test("live snapshots reuse stable rows and defer repeated pattern recognition", () => {
	const current = {
		id: "live-snapshot",
		byteStream: [0xaa, 1, 0xaa, 2].map((value, rawOffset) => ({ value, timestamp: rawOffset, rawOffset })),
		messages: [],
		notes: [],
		annotations: {},
		frameSections: [{ id: "section", start: 0, framingMode: "length", frameSize: 1 }]
	} as Capture;
	rebuildPreview(current, idFactory("live-message"));
	const initial = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	const previousRow = initial.matchingRows[0];
	const previousPatterns = initial.patterns;
	const previousLength = current.byteStream!.length;
	current.byteStream!.push({ value: 0xaa, timestamp: 4, rawOffset: 4 }, { value: 3, timestamp: 5, rawOffset: 5 });
	assert.equal(appendLivePreview(current, previousLength, idFactory("live-message")), true);

	const live = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT, { live: true });
	assert.strictEqual(live.patterns, previousPatterns);
	assert.strictEqual(live.matchingRows[0], previousRow);
	assert.deepEqual(live.matchingRows.map(row => row.bytes), [[0xaa], [1], [0xaa], [2], [0xaa], [3]]);
	assert.equal(live.signatureCounts.get("AA"), 3);

	const final = { ...current, messages: [] } as Capture;
	rebuildPreview(final, idFactory("final-message"));
	const expected = deriveMessageStreamSnapshot(final, EMPTY_VIEW_STATE_SNAPSHOT);
	assert.deepEqual(live.matchingRows.map(row => row.bytes), expected.matchingRows.map(row => row.bytes));
	assert.deepEqual([...live.signatureCounts], [...expected.signatureCounts]);
});

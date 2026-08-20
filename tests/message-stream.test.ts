import assert from "node:assert/strict";
import test from "node:test";
import { deriveMessageStreamSnapshot } from "../src/features/message-stream/message-stream.ts";
import { EMPTY_VIEW_STATE_SNAPSHOT } from "../src/shared/view-state.ts";
import {
	appendLivePreview,
	bumpCaptureProjectionGeneration,
	captureProjectionGeneration,
	normalizeCapture,
	rebuildPreview,
	type Capture
} from "../src/features/capture/capture-framing.ts";

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

test("reuses the analysis projection when only a section is collapsed", () => {
	const current = sectionedCapture();
	const initial = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	const expanded = deriveMessageStreamSnapshot(current, {
		...EMPTY_VIEW_STATE_SNAPSHOT,
		sectionPreferences: {
			"capture-1": {
				"0": { collapseRuns: false, collapsed: false }
			}
		}
	});

	assert.deepEqual(entrySummary(expanded), [
		"section:header",
		"message:0",
		"message:1",
		"section:payload",
		"message:2",
		"message:3"
	]);
	assert.notStrictEqual(expanded.entries, initial.entries);
	assert.strictEqual(expanded.matchingRows, initial.matchingRows);
	assert.strictEqual(expanded.frames, initial.frames);
	assert.strictEqual(expanded.signatureCounts, initial.signatureCounts);
	assert.strictEqual(expanded.countsByPosition, initial.countsByPosition);
	assert.strictEqual(expanded.patterns, initial.patterns);
	assert.strictEqual(expanded.patternNumbers, initial.patternNumbers);
	assert.strictEqual(expanded.visiblePatternRowCounts, initial.visiblePatternRowCounts);
});

test("invalidates the analysis projection when an earlier frame is hidden in place", () => {
	const current = sectionedCapture();
	const initial = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	const hiddenMessage = current.messages![0];
	hiddenMessage.hidden = true;
	bumpCaptureProjectionGeneration(current);

	const hidden = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	assert.notStrictEqual(hidden.matchingRows, initial.matchingRows);
	assert.deepEqual(hidden.matchingRows.map(row => row._originalStart), [1, 2, 3]);
	assert.equal(hidden.visibleCount, "3 rows");
	hiddenMessage.hidden = false;
	bumpCaptureProjectionGeneration(current);
	const rolledBack = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	assert.deepEqual(rolledBack.matchingRows.map(row => row._originalStart), [0, 1, 2, 3]);
});

test("invalidates the analysis projection when a byte is hidden and then rolled back", () => {
	const current = sectionedCapture();
	const initial = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	const message = current.messages![0];
	const rawOffset = message.rawOffsets![0];
	message.hiddenBytes![0] = true;
	current.byteStream!.find(record => record.rawOffset === rawOffset)!.hidden = true;
	rebuildPreview(current, idFactory("hidden-byte"));

	const hidden = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	assert.notStrictEqual(hidden.matchingRows, initial.matchingRows);
	assert.notDeepEqual(hidden.matchingRows[0].bytes, initial.matchingRows[0].bytes);
	assert.equal(hidden.matchingRows[0].bytes.includes(0xaa), true);

	current.byteStream!.find(record => record.rawOffset === rawOffset)!.hidden = false;
	rebuildPreview(current, idFactory("rollback-byte"));
	const rolledBack = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	assert.deepEqual(rolledBack.matchingRows[0].bytes, [0xaa, 1]);
});

test("invalidates sequence-note rails when notes change in place", () => {
	const current = sectionedCapture();
	const initial = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	assert.equal(initial.matchingRows[1]._hasSequenceNote, false);
	current.notes!.push({ type: "sequence", text: "watch", start: 2, end: 2 });

	const noted = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	assert.notStrictEqual(noted.matchingRows, initial.matchingRows);
	assert.equal(noted.matchingRows[1]._hasSequenceNote, true);
	assert.equal(noted.matchingRows[1]._sequenceNote?.text, "watch");
});

test("reuses structural analysis when a note cannot change collapsed runs", () => {
	const current = sectionedCapture();
	current.frameSections!.forEach(section => (section.collapseRuns = false));
	const initial = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);
	current.notes!.push({ type: "sequence", text: "watch", start: 2, end: 2 });

	const noted = deriveMessageStreamSnapshot(current, EMPTY_VIEW_STATE_SNAPSHOT);

	assert.equal(noted.matchingRows[1]._sequenceNote?.text, "watch");
	assert.strictEqual(noted.matchingRows[0], initial.matchingRows[0]);
	assert.strictEqual(noted.patterns, initial.patterns);
	assert.strictEqual(noted.frames, initial.frames);
});

test("uses application section view preferences without changing legacy capture data", () => {
	const current = sectionedCapture();
	const viewState = {
		...EMPTY_VIEW_STATE_SNAPSHOT,
		sectionPreferences: {
			"capture-1": {
				"0": { collapseRuns: false, collapsed: false },
				"4": { collapseRuns: false, collapsed: true }
			}
		}
	};
	const snapshot = deriveMessageStreamSnapshot(current, viewState);

	assert.deepEqual(entrySummary(snapshot), ["section:header", "message:0", "message:1", "section:payload"]);
	assert.equal(snapshot.entries.find(entry => entry.type === "section" && entry.section.id === "payload")?.section.collapseRuns, false);
	assert.equal(current.frameSections?.[0]?.collapsed, true);
	assert.equal(current.frameSections?.[1]?.collapseRuns, true);
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
	const previousGeneration = captureProjectionGeneration(current);
	current.byteStream!.push({ value: 0xaa, timestamp: 4, rawOffset: 4 }, { value: 3, timestamp: 5, rawOffset: 5 });
	assert.equal(appendLivePreview(current, previousLength, idFactory("live-message")), true);
	assert.equal(captureProjectionGeneration(current), previousGeneration + 1);

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

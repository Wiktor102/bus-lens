import assert from "node:assert/strict";
import test from "node:test";
import {
	deriveAnalysisSnapshot,
	getCounts,
	recognizeMessagePatterns,
	rowsWithDelta,
	summarizeRunCadence,
	transitionFrames
} from "../src/features/analysis/analysis.ts";
import { makeMessage, type Capture } from "../src/features/capture/capture-framing.ts";

function capture(messages: ReturnType<typeof makeMessage>[]): Capture {
	return {
		id: "capture-1",
		messages,
		byteStream: messages.flatMap(message =>
			message.bytes.map((value, index) => ({
				value,
				timestamp: message.byteTimestamps?.[index] ?? message.timestamp
			}))
		),
		notes: [],
		annotations: {}
	} as Capture;
}

test("counts signatures and derives sorted analysis card values", () => {
	const messages = [
		makeMessage([0xaa, 0x01], 0),
		makeMessage([0xaa, 0x03], 10),
		makeMessage([0xaa, 0x01], 20)
	];
	const counts = getCounts(messages);
	assert.deepEqual([...counts.entries()], [
		["AA 01", 2],
		["AA 03", 1]
	]);

	const snapshot = deriveAnalysisSnapshot(capture(messages));
	assert.deepEqual(snapshot.signatures, [
		{ signature: "AA 01", count: 2, width: 100, percentage: 67 },
		{ signature: "AA 03", count: 1, width: 50, percentage: 33 }
	]);
	assert.deepEqual(snapshot.vocabulary[1].values, [
		{ value: 1, hex: "01", count: 2 },
		{ value: 3, hex: "03", count: 1 }
	]);
	assert.equal(snapshot.bitVariance[0].cells[0].percentage, 100);
	assert.deepEqual(snapshot.transitions, [
		{ from: "AA 01", to: "AA 03", count: 1, diffs: 1 },
		{ from: "AA 03", to: "AA 01", count: 1, diffs: 1 }
	]);
});

test("adds deltas and summarizes stable repeat cadence", () => {
	const rows = [
		{ _originalStart: 0, _originalEnd: 0, _runStart: 100, _runEnd: 100 },
		{ _originalStart: 1, _originalEnd: 2, _runStart: 120, _runEnd: 130 },
		{ _originalStart: 4, _originalEnd: 4, _runStart: 180, _runEnd: 180 }
	];
	assert.deepEqual(rowsWithDelta(rows).map(row => row._delta), [null, 20, null]);

	const cadence = summarizeRunCadence({
		_runMessages: [{ timestamp: 0 }, { timestamp: 10 }, { timestamp: 20 }]
	});
	assert.deepEqual(cadence._intervals, [10, 10]);
	assert.equal(cadence._cadence, 10);
	assert.equal(cadence._cadenceStable, true);
});

test("recognizes and caches repeated message patterns", () => {
	const current = capture([
		makeMessage([0xaa], 0),
		makeMessage([0x01], 10),
		makeMessage([0xaa], 20),
		makeMessage([0x01], 30)
	]);
	const first = recognizeMessagePatterns(current);
	const second = recognizeMessagePatterns(current);

	assert.strictEqual(first, second);
	assert.equal(first.groups.length, 1);
	assert.deepEqual(first.groups[0].starts, [0, 2]);
	assert.equal(first.membership.get(1)?.occurrenceIndex, 0);
});

test("creates colored transition frames only for mixed changes in adjacent rows", () => {
	const rows = [
		{ ...makeMessage([0xaa, 0x01], 0), _originalStart: 0, _originalEnd: 0 },
		{ ...makeMessage([0xaa, 0x02], 10), _originalStart: 1, _originalEnd: 1 }
	];
	const frames = transitionFrames(rows);

	assert.equal(frames[0][1].outgoing?.label, "01 → 02");
	assert.equal(frames[1][1].incoming?.label, "01 → 02");
	assert.equal(frames[0][1].outgoing?.start, true);
	assert.equal(frames[0][1].outgoing?.end, true);
	assert.equal(frames[0][0].outgoing, null);
});

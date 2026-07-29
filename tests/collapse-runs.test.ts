import assert from "node:assert/strict";
import test from "node:test";
import {
	collapseAdjacentRuns,
	countVisibleRowsByPatternOccurrence
} from "../src/collapse-runs.ts";

function row(index: number, value: string, patternOccurrence: string | null) {
	return {
		value,
		timestamp: index * 70,
		_originalStart: index,
		_originalEnd: index,
		_hasSequenceNote: false,
		_patternOccurrence: patternOccurrence,
		_runEnd: index * 70,
		_runMessages: [],
		_repeats: 1
	};
}

test("does not hide unsequenced frames in a matching sequence run", () => {
	const rows = [
		...Array.from({ length: 3 }, (_, offset) => row(offset + 6, "E2", "sequence-1:1")),
		...Array.from({ length: 3 }, (_, offset) => row(offset + 9, "C2", "sequence-1:1")),
		...Array.from({ length: 3 }, (_, offset) => row(offset + 12, "C2", null))
	];

	const collapsed = collapseAdjacentRuns(rows, () => true, item => item.value);

	assert.deepEqual(
		collapsed.map(item => [item._originalStart + 1, item._originalEnd + 1]),
		[
			[7, 9],
			[10, 12],
			[13, 15]
		]
	);
});

test("does not merge identical frames across recognized occurrences", () => {
	const rows = [
		row(0, "E2", "sequence-1:0"),
		row(1, "C2", "sequence-1:0"),
		row(2, "C2", "sequence-1:1"),
		row(3, "E2", "sequence-1:1")
	];

	const collapsed = collapseAdjacentRuns(rows, () => true, item => item.value);

	assert.deepEqual(
		collapsed.map(item => [item._originalStart + 1, item._originalEnd + 1]),
		[
			[1, 1],
			[2, 2],
			[3, 3],
			[4, 4]
		]
	);
});

test("sequence rails span visible collapsed rows, not raw frames", () => {
	const rows = [
		row(6, "E2", "sequence-1:1"),
		row(9, "C2", "sequence-1:1"),
		row(12, "C2", null),
		row(15, "E2", "sequence-1:2"),
		row(18, "C2", "sequence-1:2")
	];

	const counts = countVisibleRowsByPatternOccurrence(rows);

	assert.equal(counts.get("sequence-1:1"), 2);
	assert.equal(counts.get("sequence-1:2"), 2);
	assert.equal(counts.has("null"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { deriveAnalysisSnapshot, recognizeMessagePatterns, rowsWithDelta, summarizeRunCadence } from "../src/features/analysis/analysis.ts";
import { rebuildPreview, type Capture } from "../src/features/capture/capture-framing.ts";
import { analysisFixture, framingFixtures, type FramingFixture } from "./fixtures/domain-interpretation-fixtures.ts";

function fixtureCapture(fixture: Pick<FramingFixture, "bytes" | "sections">, id = "fixture-capture"): Capture {
	return {
		id,
		byteStream: fixture.bytes.map(byte => ({ ...byte })),
		frameSections: fixture.sections.map(section => ({ ...section })),
		messages: [],
		notes: [],
		annotations: {},
		patternRemarks: {}
	};
}

function fixtureIdFactory(): () => string {
	let next = 0;
	return () => `fixture-id-${next++}`;
}

function frameProjection(capture: Capture) {
	return capture.messages!.map(message => ({
		bytes: message.bytes,
		rawOffsets: message.rawOffsets,
		sectionId: message.sectionId,
		directions: message.directions,
		timestamps: message.byteTimestamps
	}));
}

for (const fixture of framingFixtures) {
	test(`characterizes ${fixture.name}`, () => {
		const current = fixtureCapture(fixture);
		rebuildPreview(current, fixtureIdFactory());
		assert.deepEqual(frameProjection(current), fixture.expectedFrames);
	});
}

test(`characterizes ${analysisFixture.name}`, () => {
	const current = fixtureCapture(analysisFixture);
	rebuildPreview(current, fixtureIdFactory());
	assert.deepEqual(deriveAnalysisSnapshot(current), {
		captureId: "fixture-capture",
		...analysisFixture.expected
	});
});

test("characterizes run cadence, deltas, and repeated sequence groups", () => {
	const current = fixtureCapture(analysisFixture);
	rebuildPreview(current, fixtureIdFactory());
	current.messages!.push(...current.messages!.map(message => ({ ...message, id: `copy-${message.id}` })));

	const patterns = recognizeMessagePatterns(current);
	assert.deepEqual(patterns.groups.map(group => ({
		key: group.key,
		length: group.length,
		starts: group.starts,
		signatures: group.signatures,
		score: group.score,
		id: group.id,
		remark: group.remark
	})), [
		{
			key: "AA 01 → AA 03 → AA 01",
			length: 3,
			starts: [0, 3],
			signatures: ["AA 01", "AA 03", "AA 01"],
			score: 6,
			id: "pattern-12bdy84",
			remark: ""
		}
	]);
	assert.deepEqual([...patterns.membership.entries()].map(([index, membership]) => [index, membership.occurrenceIndex, membership.offset]), [
		[0, 0, 0],
		[1, 0, 1],
		[2, 0, 2],
		[3, 1, 0],
		[4, 1, 1],
		[5, 1, 2]
	]);

	assert.deepEqual(
		rowsWithDelta([
			{ _originalStart: 0, _originalEnd: 0, _runStart: 0, _runEnd: 0 },
			{ _originalStart: 1, _originalEnd: 2, _runStart: 4, _runEnd: 8 },
			{ _originalStart: 4, _originalEnd: 4, _runStart: 10, _runEnd: 10 }
		]).map(row => row._delta),
		[null, 4, null]
	);
	assert.deepEqual(summarizeRunCadence({ _runMessages: [{ timestamp: 0 }, { timestamp: 10 }, { timestamp: 21 }] }), {
		_runMessages: [{ timestamp: 0 }, { timestamp: 10 }, { timestamp: 21 }],
		_cadence: 10.5,
		_cadenceStable: true,
		_intervals: [10, 11]
	});
});

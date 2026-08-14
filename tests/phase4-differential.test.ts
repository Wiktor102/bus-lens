import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSnapshotReference } from "../server/agent-contracts.ts";
import { CanonicalCaptureCommandService } from "../server/canonical-capture-command-service.ts";
import { CanonicalQueryService } from "../server/canonical-query.ts";
import { openDatabase } from "../server/database.ts";
import {
	MAX_DIFFERENTIAL_ANALYZED_ELEMENTS,
	alignRawRelative,
	alignTimestampNearest,
	calculateDifferentialEvidence,
	makeDifferentialFrame
} from "../server/differential-analysis.ts";
import { McpQueryExecutor } from "../server/mcp-query-executor.ts";

function recordCapture(database: ReturnType<typeof openDatabase>, captureId: string, bytes: number[], timestamps?: number[]) {
	const commands = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-13T00:00:00.000Z" });
	commands.createCapture({ captureId, framing: [{ start: 0, framingMode: "length", frameSize: 2 }], inputFormat: "binary" });
	commands.startSession({ captureId, sessionId: `${captureId}-session` });
	const append = commands.appendChunk({
		captureId,
		sessionId: `${captureId}-session`,
		requestId: `${captureId}-request`,
		sequence: 0,
		expectedStartOffset: 0,
		bytes,
		timestamps: timestamps ?? bytes.map((_byte, index) => 100 + index),
		directions: bytes.map(() => "rx")
	});
	const finalized = commands.finalizeSession({ captureId, sessionId: `${captureId}-session`, expectedDataRevision: append.dataRevision });
	return {
		commands,
		snapshot: {
			captureId,
			profileId: finalized.profileId,
			profileVersion: finalized.profileVersion,
			sourceDataRevision: finalized.dataRevision
		} satisfies AgentSnapshotReference
	};
}

function differenceInput(baseline: AgentSnapshotReference, changed: AgentSnapshotReference, mode: "ordinal" | "timestamp-nearest" | "signature-sequence" | "raw-relative" = "ordinal") {
	return {
		baseline: { snapshot: baseline, label: "before" },
		changed: { snapshot: changed, label: "after" },
		alignment: { mode },
		limit: 100
	} as const;
}

function testFrame(id: string, ordinal: number, timestamp: number, rawOffset: number, bytes: number[] = [0], sectionKey = "section-a") {
	return makeDifferentialFrame({
		id,
		ordinal,
		sectionId: sectionKey,
		sectionKey,
		bytes,
		timestamps: [timestamp],
		directions: ["rx"],
		hidden: false,
		signature: bytes.map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(" "),
		rawOffsets: [rawOffset]
	});
}

test("timestamp-nearest maximizes cardinality before minimizing total timestamp distance", () => {
	const aligned = alignTimestampNearest(
		[testFrame("baseline-100", 0, 100, 0), testFrame("baseline-106", 1, 106, 1)],
		[testFrame("changed-101", 0, 101, 0), testFrame("changed-95", 1, 95, 1)],
		5
	);
	assert.equal(aligned.pairs.length, 2);
	assert.deepEqual(aligned.pairs.map(pair => [pair.baseline.id, pair.changed.id]), [
		["baseline-100", "changed-95"],
		["baseline-106", "changed-101"]
	]);
	assert.deepEqual(aligned.baselineUnpaired, []);
	assert.deepEqual(aligned.changedUnpaired, []);
});

test("raw-relative alignment is exact, normalized, and one-to-one", () => {
	const aligned = alignRawRelative(
		[testFrame("baseline-10", 0, 0, 10), testFrame("baseline-20", 1, 1, 20), testFrame("baseline-30", 2, 2, 30)],
		[testFrame("changed-100", 0, 0, 100), testFrame("changed-110", 1, 1, 110), testFrame("changed-130", 2, 2, 130)],
		10,
		100
	);
	assert.deepEqual(aligned.pairs.map(pair => [pair.baseline.id, pair.changed.id]), [
		["baseline-10", "changed-100"],
		["baseline-20", "changed-110"]
	]);
	assert.deepEqual(aligned.baselineUnpaired.map(frame => frame.id), ["baseline-30"]);
	assert.deepEqual(aligned.changedUnpaired.map(frame => frame.id), ["changed-130"]);
});

test("controlled differential evidence reports byte values, bit direction, and cautious ranking", () => {
	const database = openDatabase(":memory:");
	try {
		const baseline = recordCapture(database, "difference-before", [0, 0, 0, 0, 0, 0, 0, 0]);
		const changed = recordCapture(database, "difference-after", [1, 0, 1, 0, 1, 0, 1, 0]);
		const query = new CanonicalQueryService(database);
		const response = query.analyzeCaptureDifference(differenceInput(baseline.snapshot, changed.snapshot));
		const candidate = response.data.candidateFields.find(field => field.bytePosition === 0 && field.bitMask === "0x01");
		assert.ok(candidate);
		assert.equal(response.data.alignment.mode, "ordinal");
		assert.equal(response.data.alignment.pairedFrameCount, 4);
		assert.equal(response.data.alignment.baselineUnpairedFrameCount, 0);
		assert.equal(candidate.support, 4);
		assert.equal(candidate.setCount, 4);
		assert.equal(candidate.clearCount, 0);
		assert.deepEqual(candidate.baselineValues, [{ value: 0, count: 4 }]);
		assert.deepEqual(candidate.changedValues, [{ value: 1, count: 4 }]);
		assert.deepEqual(candidate.xorMasks, [{ mask: "0x01", count: 4 }]);
		assert.equal(candidate.evidence.baselineFrameIds.length, 4);
		assert.equal(candidate.evidence.evidenceTruncated, false);
		assert.ok(response.data.differenceSummary.alwaysChangingPositions.some(position => position.bytePosition === 0));
		assert.match(JSON.stringify(response), /candidateFields/);

		const reversed = query.analyzeCaptureDifference(differenceInput(changed.snapshot, baseline.snapshot));
		const reversedCandidate = reversed.data.candidateFields.find(field => field.bytePosition === 0 && field.bitMask === "0x01");
		assert.ok(reversedCandidate);
		assert.equal(reversedCandidate.setCount, 0);
		assert.equal(reversedCandidate.clearCount, 4);

		const identical = query.analyzeCaptureDifference(differenceInput(baseline.snapshot, baseline.snapshot));
		assert.deepEqual(identical.data.candidateFields, []);
		assert.ok(identical.data.differenceSummary.invariantPositions.length > 0);
	} finally {
		database.close();
	}
});

test("incompatible sections and lengths are excluded from candidate evidence and counted", () => {
	const compatible = {
		baseline: testFrame("compatible-baseline", 0, 0, 0, [0], "same-section"),
		changed: testFrame("compatible-changed", 0, 0, 0, [1], "same-section"),
		quality: 1,
		timestampDeltaMs: 0
	};
	const sectionReplacement = {
		baseline: testFrame("section-baseline", 1, 0, 1, [0], "baseline-section"),
		changed: testFrame("section-changed", 1, 0, 1, [2], "changed-section"),
		quality: 1,
		timestampDeltaMs: 0
	};
	const lengthReplacement = {
		baseline: testFrame("length-baseline", 2, 0, 2, [0, 0], "same-length-section"),
		changed: testFrame("length-changed", 2, 0, 2, [4], "same-length-section"),
		quality: 1,
		timestampDeltaMs: 0
	};
	const evidence = calculateDifferentialEvidence([compatible, sectionReplacement, lengthReplacement], 1);
	assert.equal(evidence.pairCompatibility.compatiblePairCount, 1);
	assert.equal(evidence.pairCompatibility.incompatiblePairCount, 2);
	assert.equal(evidence.pairCompatibility.sectionMismatchCount, 1);
	assert.equal(evidence.pairCompatibility.lengthMismatchCount, 1);
	assert.equal(evidence.candidateFields.length, 1);
	assert.equal(evidence.candidateFields[0]?.changedFrameFamily, "01");
	assert.deepEqual(evidence.differenceSummary.lengthChanges.map(change => [change.baselineLength, change.changedLength]), [[2, 1]]);
});

test("timestamp-nearest and signature-sequence alignment are one-to-one and report inserted frames", () => {
	const database = openDatabase(":memory:");
	try {
		const baseline = recordCapture(database, "alignment-before", [0, 0, 1, 0, 2, 0], [100, 101, 200, 201, 300, 301]);
		const changed = recordCapture(database, "alignment-after", [0, 0, 9, 9, 1, 1, 2, 0], [100, 101, 150, 151, 200, 201, 300, 301]);
		const query = new CanonicalQueryService(database);
		const timestamp = query.analyzeCaptureDifference({
			...differenceInput(baseline.snapshot, changed.snapshot, "timestamp-nearest"),
			alignment: { mode: "timestamp-nearest", maximumTimestampDeltaMs: 0 }
		});
		assert.equal(timestamp.data.alignment.pairedFrameCount, 3);
		assert.equal(timestamp.data.alignment.changedUnpairedFrameCount, 1);
		assert.equal(timestamp.data.alignment.insertedFrameCount, 1);

		const sequence = query.analyzeCaptureDifference(differenceInput(baseline.snapshot, changed.snapshot, "signature-sequence"));
		assert.equal(sequence.data.alignment.pairedFrameCount, 2);
		assert.equal(sequence.data.alignment.insertedFrameCount, 2);
		assert.equal(sequence.data.alignment.deletedFrameCount, 1);
		assert.equal(sequence.data.candidateFields.length, 0);
		assert.equal(sequence.data.alignment.pairCompatibility.compatiblePairCount, 2);
	} finally {
		database.close();
	}
});

test("shared scope.sectionId rejects profile-local section IDs instead of filtering one side silently", () => {
	const database = openDatabase(":memory:");
	try {
		const baseline = recordCapture(database, "scope-before", [0, 0]);
		const changed = recordCapture(database, "scope-after", [1, 0]);
		const baselineSection = (database.prepare("SELECT section_id FROM materialized_frames WHERE profile_id = @profileId LIMIT 1").get({ profileId: baseline.snapshot.profileId }) as { section_id: string }).section_id;
		const changedSection = (database.prepare("SELECT section_id FROM materialized_frames WHERE profile_id = @profileId LIMIT 1").get({ profileId: changed.snapshot.profileId }) as { section_id: string }).section_id;
		assert.notEqual(baselineSection, changedSection);
		const query = new CanonicalQueryService(database);
		assert.throws(
			() => query.analyzeCaptureDifference({ ...differenceInput(baseline.snapshot, changed.snapshot), scope: { sectionId: baselineSection } }),
			error => (error as { code?: string }).code === "invalid-input" && /both pinned snapshots/i.test(String((error as Error).message))
		);
	} finally {
		database.close();
	}
});

test("differential analysis rejects total byte and position arrays before materialization", () => {
	const database = openDatabase(":memory:");
	try {
		const baseline = recordCapture(database, "budget-before", [0, 0]);
		const changed = recordCapture(database, "budget-after", [1, 0]);
		database.prepare("UPDATE materialized_frames SET bytes_json = @bytes WHERE profile_id = @profileId").run({
			profileId: changed.snapshot.profileId,
			bytes: JSON.stringify(Array.from({ length: MAX_DIFFERENTIAL_ANALYZED_ELEMENTS + 1 }, () => 0))
		});
		const query = new CanonicalQueryService(database);
		assert.throws(
			() => query.analyzeCaptureDifference(differenceInput(baseline.snapshot, changed.snapshot)),
			error => (error as { code?: string }).code === "invalid-input" && /total byte\/position budget/i.test(String((error as Error).message))
		);
	} finally {
		database.close();
	}
});

test("candidate pagination is keyset-bound to both labelled snapshots and filters", () => {
	const database = openDatabase(":memory:");
	try {
		const baseline = recordCapture(database, "cursor-before", [0, 0, 0, 0, 0, 0, 0, 0]);
		const changed = recordCapture(database, "cursor-after", [3, 5, 3, 5, 3, 5, 3, 5]);
		const query = new CanonicalQueryService(database);
		const first = query.analyzeCaptureDifference({ ...differenceInput(baseline.snapshot, changed.snapshot), limit: 1 });
		const cursor = first.meta.page?.nextCursor;
		assert.ok(cursor);
		const second = query.analyzeCaptureDifference({ ...differenceInput(baseline.snapshot, changed.snapshot), limit: 1, cursor });
		const firstKey = first.data.candidateFields[0];
		const secondKey = second.data.candidateFields[0];
		assert.ok(firstKey);
		assert.ok(secondKey);
		assert.notDeepEqual(firstKey, secondKey);
		assert.throws(
			() => query.analyzeCaptureDifference({ ...differenceInput(baseline.snapshot, changed.snapshot), limit: 1, minimumSupport: 2, cursor }),
			error => (error as { code?: string }).code === "invalid-cursor"
		);
	} finally {
		database.close();
	}
});

test("the differential operation is routed through the disposable worker", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-differential-worker-test-"));
	const databasePath = join(directory, "archive.sqlite");
	const database = openDatabase(databasePath);
	const before = recordCapture(database, "worker-before", [0, 0, 0, 0]);
	const after = recordCapture(database, "worker-after", [1, 0, 1, 0]);
	const executor = new McpQueryExecutor(databasePath, 2_000);
	try {
		const response = await executor.analyzeCaptureDifference(differenceInput(before.snapshot, after.snapshot));
		assert.equal(response.data.alignment.pairedFrameCount, 2);
		assert.ok(response.data.candidateFields.length > 0);
	} finally {
		await executor.close();
		database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

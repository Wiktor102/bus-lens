import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSnapshotReference } from "../server/agent-contracts.ts";
import { CanonicalCaptureCommandService } from "../server/canonical-capture-command-service.ts";
import { CanonicalQueryService } from "../server/canonical-query.ts";
import { openDatabase } from "../server/database.ts";
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
		assert.equal(sequence.data.alignment.pairedFrameCount, 3);
		assert.equal(sequence.data.alignment.insertedFrameCount, 1);
		assert.equal(sequence.data.alignment.deletedFrameCount, 0);
		assert.ok(sequence.data.candidateFields.some(field => field.bytePosition === 1));
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

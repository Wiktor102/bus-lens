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

function recordCapture(
	database: ReturnType<typeof openDatabase>,
	captureId: string,
	bytes: number[],
	framing = [{ start: 0, framingMode: "length", frameSize: 2, collapseRuns: false, collapsed: false }]
): { commands: CanonicalCaptureCommandService; snapshot: AgentSnapshotReference } {
	const commands = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-14T00:00:00.000Z" });
	commands.createCapture({ captureId, framing, inputFormat: "binary" });
	commands.startSession({ captureId, sessionId: `${captureId}-session` });
	const append = commands.appendChunk({
		captureId,
		sessionId: `${captureId}-session`,
		requestId: `${captureId}-request`,
		sequence: 0,
		expectedStartOffset: 0,
		bytes,
		timestamps: bytes.map((_byte, index) => 100 + index),
		directions: bytes.map((_byte, index) => index % 2 ? "rx" : "rx")
	});
	const finalized = commands.finalizeSession({ captureId, sessionId: `${captureId}-session`, expectedDataRevision: append.dataRevision });
	return {
		commands,
		snapshot: {
			captureId,
			profileId: finalized.profileId,
			profileVersion: finalized.profileVersion,
			sourceDataRevision: finalized.dataRevision
		}
	};
}

function mixedCapture(database: ReturnType<typeof openDatabase>, captureId: string) {
	return recordCapture(database, captureId, [
		0x10, 0x01, 0x10, 0x02,
		0xa0, 0x01, 0x02, 0xa0, 0x03, 0x04
	], [
		{ start: 0, framingMode: "length", frameSize: 2, collapseRuns: false, collapsed: false },
		{ start: 4, framingMode: "length", frameSize: 3, collapseRuns: false, collapsed: false }
	]);
}

test("protocol reports keep sections and lengths separate and reuse transition/byte evidence", () => {
	const database = openDatabase(":memory:");
	try {
		const capture = mixedCapture(database, "protocol-report-mixed");
		const query = new CanonicalQueryService(database);
		const report = query.getProtocolReport({ snapshot: capture.snapshot });
		assert.equal(report.meta.page, undefined);
		assert.deepEqual(report.data.snapshot, capture.snapshot);
		assert.deepEqual(report.data.scope, {});
		assert.equal(report.data.hiddenPolicy, "include");
		assert.ok(report.data.frameFamilies?.some(family => family.frameLength === 2));
		assert.ok(report.data.frameFamilies?.some(family => family.frameLength === 3));
		assert.ok(report.data.frameFamilies?.some(family => family.sectionId !== report.data.frameFamilies[0]?.sectionId));
		assert.ok(report.data.invariants?.bytes.some(item => item.position === 0 && item.classification === "stable"));
		assert.ok(report.data.variableBits?.bytes.some(item => item.position === 1 && item.classification === "variable"));
		const transition = report.data.transitions?.find(item => item.fromSignature === "10 01" && item.toSignature === "10 02");
		assert.deepEqual(transition && {
			count: transition.count,
			changedPositions: transition.changedPositions,
			changedPositionCounts: transition.changedPositionCounts
		}, {
			count: 1,
			changedPositions: [1],
			changedPositionCounts: [{ position: 1, changedCount: 1 }]
		});
		const statistics = query.getByteStatistics({
			captureId: capture.snapshot.captureId,
			profileId: capture.snapshot.profileId,
			positions: [0, 1],
			scope: { sectionId: report.data.frameFamilies?.find(family => family.frameLength === 2)?.sectionId, frameLength: 2 }
		});
		assert.equal(statistics.data.matchedFrameCount, 2);
		assert.ok(statistics.data.positions.some(position => position.position === 1 && position.vocabulary.length > 1));
		assert.equal(report.data.evidenceQuality.sampleSufficiency, "sufficient");
		assert.ok(report.data.followUpOperations.some(operation => operation.tool === "query_messages"));

		const scoped = query.getProtocolReport({
			snapshot: capture.snapshot,
			scope: { sectionId: report.data.frameFamilies?.find(family => family.frameLength === 2)?.sectionId, frameLength: 2, direction: "RX" },
			hidden: "visible-only",
			include: ["frame-families", "variable-bits"]
		});
		const queryFollowUp = scoped.data.followUpOperations.find(operation => operation.tool === "query_messages");
		assert.deepEqual(queryFollowUp?.arguments && (queryFollowUp.arguments as Record<string, unknown>).scope, {
			sectionId: report.data.frameFamilies?.find(family => family.frameLength === 2)?.sectionId,
			frameLength: 2,
			direction: "rx"
		});
		assert.equal(queryFollowUp?.arguments && (queryFollowUp.arguments as Record<string, unknown>).hidden, "visible-only");
		assert.ok(!scoped.data.followUpOperations.some(operation => operation.tool === "get_transitions"));
	} finally {
		database.close();
	}
});

test("protocol reports normalize scope, make hidden policy explicit, and stay pinned to history", () => {
	const database = openDatabase(":memory:");
	try {
		const capture = mixedCapture(database, "protocol-report-history");
		const query = new CanonicalQueryService(database);
		const firstSection = database.prepare("SELECT id FROM framing_sections WHERE profile_id = @profileId ORDER BY position LIMIT 1").get({ profileId: capture.snapshot.profileId }) as { id: string };
		database.prepare("UPDATE materialized_frames SET hidden = 1 WHERE profile_id = @profileId AND ordinal = 0").run({ profileId: capture.snapshot.profileId });
		const visible = query.getProtocolReport({
			snapshot: capture.snapshot,
			scope: { sectionId: firstSection.id, frameLength: 2, direction: "RX" },
			hidden: "visible-only",
			include: ["frame-families", "invariants", "variable-bits"]
		});
		assert.deepEqual(visible.data.scope, { sectionId: firstSection.id, frameLength: 2, direction: "rx" });
		assert.equal(visible.data.hiddenPolicy, "visible-only");
		assert.equal(visible.data.evidenceQuality.hiddenExcludedFrameCount, 1);
		assert.equal(visible.data.evidenceQuality.applicableFrameCount, 1);
		assert.ok(visible.data.variableBits?.bytes.every(item => item.classification === "insufficient-evidence"));
		assert.throws(
			() => query.getProtocolReport({ snapshot: capture.snapshot, scope: { wildcardHexPattern: "?? 01" } }),
			error => (error as { code?: string }).code === "wildcard-too-broad"
		);

		const beforeReframe = query.getProtocolReport({ snapshot: capture.snapshot, include: ["frame-families", "transitions"] });
		capture.commands.reframe({
			captureId: capture.snapshot.captureId,
			expectedActiveProfileId: capture.snapshot.profileId,
			expectedDataRevision: capture.snapshot.sourceDataRevision,
			sections: [{ start: 0, framingMode: "length", frameSize: 1 }]
		});
		const historical = query.getProtocolReport({ snapshot: capture.snapshot, include: ["frame-families", "transitions"] });
		assert.deepEqual(historical.data.frameFamilies, beforeReframe.data.frameFamilies);
		assert.deepEqual(historical.data.transitions, beforeReframe.data.transitions);
		assert.equal(historical.meta.snapshot?.profileId, capture.snapshot.profileId);
	} finally {
		database.close();
	}
});

test("protocol reports classify low support and controlled differential evidence without semantic claims", () => {
	const database = openDatabase(":memory:");
	try {
		const small = recordCapture(database, "protocol-report-small", [0x10, 0x01]);
		const query = new CanonicalQueryService(database);
		const insufficient = query.getProtocolReport({ snapshot: small.snapshot, minimumSupport: 2, include: ["invariants"] });
		assert.equal(insufficient.data.evidenceQuality.sampleSufficiency, "insufficient-evidence");
		assert.ok(insufficient.data.invariants?.bytes.some(item => item.classification === "insufficient-evidence"));
		assert.ok(insufficient.data.invariants?.bits.some(item => item.classification === "insufficient-evidence"));

		const baseline = recordCapture(database, "protocol-report-diff-before", [0, 0, 0, 0]);
		const changed = recordCapture(database, "protocol-report-diff-after", [1, 0, 1, 0]);
		const differential = query.getProtocolReport({
			snapshot: baseline.snapshot,
			scope: { frameLength: 2 },
			include: ["differential-candidates"],
			minimumSupport: 1,
			differentialAnalysis: {
				baseline: { snapshot: baseline.snapshot, label: "before" },
				changed: { snapshot: changed.snapshot, label: "after" },
				alignment: { mode: "ordinal" }
			}
		});
		assert.ok(differential.data.differentialCandidates?.length);
		assert.ok(differential.data.differentialCandidates?.every(candidate => candidate.classification === "candidate"));
		assert.ok(!JSON.stringify(differential).toLowerCase().includes("power state"));
		const differentialFollowUp = differential.data.followUpOperations.find(operation => operation.tool === "analyze_capture_difference");
		assert.deepEqual(differentialFollowUp?.arguments && (differentialFollowUp.arguments as Record<string, unknown>).scope, { frameLength: 2 });
		assert.equal(differentialFollowUp?.arguments && (differentialFollowUp.arguments as Record<string, unknown>).minimumSupport, 1);
		assert.ok(differentialFollowUp);

		const rareBit = recordCapture(database, "protocol-report-rare-bit", [0x01, 0x00, ...Array.from({ length: 999 }, () => [0x00, 0x00]).flat()]);
		const rareBitReport = query.getProtocolReport({ snapshot: rareBit.snapshot, include: ["invariants", "variable-bits"] });
		assert.ok(rareBitReport.data.variableBits?.bits.some(item => item.position === 0 && item.bit === 0 && item.onePercentage === 0 && item.classification === "variable"));
		assert.ok(!rareBitReport.data.invariants?.bits.some(item => item.position === 0 && item.bit === 0));
	} finally {
		database.close();
	}
});

test("protocol reports scope before bounded sampling and do not expose unsafe sequence summaries", () => {
	const database = openDatabase(":memory:");
	try {
		const lateBytes = [...Array.from({ length: 4_001 * 2 }, () => 0), 0xaa, 0xbb];
		const late = recordCapture(database, "protocol-report-late-scope", lateBytes);
		const query = new CanonicalQueryService(database);
		const scoped = query.getProtocolReport({
			snapshot: late.snapshot,
			scope: { exactSignature: "AA BB" },
			include: ["frame-families"]
		});
		assert.equal(scoped.data.evidenceQuality.scopeMatchedFrameCount, 1);
		assert.equal(scoped.data.evidenceQuality.sampledFrameCount, 1);
		assert.equal(scoped.data.frameFamilies?.length, 1);
		assert.equal(scoped.data.frameFamilies?.[0]?.signature, "AA BB");
		assert.equal(scoped.data.evidenceQuality.truncated, false);

		const long = recordCapture(database, "protocol-report-long-signature", Array.from({ length: 1_024 }, (_value, index) => index % 256), [{ start: 0, framingMode: "length", frameSize: 1_024, collapseRuns: false, collapsed: false }]);
		const compactLong = query.getProtocolReport({ snapshot: long.snapshot, detail: "compact", include: ["frame-families"] });
		assert.ok(compactLong.data.frameFamilies?.[0]?.signatureTruncated);
		assert.ok((compactLong.data.frameFamilies?.[0]?.signatureLength ?? 0) > 96);
		assert.ok(Buffer.byteLength(JSON.stringify(compactLong), "utf8") <= 32 * 1024);

		const repeated = recordCapture(database, "protocol-report-hidden-sequence", Array.from({ length: 4 }, () => [[1, 2], [3, 4], [5, 6], [7, 8]]).flat(2));
		const group = database.prepare("SELECT id FROM sequence_groups WHERE profile_id = @profileId LIMIT 1").get({ profileId: repeated.snapshot.profileId }) as { id: string } | undefined;
		assert.ok(group);
		database.prepare("UPDATE materialized_frames SET hidden = 1 WHERE profile_id = @profileId AND ordinal = 0").run({ profileId: repeated.snapshot.profileId });
		const visible = query.getProtocolReport({
			snapshot: repeated.snapshot,
			hidden: "visible-only",
			include: ["sequences"]
		});
		assert.deepEqual(visible.data.sequences, []);
		const occurrences = query.getSequenceOccurrences({
			captureId: repeated.snapshot.captureId,
			groupId: group!.id,
			profileId: repeated.snapshot.profileId,
			profileVersion: repeated.snapshot.profileVersion,
			sourceDataRevision: repeated.snapshot.sourceDataRevision,
			scope: { frameLength: 2 },
			hidden: "visible-only",
			includeContext: true,
			limit: 10
		});
		assert.ok(occurrences.data.occurrences.length > 0);
		assert.ok(occurrences.data.occurrences.every(occurrence => occurrence.context?.every(frame => !frame.hidden)));
		assert.ok(occurrences.data.occurrences.every(occurrence => occurrence.context?.every(frame => frame.sectionId)));
	} finally {
		database.close();
	}
});

test("protocol report rejects direct pagination fields and auto-includes differential candidates", () => {
	const database = openDatabase(":memory:");
	try {
		const baseline = recordCapture(database, "protocol-report-auto-diff-before", [0, 0, 0, 0]);
		const changed = recordCapture(database, "protocol-report-auto-diff-after", [1, 0, 1, 0]);
		const query = new CanonicalQueryService(database);
		assert.throws(
			() => query.getProtocolReport({ snapshot: baseline.snapshot, cursor: "not-accepted" } as never),
			error => (error as { code?: string }).code === "invalid-input"
		);
		const report = query.getProtocolReport({
			snapshot: baseline.snapshot,
			include: ["invariants"],
			differentialAnalysis: {
				baseline: { snapshot: baseline.snapshot, label: "before" },
				changed: { snapshot: changed.snapshot, label: "after" },
				alignment: { mode: "ordinal" }
			}
		});
		assert.ok(report.data.include.includes("differential-candidates"));
		assert.ok(report.data.differentialCandidates);
	} finally {
		database.close();
	}
});

test("protocol reports remain within the normal response budget and use the disposable worker", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-protocol-report-worker-"));
	const databasePath = join(directory, "archive.sqlite");
	const database = openDatabase(databasePath);
	try {
		const bytes = Array.from({ length: 1_000 * 2 }, (_value, index) => index % 256);
		const capture = recordCapture(database, "protocol-report-worker", bytes);
		const query = new CanonicalQueryService(database);
		const direct = query.getProtocolReport({ snapshot: capture.snapshot, detail: "compact" });
		assert.ok(Buffer.byteLength(JSON.stringify(direct), "utf8") <= 32 * 1024);
		assert.equal(direct.meta.page, undefined);
		const executor = new McpQueryExecutor(databasePath, 5_000);
		try {
			const response = await executor.getProtocolReport({ snapshot: capture.snapshot, include: ["frame-families", "transitions"], detail: "compact" });
			assert.equal(response.data.snapshot.profileId, capture.snapshot.profileId);
			assert.equal(response.meta.page, undefined);
		} finally {
			await executor.close();
		}
	} finally {
		database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

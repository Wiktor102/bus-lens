import assert from "node:assert/strict";
import test from "node:test";
import { CanonicalCaptureCommandService } from "../server/canonical-capture-command-service.ts";
import { CanonicalQueryService } from "../server/canonical-query.ts";
import { openDatabase } from "../server/database.ts";

const framing = [{ start: 0, framingMode: "length", frameSize: 2, collapseRuns: false, collapsed: false }] as const;

function seedAnalysisCapture() {
	const database = openDatabase(":memory:");
	const commands = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-10T00:00:00.000Z" });
	commands.createCapture({ captureId: "analysis-capture", framing, name: "Analysis capture", inputFormat: "binary" });
	commands.startSession({ captureId: "analysis-capture", sessionId: "analysis-session" });
	const append = commands.appendChunk({
		captureId: "analysis-capture",
		sessionId: "analysis-session",
		requestId: "analysis-request",
		sequence: 0,
		expectedStartOffset: 0,
		bytes: [1, 2, 1, 2, 3, 4, 1, 2],
		timestamps: [100, 101, 200, 201, 300, 301, 400, 401],
		directions: ["rx", "rx", "tx", "tx", "rx", "rx", "rx", "rx"]
	});
	const finalized = commands.finalizeSession({ captureId: "analysis-capture", sessionId: "analysis-session", expectedDataRevision: append.dataRevision });
	const firstFrame = database.prepare("SELECT id FROM materialized_frames WHERE profile_id = @profileId AND ordinal = 0").get({ profileId: finalized.profileId }) as { id: string };
	const groupId = "analysis-group";
	database.prepare(
		`INSERT INTO sequence_groups (id, capture_id, profile_id, key_text, signatures_json, score, length)
		 VALUES (@id, 'analysis-capture', @profileId, '01 02 / 01 02', @signatures, 2, 2)`
	).run({ id: groupId, profileId: finalized.profileId, signatures: JSON.stringify(["01 02", "01 02"]) });
	database.prepare(
		`INSERT INTO sequence_occurrences
		 (group_id, occurrence_index, offset, start_frame_ordinal, start_raw_offset, end_raw_offset, length)
		 VALUES (@groupId, 0, 0, 0, 0, 3, 2), (@groupId, 1, 0, 2, 4, 7, 2)`
	).run({ groupId });
	commands.createNote({ captureId: "analysis-capture", noteId: "analysis-frame-note", text: "inspect this frame", target: { kind: "frame", frameId: firstFrame.id } });
	database.prepare("UPDATE materialized_frames SET hidden = 1 WHERE id = @frameId").run({ frameId: firstFrame.id });
	database.prepare("INSERT INTO raw_byte_visibility (capture_id, raw_offset, hidden) VALUES ('analysis-capture', 1, 1)").run();
	return { database, commands, profileId: finalized.profileId, dataRevision: finalized.dataRevision, groupId, firstFrameId: firstFrame.id };
}

test("analysis messages apply bounded filters, stable evidence references, and keyset cursors", () => {
	const { database, profileId, groupId, firstFrameId } = seedAnalysisCapture();
	try {
		const query = new CanonicalQueryService(database);
		const first = query.queryMessages({ captureId: "analysis-capture", limit: 2 });
		assert.equal(first.data.messages.length, 2);
		assert.ok(first.meta.page?.nextCursor);
		assert.equal(first.meta.snapshot?.profileId, profileId);
		const second = query.queryMessages({ captureId: "analysis-capture", limit: 2, cursor: first.meta.page?.nextCursor });
		assert.equal(second.data.messages.length, 2);
		assert.equal(new Set([...first.data.messages, ...second.data.messages].map(message => message.frameId)).size, 4);
		assert.throws(() => query.queryMessages({ captureId: "analysis-capture", limit: 2, cursor: first.meta.page?.nextCursor, sectionId: "different" }), /filters/);
		assert.throws(() => query.queryMessages({ captureId: "analysis-capture", wildcardHexPattern: "?? 02" }), error => (error as { code?: string }).code === "wildcard-too-broad");
		assert.equal(query.queryMessages({ captureId: "analysis-capture", ordinalFrom: 0, ordinalTo: 3, wildcardHexPattern: "?? 02" }).data.messages.length, 3);
		assert.equal(query.queryMessages({ captureId: "analysis-capture", hidden: "hidden-only" }).data.messages[0]?.frameId, firstFrameId);
		assert.equal(query.queryMessages({ captureId: "analysis-capture", notePresence: "with-note" }).data.messages[0]?.frameId, firstFrameId);
		assert.equal(query.queryMessages({ captureId: "analysis-capture", sequenceGroupId: groupId }).data.messages.length, 4);
		const context = query.getMessageContext({ frameId: firstFrameId, rowsBefore: 1, rowsAfter: 1 });
		assert.equal(context.meta.snapshot?.profileId, profileId);
		assert.equal(context.data.centerFrameId, firstFrameId);
		assert.equal(context.data.messages.length, 2);
	} finally {
		database.close();
	}
});

test("analysis groups, occurrences, statistics, transitions, and raw reads remain bounded", () => {
	const { database, profileId, groupId } = seedAnalysisCapture();
	try {
		const query = new CanonicalQueryService(database);
		const groups = query.getSequenceGroups({ captureId: "analysis-capture", profileId, limit: 10 });
		assert.equal(groups.data.groups[0]?.occurrenceCount, 2);
		assert.deepEqual(groups.data.groups[0]?.sections.length, 1);
		const occurrences = query.getSequenceOccurrences({ captureId: "analysis-capture", groupId, profileId, includeContext: true, contextBefore: 1, contextAfter: 1 });
		assert.equal(occurrences.data.occurrences.length, 2);
		assert.ok(occurrences.data.occurrences[0]?.context?.length);
		const statistics = query.getByteStatistics({ captureId: "analysis-capture", profileId, positions: [0, 1] });
		assert.equal(statistics.data.positions.length, 2);
		assert.ok(statistics.data.positions[0]?.vocabulary.length);
		const transitions = query.getTransitions({ captureId: "analysis-capture", profileId, minimumCount: 1 });
		assert.ok(transitions.data.transitions.length);
		const raw = query.readRawBytes({ captureId: "analysis-capture", rawOffset: 0, length: 4 });
		assert.equal(raw.data.returnedByteCount, 4);
		assert.equal(raw.data.hex, "01 ?? 01 02");
		assert.equal(raw.data.timestamps.deltas.length, 3);
		assert.throws(() => query.readRawBytes({ captureId: "analysis-capture", rawOffset: 0, length: 4097 }), /length/);
	} finally {
		database.close();
	}
});

test("message cursors keep the original profile pinned across reframing", () => {
	const { database, commands, profileId, dataRevision } = seedAnalysisCapture();
	try {
		const query = new CanonicalQueryService(database);
		const first = query.queryMessages({ captureId: "analysis-capture", limit: 1 });
		commands.reframe({ captureId: "analysis-capture", expectedActiveProfileId: profileId, expectedDataRevision: dataRevision, sections: [{ start: 0, framingMode: "length", frameSize: 1 }] });
		const continued = query.queryMessages({ captureId: "analysis-capture", limit: 1, cursor: first.meta.page?.nextCursor });
		assert.equal(continued.meta.snapshot?.profileId, profileId);
		assert.equal(continued.data.messages[0]?.ordinal, 1);
		const historicalFrameId = first.data.messages[0]!.frameId;
		const historicalContext = query.getMessageContext({ frameId: historicalFrameId });
		assert.equal(historicalContext.meta.snapshot?.profileId, profileId);
		assert.equal(historicalContext.data.centerFrameId, historicalFrameId);
		assert.throws(
			() => query.getMessageContext({ frameId: historicalFrameId, profileVersion: 999 }),
			error => (error as { code?: string }).code === "snapshot-mismatch"
		);
	} finally {
		database.close();
	}
});

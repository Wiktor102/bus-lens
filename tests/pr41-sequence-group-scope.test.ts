import assert from "node:assert/strict";
import test from "node:test";
import { CanonicalCaptureCommandService } from "../server/canonical-capture-command-service.ts";
import { CanonicalQueryService } from "../server/canonical-query.ts";
import { openDatabase } from "../server/database.ts";

const framing = [{ start: 0, framingMode: "length", frameSize: 2, collapseRuns: false, collapsed: false }] as const;

function finalizeCapture(commands: CanonicalCaptureCommandService, captureId: string, bytes: readonly number[]) {
	commands.createCapture({ captureId, framing, inputFormat: "binary" });
	commands.startSession({ captureId, sessionId: `${captureId}-session` });
	const append = commands.appendChunk({
		captureId,
		sessionId: `${captureId}-session`,
		requestId: `${captureId}-request`,
		sequence: 0,
		expectedStartOffset: 0,
		bytes,
		timestamps: bytes.map((_byte, index) => index),
		directions: bytes.map(() => "rx")
	});
	return commands.finalizeSession({ captureId, sessionId: `${captureId}-session`, expectedDataRevision: append.dataRevision });
}

function insertSequenceGroup(database: ReturnType<typeof openDatabase>, id: string, captureId: string, profileId: string, keyText: string) {
	database.prepare(
		`INSERT INTO sequence_groups (id, capture_id, profile_id, key_text, signatures_json, score, length)
		 VALUES (@id, @captureId, @profileId, @keyText, @signatures, 1, 1)`
	).run({ id, captureId, profileId, keyText, signatures: JSON.stringify([keyText]) });
}

function insertPatternNote(
	database: ReturnType<typeof openDatabase>,
	{id, captureId, profileId, sequenceKey, text, createdAt}: Readonly<{ id: string; captureId: string; profileId: string | null; sequenceKey: string; text: string; createdAt: string }>
) {
	database.prepare(
		`INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind, profile_id, sequence_key)
		 VALUES (@id, @captureId, @text, @createdAt, 'pattern', @profileId, @sequenceKey)`
	).run({ id, captureId, profileId, sequenceKey, text, createdAt });
}

test("queryMessages scopes sequence-group filters to the requested capture snapshot", () => {
	const database = openDatabase(":memory:");
	try {
		const commands = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-10T00:00:00.000Z" });
		const current = finalizeCapture(commands, "current-capture", [1, 2]);
		const foreign = finalizeCapture(commands, "foreign-capture", [3, 4]);
		const groupId = "foreign-group";
		database.prepare(
			`INSERT INTO sequence_groups (id, capture_id, profile_id, key_text, signatures_json, score, length)
			 VALUES (@id, 'foreign-capture', @profileId, '03 04', '["03 04"]', 1, 1)`
		).run({ id: groupId, profileId: foreign.profileId });
		database.prepare(
			`INSERT INTO sequence_occurrences
			 (group_id, occurrence_index, offset, start_frame_ordinal, start_raw_offset, end_raw_offset, length)
			 VALUES (@groupId, 0, 0, 0, 0, 1, 1)`
		).run({ groupId });

		const query = new CanonicalQueryService(database);
		const response = query.queryMessages({ captureId: "current-capture", profileId: current.profileId, sequenceGroupId: groupId });
		assert.deepEqual(response.data.messages, []);
	} finally {
		database.close();
	}
});

test("getSequenceGroups scopes remarks by capture and profile while retaining capture-wide notes", () => {
	const database = openDatabase(":memory:");
	try {
		const commands = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-10T00:00:00.000Z" });
		const original = finalizeCapture(commands, "scoped-capture", [1, 2]);
		const reframed = commands.reframe({
			captureId: "scoped-capture",
			expectedActiveProfileId: original.profileId,
			expectedDataRevision: original.dataRevision,
			sections: [{ start: 0, framingMode: "length", frameSize: 1 }]
		});
		const foreign = finalizeCapture(commands, "foreign-capture", [1, 2]);
		const sharedKey = "shared-sequence";
		const captureWideKey = "capture-wide-sequence";

		insertSequenceGroup(database, "original-shared-group", "scoped-capture", original.profileId, sharedKey);
		insertSequenceGroup(database, "reframed-shared-group", "scoped-capture", reframed.profileId, sharedKey);
		insertSequenceGroup(database, "foreign-shared-group", "foreign-capture", foreign.profileId, sharedKey);
		insertSequenceGroup(database, "original-wide-group", "scoped-capture", original.profileId, captureWideKey);
		insertSequenceGroup(database, "reframed-wide-group", "scoped-capture", reframed.profileId, captureWideKey);
		insertSequenceGroup(database, "foreign-wide-group", "foreign-capture", foreign.profileId, captureWideKey);

		insertPatternNote(database, { id: "scoped-wide-remark", captureId: "scoped-capture", profileId: null, sequenceKey: sharedKey, text: "scoped capture-wide remark", createdAt: "2026-08-10T00:00:01.000Z" });
		insertPatternNote(database, { id: "original-remark", captureId: "scoped-capture", profileId: original.profileId, sequenceKey: sharedKey, text: "original profile remark", createdAt: "2026-08-10T00:00:02.000Z" });
		insertPatternNote(database, { id: "reframed-remark", captureId: "scoped-capture", profileId: reframed.profileId, sequenceKey: sharedKey, text: "reframed profile remark", createdAt: "2026-08-10T00:00:03.000Z" });
		insertPatternNote(database, { id: "foreign-remark", captureId: "foreign-capture", profileId: null, sequenceKey: sharedKey, text: "foreign capture remark", createdAt: "2026-08-10T00:00:04.000Z" });
		insertPatternNote(database, { id: "scoped-wide-only-remark", captureId: "scoped-capture", profileId: null, sequenceKey: captureWideKey, text: "scoped capture-wide only remark", createdAt: "2026-08-10T00:00:05.000Z" });
		insertPatternNote(database, { id: "foreign-wide-remark", captureId: "foreign-capture", profileId: null, sequenceKey: captureWideKey, text: "foreign capture-wide remark", createdAt: "2026-08-10T00:00:06.000Z" });

		const query = new CanonicalQueryService(database);
		const groupsById = (profileId: string) => new Map(query.getSequenceGroups({ captureId: "scoped-capture", profileId }).data.groups.map(group => [group.id, group]));
		assert.equal(groupsById(original.profileId).get("original-shared-group")?.remark, "original profile remark");
		assert.equal(groupsById(reframed.profileId).get("reframed-shared-group")?.remark, "reframed profile remark");
		assert.equal(groupsById(original.profileId).get("original-wide-group")?.remark, "scoped capture-wide only remark");
		assert.equal(groupsById(reframed.profileId).get("reframed-wide-group")?.remark, "scoped capture-wide only remark");
		const foreignGroups = new Map(query.getSequenceGroups({ captureId: "foreign-capture", profileId: foreign.profileId }).data.groups.map(group => [group.id, group]));
		assert.equal(foreignGroups.get("foreign-shared-group")?.remark, "foreign capture remark");
		assert.equal(foreignGroups.get("foreign-wide-group")?.remark, "foreign capture-wide remark");
	} finally {
		database.close();
	}
});

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

import assert from "node:assert/strict";
import test from "node:test";
import {
	CanonicalCaptureCommandService,
	CanonicalCaptureConflictError,
	CanonicalCaptureIdempotencyConflictError
} from "../server/canonical-capture-command-service.ts";
import { openDatabase } from "../server/database.ts";

const framing = [{ start: 0, framingMode: "length", frameSize: 2, collapseRuns: false, collapsed: false }] as const;

function count(database: ReturnType<typeof openDatabase>, table: string, captureId: string): number {
	return (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE capture_id = @captureId`).get({ captureId }) as { count: number }).count;
}

function countProfileRows(database: ReturnType<typeof openDatabase>, table: string, captureId: string): number {
	return (
		database
			.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE profile_id IN (SELECT id FROM framing_profiles WHERE capture_id = @captureId)`)
			.get({ captureId }) as { count: number }
	).count;
}

function recordCapture(service: CanonicalCaptureCommandService, captureId: string, bytes = [1, 2, 1, 2]) {
	service.createCapture({
		captureId,
		framing,
		name: `${captureId} name`,
		description: `${captureId} description`,
		controllerView: "RS-485",
		baudRate: 9600,
		inputFormat: "binary",
		folderId: "folder-1",
		parameters: [
			{ key: "mode", value: "safe" },
			{ key: "channel", value: "A" }
		]
	});
	service.startSession({ captureId, sessionId: `${captureId}-session` });
	const append = service.appendChunk({
		captureId,
		sessionId: `${captureId}-session`,
		requestId: `${captureId}-request`,
		sequence: 0,
		expectedStartOffset: 0,
		bytes
	});
	return service.finalizeSession({ captureId, sessionId: `${captureId}-session`, expectedDataRevision: append.dataRevision });
}

function seedAnalysisAndAnnotations(
	database: ReturnType<typeof openDatabase>,
	service: CanonicalCaptureCommandService,
	captureId: string,
	profileId: string
): { frameId: string; groupId: string } {
	const frameId = (database.prepare("SELECT id FROM materialized_frames WHERE capture_id = @captureId ORDER BY ordinal LIMIT 1").get({ captureId }) as { id: string }).id;
	const groupId = `${captureId}-group`;
	database
		.prepare(
			`INSERT INTO sequence_groups (id, capture_id, profile_id, key_text, signatures_json, score, length)
			 VALUES (@id, @captureId, @profileId, @keyText, @signaturesJson, 2, 2)`
		)
		.run({ id: groupId, captureId, profileId, keyText: "01 02", signaturesJson: JSON.stringify(["01 02"]) });
	database
		.prepare(
			`INSERT INTO sequence_occurrences
			 (group_id, occurrence_index, offset, start_frame_ordinal, start_raw_offset, end_raw_offset, length)
			 VALUES (@groupId, 0, 0, 0, 0, 3, 2)`
		)
		.run({ groupId });
	database
		.prepare("INSERT INTO frame_signatures (profile_id, signature, count) VALUES (@profileId, 'custom', 2)")
		.run({ profileId });
	database
		.prepare("INSERT INTO frame_transitions (profile_id, from_signature, to_signature, count, diffs) VALUES (@profileId, 'custom', 'custom', 1, 0)")
		.run({ profileId });
	database
		.prepare("INSERT INTO byte_statistics (profile_id, position, value, count) VALUES (@profileId, 99, 99, 2)")
		.run({ profileId });
	database
		.prepare("INSERT INTO bit_statistics (profile_id, position, bit, percentage, variance) VALUES (@profileId, 99, 7, 50, 'variable')")
		.run({ profileId });
	service.createNote({ captureId, noteId: `${captureId}-capture-note`, text: "capture note", target: { kind: "capture" } });
	service.createNote({ captureId, noteId: `${captureId}-byte-note`, text: "byte note", target: { kind: "byte", rawOffset: 0 } });
	service.createNote({
		captureId,
		noteId: `${captureId}-frame-note`,
		text: "frame note",
		target: { kind: "frame", profileId, rawOffsets: [0, 1] }
	});
	service.createNote({
		captureId,
		noteId: `${captureId}-range-note`,
		text: "range note",
		target: { kind: "range", profileId, startOrdinal: 0, endOrdinal: 1 }
	});
	service.createNote({
		captureId,
		noteId: `${captureId}-group-note`,
		text: "sequence group note",
		target: { kind: "sequence-group", profileId, groupId }
	});
	database
		.prepare(
			`INSERT INTO stable_notes
			 (id, capture_id, text, created_at, target_kind, sequence_key, start_row, end_row)
			 VALUES (@id, @captureId, @text, @createdAt, @targetKind, @sequenceKey, 0, 1)`
		)
		.run({ id: `${captureId}-sequence-note`, captureId, text: "sequence note", createdAt: "2026-08-09T00:00:00.000Z", targetKind: "sequence", sequenceKey: "01 02" });
	database
		.prepare(
			`INSERT INTO stable_notes
			 (id, capture_id, text, created_at, target_kind, sequence_key)
			 VALUES (@id, @captureId, @text, @createdAt, 'pattern', @sequenceKey)`
		)
		.run({ id: `${captureId}-pattern-note`, captureId, text: "pattern note", createdAt: "2026-08-09T00:00:00.000Z", sequenceKey: "01 02" });
	database
		.prepare(
			`INSERT INTO stable_notes
			 (id, capture_id, text, created_at, target_kind, start_row, end_row)
			 VALUES (@id, @captureId, @text, @createdAt, 'legacy-sequence', 0, 1)`
		)
		.run({ id: `${captureId}-legacy-note`, captureId, text: "legacy note", createdAt: "2026-08-09T00:00:00.000Z" });
	service.setByteVisibility({ captureId, rawOffset: 0, hidden: true });
	service.setFrameVisibility({ captureId, frameId, hidden: true });
	return { frameId, groupId };
}

function captureDocumentRow(database: ReturnType<typeof openDatabase>, captureId: string): void {
	database
		.prepare(
			`INSERT INTO capture_documents (id, document_version, document_json, created_at, updated_at)
			 VALUES (@id, 1, @documentJson, @createdAt, @updatedAt)`
		)
		.run({ id: captureId, documentJson: JSON.stringify({ id: captureId, name: "legacy shadow" }), createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" });
}

test("pattern notes support stable canonical create, update, and delete commands", () => {
	const database = openDatabase(":memory:");
	try {
		const service = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-09T00:00:00.000Z" });
		service.createCapture({ captureId: "pattern-note", framing, inputFormat: "binary" });

		const created = service.createNote({
			captureId: "pattern-note",
			noteId: "pattern-note-id",
			text: "first remark",
			target: { kind: "pattern", sequenceKey: "01 02" }
		});
		assert.deepEqual(created.note.target, { kind: "pattern", sequenceKey: "01 02" });

		const updated = service.updateNote({
			captureId: "pattern-note",
			noteId: "pattern-note-id",
			text: "updated remark",
			target: { kind: "pattern", sequenceKey: "01 02" }
		});
		assert.equal(updated.note.text, "updated remark");
		assert.deepEqual(updated.note.target, { kind: "pattern", sequenceKey: "01 02" });

		service.deleteNote({ captureId: "pattern-note", noteId: "pattern-note-id" });
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM stable_notes WHERE capture_id = 'pattern-note'").get() as { count: number }).count, 0);
	} finally {
		database.close();
	}
});

test("clearCaptureData is authority-gated, atomic, revision-scoped, and preserves canonical context", () => {
	const database = openDatabase(":memory:");
	try {
		const service = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-09T00:00:00.000Z" });
		service.createCapture({
			captureId: "clear-capture",
			framing,
			name: "Keep metadata",
			description: "Keep description",
			controllerView: "RS-485",
			baudRate: 115200,
			inputFormat: "binary",
			folderId: "folder-keep",
			parameters: [{ key: "one", value: "1" }, { key: "two", value: "2" }]
		});
		service.patchMetadata({ captureId: "clear-capture", expectedMetadataRevision: 0, patch: { description: "Patched description" } });
		service.startSession({ captureId: "clear-capture", sessionId: "clear-session" });
		service.updateFramingDraft({ captureId: "clear-capture", expectedRevision: 0, sections: [{ start: 0, framingMode: "length", frameSize: 1 }] });
		const append = service.appendChunk({
			captureId: "clear-capture",
			sessionId: "clear-session",
			requestId: "clear-request",
			sequence: 0,
			expectedStartOffset: 0,
			bytes: [1, 2, 1, 2]
		});
		const finalized = service.finalizeSession({ captureId: "clear-capture", sessionId: "clear-session", expectedDataRevision: append.dataRevision });
		seedAnalysisAndAnnotations(database, service, "clear-capture", finalized.profileId);
		const before = service.getCaptureState("clear-capture");
		const draftRowsBefore = database.prepare("SELECT revision, sections_json FROM framing_drafts WHERE capture_id = 'clear-capture' ORDER BY revision").all();
		const secondBefore = recordCapture(service, "clear-other", [9, 8]);
		const secondStateBefore = service.getCaptureState("clear-other");

		const cleared = service.clearCaptureData({ captureId: "clear-capture" });
		assert.deepEqual(cleared, {
			captureId: "clear-capture",
			dataRevision: before.dataRevision + 1,
			contentRevision: before.contentRevision + 1,
			clearedByteCount: 4
		});
		const after = service.getCaptureState("clear-capture");
		assert.equal(after.name, before.name);
		assert.equal(after.description, before.description);
		assert.equal(after.controllerView, before.controllerView);
		assert.equal(after.baudRate, before.baudRate);
		assert.equal(after.inputFormat, before.inputFormat);
		assert.equal(after.folderId, before.folderId);
		assert.deepEqual(after.parameters, before.parameters);
		assert.deepEqual(after.draft, service.getCaptureState("clear-capture").draft);
		assert.deepEqual(database.prepare("SELECT revision, sections_json FROM framing_drafts WHERE capture_id = 'clear-capture' ORDER BY revision").all(), draftRowsBefore);
		assert.equal(after.metadataRevision, before.metadataRevision);
		assert.equal(after.dataRevision, before.dataRevision + 1);
		assert.equal(after.contentRevision, before.contentRevision + 1);
		assert.equal(after.byteCount, 0);
		assert.equal(after.retainedStartOffset, 0);
		assert.equal(after.lifecycle, "finalized");
		assert.equal(after.activeProfile, null);
		assert.deepEqual(after.notes.map(note => note.text), ["capture note"]);
		assert.equal(count(database, "raw_chunks", "clear-capture"), 0);
		assert.equal(count(database, "raw_chunk_requests", "clear-capture"), 0);
		assert.equal(count(database, "capture_sessions", "clear-capture"), 0);
		assert.equal(count(database, "framing_profiles", "clear-capture"), 0);
		assert.equal(count(database, "framing_sections", "clear-capture"), 0);
		assert.equal(count(database, "materialized_frames", "clear-capture"), 0);
		assert.equal(count(database, "sequence_groups", "clear-capture"), 0);
		assert.equal(count(database, "stable_notes", "clear-capture"), 1);
		assert.equal(count(database, "raw_byte_visibility", "clear-capture"), 0);
		assert.equal(count(database, "frame_visibility", "clear-capture"), 0);
		assert.equal(count(database, "finalization_jobs", "clear-capture"), 0);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sequence_occurrences").get() as { count: number }).count, 0);
		for (const table of ["frame_signatures", "frame_transitions", "byte_statistics", "bit_statistics"]) assert.equal(countProfileRows(database, table, "clear-capture"), 0, table);
		assert.deepEqual(service.getCaptureState("clear-other"), secondStateBefore);
		assert.equal(secondBefore.profileId, secondStateBefore.activeProfile?.id);

		service.createCapture({ captureId: "atomic-clear", framing, inputFormat: "binary" });
		service.startSession({ captureId: "atomic-clear", sessionId: "atomic-session" });
		service.appendChunk({ captureId: "atomic-clear", sessionId: "atomic-session", requestId: "atomic-request", sequence: 0, expectedStartOffset: 0, bytes: [1] });
		service.finalizeSession({ captureId: "atomic-clear", sessionId: "atomic-session" });
		const atomicBefore = service.getCaptureState("atomic-clear");
		database.exec("CREATE TRIGGER fail_clear_update BEFORE UPDATE OF byte_count ON captures WHEN NEW.id = 'atomic-clear' BEGIN SELECT RAISE(ABORT, 'fail clear'); END");
		assert.throws(() => service.clearCaptureData({ captureId: "atomic-clear" }), /fail clear/);
		database.exec("DROP TRIGGER fail_clear_update");
		assert.deepEqual(service.getCaptureState("atomic-clear"), atomicBefore);
	} finally {
		database.close();
	}
});

test("clearCaptureData rejects recording and finalizing sessions without changing state or data", () => {
	const database = openDatabase(":memory:");
	try {
		const service = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-09T00:00:00.000Z" });
		for (const [captureId, activeStatus] of [["clear-recording", "recording"], ["clear-finalizing", "finalizing"]] as const) {
			const sessionId = `${captureId}-session`;
			service.createCapture({ captureId, framing, inputFormat: "binary" });
			service.startSession({ captureId, sessionId });
			service.appendChunk({
				captureId,
				sessionId,
				requestId: `${captureId}-request`,
				sequence: 0,
				expectedStartOffset: 0,
				bytes: [1, 2, 3]
			});
			if (activeStatus === "finalizing") {
				database
					.prepare("UPDATE capture_sessions SET status = 'finalizing' WHERE capture_id = @captureId AND id = @sessionId")
					.run({ captureId, sessionId });
				database
					.prepare("UPDATE captures SET lifecycle = 'stopped' WHERE id = @captureId")
					.run({ captureId });
				database
					.prepare(
						`INSERT INTO finalization_jobs
							(id, capture_id, session_id, profile_id, source_data_revision, status, created_at, updated_at, error, verified)
						 VALUES (@id, @captureId, @sessionId, NULL, 1, 'running', @now, @now, NULL, 0)`
					)
					.run({ id: `${captureId}-job`, captureId, sessionId, now: "2026-08-09T00:00:00.000Z" });
			}

			const before = service.getCaptureState(captureId);
			const chunksBefore = database
				.prepare("SELECT * FROM raw_chunks WHERE capture_id = @captureId ORDER BY chunk_index")
				.all({ captureId });
			const requestsBefore = database
				.prepare("SELECT * FROM raw_chunk_requests WHERE capture_id = @captureId ORDER BY sequence")
				.all({ captureId });
			const jobsBefore = database
				.prepare("SELECT * FROM finalization_jobs WHERE capture_id = @captureId ORDER BY id")
				.all({ captureId });

			assert.throws(
				() => service.clearCaptureData({ captureId }),
				(error: unknown) => {
					if (!(error instanceof CanonicalCaptureConflictError)) return false;
					return error.details.captureId === captureId
						&& error.details.activeSessionId === sessionId
						&& error.details.activeSessionStatus === activeStatus;
				}
			);
			assert.deepEqual(service.getCaptureState(captureId), before);
			assert.deepEqual(database.prepare("SELECT * FROM raw_chunks WHERE capture_id = @captureId ORDER BY chunk_index").all({ captureId }), chunksBefore);
			assert.deepEqual(database.prepare("SELECT * FROM raw_chunk_requests WHERE capture_id = @captureId ORDER BY sequence").all({ captureId }), requestsBefore);
			assert.deepEqual(database.prepare("SELECT * FROM finalization_jobs WHERE capture_id = @captureId ORDER BY id").all({ captureId }), jobsBefore);
		}
	} finally {
		database.close();
	}
});

test("duplicateCapture makes an idempotent full canonical copy with remapped identities", () => {
	const database = openDatabase(":memory:");
	try {
		const service = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-09T00:00:00.000Z" });
		const finalized = recordCapture(service, "duplicate-source");
		seedAnalysisAndAnnotations(database, service, "duplicate-source", finalized.profileId);
		const source = service.getCaptureState("duplicate-source");
		captureDocumentRow(database, "duplicate-source");
		database
			.prepare(
				`INSERT INTO capture_backups (capture_id, document_json, migrated_at, verified)
				 VALUES ('duplicate-source', '{"id":"duplicate-source"}', '2026-08-09T00:00:00.000Z', 1)`
			)
			.run();

		const copied = service.duplicateCapture({ captureId: "duplicate-source", duplicateCaptureId: "duplicate-copy" });
		assert.deepEqual(copied, {
			sourceCaptureId: "duplicate-source",
			captureId: "duplicate-copy",
			name: "duplicate-source name · copy",
			dataRevision: source.dataRevision,
			metadataRevision: source.metadataRevision,
			contentRevision: source.contentRevision
		});
		const retry = service.duplicateCapture({ captureId: "duplicate-source", duplicateCaptureId: "duplicate-copy" });
		assert.deepEqual(retry, copied);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM captures WHERE id = 'duplicate-copy'").get() as { count: number }).count, 1);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM capture_documents WHERE id = 'duplicate-copy'").get() as { count: number }).count, 0);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM capture_backups WHERE capture_id = 'duplicate-copy'").get() as { count: number }).count, 0);
		assert.deepEqual(service.getCaptureState("duplicate-copy").parameters, source.parameters);
		assert.equal(count(database, "raw_chunks", "duplicate-copy"), count(database, "raw_chunks", "duplicate-source"));
		assert.equal(count(database, "raw_chunk_requests", "duplicate-copy"), count(database, "raw_chunk_requests", "duplicate-source"));
		assert.equal(count(database, "capture_sessions", "duplicate-copy"), count(database, "capture_sessions", "duplicate-source"));
		assert.equal(count(database, "framing_profiles", "duplicate-copy"), count(database, "framing_profiles", "duplicate-source"));
		assert.equal(count(database, "framing_sections", "duplicate-copy"), count(database, "framing_sections", "duplicate-source"));
		assert.equal(count(database, "materialized_frames", "duplicate-copy"), count(database, "materialized_frames", "duplicate-source"));
		assert.equal(count(database, "sequence_groups", "duplicate-copy"), count(database, "sequence_groups", "duplicate-source"));
		assert.equal(count(database, "stable_notes", "duplicate-copy"), count(database, "stable_notes", "duplicate-source"));
		assert.equal(count(database, "raw_byte_visibility", "duplicate-copy"), count(database, "raw_byte_visibility", "duplicate-source"));
		assert.equal(count(database, "frame_visibility", "duplicate-copy"), count(database, "frame_visibility", "duplicate-source"));
		assert.equal(count(database, "finalization_jobs", "duplicate-copy"), count(database, "finalization_jobs", "duplicate-source"));
		for (const table of ["frame_signatures", "frame_transitions", "byte_statistics", "bit_statistics"]) {
			assert.equal(countProfileRows(database, table, "duplicate-copy"), countProfileRows(database, table, "duplicate-source"), table);
		}
		assert.equal(
			(database.prepare("SELECT COUNT(*) AS count FROM sequence_occurrences WHERE group_id IN (SELECT id FROM sequence_groups WHERE capture_id = 'duplicate-copy')").get() as { count: number }).count,
			(database.prepare("SELECT COUNT(*) AS count FROM sequence_occurrences WHERE group_id IN (SELECT id FROM sequence_groups WHERE capture_id = 'duplicate-source')").get() as { count: number }).count
		);

		const idSets = [
			["framing_profiles", "id"],
			["framing_sections", "id"],
			["materialized_frames", "id"],
			["capture_sessions", "id"],
			["stable_notes", "id"],
			["sequence_groups", "id"],
			["finalization_jobs", "id"]
		] as const;
		for (const [table, column] of idSets) {
			const sourceIds = new Set((database.prepare(`SELECT ${column} AS id FROM ${table} WHERE capture_id = 'duplicate-source'`).all() as Array<{ id: string }>).map(row => row.id));
			const copyIds = new Set((database.prepare(`SELECT ${column} AS id FROM ${table} WHERE capture_id = 'duplicate-copy'`).all() as Array<{ id: string }>).map(row => row.id));
			assert.equal([...copyIds].some(id => sourceIds.has(id)), false, table);
		}
		const sourceProfileIds = new Set((database.prepare("SELECT id FROM framing_profiles WHERE capture_id = 'duplicate-source'").all() as Array<{ id: string }>).map(row => row.id));
		const copyProfileIds = new Set((database.prepare("SELECT id FROM framing_profiles WHERE capture_id = 'duplicate-copy'").all() as Array<{ id: string }>).map(row => row.id));
		assert.deepEqual(
			(database.prepare("SELECT DISTINCT profile_id FROM frame_visibility WHERE capture_id = 'duplicate-copy'").all() as Array<{ profile_id: string }>).map(row => copyProfileIds.has(row.profile_id)),
			[true]
		);
		assert.equal([...copyProfileIds].some(id => sourceProfileIds.has(id)), false);
		assert.deepEqual(
			(database.prepare("SELECT bytes, timestamps_json, directions_json, hidden_json FROM raw_chunks WHERE capture_id = 'duplicate-copy' ORDER BY chunk_index").all() as Array<{ bytes: Buffer; timestamps_json: string; directions_json: string; hidden_json: string }>).map(row => ({ bytes: [...row.bytes], timestamps_json: row.timestamps_json, directions_json: row.directions_json, hidden_json: row.hidden_json })),
			(database.prepare("SELECT bytes, timestamps_json, directions_json, hidden_json FROM raw_chunks WHERE capture_id = 'duplicate-source' ORDER BY chunk_index").all() as Array<{ bytes: Buffer; timestamps_json: string; directions_json: string; hidden_json: string }>).map(row => ({ bytes: [...row.bytes], timestamps_json: row.timestamps_json, directions_json: row.directions_json, hidden_json: row.hidden_json }))
		);

		service.createCapture({ captureId: "duplicate-other", framing, inputFormat: "binary" });
		assert.throws(
			() => service.duplicateCapture({ captureId: "duplicate-other", duplicateCaptureId: "duplicate-copy" }),
			(error: unknown) => error instanceof CanonicalCaptureIdempotencyConflictError
		);
	} finally {
		database.close();
	}
});

test("duplicateCapture preserves historical profile metadata snapshots", () => {
	const database = openDatabase(":memory:");
	try {
		const service = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-09T00:00:00.000Z" });
		const firstProfile = recordCapture(service, "duplicate-history");
		service.patchMetadata({
			captureId: "duplicate-history",
			expectedMetadataRevision: 0,
			patch: {
				name: "historical profile two",
				description: "description for profile two",
				parameters: [{ key: "mode", value: "historical" }]
			}
		});
		const secondProfile = service.reframe({
			captureId: "duplicate-history",
			expectedActiveProfileId: firstProfile.profileId,
			expectedDataRevision: firstProfile.dataRevision,
			sections: [{ start: 0, framingMode: "length", frameSize: 1 }],
			algorithmVersion: 2
		});
		service.patchMetadata({
			captureId: "duplicate-history",
			expectedMetadataRevision: 1,
			patch: {
				name: "latest capture metadata",
				description: "latest description",
				parameters: [{ key: "mode", value: "latest" }, { key: "channel", value: "B" }]
			}
		});

		const snapshotFields = `snapshots.name, snapshots.description, snapshots.controller_view, snapshots.baud_rate,
			snapshots.input_format, snapshots.lifecycle, snapshots.byte_count, snapshots.folder_id,
			snapshots.data_revision, snapshots.metadata_revision, snapshots.content_revision,
			snapshots.retained_start_offset, snapshots.parameters_json, snapshots.created_at`;
		const sourceSnapshots = database
			.prepare(
				`SELECT profiles.version, snapshots.profile_id, snapshots.capture_id, ${snapshotFields}
				 FROM framing_profile_metadata_snapshots AS snapshots
				 JOIN framing_profiles AS profiles ON profiles.id = snapshots.profile_id
				 WHERE snapshots.capture_id = 'duplicate-history'
				 ORDER BY profiles.version`
			)
			.all() as Array<Record<string, unknown>>;
		assert.equal(sourceSnapshots.length, 2);
		assert.equal(sourceSnapshots[0]?.profile_id, firstProfile.profileId);
		assert.equal(sourceSnapshots[1]?.profile_id, secondProfile.profileId);
		assert.equal(sourceSnapshots[0]?.name, "duplicate-history name");
		assert.equal(sourceSnapshots[1]?.name, "historical profile two");

		service.duplicateCapture({ captureId: "duplicate-history", duplicateCaptureId: "duplicate-history-copy" });
		const copiedSnapshots = database
			.prepare(
				`SELECT profiles.version, snapshots.profile_id, snapshots.capture_id, ${snapshotFields}
				 FROM framing_profile_metadata_snapshots AS snapshots
				 JOIN framing_profiles AS profiles ON profiles.id = snapshots.profile_id
				 WHERE snapshots.capture_id = 'duplicate-history-copy'
				 ORDER BY profiles.version`
			)
			.all() as Array<Record<string, unknown>>;
		assert.equal(copiedSnapshots.length, sourceSnapshots.length);
		assert.deepEqual(
			copiedSnapshots.map(({ profile_id: _profileId, capture_id: _captureId, ...snapshot }) => snapshot),
			sourceSnapshots.map(({ profile_id: _profileId, capture_id: _captureId, ...snapshot }) => snapshot)
		);
		assert.deepEqual(copiedSnapshots.map(snapshot => snapshot.capture_id), ["duplicate-history-copy", "duplicate-history-copy"]);
		assert.notEqual(copiedSnapshots[0]?.profile_id, sourceSnapshots[0]?.profile_id);
		assert.notEqual(copiedSnapshots[1]?.profile_id, sourceSnapshots[1]?.profile_id);
	} finally {
		database.close();
	}
});

test("duplicateCapture rejects active sources and allows a finalized copy to start a new session", () => {
	const database = openDatabase(":memory:");
	try {
		const service = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-09T00:00:00.000Z" });
		service.createCapture({ captureId: "duplicate-recording", framing, inputFormat: "binary" });
		service.startSession({ captureId: "duplicate-recording", sessionId: "recording-session" });
		service.appendChunk({
			captureId: "duplicate-recording",
			sessionId: "recording-session",
			requestId: "recording-request",
			sequence: 0,
			expectedStartOffset: 0,
			bytes: [1, 2]
		});

		assert.throws(
			() => service.duplicateCapture({ captureId: "duplicate-recording", duplicateCaptureId: "duplicate-recording-copy" }),
			(error: unknown) =>
				error instanceof CanonicalCaptureConflictError &&
					error.message === "capture must be finalized before duplication" &&
					error.details.captureId === "duplicate-recording" &&
					error.details.lifecycle === "recording"
		);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM captures WHERE id = 'duplicate-recording-copy'").get() as { count: number }).count, 0);

		const append = service.appendChunk({
			captureId: "duplicate-recording",
			sessionId: "recording-session",
			requestId: "recording-request-2",
			sequence: 1,
			expectedStartOffset: 2,
			bytes: [3, 4]
		});
		service.finalizeSession({ captureId: "duplicate-recording", sessionId: "recording-session", expectedDataRevision: append.dataRevision });

		service.duplicateCapture({ captureId: "duplicate-recording", duplicateCaptureId: "duplicate-recording-copy" });
		const copy = service.getCaptureState("duplicate-recording-copy");
		assert.equal(copy.lifecycle, "finalized");
		assert.deepEqual(copy.sessions.map(session => session.status), ["finalized"]);

		const newSession = service.startSession({ captureId: "duplicate-recording-copy", sessionId: "copy-session" });
		assert.equal(newSession.session.status, "recording");
		assert.equal(newSession.session.id, "copy-session");
		assert.equal(newSession.session.ordinal, 1);
		assert.equal(newSession.session.nextRawOffset, copy.byteCount);
	} finally {
		database.close();
	}
});

test("deleteCapture removes only the canonical target, cascade children, storage, and archive ordering", () => {
	const database = openDatabase(":memory:");
	try {
		const service = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-09T00:00:00.000Z" });
		const deleted = recordCapture(service, "delete-target");
		seedAnalysisAndAnnotations(database, service, "delete-target", deleted.profileId);
		const remaining = recordCapture(service, "delete-remaining", [7, 8]);
		captureDocumentRow(database, "delete-target");
		captureDocumentRow(database, "delete-remaining");
		database
			.prepare("INSERT INTO capture_backups (capture_id, document_json, migrated_at, verified) VALUES ('delete-target', '{\"id\":\"delete-target\"}', '2026-08-09T00:00:00.000Z', 1)")
			.run();
		database
			.prepare("INSERT INTO archive_order (entity_type, entity_id, folder_id, position) VALUES ('capture', 'delete-target', 'folder-1', 0), ('capture', 'delete-remaining', 'folder-1', 1)")
			.run();
		database
			.prepare("INSERT INTO archive_state (singleton, active_capture_id, unfiled_collapsed, updated_at) VALUES (1, 'delete-target', 0, '2026-08-09T00:00:00.000Z')")
			.run();
		const remainingBefore = service.getCaptureState("delete-remaining");

		assert.deepEqual(service.deleteCapture("delete-target"), { captureId: "delete-target", deleted: true });
		assert.throws(() => service.getCaptureState("delete-target"));
		for (const table of ["captures", "capture_storage", "raw_chunks", "raw_chunk_requests", "capture_sessions", "framing_profiles", "framing_sections", "materialized_frames", "sequence_groups", "stable_notes", "raw_byte_visibility", "frame_visibility", "finalization_jobs", "capture_documents", "capture_backups"]) {
			const idColumn = table === "captures" || table === "capture_documents" ? "id" : "capture_id";
			assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${idColumn} = 'delete-target'`).get() as { count: number }).count, 0, table);
		}
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM archive_order WHERE entity_type = 'capture' AND entity_id = 'delete-target'").get() as { count: number }).count, 0);
		assert.equal((database.prepare("SELECT active_capture_id FROM archive_state WHERE singleton = 1").get() as { active_capture_id: string | null }).active_capture_id, null);
		assert.deepEqual(service.getCaptureState("delete-remaining"), remainingBefore);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM archive_order WHERE entity_type = 'capture' AND entity_id = 'delete-remaining'").get() as { count: number }).count, 1);
		assert.equal((database.prepare("SELECT status FROM capture_storage WHERE capture_id = 'delete-remaining'").get() as { status: string }).status, "canonical");
		assert.equal(count(database, "raw_chunks", "delete-remaining"), 1);
	} finally {
		database.close();
	}
});

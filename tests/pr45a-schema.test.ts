import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, openDatabase, runMigrations } from "../server/database.ts";

const now = "2026-08-09T00:00:00.000Z";

function columns(database: ReturnType<typeof openDatabase>, table: string): Set<string> {
	return new Set(
		(database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name)
	);
}

function createV4Database(): InstanceType<typeof Database> {
	const database = new Database(":memory:");
	database.pragma("foreign_keys = ON");
	database.exec(`
		CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);
		INSERT INTO schema_migrations (version, applied_at) VALUES
			(1, '${now}'), (2, '${now}'), (3, '${now}'), (4, '${now}');

		CREATE TABLE capture_documents (
			id TEXT PRIMARY KEY NOT NULL,
			document_version INTEGER NOT NULL DEFAULT 1,
			document_json TEXT NOT NULL CHECK (json_valid(document_json)),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE capture_backups (
			capture_id TEXT PRIMARY KEY NOT NULL,
			document_json TEXT NOT NULL CHECK (json_valid(document_json)),
			migrated_at TEXT NOT NULL,
			verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
			verification_report_json TEXT CHECK (verification_report_json IS NULL OR json_valid(verification_report_json))
		);
		CREATE TABLE captures (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT NOT NULL DEFAULT 'Untitled capture',
			lifecycle TEXT NOT NULL DEFAULT 'finalized' CHECK (lifecycle IN ('recording','stopped','finalized','failed')),
			byte_count INTEGER NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			folder_id TEXT,
			active_framing_profile_id TEXT
		);
		CREATE TABLE raw_chunks (
			capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
			chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
			start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
			byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
			bytes BLOB NOT NULL,
			timestamps_json TEXT NOT NULL CHECK (json_valid(timestamps_json)),
			directions_json TEXT NOT NULL CHECK (json_valid(directions_json)),
			hidden_json TEXT NOT NULL CHECK (json_valid(hidden_json)),
			session_id TEXT,
			session_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(session_ids_json)),
			PRIMARY KEY (capture_id, chunk_index)
		);
		CREATE TABLE framing_profiles (
			id TEXT PRIMARY KEY NOT NULL,
			capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
			version INTEGER NOT NULL CHECK (version > 0),
			algorithm_version INTEGER NOT NULL DEFAULT 1,
			is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE (capture_id, version)
		);
		CREATE TABLE materialized_frames (
			id TEXT PRIMARY KEY NOT NULL,
			capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
			profile_id TEXT NOT NULL REFERENCES framing_profiles(id) ON DELETE CASCADE,
			profile_version INTEGER NOT NULL,
			ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
			section_id TEXT NOT NULL,
			raw_offsets_json TEXT NOT NULL CHECK (json_valid(raw_offsets_json)),
			bytes_json TEXT NOT NULL CHECK (json_valid(bytes_json)),
			timestamps_json TEXT NOT NULL CHECK (json_valid(timestamps_json)),
			directions_json TEXT NOT NULL CHECK (json_valid(directions_json)),
			hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
			signature TEXT NOT NULL,
			UNIQUE (profile_id, ordinal)
		);
		CREATE TABLE sequence_groups (
			id TEXT PRIMARY KEY NOT NULL,
			capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
			profile_id TEXT NOT NULL REFERENCES framing_profiles(id) ON DELETE CASCADE,
			key_text TEXT NOT NULL,
			signatures_json TEXT NOT NULL CHECK (json_valid(signatures_json)),
			score INTEGER NOT NULL CHECK (score > 0),
			length INTEGER NOT NULL CHECK (length > 0)
		);
		CREATE TABLE stable_notes (
			id TEXT PRIMARY KEY NOT NULL,
			capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
			text TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT,
			target_kind TEXT NOT NULL CHECK (target_kind IN ('capture','byte','frame','sequence','pattern','legacy-sequence')),
			raw_offset INTEGER CHECK (raw_offset >= 0),
			profile_id TEXT REFERENCES framing_profiles(id) ON DELETE SET NULL,
			raw_offsets_json TEXT CHECK (raw_offsets_json IS NULL OR json_valid(raw_offsets_json)),
			start_offset INTEGER CHECK (start_offset >= 0),
			end_offset INTEGER CHECK (end_offset >= 0),
			sequence_key TEXT,
			start_row INTEGER,
			end_row INTEGER,
			message_id TEXT,
			byte_position INTEGER CHECK (byte_position >= 0)
		);
		CREATE TABLE finalization_jobs (
			id TEXT PRIMARY KEY NOT NULL,
			capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
			status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			error TEXT,
			verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1))
		);
		CREATE TABLE capture_sessions (
			capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
			ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
			id TEXT NOT NULL,
			first_received_at REAL,
			last_received_at REAL,
			PRIMARY KEY (capture_id, ordinal),
			UNIQUE (capture_id, id)
		);
	`);
	return database;
}

test("empty databases receive the canonical command schema and enforce its invariants", () => {
	const database = openDatabase(":memory:", () => now);
	try {
		assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
		assert.deepEqual(
			[
				"capture_storage",
				"capture_parameters",
				"raw_chunk_requests",
				"framing_drafts",
				"raw_byte_visibility",
				"frame_visibility"
			].map(table => database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)),
			Array.from({ length: 6 }, () => ({ 1: 1 }))
		);

		for (const [table, expected] of Object.entries({
			captures: [
				"description",
				"controller_view",
				"baud_rate",
				"input_format",
				"data_revision",
					"metadata_revision",
					"content_revision",
					"retained_start_offset",
					"create_request_hash"
			],
			capture_sessions: ["status", "started_at", "finalized_at", "next_chunk_sequence", "next_raw_offset"],
			framing_profiles: ["source_data_revision", "retained_start_offset", "verified"],
			finalization_jobs: [
				"session_id",
				"profile_id",
				"data_revision",
				"attempt_count",
				"next_attempt_at",
				"lease_token",
				"lease_expires_at",
				"started_at",
				"completed_at"
			]
		})) {
			for (const column of expected) assert.ok(columns(database, table).has(column), `${table}.${column}`);
		}

		database.prepare(`
			INSERT INTO captures
				(id, name, lifecycle, byte_count, created_at, updated_at, active_framing_profile_id,
				 description, controller_view, baud_rate, input_format, create_request_hash)
				VALUES ('capture-1', 'Capture', 'recording', 0, @now, @now, NULL, 'desc', 'monitor', 115200, 'text', 'create-1')
		`).run({ now });
		database.prepare(`
			INSERT INTO framing_profiles
			(id, capture_id, version, created_at, updated_at, source_data_revision, retained_start_offset, verified)
			VALUES ('profile-1', 'capture-1', 1, @now, @now, 0, 0, 1)
		`).run({ now });
		database.prepare(`
			INSERT INTO capture_parameters (capture_id, position, key_text, value_text)
			VALUES ('capture-1', 0, 'Mode', 'safe')
		`).run();
		database.prepare(`
			INSERT INTO capture_sessions
			(capture_id, ordinal, id, status, started_at, next_chunk_sequence, next_raw_offset)
			VALUES ('capture-1', 0, 'session-1', 'recording', @now, 4, 8)
		`).run({ now });
		database.prepare(`
			INSERT INTO raw_chunk_requests
			(capture_id, request_id, session_id, sequence, expected_start_offset, payload_hash,
			 accepted_start_offset, accepted_end_offset, next_raw_offset, next_sequence, data_revision, created_at)
			VALUES ('capture-1', 'request-1', 'session-1', 0, 0, 'payload-1', 0, 2, 2, 1, 1, @now)
		`).run({ now });
		database.prepare(`
			INSERT INTO framing_drafts (capture_id, revision, sections_json, updated_at)
			VALUES ('capture-1', 0, '[{"mode":"length"}]', @now)
		`).run({ now });
		database.prepare(`
			INSERT INTO raw_byte_visibility (capture_id, raw_offset, hidden)
			VALUES ('capture-1', 6, 1)
		`).run();
		database.prepare(`
			INSERT INTO frame_visibility (capture_id, profile_id, start_raw_offset, end_raw_offset, hidden)
			VALUES ('capture-1', 'profile-1', 0, 1, 1)
		`).run();
		database.prepare(`
			INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind, start_offset, end_offset)
			VALUES ('range-note', 'capture-1', 'range', @now, 'range', 2, 6)
		`).run({ now });
		database.prepare(`
			INSERT INTO finalization_jobs
			(id, capture_id, status, created_at, updated_at, session_id, profile_id, data_revision, attempt_count, lease_token)
			VALUES ('job-1', 'capture-1', 'pending', @now, @now, 'session-1', 'profile-1', 0, 1, 'lease-1')
		`).run({ now });
		database.prepare(`
			INSERT INTO capture_storage (capture_id, status, created_at, updated_at, last_error)
			VALUES ('capture-1', 'canonical', @now, @now, NULL)
		`).run({ now });

		assert.throws(() =>
			database.prepare("INSERT INTO capture_storage (capture_id, status, created_at, updated_at, last_error) VALUES ('bad', 'unknown', ?, ?, NULL)").run(now, now)
		);
		assert.throws(() => database.prepare("INSERT INTO captures (id, created_at, updated_at, baud_rate) VALUES ('bad-baud', ?, ?, 0)").run(now, now));
		assert.throws(() => database.prepare(`
			INSERT INTO raw_chunk_requests
			(capture_id, request_id, session_id, sequence, expected_start_offset, payload_hash,
			 accepted_start_offset, accepted_end_offset, next_raw_offset, next_sequence, data_revision, created_at)
			VALUES ('capture-1', 'request-1', 'session-1', 0, 0, 'different', 0, 2, 2, 1, 1, '${now}')
		`).run());
		assert.throws(() => database.prepare("INSERT INTO framing_drafts (capture_id, revision, sections_json, updated_at) VALUES ('capture-1', 1, 'not-json', ?)").run(now));
		assert.throws(() => database.prepare("INSERT INTO raw_byte_visibility (capture_id, raw_offset, hidden) VALUES ('capture-1', 1, 2)").run());
		assert.throws(() => database.prepare("INSERT INTO frame_visibility (capture_id, profile_id, start_raw_offset, end_raw_offset) VALUES ('capture-1', 'missing-profile', 0, 0)").run());
		assert.throws(() => database.prepare("INSERT INTO capture_parameters (capture_id, position, key_text, value_text) VALUES ('capture-1', 0, 'duplicate', 'value')").run());
	} finally {
		database.close();
	}
});

test("databases that recorded the published v13 migration remain supported", () => {
	const database = new Database(":memory:");
	try {
		database.exec(`
			CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);
			INSERT INTO schema_migrations (version, applied_at) VALUES (13, '${now}');
		`);

		assert.doesNotThrow(() => runMigrations(database, () => now));
		assert.equal(getSchemaVersion(database), 13);
	} finally {
		database.close();
	}
});

test("v4 migration backfills explicit authority and preserves stable notes", () => {
	const database = createV4Database();
	try {
			database.prepare(`
				INSERT INTO captures
				(id, name, lifecycle, byte_count, created_at, updated_at, folder_id, active_framing_profile_id)
				VALUES
				('canonical-1', 'Canonical', 'stopped', 2, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'folder-1', 'profile-1'),
				('canonical-2', 'Canonical two', 'finalized', 0, '2026-01-05T00:00:00.000Z', '2026-01-06T00:00:00.000Z', NULL, NULL)
		`).run();
		database.prepare(`
			INSERT INTO capture_documents (id, document_json, created_at, updated_at)
			VALUES
				('canonical-1', @canonical, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
				('canonical-2', @canonicalTwo, '2026-01-05T00:00:00.000Z', '2026-01-06T00:00:00.000Z'),
				('legacy-1', @legacy, '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z')
		`).run({
			canonical: JSON.stringify({
				id: "canonical-1",
				description: "preserved description",
				view: "monitor",
				baudRate: 115200,
				inputFormat: "text",
				params: [{ key: "Mode", value: "safe" }, { key: "Port", value: "A" }]
			}),
			canonicalTwo: JSON.stringify({ id: "canonical-2", name: "Canonical two", params: [] }),
			legacy: JSON.stringify({ id: "legacy-1", name: "Legacy" })
		});
			database.prepare(`
			INSERT INTO capture_backups (capture_id, document_json, migrated_at, verified, verification_report_json)
			VALUES ('canonical-1', '{"recovery":"keep"}', '2026-01-02T00:00:00.000Z', 0, '{"source":"recovery"}')
		`).run();
		database.prepare(`
			INSERT INTO raw_chunks
			(capture_id, chunk_index, start_offset, byte_count, bytes, timestamps_json, directions_json, hidden_json, session_ids_json)
			VALUES ('canonical-1', 0, 10, 2, X'1020', '[1,2]', '["rx","rx"]', '[false,true]', '["session-1","session-1"]')
		`).run();
		database.prepare(`
			INSERT INTO framing_profiles (id, capture_id, version, is_active, created_at, updated_at)
			VALUES ('profile-1', 'canonical-1', 1, 1, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
		`).run();
		database.prepare(`
			INSERT INTO materialized_frames
			(id, capture_id, profile_id, profile_version, ordinal, section_id, raw_offsets_json, bytes_json, timestamps_json, directions_json, hidden, signature)
			VALUES ('frame-1', 'canonical-1', 'profile-1', 1, 0, 'section-1', '[10,11]', '[16,32]', '[1,2]', '["rx","rx"]', 1, '1020')
		`).run();
		database.prepare(`
			INSERT INTO capture_sessions (capture_id, ordinal, id, first_received_at, last_received_at)
			VALUES ('canonical-1', 0, 'session-1', 1, 2)
		`).run();
		database.prepare(`
			INSERT INTO stable_notes
			(id, capture_id, text, created_at, updated_at, target_kind, raw_offset, profile_id, raw_offsets_json, sequence_key, start_row, end_row, message_id, byte_position)
			VALUES
			('legacy-frame', 'canonical-1', 'frame note', @created, @updated, 'frame', NULL, 'profile-1', '[10,11]', NULL, NULL, NULL, 'message-1', NULL),
			('legacy-sequence', 'canonical-1', 'old sequence', @created, NULL, 'legacy-sequence', NULL, NULL, NULL, NULL, 2, 4, NULL, NULL),
			('legacy-pattern', 'canonical-1', 'old pattern', @created, NULL, 'pattern', NULL, NULL, NULL, 'AA BB', NULL, NULL, NULL, NULL)
		`).run({ created: now, updated: now });
		database.prepare(`
			INSERT INTO finalization_jobs (id, capture_id, status, created_at, updated_at, verified)
			VALUES ('job-1', 'canonical-1', 'completed', @created, @updated, 1)
		`).run({ created: now, updated: now });

		const beforeNotes = database
			.prepare("SELECT id, capture_id, text, created_at, updated_at, target_kind, raw_offset, profile_id, raw_offsets_json, sequence_key, start_row, end_row, message_id, byte_position FROM stable_notes ORDER BY id")
			.all();

		runMigrations(database, () => now);
		assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count, 2);
		assert.deepEqual(
			database.prepare("SELECT capture_id, status FROM capture_storage ORDER BY capture_id").all(),
			[
				{ capture_id: "canonical-1", status: "canonical" },
				{ capture_id: "canonical-2", status: "canonical" },
				{ capture_id: "legacy-1", status: "legacy-not-canonicalized" }
			]
		);
		assert.deepEqual(database.prepare("SELECT id FROM capture_documents ORDER BY id").all(), [{ id: "legacy-1" }]);
		assert.deepEqual(database.prepare("SELECT capture_id, verified FROM capture_backups ORDER BY capture_id").all(), [
			{ capture_id: "canonical-1", verified: 1 },
			{ capture_id: "canonical-2", verified: 1 }
		]);
		const preservedRecovery = database.prepare("SELECT document_json, verification_report_json FROM capture_backups WHERE capture_id = 'canonical-1'").get() as {
			document_json: string;
			verification_report_json: string | null;
		};
		assert.equal(JSON.parse(preservedRecovery.document_json).id, "canonical-1");
		assert.equal(JSON.parse(preservedRecovery.document_json).description, "preserved description");
		assert.equal(preservedRecovery.verification_report_json, null);
		const copiedBackup = database.prepare("SELECT document_json FROM capture_backups WHERE capture_id = 'canonical-2'").get() as { document_json: string };
		assert.deepEqual(JSON.parse(copiedBackup.document_json), { id: "canonical-2", name: "Canonical two", params: [] });

		assert.deepEqual(
			database.prepare("SELECT name, lifecycle, created_at, updated_at, folder_id, active_framing_profile_id, description, controller_view, baud_rate, input_format, data_revision, metadata_revision, content_revision, retained_start_offset FROM captures WHERE id = 'canonical-1'").get(),
			{
				name: "Canonical",
				lifecycle: "stopped",
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-02T00:00:00.000Z",
				folder_id: "folder-1",
				active_framing_profile_id: "profile-1",
				description: "preserved description",
				controller_view: "monitor",
				baud_rate: 115200,
				input_format: "text",
				data_revision: 1,
				metadata_revision: 1,
				content_revision: 1,
				retained_start_offset: 0
			}
		);
		assert.deepEqual(database.prepare("SELECT position, key_text, value_text FROM capture_parameters WHERE capture_id = 'canonical-1' ORDER BY position").all(), [
			{ position: 0, key_text: "Mode", value_text: "safe" },
			{ position: 1, key_text: "Port", value_text: "A" }
		]);
		assert.deepEqual(database.prepare("SELECT source_data_revision, retained_start_offset, verified FROM framing_profiles WHERE id = 'profile-1'").get(), {
			source_data_revision: 1,
			retained_start_offset: 0,
			verified: 1
		});
		assert.deepEqual(database.prepare("SELECT raw_offset, hidden FROM raw_byte_visibility WHERE capture_id = 'canonical-1' ORDER BY raw_offset").all(), [
			{ raw_offset: 10, hidden: 0 },
			{ raw_offset: 11, hidden: 1 }
		]);
		assert.deepEqual(database.prepare("SELECT start_raw_offset, end_raw_offset, hidden FROM frame_visibility WHERE profile_id = 'profile-1'").all(), [{ start_raw_offset: 10, end_raw_offset: 11, hidden: 1 }]);
		assert.deepEqual(database.prepare("SELECT status, next_chunk_sequence, next_raw_offset FROM capture_sessions WHERE capture_id = 'canonical-1'").get(), {
			status: "finalized",
			next_chunk_sequence: 0,
			next_raw_offset: 0
		});
		assert.deepEqual(database.prepare("SELECT attempt_count, data_revision, session_id, profile_id FROM finalization_jobs WHERE id = 'job-1'").get(), {
			attempt_count: 0,
			data_revision: 0,
			session_id: null,
			profile_id: null
		});

		assert.deepEqual(
			database
				.prepare("SELECT id, capture_id, text, created_at, updated_at, target_kind, raw_offset, profile_id, raw_offsets_json, sequence_key, start_row, end_row, message_id, byte_position FROM stable_notes ORDER BY id")
				.all(),
			beforeNotes
		);

		database.prepare(`
			INSERT INTO sequence_groups (id, capture_id, profile_id, key_text, signatures_json, score, length)
			VALUES ('group-1', 'canonical-1', 'profile-1', '1020', '["1020"]', 1, 1)
		`).run();
		database.prepare(`
			INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind, sequence_group_id)
			VALUES ('group-note', 'canonical-1', 'group', @created, 'sequence-group', 'group-1')
		`).run({ created: now });
		assert.equal((database.prepare("SELECT target_kind FROM stable_notes WHERE id = 'group-note'").get() as { target_kind: string }).target_kind, "sequence-group");

		const authorityCount = (database.prepare("SELECT COUNT(*) AS count FROM capture_storage").get() as { count: number }).count;
		const noteCount = (database.prepare("SELECT COUNT(*) AS count FROM stable_notes").get() as { count: number }).count;
		runMigrations(database, () => "2026-08-10T00:00:00.000Z");
		assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM capture_storage").get() as { count: number }).count, authorityCount);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM stable_notes").get() as { count: number }).count, noteCount);
		assert.deepEqual(database.pragma("foreign_key_check"), []);
	} finally {
		database.close();
	}
});

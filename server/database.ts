import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type SqliteDatabase = InstanceType<typeof Database>;
export const CURRENT_SCHEMA_VERSION = 10;

type Migration = {
	version: number;
	up: (database: SqliteDatabase) => void;
};

const migrations: Migration[] = [
	{
		version: 1,
		up: database => {
			database.exec(`
				CREATE TABLE IF NOT EXISTS capture_documents (
					id TEXT PRIMARY KEY NOT NULL,
					document_version INTEGER NOT NULL DEFAULT 1,
					document_json TEXT NOT NULL CHECK (json_valid(document_json)),
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);

				CREATE INDEX IF NOT EXISTS capture_documents_updated_at
					ON capture_documents (updated_at DESC);

				CREATE TABLE IF NOT EXISTS folders (
					id TEXT PRIMARY KEY NOT NULL,
					document_version INTEGER NOT NULL DEFAULT 1,
					document_json TEXT NOT NULL CHECK (json_valid(document_json)),
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);

				CREATE TABLE IF NOT EXISTS archive_order (
					entity_type TEXT NOT NULL CHECK (entity_type IN ('capture', 'folder')),
					entity_id TEXT NOT NULL,
					folder_id TEXT,
					position INTEGER NOT NULL DEFAULT 0,
					PRIMARY KEY (entity_type, entity_id)
				);

				CREATE INDEX IF NOT EXISTS archive_order_folder_position
					ON archive_order (entity_type, folder_id, position);

				CREATE TABLE IF NOT EXISTS archive_state (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					active_capture_id TEXT,
					unfiled_collapsed INTEGER NOT NULL DEFAULT 0 CHECK (unfiled_collapsed IN (0, 1)),
					updated_at TEXT NOT NULL
				);

				CREATE TABLE IF NOT EXISTS send_queue (
					id TEXT PRIMARY KEY NOT NULL,
					document_version INTEGER NOT NULL DEFAULT 1,
					document_json TEXT NOT NULL CHECK (json_valid(document_json)),
					position INTEGER NOT NULL DEFAULT 0,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);

				CREATE INDEX IF NOT EXISTS send_queue_position
					ON send_queue (position, created_at);

				CREATE TABLE IF NOT EXISTS send_history (
					id TEXT PRIMARY KEY NOT NULL,
					document_version INTEGER NOT NULL DEFAULT 1,
					document_json TEXT NOT NULL CHECK (json_valid(document_json)),
					occurred_at TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);

				CREATE INDEX IF NOT EXISTS send_history_occurred_at
					ON send_history (occurred_at DESC, created_at DESC);

				CREATE TABLE IF NOT EXISTS application_settings (
					key TEXT PRIMARY KEY NOT NULL,
					value_json TEXT NOT NULL CHECK (json_valid(value_json)),
					updated_at TEXT NOT NULL
				);

				CREATE TABLE IF NOT EXISTS import_migrations (
					fingerprint TEXT PRIMARY KEY NOT NULL,
					source_key TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
					report_json TEXT NOT NULL CHECK (json_valid(report_json)),
					created_at TEXT NOT NULL,
					completed_at TEXT
				);
			`);
		}
	},
	{
		version: 2,
		up: database => {
			database.exec(`
				-- Canonical captures: durable lifecycle and byte counts
				CREATE TABLE IF NOT EXISTS captures (
					id TEXT PRIMARY KEY NOT NULL,
					name TEXT NOT NULL DEFAULT 'Untitled capture',
					lifecycle TEXT NOT NULL DEFAULT 'finalized' CHECK (lifecycle IN ('recording','stopped','finalized','failed')),
					byte_count INTEGER NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					folder_id TEXT,
					active_framing_profile_id TEXT
				);
				CREATE INDEX IF NOT EXISTS captures_lifecycle ON captures (lifecycle);
				CREATE INDEX IF NOT EXISTS captures_updated_at ON captures (updated_at DESC);

				-- Immutable raw chunks: absolute raw offsets never change
				CREATE TABLE IF NOT EXISTS raw_chunks (
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					chunk_index INTEGER NOT NULL,
					start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
					byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
					bytes BLOB NOT NULL,
					timestamps_json TEXT NOT NULL CHECK (json_valid(timestamps_json)),
					directions_json TEXT NOT NULL CHECK (json_valid(directions_json)),
					hidden_json TEXT NOT NULL CHECK (json_valid(hidden_json)),
					session_id TEXT,
					PRIMARY KEY (capture_id, chunk_index)
				);
				CREATE INDEX IF NOT EXISTS raw_chunks_capture_offset ON raw_chunks (capture_id, start_offset);

				-- Versioned framing profiles (algorithmVersion tracks domain engine)
				CREATE TABLE IF NOT EXISTS framing_profiles (
					id TEXT PRIMARY KEY NOT NULL,
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					version INTEGER NOT NULL CHECK (version > 0),
					algorithm_version INTEGER NOT NULL DEFAULT 1,
					is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					UNIQUE (capture_id, version)
				);
				CREATE INDEX IF NOT EXISTS framing_profiles_capture_active ON framing_profiles (capture_id, is_active);

				-- Frame-length / marker / time sections per profile
				CREATE TABLE IF NOT EXISTS framing_sections (
					id TEXT PRIMARY KEY NOT NULL,
					profile_id TEXT NOT NULL REFERENCES framing_profiles(id) ON DELETE CASCADE,
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
					position INTEGER NOT NULL CHECK (position >= 0),
					framing_mode TEXT NOT NULL CHECK (framing_mode IN ('length','marker','time')),
					frame_length INTEGER CHECK (frame_length > 0),
					marker_bytes TEXT CHECK (json_valid(marker_bytes)),
					marker_position TEXT CHECK (marker_position IN ('start','end')),
					time_gap_ms REAL CHECK (time_gap_ms >= 0),
					collapse_runs INTEGER NOT NULL DEFAULT 0 CHECK (collapse_runs IN (0,1)),
					collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0,1))
				);
				CREATE INDEX IF NOT EXISTS framing_sections_profile_position ON framing_sections (profile_id, position);

				-- Materialized frames for the active profile version
				CREATE TABLE IF NOT EXISTS materialized_frames (
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
				CREATE INDEX IF NOT EXISTS materialized_frames_capture_profile ON materialized_frames (capture_id, profile_version);

				-- Signatures per profile
				CREATE TABLE IF NOT EXISTS frame_signatures (
					profile_id TEXT NOT NULL REFERENCES framing_profiles(id) ON DELETE CASCADE,
					signature TEXT NOT NULL,
					count INTEGER NOT NULL CHECK (count > 0),
					PRIMARY KEY (profile_id, signature)
				);

				-- Transitions per profile
				CREATE TABLE IF NOT EXISTS frame_transitions (
					profile_id TEXT NOT NULL REFERENCES framing_profiles(id) ON DELETE CASCADE,
					from_signature TEXT NOT NULL,
					to_signature TEXT NOT NULL,
					count INTEGER NOT NULL CHECK (count > 0),
					diffs INTEGER NOT NULL CHECK (diffs >= 0),
					PRIMARY KEY (profile_id, from_signature, to_signature)
				);

				-- Byte vocabulary statistics per frame position
				CREATE TABLE IF NOT EXISTS byte_statistics (
					profile_id TEXT NOT NULL REFERENCES framing_profiles(id) ON DELETE CASCADE,
					position INTEGER NOT NULL CHECK (position >= 0),
					value INTEGER NOT NULL CHECK (value >= 0 AND value <= 255),
					count INTEGER NOT NULL CHECK (count > 0),
					PRIMARY KEY (profile_id, position, value)
				);

				-- Bit variance statistics per byte position
				CREATE TABLE IF NOT EXISTS bit_statistics (
					profile_id TEXT NOT NULL REFERENCES framing_profiles(id) ON DELETE CASCADE,
					position INTEGER NOT NULL CHECK (position >= 0),
					bit INTEGER NOT NULL CHECK (bit >= 0 AND bit <= 7),
					percentage INTEGER NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
					variance TEXT NOT NULL,
					PRIMARY KEY (profile_id, position, bit)
				);

				-- Sequence groups (repeated patterns) per profile
				CREATE TABLE IF NOT EXISTS sequence_groups (
					id TEXT PRIMARY KEY NOT NULL,
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					profile_id TEXT NOT NULL REFERENCES framing_profiles(id) ON DELETE CASCADE,
					key_text TEXT NOT NULL,
					signatures_json TEXT NOT NULL CHECK (json_valid(signatures_json)),
					score INTEGER NOT NULL CHECK (score > 0),
					length INTEGER NOT NULL CHECK (length > 0)
				);
				CREATE INDEX IF NOT EXISTS sequence_groups_profile ON sequence_groups (profile_id);

				-- Sequence occurrences per group
				CREATE TABLE IF NOT EXISTS sequence_occurrences (
					group_id TEXT NOT NULL REFERENCES sequence_groups(id) ON DELETE CASCADE,
					occurrence_index INTEGER NOT NULL CHECK (occurrence_index >= 0),
					offset INTEGER NOT NULL CHECK (offset >= 0),
					start_frame_ordinal INTEGER NOT NULL CHECK (start_frame_ordinal >= 0),
					start_raw_offset INTEGER NOT NULL CHECK (start_raw_offset >= 0),
					end_raw_offset INTEGER NOT NULL CHECK (end_raw_offset >= 0),
					length INTEGER NOT NULL CHECK (length > 0),
					PRIMARY KEY (group_id, occurrence_index, offset)
				);

				-- Stable note targets: byte notes at absolute offsets, frame notes at profile+span
				CREATE TABLE IF NOT EXISTS stable_notes (
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
					end_row INTEGER
				);
				CREATE INDEX IF NOT EXISTS stable_notes_capture_kind ON stable_notes (capture_id, target_kind);

				-- Finalization / conversion job status per capture
				CREATE TABLE IF NOT EXISTS finalization_jobs (
					id TEXT PRIMARY KEY NOT NULL,
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					error TEXT,
					verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1))
				);
				CREATE INDEX IF NOT EXISTS finalization_jobs_capture_status ON finalization_jobs (capture_id, status);

				-- Reserved migration backup table; capture_documents remains authoritative in PR #24
				CREATE TABLE IF NOT EXISTS capture_backups (
					capture_id TEXT PRIMARY KEY NOT NULL,
					document_json TEXT NOT NULL CHECK (json_valid(document_json)),
					migrated_at TEXT NOT NULL,
					verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
					verification_report_json TEXT CHECK (verification_report_json IS NULL OR json_valid(verification_report_json))
				);

				-- Legacy fallback view helpers (via code, not SQLite views)
			`);
		}
	},
	{
		version: 3,
		up: database => {
			database.exec(`
				ALTER TABLE stable_notes ADD COLUMN message_id TEXT;
				ALTER TABLE stable_notes ADD COLUMN byte_position INTEGER CHECK (byte_position >= 0);
			`);
		}
	},
	{
		version: 4,
		up: database => {
			database.exec(`
				-- Session identity is per byte; the legacy session_id column remains
				-- for compatibility with databases created before this migration.
				ALTER TABLE raw_chunks ADD COLUMN session_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(session_ids_json));

				CREATE TABLE IF NOT EXISTS capture_sessions (
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
					id TEXT NOT NULL,
					first_received_at REAL,
					last_received_at REAL,
					PRIMARY KEY (capture_id, ordinal),
					UNIQUE (capture_id, id)
				);
				CREATE INDEX IF NOT EXISTS capture_sessions_capture_ordinal
					ON capture_sessions (capture_id, ordinal);
			`);
		}
	},
	{
		version: 5,
		up: database => {
			// Phase 2.5 makes canonical command state explicit. These columns are
			// additive so v4 canonical rows retain their identity, lifecycle, dates,
			// folder, and active profile while gaining revision metadata.
			database.exec(`
				ALTER TABLE captures ADD COLUMN description TEXT NOT NULL DEFAULT '';
				ALTER TABLE captures ADD COLUMN controller_view TEXT NOT NULL DEFAULT '';
				ALTER TABLE captures ADD COLUMN baud_rate INTEGER CHECK (baud_rate IS NULL OR baud_rate > 0);
				ALTER TABLE captures ADD COLUMN input_format TEXT NOT NULL DEFAULT '';
				ALTER TABLE captures ADD COLUMN data_revision INTEGER NOT NULL DEFAULT 0 CHECK (data_revision >= 0);
				ALTER TABLE captures ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 0 CHECK (metadata_revision >= 0);
				ALTER TABLE captures ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0 CHECK (content_revision >= 0);
				ALTER TABLE captures ADD COLUMN retained_start_offset INTEGER NOT NULL DEFAULT 0 CHECK (retained_start_offset >= 0);
				ALTER TABLE captures ADD COLUMN create_request_hash TEXT;

				CREATE UNIQUE INDEX IF NOT EXISTS captures_create_request_hash
					ON captures (create_request_hash)
					WHERE create_request_hash IS NOT NULL;

				CREATE TABLE IF NOT EXISTS capture_storage (
					capture_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(capture_id)) > 0),
					status TEXT NOT NULL CHECK (status IN ('legacy-not-canonicalized','canonical','canonicalization-failed')),
					created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
					updated_at TEXT NOT NULL,
					last_error TEXT
				);
				CREATE INDEX IF NOT EXISTS capture_storage_status
					ON capture_storage (status, updated_at DESC);

				CREATE TABLE IF NOT EXISTS capture_parameters (
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					position INTEGER NOT NULL CHECK (position >= 0),
					key_text TEXT NOT NULL CHECK (length(trim(key_text)) > 0),
					value_text TEXT NOT NULL,
					PRIMARY KEY (capture_id, position)
				);
				CREATE INDEX IF NOT EXISTS capture_parameters_capture_position
					ON capture_parameters (capture_id, position);

				ALTER TABLE capture_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'finalized'
					CHECK (status IN ('recording','stopped','finalizing','finalized','failed','aborted'));
				ALTER TABLE capture_sessions ADD COLUMN started_at TEXT;
				ALTER TABLE capture_sessions ADD COLUMN finalized_at TEXT;
				ALTER TABLE capture_sessions ADD COLUMN next_chunk_sequence INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk_sequence >= 0);
				ALTER TABLE capture_sessions ADD COLUMN next_raw_offset INTEGER NOT NULL DEFAULT 0 CHECK (next_raw_offset >= 0);
				CREATE INDEX IF NOT EXISTS capture_sessions_capture_status
					ON capture_sessions (capture_id, status, ordinal);

				CREATE TABLE IF NOT EXISTS raw_chunk_requests (
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					request_id TEXT NOT NULL CHECK (length(trim(request_id)) > 0),
					session_id TEXT NOT NULL CHECK (length(trim(session_id)) > 0),
					sequence INTEGER NOT NULL CHECK (sequence >= 0),
					expected_start_offset INTEGER NOT NULL CHECK (expected_start_offset >= 0),
					payload_hash TEXT NOT NULL CHECK (length(trim(payload_hash)) > 0),
					accepted_start_offset INTEGER NOT NULL CHECK (accepted_start_offset >= 0),
					accepted_end_offset INTEGER NOT NULL CHECK (accepted_end_offset >= accepted_start_offset),
					next_raw_offset INTEGER NOT NULL CHECK (next_raw_offset >= 0),
					next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0),
					data_revision INTEGER NOT NULL CHECK (data_revision >= 0),
					created_at TEXT NOT NULL,
					PRIMARY KEY (capture_id, request_id)
				);
				CREATE INDEX IF NOT EXISTS raw_chunk_requests_capture_sequence
					ON raw_chunk_requests (capture_id, session_id, sequence);

				CREATE TABLE IF NOT EXISTS framing_drafts (
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					revision INTEGER NOT NULL CHECK (revision >= 0),
					sections_json TEXT NOT NULL CHECK (json_valid(sections_json)),
					source_data_revision INTEGER NOT NULL DEFAULT 0 CHECK (source_data_revision >= 0),
					created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (capture_id, revision)
				);
				CREATE INDEX IF NOT EXISTS framing_drafts_updated_at
					ON framing_drafts (updated_at DESC);

				ALTER TABLE framing_profiles ADD COLUMN source_data_revision INTEGER NOT NULL DEFAULT 0
					CHECK (source_data_revision >= 0);
				ALTER TABLE framing_profiles ADD COLUMN retained_start_offset INTEGER NOT NULL DEFAULT 0
					CHECK (retained_start_offset >= 0);
				ALTER TABLE framing_profiles ADD COLUMN verified INTEGER NOT NULL DEFAULT 0
					CHECK (verified IN (0,1));

				CREATE TABLE IF NOT EXISTS raw_byte_visibility (
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					raw_offset INTEGER NOT NULL CHECK (raw_offset >= 0),
					hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
					PRIMARY KEY (capture_id, raw_offset)
				);
				CREATE INDEX IF NOT EXISTS raw_byte_visibility_capture_offset
					ON raw_byte_visibility (capture_id, raw_offset);

				CREATE TABLE IF NOT EXISTS frame_visibility (
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					profile_id TEXT NOT NULL REFERENCES framing_profiles(id) ON DELETE CASCADE,
					start_raw_offset INTEGER NOT NULL CHECK (start_raw_offset >= 0),
					end_raw_offset INTEGER NOT NULL CHECK (end_raw_offset >= start_raw_offset),
					hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
					PRIMARY KEY (capture_id, profile_id, start_raw_offset, end_raw_offset)
				);
				CREATE INDEX IF NOT EXISTS frame_visibility_capture_profile
					ON frame_visibility (capture_id, profile_id, start_raw_offset, end_raw_offset);

				ALTER TABLE finalization_jobs ADD COLUMN session_id TEXT;
				ALTER TABLE finalization_jobs ADD COLUMN profile_id TEXT REFERENCES framing_profiles(id) ON DELETE SET NULL;
				ALTER TABLE finalization_jobs ADD COLUMN data_revision INTEGER NOT NULL DEFAULT 0 CHECK (data_revision >= 0);
				ALTER TABLE finalization_jobs ADD COLUMN source_data_revision INTEGER;
				ALTER TABLE finalization_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
				ALTER TABLE finalization_jobs ADD COLUMN next_attempt_at TEXT;
				ALTER TABLE finalization_jobs ADD COLUMN lease_token TEXT;
				ALTER TABLE finalization_jobs ADD COLUMN lease_expires_at TEXT;
				ALTER TABLE finalization_jobs ADD COLUMN started_at TEXT;
				ALTER TABLE finalization_jobs ADD COLUMN completed_at TEXT;
				CREATE INDEX IF NOT EXISTS finalization_jobs_retry
					ON finalization_jobs (status, next_attempt_at, updated_at);
				CREATE UNIQUE INDEX IF NOT EXISTS finalization_jobs_retry_identity
					ON finalization_jobs (
						capture_id,
						COALESCE(session_id, ''),
						COALESCE(profile_id, ''),
						data_revision
					);
			`);

			// Existing v4 captures were written only after canonical conversion
			// verification. Give them an initial revision without changing their
			// durable timestamps or lifecycle. The retained boundary comes from the
			// immutable raw chunk offsets, not from row presence in an incidental table.
			database.exec(`
				UPDATE captures
				SET data_revision = 1,
					metadata_revision = 1,
					content_revision = 1,
					retained_start_offset = MAX(0, COALESCE(
						(SELECT MAX(start_offset + byte_count) FROM raw_chunks WHERE raw_chunks.capture_id = captures.id),
						0
					) - 50000)
				WHERE data_revision = 0 AND metadata_revision = 0 AND content_revision = 0;

				UPDATE captures
				SET description = COALESCE(
						(SELECT CASE WHEN json_type(document_json, '$.description') = 'text'
							THEN json_extract(document_json, '$.description') END
						 FROM capture_documents WHERE capture_documents.id = captures.id),
						description
					),
					controller_view = COALESCE(
						(SELECT CASE WHEN json_type(document_json, '$.view') = 'text'
							THEN json_extract(document_json, '$.view') END
						 FROM capture_documents WHERE capture_documents.id = captures.id),
						controller_view
					),
					baud_rate = COALESCE(
						(SELECT CASE WHEN json_type(document_json, '$.baudRate') IN ('integer','real')
							THEN json_extract(document_json, '$.baudRate') END
						 FROM capture_documents WHERE capture_documents.id = captures.id),
						baud_rate
					),
					input_format = COALESCE(
						(SELECT CASE WHEN json_type(document_json, '$.inputFormat') = 'text'
							THEN json_extract(document_json, '$.inputFormat') END
						 FROM capture_documents WHERE capture_documents.id = captures.id),
						input_format
					)
				WHERE EXISTS (SELECT 1 FROM capture_documents WHERE capture_documents.id = captures.id);

				UPDATE framing_profiles
				SET source_data_revision = COALESCE(
						(SELECT data_revision FROM captures WHERE captures.id = framing_profiles.capture_id),
						0
					),
					retained_start_offset = COALESCE(
						(SELECT retained_start_offset FROM captures WHERE captures.id = framing_profiles.capture_id),
						0
					),
					verified = 1;

				INSERT OR IGNORE INTO capture_storage (capture_id, status, created_at, updated_at, last_error)
				SELECT id, 'canonical', created_at, updated_at, NULL
				FROM captures;

				INSERT OR IGNORE INTO capture_storage (capture_id, status, created_at, updated_at, last_error)
				SELECT documents.id, 'legacy-not-canonicalized', documents.created_at, documents.updated_at, NULL
				FROM capture_documents AS documents
				LEFT JOIN captures AS canonical ON canonical.id = documents.id
				WHERE canonical.id IS NULL;

				INSERT OR IGNORE INTO capture_parameters (capture_id, position, key_text, value_text)
				SELECT captures.id,
					CAST(parameters.key AS INTEGER),
					json_extract(parameters.value, '$.key'),
					CAST(json_extract(parameters.value, '$.value') AS TEXT)
				FROM captures
				JOIN capture_documents ON capture_documents.id = captures.id
				JOIN json_each(capture_documents.document_json, '$.params') AS parameters
				WHERE json_type(capture_documents.document_json, '$.params') = 'array'
					AND json_type(parameters.value, '$.key') = 'text'
					AND length(trim(json_extract(parameters.value, '$.key'))) > 0;

				-- A v4 capture/document overlap is an explicit, already-verified
				-- conversion. Keep one deterministic recovery row containing the
				-- authoritative legacy document, replacing any obsolete provisional
				-- backup for that capture. The delete is
				-- in this migration transaction, so normal reads cannot retain both
				-- JSON copies after a successful migration.
				INSERT INTO capture_backups
					(capture_id, document_json, migrated_at, verified, verification_report_json)
				SELECT captures.id, capture_documents.document_json, capture_documents.updated_at, 1, NULL
				FROM captures
				JOIN capture_documents ON capture_documents.id = captures.id
				ON CONFLICT (capture_id) DO UPDATE SET
					document_json = excluded.document_json,
					migrated_at = excluded.migrated_at,
					verified = 1,
					verification_report_json = NULL;

				DELETE FROM capture_documents
				WHERE id IN (
					SELECT captures.id
					FROM captures
					JOIN capture_documents ON capture_documents.id = captures.id
				);

				INSERT OR IGNORE INTO raw_byte_visibility (capture_id, raw_offset, hidden)
				SELECT chunks.capture_id,
					chunks.start_offset + CAST(hidden_values.key AS INTEGER),
					CAST(hidden_values.value AS INTEGER)
				FROM raw_chunks AS chunks
				JOIN json_each(chunks.hidden_json) AS hidden_values
				WHERE json_type(hidden_values.value) IN ('integer','true','false');

				INSERT OR IGNORE INTO frame_visibility
					(capture_id, profile_id, start_raw_offset, end_raw_offset, hidden)
				SELECT frames.capture_id,
					frames.profile_id,
					CAST(json_extract(frames.raw_offsets_json, '$[0]') AS INTEGER),
					CAST(json_extract(frames.raw_offsets_json, '$[#-1]') AS INTEGER),
					frames.hidden
				FROM materialized_frames AS frames
				WHERE json_array_length(frames.raw_offsets_json) > 0;
			`);

			// v4 stable_notes already contains both current and legacy targets. A
			// table rebuild is required to widen its CHECK constraint; every prior
			// column is copied verbatim and the new target references are nullable.
			database.exec(`
				CREATE TABLE stable_notes_v5 (
					id TEXT PRIMARY KEY NOT NULL,
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					text TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT,
					target_kind TEXT NOT NULL CHECK (target_kind IN ('capture','byte','frame','range','sequence-group','sequence','pattern','legacy-sequence')),
					raw_offset INTEGER CHECK (raw_offset >= 0),
					profile_id TEXT REFERENCES framing_profiles(id) ON DELETE SET NULL,
					raw_offsets_json TEXT CHECK (raw_offsets_json IS NULL OR json_valid(raw_offsets_json)),
					start_offset INTEGER CHECK (start_offset >= 0),
					end_offset INTEGER CHECK (end_offset >= 0),
					sequence_key TEXT,
					start_row INTEGER,
					end_row INTEGER,
					message_id TEXT,
					byte_position INTEGER CHECK (byte_position >= 0),
					frame_id TEXT,
					sequence_group_id TEXT REFERENCES sequence_groups(id) ON DELETE SET NULL
				);

				INSERT INTO stable_notes_v5
					(id, capture_id, text, created_at, updated_at, target_kind, raw_offset, profile_id,
					 raw_offsets_json, start_offset, end_offset, sequence_key, start_row, end_row,
					 message_id, byte_position)
				SELECT id, capture_id, text, created_at, updated_at, target_kind, raw_offset, profile_id,
					raw_offsets_json, start_offset, end_offset, sequence_key, start_row, end_row,
					message_id, byte_position
				FROM stable_notes;

				DROP TABLE stable_notes;
				ALTER TABLE stable_notes_v5 RENAME TO stable_notes;
				CREATE INDEX stable_notes_capture_kind ON stable_notes (capture_id, target_kind);
				CREATE INDEX stable_notes_capture_raw_offset ON stable_notes (capture_id, raw_offset);
				CREATE INDEX stable_notes_profile_target ON stable_notes (profile_id, target_kind);
				CREATE INDEX stable_notes_sequence_group ON stable_notes (sequence_group_id);
			`);
		}
	},
	{
		version: 6,
		up: database => {
			// Canonicalization is a user-controlled, observable operation.  Keep the
			// transient converting state in the authority table so every command
			// boundary can fail closed while the legacy document remains readable.
			database.exec(`
				CREATE TABLE capture_storage_v6 (
					capture_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(capture_id)) > 0),
					status TEXT NOT NULL CHECK (status IN ('legacy-not-canonicalized','converting','canonical','canonicalization-failed')),
					created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
					updated_at TEXT NOT NULL,
					last_error TEXT
				);

				INSERT INTO capture_storage_v6 (capture_id, status, created_at, updated_at, last_error)
				SELECT capture_id, status, created_at, updated_at, last_error FROM capture_storage;
				DROP TABLE capture_storage;
				ALTER TABLE capture_storage_v6 RENAME TO capture_storage;
				CREATE INDEX capture_storage_status ON capture_storage (status, updated_at DESC);

				CREATE TABLE finalization_jobs_v6 (
					id TEXT PRIMARY KEY NOT NULL,
					-- Conversion jobs must remain readable after a failed conversion
					-- removes partial canonical rows.  The authority row is checked by
					-- the repository at every operation boundary; a foreign key to
					-- captures would delete the failure record with those rows.
					capture_id TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					error TEXT,
					verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
					session_id TEXT,
					profile_id TEXT REFERENCES framing_profiles(id) ON DELETE SET NULL,
					data_revision INTEGER NOT NULL DEFAULT 0 CHECK (data_revision >= 0),
					source_data_revision INTEGER,
					attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
					next_attempt_at TEXT,
					lease_token TEXT,
					lease_expires_at TEXT,
					started_at TEXT,
					completed_at TEXT,
					verification_report_json TEXT CHECK (verification_report_json IS NULL OR json_valid(verification_report_json))
				);

				INSERT INTO finalization_jobs_v6
					(id, capture_id, status, created_at, updated_at, error, verified,
					 session_id, profile_id, data_revision, source_data_revision, attempt_count,
					 next_attempt_at, lease_token, lease_expires_at, started_at, completed_at)
				SELECT id, capture_id, status, created_at, updated_at, error, verified,
					 session_id, profile_id, data_revision, source_data_revision, attempt_count,
					 next_attempt_at, lease_token, lease_expires_at, started_at, completed_at
				FROM finalization_jobs;
				DROP TABLE finalization_jobs;
				ALTER TABLE finalization_jobs_v6 RENAME TO finalization_jobs;
				CREATE INDEX finalization_jobs_capture_status ON finalization_jobs (capture_id, status);
				CREATE INDEX finalization_jobs_retry ON finalization_jobs (status, next_attempt_at, updated_at);
				CREATE UNIQUE INDEX finalization_jobs_retry_identity
					ON finalization_jobs (
						capture_id,
						COALESCE(session_id, ''),
						COALESCE(profile_id, ''),
						data_revision
					);
			`);
		}
	},
	{
		version: 7,
		up: database => {
			// Agent reads use keyset ordering and explicit profile revisions. These
			// indexes keep discovery, frame paging, and analytical summaries bounded
			// without changing the existing complete-capture UI paths.
			const tables = new Set(
				(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name)
			);
			const indexes: Array<[string, string, string]> = [
				["captures_agent_discovery", "captures", "updated_at DESC, id ASC"],
				["captures_agent_filters", "captures", "lifecycle, created_at, updated_at DESC, id ASC"],
				["capture_storage_agent_discovery", "capture_storage", "status, updated_at DESC, capture_id ASC"],
				["capture_parameters_agent_filter", "capture_parameters", "capture_id, key_text, value_text"],
				["framing_profiles_agent_revision", "framing_profiles", "capture_id, version, id"],
				["materialized_frames_agent_ordinal", "materialized_frames", "profile_id, ordinal, id"],
				["frame_signatures_agent_count", "frame_signatures", "profile_id, count DESC, signature ASC"],
				["frame_transitions_agent_count", "frame_transitions", "profile_id, count DESC, from_signature, to_signature"],
				["sequence_occurrences_agent_group_ordinal", "sequence_occurrences", "group_id, start_frame_ordinal, occurrence_index"]
			];
			for (const [index, table, columns] of indexes) {
				if (tables.has(table)) database.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table} (${columns})`);
			}
		}
	},
	{
		version: 8,
		up: database => {
			// Scoped byte statistics commonly constrain a profile by section and
			// exact signature before expanding the frame byte arrays.
			database.exec(`
				CREATE INDEX IF NOT EXISTS materialized_frames_agent_scope
					ON materialized_frames (profile_id, section_id, signature);
			`);
		}
	},
	{
		version: 9,
		up: database => {
			// Raw-range message lookup constrains a profile by the first and last
			// raw offsets stored in each frame's immutable offset array.
			database.exec(`
				CREATE INDEX IF NOT EXISTS materialized_frames_agent_raw_span
					ON materialized_frames (
						profile_id,
					CAST(json_extract(raw_offsets_json, '$[0]') AS INTEGER),
					CAST(json_extract(raw_offsets_json, '$[#-1]') AS INTEGER)
				);
			`);
		}
	},
	{
		version: 10,
		up: database => {
			// A profile is an immutable analytical snapshot. Capture metadata and
			// parameters are otherwise replaced in place, so preserve the values and
			// data extent that were current when each profile was materialized.
			database.exec(`
				CREATE TABLE IF NOT EXISTS framing_profile_metadata_snapshots (
					profile_id TEXT PRIMARY KEY NOT NULL REFERENCES framing_profiles(id) ON DELETE CASCADE,
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					name TEXT NOT NULL,
					description TEXT NOT NULL,
					controller_view TEXT NOT NULL,
					baud_rate INTEGER CHECK (baud_rate IS NULL OR baud_rate > 0),
					input_format TEXT NOT NULL,
					lifecycle TEXT NOT NULL,
					byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
					folder_id TEXT,
					data_revision INTEGER NOT NULL CHECK (data_revision >= 0),
					metadata_revision INTEGER NOT NULL CHECK (metadata_revision >= 0),
					content_revision INTEGER NOT NULL CHECK (content_revision >= 0),
					retained_start_offset INTEGER NOT NULL CHECK (retained_start_offset >= 0),
					parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
					created_at TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS framing_profile_metadata_snapshots_capture
					ON framing_profile_metadata_snapshots (capture_id, profile_id);

				INSERT OR IGNORE INTO framing_profile_metadata_snapshots (
					profile_id, capture_id, name, description, controller_view, baud_rate,
					input_format, lifecycle, byte_count, folder_id, data_revision,
					metadata_revision, content_revision, retained_start_offset, parameters_json,
					created_at
				)
				SELECT profiles.id, captures.id, captures.name, captures.description,
					captures.controller_view, captures.baud_rate, captures.input_format,
					captures.lifecycle, captures.byte_count, captures.folder_id,
					COALESCE(profiles.source_data_revision, captures.data_revision),
					captures.metadata_revision, captures.content_revision,
					COALESCE(profiles.retained_start_offset, captures.retained_start_offset),
					COALESCE((
						SELECT json_group_array(json_object('key', ordered.key_text, 'value', ordered.value_text))
						FROM (
							SELECT key_text, value_text
							FROM capture_parameters
							WHERE capture_id = captures.id
							ORDER BY position
						) AS ordered
					), '[]'),
					profiles.created_at
				FROM framing_profiles AS profiles
				JOIN captures ON captures.id = profiles.capture_id;

				CREATE TRIGGER IF NOT EXISTS framing_profile_metadata_snapshot_insert
				AFTER INSERT ON framing_profiles
				BEGIN
					INSERT INTO framing_profile_metadata_snapshots (
						profile_id, capture_id, name, description, controller_view, baud_rate,
						input_format, lifecycle, byte_count, folder_id, data_revision,
						metadata_revision, content_revision, retained_start_offset, parameters_json,
						created_at
					)
					SELECT NEW.id, captures.id, captures.name, captures.description,
						captures.controller_view, captures.baud_rate, captures.input_format,
						captures.lifecycle, captures.byte_count, captures.folder_id,
						COALESCE(NEW.source_data_revision, captures.data_revision),
						captures.metadata_revision, captures.content_revision,
						COALESCE(NEW.retained_start_offset, captures.retained_start_offset),
						COALESCE((
							SELECT json_group_array(json_object('key', ordered.key_text, 'value', ordered.value_text))
							FROM (
								SELECT key_text, value_text
								FROM capture_parameters
								WHERE capture_id = captures.id
								ORDER BY position
							) AS ordered
						), '[]'),
						NEW.created_at
					FROM captures
					WHERE captures.id = NEW.capture_id;
				END;
			`);
		}
	},
	{
		version: 9,
		up: database => {
			// Agent notes need durable attribution and two stable range target kinds.
			// Rebuild the table because SQLite cannot widen the existing target CHECK
			// constraint with ALTER TABLE.
			database.exec(`
				CREATE TABLE stable_notes_v9 (
					id TEXT PRIMARY KEY NOT NULL,
					capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
					text TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT,
					target_kind TEXT NOT NULL CHECK (target_kind IN ('capture','byte','frame','range','raw-range','frame-range','sequence-group','sequence','pattern','legacy-sequence')),
					raw_offset INTEGER CHECK (raw_offset >= 0),
					profile_id TEXT REFERENCES framing_profiles(id) ON DELETE SET NULL,
					raw_offsets_json TEXT CHECK (raw_offsets_json IS NULL OR json_valid(raw_offsets_json)),
					start_offset INTEGER CHECK (start_offset >= 0),
					end_offset INTEGER CHECK (end_offset >= 0),
					sequence_key TEXT,
					start_row INTEGER,
					end_row INTEGER,
					message_id TEXT,
					byte_position INTEGER CHECK (byte_position >= 0),
					frame_id TEXT,
					sequence_group_id TEXT REFERENCES sequence_groups(id) ON DELETE SET NULL,
					author_type TEXT NOT NULL DEFAULT 'human' CHECK (author_type IN ('human','agent')),
					reported_client_name TEXT,
					reported_client_version TEXT,
					protocol_version TEXT
				);

				INSERT INTO stable_notes_v9
					(id, capture_id, text, created_at, updated_at, target_kind, raw_offset, profile_id,
					 raw_offsets_json, start_offset, end_offset, sequence_key, start_row, end_row,
					 message_id, byte_position, frame_id, sequence_group_id, author_type,
					 reported_client_name, reported_client_version, protocol_version)
				SELECT id, capture_id, text, created_at, updated_at, target_kind, raw_offset, profile_id,
					raw_offsets_json, start_offset, end_offset, sequence_key, start_row, end_row,
					message_id, byte_position, frame_id, sequence_group_id, 'human', NULL, NULL, NULL
				FROM stable_notes;

				DROP TABLE stable_notes;
				ALTER TABLE stable_notes_v9 RENAME TO stable_notes;
				CREATE INDEX stable_notes_capture_kind ON stable_notes (capture_id, target_kind);
				CREATE INDEX stable_notes_capture_raw_offset ON stable_notes (capture_id, raw_offset);
				CREATE INDEX stable_notes_profile_target ON stable_notes (profile_id, target_kind);
				CREATE INDEX stable_notes_sequence_group ON stable_notes (sequence_group_id);
				CREATE INDEX stable_notes_author_type ON stable_notes (capture_id, author_type, created_at DESC);
			`);
			const hasSettings = (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'application_settings'").get() as { 1: number } | undefined);
			if (hasSettings) database.prepare("INSERT OR IGNORE INTO application_settings (key, value_json, updated_at) VALUES (@key, 'false', CURRENT_TIMESTAMP)").run({ key: "allow_agent_authored_notes" });
		}
	}
];

function ensureMigrationTable(database: SqliteDatabase): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY NOT NULL,
			applied_at TEXT NOT NULL
		);
	`);
}

export function runMigrations(database: SqliteDatabase, nowIso = () => new Date().toISOString()): void {
	ensureMigrationTable(database);
	const applied = new Set(
		(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map(
			row => row.version
		)
	);
	const knownVersions = new Set(migrations.map(migration => migration.version));
	for (const version of applied) {
		if (!knownVersions.has(version)) {
			throw new Error(`Database schema version ${version} is newer than this application supports`);
		}
	}

	for (const migration of migrations) {
		if (applied.has(migration.version)) continue;
		const apply = database.transaction(() => {
			migration.up(database);
			database
				.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (@version, @appliedAt)")
				.run({ version: migration.version, appliedAt: nowIso() });
		});
		apply();
	}
}

/**
 * Run a group of related SQLite writes atomically. better-sqlite3 transactions
 * are synchronous, which is useful here: callers cannot accidentally observe
 * a half-written archive document and its related ordering row.
 */
export function withTransaction<T>(database: SqliteDatabase, operation: () => T): T {
	return database.transaction(operation)();
}

export function getSchemaVersion(database: SqliteDatabase): number {
	const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
		| { version: number | null }
		| undefined;
	return row?.version ?? 0;
}

export function openDatabase(databasePath: string, nowIso = () => new Date().toISOString()): SqliteDatabase {
	mkdirSync(dirname(databasePath), { recursive: true });
	const database = new Database(databasePath, { timeout: 5_000 });
	try {
		// These pragmas are intentionally applied on every open so a copied or older
		// database cannot silently lose the archive's durability settings.
		database.pragma("journal_mode = WAL");
		database.pragma("foreign_keys = ON");
		database.pragma("busy_timeout = 5000");
		runMigrations(database, nowIso);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type SqliteDatabase = InstanceType<typeof Database>;
export const CURRENT_SCHEMA_VERSION = 3;

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

				-- Migration backup: original JSON retained until verification succeeds
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

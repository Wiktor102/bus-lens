import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type SqliteDatabase = InstanceType<typeof Database>;
export const CURRENT_SCHEMA_VERSION = 1;

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

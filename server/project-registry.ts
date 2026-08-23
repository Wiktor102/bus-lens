import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { SqliteDatabase } from "./database.ts";

/**
 * Project routing is control-plane state. The service stores it separately so
 * replacing any project database, including Default, cannot rewrite routing.
 */
export const DEFAULT_PROJECT_ID = "default";
export const DEFAULT_PROJECT_NAME = "Default";
export const PROJECT_REGISTRY_FILENAME = "bus-lens-registry.sqlite";

export type ProjectRecord = Readonly<{
	id: string;
	name: string;
	dbPath: string;
	createdAt: string;
	lastUsedAt: string;
}>;

export type ProjectRegistryErrorCode = "not-found" | "conflict" | "invalid";

export class ProjectRegistryError extends Error {
	readonly code: ProjectRegistryErrorCode;

	constructor(code: ProjectRegistryErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export type EnsureProjectInput = Readonly<{
	id?: string;
	name: string;
	dbPath: string;
}>;

type ProjectRow = {
	id: string;
	name: string;
	db_path: string;
	created_at: string;
	last_used_at: string;
};

type ProjectRoutingRow = {
	key: string;
	project_id: string;
};

function recordFrom(row: ProjectRow): ProjectRecord {
	return {
		id: row.id,
		name: row.name,
		dbPath: row.db_path,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at
	};
}

function assertValidName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new ProjectRegistryError("invalid", "Project name must not be empty");
	if (trimmed.length > 200) throw new ProjectRegistryError("invalid", "Project name must be at most 200 characters");
	return trimmed;
}

/**
 * Durable list of project databases. Storage-only by design: allocating files,
 * opening connections, and serving HTTP stay in the database manager and the
 * HTTP service.
 */
export class ProjectRegistry {
	private readonly database: SqliteDatabase;
	private readonly nowIso: () => string;

	constructor(database: SqliteDatabase, nowIso: () => string = () => new Date().toISOString()) {
		this.database = database;
		this.nowIso = nowIso;
		this.ensureSchema();
	}

	private ensureSchema(): void {
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS projects (
				id TEXT PRIMARY KEY NOT NULL,
				name TEXT NOT NULL,
				db_path TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL,
				last_used_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS project_routing (
				key TEXT PRIMARY KEY NOT NULL,
				project_id TEXT NOT NULL
			);
		`);
	}

	/** Imports control-plane rows written by builds that stored them in Default. */
	importLegacy(records: readonly ProjectRecord[], routing: readonly ProjectRoutingRow[]): void {
		const importRows = this.database.transaction(() => {
			const insert = this.database.prepare(
				"INSERT OR IGNORE INTO projects (id, name, db_path, created_at, last_used_at) VALUES (@id, @name, @dbPath, @createdAt, @lastUsedAt)"
			);
			for (const record of records) insert.run(record);
			const insertRouting = this.database.prepare(
				"INSERT OR IGNORE INTO project_routing (key, project_id) VALUES (@key, @projectId)"
			);
			for (const route of routing) insertRouting.run({ key: route.key, projectId: route.project_id });
		});
		importRows();
	}

	list(): ProjectRecord[] {
		const rows = this.database
			.prepare("SELECT id, name, db_path, created_at, last_used_at FROM projects ORDER BY created_at, id")
			.all() as ProjectRow[];
		return rows.map(recordFrom);
	}

	get(projectId: string): ProjectRecord | undefined {
		const row = this.database
			.prepare("SELECT id, name, db_path, created_at, last_used_at FROM projects WHERE id = @id")
			.get({ id: projectId }) as ProjectRow | undefined;
		return row ? recordFrom(row) : undefined;
	}

	getByDbPath(databasePath: string): ProjectRecord | undefined {
		const row = this.database
			.prepare("SELECT id, name, db_path, created_at, last_used_at FROM projects WHERE db_path = @dbPath")
			.get({ dbPath: resolve(databasePath) }) as ProjectRow | undefined;
		return row ? recordFrom(row) : undefined;
	}

	require(projectId: string): ProjectRecord {
		const record = this.get(projectId);
		if (!record) throw new ProjectRegistryError("not-found", `Unknown project ${projectId}`);
		return record;
	}

	/** Idempotent registration; an explicit id keeps the supplied path authoritative. */
	ensureProject(input: EnsureProjectInput): ProjectRecord {
		const name = assertValidName(input.name);
		const dbPath = resolve(input.dbPath);
		const id = input.id ?? randomUUID();
		const existingById = this.get(id);
		if (existingById) {
			if (existingById.dbPath === dbPath) return existingById;
			const conflicting = this.getByDbPath(dbPath);
			if (conflicting) {
				if (conflicting.id === id) return conflicting;
				throw new ProjectRegistryError(
					"conflict",
					`Database path ${dbPath} is already registered to project ${conflicting.id}`
				);
			}
			try {
				this.database.prepare("UPDATE projects SET db_path = @dbPath WHERE id = @id").run({ id, dbPath });
			} catch (error) {
				// Convert a concurrent path registration into the same useful error.
				const raced = this.getByDbPath(dbPath);
				if (raced && raced.id !== id) {
					throw new ProjectRegistryError(
						"conflict",
						`Database path ${dbPath} is already registered to project ${raced.id}`
					);
				}
				throw error;
			}
			return this.require(id);
		}
		const existingByPath = this.getByDbPath(dbPath);
		if (existingByPath) return existingByPath;
		const timestamp = this.nowIso();
		try {
			this.database
				.prepare(
					"INSERT INTO projects (id, name, db_path, created_at, last_used_at) VALUES (@id, @name, @dbPath, @createdAt, @lastUsedAt)"
				)
				.run({ id, name, dbPath, createdAt: timestamp, lastUsedAt: timestamp });
		} catch (error) {
			// A UNIQUE collision means a concurrent writer registered the same file;
			// the registry row is the shared truth either way.
			const raced = this.getByDbPath(dbPath);
			if (raced) return raced;
			throw error;
		}
		return this.require(id);
	}

	rename(projectId: string, name: string): ProjectRecord {
		const trimmed = assertValidName(name);
		this.require(projectId);
		this.database.prepare("UPDATE projects SET name = @name WHERE id = @id").run({ id: projectId, name: trimmed });
		return this.require(projectId);
	}

	remove(projectId: string): void {
		this.require(projectId);
		this.database.prepare("DELETE FROM projects WHERE id = @id").run({ id: projectId });
	}

	mcpProjectId(): string {
		const row = this.database.prepare("SELECT project_id FROM project_routing WHERE key = 'mcp'").get() as { project_id: string } | undefined;
		return row && this.get(row.project_id) ? row.project_id : DEFAULT_PROJECT_ID;
	}

	setMcpProjectId(projectId: string): void {
		this.require(projectId);
		this.database.prepare(`
			INSERT INTO project_routing (key, project_id) VALUES ('mcp', @projectId)
			ON CONFLICT(key) DO UPDATE SET project_id = excluded.project_id
		`).run({ projectId });
	}
}

export function openProjectRegistryDatabase(databasePath: string): SqliteDatabase {
	const resolvedPath = resolve(databasePath);
	mkdirSync(dirname(resolvedPath), { recursive: true });
	const database = new Database(resolvedPath, { timeout: 5_000 });
	try {
		database.pragma("journal_mode = WAL");
		database.pragma("foreign_keys = ON");
		database.pragma("busy_timeout = 5000");
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

function tableExists(database: SqliteDatabase, table: string): boolean {
	return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = @table").get({ table }));
}

/** Moves control-plane rows out of the legacy Default archive on first boot. */
export function migrateLegacyProjectRegistry(registry: ProjectRegistry, legacyDatabase: SqliteDatabase): void {
	const hasProjects = tableExists(legacyDatabase, "projects");
	const hasRouting = tableExists(legacyDatabase, "project_routing");
	if (!hasProjects && !hasRouting) return;
	const projects = hasProjects
		? (legacyDatabase.prepare("SELECT id, name, db_path, created_at, last_used_at FROM projects ORDER BY created_at, id").all() as ProjectRow[]).map(recordFrom)
		: [];
	const routing = hasRouting
		? legacyDatabase.prepare("SELECT key, project_id FROM project_routing").all() as ProjectRoutingRow[]
		: [];
	registry.importLegacy(projects, routing);
	legacyDatabase.transaction(() => {
		legacyDatabase.exec("DROP TABLE IF EXISTS project_routing; DROP TABLE IF EXISTS projects;");
	})();
}

/**
 * Existing installs keep their single archive file; it becomes the Default
 * project in place so no data moves. Fresh installs get an empty Default
 * pointing at the same root file the service has always opened.
 */
export function ensureDefaultProject(registry: ProjectRegistry, rootDatabasePath: string): ProjectRecord {
	const record = registry.ensureProject({ id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME, dbPath: rootDatabasePath });
	if (record.id !== DEFAULT_PROJECT_ID) {
		throw new ProjectRegistryError(
			"conflict",
			`Default database path ${resolve(rootDatabasePath)} is already registered to project ${record.id}`
		);
	}
	return record;
}

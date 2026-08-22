import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { SqliteDatabase } from "./database.ts";

/**
 * The registry lives in the always-open root database and is the only
 * multi-project state it holds. Everything else belongs to a project database.
 */
export const DEFAULT_PROJECT_ID = "default";
export const DEFAULT_PROJECT_NAME = "Default";

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
		database.exec(`
			CREATE TABLE IF NOT EXISTS projects (
				id TEXT PRIMARY KEY NOT NULL,
				name TEXT NOT NULL,
				db_path TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL,
				last_used_at TEXT NOT NULL
			);
		`);
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

	/** Idempotent registration used by boot-time Default registration. */
	ensureProject(input: EnsureProjectInput): ProjectRecord {
		const name = assertValidName(input.name);
		const dbPath = resolve(input.dbPath);
		const id = input.id ?? randomUUID();
		const existingById = this.get(id);
		if (existingById) return existingById;
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

	touch(projectId: string): void {
		this.require(projectId);
		this.database.prepare("UPDATE projects SET last_used_at = @lastUsedAt WHERE id = @id").run({
			id: projectId,
			lastUsedAt: this.nowIso()
		});
	}

	remove(projectId: string): void {
		this.require(projectId);
		this.database.prepare("DELETE FROM projects WHERE id = @id").run({ id: projectId });
	}

	mostRecentlyUsed(): ProjectRecord | undefined {
		const row = this.database
			.prepare("SELECT id, name, db_path, created_at, last_used_at FROM projects ORDER BY last_used_at DESC, id LIMIT 1")
			.get() as ProjectRow | undefined;
		return row ? recordFrom(row) : undefined;
	}
}

/**
 * Existing installs keep their single archive file; it becomes the Default
 * project in place so no data moves. Fresh installs get an empty Default
 * pointing at the same root file the service has always opened.
 */
export function ensureDefaultProject(registry: ProjectRegistry, rootDatabasePath: string): ProjectRecord {
	return registry.ensureProject({ id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME, dbPath: rootDatabasePath });
}

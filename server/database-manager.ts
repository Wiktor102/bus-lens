import { resolve } from "node:path";
import { ArchiveRepository } from "./archive-repository.ts";
import { CanonicalQueryService } from "./canonical-query.ts";
import { CanonicalCaptureCommandService } from "./canonical-capture-command-service.ts";
import { openDatabase, type SqliteDatabase } from "./database.ts";
import { DEFAULT_PROJECT_ID, type ProjectRecord, type ProjectRegistry } from "./project-registry.ts";

export type ProjectDatabaseContext = Readonly<{
	projectId: string;
	databasePath: string;
	database: SqliteDatabase;
	repository: ArchiveRepository;
	queryService: CanonicalQueryService;
	commandService: CanonicalCaptureCommandService;
}>;

export class ProjectNotFoundError extends Error {
	readonly projectId: string;

	constructor(projectId: string) {
		super(`Unknown project ${projectId}`);
		this.projectId = projectId;
	}
}

type DatabaseOpener = (databasePath: string) => SqliteDatabase;

type ManagerOptions = Readonly<{
	rootDatabase: SqliteDatabase;
	rootDatabasePath: string;
	registry: ProjectRegistry;
	/** Independently opened project handles kept warm before LRU eviction. */
	capacity?: number;
	openDatabase?: DatabaseOpener;
}>;

type CacheEntry = Readonly<{
	context: ProjectDatabaseContext;
	/** The shared root handle is closed by service shutdown, never by eviction. */
	closable: boolean;
}>;

const DEFAULT_CAPACITY = 8;

/**
 * Lazily opens and caches one service context per project. Routing stays
 * stateless: every request names its project, so two tabs can safely sit on
 * different projects and switching is atomic on the client.
 */
export class DatabaseManager {
	private readonly registry: ProjectRegistry;
	private readonly rootDatabase: SqliteDatabase;
	private readonly rootDatabasePath: string;
	private readonly capacity: number;
	private readonly open: DatabaseOpener;
	private readonly cache = new Map<string, CacheEntry>();

	constructor(options: ManagerOptions) {
		this.registry = options.registry;
		this.rootDatabase = options.rootDatabase;
		this.rootDatabasePath = resolve(options.rootDatabasePath);
		this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
		this.open = options.openDatabase ?? openDatabase;
	}

	forProject(projectId?: string): ProjectDatabaseContext {
		const record = this.resolveRecord(projectId);
		const existing = this.cache.get(record.id);
		if (existing) {
			this.cache.delete(record.id);
			this.cache.set(record.id, existing);
			return existing.context;
		}
		const entry = this.openContext(record);
		this.cache.set(record.id, entry);
		this.evictBeyondCapacity();
		return entry.context;
	}

	close(projectId: string): void {
		const entry = this.cache.get(projectId);
		if (!entry) return;
		this.cache.delete(projectId);
		if (entry.closable) entry.context.database.close();
	}

	closeAll(): void {
		for (const [projectId, entry] of [...this.cache]) {
			if (!entry.closable) continue;
			this.cache.delete(projectId);
			entry.context.database.close();
		}
	}

	private resolveRecord(projectId?: string): ProjectRecord {
		const id = projectId?.trim() || DEFAULT_PROJECT_ID;
		const record = this.registry.get(id);
		if (!record) throw new ProjectNotFoundError(id);
		return record;
	}

	private openContext(record: ProjectRecord): CacheEntry {
		const databasePath = resolve(record.dbPath);
		const sharesRootHandle = databasePath === this.rootDatabasePath;
		const database = sharesRootHandle ? this.rootDatabase : this.open(databasePath);
		return {
			closable: !sharesRootHandle,
			context: {
				projectId: record.id,
				databasePath,
				database,
				repository: new ArchiveRepository(database),
				queryService: new CanonicalQueryService(database),
				commandService: new CanonicalCaptureCommandService(database)
			}
		};
	}

	private evictBeyondCapacity(): void {
		for (const [projectId, entry] of [...this.cache]) {
			if (this.closableCount() <= this.capacity) return;
			if (!entry.closable) continue;
			this.cache.delete(projectId);
			entry.context.database.close();
		}
	}

	private closableCount(): number {
		let count = 0;
		for (const entry of this.cache.values()) if (entry.closable) count += 1;
		return count;
	}
}

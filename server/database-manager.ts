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

type PendingClose = Readonly<{
	promise: Promise<void>;
	resolve: () => void;
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
	/** In-flight request counts; handles are only closed at zero. */
	private readonly inFlight = new Map<string, number>();
	private readonly pendingCloses = new Map<string, PendingClose>();

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
		this.evictBeyondCapacity(record.id);
		return entry.context;
	}

	/**
	 * Marks a resolved context as in use across awaits. Without this, an
	 * interleaved eviction or explicit close could close the handle a
	 * suspended request resumes into ("connection is not open").
	 */
	acquire(projectId: string): void {
		this.inFlight.set(projectId, (this.inFlight.get(projectId) ?? 0) + 1);
	}

	release(projectId: string): void {
		const count = this.inFlight.get(projectId);
		if (!count) return;
		if (count > 1) {
			this.inFlight.set(projectId, count - 1);
			return;
		}
		this.inFlight.delete(projectId);
		const pending = this.pendingCloses.get(projectId);
		if (!pending) return;
		this.pendingCloses.delete(projectId);
		this.closeNow(projectId);
		pending.resolve();
	}

	/** Resolves once the last in-flight request for the project has finished. */
	async close(projectId: string): Promise<void> {
		if (this.inFlight.has(projectId)) {
			const existing = this.pendingCloses.get(projectId);
			if (existing) return existing.promise;
			let resolve!: () => void;
			const promise = new Promise<void>(resolveClose => {
				resolve = resolveClose;
			});
			this.pendingCloses.set(projectId, { promise, resolve });
			return promise;
		}
		this.closeNow(projectId);
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

	/**
	 * Closes unpinned handles oldest-first until capacity is respected. Pinned
	 * (in-flight) entries and the freshly inserted context are never closed;
	 * while they occupy slots the cache may temporarily exceed capacity.
	 */
	private evictBeyondCapacity(skipProjectId?: string): void {
		for (const [projectId, entry] of [...this.cache]) {
			if (this.closableCount() <= this.capacity) return;
			if (!entry.closable || projectId === skipProjectId || this.inFlight.has(projectId)) continue;
			this.cache.delete(projectId);
			entry.context.database.close();
		}
	}

	private closableCount(): number {
		let count = 0;
		for (const entry of this.cache.values()) if (entry.closable) count += 1;
		return count;
	}

	private closeNow(projectId: string): void {
		const entry = this.cache.get(projectId);
		if (!entry) return;
		this.cache.delete(projectId);
		if (entry.closable) entry.context.database.close();
	}
}

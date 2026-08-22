import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseManager } from "./database-manager.ts";
import { DEFAULT_PROJECT_ID, ProjectRegistryError, type ProjectRecord, type ProjectRegistry } from "./project-registry.ts";

export type ProjectsServiceOptions = Readonly<{
	registry: ProjectRegistry;
	manager: DatabaseManager;
	projectsDirectory: string;
}>;

/**
 * Application-level project operations above the storage-only registry:
 * file allocation for managed projects, opening new databases eagerly so a
 * broken path fails at creation time, and guarded removal.
 */
export class ProjectsService {
	private readonly registry: ProjectRegistry;
	private readonly manager: DatabaseManager;
	private readonly projectsDirectory: string;

	constructor(options: ProjectsServiceOptions) {
		this.registry = options.registry;
		this.manager = options.manager;
		this.projectsDirectory = resolve(options.projectsDirectory);
	}

	list(): ProjectRecord[] {
		return this.registry.list();
	}

	get(projectId: string): ProjectRecord | undefined {
		return this.registry.get(projectId);
	}

	async create(name: string): Promise<ProjectRecord> {
		const id = randomUUID();
		const dbPath = join(this.projectsDirectory, `${id}.sqlite`);
		const record = this.registry.ensureProject({ id, name, dbPath });
		// Open (and migrate) immediately so creation validates the database file.
		this.manager.forProject(record.id);
		return record;
	}

	rename(projectId: string, name: string): ProjectRecord {
		return this.registry.rename(projectId, name);
	}

	async delete(projectId: string, requesterActiveProjectId?: string): Promise<void> {
		if (projectId === DEFAULT_PROJECT_ID) {
			throw new ProjectRegistryError("conflict", "The Default project cannot be deleted");
		}
		if (requesterActiveProjectId && projectId === requesterActiveProjectId) {
			throw new ProjectRegistryError("conflict", "Switch away from a project before deleting it");
		}
		const record = this.registry.require(projectId);
		this.manager.close(projectId);
		this.registry.remove(projectId);
		const removedPath = `${record.dbPath}.removed`;
		if (!existsSync(record.dbPath)) return;
		await rename(record.dbPath, removedPath);
	}
}

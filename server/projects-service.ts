import { randomUUID } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseManager, ProjectNotFoundError } from "./database-manager.ts";
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
		try {
			// Open (and migrate) immediately so creation validates the database file.
			this.manager.forProject(record.id);
		} catch (error) {
			// A fresh row must not outlive a failed allocation: otherwise the
			// project lists forever while every request against it fails.
			if (record.id === id) {
				try {
					this.registry.remove(record.id);
				} catch {
					// Rollback is best-effort; surface the original failure.
				}
				await this.removeDatabaseFiles(dbPath);
			}
			throw error;
		}
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
		let releaseDeletion: () => void;
		try {
			releaseDeletion = this.manager.reserveDeletion(projectId);
		} catch (error) {
			if (error instanceof ProjectNotFoundError) {
				throw new ProjectRegistryError("conflict", `Project ${projectId} is already being deleted`);
			}
			throw error;
		}
		try {
			await this.manager.close(projectId);
			const removedPath = `${record.dbPath}.removed`;
			if (existsSync(record.dbPath)) {
				// Rename before removing the registry row. A failed soft-delete must
				// leave the project reachable so the user can retry or recover it.
				await rename(record.dbPath, removedPath);
			}
			this.registry.remove(projectId);
		} finally {
			releaseDeletion();
		}
	}

	private async removeDatabaseFiles(dbPath: string): Promise<void> {
		for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
			try {
				if (existsSync(candidate)) await unlink(candidate);
			} catch {
				// Best-effort cleanup; the registry rollback already happened.
			}
		}
	}
}

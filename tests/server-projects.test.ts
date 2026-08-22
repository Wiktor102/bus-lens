import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { type AddressInfo } from "node:net";
import { createArchiveHttpService, type ArchiveHttpService } from "../server/http-service.ts";
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, openDatabase } from "../server/database.ts";
import { ArchiveRepository } from "../server/archive-repository.ts";
import { DatabaseManager, ProjectNotFoundError } from "../server/database-manager.ts";
import { ProjectsService } from "../server/projects-service.ts";
import {
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_NAME,
	ensureDefaultProject,
	ProjectRegistry
} from "../server/project-registry.ts";

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-projects-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("the registry keeps one row per database file and defaults are registered once", async () => {
	await withTemporaryDirectory(async directory => {
		const rootPath = join(directory, "bus-lens.sqlite");
		const database = openDatabase(rootPath);
		const registry = new ProjectRegistry(database);

		const created = ensureDefaultProject(registry, rootPath);
		assert.equal(created.id, DEFAULT_PROJECT_ID);
		assert.equal(created.name, DEFAULT_PROJECT_NAME);
		assert.equal(created.dbPath, resolve(rootPath));

		const reregistered = ensureDefaultProject(registry, rootPath);
		assert.equal(reregistered.id, DEFAULT_PROJECT_ID);

		// Re-registering the same file under a different id must not duplicate rows.
		const raced = registry.ensureProject({ id: "other", name: "Other", dbPath: rootPath });
		assert.equal(raced.id, DEFAULT_PROJECT_ID);
		assert.equal(registry.list().length, 1);
		database.close();
	});
});

test("registry touch orders most-recently-used projects", async () => {
	await withTemporaryDirectory(async directory => {
		const database = openDatabase(join(directory, "root.sqlite"));
		const registry = new ProjectRegistry(database);
		let clock = 0;
		const timed = new ProjectRegistry(database, () => new Date(++clock * 1000).toISOString());
		timed.ensureProject({ id: "a", name: "A", dbPath: join(directory, "a.sqlite") });
		timed.ensureProject({ id: "b", name: "B", dbPath: join(directory, "b.sqlite") });
		timed.touch("a");
		assert.equal(timed.mostRecentlyUsed()?.id, "a");
		timed.touch("b");
		assert.equal(timed.mostRecentlyUsed()?.id, "b");
		assert.equal(registry.list().length, 2);
		database.close();
	});
});

test("routed reads do not reorder most-recently-used projects but writes do", async () => {
	await withTemporaryDirectory(async directory => {
		await withHttpService(async ({ service, baseUrl }) => {
			const labPath = join(directory, "projects", "lab.sqlite");
			service.registry.ensureProject({ id: "lab", name: "Lab", dbPath: labPath });

			// Reads leave the MRU pointing at the newest registered project.
			await requestJson(baseUrl, "/api/archive", { projectId: DEFAULT_PROJECT_ID });
			assert.equal(service.registry.mostRecentlyUsed()?.id, "lab");

			// A write to Default is a real usage signal and retargets the MRU.
			const put = await requestJson(baseUrl, "/api/captures/default-capture", {
				method: "PUT",
				projectId: DEFAULT_PROJECT_ID,
				body: { id: "default-capture", name: "Default capture", messages: [], byteStream: [] }
			});
			assert.equal(put.status, 200);
			assert.equal(service.registry.mostRecentlyUsed()?.id, DEFAULT_PROJECT_ID);
		}, directory);
	});
});

test("registry rejects empty names and unknown ids", async () => {
	await withTemporaryDirectory(async directory => {
		const database = openDatabase(join(directory, "root.sqlite"));
		const registry = new ProjectRegistry(database);
		assert.throws(() => registry.rename("missing", "x"), (error: unknown) => {
			return error instanceof Error && error.message.includes("Unknown project");
		});
		database.close();
	});
});

test("the manager lazily migrates fresh project databases and isolates projects", async () => {
	await withTemporaryDirectory(async directory => {
		const rootPath = join(directory, "bus-lens.sqlite");
		const rootDatabase = openDatabase(rootPath);
		const registry = new ProjectRegistry(rootDatabase);
		ensureDefaultProject(registry, rootPath);
		const manager = new DatabaseManager({ rootDatabase, rootDatabasePath: rootPath, registry });

		const labPath = join(directory, "projects", "lab.sqlite");
		registry.ensureProject({ id: "lab", name: "Lab", dbPath: labPath });

		const lab = manager.forProject("lab");
		assert.equal(getSchemaVersion(lab.database), CURRENT_SCHEMA_VERSION);
		lab.repository.putCapture("lab-capture", { id: "lab-capture", name: "Lab", messages: [] });

		const home = manager.forProject(DEFAULT_PROJECT_ID);
		home.repository.putCapture("home-capture", { id: "home-capture", name: "Home", messages: [] });

		assert.deepEqual(lab.repository.listCaptures().map(capture => capture.id), ["lab-capture"]);
		assert.deepEqual(home.repository.listCaptures().map(capture => capture.id), ["home-capture"]);
		manager.closeAll();
		rootDatabase.close();

		const reopened = new ArchiveRepository(openDatabase(labPath));
		assert.equal(reopened.getCapture("lab-capture")?.document.name, "Lab");
		reopened.close();
	});
});

test("the manager reuses the root handle for the Default project and never evicts it", async () => {
	await withTemporaryDirectory(async directory => {
		const rootPath = join(directory, "bus-lens.sqlite");
		const rootDatabase = openDatabase(rootPath);
		const registry = new ProjectRegistry(rootDatabase);
		ensureDefaultProject(registry, rootPath);
		const manager = new DatabaseManager({ rootDatabase, rootDatabasePath: rootPath, registry, capacity: 1 });

		const shared = manager.forProject();
		assert.equal(shared.database, rootDatabase);

		for (const id of ["p1", "p2"]) registry.ensureProject({ id, name: id, dbPath: join(directory, `${id}.sqlite`) });
		manager.forProject("p1");
		manager.forProject("p2"); // evicts p1 at capacity 1
		manager.forProject(); // never evicts or closes the root handle

		assert.equal(manager.forProject().database, rootDatabase);
		assert.equal(rootDatabase.open, true);
		manager.closeAll();
		assert.equal(rootDatabase.open, true);
		rootDatabase.close();
		assert.equal(rootDatabase.open, false);
	});
});

test("the manager evicts the least-recently-used project beyond its capacity", async () => {
	await withTemporaryDirectory(async directory => {
		const rootPath = join(directory, "bus-lens.sqlite");
		const rootDatabase = openDatabase(rootPath);
		const registry = new ProjectRegistry(rootDatabase);
		ensureDefaultProject(registry, rootPath);
		const opened = new Map<string, ReturnType<typeof openDatabase>>();
		const manager = new DatabaseManager({
			rootDatabase,
			rootDatabasePath: rootPath,
			registry,
			capacity: 2,
			openDatabase: path => {
				const database = openDatabase(path);
				opened.set(path, database);
				return database;
			}
		});
		for (const id of ["a", "b", "c"]) registry.ensureProject({ id, name: id, dbPath: join(directory, `${id}.sqlite`) });

		manager.forProject("a");
		manager.forProject("b");
		manager.forProject("a"); // refresh a
		manager.forProject("c"); // evicts b

		assert.equal(opened.get(join(directory, "b.sqlite"))?.open, false);
		assert.equal(opened.get(join(directory, "a.sqlite"))?.open, true);
		assert.equal(opened.get(join(directory, "c.sqlite"))?.open, true);
		manager.closeAll();
	});
});

test("eviction skips in-flight projects and resumes once released", async () => {
	await withTemporaryDirectory(async directory => {
		const rootPath = join(directory, "bus-lens.sqlite");
		const rootDatabase = openDatabase(rootPath);
		const registry = new ProjectRegistry(rootDatabase);
		ensureDefaultProject(registry, rootPath);
		const opened = new Map<string, ReturnType<typeof openDatabase>>();
		const pathOf = (id: string) => join(directory, `${id}.sqlite`);
		const manager = new DatabaseManager({
			rootDatabase,
			rootDatabasePath: rootPath,
			registry,
			capacity: 1,
			openDatabase: path => {
				const database = openDatabase(path);
				opened.set(path, database);
				return database;
			}
		});
		for (const id of ["a", "b", "c"]) registry.ensureProject({ id, name: id, dbPath: pathOf(id) });

		manager.forProject("a");
		manager.acquire("a"); // a request resolved its context and is suspended across an await
		manager.forProject("b");

		// The pinned handle survives capacity pressure and the fresh context
		// is never closed underneath its caller; the cache temporarily overflows.
		assert.equal(opened.get(pathOf("a"))?.open, true);
		assert.equal(opened.get(pathOf("b"))?.open, true);

		manager.release("a");
		manager.forProject("c"); // capacity applies again from the oldest entry
		assert.equal(opened.get(pathOf("a"))?.open, false);
		assert.equal(opened.get(pathOf("b"))?.open, false);
		assert.equal(opened.get(pathOf("c"))?.open, true);
		manager.closeAll();
	});
});

test("close waits for in-flight requests before closing the handle", async () => {
	await withTemporaryDirectory(async directory => {
		const rootPath = join(directory, "bus-lens.sqlite");
		const rootDatabase = openDatabase(rootPath);
		const registry = new ProjectRegistry(rootDatabase);
		ensureDefaultProject(registry, rootPath);
		const opened = new Map<string, ReturnType<typeof openDatabase>>();
		const manager = new DatabaseManager({
			rootDatabase,
			rootDatabasePath: rootPath,
			registry,
			openDatabase: path => {
				const database = openDatabase(path);
				opened.set(path, database);
				return database;
			}
		});
		registry.ensureProject({ id: "a", name: "A", dbPath: join(directory, "a.sqlite") });
		const databasePath = join(directory, "a.sqlite");
		manager.forProject("a");

		manager.acquire("a");
		const closing = manager.close("a");
		let closed = false;
		void closing.then(() => {
			closed = true;
		});
		await Promise.resolve();
		assert.equal(closed, false);
		assert.equal(opened.get(databasePath)?.open, true);

		manager.release("a");
		await closing;
		assert.equal(closed, true);
		assert.equal(opened.get(databasePath)?.open, false);

		// Closing an idle project stays immediate.
		await manager.close("a");
		manager.forProject("a");
		await manager.close("a");
		assert.equal(opened.get(databasePath)?.open, false);
		rootDatabase.close();
	});
});

test("unknown project ids fail with ProjectNotFoundError", async () => {
	await withTemporaryDirectory(async directory => {
		const rootPath = join(directory, "bus-lens.sqlite");
		const rootDatabase = openDatabase(rootPath);
		const registry = new ProjectRegistry(rootDatabase);
		const manager = new DatabaseManager({ rootDatabase, rootDatabasePath: rootPath, registry });
		assert.throws(() => manager.forProject("ghost"), ProjectNotFoundError);
		rootDatabase.close();
	});
});

test("a failed eager open rolls back project creation", async () => {
	await withTemporaryDirectory(async directory => {
		const rootPath = join(directory, "bus-lens.sqlite");
		const rootDatabase = openDatabase(rootPath);
		const registry = new ProjectRegistry(rootDatabase);
		ensureDefaultProject(registry, rootPath);
		const projectsDirectory = join(directory, "projects");
		mkdirSync(projectsDirectory, { recursive: true });
		const brokenManager = {
			forProject: (projectId: string) => {
				// Simulate a half-created database file before the failure.
				writeFileSync(join(projectsDirectory, `${projectId}.sqlite`), "not a database");
				throw new Error("simulated allocation failure");
			}
		} as unknown as DatabaseManager;
		const projects = new ProjectsService({ registry, manager: brokenManager, projectsDirectory });

		await assert.rejects(projects.create("Broken"), /simulated allocation failure/);

		// No registry row and no file survive the failed creation.
		assert.deepEqual(registry.list().map(record => record.id), [DEFAULT_PROJECT_ID]);
		let leftovers: string[] = [];
		try {
			leftovers = await readdir(projectsDirectory);
		} catch {
			// The directory may not exist at all.
		}
		assert.deepEqual(leftovers.filter(file => file.endsWith(".sqlite")), []);
		rootDatabase.close();
	});
});

type HttpFixture = {
	service: ArchiveHttpService;
	baseUrl: string;
};

async function listen(service: ArchiveHttpService): Promise<string> {
	await new Promise<void>((resolveListen, reject) => {
		service.server.once("error", reject);
		service.server.once("listening", resolveListen);
		service.server.listen({ host: "127.0.0.1", port: 0 });
	});
	const address = service.server.address() as AddressInfo | null;
	assert.ok(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}`;
}

async function withHttpService(
	run: (fixture: HttpFixture) => Promise<void>,
	directory?: string,
	serviceOptions: Partial<Parameters<typeof createArchiveHttpService>[0]> = {}
): Promise<void> {
	const owned = !directory;
	const target = directory ?? await mkdtemp(join(tmpdir(), "bus-lens-projects-http-"));
	const service = createArchiveHttpService({ databasePath: join(target, "bus-lens.sqlite"), ...serviceOptions });
	try {
		const baseUrl = await listen(service);
		await run({ service, baseUrl });
	} finally {
		await service.close();
		if (owned) await rm(target, { recursive: true, force: true });
	}
}

async function requestJson(baseUrl: string, path: string, options: { method?: string; body?: unknown; projectId?: string } = {}): Promise<{ status: number; body: unknown }> {
	const headers: Record<string, string> = { "content-type": "application/json", connection: "close" };
	if (options.projectId) headers["x-bus-lens-project"] = options.projectId;
	const response = await fetch(`${baseUrl}${path}`, {
		method: options.method ?? "GET",
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body)
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

test("routed requests isolate projects and missing headers select Default", async () => {
	await withTemporaryDirectory(async directory => {
		await withHttpService(async ({ service, baseUrl }) => {
			service.registry.ensureProject({ id: "lab", name: "Lab", dbPath: join(directory, "projects", "lab.sqlite") });

			const put = (projectId: string | undefined, id: string) => requestJson(baseUrl, `/api/captures/${id}`, {
				method: "PUT",
				projectId,
				body: { id, name: id, messages: [], byteStream: [] }
			});
			assert.equal((await put(undefined, "default-capture")).status, 200);
			assert.equal((await put("lab", "lab-capture")).status, 200);

			const defaultArchive = await requestJson(baseUrl, "/api/archive");
			assert.equal(defaultArchive.status, 200);
			assert.deepEqual(
				(defaultArchive.body as { captures: Array<{ id: string }> }).captures.map(capture => capture.id),
				["default-capture"]
			);

			const labArchive = await requestJson(baseUrl, "/api/archive", { projectId: "lab" });
			assert.equal(labArchive.status, 200);
			assert.deepEqual(
				(labArchive.body as { captures: Array<{ id: string }> }).captures.map(capture => capture.id),
				["lab-capture"]
			);

			assert.equal(service.registry.get(DEFAULT_PROJECT_ID)?.dbPath, resolve(join(directory, "bus-lens.sqlite")));
		}, directory);
	});
});

test("unknown project headers return 404 without touching storage", async () => {
	await withHttpService(async ({ baseUrl }) => {
		const result = await requestJson(baseUrl, "/api/archive", { projectId: "ghost" });
		assert.equal(result.status, 404);
	});
});

test("restore refuses destinations that collide with live project databases", async () => {
	await withTemporaryDirectory(async directory => {
		await withHttpService(async ({ service, baseUrl }) => {
			const backupPath = join(directory, "seed-backup.sqlite");
			openDatabase(backupPath).close();

			const defaultPath = service.registry.require(DEFAULT_PROJECT_ID).dbPath;
			const refusedRoot = await requestJson(baseUrl, "/api/restore", {
				method: "POST",
				body: { backupPath, destinationPath: defaultPath }
			});
			assert.equal(refusedRoot.status, 409);

			const managedPath = join(directory, "projects", "managed.sqlite");
			service.registry.ensureProject({ id: "managed", name: "Managed", dbPath: managedPath });
			const refusedManaged = await requestJson(baseUrl, "/api/restore", {
				method: "POST",
				body: { backupPath, destinationPath: managedPath }
			});
			assert.equal(refusedManaged.status, 409);

			// The service stays healthy after refusals and unrelated paths still restore.
			const healthy = await requestJson(baseUrl, "/api/archive");
			assert.equal(healthy.status, 200);
			const restored = await requestJson(baseUrl, "/api/restore", {
				method: "POST",
				body: { backupPath, destinationPath: join(directory, "restored.sqlite") }
			});
			assert.equal(restored.status, 204);
			assert.equal(existsSync(join(directory, "restored.sqlite")), true);
			assert.equal(service.manager.forProject("managed").database.open, true);
		}, directory);
	});
});

test("project CRUD creates managed databases and guards removal", async () => {
	await withHttpService(async ({ service, baseUrl }) => {
		const created = await requestJson(baseUrl, "/api/projects", { method: "POST", body: { name: "Field log" } });
		assert.equal(created.status, 201);
		const project = created.body as { id: string; name: string; dbPath: string };
		assert.equal(project.name, "Field log");
		assert.match(project.dbPath, /projects[\\/].+\.sqlite$/);

		// Creation eagerly migrates the new database.
		const context = service.manager.forProject(project.id);
		assert.equal(getSchemaVersion(context.database), CURRENT_SCHEMA_VERSION);

		const listed = await requestJson(baseUrl, "/api/projects");
		assert.equal(listed.status, 200);
		assert.deepEqual(
			(listed.body as { projects: Array<{ id: string }> }).projects.map(entry => entry.id),
			[DEFAULT_PROJECT_ID, project.id]
		);

		const renamed = await requestJson(baseUrl, `/api/projects/${project.id}`, { method: "PATCH", body: { name: "Renamed" } });
		assert.equal(renamed.status, 200);
		assert.equal((renamed.body as { name: string }).name, "Renamed");

		const invalid = await requestJson(baseUrl, "/api/projects", { method: "POST", body: { name: "  " } });
		assert.equal(invalid.status, 400);

		const coerced = await requestJson(baseUrl, "/api/projects", { method: "POST", body: { name: { a: 1 } } });
		assert.equal(coerced.status, 400);
		const notRenamed = await requestJson(baseUrl, `/api/projects/${project.id}`, { method: "PATCH", body: { name: 42 } });
		assert.equal(notRenamed.status, 400);

		const missing = await requestJson(baseUrl, "/api/projects/ghost", { method: "PATCH", body: { name: "x" } });
		assert.equal(missing.status, 404);

		const deleteDefault = await requestJson(baseUrl, `/api/projects/${DEFAULT_PROJECT_ID}`, { method: "DELETE" });
		assert.equal(deleteDefault.status, 409);

		const deleteActive = await requestJson(baseUrl, `/api/projects/${project.id}`, { method: "DELETE", projectId: project.id });
		assert.equal(deleteActive.status, 409);

		const deleted = await requestJson(baseUrl, `/api/projects/${project.id}`, { method: "DELETE" });
		assert.equal(deleted.status, 204);
		assert.equal(service.registry.get(project.id), undefined);
		assert.equal(existsSync(`${project.dbPath}.removed`), true);
		assert.equal(existsSync(project.dbPath), false);

		const afterDelete = await requestJson(baseUrl, "/api/archive", { projectId: project.id });
		assert.equal(afterDelete.status, 404);
	});
});

test("agent access follows the most-recently-used project", async () => {
	await withHttpService(async ({ baseUrl }) => {
		const created = await requestJson(baseUrl, "/api/projects", { method: "POST", body: { name: "Agent lab" } });
		const project = created.body as { id: string };

		await requestJson(baseUrl, "/api/captures/agent-lab-capture", {
			method: "PUT",
			projectId: project.id,
			body: { id: "agent-lab-capture", name: "Agent lab capture", messages: [], byteStream: [] }
		});

		const response = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": "tools/call",
				"Mcp-Name": "list_captures"
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "list_captures",
					arguments: {},
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientInfo": { name: "projects-test", version: "1.0" },
						"io.modelcontextprotocol/clientCapabilities": {}
					}
				}
			})
		});
		assert.equal(response.status, 200);
		const payload = await response.json() as { result?: { structuredContent?: { data?: { captures?: Array<{ id: string }> } } } };
		assert.deepEqual(
			(payload.result?.structuredContent?.data?.captures ?? []).map(capture => capture.id),
			["agent-lab-capture"]
		);
	});
});

async function callListCaptures(baseUrl: string): Promise<string[]> {
	const response = await fetch(`${baseUrl}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			connection: "close",
			"MCP-Protocol-Version": "2026-07-28",
			"Mcp-Method": "tools/call",
			"Mcp-Name": "list_captures"
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "list_captures",
				arguments: {},
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": { name: "projects-test", version: "1.0" },
					"io.modelcontextprotocol/clientCapabilities": {}
				}
			}
		})
	});
	assert.equal(response.status, 200);
	const payload = await response.json() as { result?: { structuredContent?: { data?: { captures?: Array<{ id: string }> } } } };
	return (payload.result?.structuredContent?.data?.captures ?? []).map(capture => capture.id);
}

test("interleaved writes collapse into one retarget and the exposed access stays live", async () => {
	await withTemporaryDirectory(async directory => {
		await withHttpService(async ({ service, baseUrl }) => {
			const projects: Array<{ id: string; name: string }> = [];
			for (const name of ["Chatter A", "Chatter B"]) {
				const created = await requestJson(baseUrl, "/api/projects", { method: "POST", body: { name } });
				projects.push(created.body as { id: string; name: string });
			}
			const initialAccess = service.mcpAccess;

			// Two tabs writing to different projects in quick succession flip the
			// MRU back and forth; the retarget must converge on the last write
			// instead of recreating agent access per flip.
			for (let round = 0; round < 3; round += 1) {
				for (const project of projects) {
					const put = await requestJson(baseUrl, `/api/captures/${project.id}-capture`, {
						method: "PUT",
						projectId: project.id,
						body: { id: `${project.id}-capture`, name: `Capture ${round}`, messages: [], byteStream: [] }
					});
					assert.equal(put.status, 200);
				}
			}

			const captures = await callListCaptures(baseUrl);
			const lastProject = projects[projects.length - 1]!;
			assert.deepEqual(captures, [`${lastProject.id}-capture`]);
			assert.notEqual(service.mcpAccess, initialAccess);
		}, directory, { mcpRetargetDebounceMs: 10 });
	});
});

test("replaced agent targets close after the handoff grace window", async () => {
	await withTemporaryDirectory(async directory => {
		await withHttpService(async ({ service, baseUrl }) => {
			const created = await requestJson(baseUrl, "/api/projects", { method: "POST", body: { name: "Handoff" } });
			const project = created.body as { id: string };
			const initialAccess = service.mcpAccess;
			assert.equal(initialAccess.getStatus().status, "running");

			await requestJson(baseUrl, "/api/captures/handoff-capture", {
				method: "PUT",
				projectId: project.id,
				body: { id: "handoff-capture", name: "Handoff capture", messages: [], byteStream: [] }
			});
			// No /mcp traffic yet, so nothing has been retired.
			assert.equal(initialAccess.getStatus().status, "running");

			// The response resumes exactly when the swap completes, so the
			// previous target must still be inside its grace window here.
			assert.deepEqual(await callListCaptures(baseUrl), ["handoff-capture"]);
			assert.notEqual(service.mcpAccess, initialAccess);
			assert.equal(initialAccess.getStatus().status, "running");

			await new Promise(resolveGrace => setTimeout(resolveGrace, 800));
			// ...and is closed once the window elapses.
			assert.equal(initialAccess.getStatus().status, "stopped");
		}, directory, { mcpRetargetDebounceMs: 10, mcpHandoffGraceMs: 300 });
	});
});

test("shutdown drains a pending retarget instead of leaking the recreated access", async () => {
	await withTemporaryDirectory(async directory => {
		const target = await mkdtemp(join(tmpdir(), "bus-lens-projects-shutdown-"));
		try {
			const service = createArchiveHttpService({
				databasePath: join(target, "bus-lens.sqlite"),
				mcpRetargetDebounceMs: 500,
				mcpHandoffGraceMs: 20
			});
			await new Promise<void>((resolveListen, reject) => {
				service.server.once("error", reject);
				service.server.listen({ host: "127.0.0.1", port: 0 });
				service.server.once("listening", resolveListen);
			});
			const baseUrl = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;

			const created = await requestJson(baseUrl, "/api/projects", { method: "POST", body: { name: "Shutdown" } });
			const project = created.body as { id: string };
			const initialAccess = service.mcpAccess;

			await requestJson(baseUrl, "/api/captures/shutdown-capture", {
				method: "PUT",
				projectId: project.id,
				body: { id: "shutdown-capture", name: "Shutdown capture", messages: [], byteStream: [] }
			});

			// Schedule a debounced retarget, give the /mcp request time to park
			// inside the quiet window, then shut down before it elapses.
			void callListCaptures(baseUrl).catch(() => "aborted");
			await new Promise(resolveSchedule => setTimeout(resolveSchedule, 120));
			await service.close();

			// The chained retarget completed inside close(): the swapped-in
			// access was closed with everything else instead of leaking.
			assert.equal(initialAccess.getStatus().status, "stopped");
			assert.notEqual(service.mcpAccess, initialAccess);
			assert.equal(service.mcpAccess.getStatus().status, "stopped");
		} finally {
			await rm(target, { recursive: true, force: true });
		}
	});
});

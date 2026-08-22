import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import {
	ACTIVE_PROJECT_STORAGE_KEY,
	clearActiveProjectId,
	readActiveProjectId,
	writeActiveProjectId
} from "../src/persistence/active-project.ts";
import { ArchiveClient, type ProjectSummary } from "../src/persistence/archive-client.ts";
import { createArchiveDataLayer } from "../src/data/archive-data-layer.ts";
import { archiveQueryKeys, createArchiveQueryOptions } from "../src/data/archive-queries.ts";

type Call = {
	path: string;
	method: string;
	headers: Record<string, string>;
};

function memoryStorage(): Map<string, string> {
	return new Map();
}

function storageOf(map: Map<string, string>) {
	return {
		getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key)
	};
}

test("active project ids persist to and clear from storage", () => {
	const map = memoryStorage();
	const storage = storageOf(map);
	assert.equal(readActiveProjectId(storage), null);
	writeActiveProjectId("p-1", storage);
	assert.equal(map.get(ACTIVE_PROJECT_STORAGE_KEY), "p-1");
	assert.equal(readActiveProjectId(storage), "p-1");
	writeActiveProjectId("   ", storage);
	assert.equal(readActiveProjectId(storage), null);
	clearActiveProjectId(storage);
	assert.equal(map.size, 0);
});

test("storage failures degrade to an absent project id", () => {
	const hostile = {
		getItem: () => {
			throw new Error("blocked");
		},
		setItem: () => {
			throw new Error("blocked");
		},
		removeItem: () => {
			throw new Error("blocked");
		}
	};
	assert.equal(readActiveProjectId(hostile), null);
	assert.doesNotThrow(() => writeActiveProjectId("p-1", hostile));
	assert.doesNotThrow(() => clearActiveProjectId(hostile));
});

async function withFetchClient(getActiveProjectId: () => string | null | undefined, run: (client: ArchiveClient, calls: Call[]) => Promise<void>) {
	const originalFetch = globalThis.fetch;
	const calls: Call[] = [];
	globalThis.fetch = async (input, init) => {
		calls.push({
			path: String(input),
			method: init?.method ?? "GET",
			headers: { ...(init?.headers as Record<string, string>) }
		});
		if (String(input).endsWith("/projects")) {
			return new Response(JSON.stringify({ projects: [] }), { status: 200, headers: { "content-type": "application/json" } });
		}
		return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
	};
	try {
		await run(new ArchiveClient({ getActiveProjectId }), calls);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

test("every archive request carries the active project header when one is selected", async () => {
	let active: string | null = "lab";
	await withFetchClient(() => active, async (client, calls) => {
		await client.health();
		await client.loadArchiveIndex();
		active = null;
		await client.health();

		assert.equal(calls[0]?.headers["x-bus-lens-project"], "lab");
		assert.equal(calls[1]?.headers["x-bus-lens-project"], "lab");
		assert.equal(calls[2] && "x-bus-lens-project" in (calls[2].headers), false);
	});
});

test("project management endpoints use dedicated REST paths", async () => {
	await withFetchClient(() => null, async (client, calls) => {
		await client.createProject("Field log");
		await client.renameProject("p-1", "Renamed");
		await client.listProjects();
		await client.deleteProject("p-1");

		assert.deepEqual(calls.map(call => [call.path, call.method]), [
			["/api/projects", "POST"],
			["/api/projects/p-1", "PATCH"],
			["/api/projects", "GET"],
			["/api/projects/p-1", "DELETE"]
		]);
	});
});

test("switching projects persists the selection and clears the whole archive cache", async () => {
	const map = memoryStorage();
	const storage = storageOf(map);
	const queryClient = new QueryClient();
	queryClient.setQueryData(archiveQueryKeys.captures(), [{ id: "old" }]);
	queryClient.setQueryData(archiveQueryKeys.projects(), []);

	let reloads = 0;
	// The bootstrap must not touch the network; only switch semantics matter here.
	const client = Object.assign(new ArchiveClient(), {
		health: async () => {},
		load: async () => ({ captures: [], folders: [], sendQueue: [], sendHistory: [], sendSettings: {} }),
		loadArchiveIndex: async () => ({ activeId: null, unfiledCollapsed: false, captures: [], folders: [] }),
		listCaptures: async () => [],
		listFolders: async () => [],
		listQueue: async () => [],
		listHistory: async () => [],
		loadSettings: async () => ({}),
		listCaptureSummaries: async () => [],
		listProjects: async () => []
	}) as ArchiveClient;
	const layer = createArchiveDataLayer(queryClient, client, storage, { reloadWindow: () => void (reloads += 1) });
	await layer.ready;

	await layer.commands.switchActiveProject("p-9");
	assert.equal(readActiveProjectId(storage), "p-9");
	assert.equal(reloads, 1);
	assert.equal(queryClient.getQueryData(archiveQueryKeys.captures()), undefined);

	// Switching to the already-active project is a no-op.
	await layer.commands.switchActiveProject("p-9");
	assert.equal(reloads, 1);

	layer.commands.forgetActiveProject();
	assert.equal(readActiveProjectId(storage), null);
	assert.equal(reloads, 2);
});

const summaryOf = (id: string): ProjectSummary => ({ id, name: id, dbPath: `/data/${id}.sqlite`, createdAt: "c", lastUsedAt: "l" });

async function withProjectsDataLayer(
	storedId: string | null,
	projects: ProjectSummary[],
	run: (layer: ReturnType<typeof createArchiveDataLayer>, storage: { getItem: (key: string) => string | null }, reloads: () => number) => Promise<void>,
	clientOverrides: Partial<ArchiveClient> = {}
): Promise<void> {
	const map = memoryStorage();
	const storage = storageOf(map);
	if (storedId !== null) writeActiveProjectId(storedId, storage);
	const queryClient = new QueryClient();
	let reloads = 0;
	const client = Object.assign(new ArchiveClient(), {
		health: async () => {},
		load: async () => ({ captures: [], folders: [], sendQueue: [], sendHistory: [], sendSettings: {} }),
		loadArchiveIndex: async () => ({ activeId: null, unfiledCollapsed: false, captures: [], folders: [] }),
		listCaptures: async () => [],
		listFolders: async () => [],
		listQueue: async () => [],
		listHistory: async () => [],
		loadSettings: async () => ({}),
		listCaptureSummaries: async () => [],
		listProjects: async () => projects,
		startSession: async () => ({ sessionId: "s-1", nextChunkSequence: 1, nextRawOffset: 0, dataRevision: 1 }),
		finalizeSession: async () => ({ dataRevision: 2 }),
		appendChunk: async () => ({ accepted: true, nextChunkSequence: 1, nextRawOffset: 0, dataRevision: 1 }),
		...clientOverrides
	}) as ArchiveClient;
	const layer = createArchiveDataLayer(queryClient, client, storage, { reloadWindow: () => void (reloads += 1) });
	await layer.ready;
	await run(layer, storage, () => reloads);
}

test("a stored project id missing from the registry heals back to Default", async () => {
	await withProjectsDataLayer("ghost", [summaryOf("default"), summaryOf("p-1")], async (layer, storage, reloads) => {
		await layer.commands.listProjects();
		assert.equal(readActiveProjectId(storage), null);
		assert.equal(reloads(), 1);
	});
});

test("a stored project id present in the registry is left alone", async () => {
	await withProjectsDataLayer("p-1", [summaryOf("default"), summaryOf("p-1")], async (layer, _storage, reloads) => {
		await layer.commands.listProjects();
		assert.equal(readActiveProjectId(_storage), "p-1");
		assert.equal(reloads(), 0);
	});
});

test("switching projects is fenced while a recording session is open", async () => {
	await withProjectsDataLayer(null, [summaryOf("default"), summaryOf("p-2")], async (layer, storage, reloads) => {
		await layer.commands.recordingWriter.startSession({ captureId: "cap-1", sessionId: "s-1" });

		await assert.rejects(layer.commands.switchActiveProject("p-2"), /Stop recording before switching projects/);
		assert.equal(readActiveProjectId(storage), null);
		assert.equal(reloads(), 0);

		// Finalizing closes the fence and switching proceeds.
		await layer.commands.recordingWriter.finalizeSession({ captureId: "cap-1", sessionId: "s-1", expectedDataRevision: 1 });
		await layer.commands.switchActiveProject("p-2");
		assert.equal(readActiveProjectId(storage), "p-2");
		assert.equal(reloads(), 1);
	});
});

test("a failed recording session start does not engage the switch fence", async () => {
	await withProjectsDataLayer(
		null,
		[summaryOf("default"), summaryOf("p-2")],
		async (layer, storage, reloads) => {
			await assert.rejects(layer.commands.recordingWriter.startSession({ captureId: "cap-1", sessionId: "s-1" }), /no server/);
			await layer.commands.switchActiveProject("p-2");
			assert.equal(readActiveProjectId(storage), "p-2");
			assert.equal(reloads(), 1);
		},
		{ startSession: async () => Promise.reject(new Error("no server session")) }
	);
});

test("the projects query option reads through the injected client", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({ projects: [{ id: "p-1", name: "One", dbPath: "/x.sqlite", createdAt: "c", lastUsedAt: "l" }] }),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		const options = createArchiveQueryOptions(new ArchiveClient()).projects();
		assert.equal(options.queryKey[1], "projects");
		assert.deepEqual(await options.queryFn(), [
			{ id: "p-1", name: "One", dbPath: "/x.sqlite", createdAt: "c", lastUsedAt: "l" }
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

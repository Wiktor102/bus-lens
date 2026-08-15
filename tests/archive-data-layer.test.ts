import assert from "node:assert/strict";
import test from "node:test";
import { ArchiveClient, type ArchiveIndex } from "../src/persistence/archive-client.ts";
import { createArchiveDataLayer } from "../src/data/archive-data-layer.ts";
import { createTestQueryClient } from "../src/test-utils/query-client.ts";
import type { AppState, SendQueueEntry, SendSettings } from "../src/shared/app-state.ts";

type TestServer = {
	state: AppState;
	index: ArchiveIndex;
	failIndex: boolean;
	failQueue: boolean;
	migrations: number;
};

function createTestClient(server: TestServer): ArchiveClient {
	const copy = <T>(value: T): T => structuredClone(value);
	return Object.assign(new ArchiveClient(), {
		health: async () => {},
		load: async () => copy(server.state),
		loadArchiveIndex: async () => copy(server.index),
		listCaptures: async () => copy(server.state.captures),
		listFolders: async () => copy(server.state.folders),
		listQueue: async () => copy(server.state.sendQueue ?? []),
		listHistory: async () => copy(server.state.sendHistory ?? []),
		loadSettings: async () => copy(server.state.sendSettings ?? {}),
		listCaptureSummaries: async () => server.state.captures.map(capture => ({
			id: String(capture.id),
			status: "legacy-not-canonicalized" as const,
			name: String(capture.name ?? ""),
			lifecycle: null,
			byteCount: capture.byteStream?.length ?? 0,
			createdAt: String(capture.createdAt ?? ""),
			updatedAt: String(capture.updatedAt ?? ""),
			folderId: capture.folderId ?? null
		})),
		migrate: async (archive: AppState) => {
			server.migrations += 1;
			server.state = copy(archive);
			server.index = {
				activeId: archive.activeId ?? null,
				unfiledCollapsed: Boolean(archive.unfiledCollapsed),
				captures: archive.captures.map((capture, position) => ({ id: String(capture.id), folderId: capture.folderId ?? null, position })),
				folders: archive.folders.map((folder, position) => ({ id: String(folder.id), position }))
			};
			return { fingerprint: "test", captures: archive.captures.length, folders: archive.folders.length, rawBytes: 0, notes: 0, queueEntries: 0, historyEntries: 0 };
		},
		saveArchiveIndex: async (index: ArchiveIndex) => {
			if (server.failIndex) throw new Error("index write failed");
			server.index = copy(index);
		},
		saveQueueItem: async (item: SendQueueEntry) => {
			if (server.failQueue) throw new Error("queue write failed");
			server.state.sendQueue = [
				...(server.state.sendQueue ?? []).filter(candidate => candidate.id !== item.id),
				copy(item)
			];
		},
		saveFolder: async () => {},
		deleteFolder: async () => {},
		deleteQueueItem: async id => {
			server.state.sendQueue = (server.state.sendQueue ?? []).filter(item => item.id !== id);
		},
		deleteHistoryItem: async () => {},
		saveHistoryItem: async () => {},
		saveSendState: async () => {},
		saveSettings: async settings => {
			server.state.sendSettings = { ...(server.state.sendSettings ?? {}), ...copy(settings) };
		},
		createCapture: async request => ({ captureId: String(request.captureId), name: String(request.name ?? ""), description: String(request.description ?? ""), controllerView: String(request.controllerView ?? ""), baudRate: request.baudRate ?? null, inputFormat: "binary", folderId: request.folderId ?? null, lifecycle: "created", byteCount: 0, createdAt: "", updatedAt: "", dataRevision: 0, metadataRevision: 0, contentRevision: 0, retainedStartOffset: 0, activeProfile: null, storage: { captureId: String(request.captureId), status: "canonical", updatedAt: null, lastError: null }, parameters: [], sessions: [], draft: null, byteVisibility: [], frameVisibility: [], notes: [] }),
		patchMetadata: async () => { throw new Error("not used"); },
		startCanonicalization: async () => { throw new Error("not used"); },
		delete: async () => {}
	}) as ArchiveClient;
}

function emptyServer(): TestServer {
	return {
		state: { captures: [], folders: [], sendQueue: [], sendHistory: [], sendSettings: {} },
		index: { activeId: null, unfiledCollapsed: false, captures: [], folders: [] },
		failIndex: false,
		failQueue: false,
		migrations: 0
	};
}

test("reconstructs authoritative archive queries after reload", async () => {
	const server = emptyServer();
	server.state.captures = [{ id: "capture-1", name: "Stored", messages: [], byteStream: [] }];
	server.state.folders = [{ id: "folder-1", name: "Stored folder", collapsed: false }];
	server.state.sendQueue = [{ id: "queue-1", bytes: [0xaa], createdAt: 1 }];
	server.index = {
		activeId: "capture-1",
		unfiledCollapsed: true,
		captures: [{ id: "capture-1", folderId: "folder-1", position: 0 }],
		folders: [{ id: "folder-1", position: 0 }]
	};

	const layer = createArchiveDataLayer(createTestQueryClient(), createTestClient(server));
	await layer.ready;

	assert.equal(layer.queryClient.getQueryData(layer.queries.index().queryKey)?.activeId, "capture-1");
	assert.deepEqual(layer.queryClient.getQueryData(layer.queries.folders().queryKey)?.map(folder => folder.id), ["folder-1"]);
	assert.deepEqual(layer.queryClient.getQueryData(layer.queries.queue().queryKey)?.map(item => item.id), ["queue-1"]);
	assert.equal(layer.queryClient.getQueryData(layer.queries.captures().queryKey)?.[0]?.name, "Stored");
});

test("rolls back a failed archive-index mutation and permits retry", async () => {
	const server = emptyServer();
	server.index = { activeId: null, unfiledCollapsed: false, captures: [], folders: [] };
	const queryClient = createTestQueryClient();
	const layer = createArchiveDataLayer(queryClient, createTestClient(server));
	await layer.ready;
	const next: ArchiveIndex = { ...server.index, activeId: "capture-1" };
	server.failIndex = true;

	await assert.rejects(layer.commands.persistArchiveIndex(next), /index write failed/);
	assert.equal(queryClient.getQueryData<ArchiveIndex>(layer.queries.index().queryKey)?.activeId, null);

	server.failIndex = false;
	await layer.commands.persistArchiveIndex(next);
	assert.equal(queryClient.getQueryData<ArchiveIndex>(layer.queries.index().queryKey)?.activeId, "capture-1");
});

test("query data reflects named queue and settings commands without AppState persistence", async () => {
	const server = emptyServer();
	const queryClient = createTestQueryClient();
	const layer = createArchiveDataLayer(queryClient, createTestClient(server));
	await layer.ready;
	const item: SendQueueEntry = { id: "queue-1", bytes: [1, 2, 3], createdAt: 10 };

	server.failQueue = true;
	await assert.rejects(layer.commands.saveQueueItem(item, 0), /queue write failed/);
	assert.deepEqual(queryClient.getQueryData(layer.queries.queue().queryKey), []);

	server.failQueue = false;
	await layer.commands.saveQueueItem(item, 0);
	await layer.commands.saveSettings({ delayMs: 250 });
	assert.deepEqual(queryClient.getQueryData<SendQueueEntry[]>(layer.queries.queue().queryKey), [item]);
	assert.equal(queryClient.getQueryData<{ delayMs?: number }>(layer.queries.settings().queryKey)?.delayMs, 250);

	const reloaded = createArchiveDataLayer(createTestQueryClient(), createTestClient(server));
	await reloaded.ready;
	assert.deepEqual(reloaded.queryClient.getQueryData<SendQueueEntry[]>(reloaded.queries.queue().queryKey), [item]);
	assert.equal(reloaded.queryClient.getQueryData<{ delayMs?: number }>(reloaded.queries.settings().queryKey)?.delayMs, 250);
});

test("serializes concurrent settings writes and keeps the latest optimistic value", async () => {
	const server = emptyServer();
	const client = createTestClient(server);
	const writes: string[] = [];
	let releaseFirst!: () => void;
	const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve; });
	client.saveSettings = async settings => {
		writes.push(String(settings.draft));
		if (writes.length === 1) await firstWrite;
		server.state.sendSettings = { ...(server.state.sendSettings ?? {}), ...structuredClone(settings) };
	};
	const layer = createArchiveDataLayer(createTestQueryClient(), client);
	await layer.ready;

	const first = layer.commands.saveSettings({ draft: "A" });
	const latest = layer.commands.saveSettings({ draft: "AB" });
	assert.equal(layer.queryClient.getQueryData<SendSettings>(layer.queries.settings().queryKey)?.draft, "AB");
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(writes, ["A"]);

	releaseFirst();
	await Promise.all([first, latest]);
	assert.deepEqual(writes, ["A", "AB"]);
	assert.equal(server.state.sendSettings?.draft, "AB");
});

test("migrates a legacy local archive before removing its compatibility copy", async () => {
	const server = emptyServer();
	const raw = JSON.stringify({ captures: [{ id: "legacy", name: "Legacy", messages: [], byteStream: [] }], folders: [] });
	let stored: string | null = raw;
	const storage = {
		getItem: () => stored,
		removeItem: () => { stored = null; }
	};
	const layer = createArchiveDataLayer(createTestQueryClient(), createTestClient(server), storage);
	await layer.ready;

	assert.equal(server.migrations, 1);
	assert.equal(stored, null);
	assert.equal(layer.queryClient.getQueryData(layer.queries.captures().queryKey)?.[0]?.id, "legacy");
});

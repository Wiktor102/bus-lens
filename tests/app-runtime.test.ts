import assert from "node:assert/strict";
import test from "node:test";
import { createAppRuntime } from "../src/app/app-runtime.ts";
import type { ArchiveDataLayer } from "../src/data/archive-data-layer.ts";
import { STORAGE_KEY, type AppState } from "../src/shared/app-state.ts";

function emptyState(): AppState {
	return {
		captures: [],
		folders: [],
		activeId: null,
		unfiledCollapsed: false,
		sendQueue: [],
		sendHistory: [],
		sendSettings: { draft: "", delayMs: 100, baudRate: 115200 }
	};
}

test("keeps a legacy fallback for live compatibility without exposing generic persistence", async () => {
	const legacy: AppState = {
		...emptyState(),
		captures: [{ id: "legacy-capture", name: "Legacy", messages: [], byteStream: [] }]
	};
	const runtime = createAppRuntime({
		storage: { getItem: key => key === STORAGE_KEY ? JSON.stringify(legacy) : null }
	});

	assert.equal(runtime.state.captures[0]?.id, "legacy-capture");
	assert.equal("saveState" in runtime, false);
	assert.equal("persistState" in runtime, false);
	await runtime.ready;
	assert.equal(runtime.capture()?.id, "legacy-capture");
});

test("hydrates the compatibility projection only from the archive data layer", async () => {
	const stored: AppState = {
		...emptyState(),
		captures: [{ id: "stored-capture", name: "Stored", messages: [], byteStream: [] }],
		folders: [{ id: "stored-folder", name: "Stored folder", collapsed: false }],
		activeId: "stored-capture",
		unfiledCollapsed: true,
		sendQueue: [{ id: "queue-1", bytes: [1] }],
		sendHistory: [{ id: "history-1", bytes: [2] }],
		sendSettings: { draft: "AA", delayMs: 250, baudRate: 9600 }
	};
	const archive = {
		ready: Promise.resolve(),
		commands: {
			hydrate: async () => ({
				index: {
					activeId: stored.activeId ?? null,
					unfiledCollapsed: true,
					captures: [{ id: "stored-capture", folderId: "stored-folder", position: 0 }],
					folders: [{ id: "stored-folder", position: 0 }]
				},
				captures: stored.captures,
				folders: stored.folders,
				queue: stored.sendQueue!,
				history: stored.sendHistory!,
				settings: stored.sendSettings!,
				summaries: []
			}),
			recordingWriter: {}
		}
	} as unknown as ArchiveDataLayer;

	const runtime = createAppRuntime({ archive, storage: { getItem: () => null } });
	await runtime.ready;

	assert.deepEqual(runtime.state.captures.map(capture => capture.id), ["stored-capture"]);
	assert.deepEqual(runtime.state.folders.map(folder => folder.id), ["stored-folder"]);
	assert.deepEqual(runtime.state.sendQueue?.map(item => item.id), ["queue-1"]);
	assert.deepEqual(runtime.state.sendHistory?.map(item => item.id), ["history-1"]);
	assert.equal(runtime.getActiveId(), "stored-capture");
	assert.equal(runtime.state.unfiledCollapsed, true);
	assert.equal(runtime.state.sendSettings?.delayMs, 250);
});

test("waits for a named capture command before recording or canonicalization", async () => {
	let release!: () => void;
	const write = new Promise<void>(resolve => { release = resolve; });
	const runtime = createAppRuntime({ storage: { getItem: () => null } });
	runtime.trackCaptureWrite("capture-1", write);

	let waited = false;
	const pending = runtime.waitForCaptureWrite("capture-1").then(() => { waited = true; });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(waited, false);

	release();
	await pending;
	assert.equal(waited, true);
});

test("keeps canonical routing when the supplemental status list is incomplete", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<{ path: string; method: string }> = [];
	const stored = {
		captures: [{ id: "canonical", document: { id: "canonical", name: "Before", storageStatus: "canonical", messages: [], byteStream: [] } }],
		folders: [],
		index: { activeId: "canonical", unfiledCollapsed: false },
		queue: [],
		history: [],
		settings: {}
	};
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		requests.push({ path, method: init?.method || "GET" });
		if (path.endsWith("/health")) return new Response(null, { status: 204 });
		if (path.endsWith("/archive")) return new Response(JSON.stringify(stored), { status: 200 });
		if (path.endsWith("/canonical/captures")) return new Response(JSON.stringify([]), { status: 200 });
		if (path.endsWith("/metadata")) return new Response(JSON.stringify({ metadataRevision: 2, updatedAt: "now" }), { status: 200 });
		return new Response(null, { status: 204 });
	};

	try {
		const runtime = createAppRuntime();
		await runtime.ready;
		assert.equal(runtime.getCaptureStorageStatus("canonical"), "canonical");
		assert.equal(runtime.isCanonicalCapture("canonical"), true);

		runtime.state.captures[0]!.name = "Renamed";
		runtime.saveCapture("canonical");
		await runtime.waitForCaptureWrite("canonical");

		assert.ok(requests.some(request => request.path === "/api/captures/canonical/metadata" && request.method === "PATCH"));
		assert.equal(requests.some(request => request.path === "/api/captures/canonical" && request.method === "PUT"), false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

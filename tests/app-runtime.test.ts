import assert from "node:assert/strict";
import test from "node:test";
import { createAppRuntime } from "../src/app/app-runtime.ts";

test("resolves after the database archive has replaced the initial fallback state", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async input => {
		const path = String(input);
		const body = path.endsWith("/health")
			? { ok: true }
			: {
					captures: [
						{ document: { id: "stored-capture", name: "Stored capture", view: "Main", folderId: "stored-folder", messages: [], byteStream: [] } }
					],
					folders: [{ document: { id: "stored-folder", name: "Stored folder", collapsed: false } }],
					index: { activeId: "stored-capture", unfiledCollapsed: false },
					queue: [],
					history: [],
					settings: {}
				};
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	};

	try {
		const runtime = createAppRuntime();

		assert.equal(runtime.state.captures.length, 2);
		await runtime.ready;

		assert.deepEqual(runtime.state.captures.map(capture => capture.id), ["stored-capture"]);
		assert.deepEqual(runtime.state.folders.map(folder => folder.id), ["stored-folder"]);
		assert.equal(runtime.getActiveId(), "stored-capture");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("reconciles deleted captures, folders, queue entries, and history entries", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<{ path: string; method: string }> = [];
	const stored = {
		captures: [
			{ id: "capture-keep", document: { id: "capture-keep", name: "Keep", messages: [], byteStream: [] } },
			{ id: "capture-delete", document: { id: "capture-delete", name: "Delete", messages: [], byteStream: [] } }
		],
		folders: [
			{ id: "folder-keep", document: { id: "folder-keep", name: "Keep", collapsed: false } },
			{ id: "folder-delete", document: { id: "folder-delete", name: "Delete", collapsed: false } }
		],
		index: { activeId: "capture-keep", unfiledCollapsed: false },
		queue: [
			{ id: "queue-keep", document: { bytes: [1] } },
			{ id: "queue-delete", document: { bytes: [2] } }
		],
		history: [
			{ id: "history-keep", document: { bytes: [3] } },
			{ id: "history-delete", document: { bytes: [4] } }
		],
		settings: { send: { delayMs: 100, draft: "", baudRate: 115200 } }
	};
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		requests.push({ path, method: init?.method || "GET" });
		if (path.endsWith("/health")) return new Response(null, { status: 204 });
		if (path.endsWith("/archive")) return new Response(JSON.stringify(stored), { status: 200 });
		return new Response(null, { status: 204 });
	};

	try {
		const runtime = createAppRuntime();
		await runtime.ready;

		runtime.state.captures = runtime.state.captures.filter(capture => capture.id !== "capture-delete");
		runtime.state.folders = runtime.state.folders.filter(folder => folder.id !== "folder-delete");
		runtime.state.sendQueue = runtime.state.sendQueue?.filter(item => item.id !== "queue-delete");
		runtime.state.sendHistory = runtime.state.sendHistory?.filter(item => item.id !== "history-delete");
		runtime.saveState({ immediate: true });
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepEqual(
			requests.filter(request => request.method === "DELETE").map(request => request.path).sort(),
			[
				"/api/captures/capture-delete",
				"/api/folders/folder-delete",
				"/api/history/history-delete",
				"/api/queue/queue-delete"
			].sort()
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("saveState preserves global persistence without replaying every capture", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<{ path: string; method: string }> = [];
	const stored = {
		captures: [
			{ id: "capture-one", document: { id: "capture-one", name: "One", messages: [], byteStream: [] } },
			{ id: "capture-two", document: { id: "capture-two", name: "Two", messages: [], byteStream: [] } }
		],
		folders: [],
		index: { activeId: "capture-one", unfiledCollapsed: false },
		queue: [],
		history: [],
		settings: { send: { delayMs: 100, draft: "", baudRate: 115200 } }
	};
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		requests.push({ path, method: init?.method || "GET" });
		if (path.endsWith("/health")) return new Response(null, { status: 204 });
		if (path.endsWith("/archive")) return new Response(JSON.stringify(stored), { status: 200 });
		if (path.endsWith("/canonical/captures")) return new Response(JSON.stringify([]), { status: 200 });
		return new Response(null, { status: 204 });
	};

	try {
		const runtime = createAppRuntime();
		await runtime.ready;
		requests.length = 0;
		runtime.saveState({ immediate: true });
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.equal(requests.some(request => request.path === "/api/captures/capture-one" || request.path === "/api/captures/capture-two"), false);
		assert.ok(requests.some(request => request.path === "/api/archive-index" && request.method === "PUT"));
		assert.ok(requests.some(request => request.path === "/api/settings/send" && request.method === "PUT"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("saveState creates a new capture through POST /api/captures", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<{ path: string; method: string; body?: unknown }> = [];
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		requests.push({ path, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
		if (path.endsWith("/health")) return new Response(null, { status: 204 });
		if (path.endsWith("/archive")) {
			return new Response(JSON.stringify({ captures: [], folders: [], index: { activeId: null, unfiledCollapsed: false }, queue: [], history: [], settings: {} }), { status: 200 });
		}
		if (path.endsWith("/canonical/captures")) return new Response(JSON.stringify([]), { status: 200 });
		return new Response(JSON.stringify({}), { status: 201, headers: { "content-type": "application/json" } });
	};

	try {
		const runtime = createAppRuntime();
		await runtime.ready;
		runtime.state.captures = [{ id: "created-capture", name: "Created", messages: [], byteStream: [], frameSections: [{ start: 0, framingMode: "length", frameSize: 3 }] }];
		runtime.setActiveId("created-capture");
		requests.length = 0;
		runtime.saveState({ immediate: true });
		await new Promise(resolve => setTimeout(resolve, 0));

		const create = requests.find(request => request.path === "/api/captures");
		assert.deepEqual(create && { path: create.path, method: create.method }, { path: "/api/captures", method: "POST" });
		assert.equal(requests.some(request => request.path === "/api/captures/created-capture" && request.method === "PUT"), false);
		assert.equal((create?.body as { inputFormat?: string } | undefined)?.inputFormat, "binary");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

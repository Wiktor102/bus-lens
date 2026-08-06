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

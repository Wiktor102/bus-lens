import assert from "node:assert/strict";
import test from "node:test";
import { buildArchiveGroups } from "../src/features/archive/archive-list.ts";
import { captureStorageLabel, captureStorageUiStatus } from "../src/features/capture/capture-storage.ts";
import { createAppRuntime } from "../src/app/app-runtime.ts";

const captures = [
	{ id: "legacy", name: "Legacy", view: "", folderId: null, params: [], messageCount: 1, storageStatus: "legacy-not-canonicalized" as const },
	{ id: "converting", name: "Converting", view: "", folderId: null, params: [], messageCount: 1, storageStatus: "converting" as const },
	{ id: "canonical", name: "Canonical", view: "", folderId: null, params: [], messageCount: 1, storageStatus: "canonical" as const },
	{ id: "failed", name: "Failed", view: "", folderId: null, params: [], messageCount: 1, storageStatus: "canonicalization-failed" as const }
];

test("storage badges normalize the four visible capture states", () => {
	assert.equal(captureStorageLabel(captureStorageUiStatus("legacy-not-canonicalized")), "LEGACY");
	assert.equal(captureStorageLabel(captureStorageUiStatus("converting")), "CONVERTING");
	assert.equal(captureStorageLabel(captureStorageUiStatus("canonical")), "CANONICAL");
	assert.equal(captureStorageLabel(captureStorageUiStatus("canonicalization-failed")), "CONVERSION FAILED");
});

test("archive storage filters separate legacy, canonical, and failed captures", () => {
	const folders = [];
	assert.deepEqual(buildArchiveGroups(captures, folders, "", false, "legacy").visibleCaptures.map(capture => capture.id), ["legacy", "converting"]);
	assert.deepEqual(buildArchiveGroups(captures, folders, "", false, "canonical").visibleCaptures.map(capture => capture.id), ["canonical"]);
	assert.deepEqual(buildArchiveGroups(captures, folders, "", false, "failed").visibleCaptures.map(capture => capture.id), ["failed"]);
});

test("opening or querying a legacy capture does not implicitly canonicalize it", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<{ path: string; method: string }> = [];
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		requests.push({ path, method: init?.method || "GET" });
		if (path.endsWith("/health")) return new Response(null, { status: 204 });
		if (path.endsWith("/archive")) {
			return new Response(JSON.stringify({
				captures: [{ id: "legacy", document: { id: "legacy", name: "Legacy", messages: [], byteStream: [] } }],
				folders: [], index: { activeId: "legacy", unfiledCollapsed: false }, queue: [], history: [], settings: {}
			}), { status: 200 });
		}
		if (path.endsWith("/canonical/captures")) {
			return new Response(JSON.stringify([{ id: "legacy", status: "legacy-not-canonicalized", name: "Legacy", lifecycle: "finalized", byteCount: 0, createdAt: "now", updatedAt: "now", folderId: null }]), { status: 200 });
		}
		return new Response(null, { status: 204 });
	};
	try {
		const runtime = createAppRuntime();
		await runtime.ready;
		assert.equal(await runtime.ensureCanonicalCapture("legacy"), false);
		assert.equal(requests.some(request => request.path === "/api/captures" && request.method === "POST"), false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

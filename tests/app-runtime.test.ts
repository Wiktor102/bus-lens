import assert from "node:assert/strict";
import test from "node:test";
import { createAppRuntime } from "../src/app/app-runtime.ts";
import { createCaptureController } from "../src/features/capture/capture-controller.ts";
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
	const stored: AppState = {
		...emptyState(),
		captures: [{ id: "canonical", name: "Before", storageStatus: "canonical", params: [], messages: [], byteStream: [] }],
		activeId: "canonical"
	};
	const metadataCalls: string[] = [];
	const writer = {
		patchMetadata: async () => {
			metadataCalls.push("metadata");
			return { metadataRevision: 2, updatedAt: "now" };
		}
	};
	const archive = {
		ready: Promise.resolve(),
		commands: {
			hydrate: async () => ({
				index: {
					activeId: stored.activeId ?? null,
					unfiledCollapsed: false,
					captures: [{ id: "canonical", folderId: null, position: 0 }],
					folders: []
				},
				captures: stored.captures,
				folders: [],
				queue: [],
				history: [],
				settings: stored.sendSettings!,
				summaries: []
			}),
			recordingWriter: writer
		}
	} as unknown as ArchiveDataLayer;
	const runtime = createAppRuntime({ archive });
	await runtime.ready;
	assert.equal(runtime.getCaptureStorageStatus("canonical"), "canonical");
	assert.equal(runtime.isCanonicalCapture("canonical"), true);

	const controller = createCaptureController({
		state: runtime.state,
		capture: runtime.capture,
		getActiveId: runtime.getActiveId,
		setActiveId: runtime.setActiveId,
		saveState: () => { throw new Error("canonical rename used legacy persistence"); },
		render: () => {},
		renderMessages: () => {},
		showToast: () => {},
		confirm: () => true,
		transport: { isRecording: () => false, stopRecording: async () => {} },
		publishDialogCommand: () => {},
		captureWriter: runtime.captureWriter,
		isCanonicalCapture: runtime.isCanonicalCapture
	});

	controller.commitCaptureTitle("Renamed");
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(metadataCalls, ["metadata"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createAppRuntime } from "../src/app/app-runtime.ts";
import { createCaptureController } from "../src/features/capture/capture-controller.ts";
import type { ArchiveDataLayer } from "../src/data/archive-data-layer.ts";
import type { Capture } from "../src/features/capture/capture-framing.ts";

function capture(id: string): Capture {
	return { id, name: id, messages: [], byteStream: [], frameSections: [], notes: [], annotations: {} };
}

test("does not expose a mutable archive-wide state or generic persistence API", async () => {
	const runtime = createAppRuntime();

	assert.equal("state" in runtime, false);
	assert.equal("saveState" in runtime, false);
	assert.equal("persistState" in runtime, false);
	await runtime.ready;
	assert.equal(runtime.capture(), undefined);
});

test("hydrates the active capture through archive reads and named commands", async () => {
	const stored = capture("stored-capture");
	const archive = {
		ready: Promise.resolve(),
		reads: {
			index: () => ({ activeId: stored.id, unfiledCollapsed: true, captures: [{ id: stored.id, folderId: null, position: 0 }], folders: [] }),
			capture: () => undefined,
			captureSummaries: () => [],
			captures: () => [{ id: stored.id, name: stored.name, description: "", view: "", folderId: null, params: [], messageCount: 0 }],
			folders: () => [],
			queue: () => [],
			history: () => [],
			settings: () => ({ draft: "", delayMs: 100, baudRate: 115200 })
		},
		commands: {
			getCapture: async () => stored,
			recordingWriter: {}
		}
	} as unknown as ArchiveDataLayer;

	const runtime = createAppRuntime({ archive });
	await runtime.ready;

	assert.equal(runtime.getActiveId(), stored.id);
	assert.equal(runtime.capture()?.id, stored.id);
	assert.equal(runtime.getCapture(stored.id)?.id, stored.id);
});

test("waits for a named capture command before recording or canonicalization", async () => {
	let release!: () => void;
	const write = new Promise<void>(resolve => { release = resolve; });
	const runtime = createAppRuntime();
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

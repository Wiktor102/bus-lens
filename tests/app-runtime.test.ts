import assert from "node:assert/strict";
import test from "node:test";
import { createAppRuntime } from "../src/app/app-runtime.ts";
import { createCaptureController } from "../src/features/capture/capture-controller.ts";
import type { ArchiveDataLayer } from "../src/data/archive-data-layer.ts";
import type { Capture } from "../src/features/capture/capture-framing.ts";
import { applicationStore } from "../src/shared/application-store.ts";

function capture(id: string): Capture {
	return {
		id,
		name: id,
		description: "",
		view: "",
		baudRate: 115200,
		params: [],
		messages: [],
		byteStream: [],
		frameSections: [],
		notes: [],
		annotations: {},
		patternRemarks: {}
	};
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

test("renders an asynchronously selected capture after clearing the previous projection", async () => {
	applicationStore.send({ type: "capture/selected-changed", captureId: null });
	const first = capture("first");
	const second = capture("second");
	let releaseSecond!: (value: Capture) => void;
	const secondLoad = new Promise<Capture>(resolve => { releaseSecond = resolve; });
	const archive = {
		ready: Promise.resolve(),
		reads: {
			index: () => ({ activeId: first.id, unfiledCollapsed: false, captures: [
				{ id: first.id, folderId: null, position: 0 },
				{ id: second.id, folderId: null, position: 1 }
			], folders: [] }),
			capture: () => undefined,
			captureSummaries: () => [],
			captures: () => [first, second],
			folders: () => [],
			queue: () => [],
			history: () => [],
			settings: () => ({ draft: "", delayMs: 100, baudRate: 115200 })
		},
		commands: {
			getCapture: (captureId: string) => captureId === first.id ? Promise.resolve(first) : secondLoad,
			recordingWriter: {}
		}
	} as unknown as ArchiveDataLayer;
	const runtime = createAppRuntime({ archive });
	await runtime.ready;
	const renderedCaptureIds: Array<string | null> = [];
	const controller = createCaptureController({
		capture: runtime.capture,
		getActiveId: runtime.getActiveId,
		setActiveId: runtime.setActiveId,
		render: () => { renderedCaptureIds.push(runtime.capture()?.id ?? null); },
		renderMessages: () => {},
		showToast: () => {},
		confirm: () => true,
		transport: { isRecording: () => false, stopRecording: async () => {} },
		publishDialogCommand: () => {}
	});

	controller.selectArchiveCapture(second.id!);
	assert.equal(runtime.getActiveId(), second.id);
	assert.equal(runtime.capture(), undefined);
	assert.deepEqual(renderedCaptureIds, [null]);

	releaseSecond(second);
	await secondLoad;
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(runtime.capture()?.id, second.id);
	assert.deepEqual(renderedCaptureIds, [null, second.id]);
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
	applicationStore.send({ type: "capture/selected-changed", captureId: null });
	const stored = capture("canonical");
	stored.storageStatus = "canonical";
	const metadataCalls: string[] = [];
	const writer = {
		patchMetadata: async () => {
			metadataCalls.push("metadata");
			return { metadataRevision: 2, updatedAt: "now" };
		}
	};
	const archive = {
		ready: Promise.resolve(),
		reads: {
			index: () => ({ activeId: stored.id, unfiledCollapsed: false, captures: [{ id: stored.id, folderId: null, position: 0 }], folders: [] }),
			capture: () => stored,
			captureSummaries: () => [],
			captures: () => [{ id: stored.id, name: stored.name, description: "", view: "", folderId: null, params: [], messageCount: 0 }],
			folders: () => [],
			queue: () => [],
			history: () => [],
			settings: () => ({ draft: "", delayMs: 100, baudRate: 115200 })
		},
		commands: {
			getCapture: async () => stored,
			recordingWriter: writer
		}
	} as unknown as ArchiveDataLayer;
	const runtime = createAppRuntime({ archive });
	await runtime.ready;
	assert.equal(runtime.getCaptureStorageStatus("canonical"), "canonical");
	assert.equal(runtime.isCanonicalCapture("canonical"), true);

	const controller = createCaptureController({
		capture: runtime.capture,
		getCapture: runtime.getCapture,
		getCaptures: archive.reads.captures,
		getFolders: archive.reads.folders,
		getActiveId: runtime.getActiveId,
		setActiveId: runtime.setActiveId,
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

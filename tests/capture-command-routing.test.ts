import assert from "node:assert/strict";
import test from "node:test";
import { createCaptureController } from "../src/features/capture/capture-controller.ts";
import { createAppRuntime } from "../src/app/app-runtime.ts";
import type { Capture } from "../src/features/capture/capture-framing.ts";
import type { CaptureWriter } from "../src/persistence/archive-client.ts";
import type { AppState } from "../src/shared/app-state.ts";

test("canonical optimistic mutations route through dedicated commands", async () => {
	const capture: Capture = {
		id: "canonical",
		name: "Before",
		description: "",
		view: "",
		baudRate: 115200,
		inputFormat: "binary",
		storageStatus: "canonical",
		lifecycle: "finalized",
		dataRevision: 2,
		metadataRevision: 3,
		contentRevision: 4,
		activeFramingProfileId: "profile-1",
		byteStream: [
			{ rawOffset: 10, value: 1, timestamp: 1, direction: "rx" },
			{ rawOffset: 11, value: 2, timestamp: 2, direction: "rx" }
		],
		messages: [{ id: "frame-1", timestamp: 1, bytes: [1, 2], rawOffsets: [10, 11], _rawPositions: [10, 11] }],
		frameSections: [{ id: "section-1", start: 10, framingMode: "length", frameSize: 2 }],
		params: [],
		notes: [],
		annotations: {},
		patternRemarks: {}
	};
	const calls: string[] = [];
	const writer = {
		patchMetadata: async () => {
			calls.push("metadata");
			return { ...capture, captureId: "canonical", metadataRevision: 4, parameters: [], storage: { captureId: "canonical", status: "canonical", updatedAt: "now", lastError: null }, sessions: [], draft: null, byteVisibility: [], frameVisibility: [], notes: [], activeProfile: null, byteCount: 2, createdAt: "now", updatedAt: "now", controllerView: "", folderId: null };
		},
		createNote: async () => {
			calls.push("note");
			return { note: { id: "stable-note", captureId: "canonical", text: "observation", createdAt: "now", updatedAt: null, target: { kind: "capture" as const } }, contentRevision: 5 };
		},
		reframe: async () => {
			calls.push("reframe");
			return { captureId: "canonical", profileId: "profile-2", version: 2, sourceDataRevision: 2, retainedStartOffset: 0, verified: true };
		},
		clearData: async () => {
			calls.push("clear");
			return { captureId: "canonical", dataRevision: 3, contentRevision: 6, clearedByteCount: 2 };
		}
	} as unknown as CaptureWriter;
	const state = { captures: [capture], folders: [], unfiledCollapsed: false } as unknown as AppState;
	const controller = createCaptureController({
		state,
		capture: () => capture,
		getActiveId: () => "canonical",
		setActiveId: () => {},
		saveState: () => { throw new Error("canonical mutation used generic saveState"); },
		render: () => {},
		renderMessages: () => {},
		showToast: () => {},
		confirm: () => true,
		transport: { isRecording: () => false, stopRecording: async () => {} },
		publishArchiveState: () => {},
		publishCaptureHeaderState: () => {},
		publishNotesState: () => {},
		publishDialogCommand: () => {},
		captureWriter: writer,
		isCanonicalCapture: () => true,
		refreshCapture: async () => capture,
		reportPersistenceFailure: (_captureId, error) => { throw error; }
	});

	controller.commitCaptureTitle("After");
	controller.addSequenceNote({ start: 1, end: 1, text: "observation" });
	controller.setSectionFrameSize("section-1", 1);
	controller.clearActiveCaptureMessages();
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.deepEqual(calls.sort(), ["clear", "metadata", "note", "reframe"]);
	assert.equal(capture.metadataRevision, 4);
	assert.equal(capture.notes?.[0]?.id, "stable-note");
	assert.equal(capture.activeFramingProfileId, "profile-2");
	assert.deepEqual(capture.byteStream, []);
});

test("serializes metadata and framing revisions while coalescing the latest optimistic state", async () => {
	const capture: Capture = {
		id: "queued-capture",
		name: "Before",
		description: "",
		view: "",
		baudRate: 115200,
		inputFormat: "binary",
		storageStatus: "canonical",
		lifecycle: "finalized",
		dataRevision: 2,
		metadataRevision: 0,
		contentRevision: 4,
		framingDraftRevision: 0,
		activeFramingProfileId: "profile-1",
		byteStream: [
			{ rawOffset: 0, value: 1, timestamp: 1, direction: "rx" },
			{ rawOffset: 1, value: 2, timestamp: 2, direction: "rx" }
		],
		messages: [{ id: "frame-1", timestamp: 1, bytes: [1, 2], rawOffsets: [0, 1], _rawPositions: [0, 1] }],
		frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 2 }],
		params: [],
		notes: [],
		annotations: {},
		patternRemarks: {}
	};
	const metadataRequests: Array<{ expectedMetadataRevision?: number; patch: Record<string, unknown> }> = [];
	const framingRequests: Array<{ expectedRevision?: number; sections: readonly Record<string, unknown>[] }> = [];
	let releaseMetadata!: (value: { metadataRevision: number; updatedAt: string }) => void;
	let releaseFraming!: (value: { revision: number; sections: readonly Record<string, unknown>[]; updatedAt: string }) => void;
	const firstMetadata = new Promise<{ metadataRevision: number; updatedAt: string }>(resolve => { releaseMetadata = resolve; });
	const firstFraming = new Promise<{ revision: number; sections: readonly Record<string, unknown>[]; updatedAt: string }>(resolve => { releaseFraming = resolve; });
	const writer = {
		patchMetadata: (request: { expectedMetadataRevision?: number; patch: Record<string, unknown> }) => {
			metadataRequests.push(request);
			return metadataRequests.length === 1
				? firstMetadata
				: Promise.resolve({ metadataRevision: 2, updatedAt: "metadata-2" });
		},
		updateFramingDraft: (request: { expectedRevision?: number; sections: readonly Record<string, unknown>[] }) => {
			framingRequests.push(request);
			return framingRequests.length === 1
				? firstFraming
				: Promise.resolve({ revision: 2, sections: request.sections, updatedAt: "framing-2" });
		}
	} as unknown as CaptureWriter;
	const state = { captures: [capture], folders: [], unfiledCollapsed: false } as unknown as AppState;
	const controller = createCaptureController({
		state,
		capture: () => capture,
		getActiveId: () => "queued-capture",
		setActiveId: () => {},
		saveState: () => { throw new Error("canonical mutation used generic saveState"); },
		render: () => {},
		renderMessages: () => {},
		showToast: () => {},
		confirm: () => true,
		transport: { isRecording: () => true, stopRecording: async () => {} },
		publishArchiveState: () => {},
		publishCaptureHeaderState: () => {},
		publishNotesState: () => {},
		publishDialogCommand: () => {},
		captureWriter: writer,
		isCanonicalCapture: () => true,
		refreshCapture: async () => capture,
		reportPersistenceFailure: (_captureId, error) => { throw error; }
	});

	controller.commitCaptureTitle("Title");
	controller.commitCaptureDescription("Description");
	assert.equal(metadataRequests.length, 1);
	assert.equal(metadataRequests[0]?.expectedMetadataRevision, 0);
	releaseMetadata({ metadataRevision: 1, updatedAt: "metadata-1" });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(metadataRequests.length, 2);
	assert.equal(metadataRequests[1]?.expectedMetadataRevision, 1);
	assert.equal(metadataRequests[1]?.patch.name, "Title");
	assert.equal(metadataRequests[1]?.patch.description, "Description");
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(capture.metadataRevision, 2);

	controller.setSectionFrameSize("section-1", 1);
	controller.setSectionFrameSize("section-1", 4);
	assert.equal(framingRequests.length, 1);
	assert.equal(framingRequests[0]?.expectedRevision, 0);
	assert.equal(framingRequests[0]?.sections[0]?.frameSize, 1);
	releaseFraming({ revision: 1, sections: framingRequests[0]?.sections || [], updatedAt: "framing-1" });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(framingRequests.length, 2);
	assert.equal(framingRequests[1]?.expectedRevision, 1);
	assert.equal(framingRequests[1]?.sections[0]?.frameSize, 4);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(capture.framingDraftRevision, 2);
});

test("awaits active recording shutdown before deleting a canonical capture", async () => {
	const capture: Capture = {
		id: "delete-after-stop",
		name: "Delete after stop",
		messages: [],
		byteStream: [],
		frameSections: [],
		params: [],
		notes: [],
		annotations: {},
		patternRemarks: {},
		storageStatus: "canonical"
	};
	const state = { captures: [capture], folders: [], unfiledCollapsed: false } as unknown as AppState;
	let activeId: string | null = capture.id!;
	let releaseStop!: () => void;
	const calls: string[] = [];
	const stop = new Promise<void>(resolve => { releaseStop = resolve; });
	const writer = { delete: async () => { calls.push("delete"); } } as unknown as CaptureWriter;
	const controller = createCaptureController({
		state,
		capture: () => capture,
		getActiveId: () => activeId,
		setActiveId: id => { activeId = id ? String(id) : null; },
		saveState: () => {},
		render: () => {},
		renderMessages: () => {},
		showToast: () => {},
		confirm: () => true,
		transport: { isRecording: () => true, stopRecording: () => { calls.push("stop"); return stop; } },
		publishArchiveState: () => {},
		publishCaptureHeaderState: () => {},
		publishNotesState: () => {},
		publishDialogCommand: () => {},
		captureWriter: writer,
		isCanonicalCapture: () => true
	});

	const deletion = controller.deleteArchiveCapture(capture.id!);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(calls, ["stop"]);
	assert.deepEqual(state.captures, [capture]);
	assert.equal(activeId, capture.id);

	releaseStop();
	await deletion;
	assert.deepEqual(calls, ["stop", "delete"]);
	assert.deepEqual(state.captures, []);
	assert.equal(activeId, null);
});

test("keeps a canonical capture when recording shutdown fails", async () => {
	const capture: Capture = {
		id: "delete-stop-failed",
		name: "Keep recovery",
		messages: [],
		byteStream: [],
		frameSections: [],
		params: [],
		notes: [],
		annotations: {},
		patternRemarks: {},
		storageStatus: "canonical"
	};
	const state = { captures: [capture], folders: [], unfiledCollapsed: false } as unknown as AppState;
	let activeId: string | null = capture.id!;
	let deleteCalls = 0;
	const writer = { delete: async () => { deleteCalls++; } } as unknown as CaptureWriter;
	const controller = createCaptureController({
		state,
		capture: () => capture,
		getActiveId: () => activeId,
		setActiveId: id => { activeId = id ? String(id) : null; },
		saveState: () => {},
		render: () => {},
		renderMessages: () => {},
		showToast: () => {},
		confirm: () => true,
		transport: { isRecording: () => false, stopRecording: async () => { throw new Error("finalize failed"); } },
		publishArchiveState: () => {},
		publishCaptureHeaderState: () => {},
		publishNotesState: () => {},
		publishDialogCommand: () => {},
		captureWriter: writer,
		isCanonicalCapture: () => true
	});

	await controller.deleteArchiveCapture(capture.id!);
	assert.equal(deleteCalls, 0);
	assert.deepEqual(state.captures, [capture]);
	assert.equal(activeId, capture.id);
});

test("new capture creation uses runtime bookkeeping and does not replay the create", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<{ path: string; method: string; body?: unknown }> = [];
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		requests.push({
			path,
			method: init?.method || "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined
		});
		if (path.endsWith("/health")) return new Response(null, { status: 204 });
		if (path.endsWith("/archive")) {
			return new Response(JSON.stringify({ captures: [], folders: [], index: { activeId: null, unfiledCollapsed: false }, queue: [], history: [], settings: {} }), { status: 200 });
		}
		if (path.endsWith("/canonical/captures")) return new Response(JSON.stringify([]), { status: 200 });
		if (path.endsWith("/captures") && (init?.method || "GET") === "POST") return new Response(JSON.stringify({}), { status: 201 });
		return new Response(null, { status: 204 });
	};

	try {
		const runtime = createAppRuntime();
		await runtime.ready;
		runtime.state.captures = [];
		runtime.setActiveId(null);
		const controller = createCaptureController({
			state: runtime.state,
			capture: runtime.capture,
			getActiveId: runtime.getActiveId,
			setActiveId: runtime.setActiveId,
			saveState: runtime.saveState,
			render: () => {},
			renderMessages: () => {},
			showToast: () => {},
			confirm: () => true,
			transport: { isRecording: () => false, stopRecording: async () => {} },
			publishArchiveState: () => {},
			publishCaptureHeaderState: () => {},
			publishNotesState: () => {},
			publishDialogCommand: () => {},
			captureWriter: runtime.captureWriter,
			isCanonicalCapture: runtime.isCanonicalCapture
		});

		assert.equal(controller.commitContextDraft({
			mode: "new",
			captureId: null,
			draft: { name: "Created", view: "Main", folderId: "", baudRate: "115200", parameters: [] }
		}), true);

		const captureId = String(runtime.state.captures[0]?.id);
		await runtime.waitForCaptureWrite(captureId);
		const initialCreates = requests.filter(request => request.path === "/api/captures" && request.method === "POST");
		const initialIndexes = requests.filter(request => request.path === "/api/archive-index" && request.method === "PUT");
		assert.equal(initialCreates.length, 1);
		assert.equal(initialIndexes.length, 1);
		assert.equal((initialIndexes[0]?.body as { activeId?: string } | undefined)?.activeId, captureId);
		assert.deepEqual((initialIndexes[0]?.body as { activeId?: string; captures?: unknown[] } | undefined)?.captures, [{ id: captureId, folderId: null, position: 0 }]);

		runtime.saveState({ immediate: true });
		await runtime.waitForCaptureWrite(captureId);
		assert.equal(requests.filter(request => request.path === "/api/captures" && request.method === "POST").length, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

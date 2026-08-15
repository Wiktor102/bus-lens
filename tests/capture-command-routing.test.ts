import assert from "node:assert/strict";
import test from "node:test";
import { createCaptureController } from "../src/features/capture/capture-controller.ts";
import { createAppRuntime } from "../src/app/app-runtime.ts";
import { createSnapshotRuntime } from "../src/app/snapshot-runtime.ts";
import { getMessageStreamSnapshot } from "../src/features/message-stream/message-stream-bridge.ts";
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

test("canonical storage state wins when the status lookup is stale during rename", async () => {
	const capture: Capture = {
		id: "canonical-rename",
		name: "Before",
		storageStatus: "canonical",
		metadataRevision: 1,
		messages: [],
		byteStream: [],
		frameSections: [],
		params: [],
		notes: [],
		annotations: {},
		patternRemarks: {}
	};
	const calls: string[] = [];
	const writer = {
		patchMetadata: async () => {
			calls.push("metadata");
			return { metadataRevision: 2, updatedAt: "now" };
		}
	} as unknown as CaptureWriter;
	const state = { captures: [capture], folders: [], unfiledCollapsed: false } as unknown as AppState;
	const controller = createCaptureController({
		state,
		capture: () => capture,
		getActiveId: () => capture.id,
		setActiveId: () => {},
		saveState: () => { throw new Error("canonical rename used legacy persistence"); },
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
		isCanonicalCapture: () => false
	});

	controller.commitCaptureTitle("After");
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.deepEqual(calls, ["metadata"]);
	assert.equal(capture.metadataRevision, 2);
});

test("reloads server-owned frame IDs after canonical reframing", async () => {
	const capture: Capture = {
		id: "reframe-frame-ids",
		name: "Reframe IDs",
		storageStatus: "canonical",
		lifecycle: "finalized",
		dataRevision: 1,
		activeFramingProfileId: "profile-1",
		byteStream: [
			{ rawOffset: 0, value: 1, timestamp: 1, direction: "rx" },
			{ rawOffset: 1, value: 2, timestamp: 2, direction: "rx" }
		],
		messages: [{ id: "browser-frame-1", timestamp: 1, bytes: [1, 2], rawOffsets: [0, 1], _rawPositions: [0, 1] }],
		frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 2 }],
		params: [],
		notes: [],
		annotations: {},
		patternRemarks: {}
	};
	const serverCapture: Capture = {
		...capture,
		activeFramingProfileId: "profile-2",
		frameSections: [{ id: "server-section-2", start: 0, framingMode: "length", frameSize: 1 }],
		messages: [
			{ id: "server-frame-1", timestamp: 1, bytes: [1], rawOffsets: [0], _rawPositions: [0] },
			{ id: "server-frame-2", timestamp: 2, bytes: [2], rawOffsets: [1], _rawPositions: [1] }
		]
	};
	const state = { captures: [capture], folders: [], unfiledCollapsed: false } as unknown as AppState;
	let refreshCount = 0;
	const snapshots = createSnapshotRuntime({
		state,
		capture: () => state.captures[0],
		getActiveId: () => capture.id,
		getTransport: () => ({ getPort: () => null, isRecording: () => false, publishState: () => {} }),
		getSendController: () => ({ getStatus: () => ({ sendInFlight: false, queueRunning: false, stopQueueRequested: false }) })
	});
	const writer = {
		reframe: async () => ({ captureId: capture.id!, profileId: "profile-2", version: 2, sourceDataRevision: 1, retainedStartOffset: 0, verified: true })
	} as unknown as CaptureWriter;
	const controller = createCaptureController({
		state,
		capture: () => state.captures[0],
		getActiveId: () => capture.id,
		setActiveId: () => {},
		saveState: () => { throw new Error("canonical mutation used generic saveState"); },
		render: snapshots.render,
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
		refreshCapture: async () => {
			refreshCount += 1;
			state.captures[0] = serverCapture;
			return serverCapture;
		},
		reportPersistenceFailure: (_captureId, error) => { throw error; }
	});

	controller.setSectionFrameSize("section-1", 1);
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.equal(refreshCount, 1);
	assert.equal(state.captures[0]?.activeFramingProfileId, "profile-2");
	assert.deepEqual(state.captures[0]?.messages?.map(message => message.id), ["server-frame-1", "server-frame-2"]);
	assert.deepEqual(
		getMessageStreamSnapshot().entries
			.filter(entry => entry.type === "message")
			.map(entry => entry.row.id),
		["server-frame-1", "server-frame-2"]
	);
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

test("retries a failed metadata revision without losing the latest optimistic patch", async () => {
	const capture: Capture = {
		id: "retry-capture",
		name: "Before",
		description: "before",
		view: "",
		baudRate: 115200,
		metadataRevision: 0,
		messages: [],
		byteStream: [],
		frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 2 }],
		params: [],
		notes: [],
		annotations: {},
		patternRemarks: {},
		storageStatus: "canonical"
	};
	const state = { captures: [capture], folders: [], unfiledCollapsed: false } as unknown as AppState;
	const metadataRequests: Array<{ expectedMetadataRevision?: number; patch: Record<string, unknown> }> = [];
	let rejectFirst!: (error: Error) => void;
	const firstRequest = new Promise<{ metadataRevision: number; updatedAt: string }>((_resolve, reject) => { rejectFirst = reject; });
	const writer = {
		patchMetadata: (request: { expectedMetadataRevision?: number; patch: Record<string, unknown> }) => {
			metadataRequests.push(request);
			return metadataRequests.length === 1
				? firstRequest
				: Promise.resolve({ metadataRevision: 1, updatedAt: "retried" });
		}
	} as unknown as CaptureWriter;
	const errors: unknown[] = [];
	const controller = createCaptureController({
		state,
		capture: () => state.captures[0],
		getActiveId: () => capture.id,
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
		refreshCapture: async () => {
			const reloaded = { ...capture, name: "Server name", description: "Server description", metadataRevision: 0 };
			state.captures[0] = reloaded;
			return reloaded;
		},
		reportPersistenceFailure: (_captureId, error) => errors.push(error)
	});

	controller.commitCaptureTitle("Latest title");
	controller.commitCaptureDescription("Latest description");
	rejectFirst(new Error("stale metadata revision"));
	await new Promise(resolve => setTimeout(resolve, 0));
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.equal(metadataRequests.length, 2);
	assert.equal(metadataRequests[1]?.expectedMetadataRevision, 0);
	assert.equal(metadataRequests[1]?.patch.name, "Latest title");
	assert.equal(metadataRequests[1]?.patch.description, "Latest description");
	assert.equal(state.captures[0]?.metadataRevision, 1);
	assert.equal(state.captures[0]?.name, "Latest title");
	assert.equal(state.captures[0]?.description, "Latest description");
	assert.deepEqual(errors, []);
});

test("uses reloaded annotation note IDs for canonical update and delete commands", async () => {
	const capture: Capture = {
		id: "reloaded-annotation",
		name: "Annotated",
		activeFramingProfileId: "profile-1",
		messages: [{ id: "frame-1", timestamp: 1, bytes: [1, 2], rawOffsets: [10, 11], _rawPositions: [10, 11] }],
		byteStream: [
			{ rawOffset: 10, value: 1, timestamp: 1, direction: "rx" },
			{ rawOffset: 11, value: 2, timestamp: 2, direction: "rx" }
		],
		frameSections: [{ id: "section-1", start: 10, framingMode: "length", frameSize: 2 }],
		params: [],
		notes: [],
		annotations: {
			"frame-1": { noteId: "stable-frame-note", text: "before", type: "message", createdAt: 1 }
		},
		patternRemarks: {},
		storageStatus: "canonical"
	};
	const calls: string[] = [];
	const writer = {
		createNote: async () => { throw new Error("reloaded annotation must not be created again"); },
		updateNote: async (request: { noteId: string; text?: unknown }) => {
			calls.push(`update:${request.noteId}`);
			return {
				note: { id: request.noteId, captureId: capture.id!, text: String(request.text), createdAt: "now", updatedAt: "now", target: { kind: "capture" as const } },
				contentRevision: 2
			};
		},
		deleteNote: async (request: { noteId: string }) => { calls.push(`delete:${request.noteId}`); }
	} as unknown as CaptureWriter;
	const state = { captures: [capture], folders: [], unfiledCollapsed: false } as unknown as AppState;
	const controller = createCaptureController({
		state,
		capture: () => capture,
		getActiveId: () => capture.id,
		setActiveId: () => {},
		saveState: () => { throw new Error("canonical annotation used generic saveState"); },
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
		refreshCapture: async () => capture
	});

	assert.equal(controller.commitAnnotationDraft({ captureId: capture.id!, annotationType: "message", key: "frame-1", text: "after" }), true);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(calls, ["update:stable-frame-note"]);
	assert.equal((capture.annotations?.["frame-1"] as { noteId?: string }).noteId, "stable-frame-note");

	controller.removeAnnotationDraft({ captureId: capture.id!, annotationType: "message", key: "frame-1" });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(calls, ["update:stable-frame-note", "delete:stable-frame-note"]);
});

test("routes canonical pattern remarks and folder changes through commands", async () => {
	const capture: Capture = {
		id: "canonical-folder-capture",
		name: "Canonical",
		description: "",
		view: "",
		baudRate: 115200,
		metadataRevision: 0,
		folderId: "folder-1",
		messages: [],
		byteStream: [],
		frameSections: [],
		params: [],
		notes: [],
		annotations: {},
		patternRemarks: {},
		storageStatus: "canonical"
	};
	const state = {
		captures: [capture],
		folders: [{ id: "folder-1", name: "To delete", collapsed: false, createdAt: "now" }],
		unfiledCollapsed: false
	} as unknown as AppState;
	const noteCalls: string[] = [];
	const metadataRequests: Array<{ patch: Record<string, unknown>; expectedMetadataRevision?: number }> = [];
	const writer = {
		createNote: async (request: { text: string; target: { kind: string; sequenceKey?: string } }) => {
			noteCalls.push(`create:${request.target.kind}:${request.target.sequenceKey}`);
			return {
				note: { id: "pattern-note", captureId: capture.id!, text: request.text, createdAt: "now", updatedAt: null, target: { kind: "pattern" as const, sequenceKey: request.target.sequenceKey! } },
			contentRevision: 1
		};
		},
		updateNote: async (request: { noteId: string; text?: string }) => {
			noteCalls.push(`update:${request.noteId}`);
			return {
				note: { id: request.noteId, captureId: capture.id!, text: request.text || "", createdAt: "now", updatedAt: "now", target: { kind: "pattern" as const, sequenceKey: "AA" } },
			contentRevision: 2
		};
		},
		deleteNote: async (request: { noteId: string }) => { noteCalls.push(`delete:${request.noteId}`); },
		patchMetadata: async (request: { patch: Record<string, unknown>; expectedMetadataRevision?: number }) => {
			metadataRequests.push(request);
			return { metadataRevision: (request.expectedMetadataRevision ?? 0) + 1, updatedAt: "metadata-updated" };
		}
	} as unknown as CaptureWriter;
	const controller = createCaptureController({
		state,
		capture: () => capture,
		getActiveId: () => capture.id,
		setActiveId: () => {},
		saveState: () => {},
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
		refreshCapture: async () => capture
	});

	assert.equal(controller.commitPatternRemarkDraft({ captureId: capture.id!, patternKey: "AA", text: "first" }), true);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(noteCalls, ["create:pattern:AA"]);
	assert.equal((capture.patternRemarks?.AA as { noteId?: string }).noteId, "pattern-note");

	controller.commitPatternRemarkDraft({ captureId: capture.id!, patternKey: "AA", text: "second" });
	await new Promise(resolve => setTimeout(resolve, 0));
	controller.commitPatternRemarkDraft({ captureId: capture.id!, patternKey: "AA", text: "" });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(noteCalls, ["create:pattern:AA", "update:pattern-note", "delete:pattern-note"]);
	assert.equal(capture.patternRemarks?.AA, undefined);

	controller.deleteFolder("folder-1");
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(metadataRequests.length, 1);
	assert.equal(metadataRequests[0]?.expectedMetadataRevision, 0);
	assert.equal(metadataRequests[0]?.patch.folderId, null);
	assert.equal(capture.folderId, null);
});

test("serializes rapid canonical pattern remark intent without duplicate notes", async () => {
	const capture: Capture = {
		id: "pattern-queue-capture",
		name: "Canonical",
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
	const calls: string[] = [];
	let releaseCreate!: (result: { note: { id: string }; contentRevision: number }) => void;
	const createResult = new Promise<{ note: { id: string }; contentRevision: number }>(resolve => { releaseCreate = resolve; });
	const errors: unknown[] = [];
	const writer = {
		createNote: (request: { text: string }) => {
			calls.push(`create:${request.text}`);
			return createResult;
		},
		updateNote: async (request: { noteId: string; text?: string }) => {
			calls.push(`update:${request.noteId}:${request.text}`);
			return { note: { id: request.noteId }, contentRevision: 2 };
		},
		deleteNote: async (request: { noteId: string }) => { calls.push(`delete:${request.noteId}`); }
	} as unknown as CaptureWriter;
	const controller = createCaptureController({
		state,
		capture: () => capture,
		getActiveId: () => capture.id,
		setActiveId: () => {},
		saveState: () => { throw new Error("canonical pattern mutation used generic saveState"); },
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
		reportPersistenceFailure: (_captureId, error) => errors.push(error)
	});

	controller.commitPatternRemarkDraft({ captureId: capture.id!, patternKey: "AA", text: "first" });
	controller.commitPatternRemarkDraft({ captureId: capture.id!, patternKey: "AA", text: "latest" });
	assert.deepEqual(calls, ["create:first"]);

	releaseCreate({ note: { id: "stable-pattern-note" }, contentRevision: 1 });
	await new Promise(resolve => setTimeout(resolve, 0));
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(calls, ["create:first", "update:stable-pattern-note:latest"]);

	controller.commitPatternRemarkDraft({ captureId: capture.id!, patternKey: "AA", text: "" });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(calls, ["create:first", "update:stable-pattern-note:latest", "delete:stable-pattern-note"]);
	assert.equal(capture.patternRemarks?.AA, undefined);
	assert.deepEqual(errors, []);
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

test("holds canonical metadata writes until a new capture is acknowledged", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<{ path: string; method: string; body?: unknown }> = [];
	let releaseCreate!: (response: Response) => void;
	const createResponse = new Promise<Response>(resolve => { releaseCreate = resolve; });
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
		if (path.endsWith("/captures") && (init?.method || "GET") === "POST") return createResponse;
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
			isCanonicalCapture: runtime.isCanonicalCapture,
			waitForCaptureWrite: runtime.waitForCaptureWrite
		});

		assert.equal(controller.commitContextDraft({
			mode: "new",
			captureId: null,
			draft: { name: "Created", view: "Main", folderId: "", baudRate: "115200", parameters: [] }
		}), true);
		const captureId = String(runtime.state.captures[0]?.id);
		await new Promise(resolve => setTimeout(resolve, 0));
		controller.commitCaptureTitle("Edited before create acknowledgement");
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(requests.filter(request => request.path.endsWith(`/captures/${captureId}/metadata`)).length, 0);

		releaseCreate(new Response(JSON.stringify({}), { status: 201 }));
		await runtime.waitForCaptureWrite(captureId);
		await new Promise(resolve => setTimeout(resolve, 0));
		const metadataRequest = requests.find(request => request.path.endsWith(`/captures/${captureId}/metadata`));
		assert.equal(metadataRequest?.method, "PATCH");
		assert.equal((metadataRequest?.body as { patch?: { name?: string } } | undefined)?.patch?.name, "Edited before create acknowledgement");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

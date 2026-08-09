import assert from "node:assert/strict";
import test from "node:test";
import { createCaptureController } from "../src/features/capture/capture-controller.ts";
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

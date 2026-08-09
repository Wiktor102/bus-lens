import assert from "node:assert/strict";
import test from "node:test";
import { createCaptureController } from "../src/features/capture/capture-controller.ts";
import type { Capture } from "../src/features/capture/capture-framing.ts";
import type { AppState } from "../src/shared/app-state.ts";

test("does not turn an edit-context click event into a new capture", () => {
	const original = {
		id: "capture-1",
		name: "Original capture",
		view: "Overview",
		params: [{ key: "Speed", value: "1" }],
		baudRate: 115200,
		messages: [{ id: "message-1", bytes: [0xaa, 0xbb], timestamp: 1 }],
		byteStream: [
			{ value: 0xaa, timestamp: 1, direction: "rx" },
			{ value: 0xbb, timestamp: 1, direction: "rx" }
		],
		notes: []
	} as Capture;
	const state = { captures: [original], folders: [], activeId: original.id } as AppState;
	let published: unknown;
	const controller = createCaptureController({
		state,
		capture: () => original,
		getActiveId: () => original.id,
		setActiveId: () => {},
		saveState: () => {},
		render: () => {},
		renderMessages: () => {},
		showToast: () => {},
		confirm: () => true,
		transport: { isRecording: () => false, stopRecording: () => {} },
		publishArchiveState: () => {},
		publishCaptureHeaderState: () => {},
		publishNotesState: () => {},
		publishDialogCommand: command => {
			published = command;
		}
	});

	// React passes its click event to a handler when a function reference is used.
	controller.publishContextDialog({ type: "click" } as unknown as boolean);

	assert.deepEqual(published, {
		type: "context",
		mode: "edit",
		captureId: "capture-1",
		name: "Original capture",
		view: "Overview",
		folderId: null,
		baudRate: 115200,
		params: [{ key: "Speed", value: "1" }],
		folders: []
	});

	const saved = controller.commitContextDraft({
		mode: "edit",
		captureId: "capture-1",
		draft: {
			name: "Edited capture",
			view: "Details",
			folderId: "",
			baudRate: "9600",
			parameters: []
		}
	});

	assert.equal(saved, true);
	assert.equal(state.captures.length, 1);
	assert.equal(state.captures[0], original);
	assert.equal(original.name, "Edited capture");
	assert.equal(original.view, "Details");
	assert.equal(original.baudRate, 9600);
	assert.deepEqual(original.messages, [{ id: "message-1", bytes: [0xaa, 0xbb], timestamp: 1 }]);
	assert.deepEqual(original.byteStream, [
		{ value: 0xaa, timestamp: 1, direction: "rx" },
		{ value: 0xbb, timestamp: 1, direction: "rx" }
	]);
});

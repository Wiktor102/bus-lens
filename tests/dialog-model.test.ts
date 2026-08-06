import assert from "node:assert/strict";
import test from "node:test";
import {
	appendContextParameter,
	annotationTextIsValid,
	annotationTargetLabel,
	contextDraftToValues,
	createContextDraft,
	normalizeAnnotationText,
	normalizePatternRemarkText,
	removeContextParameter,
	updateContextParameter
} from "../src/features/dialogs/dialog-model.ts";

test("builds context drafts without mutating the open command", () => {
	const command = {
		type: "context" as const,
		requestId: 1,
		mode: "edit" as const,
		captureId: "capture-1",
		name: "Overview",
		view: "Temperature",
		folderId: "folder-1",
		baudRate: 115200,
		params: [],
		folders: []
	};
	const draft = createContextDraft(command);

	assert.deepEqual(draft.parameters, [{ id: "parameter-0", key: "Speed", value: "" }]);
	const added = appendContextParameter(draft.parameters, () => "parameter-1");
	const updated = updateContextParameter(added, "parameter-1", { key: " Mode ", value: " safe " });
	const removed = removeContextParameter(updated, "parameter-0");
	assert.deepEqual(contextDraftToValues({ ...draft, parameters: removed, name: "  " }), {
		name: "Untitled capture",
		view: "Temperature",
		folderId: "folder-1",
		params: [{ key: "Mode", value: "safe" }],
		baudRate: 115200,
		inputFormat: "raw"
	});
	assert.deepEqual(command.params, []);
});

test("normalizes annotation drafts and labels a raw byte by its visible position", () => {
	const capture = {
		messages: [
			{
				id: "message-1",
				timestamp: 100,
				bytes: [0xaa, 0xbb, 0xcc],
				hiddenBytes: [false, true, false]
			}
		]
	} as never;
	const details = annotationTargetLabel(capture, "byte", "message-1:2");

	assert.equal(annotationTextIsValid("  note "), true);
	assert.equal(annotationTextIsValid(" \n\t"), false);
	assert.equal(normalizeAnnotationText("  note \n"), "note");
	assert.equal(normalizePatternRemarkText("  exchange  "), "exchange");
	assert.deepEqual(details, {
		title: "Note on byte 2",
		target: "AA CC · BYTE 2",
		targetKey: "message-1:2",
		displayPosition: 1
	});
});

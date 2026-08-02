import assert from "node:assert/strict";
import test from "node:test";
import {
	appendContextParameter,
	appendSectionDraft,
	annotationTextIsValid,
	annotationTargetLabel,
	contextDraftToValues,
	createContextDraft,
	createSectionsDraft,
	normalizeAnnotationText,
	normalizePatternRemarkText,
	removeContextParameter,
	removeSectionDraft,
	serializeSectionDrafts,
	updateContextParameter,
	updateSectionDraft
} from "../src/dialog-model.ts";

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

test("keeps section drafts string-valued until save and validates starts", () => {
	const rows = createSectionsDraft([
		{ id: "first", start: 0, frameSize: 2, collapseRuns: true },
		{ id: "second", start: 3, frameSize: 4, collapseRuns: false }
	]);
	const appended = appendSectionDraft(rows, 8, 3, () => "third");
	assert.equal(appended?.at(-1)?.start, "5");
	const edited = updateSectionDraft(appended!, "third", { start: "9", frameSize: "0" });
	const serialized = serializeSectionDrafts(edited, 7, 3);
	assert.deepEqual(serialized, {
		ok: true,
		sections: [
			{ id: "first", start: 0, frameSize: 2, collapseRuns: true },
			{ id: "second", start: 3, frameSize: 4, collapseRuns: false },
			{ id: "third", start: 7, frameSize: 3, collapseRuns: false }
		]
	});
	assert.deepEqual(serializeSectionDrafts([{ ...rows[1], start: "1" }, { ...rows[0], start: "1" }], 7, 3), {
		ok: false,
		error: "Each section must start at a different raw byte"
	});
	assert.deepEqual(removeSectionDraft(rows, "first"), [rows[1]]);
	assert.equal(removeSectionDraft([rows[0]], "first"), null);
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

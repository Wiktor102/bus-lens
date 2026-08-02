import assert from "node:assert/strict";
import test from "node:test";
import { deriveNotesSnapshot } from "../src/notes.ts";
import type { Capture } from "../src/capture-framing.ts";

test("derives sorted sequence, byte, and message note cards", () => {
	const snapshot = deriveNotesSnapshot({
		id: "capture-1",
		notes: [
			{ id: "sequence", type: "sequence", text: "Sequence note", createdAt: 20, targetLabel: "rows 2–4" }
		],
		annotations: {
			"message-1": { text: "Message note", createdAt: 30, targetLabel: "AA 01" },
			"message-1:0": { text: "Byte note", createdAt: 10, targetLabel: "AA 01 · byte 1" }
		}
	} as Capture);

	assert.equal(snapshot.count, 3);
	assert.deepEqual(snapshot.notes, [
		{ id: "message-1", label: "MESSAGE", text: "Message note", createdAt: 30, targetLabel: "AA 01" },
		{ id: "sequence", label: "SEQUENCE", text: "Sequence note", createdAt: 20, targetLabel: "rows 2–4" },
		{ id: "message-1:0", label: "BYTE", text: "Byte note", createdAt: 10, targetLabel: "AA 01 · byte 1" }
	]);
});

test("returns an empty snapshot without a selected capture", () => {
	assert.deepEqual(deriveNotesSnapshot(undefined), {
		captureId: null,
		count: 0,
		notes: []
	});
});

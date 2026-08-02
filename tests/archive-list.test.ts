import assert from "node:assert/strict";
import test from "node:test";
import { buildArchiveGroups, type ArchiveCapture, type ArchiveFolder } from "../src/archive-list.ts";

const folders: ArchiveFolder[] = [
	{ id: "alpha", name: "Alpha tests", collapsed: true },
	{ id: "empty", name: "Empty folder", collapsed: false }
];

const captures: ArchiveCapture[] = [
	{
		id: "capture-1",
		name: "Overview",
		view: "Home",
		folderId: "alpha",
		params: [{ key: "Speed", value: "1" }],
		messageCount: 3
	},
	{
		id: "capture-2",
		name: "Diagnostics",
		view: "Service",
		folderId: null,
		params: [{ key: "Mode", value: "safe" }],
		messageCount: 0
	}
];

test("groups all captures, including empty folders and unfiled captures", () => {
	const result = buildArchiveGroups(captures, folders, "", true);

	assert.deepEqual(result.visibleCaptures.map(capture => capture.id), ["capture-1", "capture-2"]);
	assert.deepEqual(result.groups.map(group => [group.id, group.captures.map(capture => capture.id)]), [
		["alpha", ["capture-1"]],
		["empty", []],
		["", ["capture-2"]]
	]);
	assert.equal(result.searching, false);
});

test("searches capture metadata and folder names, then hides empty groups", () => {
	const result = buildArchiveGroups(captures, folders, "alpha");

	assert.deepEqual(result.visibleCaptures.map(capture => capture.id), ["capture-1"]);
	assert.deepEqual(result.groups.map(group => group.id), ["alpha"]);
	assert.equal(result.searching, true);
});

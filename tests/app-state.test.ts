import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_SEND_HISTORY,
	STORAGE_KEY,
	loadState,
	normalizeArchiveState,
	normalizeSendState,
	type AppState
} from "../src/app-state.ts";

function idFactory(prefix = "generated") {
	let count = 0;
	return () => `${prefix}-${++count}`;
}

test("normalizes send settings, filters entries, and caps history", () => {
	const target = {
		captures: [],
		folders: [],
		sendHistory: [
			{ bytes: [] },
			...Array.from({ length: MAX_SEND_HISTORY + 1 }, (_, index) => ({
				id: `history-${index}`,
				bytes: [index]
			})),
			{ bytes: ["after-cap"] }
		],
		sendQueue: [
			{ bytes: [] },
			{ bytes: ["1", "2.5"] },
			{ id: "saved-queue", bytes: [3], createdAt: 0 }
		],
		sendSettings: { delayMs: 900_000, draft: " C2 ", baudRate: 120 }
	} as unknown as AppState;

	normalizeSendState(target, { generateId: idFactory("queue"), now: () => 4_321 });

	assert.equal(target.sendHistory?.length, MAX_SEND_HISTORY);
	assert.deepEqual(target.sendHistory?.[0].bytes, [0]);
	assert.deepEqual(target.sendHistory?.at(-1)?.bytes, [MAX_SEND_HISTORY - 1]);
	assert.deepEqual(target.sendQueue, [
		{ id: "queue-1", bytes: [1, 2.5], createdAt: 4_321 },
		{ id: "saved-queue", bytes: [3], createdAt: 4_321 }
	]);
	assert.deepEqual(target.sendSettings, { delayMs: 600_000, draft: " C2 ", baudRate: 300 });
});

test("normalizes, deduplicates, and cleans up archive folders", () => {
	const target = {
		captures: [
			{ id: "capture-1", folderId: "work" },
			{ id: "capture-2", folderId: "generated-folder" },
			{ id: "capture-3", folderId: "missing" }
		],
		folders: [
			{ id: "work", name: "  Work  ", collapsed: 1, createdAt: "saved" },
			{ id: "work", name: "Duplicate", collapsed: false, createdAt: "ignored" },
			null,
			{ id: "", name: "   ", collapsed: 0 }
		]
	} as unknown as AppState;

	normalizeArchiveState(target, {
		generateId: () => "generated-folder",
		nowIso: () => "injected-time"
	});

	assert.deepEqual(target.folders, [
		{ id: "work", name: "Work", collapsed: true, createdAt: "saved" },
		{ id: "generated-folder", name: "Untitled folder", collapsed: false, createdAt: "injected-time" }
	]);
	assert.deepEqual(target.captures.map(capture => capture.folderId), ["work", "generated-folder", null]);
});

test("loads and normalizes saved state before using demo fallback", () => {
	const savedState = {
		captures: [
			{
				id: "saved-capture",
				name: "Saved capture",
				folderId: "saved-folder",
				frameSize: 2,
				byteStream: [
					{ value: 0xaa, timestamp: 10 },
					{ value: 0xbb, timestamp: 20 }
				],
				messages: [],
				notes: []
			}
		],
		folders: [{ id: "saved-folder", name: "Saved", collapsed: false }],
		activeId: "saved-capture",
		sendSettings: { delayMs: 12, draft: "AA", baudRate: 9 }
	};
	const saved = loadState({
		storage: { getItem: key => (key === STORAGE_KEY ? JSON.stringify(savedState) : null) },
		generateId: idFactory("saved"),
		now: () => 8_000
	});

	assert.equal(saved.captures.length, 1);
	assert.equal(saved.captures[0].id, "saved-capture");
	assert.deepEqual(saved.captures[0].messages?.map(message => message.bytes), [[0xaa, 0xbb]]);
	assert.equal(saved.captures[0].folderId, "saved-folder");
	assert.equal(saved.sendSettings?.delayMs, 12);

	const fallback = loadState({ storage: { getItem: () => null }, generateId: idFactory("demo"), now: () => 8_000 });
	assert.deepEqual(fallback.captures.map(capture => capture.name), ["Overview · Speed 1", "Speed · 1 → 2"]);
	assert.equal(fallback.folders.length, 0);
	assert.equal(fallback.activeId, fallback.captures[0].id);
	assert.ok(fallback.captures.every(capture => capture.byteStream?.length && capture.messages?.length));
	assert.deepEqual(fallback.sendSettings, { delayMs: 100, draft: "", baudRate: 115200 });
});

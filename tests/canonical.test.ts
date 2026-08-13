import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArchiveRepository } from "../server/archive-repository.ts";
import { openDatabase } from "../server/database.ts";

test("canonical conversion preserves legacy message visibility by raw span", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-canonical-"));
	const database = openDatabase(join(directory, "archive.sqlite"));
	try {
		const repository = new ArchiveRepository(database, {
			nowIso: () => "2026-01-01T00:00:00.000Z",
			generateId: (() => {
				let next = 0;
				return () => `generated-${next++}`;
			})()
		});
		repository.putCapture("hidden-capture", {
			id: "hidden-capture",
			name: "Hidden message",
			createdAt: "2026-01-01T00:00:00.000Z",
			byteStream: [
				{ rawOffset: 10, value: 0x10, timestamp: 1, direction: "rx" },
				{ rawOffset: 11, value: 0x11, timestamp: 2, direction: "rx" },
				{ rawOffset: 12, value: 0x20, timestamp: 3, direction: "rx" },
				{ rawOffset: 13, value: 0x21, timestamp: 4, direction: "rx" }
			],
			frameSections: [{ id: "section", start: 10, framingMode: "length", frameSize: 2 }],
			messages: [
				{
					id: "hidden-message",
					timestamp: 1,
					bytes: [0x10, 0x11],
					directions: ["rx", "rx"],
					hidden: true,
					rawOffsets: [10, 11],
					_rawPositions: [10, 11]
				},
				{
					id: "visible-message",
					timestamp: 3,
					bytes: [0x20, 0x21],
					directions: ["rx", "rx"],
					hidden: false,
					rawOffsets: [12, 13],
					_rawPositions: [12, 13]
				}
			],
			notes: [],
			annotations: {},
			patternRemarks: {}
		});

		const result = repository.convertCaptureToCanonical("hidden-capture");
		assert.equal(result.ok, true);
		assert.equal(result.verified, true);
		assert.equal(result.report.messageVisibilityOk, true);

		const rows = database
			.prepare("SELECT id, raw_offsets_json, hidden FROM materialized_frames WHERE capture_id = @captureId ORDER BY ordinal")
			.all({ captureId: "hidden-capture" }) as Array<{ id: string; raw_offsets_json: string; hidden: number }>;
		assert.deepEqual(
			rows.map(row => ({ id: row.id, rawOffsets: JSON.parse(row.raw_offsets_json), hidden: Boolean(row.hidden) })),
			[
				{ id: "hidden-message", rawOffsets: [10, 11], hidden: true },
				{ id: "visible-message", rawOffsets: [12, 13], hidden: false }
			]
		);

		const restoredMessages = repository.getCapture("hidden-capture")?.document.messages as
			| Array<{ id?: string; hidden?: boolean }>
			| undefined;
		assert.deepEqual(restoredMessages?.map(message => ({ id: message.id, hidden: message.hidden })), [
			{ id: "hidden-message", hidden: true },
			{ id: "visible-message", hidden: false }
		]);
	} finally {
		database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ArchiveRepository } from "../server/archive-repository.ts";
import { openDatabase } from "../server/database.ts";

async function withTemporaryArchive(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("saves to converted captures keep canonical reads current", async () => {
	await withTemporaryArchive(async directory => {
		const path = join(directory, "archive.sqlite");
		const database = openDatabase(path);
		const repository = new ArchiveRepository(database, { nowIso: () => "2026-01-01T00:00:00.000Z" });
		repository.putCapture("converted-save", {
			id: "converted-save",
			name: "Before",
			createdAt: "2026-01-01T00:00:00.000Z",
			lifecycle: "finalized",
			byteStream: [
				{ rawOffset: 0, value: 0x10, timestamp: 100, direction: "rx", hidden: false },
				{ rawOffset: 1, value: 0x20, timestamp: 125, direction: "rx", hidden: false }
			],
			frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 2 }],
			notes: [{ id: "note-1", type: "capture", text: "before", createdAt: 1_000 }]
		});
		const conversion = repository.convertCaptureToCanonical("converted-save");
		assert.equal(conversion.verified, true);

		const before = repository.getCapture("converted-save");
		assert.ok(before);
		const metadataSave = repository.putCapture(
			"converted-save",
			{ ...before.document, name: "Renamed", notes: [{ id: "note-1", type: "capture", text: "renamed", createdAt: 1_500 }] },
			before.version
		);
		assert.equal(metadataSave.version, before.version + 1);
		assert.equal(repository.getCapture("converted-save")?.document.name, "Renamed");
		assert.deepEqual(repository.getCapture("converted-save")?.document.notes, [{ id: "note-1", type: "capture", text: "renamed", createdAt: 1_500 }]);

		const current = repository.getCapture("converted-save");
		assert.ok(current);
		const beforeMessage = (current.document.messages as Array<Record<string, unknown>>)[0];
		const updated = {
			...current.document,
			name: "After",
			folderId: "folder-1",
			byteStream: (current.document.byteStream as Array<Record<string, unknown>>).map((record, index) => ({
				...record,
				value: index === 1 ? 0x2a : record.value
			})),
			notes: [{ id: "note-1", type: "capture", text: "after", createdAt: 2_000 }],
			annotations: {
				[`${String(beforeMessage.id)}:1`]: { text: "changed byte", createdAt: 2_001 }
			}
		};

		const saved = repository.putCapture("converted-save", updated, metadataSave.version);
		assert.equal(saved.version, metadataSave.version + 1);
		const after = repository.getCapture("converted-save");
		assert.ok(after);
		assert.equal(after.document.name, "After");
		assert.equal(after.document.folderId, "folder-1");
		assert.deepEqual(
			(after.document.byteStream as Array<Record<string, unknown>>).map(record => record.value),
			[0x10, 0x2a]
		);
		assert.deepEqual(after.document.notes, [{ id: "note-1", type: "capture", text: "after", createdAt: 2_000 }]);
		assert.equal(
			(Object.values(after.document.annotations as Record<string, Record<string, unknown>>)[0] as Record<string, unknown>).text,
			"changed byte"
		);
		const canonicalCapture = database.prepare("SELECT name, folder_id, byte_count FROM captures WHERE id = 'converted-save'").get() as {
			name: string;
			folder_id: string;
			byte_count: number;
		};
		assert.deepEqual(canonicalCapture, { name: "After", folder_id: "folder-1", byte_count: 2 });
		assert.equal((database.prepare("SELECT bytes FROM raw_chunks WHERE capture_id = 'converted-save'").get() as { bytes: Buffer }).bytes[1], 0x2a);

		repository.close();
		const reopened = new ArchiveRepository(openDatabase(path));
		const reloaded = reopened.getCapture("converted-save")?.document;
		assert.equal(reloaded?.name, "After");
		assert.deepEqual((reloaded?.byteStream as Array<Record<string, unknown>>).map(record => record.value), [0x10, 0x2a]);
		assert.deepEqual(reloaded?.notes, [{ id: "note-1", type: "capture", text: "after", createdAt: 2_000 }]);
		reopened.close();
	});
});

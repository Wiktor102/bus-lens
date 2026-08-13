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

test("verified conversion deletes the legacy document and retains one verified recovery backup", async () => {
	await withTemporaryArchive(async directory => {
		const path = join(directory, "archive.sqlite");
		const database = openDatabase(path);
		const repository = new ArchiveRepository(database, { nowIso: () => "2026-01-03T00:00:00.000Z" });
		repository.putCapture("retained-json", {
			id: "retained-json",
			name: "Readable after conversion",
			byteStream: [
				{ rawOffset: 0, value: 0x10, timestamp: 100, direction: "rx" },
				{ rawOffset: 1, value: 0x20, timestamp: 125, direction: "rx" }
			],
			frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 2 }],
			messages: [{ id: "message-1", timestamp: 100, bytes: [0x10, 0x20], byteTimestamps: [100, 125], rawOffsets: [0, 1] }],
			notes: []
		});

		const result = repository.convertCaptureToCanonical("retained-json");
		assert.equal(result.verified, true);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM capture_documents WHERE id = 'retained-json'").get() as { count: number }).count, 0);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM capture_backups WHERE capture_id = 'retained-json'").get() as { count: number }).count, 1);
		assert.equal((database.prepare("SELECT verified FROM capture_backups WHERE capture_id = 'retained-json'").get() as { verified: number }).verified, 1);
		assert.equal(JSON.parse(repository.getCaptureBackup("retained-json")?.document_json ?? "{}").name, "Readable after conversion");
		assert.equal(repository.getCapture("retained-json")?.document.name, "Readable after conversion");

		repository.close();
		const reopened = new ArchiveRepository(openDatabase(path));
		assert.equal(reopened.getCapture("retained-json")?.document.name, "Readable after conversion");
		assert.equal(reopened.getCaptureBackup("retained-json")?.verified, 1);
		reopened.close();
	});
});

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

test("legacy captures stay JSON-backed until an explicit conversion operation", async () => {
	await withTemporaryArchive(async directory => {
		const path = join(directory, "archive.sqlite");
		const database = openDatabase(path);
		const repository = new ArchiveRepository(database, {
			nowIso: () => "2026-01-01T00:00:00.000Z"
		});
		repository.putCapture("explicit-conversion", {
			id: "explicit-conversion",
			name: "Legacy capture",
			byteStream: [
				{ rawOffset: 0, value: 0x10, timestamp: 100, direction: "rx" },
				{ rawOffset: 1, value: 0x20, timestamp: 125, direction: "rx" }
			],
			frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 2 }],
			messages: [{
				id: "legacy-message",
				timestamp: 100,
				bytes: [0x10, 0x20],
				byteTimestamps: [100, 125],
				rawOffsets: [0, 1]
			}],
			notes: []
		});

		assert.equal(repository.isCaptureConverted("explicit-conversion"), false);
		assert.equal((repository.getCapture("explicit-conversion")?.document.name), "Legacy capture");
		assert.deepEqual(repository.getFinalizationJobs("explicit-conversion"), []);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count, 0);
		repository.close();

		const reopened = new ArchiveRepository(openDatabase(path));
		assert.equal(reopened.isCaptureConverted("explicit-conversion"), false);
		const result = reopened.convertCaptureToCanonical("explicit-conversion");
		assert.equal(result.verified, true);
		assert.equal(reopened.isCaptureConverted("explicit-conversion"), true);
		reopened.close();
	});
});

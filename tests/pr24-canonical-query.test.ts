import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ArchiveRepository } from "../server/archive-repository.ts";
import { CanonicalQueryService, MAX_FRAME_WINDOW_LIMIT } from "../server/canonical-query.ts";
import { openDatabase } from "../server/database.ts";

async function withTemporaryArchive(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("canonical query reads stay bounded and use canonical frame rows", async () => {
	await withTemporaryArchive(async directory => {
		const database = openDatabase(join(directory, "archive.sqlite"));
		const repository = new ArchiveRepository(database, { nowIso: () => "2026-01-01T00:00:00.000Z" });
		repository.putCapture("query-capture", {
			id: "query-capture",
			name: "Query capture",
			byteStream: [
				{ rawOffset: 0, value: 0x10, timestamp: 100, direction: "rx" },
				{ rawOffset: 1, value: 0x20, timestamp: 125, direction: "rx" },
				{ rawOffset: 2, value: 0x30, timestamp: 150, direction: "rx" },
				{ rawOffset: 3, value: 0x40, timestamp: 175, direction: "rx" }
			],
			frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 2 }],
			messages: [
				{ id: "message-1", timestamp: 100, bytes: [0x10, 0x20], byteTimestamps: [100, 125], rawOffsets: [0, 1] },
				{ id: "message-2", timestamp: 150, bytes: [0x30, 0x40], byteTimestamps: [150, 175], rawOffsets: [2, 3] }
			],
			notes: []
		});
		repository.convertCaptureToCanonical("query-capture");

		const queries = new CanonicalQueryService(database);
		assert.deepEqual(queries.listCaptureSummaries(), [{
			id: "query-capture",
			status: "canonical",
			name: "Query capture",
			lifecycle: "finalized",
			byteCount: 4,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			folderId: null
		}]);
		const overview = queries.getCaptureOverview("query-capture");
		assert.equal(overview?.status, "canonical");
		assert.equal(overview?.rawByteCount, 4);
		assert.equal(overview?.frameCount, 2);

		const window = queries.getFrameWindow("query-capture", 1, 1);
		assert.equal(window?.totalFrames, 2);
		assert.equal(window?.frames.length, 1);
		assert.deepEqual(window?.frames[0].bytes, [0x30, 0x40]);
		assert.equal(queries.getFrameWindow("query-capture", 0, MAX_FRAME_WINDOW_LIMIT + 1)?.limit, MAX_FRAME_WINDOW_LIMIT);
		repository.close();
	});
});

test("old JSON captures are visible as legacy and are never materialized by bounded reads", async () => {
	await withTemporaryArchive(async directory => {
		const database = openDatabase(join(directory, "archive.sqlite"));
		const repository = new ArchiveRepository(database, { nowIso: () => "2026-01-02T00:00:00.000Z" });
		repository.putCapture("legacy-query-capture", {
			id: "legacy-query-capture",
			name: "Old JSON capture",
			byteCount: 1000,
			messages: [{ id: "legacy-message", bytes: Array.from({ length: 1000 }, (_, index) => index & 0xff) }]
		});

		const queries = new CanonicalQueryService(database);
		const summary = queries.getCaptureSummary("legacy-query-capture");
		assert.equal(summary?.status, "legacy-not-canonicalized");
		assert.equal(summary?.name, "Old JSON capture");
		assert.equal(summary?.byteCount, 1000);

		const overview = queries.getCaptureOverview("legacy-query-capture");
		assert.equal(overview?.status, "legacy-not-canonicalized");
		assert.equal(overview?.frameCount, null);
		assert.equal(overview?.rawByteCount, null);
		assert.equal(overview?.activeProfile, null);

		const window = queries.getFrameWindow("legacy-query-capture", 0, 20);
		assert.equal(window?.status, "legacy-not-canonicalized");
		assert.equal(window?.totalFrames, null);
		assert.deepEqual(window?.frames, []);
		assert.equal("messages" in (window ?? {}), false);
		repository.close();
	});
});

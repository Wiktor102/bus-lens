import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	ArchiveRepository,
	CanonicalCommandRequiredError
} from "../server/archive-repository.ts";
import { CanonicalCaptureCommandService } from "../server/canonical-capture-command-service.ts";
import { openDatabase } from "../server/database.ts";

async function withTemporaryArchive(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("converted captures reject document saves and accept canonical metadata commands", async () => {
	await withTemporaryArchive(async directory => {
		const database = openDatabase(join(directory, "archive.sqlite"));
		const repository = new ArchiveRepository(database, { nowIso: () => "2026-01-01T00:00:00.000Z" });
		repository.putCapture("converted-save", {
			id: "converted-save",
			name: "Before",
			description: "legacy metadata",
			view: "raw",
			baudRate: 115200,
			inputFormat: "binary",
			params: [{ key: "mode", value: "legacy" }],
			byteStream: [
				{ rawOffset: 0, value: 0x10, timestamp: 100, direction: "rx" },
				{ rawOffset: 1, value: 0x20, timestamp: 125, direction: "rx" }
			],
			frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 2 }],
			messages: [{
				id: "message-1",
				timestamp: 100,
				byteTimestamps: [100, 125],
				bytes: [0x10, 0x20],
				rawOffsets: [0, 1]
			}],
			notes: []
		});
		assert.equal(repository.convertCaptureToCanonical("converted-save").verified, true);

		assert.throws(
			() => repository.putCapture("converted-save", { id: "converted-save", name: "Shadow write" }),
			(error: unknown) => error instanceof CanonicalCommandRequiredError
		);
		assert.equal(database.prepare(
			"SELECT COUNT(*) FROM capture_documents WHERE id = 'converted-save'"
		).pluck().get(), 0);

		const commandService = new CanonicalCaptureCommandService(database, {
			nowIso: () => "2026-01-02T00:00:00.000Z"
		});
		const updated = commandService.patchMetadata({
			captureId: "converted-save",
			expectedMetadataRevision: 1,
			patch: {
				name: "After",
				description: "canonical metadata",
				parameters: [{ key: "mode", value: "canonical" }]
			}
		});
		assert.equal(updated.name, "After");
		assert.equal(updated.metadataRevision, 2);
		assert.equal(updated.dataRevision, 1);
		assert.deepEqual(updated.parameters, [{ key: "mode", value: "canonical" }]);
		assert.deepEqual(
			(repository.getCapture("converted-save")?.document.byteStream as Array<{ value: number }>).map(record => record.value),
			[0x10, 0x20]
		);

		repository.close();
	});
});

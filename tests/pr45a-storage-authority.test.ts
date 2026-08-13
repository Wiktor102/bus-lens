import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	ArchiveRepository,
	CanonicalCommandRequiredError
} from "../server/archive-repository.ts";
import { openDatabase, type SqliteDatabase } from "../server/database.ts";

async function withRepository(
	run: (repository: ArchiveRepository, database: SqliteDatabase) => void | Promise<void>
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-storage-authority-"));
	const database = openDatabase(join(directory, "archive.sqlite"));
	const repository = new ArchiveRepository(database, {
		nowIso: () => "2026-08-09T00:00:00.000Z",
		generateId: (() => {
			let next = 0;
			return () => `generated-${++next}`;
		})()
	});
	try {
		await run(repository, database);
	} finally {
		repository.close();
		await rm(directory, { recursive: true, force: true });
	}
}

test("capture authority follows explicit storage status instead of incidental rows", async () => {
	await withRepository((repository, database) => {
		repository.putCapture("legacy", { id: "legacy", name: "Document authority" });
		assert.equal(repository.getCaptureStorageStatus("legacy"), "legacy-not-canonicalized");

		database.prepare(
			`INSERT INTO captures (id, name, lifecycle, byte_count, created_at, updated_at)
			 VALUES ('legacy', 'Incidental canonical row', 'finalized', 0, @now, @now)`
		).run({ now: "2026-08-09T00:00:00.000Z" });

		assert.equal(repository.getCapture("legacy")?.document.name, "Document authority");
		repository.putCapture("legacy", { id: "legacy", name: "Updated document" });
		assert.equal(repository.getCapture("legacy")?.document.name, "Updated document");
	});
});

test("whole-document writes are rejected for explicitly canonical captures", async () => {
	await withRepository((repository, database) => {
		repository.putCapture("canonical", { id: "canonical", name: "Legacy seed" });
		database.prepare(
			`INSERT INTO captures (id, name, lifecycle, byte_count, created_at, updated_at)
			 VALUES ('canonical', 'Canonical', 'finalized', 0, @now, @now)`
		).run({ now: "2026-08-09T00:00:00.000Z" });
		database.prepare(
			"UPDATE capture_storage SET status = 'canonical' WHERE capture_id = 'canonical'"
		).run();
		const before = database.prepare(
			"SELECT document_json FROM capture_documents WHERE id = 'canonical'"
		).get() as { document_json: string };

		assert.throws(
			() => repository.putCapture("canonical", { id: "canonical", name: "Shadow rewrite" }),
			(error: unknown) => error instanceof CanonicalCommandRequiredError && error.code === "canonical-command-required"
		);
		const after = database.prepare(
			"SELECT document_json FROM capture_documents WHERE id = 'canonical'"
		).get() as { document_json: string };
		assert.equal(after.document_json, before.document_json);
	});
});

test("verified conversion leaves one backup and removes the authoritative document", async () => {
	await withRepository((repository, database) => {
		repository.putCapture("convert", {
			id: "convert",
			name: "Legacy conversion",
			byteStream: [
				{ rawOffset: 0, value: 0x10, timestamp: 100, direction: "rx" },
				{ rawOffset: 1, value: 0x20, timestamp: 120, direction: "rx" }
			],
			frameSections: [{ id: "legacy-section", start: 0, framingMode: "length", frameSize: 2 }],
			messages: [{
				id: "legacy-frame",
				timestamp: 100,
				byteTimestamps: [100, 120],
				bytes: [0x10, 0x20],
				rawOffsets: [0, 1]
			}],
			notes: []
		});

		const result = repository.convertCaptureToCanonical("convert");
		assert.equal(result.verified, true);
		assert.equal(repository.getCaptureStorageStatus("convert"), "canonical");
		assert.equal(database.prepare(
			"SELECT COUNT(*) AS count FROM capture_documents WHERE id = 'convert'"
		).pluck().get(), 0);
		assert.equal(database.prepare(
			"SELECT COUNT(*) AS count FROM capture_backups WHERE capture_id = 'convert' AND verified = 1"
		).pluck().get(), 1);
		assert.equal(repository.getCapture("convert")?.document.name, "Legacy conversion");
	});
});

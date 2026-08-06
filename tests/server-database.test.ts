import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backupDatabase, restoreDatabase } from "../server/backup.ts";
import { ArchiveRepository } from "../server/archive-repository.ts";
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, openDatabase, runMigrations } from "../server/database.ts";

async function withTemporaryArchive(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("migrations are idempotent and durable document writes do not rewrite other captures", async () => {
	await withTemporaryArchive(async directory => {
		const path = join(directory, "archive.sqlite");
		const database = openDatabase(path);
		assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
		runMigrations(database);
		const repository = new ArchiveRepository(database, { nowIso: () => "2026-01-01T00:00:00.000Z" });
		repository.putCapture("capture-a", { id: "capture-a", name: "First", messages: [] });
		repository.putCapture("capture-b", { id: "capture-b", name: "Second", messages: [] });
		const original = repository.getCapture("capture-b");
		repository.putCapture("capture-a", { id: "capture-a", name: "Updated", messages: [] }, 1);
		assert.equal(repository.getCapture("capture-a")?.document.name, "Updated");
		assert.deepEqual(repository.getCapture("capture-b"), original);
		database.close();

		const reopened = new ArchiveRepository(openDatabase(path));
		assert.equal(reopened.getCapture("capture-a")?.document.name, "Updated");
		assert.equal(reopened.listCaptures().length, 2);
		reopened.close();
	});
});

test("SQLite backup restores a complete archive", async () => {
	await withTemporaryArchive(async directory => {
		const sourcePath = join(directory, "source.sqlite");
		const backupPath = join(directory, "backups", "archive.sqlite");
		const restoredPath = join(directory, "restored.sqlite");
		const database = openDatabase(sourcePath);
		const repository = new ArchiveRepository(database);
		repository.putCapture("capture-1", { id: "capture-1", name: "Recover me", notes: [{ text: "durable" }] });
		repository.putFolder("folder-1", { id: "folder-1", name: "Archive" });
		repository.setSetting("send", { baudRate: 115200 });
		await backupDatabase(database, backupPath);
		database.close();

		await restoreDatabase(backupPath, restoredPath);
		const recovered = new ArchiveRepository(openDatabase(restoredPath));
		assert.equal(recovered.getCapture("capture-1")?.document.name, "Recover me");
		assert.equal(recovered.getFolder("folder-1")?.document.name, "Archive");
		assert.deepEqual(recovered.getSetting("send"), { baudRate: 115200 });
		recovered.close();
	});
});

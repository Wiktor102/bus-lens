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

test("canonical capture reads use modeled metadata and do not consult compatibility blobs", async () => {
	await withTemporaryArchive(async directory => {
		const path = join(directory, "archive.sqlite");
		const database = openDatabase(path);
		const repository = new ArchiveRepository(database, { nowIso: () => "2026-01-01T00:00:00.000Z" });
		repository.putCapture("capture-metadata", {
			id: "capture-metadata",
			name: "Metadata capture",
			description: "Retain this description",
			view: "Overview",
			baudRate: 9600,
			inputFormat: "text",
			params: [{ key: "Mode", value: "safe" }],
			customMetadata: { operator: "test" },
			captureSessions: [{ id: "session-1", firstReceivedAt: 100, lastReceivedAt: 200 }],
			byteStream: [
				{ rawOffset: 0, value: 0xc2, timestamp: 100, direction: "rx", sessionId: "session-1" },
				{ rawOffset: 1, value: 0x08, timestamp: 100, direction: "rx", sessionId: "session-1" }
			],
			frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 2, frameMarker: "", markerPosition: "start", frameTimeGap: 5, collapseRuns: false, collapsed: false }],
			notes: [],
			annotations: {},
			patternRemarks: {}
		});

		const conversion = repository.convertCaptureToCanonical("capture-metadata");
		assert.equal(conversion.ok, true);
		assert.equal(conversion.verified, true);
		const converted = repository.getCapture("capture-metadata")?.document;
		assert.equal(converted?.description, "Retain this description");
		assert.equal(converted?.view, "Overview");
		assert.equal(converted?.baudRate, 9600);
		assert.equal(converted?.inputFormat, "text");
		assert.deepEqual(converted?.params, [{ key: "Mode", value: "safe" }]);
		assert.equal(converted?.customMetadata, undefined);
		assert.deepEqual(converted?.captureSessions, [{ id: "session-1", firstReceivedAt: 100, lastReceivedAt: 200 }]);
		assert.equal(converted?.byteStream && (converted.byteStream[0] as { sessionId?: string }).sessionId, "session-1");

		repository.close();
		const reopened = new ArchiveRepository(openDatabase(path));
		const reloaded = reopened.getCapture("capture-metadata")?.document;
		assert.equal(reloaded?.description, "Retain this description");
		assert.equal(reloaded?.view, "Overview");
		assert.equal(reloaded?.baudRate, 9600);
		assert.equal(reloaded?.inputFormat, "text");
		assert.deepEqual(reloaded?.params, [{ key: "Mode", value: "safe" }]);
		assert.equal(reloaded?.customMetadata, undefined);
		assert.deepEqual(reloaded?.captureSessions, [{ id: "session-1", firstReceivedAt: 100, lastReceivedAt: 200 }]);
		assert.equal(reloaded?.byteStream && (reloaded.byteStream[0] as { sessionId?: string }).sessionId, "session-1");
		reopened.close();
	});
});

test("canonical annotation notes reload under the message and byte keys used by the UI", async () => {
	await withTemporaryArchive(async directory => {
		const repository = new ArchiveRepository(openDatabase(join(directory, "archive.sqlite")), {
			nowIso: () => "2026-01-01T00:00:00.000Z"
		});
		const legacyMessageId = "legacy-message";
		repository.putCapture("annotated-capture", {
			id: "annotated-capture",
			name: "Annotated capture",
			byteStream: [
				{ rawOffset: 10, value: 0xa0, timestamp: 100, direction: "rx" },
				{ rawOffset: 11, value: 0xb1, timestamp: 125, direction: "rx" }
			],
			frameSections: [{ id: "section-1", start: 10, framingMode: "length", frameSize: 2 }],
			messages: [{
				id: legacyMessageId,
				timestamp: 100,
				bytes: [0xa0, 0xb1],
				byteTimestamps: [100, 125],
				rawOffsets: [10, 11],
				_rawPositions: [10, 11]
			}],
			notes: [],
			annotations: {
				[legacyMessageId]: { text: "message target", createdAt: 1_000, type: "message" },
				[`${legacyMessageId}:1`]: { text: "byte target", createdAt: 2_000, type: "byte" }
			},
			patternRemarks: {}
		});

		const conversion = repository.convertCaptureToCanonical("annotated-capture");
		assert.equal(conversion.ok, true);
		assert.equal(conversion.verified, true);
		const converted = repository.getCapture("annotated-capture")?.document as {
			messages: Array<{ id: string }>;
			annotations: Record<string, { text: string; type: string }>;
		};
		const messageId = converted.messages[0].id;
		assert.deepEqual(Object.keys(converted.annotations).sort(), [messageId, `${messageId}:1`].sort());
		assert.equal(converted.annotations[messageId].text, "message target");
		assert.equal(converted.annotations[messageId].type, "message");
		assert.equal(converted.annotations[`${messageId}:1`].text, "byte target");
		assert.equal(converted.annotations[`${messageId}:1`].type, "byte");

		const stableNotes = repository.getStableNotes("annotated-capture");
		const messageNote = stableNotes.find(note => note.target_kind === "frame");
		const byteNote = stableNotes.find(note => note.target_kind === "byte");
		assert.equal(messageNote?.message_id, legacyMessageId);
		assert.equal(messageNote?.byte_position, null);
		assert.equal(messageNote?.raw_offsets_json, JSON.stringify([10, 11]));
		assert.equal(byteNote?.message_id, legacyMessageId);
		assert.equal(byteNote?.byte_position, 1);
		assert.equal(byteNote?.raw_offset, 11);

		repository.close();
		const reopened = new ArchiveRepository(openDatabase(join(directory, "archive.sqlite")));
		const reloaded = reopened.getCapture("annotated-capture")?.document as typeof converted;
		assert.deepEqual(Object.keys(reloaded.annotations).sort(), [messageId, `${messageId}:1`].sort());
		assert.equal(reloaded.annotations[messageId].text, "message target");
		assert.equal(reloaded.annotations[`${messageId}:1`].text, "byte target");
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

test("legacy migration is transactional and idempotent by fingerprint", async () => {
	await withTemporaryArchive(async directory => {
		const repository = new ArchiveRepository(openDatabase(join(directory, "archive.sqlite")));
		const archive = {
			captures: [{ id: "capture-1", name: "Imported", byteStream: [{ value: 1 }], notes: [] }],
			folders: [{ id: "folder-1", name: "Imported folder", collapsed: false }],
			activeId: "capture-1",
			sendQueue: [{ id: "queue-1", bytes: [1] }],
			sendHistory: [{ id: "history-1", bytes: [2] }],
			sendSettings: { baudRate: 115200 }
		};
		assert.equal(repository.migrateLegacyArchive("fingerprint", archive, { captures: 1 }).imported, true);
		assert.equal(repository.migrateLegacyArchive("fingerprint", archive, { captures: 1 }).imported, false);
		assert.equal(repository.listCaptures().length, 1);
		assert.equal(repository.listFolders().length, 1);
		assert.equal(repository.listQueue().length, 1);
		assert.equal(repository.listHistory().length, 1);
		repository.close();
	});
});

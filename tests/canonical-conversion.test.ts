import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArchiveRepository } from "../server/archive-repository.ts";
import { convertCaptureDocumentToCanonical, isCaptureConverted } from "../server/canonical.ts";
import { openDatabase } from "../server/database.ts";

async function withTemporaryArchive(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("canonical conversion reconstructs legacy message-only captures", async () => {
	await withTemporaryArchive(async directory => {
		const repository = new ArchiveRepository(openDatabase(join(directory, "archive.sqlite")), {
			nowIso: () => "2026-01-01T00:00:00.000Z",
			generateId: (() => {
				let index = 0;
				return () => `generated-${index++}`;
			})()
		});
		repository.putCapture("legacy-message-only", {
			id: "legacy-message-only",
			name: "Legacy messages",
			frameSize: 2,
			messages: [
				{
					id: "legacy-message",
					timestamp: 100,
					byteTimestamps: [100, 125],
					bytes: [0x10, 0x20],
					hiddenBytes: [false, true]
				}
			]
		});

		const result = repository.convertCaptureToCanonical("legacy-message-only");

		assert.equal(result.ok, true);
		assert.equal(result.verified, true);
		assert.deepEqual(result.report.rawByteCount, { expected: 2, actual: 2, ok: true });
		assert.deepEqual(result.report.messageCount, { expected: 1, actual: 1, ok: true });
		const converted = repository.getCapture("legacy-message-only")?.document;
		assert.deepEqual(
			(converted?.byteStream as Array<Record<string, unknown>>).map(record => ({
				value: record.value,
				timestamp: record.timestamp,
				hidden: record.hidden
			})),
			[
				{ value: 0x10, timestamp: 100, hidden: false },
				{ value: 0x20, timestamp: 125, hidden: true }
			]
		);
		assert.deepEqual(
			(converted?.messages as Array<Record<string, unknown>>).map(message => ({
				bytes: message.bytes,
				byteTimestamps: message.byteTimestamps
			})),
			[{ bytes: [0x10], byteTimestamps: [100] }]
		);

		repository.close();
	});
});

test("conversion commits explicit authority, complete metadata, and one idempotent recovery row", () => {
	const database = openDatabase(":memory:", () => "2026-01-01T00:00:00.000Z");
	try {
		const document = {
			id: "metadata-conversion",
			name: "Metadata capture",
			description: "legacy description",
			view: "monitor",
			baudRate: 115200,
			inputFormat: "binary",
			folderId: "folder-1",
			params: [
				{ key: "second", value: "2" },
				{ key: "first", value: "1" }
			],
			createdAt: "2025-12-31T23:00:00.000Z",
			byteStream: [
				{ rawOffset: 0, value: 0x10, timestamp: 100, direction: "rx" },
				{ rawOffset: 1, value: 0x20, timestamp: 125, direction: "tx" }
			],
			frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 2 }],
			messages: [{ id: "message-1", timestamp: 100, bytes: [0x10, 0x20], byteTimestamps: [100, 125], rawOffsets: [0, 1] }]
		};
		database
			.prepare(
				`INSERT INTO capture_documents (id, document_version, document_json, created_at, updated_at)
				 VALUES ('metadata-conversion', 1, @documentJson, @createdAt, @updatedAt)`
			)
			.run({
				documentJson: JSON.stringify(document),
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z"
			});

		// An incidental canonical row must not establish authority by itself.
		database.prepare("INSERT INTO captures (id, created_at, updated_at) VALUES ('metadata-conversion', @now, @now)").run({ now: "2026-01-01T00:00:00.000Z" });
		assert.equal(isCaptureConverted(database, "metadata-conversion"), false);

		const first = convertCaptureDocumentToCanonical(database, "metadata-conversion", {
			nowIso: () => "2026-01-02T00:00:00.000Z",
			generateId: (() => {
				let index = 0;
				return () => `conversion-${index++}`;
			})()
		});
		assert.equal(first.verified, true);
		assert.equal(isCaptureConverted(database, "metadata-conversion"), true);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM capture_documents WHERE id = 'metadata-conversion'").get() as { count: number }).count, 0);
		assert.deepEqual(
			database
				.prepare(
					`SELECT name, description, controller_view, baud_rate, input_format, folder_id,
							data_revision, metadata_revision, content_revision, retained_start_offset
					 FROM captures WHERE id = 'metadata-conversion'`
				)
				.get(),
			{
				name: "Metadata capture",
				description: "legacy description",
				controller_view: "monitor",
				baud_rate: 115200,
				input_format: "binary",
				folder_id: "folder-1",
				data_revision: 1,
				metadata_revision: 1,
				content_revision: 1,
				retained_start_offset: 0
			}
		);
		assert.deepEqual(database.prepare("SELECT position, key_text, value_text FROM capture_parameters WHERE capture_id = 'metadata-conversion' ORDER BY position").all(), [
			{ position: 0, key_text: "second", value_text: "2" },
			{ position: 1, key_text: "first", value_text: "1" }
		]);
		assert.deepEqual(database.prepare("SELECT source_data_revision, retained_start_offset, verified FROM framing_profiles WHERE capture_id = 'metadata-conversion'").get(), {
			source_data_revision: 1,
			retained_start_offset: 0,
			verified: 1
		});
		assert.deepEqual(database.prepare("SELECT status, last_error FROM capture_storage WHERE capture_id = 'metadata-conversion'").get(), {
			status: "canonical",
			last_error: null
		});
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM capture_backups WHERE capture_id = 'metadata-conversion' AND verified = 1").get() as { count: number }).count, 1);

		const second = convertCaptureDocumentToCanonical(database, "metadata-conversion", {
			nowIso: () => "2026-01-03T00:00:00.000Z",
			generateId: () => "must-not-be-used"
		});
		assert.equal(second.verified, true);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM capture_backups WHERE capture_id = 'metadata-conversion'").get() as { count: number }).count, 1);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM framing_profiles WHERE capture_id = 'metadata-conversion'").get() as { count: number }).count, 1);
	} finally {
		database.close();
	}
});

test("conversion retains all raw chunks while limiting the active profile to 50,000 bytes", () => {
	const database = openDatabase(":memory:", () => "2026-01-01T00:00:00.000Z");
	try {
		const byteCount = 50_005;
		const document = {
			id: "retained-boundary",
			name: "Retained boundary",
			frameSize: 1024,
			byteStream: Array.from({ length: byteCount }, (_, rawOffset) => ({
				rawOffset,
				value: rawOffset & 0xff,
				timestamp: rawOffset,
				direction: "rx"
			})),
			frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 1024 }]
		};
		database
			.prepare(
				`INSERT INTO capture_documents (id, document_version, document_json, created_at, updated_at)
				 VALUES ('retained-boundary', 1, @documentJson, @createdAt, @updatedAt)`
			)
			.run({
				documentJson: JSON.stringify(document),
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z"
			});

		const result = convertCaptureDocumentToCanonical(database, "retained-boundary", {
			nowIso: () => "2026-01-02T00:00:00.000Z",
			generateId: (() => {
				let index = 0;
				return () => `retained-${index++}`;
			})()
		});
		assert.equal(result.verified, true);
		assert.deepEqual(database.prepare("SELECT byte_count, retained_start_offset FROM captures WHERE id = 'retained-boundary'").get(), {
			byte_count: byteCount,
			retained_start_offset: 5
		});
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM raw_chunks WHERE capture_id = 'retained-boundary'").get() as { count: number }).count, Math.ceil(byteCount / 4096));
		assert.deepEqual(
			database.prepare("SELECT COUNT(*) AS count, MIN(json_extract(raw_offsets_json, '$[0]')) AS first_offset, MAX(json_extract(raw_offsets_json, '$[#-1]')) AS last_offset FROM materialized_frames WHERE capture_id = 'retained-boundary'").get(),
			{ count: Math.ceil(50_000 / 1024), first_offset: 5, last_offset: byteCount - 1 }
		);
	} finally {
		database.close();
	}
});

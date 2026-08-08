import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

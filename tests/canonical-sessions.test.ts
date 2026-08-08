import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ArchiveRepository } from "../server/archive-repository.ts";
import { openDatabase } from "../server/database.ts";

test("canonical conversion persists per-byte session IDs and session boundaries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-canonical-sessions-"));
	const path = join(directory, "archive.sqlite");
	try {
		const database = openDatabase(path);
		const repository = new ArchiveRepository(database, { nowIso: () => "2026-01-01T00:00:00.000Z" });
		repository.putCapture("session-capture", {
			id: "session-capture",
			name: "Multiple sessions",
			captureSessions: [
				{ id: "session-a", firstReceivedAt: 100, lastReceivedAt: 200 },
				{ id: "session-b", firstReceivedAt: 500, lastReceivedAt: 600 }
			],
			byteStream: [
				{ rawOffset: 20, value: 0x10, timestamp: 100, direction: "rx", sessionId: "session-a" },
				{ rawOffset: 21, value: 0x11, timestamp: 200, direction: "rx", sessionId: "session-a" },
				{ rawOffset: 22, value: 0x20, timestamp: 500, direction: "rx", sessionId: "session-b" },
				{ rawOffset: 23, value: 0x21, timestamp: 600, direction: "rx", sessionId: "session-b" }
			],
			frameSections: [{ id: "section", start: 20, framingMode: "length", frameSize: 2 }],
			messages: [],
			notes: [],
			annotations: {},
			patternRemarks: {}
		});

		const result = repository.convertCaptureToCanonical("session-capture");
		assert.equal(result.ok, true);
		assert.equal(result.verified, true);
		assert.equal(result.report.sessionIdentityOk, true);
		assert.deepEqual(
			(database.prepare("SELECT session_ids_json FROM raw_chunks WHERE capture_id = @captureId ORDER BY chunk_index").all({ captureId: "session-capture" }) as Array<{ session_ids_json: string }>).map(row => JSON.parse(row.session_ids_json)),
			[["session-a", "session-a", "session-b", "session-b"]]
		);

		const restored = repository.getCapture("session-capture")?.document;
		assert.deepEqual(restored?.captureSessions, [
			{ id: "session-a", firstReceivedAt: 100, lastReceivedAt: 200 },
			{ id: "session-b", firstReceivedAt: 500, lastReceivedAt: 600 }
		]);
		assert.deepEqual(
			(restored?.byteStream as Array<{ sessionId?: string }>).map(record => record.sessionId),
			["session-a", "session-a", "session-b", "session-b"]
		);

		repository.close();
		const reopened = new ArchiveRepository(openDatabase(path));
		const reloaded = reopened.getCapture("session-capture")?.document;
		assert.deepEqual(reloaded?.captureSessions, restored?.captureSessions);
		assert.deepEqual(
			(reloaded?.byteStream as Array<{ sessionId?: string }>).map(record => record.sessionId),
			["session-a", "session-a", "session-b", "session-b"]
		);
		reopened.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

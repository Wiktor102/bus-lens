import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ArchiveRepository } from "../server/archive-repository.ts";
import { AgentQueryError } from "../server/agent-contracts.ts";
import { CanonicalQueryService } from "../server/canonical-query.ts";
import { openDatabase } from "../server/database.ts";

async function withTemporaryArchive(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-phase4-query-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function legacyDocument(id: string, name: string) {
	return {
		id,
		name,
		view: "monitor",
		params: [{ key: "mode", value: "capture" }],
		byteCount: 2,
		byteStream: [{ rawOffset: 0, value: 0x10, timestamp: 1, direction: "rx" }],
		messages: [{ id: `${id}-message`, timestamp: 1, bytes: [0x10, 0x20] }]
	};
}

test("agent discovery is filtered, stable at equal timestamps, and keyset paginated", async () => {
	await withTemporaryArchive(async directory => {
		const database = openDatabase(join(directory, "archive.sqlite"), () => "2026-08-10T00:00:00.000Z");
		const repository = new ArchiveRepository(database, { nowIso: () => "2026-08-10T00:00:00.000Z" });
		repository.putCapture("legacy-a", legacyDocument("legacy-a", "Alpha"));
		repository.putCapture("legacy-b", legacyDocument("legacy-b", "Beta"));
		repository.putCapture("legacy-c", legacyDocument("legacy-c", "Gamma"));
		const queries = new CanonicalQueryService(database);

		const first = queries.queryCaptureDiscovery({ limit: 2, controllerView: "monitor", contextParameters: { mode: "capture" } });
		assert.deepEqual(first.data.captures.map(capture => capture.id), ["legacy-a", "legacy-b"]);
		assert.equal(first.meta.page?.returned, 2);
		assert.ok(first.meta.page?.nextCursor);
		assert.equal(first.data.captures[0]?.status, "legacy-not-canonicalized");
		assert.match(first.data.captures[0]?.conversionGuidance ?? "", /Convert/);

		const second = queries.queryCaptureDiscovery({ limit: 2, controllerView: "monitor", contextParameters: { mode: "capture" }, cursor: first.meta.page?.nextCursor });
		assert.deepEqual(second.data.captures.map(capture => capture.id), ["legacy-c"]);
		assert.equal(second.meta.page?.nextCursor, undefined);
		assert.throws(
			() => queries.queryCaptureDiscovery({ limit: 2, controllerView: "other", cursor: first.meta.page?.nextCursor }),
			(error: unknown) => error instanceof AgentQueryError && error.code === "invalid-cursor"
		);
		database.close();
	});
});

test("agent overview pins an explicit profile revision and remains bounded", async () => {
	await withTemporaryArchive(async directory => {
		const database = openDatabase(join(directory, "archive.sqlite"), () => "2026-08-10T00:00:00.000Z");
		const repository = new ArchiveRepository(database, { nowIso: () => "2026-08-10T00:00:00.000Z" });
		repository.putCapture("canonical", {
			id: "canonical",
			name: "Canonical",
			parameters: [{ key: "mode", value: "safe" }],
			byteStream: Array.from({ length: 8 }, (_, index) => ({ rawOffset: index, value: index, timestamp: index, direction: "rx" })),
			frameSections: [{ id: "section", start: 0, framingMode: "length", frameSize: 2 }],
			messages: Array.from({ length: 4 }, (_, index) => ({ id: `message-${index}`, timestamp: index, bytes: [index * 2, index * 2 + 1], rawOffsets: [index * 2, index * 2 + 1], byteTimestamps: [index, index + 1] })),
			notes: []
		});
		repository.convertCaptureToCanonical("canonical");
		const queries = new CanonicalQueryService(database);
		const before = queries.queryCaptureOverview("canonical");
		assert.ok(before.meta.snapshot);
		assert.ok(before.data.sections.length);
		assert.equal("messages" in before.data, false);
		assert.equal("bytes" in before.data, false);
		assert.ok(JSON.stringify(before).length <= 96 * 1024);

		repository.createFramingRevision("canonical", [{ start: 0, framingMode: "length", frameSize: 4 }]);
		const after = queries.queryCaptureOverview("canonical");
		assert.ok(after.meta.snapshot);
		assert.notEqual(after.meta.snapshot?.profileId, before.meta.snapshot?.profileId);
		const pinned = queries.queryCaptureOverview("canonical", before.meta.snapshot);
		assert.equal(pinned.meta.snapshot?.profileId, before.meta.snapshot?.profileId);
		assert.equal(pinned.meta.snapshot?.profileVersion, before.meta.snapshot?.profileVersion);
		assert.throws(
			() => queries.queryCaptureOverview("canonical", { ...before.meta.snapshot!, sourceDataRevision: 999 }),
			(error: unknown) => error instanceof AgentQueryError && error.code === "snapshot-mismatch"
		);
		database.close();
	});
});

test("large discovery fixtures return bounded pages and use agent ordering indexes", async () => {
	await withTemporaryArchive(async directory => {
		const database = openDatabase(join(directory, "archive.sqlite"));
		const repository = new ArchiveRepository(database);
		for (let index = 0; index < 125; index++) repository.putCapture(`capture-${String(index).padStart(3, "0")}`, legacyDocument(`capture-${index}`, `Capture ${index}`));
		const queries = new CanonicalQueryService(database);
		const response = queries.queryCaptureDiscovery({ limit: 100 });
		assert.ok(response.data.captures.length <= 100);
		assert.ok(response.data.captures.length > 0);
		assert.ok(response.meta.page?.nextCursor);
		assert.ok(JSON.stringify(response).length < 96 * 1024);
		assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'captures_agent_discovery'").get());
		const plan = database.prepare("EXPLAIN QUERY PLAN SELECT id FROM captures ORDER BY updated_at DESC, id ASC LIMIT 20").all() as Array<{ detail: string }>;
		assert.ok(plan.some(row => row.detail.includes("captures_agent_discovery") || row.detail.includes("captures")));
		repository.close();
	});
});

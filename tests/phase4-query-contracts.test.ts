import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ArchiveRepository } from "../server/archive-repository.ts";
import {
	AGENT_CONTRACT_VERSION,
	AgentQueryError,
	assertCursorFilters,
	decodeAgentCursor,
	encodeAgentCursor
} from "../server/agent-contracts.ts";
import { CanonicalQueryService, MAX_CONTEXT_PARAMETER_FILTERS, normalizeCaptureDiscoveryFilters } from "../server/canonical-query.ts";
import { openDatabase } from "../server/database.ts";

async function withTemporaryArchive(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-phase4-query-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function legacyDocument(id: string, name: string, description = "") {
	return {
		id,
		name,
		description,
		view: "monitor",
		params: [{ key: "mode", value: "capture" }],
		byteCount: 2,
		byteStream: [{ rawOffset: 0, value: 0x10, timestamp: 1, direction: "rx" }],
		messages: [{ id: `${id}-message`, timestamp: 1, bytes: [0x10, 0x20] }]
	};
}

test("agent discovery deduplicates context filters and rejects an unbounded filter set", () => {
	const normalized = normalizeCaptureDiscoveryFilters({
		contextParameters: [
			{ key: " mode ", value: "capture" },
			{ key: "mode", value: "capture" },
			{ key: "other", value: "value" }
		]
	});
	assert.deepEqual(normalized.contextParameters, [
		{ key: "mode", value: "capture" },
		{ key: "other", value: "value" }
	]);

	assert.throws(
		() => normalizeCaptureDiscoveryFilters({
			contextParameters: Array.from({ length: MAX_CONTEXT_PARAMETER_FILTERS + 1 }, (_, index) => ({ key: `key-${index}`, value: "value" }))
		}),
		(error: unknown) => error instanceof AgentQueryError && error.code === "invalid-input"
	);
});

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
		assert.equal(first.meta.page?.requestedLimit, 2);
		assert.equal(first.meta.page?.effectiveLimit, 2);
		assert.equal(first.meta.page?.returned, 2);
		assert.equal(first.meta.page?.truncationReason, "page-limit");
		assert.ok(first.meta.page?.nextCursor);
		assert.equal(first.data.captures[0]?.status, "legacy-not-canonicalized");
		assert.match(first.data.captures[0]?.conversionGuidance ?? "", /Convert/);

		const second = queries.queryCaptureDiscovery({ limit: 5, controllerView: "monitor", contextParameters: { mode: "capture" }, cursor: first.meta.page?.nextCursor });
		assert.deepEqual(second.data.captures.map(capture => capture.id), ["legacy-c"]);
		assert.equal(second.meta.page?.requestedLimit, 5);
		assert.equal(second.meta.page?.effectiveLimit, 5);
		assert.equal(second.meta.page?.returned, 1);
		assert.equal(second.meta.page?.truncationReason, undefined);
		assert.equal(second.meta.page?.nextCursor, undefined);
		assert.throws(
			() => queries.queryCaptureDiscovery({ limit: 1, controllerView: "other", cursor: first.meta.page?.nextCursor }),
			(error: unknown) => error instanceof AgentQueryError && error.code === "invalid-cursor"
		);
		database.close();
	});
});

test("agent cursors remain filter- and snapshot-bound while page size stays outside the cursor", () => {
	const filters = { controllerView: "monitor" };
	const snapshot = { captureId: "capture", profileId: "profile", profileVersion: 1, sourceDataRevision: 2 };
	const cursor = encodeAgentCursor({
		contractVersion: AGENT_CONTRACT_VERSION,
		scope: "capture-discovery",
		filters,
		snapshot,
		key: { updatedAt: "2026-08-10T00:00:00.000Z", id: "capture" }
	});
	const decoded = decodeAgentCursor(cursor, "capture-discovery");
	assert.equal("limit" in (decoded.filters as Record<string, unknown>), false);
	assert.doesNotThrow(() => assertCursorFilters(decoded, filters, snapshot));
	assert.throws(
		() => assertCursorFilters(decoded, { controllerView: "other" }, snapshot),
		(error: unknown) => error instanceof AgentQueryError && error.code === "invalid-cursor"
	);
	assert.throws(
		() => assertCursorFilters(decoded, filters, { ...snapshot, sourceDataRevision: 3 }),
		(error: unknown) => error instanceof AgentQueryError && error.code === "invalid-cursor"
	);
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

		const profileANoteId = "profile-a-note";
		const profileA = before.meta.snapshot!.profileId;
		const revision = repository.createFramingRevision("canonical", [{ start: 0, framingMode: "length", frameSize: 4 }]);
		const insertNote = database.prepare(
			`INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind, profile_id)
			 VALUES (@id, @captureId, @text, @createdAt, @targetKind, @profileId)`
		);
		insertNote.run({ id: profileANoteId, captureId: "canonical", text: "profile A", createdAt: "2026-08-10T00:00:01.000Z", targetKind: "frame", profileId: profileA });
		insertNote.run({ id: "profile-b-note", captureId: "canonical", text: "profile B", createdAt: "2026-08-10T00:00:02.000Z", targetKind: "frame", profileId: revision.profileId });
		insertNote.run({ id: "capture-note", captureId: "canonical", text: "capture-wide", createdAt: "2026-08-10T00:00:03.000Z", targetKind: "capture", profileId: null });

		const after = queries.queryCaptureOverview("canonical");
		assert.ok(after.meta.snapshot);
		assert.notEqual(after.meta.snapshot?.profileId, before.meta.snapshot?.profileId);
		assert.deepEqual(new Set(after.data.notes.map(note => note.id)), new Set(["profile-b-note", "capture-note"]));
		const pinned = queries.queryCaptureOverview("canonical", before.meta.snapshot);
		assert.equal(pinned.meta.snapshot?.profileId, before.meta.snapshot?.profileId);
		assert.equal(pinned.meta.snapshot?.profileVersion, before.meta.snapshot?.profileVersion);
		assert.deepEqual(new Set(pinned.data.notes.map(note => note.id)), new Set([profileANoteId, "capture-note"]));
		assert.throws(
			() => queries.queryCaptureOverview("canonical", { ...before.meta.snapshot!, sourceDataRevision: 999 }),
			(error: unknown) => error instanceof AgentQueryError && error.code === "snapshot-mismatch"
		);
		database.close();
	});
});

test("agent overview resolves pattern remarks by key within the selected capture", async () => {
	await withTemporaryArchive(async directory => {
		const database = openDatabase(join(directory, "archive.sqlite"), () => "2026-08-10T00:00:00.000Z");
		const repository = new ArchiveRepository(database, { nowIso: () => "2026-08-10T00:00:00.000Z" });
		const capture = (id: string) => ({
			id,
			name: id,
			parameters: [],
			byteStream: [
				{ rawOffset: 0, value: 0x10, timestamp: 1, direction: "rx" },
				{ rawOffset: 1, value: 0x20, timestamp: 2, direction: "rx" }
			],
			frameSections: [{ id: `${id}-section`, start: 0, framingMode: "length", frameSize: 2 }],
			messages: [{ id: `${id}-message`, timestamp: 1, bytes: [0x10, 0x20], rawOffsets: [0, 1], byteTimestamps: [1, 2] }],
			notes: []
		});
		repository.putCapture("pattern-capture", capture("pattern-capture"));
		repository.putCapture("other-capture", capture("other-capture"));
		repository.convertCaptureToCanonical("pattern-capture");
		repository.convertCaptureToCanonical("other-capture");
		const queries = new CanonicalQueryService(database);
		const profileId = queries.queryCaptureOverview("pattern-capture").meta.snapshot!.profileId;
		database.prepare(
			`INSERT INTO sequence_groups (id, capture_id, profile_id, key_text, signatures_json, score, length)
			 VALUES ('pattern-group', 'pattern-capture', @profileId, 'AA×1', '[]', 1, 1)`
		).run({ profileId });
		const insertNote = database.prepare(
			`INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind, profile_id, sequence_key)
			 VALUES (@id, @captureId, @text, @createdAt, 'pattern', @profileId, @sequenceKey)`
		);
		insertNote.run({ id: "local-pattern-note", captureId: "pattern-capture", text: "local pattern", createdAt: "2026-08-10T00:00:01.000Z", profileId: null, sequenceKey: "AA×1" });
		insertNote.run({ id: "foreign-pattern-note", captureId: "other-capture", text: "foreign pattern", createdAt: "2026-08-10T00:00:02.000Z", profileId: null, sequenceKey: "AA×1" });

		const overview = queries.queryCaptureOverview("pattern-capture");
		assert.equal(overview.data.sequenceGroups.find(group => group.id === "pattern-group")?.remark, "local pattern");
		repository.close();
	});
});

test("agent overview derives framed bytes from the selected profile materialization", async () => {
	await withTemporaryArchive(async directory => {
		const database = openDatabase(join(directory, "archive.sqlite"), () => "2026-08-10T00:00:00.000Z");
		const repository = new ArchiveRepository(database, { nowIso: () => "2026-08-10T00:00:00.000Z" });
		repository.putCapture("framed-bytes", {
			id: "framed-bytes",
			name: "Framed bytes",
			parameters: [],
			byteStream: [
				{ rawOffset: 0, value: 0x10, timestamp: 1, direction: "rx" },
				{ rawOffset: 1, value: 0x20, timestamp: 2, direction: "rx" }
			],
			frameSections: [{ id: "length-section", start: 0, framingMode: "length", frameSize: 2 }],
			messages: [{ id: "framed-message", timestamp: 1, bytes: [0x10, 0x20], rawOffsets: [0, 1], byteTimestamps: [1, 2] }],
			notes: []
		});
		repository.convertCaptureToCanonical("framed-bytes");
		const queries = new CanonicalQueryService(database);
		const before = queries.queryCaptureOverview("framed-bytes");
		assert.deepEqual(before.data.counts, { rawBytes: 2, framedBytes: 2, frames: 1, visibleFrames: 1 });

		repository.createFramingRevision("framed-bytes", [{ start: 0, framingMode: "marker", frameMarker: "AA", markerPosition: "end" }]);
		const unframed = queries.queryCaptureOverview("framed-bytes");
		assert.deepEqual(unframed.data.counts, { rawBytes: 2, framedBytes: 0, frames: 0, visibleFrames: 0 });
		const pinned = queries.queryCaptureOverview("framed-bytes", before.meta.snapshot);
		assert.deepEqual(pinned.data.counts, { rawBytes: 2, framedBytes: 2, frames: 1, visibleFrames: 1 });
		repository.close();
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

test("agent discovery reports response-size when the response budget lowers the effective limit", async () => {
	await withTemporaryArchive(async directory => {
		const database = openDatabase(join(directory, "archive.sqlite"));
		const repository = new ArchiveRepository(database);
		for (let index = 0; index < 100; index++) {
			repository.putCapture(
				`large-${String(index).padStart(3, "0")}`,
				legacyDocument(`large-${index}`, `Large ${index}`, "x".repeat(600))
			);
		}
		const queries = new CanonicalQueryService(database);
		const response = queries.queryCaptureDiscovery({ limit: 100 });
		assert.equal(response.meta.page?.requestedLimit, 100);
		assert.ok((response.meta.page?.effectiveLimit ?? 100) < 100);
		assert.equal(response.meta.page?.returned, response.meta.page?.effectiveLimit);
		assert.equal(response.meta.page?.truncationReason, "response-size");
		assert.equal(response.meta.truncated, true);
		assert.ok(response.meta.page?.nextCursor);
		repository.close();
	});
});

import assert from "node:assert/strict";
import test from "node:test";
import { CanonicalCaptureCommandService } from "../server/canonical-capture-command-service.ts";
import { CanonicalQueryService, type AgentComparisonSnapshot } from "../server/canonical-query.ts";
import { openDatabase } from "../server/database.ts";

const framing = [{ start: 0, framingMode: "length", frameSize: 2 }] as const;

function record(database: ReturnType<typeof openDatabase>, id: string, bytes: number[]) {
	const commands = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-10T00:00:00.000Z" });
	commands.createCapture({ captureId: id, framing, name: `${id} capture`, controllerView: id === "left" ? "A" : "B", inputFormat: "binary", parameters: [{ key: "mode", value: id }] });
	commands.startSession({ captureId: id, sessionId: `${id}-session` });
	const append = commands.appendChunk({ captureId: id, sessionId: `${id}-session`, requestId: `${id}-request`, sequence: 0, expectedStartOffset: 0, bytes });
	const finalized = commands.finalizeSession({ captureId: id, sessionId: `${id}-session`, expectedDataRevision: append.dataRevision });
	return { commands, snapshot: { captureId: id, profileId: finalized.profileId, profileVersion: finalized.profileVersion, sourceDataRevision: finalized.dataRevision } as AgentComparisonSnapshot };
}
function seedHighCardinalityByteStatistics(database: ReturnType<typeof openDatabase>, profileId: string, count: number) {
	database.prepare("DELETE FROM byte_statistics WHERE profile_id = @profileId").run({ profileId });
	database.prepare("DELETE FROM bit_statistics WHERE profile_id = @profileId").run({ profileId });
	const insertVocabulary = database.prepare("INSERT INTO byte_statistics (profile_id, position, value, count) VALUES (@profileId, @position, @value, @count)");
	const insertBits = database.prepare("INSERT INTO bit_statistics (profile_id, position, bit, percentage, variance) VALUES (@profileId, @position, @bit, 50, @variance)");
	const seed = database.transaction(() => {
		for (let position = 0; position < 20; position += 1) {
			for (let value = 0; value < 256; value += 1) insertVocabulary.run({ profileId, position, value, count });
			for (let bit = 0; bit < 8; bit += 1) insertBits.run({ profileId, position, bit, variance: "variable" });
		}
	});
	seed();
}


test("comparisons use explicit snapshots and page category deltas independently", () => {
	const database = openDatabase(":memory:");
	try {
		const left = record(database, "left", [1, 2, 3, 4, 5, 6]);
		const right = record(database, "right", [1, 2, 9, 4, 10, 11]);
		const query = new CanonicalQueryService(database);
		const first = query.compareCaptures({ left: left.snapshot, right: right.snapshot, categories: ["metadata", "sections", "signatures", "transitions", "byte-statistics"], limits: { signatures: 1 } });
		assert.equal(first.data.left.profileId, left.snapshot.profileId);
		assert.ok(first.data.categories.metadata);
		assert.ok(first.data.categories.signatures);
		const signaturePage = first.data.categories.signatures as { items: Array<{ signature: string }>; nextCursor?: string; truncated: boolean };
		assert.equal(signaturePage.items.length, 1);
		assert.ok(signaturePage.nextCursor);
		const second = query.compareCaptures({ left: left.snapshot, right: right.snapshot, categories: ["signatures"], limits: { signatures: 1 }, cursors: { signatures: signaturePage.nextCursor } });
		const secondSignaturePage = second.data.categories.signatures as { items: Array<{ signature: string }>; truncated: boolean };
		assert.ok(secondSignaturePage.items.length);
		assert.notEqual(secondSignaturePage.items[0]?.signature, signaturePage.items[0]?.signature);
		const rawText = JSON.stringify(first);
		assert.doesNotMatch(rawText, /bytes_json|raw_offsets_json/);
	} finally {
		database.close();
	}
});

test("comparison cursors remain bound to both requested profile revisions", () => {
	const database = openDatabase(":memory:");
	try {
		const left = record(database, "left-pinned", [1, 2, 3, 4, 5, 6]);
		const right = record(database, "right-pinned", [1, 2, 9, 4, 10, 11]);
		const query = new CanonicalQueryService(database);
		const first = query.compareCaptures({ left: left.snapshot, right: right.snapshot, categories: ["signatures"], limits: { signatures: 1 } });
		const page = first.data.categories.signatures as { nextCursor?: string };
		assert.ok(page.nextCursor);
		left.commands.reframe({ captureId: left.snapshot.captureId, expectedActiveProfileId: left.snapshot.profileId, expectedDataRevision: left.snapshot.sourceDataRevision, sections: [{ start: 0, framingMode: "length", frameSize: 1 }] });
		const continued = query.compareCaptures({ left: left.snapshot, right: right.snapshot, categories: ["signatures"], limits: { signatures: 1 }, cursors: { signatures: page.nextCursor } });
		assert.equal(continued.data.left.profileId, left.snapshot.profileId);
		assert.equal((continued.data.categories.signatures as { items: unknown[] }).items.length, 1);
		assert.throws(() => query.compareCaptures({ left: { ...left.snapshot, profileVersion: left.snapshot.profileVersion + 1 }, right: right.snapshot, categories: ["metadata"] }), error => (error as { code?: string }).code === "snapshot-mismatch");
	} finally {
		database.close();
	}
});

test("byte-statistics comparison pages stay encoded-size safe and advance by position", () => {
	const database = openDatabase(":memory:");
	try {
		const left = record(database, "left-byte-page", [1, 2, 3, 4, 5, 6]);
		const right = record(database, "right-byte-page", [1, 2, 9, 4, 10, 11]);
		seedHighCardinalityByteStatistics(database, left.snapshot.profileId, 1);
		seedHighCardinalityByteStatistics(database, right.snapshot.profileId, 2);
		const query = new CanonicalQueryService(database);
		const first = query.compareCaptures({ left: left.snapshot, right: right.snapshot, limits: { "byte-statistics": 100 } });
		const firstPage = first.data.categories["byte-statistics"] as { items: Array<{ position: number }>; nextCursor?: string; truncated: boolean };
		assert.deepEqual(firstPage.items.map(item => item.position), [0]);
		assert.ok(firstPage.nextCursor);
		assert.equal(firstPage.truncated, true);

		const positions = [...firstPage.items.map(item => item.position)];
		let cursor = firstPage.nextCursor;
		while (cursor) {
			const page = query.compareCaptures({ left: left.snapshot, right: right.snapshot, categories: ["byte-statistics"], limits: { "byte-statistics": 100 }, cursors: { "byte-statistics": cursor } }).data.categories["byte-statistics"] as { items: Array<{ position: number }>; nextCursor?: string; truncated: boolean };
			assert.equal(page.items.length, 1);
			assert.ok(page.items[0]);
			assert.ok(page.items[0].position > positions.at(-1)!);
			positions.push(page.items[0].position);
			cursor = page.nextCursor;
		}
		assert.deepEqual(positions, Array.from({ length: 20 }, (_value, position) => position));
	} finally {
		database.close();
	}
});

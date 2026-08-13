import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_NORMAL_RESPONSE_BYTES } from "../server/agent-contracts.ts";
import { CanonicalCaptureCommandService } from "../server/canonical-capture-command-service.ts";
import { CanonicalQueryService, type AgentComparisonSnapshot, type AgentOperationTemplate } from "../server/canonical-query.ts";
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

test("comparison drill-down templates are category-level and bind selected item fields", () => {
	const database = openDatabase(":memory:");
	try {
		const left = record(database, "left-templates", [1, 2, 3, 4, 5, 6]);
		const right = record(database, "right-templates", [1, 2, 9, 4, 10, 11]);
		const query = new CanonicalQueryService(database);
		const response = query.compareCaptures({
			left: left.snapshot,
			right: right.snapshot,
			categories: ["signatures", "transitions", "sequence-groups"],
			limits: { signatures: 100, transitions: 100, "sequence-groups": 100 }
		});

		const signatures = response.data.categories.signatures as {
			items: Array<Record<string, unknown>>;
			operationTemplates: AgentOperationTemplate[];
		};
		const transitions = response.data.categories.transitions as {
			items: Array<Record<string, unknown>>;
			operationTemplates: AgentOperationTemplate[];
		};
		const sequenceGroups = response.data.categories["sequence-groups"] as {
			items: Array<Record<string, unknown>>;
			operationTemplates: AgentOperationTemplate[];
		};

		assert.equal(signatures.operationTemplates.length, 2);
		assert.equal(transitions.operationTemplates.length, 2);
		assert.equal(sequenceGroups.operationTemplates.length, 2);
		assert.deepEqual(signatures.operationTemplates.map(template => template.argumentBindings), [
			{ exactSignature: "signature" },
			{ exactSignature: "signature" }
		]);
		assert.deepEqual(transitions.operationTemplates.map(template => template.argumentBindings), [
			{ exactSignature: "fromSignature" },
			{ exactSignature: "fromSignature" }
		]);
		assert.deepEqual(sequenceGroups.operationTemplates.map(template => template.argumentBindings), [
			{ groupId: "leftGroupId" },
			{ groupId: "rightGroupId" }
		]);

		const snapshotArguments = (snapshot: AgentComparisonSnapshot) => ({
			captureId: snapshot.captureId,
			profileId: snapshot.profileId,
			profileVersion: snapshot.profileVersion,
			sourceDataRevision: snapshot.sourceDataRevision
		});
		assert.deepEqual(signatures.operationTemplates.map(template => template.fixedArguments), [snapshotArguments(left.snapshot), snapshotArguments(right.snapshot)]);
		assert.deepEqual(transitions.operationTemplates.map(template => template.fixedArguments), [snapshotArguments(left.snapshot), snapshotArguments(right.snapshot)]);

		for (const page of [signatures, transitions, sequenceGroups]) {
			for (const item of page.items) {
				assert.equal("suggestedOperations" in item, false);
				assert.equal("leftCaptureId" in item, false);
				assert.equal("rightCaptureId" in item, false);
			}
		}
		const signatureItem = signatures.items[0];
		assert.ok(signatureItem);
		for (const template of signatures.operationTemplates) {
			const binding = template.argumentBindings.exactSignature;
			assert.equal(signatureItem[binding], signatureItem.signature);
		}
		const transitionItem = transitions.items[0];
		assert.ok(transitionItem);
		for (const template of transitions.operationTemplates) {
			const binding = template.argumentBindings.exactSignature;
			assert.equal(transitionItem[binding], transitionItem.fromSignature);
		}
		assert.match(sequenceGroups.operationTemplates[0]?.reason ?? "", /inapplicable.*null/);
		assert.deepEqual(response.meta.suggestedOperations, []);
	} finally {
		database.close();
	}
});

test("comparison template count stays constant for a 100-item signature page", () => {
	const database = openDatabase(":memory:");
	try {
		const left = record(database, "left-100-signatures", Array.from({ length: 200 }, (_value, index) => index));
		const right = record(database, "right-100-signatures", Array.from({ length: 200 }, (_value, index) => (index + 56) % 256));
		const query = new CanonicalQueryService(database);
		const oneItem = query.compareCaptures({ left: left.snapshot, right: right.snapshot, categories: ["signatures"], limits: { signatures: 1 } });
		const hundredItems = query.compareCaptures({ left: left.snapshot, right: right.snapshot, categories: ["signatures"], limits: { signatures: 100 } });
		const oneItemPage = oneItem.data.categories.signatures as { items: unknown[]; operationTemplates: AgentOperationTemplate[] };
		const hundredItemPage = hundredItems.data.categories.signatures as { items: unknown[]; operationTemplates: AgentOperationTemplate[] };

		assert.equal(oneItemPage.items.length, 1);
		assert.equal(hundredItemPage.items.length, 100);
		assert.equal(oneItemPage.operationTemplates.length, 2);
		assert.equal(hundredItemPage.operationTemplates.length, 2);
		assert.equal((JSON.stringify(oneItemPage).match(/operationTemplates/g) ?? []).length, 1);
		assert.equal((JSON.stringify(hundredItemPage).match(/operationTemplates/g) ?? []).length, 1);
		assert.equal((JSON.stringify(hundredItemPage).match(/suggestedOperations/g) ?? []).length, 0);
		assert.ok(Buffer.byteLength(JSON.stringify(hundredItems), "utf8") <= AGENT_NORMAL_RESPONSE_BYTES);
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

test("comparison metadata stays pinned when a profile becomes historical", () => {
	const database = openDatabase(":memory:");
	try {
		const left = record(database, "left-metadata-pinned", [1, 2, 3, 4, 5, 6]);
		const right = record(database, "right-metadata-pinned", [1, 2, 9, 4, 10, 11]);
		const query = new CanonicalQueryService(database);
		const request = { left: left.snapshot, right: right.snapshot, categories: ["metadata"] as const };
		const before = query.compareCaptures(request);

		left.commands.patchMetadata({
			captureId: left.snapshot.captureId,
			patch: { name: "patched after snapshot", parameters: [{ key: "mode", value: "new" }] }
		});
		left.commands.startSession({ captureId: left.snapshot.captureId, sessionId: "left-metadata-append" });
		left.commands.appendChunk({
			captureId: left.snapshot.captureId,
			sessionId: "left-metadata-append",
			requestId: "left-metadata-append-request",
			sequence: 0,
			expectedStartOffset: 6,
			bytes: [7, 8]
		});

		const after = query.compareCaptures(request);
		assert.deepEqual(after, before);
		assert.doesNotMatch(JSON.stringify(after), /patched after snapshot|\"new\"/);
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

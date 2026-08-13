import assert from "node:assert/strict";
import test from "node:test";
import { CanonicalCaptureCommandService } from "../server/canonical-capture-command-service.ts";
import { CanonicalQueryService } from "../server/canonical-query.ts";
import { openDatabase } from "../server/database.ts";

const framing = [{ start: 0, framingMode: "length", frameSize: 2, collapseRuns: false, collapsed: false }] as const;

function seedAnalysisCapture() {
	const database = openDatabase(":memory:");
	const commands = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-10T00:00:00.000Z" });
	commands.createCapture({ captureId: "analysis-capture", framing, name: "Analysis capture", inputFormat: "binary" });
	commands.startSession({ captureId: "analysis-capture", sessionId: "analysis-session" });
	const append = commands.appendChunk({
		captureId: "analysis-capture",
		sessionId: "analysis-session",
		requestId: "analysis-request",
		sequence: 0,
		expectedStartOffset: 0,
		bytes: [1, 2, 1, 2, 3, 4, 1, 2],
		timestamps: [100, 101, 200, 201, 300, 301, 400, 401],
		directions: ["rx", "rx", "tx", "tx", "rx", "rx", "rx", "rx"]
	});
	const finalized = commands.finalizeSession({ captureId: "analysis-capture", sessionId: "analysis-session", expectedDataRevision: append.dataRevision });
	const firstFrame = database.prepare("SELECT id FROM materialized_frames WHERE profile_id = @profileId AND ordinal = 0").get({ profileId: finalized.profileId }) as { id: string };
	const groupId = "analysis-group";
	database.prepare(
		`INSERT INTO sequence_groups (id, capture_id, profile_id, key_text, signatures_json, score, length)
		 VALUES (@id, 'analysis-capture', @profileId, '01 02 / 01 02', @signatures, 2, 2)`
	).run({ id: groupId, profileId: finalized.profileId, signatures: JSON.stringify(["01 02", "01 02"]) });
	database.prepare(
		`INSERT INTO sequence_occurrences
		 (group_id, occurrence_index, offset, start_frame_ordinal, start_raw_offset, end_raw_offset, length)
		 VALUES (@groupId, 0, 0, 0, 0, 3, 2), (@groupId, 1, 0, 2, 4, 7, 2)`
	).run({ groupId });
	commands.createNote({ captureId: "analysis-capture", noteId: "analysis-frame-note", text: "inspect this frame", target: { kind: "frame", frameId: firstFrame.id } });
	database.prepare("UPDATE materialized_frames SET hidden = 1 WHERE id = @frameId").run({ frameId: firstFrame.id });
	database.prepare("INSERT INTO raw_byte_visibility (capture_id, raw_offset, hidden) VALUES ('analysis-capture', 1, 1)").run();
	return { database, commands, profileId: finalized.profileId, dataRevision: finalized.dataRevision, groupId, firstFrameId: firstFrame.id };
}

function seedManyFrameAnalysisCapture(frameCount: number) {
	const database = openDatabase(":memory:");
	const commands = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-10T00:00:00.000Z" });
	commands.createCapture({ captureId: "many-frame-analysis-capture", framing, name: "Many-frame analysis capture", inputFormat: "binary" });
	commands.startSession({ captureId: "many-frame-analysis-capture", sessionId: "many-frame-analysis-session" });
	const bytes = Array.from({ length: frameCount * 2 }, (_value, index) => index % 256);
	const append = commands.appendChunk({
		captureId: "many-frame-analysis-capture",
		sessionId: "many-frame-analysis-session",
		requestId: "many-frame-analysis-request",
		sequence: 0,
		expectedStartOffset: 0,
		bytes,
		timestamps: bytes.map((_byte, index) => 100 + index),
		directions: bytes.map(() => "rx")
	});
	const finalized = commands.finalizeSession({ captureId: "many-frame-analysis-capture", sessionId: "many-frame-analysis-session", expectedDataRevision: append.dataRevision });
	return { database, profileId: finalized.profileId };
}

function seedMixedFrameAnalysisCapture() {
	const database = openDatabase(":memory:");
	const commands = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-10T00:00:00.000Z" });
	const mixedFraming = [
		{ start: 0, framingMode: "length", frameSize: 2, collapseRuns: false, collapsed: false },
		{ start: 4, framingMode: "length", frameSize: 3, collapseRuns: false, collapsed: false }
	] as const;
	commands.createCapture({ captureId: "mixed-frame-analysis-capture", framing: mixedFraming, name: "Mixed frame analysis capture", inputFormat: "binary" });
	commands.startSession({ captureId: "mixed-frame-analysis-capture", sessionId: "mixed-frame-analysis-session" });
	const bytes = [0x10, 0x01, 0x10, 0x02, 0xa0, 0x01, 0x02, 0xa0, 0x03, 0x04];
	const append = commands.appendChunk({
		captureId: "mixed-frame-analysis-capture",
		sessionId: "mixed-frame-analysis-session",
		requestId: "mixed-frame-analysis-request",
		sequence: 0,
		expectedStartOffset: 0,
		bytes,
		timestamps: bytes.map((_byte, index) => 100 + index),
		directions: ["rx", "rx", "rx", "rx", "tx", "tx", "tx", "tx", "tx", "tx"]
	});
	const finalized = commands.finalizeSession({ captureId: "mixed-frame-analysis-capture", sessionId: "mixed-frame-analysis-session", expectedDataRevision: append.dataRevision });
	const sections = database.prepare(
		"SELECT id, frame_length FROM framing_sections WHERE profile_id = @profileId ORDER BY position"
	).all({ profileId: finalized.profileId }) as Array<{ id: string; frame_length: number | null }>;
	return { database, commands, profileId: finalized.profileId, dataRevision: finalized.dataRevision, sections };
}

test("analysis messages apply bounded filters, stable evidence references, and keyset cursors", () => {
	const { database, profileId, groupId, firstFrameId } = seedAnalysisCapture();
	try {
		const query = new CanonicalQueryService(database);
		const first = query.queryMessages({ captureId: "analysis-capture", limit: 2 });
		assert.equal(first.data.messages.length, 2);
		assert.equal(first.meta.page?.effectiveLimit, 2);
		assert.equal(first.meta.page?.truncationReason, "page-limit");
		assert.equal(first.meta.truncated, true);
		assert.ok(first.meta.page?.nextCursor);
		assert.equal(first.meta.snapshot?.profileId, profileId);
		const second = query.queryMessages({ captureId: "analysis-capture", limit: 2, cursor: first.meta.page?.nextCursor });
		assert.equal(second.data.messages.length, 2);
		assert.equal(second.meta.page?.effectiveLimit, 2);
		assert.equal(second.meta.page?.truncationReason, undefined);
		assert.equal(second.meta.truncated, false);
		assert.equal(new Set([...first.data.messages, ...second.data.messages].map(message => message.frameId)).size, 4);
		assert.throws(() => query.queryMessages({ captureId: "analysis-capture", limit: 2, cursor: first.meta.page?.nextCursor, sectionId: "different" }), /filters/);
		assert.throws(() => query.queryMessages({ captureId: "analysis-capture", wildcardHexPattern: "?? 02" }), error => (error as { code?: string }).code === "wildcard-too-broad");
		assert.equal(query.queryMessages({ captureId: "analysis-capture", ordinalFrom: 0, ordinalTo: 3, wildcardHexPattern: "?? 02" }).data.messages.length, 3);
		assert.equal(query.queryMessages({ captureId: "analysis-capture", hidden: "hidden-only" }).data.messages[0]?.frameId, firstFrameId);
		assert.equal(query.queryMessages({ captureId: "analysis-capture", notePresence: "with-note" }).data.messages[0]?.frameId, firstFrameId);
		assert.equal(query.queryMessages({ captureId: "analysis-capture", sequenceGroupId: groupId }).data.messages.length, 4);
		const context = query.getMessageContext({ frameId: firstFrameId, rowsBefore: 1, rowsAfter: 1 });
		assert.equal(context.meta.snapshot?.profileId, profileId);
		assert.equal(context.data.centerFrameId, firstFrameId);
		assert.equal(context.data.messages.length, 2);
	} finally {
		database.close();
	}
});

test("analysis messages resolve inclusive raw-byte overlap ranges", () => {
	const { database } = seedAnalysisCapture();
	try {
		const query = new CanonicalQueryService(database);
		const insideFrame = query.queryMessages({ captureId: "analysis-capture", rawOffsetFrom: 1 });
		assert.deepEqual(insideFrame.data.messages.map(message => message.ordinal), [0]);
		assert.deepEqual(insideFrame.data.messages[0]?.rawSpan, { startOffset: 0, endOffset: 1 });
		assert.equal(insideFrame.meta.appliedFilters.rawOffsetFrom, 1);
		assert.equal(insideFrame.meta.appliedFilters.rawOffsetTo, 1);

		assert.deepEqual(query.queryMessages({ captureId: "analysis-capture", rawOffsetFrom: 0, rawOffsetTo: 1 }).data.messages.map(message => message.ordinal), [0]);
		assert.deepEqual(query.queryMessages({ captureId: "analysis-capture", rawOffsetFrom: 2, rawOffsetTo: 3 }).data.messages.map(message => message.ordinal), [1]);
		assert.deepEqual(query.queryMessages({ captureId: "analysis-capture", rawOffsetFrom: 1, rawOffsetTo: 4 }).data.messages.map(message => message.ordinal), [0, 1, 2]);
		assert.deepEqual(query.queryMessages({ captureId: "analysis-capture", rawOffsetTo: 5 }).data.messages.map(message => message.ordinal), [2]);
		assert.deepEqual(query.queryMessages({ captureId: "analysis-capture", rawOffsetFrom: 8, rawOffsetTo: 8 }).data.messages, []);
		assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'materialized_frames_agent_raw_span'").get());
	} finally {
		database.close();
	}
});

test("raw-range message cursors retain the broad range and historical profile", () => {
	const { database, commands, profileId, dataRevision } = seedAnalysisCapture();
	try {
		const query = new CanonicalQueryService(database);
		const first = query.queryMessages({ captureId: "analysis-capture", rawOffsetFrom: 0, rawOffsetTo: 7, limit: 2 });
		assert.deepEqual(first.data.messages.map(message => message.ordinal), [0, 1]);
		assert.ok(first.meta.page?.nextCursor);
		const continued = query.queryMessages({ captureId: "analysis-capture", rawOffsetFrom: 0, rawOffsetTo: 7, limit: 2, cursor: first.meta.page?.nextCursor });
		assert.deepEqual(continued.data.messages.map(message => message.ordinal), [2, 3]);
		assert.equal(continued.meta.page?.nextCursor, undefined);
		assert.throws(
			() => query.queryMessages({ captureId: "analysis-capture", rawOffsetFrom: 0, rawOffsetTo: 6, limit: 2, cursor: first.meta.page?.nextCursor }),
			error => (error as { code?: string }).code === "invalid-cursor"
		);

		const historicalFrame = query.queryMessages({ captureId: "analysis-capture", profileId, rawOffsetFrom: 2, rawOffsetTo: 3 }).data.messages[0];
		assert.ok(historicalFrame);
		commands.reframe({ captureId: "analysis-capture", expectedActiveProfileId: profileId, expectedDataRevision: dataRevision, sections: [{ start: 0, framingMode: "length", frameSize: 1 }] });
		const historical = query.queryMessages({ captureId: "analysis-capture", profileId, rawOffsetFrom: 2, rawOffsetTo: 3 });
		assert.equal(historical.meta.snapshot?.profileId, profileId);
		assert.equal(historical.data.messages[0]?.frameId, historicalFrame.frameId);
		assert.deepEqual(historical.data.messages[0]?.rawSpan, { startOffset: 2, endOffset: 3 });
	} finally {
		database.close();
	}
});

test("raw-range message queries reject reversed bounds", () => {
	const { database } = seedAnalysisCapture();
	try {
		const query = new CanonicalQueryService(database);
		assert.throws(
			() => query.queryMessages({ captureId: "analysis-capture", rawOffsetFrom: 3, rawOffsetTo: 2 }),
			error => (error as { code?: string }).code === "invalid-input"
		);
	} finally {
		database.close();
	}
});

test("size-bounded message pages binary-search bulky rows and preserve cursor traversal", () => {
	const { database, profileId } = seedManyFrameAnalysisCapture(200);
	try {
		const bulkyBytes = JSON.stringify(Array.from({ length: 256 }, () => 255));
		database.prepare("UPDATE materialized_frames SET bytes_json = @bytes WHERE profile_id = @profileId").run({ profileId, bytes: bulkyBytes });
		const query = new CanonicalQueryService(database);
		let response = query.queryMessages({ captureId: "many-frame-analysis-capture", profileId, limit: 200 });
		assert.ok(response.data.messages.length > 0);
		assert.ok(response.data.messages.length < 200);
		assert.equal(response.meta.page?.effectiveLimit, response.data.messages.length);
		assert.equal(response.meta.page?.truncationReason, "response-size");
		assert.equal(response.meta.truncated, true);

		const ordinals: number[] = [];
		for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
			ordinals.push(...response.data.messages.map(message => message.ordinal));
			const cursor = response.meta.page?.nextCursor;
			if (!cursor) {
				assert.equal(response.meta.truncated, false);
				assert.equal(response.meta.page?.truncationReason, undefined);
				break;
			}
			response = query.queryMessages({ captureId: "many-frame-analysis-capture", profileId, limit: 200, cursor });
			if (pageNumber === 19) throw new Error("bulky page traversal did not reach a final page");
		}
		assert.deepEqual(ordinals, Array.from({ length: 200 }, (_value, index) => index));
	} finally {
		database.close();
	}
});

test("size-bounded analysis metadata distinguishes ordinary and final partial pages", () => {
	const { database, profileId, groupId } = seedAnalysisCapture();
	try {
		const query = new CanonicalQueryService(database);
		const first = query.queryMessages({ captureId: "analysis-capture", profileId, limit: 3 });
		assert.equal(first.data.messages.length, 3);
		assert.equal(first.meta.page?.effectiveLimit, 3);
		assert.equal(first.meta.page?.truncationReason, "page-limit");
		const final = query.queryMessages({ captureId: "analysis-capture", profileId, limit: 3, cursor: first.meta.page?.nextCursor });
		assert.equal(final.data.messages.length, 1);
		assert.equal(final.meta.page?.effectiveLimit, 1);
		assert.equal(final.meta.page?.truncationReason, undefined);
		assert.equal(final.meta.truncated, false);

		const groups = query.getSequenceGroups({ captureId: "analysis-capture", profileId, limit: 10 });
		assert.equal(groups.meta.page?.effectiveLimit, groups.data.groups.length);
		assert.equal(groups.meta.page?.truncationReason, undefined);
		const occurrences = query.getSequenceOccurrences({ captureId: "analysis-capture", groupId, profileId, limit: 10 });
		assert.equal(occurrences.meta.page?.effectiveLimit, occurrences.data.occurrences.length);
		assert.equal(occurrences.meta.page?.truncationReason, undefined);
	} finally {
		database.close();
	}
});

test("size-bounded analysis pages reject a single record beyond the hard response limit", () => {
	const { database, profileId } = seedAnalysisCapture();
	try {
		const frame = database.prepare("SELECT id FROM materialized_frames WHERE profile_id = @profileId LIMIT 1").get({ profileId }) as { id: string };
		database.prepare("UPDATE materialized_frames SET bytes_json = @bytes WHERE id = @id").run({ id: frame.id, bytes: JSON.stringify(Array.from({ length: 50_000 }, () => 255)) });
		const query = new CanonicalQueryService(database);
		assert.throws(
			() => query.queryMessages({ captureId: "analysis-capture", profileId, limit: 200 }),
			error => (error as { code?: string }).code === "response-too-large"
		);
	} finally {
		database.close();
	}
});

test("analysis messages attach each sequence member to its offset frame", () => {
	const { database, groupId } = seedAnalysisCapture();
	try {
		database.prepare(
			`INSERT INTO sequence_occurrences
			 (group_id, occurrence_index, offset, start_frame_ordinal, start_raw_offset, end_raw_offset, length)
			 VALUES (@groupId, 0, 1, 0, 0, 3, 2), (@groupId, 1, 1, 2, 4, 7, 2)`
		).run({ groupId });

		const query = new CanonicalQueryService(database);
		const messages = query.queryMessages({ captureId: "analysis-capture", limit: 10 }).data.messages;
		assert.deepEqual(messages.map(message => message.sequenceMembership), [
			[{ groupId, occurrenceNumber: 0, offset: 0 }],
			[{ groupId, occurrenceNumber: 0, offset: 1 }],
			[{ groupId, occurrenceNumber: 1, offset: 0 }],
			[{ groupId, occurrenceNumber: 1, offset: 1 }]
		]);
	} finally {
		database.close();
	}
});

test("analysis note presence includes byte notes at frame raw-span boundaries", () => {
	const { database, commands } = seedAnalysisCapture();
	try {
		commands.deleteNote({ captureId: "analysis-capture", noteId: "analysis-frame-note" });
		commands.createNote({ captureId: "analysis-capture", noteId: "analysis-byte-note", text: "inspect this byte", target: { kind: "byte", rawOffset: 0 } });
		const query = new CanonicalQueryService(database);
		const withNote = query.queryMessages({ captureId: "analysis-capture", notePresence: "with-note" }).data.messages;
		assert.deepEqual(withNote.map(message => message.ordinal), [0]);
		assert.deepEqual(withNote[0]?.noteReferences, ["analysis-byte-note"]);
		assert.deepEqual(query.queryMessages({ captureId: "analysis-capture", notePresence: "without-note" }).data.messages.map(message => message.ordinal), [1, 2, 3]);
	} finally {
		database.close();
	}
});

test("analysis groups, occurrences, statistics, transitions, and raw reads remain bounded", () => {
	const { database, profileId, groupId } = seedAnalysisCapture();
	try {
		const query = new CanonicalQueryService(database);
		const groups = query.getSequenceGroups({ captureId: "analysis-capture", profileId, limit: 10 });
		assert.equal(groups.data.groups[0]?.occurrenceCount, 2);
		assert.deepEqual(groups.data.groups[0]?.sections.length, 1);
		const occurrences = query.getSequenceOccurrences({ captureId: "analysis-capture", groupId, profileId, includeContext: true, contextBefore: 1, contextAfter: 1 });
		assert.equal(occurrences.data.occurrences.length, 2);
		assert.ok(occurrences.data.occurrences[0]?.context?.length);
		const statistics = query.getByteStatistics({ captureId: "analysis-capture", profileId, positions: [0, 1] });
		assert.equal(statistics.data.positions.length, 2);
		assert.ok(statistics.data.positions[0]?.vocabulary.length);
		const transitions = query.getTransitions({ captureId: "analysis-capture", profileId, minimumCount: 1 });
		assert.ok(transitions.data.transitions.length);
		const sectionId = (database.prepare("SELECT section_id FROM materialized_frames WHERE profile_id = @profileId ORDER BY ordinal LIMIT 1").get({ profileId }) as { section_id: string }).section_id;
		const sectionOnly = query.getTransitions({ captureId: "analysis-capture", profileId, sectionId });
		assert.ok(sectionOnly.data.transitions.length);
		assert.ok(sectionOnly.data.transitions.every(transition => transition.sectionId === sectionId));
		assert.ok(sectionOnly.data.transitions.every(transition => transition.changedPositionCount > 0));
		assert.ok(sectionOnly.data.transitions.every(transition => transition.fromSignature !== transition.toSignature));
		const positionOnly = query.getTransitions({ captureId: "analysis-capture", profileId, changedPositions: [0] });
		assert.ok(positionOnly.data.transitions.length);
		const aliasRefined = query.getTransitions({ captureId: "analysis-capture", profileId, sectionId, fromSignature: transitions.data.transitions[0]!.fromSignature });
		assert.ok(aliasRefined.data.transitions.length);
		const snapshot = query.queryCaptureOverview("analysis-capture").meta.snapshot;
		assert.ok(snapshot);
		const raw = query.readRawBytes({ captureId: "analysis-capture", rawOffset: 0, length: 4 });
		assert.equal(raw.data.returnedByteCount, 4);
		assert.equal(raw.data.hex, "01 ?? 01 02");
		assert.equal(raw.data.timestamps.deltas.length, 3);
		assert.deepEqual(raw.meta.suggestedOperations[0], {
			tool: "query_messages",
			reason: "Find interpreted frames overlapping this range with reverse raw-range lookup",
			arguments: {
				captureId: "analysis-capture",
				rawOffsetFrom: 0,
				rawOffsetTo: 3,
				profileId,
				profileVersion: snapshot.profileVersion,
				sourceDataRevision: snapshot.sourceDataRevision
			}
		});
		assert.throws(() => query.readRawBytes({ captureId: "analysis-capture", rawOffset: 0, length: 4097 }), /length/);
	} finally {
		database.close();
	}
});

test("indexed transitions match aggregate max-width diffs and use bounded position pagination", () => {
		const { database, profileId, sections } = seedMixedFrameAnalysisCapture();
		try {
			const query = new CanonicalQueryService(database);
			const aggregate = query.getTransitions({ captureId: "mixed-frame-analysis-capture", profileId, limit: 20 });
			const unequal = aggregate.data.transitions.find(transition => transition.fromSignature === "10 02" && transition.toSignature === "A0 01 02");
			assert.deepEqual(unequal && {
				changedPositionCount: unequal.changedPositionCount,
				changedPositions: unequal.changedPositions
			}, { changedPositionCount: 3, changedPositions: [] });

			const indexed = query.getTransitions({
				captureId: "mixed-frame-analysis-capture",
				profileId,
				sectionId: sections[0]!.id,
				sourceSignature: "10 02",
				destinationSignature: "A0 01 02"
			});
			assert.deepEqual(indexed.data.transitions[0]?.changedPositions, [0, 1, 2]);
			assert.equal(indexed.data.transitions[0]?.changedPositionCount, unequal?.changedPositionCount);
			assert.deepEqual(indexed.data.transitions[0]?.changedPositionCounts, [
				{ position: 0, changedCount: 1 },
				{ position: 1, changedCount: 1 },
				{ position: 2, changedCount: 1 }
			]);
			assert.deepEqual(indexed.data.transitions[0]?.changedPercentages, [
				{ position: 0, percentage: 100 },
				{ position: 1, percentage: 100 },
				{ position: 2, percentage: 100 }
			]);

			assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'frame_transition_positions_profile_section_position_changed_count'").get());
			const plan = database.prepare(
				`EXPLAIN QUERY PLAN
				 SELECT section_id, from_signature, to_signature, changed_count
				 FROM frame_transition_positions
				 WHERE profile_id = @profileId AND section_id = @sectionId AND position = @position`
			).all({ profileId, sectionId: sections[0]!.id, position: 2 }) as Array<{ detail: string }>;
			assert.ok(plan.some(row => row.detail.includes("frame_transition_positions_profile_section_position_changed_count")));
		} finally {
			database.close();
		}
});

test("indexed transition cursors are bounded, snapshot-pinned, and accept omitted snapshot fields", () => {
		const { database, commands, profileId, dataRevision } = seedAnalysisCapture();
		try {
			const query = new CanonicalQueryService(database);
			const sectionId = (database.prepare("SELECT section_id FROM materialized_frames WHERE profile_id = @profileId LIMIT 1").get({ profileId }) as { section_id: string }).section_id;
			const first = query.getTransitions({ captureId: "analysis-capture", sectionId, limit: 1 });
			assert.equal(first.data.transitions.length, 1);
			assert.ok(first.meta.page?.nextCursor);
			assert.equal(first.meta.page?.effectiveLimit, 1);
			const snapshot = first.meta.snapshot!;

			commands.reframe({
				captureId: "analysis-capture",
				expectedActiveProfileId: profileId,
				expectedDataRevision: dataRevision,
				sections: [{ start: 0, framingMode: "length", frameSize: 1 }]
			});

			const continued = query.getTransitions({ captureId: "analysis-capture", sectionId, limit: 1, cursor: first.meta.page?.nextCursor });
			assert.equal(continued.data.transitions.length, 1);
			assert.equal(continued.meta.snapshot?.profileId, snapshot.profileId);
			assert.notEqual(continued.data.transitions[0]?.fromSignature, first.data.transitions[0]?.fromSignature);

			assert.doesNotThrow(() => query.getTransitions({
				captureId: "analysis-capture",
				sectionId,
				profileId: snapshot.profileId,
				profileVersion: snapshot.profileVersion,
				sourceDataRevision: snapshot.sourceDataRevision,
				limit: 1,
				cursor: first.meta.page?.nextCursor
			}));
			assert.throws(
				() => query.getTransitions({ captureId: "analysis-capture", sectionId, profileVersion: snapshot.profileVersion + 1, limit: 1, cursor: first.meta.page?.nextCursor }),
				error => (error as { code?: string }).code === "invalid-cursor"
			);
			assert.throws(
				() => query.getTransitions({ captureId: "analysis-capture", sectionId: "different-section", limit: 1, cursor: first.meta.page?.nextCursor }),
				error => (error as { code?: string }).code === "invalid-cursor"
			);
		} finally {
			database.close();
		}
});

test("sequence occurrence suggestions use a stable starting frame without context", () => {
	const { database, profileId, groupId, firstFrameId } = seedAnalysisCapture();
	try {
		const query = new CanonicalQueryService(database);
		const response = query.getSequenceOccurrences({ captureId: "analysis-capture", groupId, profileId, includeContext: false });

		assert.equal(response.data.occurrences[0]?.context, undefined);
		assert.equal(response.data.occurrences[0]?.startingOrdinal, 0);
		assert.deepEqual(response.meta.suggestedOperations[0], {
			tool: "get_message_context",
			reason: "Inspect a frame near this occurrence",
			arguments: { frameId: firstFrameId }
		});
	} finally {
		database.close();
	}
});

test("byte statistics scope frame families with SQL-derived denominators and remains snapshot-pinned", () => {
	const { database, commands, profileId, dataRevision, sections } = seedMixedFrameAnalysisCapture();
	try {
		const query = new CanonicalQueryService(database);
		const profileWide = query.getByteStatistics({ captureId: "mixed-frame-analysis-capture", profileId, positions: [0, 1, 2] });
		assert.deepEqual(profileWide.data.scope, {});
		assert.equal(profileWide.data.matchedFrameCount, 4);
		assert.deepEqual(profileWide.meta.appliedFilters.scope, {});
		assert.equal(profileWide.data.positions.find(position => position.position === 0)?.applicableFrameCount, 4);
		assert.deepEqual(profileWide.data.positions.find(position => position.position === 2)?.vocabulary, [{ value: 2, count: 1 }, { value: 4, count: 1 }]);
		assert.equal(profileWide.data.positions.find(position => position.position === 2)?.applicableFrameCount, 2);

		const twoByteSection = query.getByteStatistics({
			captureId: "mixed-frame-analysis-capture",
			profileId,
			positions: [0, 1, 2],
			scope: { sectionId: sections[0]!.id }
		});
		assert.deepEqual(twoByteSection.data.scope, { sectionId: sections[0]!.id });
		assert.equal(twoByteSection.data.matchedFrameCount, 2);
		assert.equal(twoByteSection.data.positions.find(position => position.position === 0)?.applicableFrameCount, 2);
		assert.deepEqual(twoByteSection.data.positions.find(position => position.position === 2)?.vocabulary, []);
		assert.equal(twoByteSection.data.positions.find(position => position.position === 2)?.variance, null);

		const threeByteFrames = query.getByteStatistics({
			captureId: "mixed-frame-analysis-capture",
			profileId,
			positions: [0, 1, 2],
			scope: { frameLength: 3 }
		});
		assert.equal(threeByteFrames.data.matchedFrameCount, 2);
		assert.equal(threeByteFrames.data.positions.find(position => position.position === 2)?.applicableFrameCount, 2);
		assert.deepEqual(threeByteFrames.data.positions.find(position => position.position === 0)?.vocabulary, [{ value: 160, count: 2 }]);

		const wildcard = query.getByteStatistics({
			captureId: "mixed-frame-analysis-capture",
			profileId,
			positions: [0, 1, 2],
			scope: { wildcardHexPattern: "a0 ?? 04" }
		});
		assert.deepEqual(wildcard.data.scope, { wildcardHexPattern: "A0 ?? 04" });
		assert.equal(wildcard.data.matchedFrameCount, 1);
		assert.deepEqual(wildcard.data.positions.find(position => position.position === 1)?.vocabulary, [{ value: 3, count: 1 }]);
		assert.equal(wildcard.data.positions.find(position => position.position === 1)?.bitOnePercentages.find(bit => bit.bit === 1)?.percentage, 100);

		const txFrames = query.getByteStatistics({
			captureId: "mixed-frame-analysis-capture",
			profileId,
			positions: [0, 1],
			scope: { direction: "TX" }
		});
		assert.deepEqual(txFrames.data.scope, { direction: "tx" });
		assert.equal(txFrames.data.matchedFrameCount, 2);
		assert.equal(txFrames.data.positions.find(position => position.position === 1)?.bitOnePercentages.find(bit => bit.bit === 1)?.percentage, 50);
		assert.deepEqual(query.getByteStatistics({
			captureId: "mixed-frame-analysis-capture",
			profileId,
			positions: [1],
			scope: { exactSignature: "a0 03 04" }
		}).data.scope, { exactSignature: "A0 03 04" });

		const empty = query.getByteStatistics({ captureId: "mixed-frame-analysis-capture", profileId, positions: [0], scope: { sectionId: "missing-section" } });
		assert.equal(empty.data.matchedFrameCount, 0);
		assert.deepEqual(empty.data.positions[0], { position: 0, vocabulary: [], bitOnePercentages: [], variance: null, applicableFrameCount: 0 });
		assert.throws(
			() => query.getByteStatistics({ captureId: "mixed-frame-analysis-capture", profileId, positions: [0], scope: {} }),
			error => (error as { code?: string }).code === "invalid-input"
		);
		assert.throws(
			() => query.getByteStatistics({ captureId: "mixed-frame-analysis-capture", profileId, positions: [0], scope: { wildcardHexPattern: "?? 01" } }),
			error => (error as { code?: string }).code === "wildcard-too-broad"
		);

		commands.reframe({
			captureId: "mixed-frame-analysis-capture",
			expectedActiveProfileId: profileId,
			expectedDataRevision: dataRevision,
			sections: [{ start: 0, framingMode: "length", frameSize: 1 }]
		});
		const historical = query.getByteStatistics({
			captureId: "mixed-frame-analysis-capture",
			profileId,
			positions: [2],
			scope: { frameLength: 3 }
		});
		assert.equal(historical.meta.snapshot?.profileId, profileId);
		assert.equal(historical.data.matchedFrameCount, 2);
		assert.deepEqual(historical.data.positions[0]?.vocabulary, [{ value: 2, count: 1 }, { value: 4, count: 1 }]);
	} finally {
		database.close();
	}
});

test("message cursors keep the original profile pinned across reframing", () => {
	const { database, commands, profileId, dataRevision } = seedAnalysisCapture();
	try {
		const query = new CanonicalQueryService(database);
		const first = query.queryMessages({ captureId: "analysis-capture", limit: 1 });
		commands.reframe({ captureId: "analysis-capture", expectedActiveProfileId: profileId, expectedDataRevision: dataRevision, sections: [{ start: 0, framingMode: "length", frameSize: 1 }] });
		const continued = query.queryMessages({ captureId: "analysis-capture", limit: 1, cursor: first.meta.page?.nextCursor });
		assert.equal(continued.meta.snapshot?.profileId, profileId);
		assert.equal(continued.data.messages[0]?.ordinal, 1);
		const historicalFrameId = first.data.messages[0]!.frameId;
		const historicalContext = query.getMessageContext({ frameId: historicalFrameId });
		assert.equal(historicalContext.meta.snapshot?.profileId, profileId);
		assert.equal(historicalContext.data.centerFrameId, historicalFrameId);
		assert.throws(
			() => query.getMessageContext({ frameId: historicalFrameId, profileVersion: 999 }),
			error => (error as { code?: string }).code === "snapshot-mismatch"
		);
	} finally {
		database.close();
	}
});

import assert from "node:assert/strict";
import test from "node:test";
import { ArchiveRepository } from "../server/archive-repository.ts";
import { openDatabase } from "../server/database.ts";

const now = "2026-01-01T00:00:00.000Z";

function legacyCapture(id: string, sections: Array<{ id: string; start: number }>, values?: number[]): Record<string, unknown> {
	const sourceValues = values ?? Array.from({ length: sections.length * 2 }, (_, rawOffset) => 0x10 + rawOffset);
	const byteStream = sourceValues.map((value, rawOffset) => ({
		rawOffset,
		value,
		timestamp: rawOffset + 1,
		direction: "rx"
	}));
	return {
		id,
		name: id,
		createdAt: now,
		byteStream,
		frameSections: sections.map(section => ({
			...section,
			framingMode: "length",
			frameSize: 2
		})),
		messages: Array.from({ length: Math.floor(byteStream.length / 2) }, (_, index) => ({
			id: `${id}-message-${index}`,
			timestamp: index * 2 + 1,
			bytes: byteStream.slice(index * 2, index * 2 + 2).map(record => record.value),
			byteTimestamps: byteStream.slice(index * 2, index * 2 + 2).map(record => record.timestamp),
			directions: ["rx", "rx"],
			rawOffsets: [index * 2, index * 2 + 1],
			_rawPositions: [index * 2, index * 2 + 1],
			sectionId: [...sections].reverse().find(section => section.start <= index * 2)?.id || sections[0].id
		}))
	};
}

test("legacy captures with shared section ids get distinct canonical section identities", () => {
	const database = openDatabase(":memory:");
	let generated = 0;
	const repository = new ArchiveRepository(database, {
		nowIso: () => now,
		generateId: () => `canonical-${generated++}`
	});
	try {
		const firstDocument = legacyCapture("capture-one", [{ id: "section-0", start: 0 }]);
		const secondDocument = legacyCapture("capture-two", [{ id: "section-0", start: 0 }]);
		repository.putCapture("capture-one", firstDocument);
		repository.putCapture("capture-two", secondDocument);
		const firstJson = (database.prepare("SELECT document_json FROM capture_documents WHERE id = 'capture-one'").get() as { document_json: string }).document_json;
		const secondJson = (database.prepare("SELECT document_json FROM capture_documents WHERE id = 'capture-two'").get() as { document_json: string }).document_json;

		assert.equal(repository.convertCaptureToCanonical("capture-one").verified, true);
		assert.equal(repository.convertCaptureToCanonical("capture-two").verified, true);

		const sections = database
			.prepare("SELECT capture_id, id FROM framing_sections WHERE capture_id IN ('capture-one', 'capture-two') ORDER BY capture_id")
			.all() as Array<{ capture_id: string; id: string }>;
		assert.equal(sections.length, 2);
		assert.notEqual(sections[0].id, "section-0");
		assert.notEqual(sections[1].id, "section-0");
		assert.notEqual(sections[0].id, sections[1].id);

		for (const section of sections) {
			const frames = database
				.prepare("SELECT section_id FROM materialized_frames WHERE capture_id = @captureId")
				.all({ captureId: section.capture_id }) as Array<{ section_id: string }>;
			assert.deepEqual([...new Set(frames.map(frame => frame.section_id))], [section.id]);
		}

		// Conversion must leave the legacy JSON source available for recovery and retry.
		assert.equal((database.prepare("SELECT document_json FROM capture_documents WHERE id = 'capture-one'").get() as { document_json: string }).document_json, firstJson);
		assert.equal((database.prepare("SELECT document_json FROM capture_documents WHERE id = 'capture-two'").get() as { document_json: string }).document_json, secondJson);
	} finally {
		repository.close();
	}
});

test("repeated section ids in one legacy document are remapped before frame materialization", () => {
	const database = openDatabase(":memory:");
	const repository = new ArchiveRepository(database, {
		nowIso: () => now,
		generateId: (() => {
			let generated = 0;
			return () => `canonical-${generated++}`;
		})()
	});
	try {
		repository.putCapture("repeated-sections", legacyCapture("repeated-sections", [
			{ id: "section-0", start: 0 },
			{ id: "section-0", start: 4 }
		], [0x10, 0x11, 0x20, 0x21, 0x10, 0x11, 0x20, 0x21]));

		const result = repository.convertCaptureToCanonical("repeated-sections");
		assert.equal(result.verified, true);

		const sections = database
			.prepare("SELECT id, start_offset FROM framing_sections WHERE capture_id = 'repeated-sections' ORDER BY position")
			.all() as Array<{ id: string; start_offset: number }>;
		const frames = database
			.prepare("SELECT section_id, raw_offsets_json FROM materialized_frames WHERE capture_id = 'repeated-sections' ORDER BY ordinal")
			.all() as Array<{ section_id: string; raw_offsets_json: string }>;

		assert.deepEqual(sections.map(section => section.start_offset), [0, 4]);
		assert.equal(new Set(sections.map(section => section.id)).size, 2);
		assert.deepEqual(frames.map(frame => ({ sectionId: frame.section_id, rawOffsets: JSON.parse(frame.raw_offsets_json) })), [
			{ sectionId: sections[0].id, rawOffsets: [0, 1] },
			{ sectionId: sections[0].id, rawOffsets: [2, 3] },
			{ sectionId: sections[1].id, rawOffsets: [4, 5] },
			{ sectionId: sections[1].id, rawOffsets: [6, 7] }
		]);
	} finally {
		repository.close();
	}
});

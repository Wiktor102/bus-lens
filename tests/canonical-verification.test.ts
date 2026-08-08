import assert from "node:assert/strict";
import test from "node:test";
import { convertCaptureDocumentToCanonical } from "../server/canonical.ts";
import { openDatabase } from "../server/database.ts";

const now = "2026-01-01T00:00:00.000Z";

function seedCapture(database: ReturnType<typeof openDatabase>, id: string, document: Record<string, unknown>): void {
	database
		.prepare(
			`INSERT INTO capture_documents (id, document_version, document_json, created_at, updated_at)
			 VALUES (@id, 1, @documentJson, @createdAt, @updatedAt)`
		)
		.run({ id, documentJson: JSON.stringify(document), createdAt: now, updatedAt: now });
}

function captureDocument(messageBytes: number[]): Record<string, unknown> {
	return {
		id: "capture-1",
		name: "Source capture",
		createdAt: now,
		previewMode: "length",
		frameSize: 2,
		frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 2 }],
		byteStream: [
			{ rawOffset: 0, value: 1, timestamp: 1, direction: "rx" },
			{ rawOffset: 1, value: 2, timestamp: 2, direction: "rx" }
		],
		messages: [
			{
				id: "message-1",
				timestamp: 1,
				byteTimestamps: [1, 2],
				bytes: messageBytes,
				directions: ["rx", "rx"],
				hidden: false,
				hiddenBytes: [false, false],
				rawOffsets: [0, 1],
				_rawPositions: [0, 1],
				sectionId: "section-1"
			}
		]
	};
}

function conversionOptions() {
	let generated = 0;
	return {
		nowIso: () => now,
		generateId: () => `generated-${generated++}`
	};
}

test("conversion verification compares rebuilt frames with the original messages", () => {
	const database = openDatabase(":memory:");
	try {
		seedCapture(database, "capture-1", captureDocument([1, 3]));

		const result = convertCaptureDocumentToCanonical(database, "capture-1", conversionOptions());

		assert.equal(result.verified, false);
		assert.equal(result.report.messageCount.expected, 1);
		assert.equal(result.report.messageCount.actual, 1);
		assert.equal(result.report.signaturesOk, false);
		assert.equal(result.report.overallOk, false);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count, 0);
	} finally {
		database.close();
	}
});

test("conversion verification re-reads persisted canonical frames", () => {
	const database = openDatabase(":memory:");
	try {
		seedCapture(database, "capture-1", captureDocument([1, 2]));
		database.exec(`
			CREATE TRIGGER corrupt_materialized_frame
			AFTER INSERT ON materialized_frames
			BEGIN
				UPDATE materialized_frames SET signature = 'CORRUPTED' WHERE id = NEW.id;
			END;
		`);

		const result = convertCaptureDocumentToCanonical(database, "capture-1", conversionOptions());

		assert.equal(result.verified, false);
		assert.equal(result.report.overallOk, false);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count, 0);
	} finally {
		database.close();
	}
});

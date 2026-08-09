import assert from "node:assert/strict";
import test from "node:test";
import { CanonicalCaptureCommandService, CanonicalCaptureIdempotencyConflictError } from "../server/canonical-capture-command-service.ts";
import { openDatabase } from "../server/database.ts";

function columns(database: ReturnType<typeof openDatabase>, table: string): Set<string> {
	return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));
}

function installCommandSchema(database: ReturnType<typeof openDatabase>): void {
	if (!columns(database, "captures").has("create_request_hash")) database.exec("ALTER TABLE captures ADD COLUMN create_request_hash TEXT");
	if (!columns(database, "capture_parameters").has("key_text")) {
		database.exec("DROP TABLE capture_parameters");
		database.exec(`
			CREATE TABLE capture_parameters (
				capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				key_text TEXT NOT NULL,
				value_text TEXT NOT NULL,
				PRIMARY KEY (capture_id, position)
			)
		`);
	}
	if (!columns(database, "capture_sessions").has("next_chunk_sequence")) {
		database.exec("ALTER TABLE capture_sessions ADD COLUMN next_chunk_sequence INTEGER NOT NULL DEFAULT 0");
	}
	if (!columns(database, "framing_drafts").has("sections_json")) {
		database.exec("DROP TABLE framing_drafts");
		database.exec(`
			CREATE TABLE framing_drafts (
				capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
				revision INTEGER NOT NULL,
				sections_json TEXT NOT NULL CHECK (json_valid(sections_json)),
				updated_at TEXT NOT NULL,
				PRIMARY KEY (capture_id, revision)
			)
		`);
	}
	if (!columns(database, "frame_visibility").has("start_raw_offset")) {
		database.exec("DROP TABLE frame_visibility");
		database.exec(`
			CREATE TABLE frame_visibility (
				capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
				profile_id TEXT NOT NULL REFERENCES framing_profiles(id) ON DELETE CASCADE,
				start_raw_offset INTEGER NOT NULL,
				end_raw_offset INTEGER NOT NULL,
				hidden INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (capture_id, profile_id, start_raw_offset, end_raw_offset)
			)
		`);
	}
	database.exec(`
		CREATE TABLE IF NOT EXISTS capture_storage (
			capture_id TEXT PRIMARY KEY NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
			status TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_error TEXT
		);
	`);
}

test("canonical creation is idempotent by stable request hash and stores ordered metadata", () => {
	const database = openDatabase(":memory:");
	installCommandSchema(database);
	try {
		const service = new CanonicalCaptureCommandService(database, {
			nowIso: () => "2026-08-09T00:00:00.000Z",
			generateId: () => "generated-capture"
		});
		const request = {
			captureId: "capture-1",
			name: "Canonical capture",
			description: "operator notes",
			controllerView: "RS-485",
			baudRate: 115200,
			inputFormat: "hex",
			parameters: [
				{ key: "mode", value: "safe" },
				{ key: "channel", value: "A" }
			]
		} as const;
		const first = service.createCapture(request);
		const second = service.createCapture(request);
		assert.equal(first.captureId, "capture-1");
		assert.deepEqual(second, first);
		assert.equal(first.storage.status, "canonical");
		assert.deepEqual(
			database.prepare("SELECT position, key_text, value_text FROM capture_parameters ORDER BY position").all(),
			[
				{ position: 0, key_text: "mode", value_text: "safe" },
				{ position: 1, key_text: "channel", value_text: "A" }
			]
		);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM capture_documents").get() as { count: number }).count, 0);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM capture_backups").get() as { count: number }).count, 0);
		assert.throws(
			() => service.createCapture({ ...request, name: "different" }),
			(error: unknown) => error instanceof CanonicalCaptureIdempotencyConflictError
		);
	} finally {
		database.close();
	}
});

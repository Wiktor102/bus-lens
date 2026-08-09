import assert from "node:assert/strict";
import test from "node:test";
import { CanonicalCaptureCommandService, CanonicalCaptureIdempotencyConflictError } from "../server/canonical-capture-command-service.ts";
import { openDatabase } from "../server/database.ts";

const framing = [{ start: 0, framingMode: "length", frameSize: 2, collapseRuns: false, collapsed: false }] as const;

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
		CREATE TABLE IF NOT EXISTS raw_chunk_requests (
			capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
			request_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			sequence INTEGER NOT NULL,
			expected_start_offset INTEGER NOT NULL,
			payload_hash TEXT NOT NULL,
			accepted_start_offset INTEGER NOT NULL,
			accepted_end_offset INTEGER NOT NULL,
			next_raw_offset INTEGER NOT NULL,
			next_sequence INTEGER NOT NULL,
			data_revision INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (capture_id, request_id)
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
			framing,
			name: "Canonical capture",
			description: "operator notes",
			controllerView: "RS-485",
			baudRate: 115200,
			inputFormat: "binary",
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
		assert.equal(first.lifecycle, "finalized");
		assert.equal(first.activeProfile, null);
		assert.equal(first.draft?.sections[0].framingMode, "length");
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

test("metadata patches increment only metadata revision and replace parameters in order", () => {
	const database = openDatabase(":memory:");
	installCommandSchema(database);
	try {
		const service = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-09T00:00:00.000Z" });
		const created = service.createCapture({ captureId: "metadata-capture", framing, inputFormat: "binary", name: "Before", parameters: [{ key: "one", value: "1" }] });
		const updated = service.patchMetadata({
			captureId: created.captureId,
			expectedMetadataRevision: 0,
			patch: {
				name: "After",
				description: "Updated description",
				controllerView: "controller",
				baudRate: 9600,
				inputFormat: "binary",
				parameters: [
					{ key: "two", value: "2" },
					{ key: "one", value: "changed" }
				]
			}
		});
		assert.equal(updated.metadataRevision, 1);
		assert.equal(updated.dataRevision, 0);
		assert.equal(updated.contentRevision, 0);
		assert.equal(updated.name, "After");
		assert.equal(updated.description, "Updated description");
		assert.equal(updated.controllerView, "controller");
		assert.equal(updated.baudRate, 9600);
		assert.deepEqual(updated.parameters, [
			{ key: "two", value: "2" },
			{ key: "one", value: "changed" }
		]);
		assert.throws(
			() => service.patchMetadata({ captureId: created.captureId, expectedMetadataRevision: 0, patch: { name: "stale" } }),
			(error: unknown) => error instanceof Error && "details" in error && (error as { details: { actualMetadataRevision?: number } }).details.actualMetadataRevision === 1
		);
	} finally {
		database.close();
	}
});

test("sessions are durable, retryable by id, and support repeat recording", () => {
	const database = openDatabase(":memory:");
	installCommandSchema(database);
	try {
		let nextId = 0;
		const service = new CanonicalCaptureCommandService(database, {
			nowIso: () => "2026-08-09T00:00:00.000Z",
			generateId: () => `session-${nextId++}`
		});
		service.createCapture({ captureId: "session-capture", framing, inputFormat: "binary" });
		const first = service.startSession({ captureId: "session-capture", sessionId: "recording-a" });
		const retry = service.startSession({ captureId: "session-capture", sessionId: "recording-a" });
		assert.deepEqual(retry, first);
		assert.equal(first.session.status, "recording");
		assert.equal(first.session.nextChunkSequence, 0);
		assert.equal(first.session.nextRawOffset, 0);
		assert.throws(() => service.startSession({ captureId: "session-capture", sessionId: "recording-b" }));

		database.prepare("UPDATE capture_sessions SET status = 'finalized', finalized_at = @finalizedAt WHERE id = 'recording-a'").run({ finalizedAt: "2026-08-09T00:01:00.000Z" });
		const second = service.startSession({ captureId: "session-capture" });
		assert.equal(second.session.ordinal, 1);
		assert.equal(second.session.id, "session-1");
		assert.equal(second.session.nextRawOffset, 0);
		assert.equal(service.getCaptureState("session-capture").sessions.length, 2);
	} finally {
		database.close();
	}
});

test("append flattens segments, preserves byte metadata, and is SHA-256 idempotent", () => {
	const database = openDatabase(":memory:");
	installCommandSchema(database);
	try {
		const service = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-09T00:00:00.000Z" });
		service.createCapture({ captureId: "append-capture", framing, inputFormat: "binary" });
		service.startSession({ captureId: "append-capture", sessionId: "append-session" });
		const request = {
			captureId: "append-capture",
			sessionId: "append-session",
			requestId: "request-1",
			sequence: 0,
			expectedStartOffset: 0,
			segments: [
				{ timestamp: 100, direction: "rx", bytes: [0x10, 0x11] },
				{ timestamp: 120, direction: "tx", bytes: [0x20] }
			]
		} as const;
		const first = service.appendChunk(request);
		const retry = service.appendChunk(request);
		assert.deepEqual(retry, first);
		assert.equal(first.acceptedStartOffset, 0);
		assert.equal(first.acceptedEndOffset, 3);
		assert.equal(first.nextRawOffset, 3);
		assert.equal(first.nextSequence, 1);
		assert.equal(first.dataRevision, 1);
		assert.equal(retry.dataRevision, first.dataRevision);
		const chunk = database.prepare("SELECT start_offset, byte_count, bytes, timestamps_json, directions_json, session_ids_json FROM raw_chunks WHERE capture_id = 'append-capture'").get() as {
			start_offset: number;
			byte_count: number;
			bytes: Buffer;
			timestamps_json: string;
			directions_json: string;
			session_ids_json: string;
		};
		assert.equal(chunk.start_offset, 0);
		assert.equal(chunk.byte_count, 3);
		assert.deepEqual([...chunk.bytes], [0x10, 0x11, 0x20]);
		assert.deepEqual(JSON.parse(chunk.timestamps_json), [100, 100, 120]);
		assert.deepEqual(JSON.parse(chunk.directions_json), ["rx", "rx", "tx"]);
		assert.deepEqual(JSON.parse(chunk.session_ids_json), ["append-session", "append-session", "append-session"]);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM materialized_frames").get() as { count: number }).count, 0);
		assert.throws(
			() => service.appendChunk({ ...request, bytes: [0xff], segments: undefined }),
			(error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "IDEMPOTENCY_CONFLICT"
		);
		assert.throws(
			() => service.appendChunk({ ...request, sequence: 1, expectedStartOffset: 3 }),
			(error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "IDEMPOTENCY_CONFLICT"
		);
		const retainedAppend = service.appendChunk({
			captureId: "append-capture",
			sessionId: "append-session",
			requestId: "request-2",
			sequence: 1,
			expectedStartOffset: 3,
			bytes: new Uint8Array(50_000)
		});
		assert.equal(retainedAppend.dataRevision, 2);
		assert.equal(service.getCaptureState("append-capture").retainedStartOffset, 3);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM raw_chunks WHERE capture_id = 'append-capture'").get() as { count: number }).count, 2);
		assert.throws(
			() => service.appendChunk({ ...request, segments: [{ timestamp: 100, direction: "invalid", bytes: [1] }] }),
			(error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "VALIDATION_ERROR"
		);
		assert.throws(
			() => service.appendChunk({ ...request, requestId: "request-2", sequence: 3 }),
			(error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "IDEMPOTENCY_CONFLICT"
		);
		assert.throws(
			() => service.appendChunk({
				captureId: "append-capture",
				sessionId: "append-session",
				requestId: "request-3",
				sequence: 4,
				expectedStartOffset: 4,
				bytes: [1]
			}),
			(error: unknown) => {
				if (!(error instanceof Error) || !("details" in error)) return false;
				const details = (error as { details: Record<string, unknown> }).details;
				return details.expectedSequence === 2 && details.actualSequence === 4 && details.expectedStartOffset === 50_003 && details.actualStartOffset === 4;
			}
		);
		assert.equal(service.getCaptureState("append-capture").dataRevision, 2);
	} finally {
		database.close();
	}
});

test("finalization verifies continuous acknowledged chunks, stops before materialization, and retries atomically", () => {
	const database = openDatabase(":memory:");
	installCommandSchema(database);
	try {
		let nextId = 0;
		const service = new CanonicalCaptureCommandService(database, {
			nowIso: () => "2026-08-09T00:00:00.000Z",
			generateId: () => `finalize-id-${nextId++}`
		});
		service.createCapture({ captureId: "finalize-capture", framing, inputFormat: "binary" });
		service.startSession({ captureId: "finalize-capture", sessionId: "finalize-session" });
		service.appendChunk({
			captureId: "finalize-capture",
			sessionId: "finalize-session",
			requestId: "finalize-request",
			sequence: 0,
			expectedStartOffset: 0,
			segments: [{ timestamp: 10, direction: "rx", bytes: [1, 2, 3, 4] }]
		});
		database.prepare("INSERT INTO raw_byte_visibility (capture_id, raw_offset, hidden) VALUES ('finalize-capture', 1, 1)").run();
		const finalized = service.finalizeSession({ captureId: "finalize-capture", sessionId: "finalize-session", expectedDataRevision: 1 });
		assert.equal(finalized.job.status, "completed");
		assert.equal(finalized.job.sourceDataRevision, 1);
		assert.equal(finalized.session.status, "finalized");
		assert.equal(service.getCaptureState("finalize-capture").lifecycle, "finalized");
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM framing_profiles WHERE capture_id = 'finalize-capture'").get() as { count: number }).count, 1);
		assert.deepEqual(
			database.prepare("SELECT bytes_json FROM materialized_frames WHERE capture_id = 'finalize-capture' ORDER BY ordinal").all(),
			[{ bytes_json: "[1,3]" }, { bytes_json: "[4]" }]
		);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM raw_chunks WHERE capture_id = 'finalize-capture'").get() as { count: number }).count, 1);
		const retry = service.finalizeSession({ captureId: "finalize-capture", sessionId: "finalize-session" });
		assert.equal(retry.idempotent, true);
		assert.equal(retry.job.id, finalized.job.id);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM finalization_jobs WHERE capture_id = 'finalize-capture'").get() as { count: number }).count, 1);

		service.createCapture({ captureId: "incomplete-capture", framing, inputFormat: "binary" });
		service.startSession({ captureId: "incomplete-capture", sessionId: "incomplete-session" });
		service.appendChunk({
			captureId: "incomplete-capture",
			sessionId: "incomplete-session",
			requestId: "incomplete-request",
			sequence: 0,
			expectedStartOffset: 0,
			bytes: [9, 8]
		});
		database.prepare("DELETE FROM raw_chunks WHERE capture_id = 'incomplete-capture'").run();
		assert.throws(
			() => service.finalizeSession({ captureId: "incomplete-capture", sessionId: "incomplete-session" }),
			(error: unknown) => error instanceof Error && error.message.includes("no complete raw chunk span")
		);
		assert.equal(service.getCaptureState("incomplete-capture").lifecycle, "recording");
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM finalization_jobs WHERE capture_id = 'incomplete-capture'").get() as { count: number }).count, 0);

		service.createCapture({ captureId: "retry-capture", framing, inputFormat: "binary" });
		service.startSession({ captureId: "retry-capture", sessionId: "retry-session" });
		service.appendChunk({
			captureId: "retry-capture",
			sessionId: "retry-session",
			requestId: "retry-request",
			sequence: 0,
			expectedStartOffset: 0,
			bytes: [5, 6]
		});
		database.exec(`
			CREATE TRIGGER corrupt_retry_materialization
			AFTER INSERT ON materialized_frames
			BEGIN
				UPDATE materialized_frames SET signature = 'corrupted' WHERE id = NEW.id;
			END
		`);
		let failedJobId: string | undefined;
		assert.throws(() => service.finalizeSession({ captureId: "retry-capture", sessionId: "retry-session" }));
		const failedState = service.getCaptureState("retry-capture");
		assert.equal(failedState.lifecycle, "stopped");
		assert.equal(failedState.sessions[0]?.status, "failed");
		assert.equal(failedState.activeProfile, null);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM framing_profiles WHERE capture_id = 'retry-capture'").get() as { count: number }).count, 0);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM raw_chunks WHERE capture_id = 'retry-capture'").get() as { count: number }).count, 1);
		failedJobId = (database.prepare("SELECT id FROM finalization_jobs WHERE capture_id = 'retry-capture'").get() as { id: string }).id;
		assert.equal((database.prepare("SELECT status FROM finalization_jobs WHERE id = @id").get({ id: failedJobId }) as { status: string }).status, "failed");
		database.exec("DROP TRIGGER corrupt_retry_materialization");
		const retried = service.finalizeSession({ captureId: "retry-capture", sessionId: "retry-session" });
		assert.equal(retried.job.status, "completed");
		assert.equal(retried.job.id, failedJobId);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM finalization_jobs WHERE capture_id = 'retry-capture'").get() as { count: number }).count, 1);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM framing_profiles WHERE capture_id = 'retry-capture'").get() as { count: number }).count, 1);
	} finally {
		database.close();
	}
});

test("commands reject incidental canonical rows when storage authority is failed", () => {
	const database = openDatabase(":memory:");
	installCommandSchema(database);
	try {
		const service = new CanonicalCaptureCommandService(database);
		service.createCapture({ captureId: "failed-authority", framing, inputFormat: "binary" });
		database.prepare("UPDATE capture_storage SET status = 'canonicalization-failed', last_error = 'legacy source retained' WHERE capture_id = 'failed-authority'").run();
		for (const command of [
			() => service.patchMetadata({ captureId: "failed-authority", patch: { name: "blocked" } }),
			() => service.startSession({ captureId: "failed-authority" }),
			() => service.appendChunk({ captureId: "failed-authority", sessionId: "missing", requestId: "request", sequence: 0, expectedStartOffset: 0, bytes: [1] })
		]) {
			assert.throws(command, (error: unknown) => error instanceof Error && "details" in error && (error as { details: { status?: string } }).details.status === "canonicalization-failed");
		}
		assert.equal(service.getCaptureState("failed-authority").storage.status, "canonicalization-failed");
	} finally {
		database.close();
	}
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createArchiveHttpService, type ArchiveHttpService } from "../server/http-service.ts";

type JsonRecord = Record<string, unknown>;
type RequestOptions = { method?: string; body?: unknown };
type HttpResult<T = unknown> = { status: number; body: T };

function legacyCapture(id: string, overrides: JsonRecord = {}): JsonRecord {
	return {
		id,
		name: "Legacy capture",
		description: "kept as JSON until explicitly upgraded",
		view: "raw",
		baudRate: 115200,
		inputFormat: "binary",
		params: [{ key: "mode", value: "legacy" }],
		byteStream: [
			{ rawOffset: 0, value: 0x10, timestamp: 100, direction: "rx" },
			{ rawOffset: 1, value: 0x20, timestamp: 110, direction: "rx" }
		],
		frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 2 }],
		messages: [{ id: "message-1", timestamp: 100, byteTimestamps: [100, 110], bytes: [0x10, 0x20], rawOffsets: [0, 1] }],
		notes: [{ id: "note-1", type: "capture", text: "keep me", createdAt: 100 }],
		annotations: { "message-1": { text: "annotation" } },
		patternRemarks: { "10 20": { text: "sequence" } },
		...overrides
	};
}

async function withService(run: (request: <T = unknown>(path: string, options?: RequestOptions) => Promise<HttpResult<T>>, service: ArchiveHttpService) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-pr45c-"));
	const service = createArchiveHttpService({ databasePath: join(directory, "archive.sqlite") });
	try {
		await new Promise<void>((resolve, reject) => {
			service.server.once("error", reject);
			service.server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
		});
		const address = service.server.address() as AddressInfo;
		const request = async <T = unknown>(path: string, options: RequestOptions = {}): Promise<HttpResult<T>> => {
			const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
				method: options.method || "GET",
				headers: options.body === undefined ? {} : { "content-type": "application/json" },
				body: options.body === undefined ? undefined : JSON.stringify(options.body)
			});
			const text = await response.text();
			return { status: response.status, body: text ? JSON.parse(text) as T : undefined as T };
		};
		await run(request, service);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function bodyRecord(value: unknown): JsonRecord {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value as JsonRecord;
}

test("canonicalization exposes preflight, recovery JSON, verification, and one idempotent job", async () => {
	await withService(async request => {
		const seeded = await request("/api/captures/legacy-1", { method: "PUT", body: legacyCapture("legacy-1") });
		assert.equal(seeded.status, 200);

		const preflight = await request<JsonRecord>("/api/captures/legacy-1/canonicalization");
		assert.equal(preflight.status, 200);
		assert.equal(bodyRecord(preflight.body).status, "legacy-not-canonicalized");
		assert.equal(bodyRecord(preflight.body).eligible, true);
		assert.equal(bodyRecord(preflight.body).captureSize, 2);
		assert.equal(bodyRecord(preflight.body).messageCount, 1);
		assert.equal(bodyRecord(preflight.body).noteCount, 3);

		const original = await request<JsonRecord>("/api/captures/legacy-1/legacy-backup");
		assert.equal(original.status, 200);
		assert.equal(bodyRecord(original.body).source, "legacy-document");

		const started = await request<JsonRecord>("/api/captures/legacy-1/canonicalization", { method: "POST", body: {} });
		assert.equal(started.status, 200);
		const job = bodyRecord(started.body);
		assert.equal(job.status, "completed");
		assert.equal(job.verified, true);
		assert.equal(bodyRecord(job.verification).rawBytesMatched, true);

		const jobRead = await request<JsonRecord>(`/api/captures/legacy-1/canonicalization/jobs/${job.id}`);
		assert.equal(jobRead.status, 200);
		assert.equal(bodyRecord(jobRead.body).status, "completed");
		const completedPreflight = await request<JsonRecord>("/api/captures/legacy-1/canonicalization");
		assert.equal(bodyRecord(completedPreflight.body).status, "canonical");
		assert.equal(bodyRecord(completedPreflight.body).activeJobId, job.id);

		const recovery = await request<JsonRecord>("/api/captures/legacy-1/legacy-backup");
		assert.equal(bodyRecord(recovery.body).source, "recovery-backup");
		assert.equal(bodyRecord(recovery.body).verified, true);
		assert.equal((await request("/api/captures/legacy-1")).status, 200);
		assert.equal((await request("/api/captures/legacy-1", { method: "PUT", body: legacyCapture("legacy-1", { name: "must use commands" }) })).status, 409);

		const repeated = await request<JsonRecord>("/api/captures/legacy-1/canonicalization", { method: "POST", body: {} });
		assert.equal(repeated.status, 200);
		assert.equal(bodyRecord(repeated.body).id, job.id);
	});
});

test("canonicalization completes for legacy captures that share a section id", async () => {
	await withService(async request => {
		for (const captureId of ["legacy-shared-section-a", "legacy-shared-section-b"]) {
			const seeded = await request(`/api/captures/${captureId}`, {
				method: "PUT",
				body: legacyCapture(captureId)
			});
			assert.equal(seeded.status, 200);
		}

		for (const captureId of ["legacy-shared-section-a", "legacy-shared-section-b"]) {
			const converted = await request<JsonRecord>(`/api/captures/${captureId}/canonicalization`, {
				method: "POST",
				body: {}
			});
			assert.equal(converted.status, 200);
			assert.equal(bodyRecord(converted.body).status, "completed");
			assert.equal(bodyRecord(converted.body).verified, true);
		}
	});
});

test("recording captures cannot be converted and failed conversion keeps the legacy source for retry", async () => {
	await withService(async (request, service) => {
		await request("/api/captures/recording", { method: "PUT", body: legacyCapture("recording", { lifecycle: "recording" }) });
		const recordingPreflight = await request<JsonRecord>("/api/captures/recording/canonicalization");
		assert.equal(bodyRecord(recordingPreflight.body).recordingActive, true);
		assert.equal(bodyRecord(recordingPreflight.body).eligible, false);
		const recordingStart = await request<JsonRecord>("/api/captures/recording/canonicalization", { method: "POST", body: {} });
		assert.equal(recordingStart.status, 409);
		assert.equal(bodyRecord(recordingStart.body).code, "canonicalization-recording-active");

		await request("/api/captures/retry", { method: "PUT", body: legacyCapture("retry", { params: [{}] }) });
		const failed = await request<JsonRecord>("/api/captures/retry/canonicalization", { method: "POST", body: {} });
		assert.equal(failed.status, 200);
		assert.equal(bodyRecord(failed.body).status, "failed");
		assert.equal(bodyRecord(failed.body).verified, false);
		assert.equal((await request("/api/captures/retry")).status, 200);
		assert.equal(bodyRecord((await request<JsonRecord>("/api/captures/retry/canonicalization")).body).status, "failed");
		assert.equal((service.database.prepare("SELECT COUNT(*) AS count FROM captures WHERE id = 'retry'").get() as { count: number }).count, 0);
		assert.equal((service.database.prepare("SELECT COUNT(*) AS count FROM capture_documents WHERE id = 'retry'").get() as { count: number }).count, 1);
		for (const table of ["raw_chunks", "capture_sessions", "framing_profiles", "stable_notes", "capture_backups"]) {
			assert.equal((service.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE capture_id = 'retry'`).get() as { count: number }).count, 0, table);
		}
		assert.equal((service.database.prepare("SELECT COUNT(*) AS count FROM finalization_jobs WHERE capture_id = 'retry'").get() as { count: number }).count, 1);

		await request("/api/captures/retry", { method: "PUT", body: legacyCapture("retry", { params: [{ key: "fixed", value: "yes" }] }) });
		const retried = await request<JsonRecord>("/api/captures/retry/canonicalization", { method: "POST", body: {} });
		assert.equal(bodyRecord(retried.body).status, "completed");
		assert.equal((service.database.prepare("SELECT COUNT(*) AS count FROM capture_backups WHERE capture_id = 'retry'").get() as { count: number }).count, 1);
	});
});

test("bulk canonicalization reuses the per-capture operation and skips recording/canonical captures", async () => {
	await withService(async request => {
		await request("/api/captures/eligible", { method: "PUT", body: legacyCapture("eligible") });
		await request("/api/captures/recording-bulk", { method: "PUT", body: legacyCapture("recording-bulk", { lifecycle: "recording" }) });
		await request("/api/captures", { method: "POST", body: {
			captureId: "canonical-bulk",
			inputFormat: "binary",
			framing: [{ start: 0, framingMode: "length", frameSize: 1 }]
		} });

		const response = await request<JsonRecord>("/api/migrations/canonical", { method: "POST", body: {} });
		assert.equal(response.status, 200);
		const results = bodyRecord(response.body).results as Array<JsonRecord>;
		assert.equal(results.find(result => result.captureId === "eligible")?.status, "completed");
		assert.deepEqual(results.find(result => result.captureId === "recording-bulk"), {
			captureId: "recording-bulk",
			status: "skipped",
			reason: "recording-active",
			verified: true
		});
		assert.deepEqual(results.find(result => result.captureId === "canonical-bulk"), {
			captureId: "canonical-bulk",
			status: "skipped",
			reason: "already-canonical",
			verified: true
		});
	});
});

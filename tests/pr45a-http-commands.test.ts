import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createArchiveHttpService, type ArchiveHttpService } from "../server/http-service.ts";

type JsonRecord = Record<string, unknown>;

type RequestOptions = {
	method?: string;
	body?: unknown;
};

type HttpResult<T = unknown> = {
	status: number;
	body: T;
};

type HttpRequest = <T = unknown>(path: string, options?: RequestOptions) => Promise<HttpResult<T>>;

type HttpFixture = {
	service: ArchiveHttpService;
	request: HttpRequest;
};

const CAPTURE_ID = "http-command-capture";
const FRAME_SIZE = 2;

function framingSections(frameSize = FRAME_SIZE): JsonRecord[] {
	return [
		{
			id: "section-1",
			start: 0,
			framingMode: "length",
			frameSize,
			frameMarker: "",
			markerPosition: "start",
			frameTimeGap: 5,
			collapseRuns: false,
			collapsed: false
		}
	];
}

function createCaptureBody(id: string, name = "HTTP command capture"): JsonRecord {
	return {
		id,
		name,
		description: "capture created through the canonical command API",
		view: "raw",
		folderId: null,
		baudRate: 115200,
		inputFormat: "binary",
		parameters: [
			{ key: "mode", value: "raw" },
			{ key: "channel", value: "A" }
		],
		framing: {
			algorithmVersion: 1,
			sections: framingSections()
		}
	};
}

function isRecord(value: unknown): value is JsonRecord {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function record(value: unknown, label = "response"): JsonRecord {
	assert.ok(isRecord(value), `${label} must be an object`);
	return value;
}

function array(value: unknown, label: string): unknown[] {
	assert.ok(Array.isArray(value), `${label} must be an array`);
	return value;
}

function status(result: HttpResult, expected: number): void {
	assert.equal(result.status, expected, JSON.stringify(result.body));
}

function stateBody(result: HttpResult): JsonRecord {
	const body = record(result.body);
	if (isRecord(body.state)) return body.state;
	if (isRecord(body.capture)) return body.capture;
	return body;
}

function documentBody(result: HttpResult): JsonRecord {
	const body = record(result.body);
	return isRecord(body.document) ? body.document : body;
}

function idFrom(body: JsonRecord): string {
	const id = body.captureId ?? body.id;
	assert.equal(typeof id, "string");
	return id as string;
}

function conflict(result: HttpResult, code: string, expected: JsonRecord = {}): void {
	status(result, 409);
	const body = record(result.body);
	assert.equal(body.code, code);
	const details = isRecord(body.details) ? body.details : body;
	for (const [key, expectedValue] of Object.entries(expected)) {
		const actualValue = details[key] ?? body[key];
		assert.deepEqual(actualValue, expectedValue, `conflict field ${key}`);
	}
}

async function listen(service: ArchiveHttpService): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			service.server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			service.server.off("error", onError);
			resolve();
		};
		service.server.once("error", onError);
		service.server.once("listening", onListening);
		service.server.listen({ host: "127.0.0.1", port: 0 });
	});
	const address = service.server.address() as AddressInfo | null;
	assert.ok(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}`;
}

async function withHttpService(run: (fixture: HttpFixture) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-http-command-"));
	const service = createArchiveHttpService({ databasePath: join(directory, "archive.sqlite") });
	try {
		const baseUrl = await listen(service);
		const request: HttpRequest = async <T = unknown>(path: string, options: RequestOptions = {}): Promise<HttpResult<T>> => {
			const headers: Record<string, string> = { connection: "close" };
			let body: string | undefined;
			if (options.body !== undefined) {
				headers["content-type"] = "application/json";
				body = JSON.stringify(options.body);
			}
			const response = await fetch(`${baseUrl}${path}`, {
				method: options.method ?? "GET",
				headers,
				body
			});
			const text = await response.text();
			let parsed: unknown;
			if (text) {
				try {
					parsed = JSON.parse(text);
				} catch {
					parsed = text;
				}
			}
			return { status: response.status, body: parsed as T };
		};
		await run({ service, request });
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
}

async function createCanonical(request: HttpRequest, id = CAPTURE_ID, name = "HTTP command capture"): Promise<void> {
	const result = await request("/api/captures", { method: "POST", body: createCaptureBody(id, name) });
	status(result, 201);
}

async function startSession(request: HttpRequest, captureId: string, sessionId: string): Promise<JsonRecord> {
	const result = await request(`/api/captures/${encodeURIComponent(captureId)}/sessions`, {
		method: "POST",
		body: { sessionId }
	});
	status(result, 200);
	const body = record(result.body);
	assert.equal(body.sessionId, sessionId);
	return body;
}

type ChunkSpec = {
	requestId: string;
	sequence: number;
	expectedStartOffset: number;
	timestamp: number;
	direction: "rx" | "tx";
	bytes: number[];
};

function chunkBody(sessionId: string, chunk: ChunkSpec): JsonRecord {
	return {
		requestId: chunk.requestId,
		sessionId,
		sequence: chunk.sequence,
		expectedStartOffset: chunk.expectedStartOffset,
		segments: [{ timestamp: chunk.timestamp, direction: chunk.direction, bytes: chunk.bytes }]
	};
}

async function appendChunk(request: HttpRequest, captureId: string, sessionId: string, chunk: ChunkSpec): Promise<HttpResult> {
	return request(`/api/captures/${encodeURIComponent(captureId)}/raw-chunks`, {
		method: "POST",
		body: chunkBody(sessionId, chunk)
	});
}

async function appendThreeChunks(request: HttpRequest, captureId: string, sessionId: string, startOffset = 0): Promise<JsonRecord[]> {
	const chunks: ChunkSpec[] = [
		{
			requestId: "chunk-0",
			sequence: 0,
			expectedStartOffset: startOffset,
			timestamp: 100,
			direction: "rx",
			bytes: [0x10, 0x11]
		},
		{
			requestId: "chunk-1",
			sequence: 1,
			expectedStartOffset: startOffset + 2,
			timestamp: 110,
			direction: "tx",
			bytes: [0x20]
		},
		{
			requestId: "chunk-2",
			sequence: 2,
			expectedStartOffset: startOffset + 3,
			timestamp: 120,
			direction: "rx",
			bytes: [0x30, 0x31]
		}
	];
	const acknowledgements: JsonRecord[] = [];
	for (const [index, chunk] of chunks.entries()) {
		const result = await appendChunk(request, captureId, sessionId, chunk);
		status(result, 200);
		const body = record(result.body);
		assert.equal(body.acceptedStartOffset, chunk.expectedStartOffset);
		assert.equal(body.acceptedEndOffset, chunk.expectedStartOffset + chunk.bytes.length);
		assert.equal(body.nextRawOffset, chunk.expectedStartOffset + chunk.bytes.length);
		assert.equal(body.nextSequence, index + 1);
		assert.equal(body.dataRevision, index + 1);
		acknowledgements.push(body);
	}
	return acknowledgements;
}

test("HTTP canonical creation is idempotent, explicit, and document-free", async () => {
	await withHttpService(async ({ request, service }) => {
		const body = createCaptureBody(CAPTURE_ID);
		const first = await request("/api/captures", { method: "POST", body });
		status(first, 201);
		const state = stateBody(first);
		assert.equal(idFrom(state), CAPTURE_ID);
		const storage = record(state.storage);
		assert.equal(storage.status, "canonical");
		assert.ok(["stopped", "finalized"].includes(String(state.lifecycle)));
		assert.equal(state.dataRevision, 0);
		assert.equal(state.metadataRevision, 0);
		assert.equal(state.contentRevision, 0);
		assert.deepEqual(state.parameters, body.parameters);
		const framing = state.draft ?? state.framing;
		assert.ok(isRecord(framing), "creation response must include active framing configuration");
		assert.deepEqual(framing.sections, (body.framing as JsonRecord).sections);

		const retry = await request("/api/captures", { method: "POST", body });
		status(retry, 200);
		assert.deepEqual(retry.body, first.body);

		const conflictingCreate = await request("/api/captures", {
			method: "POST",
			body: { ...body, name: "a different capture" }
		});
		conflict(conflictingCreate, "IDEMPOTENCY_CONFLICT", { captureId: CAPTURE_ID });

		const documents = service.database
			.prepare("SELECT COUNT(*) AS count FROM capture_documents WHERE id = @id")
			.get({ id: CAPTURE_ID }) as { count: number };
		const backups = service.database
			.prepare("SELECT COUNT(*) AS count FROM capture_backups WHERE capture_id = @id")
			.get({ id: CAPTURE_ID }) as { count: number };
		assert.equal(documents.count, 0);
		assert.equal(backups.count, 0);
	});
});

test("HTTP metadata patches use optimistic metadata revisions without touching data revision", async () => {
	await withHttpService(async ({ request }) => {
		await createCanonical(request, "metadata-capture");
		const firstPatch = await request("/api/captures/metadata-capture/metadata", {
			method: "PATCH",
			body: {
				expectedMetadataRevision: 0,
				patch: {
					name: "Metadata changed",
					description: "new description",
					view: "controller",
					folderId: "folder-a",
					baudRate: 9600,
					parameters: [
						{ key: "second", value: "2" },
						{ key: "first", value: "changed" }
					]
				}
			}
		});
		status(firstPatch, 200);
		const updated = stateBody(firstPatch);
		assert.equal(updated.name, "Metadata changed");
		assert.equal(updated.metadataRevision, 1);
		assert.equal(updated.dataRevision, 0);
		assert.equal(updated.contentRevision, 0);
		assert.deepEqual(updated.parameters, [
			{ key: "second", value: "2" },
			{ key: "first", value: "changed" }
		]);

		const started = await startSession(request, "metadata-capture", "metadata-session");
		assert.equal(started.dataRevision, 0);
		const appended = await appendChunk(request, "metadata-capture", "metadata-session", {
			requestId: "metadata-data-0",
			sequence: 0,
			expectedStartOffset: 0,
			timestamp: 200,
			direction: "rx",
			bytes: [0xaa]
		});
		status(appended, 200);
		assert.equal(record(appended.body).dataRevision, 1);

		const secondPatch = await request("/api/captures/metadata-capture/metadata", {
			method: "PATCH",
			body: { expectedMetadataRevision: 1, patch: { name: "Metadata changed twice" } }
		});
		status(secondPatch, 200);
		const secondState = stateBody(secondPatch);
		assert.equal(secondState.metadataRevision, 2);
		assert.equal(secondState.dataRevision, 1);

		const stale = await request("/api/captures/metadata-capture/metadata", {
			method: "PATCH",
			body: { expectedMetadataRevision: 0, patch: { name: "must not win" } }
		});
		conflict(stale, "CONFLICT", { expectedMetadataRevision: 0, actualMetadataRevision: 2 });
		const read = await request("/api/captures/metadata-capture");
		status(read, 200);
		assert.equal(documentBody(read).name, "Metadata changed twice");
	});
});

test("HTTP recording appends preserve absolute offsets and reject unsafe retries", async () => {
	await withHttpService(async ({ request, service }) => {
		await createCanonical(request, "append-capture");
		const started = await startSession(request, "append-capture", "append-session");
		assert.equal(started.nextChunkSequence, 0);
		assert.equal(started.nextRawOffset, 0);
		assert.equal(started.dataRevision, 0);

		const acknowledgements = await appendThreeChunks(request, "append-capture", "append-session");
		assert.deepEqual(acknowledgements.map(item => item.acceptedStartOffset), [0, 2, 3]);
		assert.deepEqual(acknowledgements.map(item => item.nextRawOffset), [2, 3, 5]);

		const identicalRetry = await appendChunk(request, "append-capture", "append-session", {
			requestId: "chunk-1",
			sequence: 1,
			expectedStartOffset: 2,
			timestamp: 110,
			direction: "tx",
			bytes: [0x20]
		});
		status(identicalRetry, 200);
		assert.deepEqual(identicalRetry.body, acknowledgements[1]);

		const requestIdConflict = await appendChunk(request, "append-capture", "append-session", {
			requestId: "chunk-1",
			sequence: 1,
			expectedStartOffset: 2,
			timestamp: 110,
			direction: "tx",
			bytes: [0x21]
		});
		conflict(requestIdConflict, "IDEMPOTENCY_CONFLICT", { requestId: "chunk-1" });

		const sequenceConflict = await appendChunk(request, "append-capture", "append-session", {
			requestId: "bad-sequence",
			sequence: 1,
			expectedStartOffset: 5,
			timestamp: 130,
			direction: "rx",
			bytes: [0x40]
		});
		conflict(sequenceConflict, "CONFLICT", { expectedSequence: 3, expectedStartOffset: 5 });

		const offsetConflict = await appendChunk(request, "append-capture", "append-session", {
			requestId: "bad-offset",
			sequence: 3,
			expectedStartOffset: 4,
			timestamp: 131,
			direction: "rx",
			bytes: [0x41]
		});
		conflict(offsetConflict, "CONFLICT", { expectedSequence: 3, expectedStartOffset: 5 });

		const acceptedAfterConflicts = await appendChunk(request, "append-capture", "append-session", {
			requestId: "chunk-3",
			sequence: 3,
			expectedStartOffset: 5,
			timestamp: 140,
			direction: "rx",
			bytes: [0x40]
		});
		status(acceptedAfterConflicts, 200);
		assert.equal(record(acceptedAfterConflicts.body).nextRawOffset, 6);
		assert.equal(record(acceptedAfterConflicts.body).dataRevision, 4);

		const chunks = service.database
			.prepare("SELECT chunk_index, start_offset, byte_count FROM raw_chunks WHERE capture_id = @id ORDER BY chunk_index")
			.all({ id: "append-capture" }) as Array<{ chunk_index: number; start_offset: number; byte_count: number }>;
		assert.deepEqual(chunks, [
			{ chunk_index: 0, start_offset: 0, byte_count: 2 },
			{ chunk_index: 1, start_offset: 2, byte_count: 1 },
			{ chunk_index: 2, start_offset: 3, byte_count: 2 },
			{ chunk_index: 3, start_offset: 5, byte_count: 1 }
		]);
		const profiles = service.database
			.prepare("SELECT COUNT(*) AS count FROM framing_profiles WHERE capture_id = @id")
			.get({ id: "append-capture" }) as { count: number };
		assert.equal(profiles.count, 0, "append must not frame or analyze partial data");
	});
});

test("HTTP finalization synthesizes canonical reads and creates a new profile per session", async () => {
	await withHttpService(async ({ request }) => {
		await createCanonical(request, "finalize-capture");
		await startSession(request, "finalize-capture", "session-1");
		await appendThreeChunks(request, "finalize-capture", "session-1");

		const firstFinalize = await request("/api/captures/finalize-capture/sessions/session-1/finalize", {
			method: "POST",
			body: {}
		});
		status(firstFinalize, 200);
		const firstFinalization = record(firstFinalize.body);
		assert.equal(firstFinalization.dataRevision, 3);
		assert.equal(firstFinalization.retainedStartOffset, 0);
		assert.equal(record(firstFinalization.job).status, "completed");
		assert.equal(record(firstFinalization.job).verified, true);
		assert.equal(typeof firstFinalization.profileId, "string");
		assert.equal(record(firstFinalization.session).status, "finalized");

		const firstRead = await request("/api/captures/finalize-capture");
		status(firstRead, 200);
		const firstDocument = documentBody(firstRead);
		assert.equal(firstDocument.name, "HTTP command capture");
		assert.deepEqual(
			array(firstDocument.byteStream, "canonical byteStream").map(item => record(item).value),
			[0x10, 0x11, 0x20, 0x30, 0x31]
		);

		const overview = await request("/api/canonical/captures/finalize-capture/overview");
		status(overview, 200);
		const overviewBody = record(overview.body);
		assert.equal(overviewBody.status, "canonical");
		assert.equal(overviewBody.rawByteCount, 5);
		assert.ok(Number(overviewBody.frameCount) > 0);

		const profilesAfterFirst = await request("/api/captures/finalize-capture/profiles");
		status(profilesAfterFirst, 200);
		const firstProfiles = array(profilesAfterFirst.body, "first framing profiles");
		assert.equal(firstProfiles.length, 1);

		const secondStart = await startSession(request, "finalize-capture", "session-2");
		assert.equal(secondStart.nextChunkSequence, 0);
		assert.equal(secondStart.nextRawOffset, 5);
		assert.equal(secondStart.dataRevision, 3);
		const secondAppend = await appendChunk(request, "finalize-capture", "session-2", {
			requestId: "session-2-chunk-0",
			sequence: 0,
			expectedStartOffset: 5,
			timestamp: 200,
			direction: "rx",
			bytes: [0x40, 0x41]
		});
		status(secondAppend, 200);
		assert.equal(record(secondAppend.body).dataRevision, 4);

		const secondFinalize = await request("/api/captures/finalize-capture/sessions/session-2/finalize", {
			method: "POST",
			body: {}
		});
		status(secondFinalize, 200);
		const secondFinalization = record(secondFinalize.body);
		assert.equal(secondFinalization.dataRevision, 4);
		assert.equal(record(secondFinalization.job).status, "completed");
		assert.equal(record(secondFinalization.job).verified, true);
		assert.notEqual(secondFinalization.profileId, firstFinalization.profileId);

		const profilesAfterSecond = await request("/api/captures/finalize-capture/profiles");
		status(profilesAfterSecond, 200);
		const secondProfiles = array(profilesAfterSecond.body, "second framing profiles").map(item => record(item));
		assert.equal(secondProfiles.length, 2);
		assert.deepEqual(secondProfiles.map(profile => profile.version), [1, 2]);
		assert.equal(secondProfiles.filter(profile => Boolean(profile.isActive)).length, 1);

		const secondRead = await request("/api/captures/finalize-capture");
		status(secondRead, 200);
		assert.deepEqual(
			array(documentBody(secondRead).byteStream, "second canonical byteStream").map(item => record(item).value),
			[0x10, 0x11, 0x20, 0x30, 0x31, 0x40, 0x41]
		);

		const jobs = await request("/api/captures/finalize-capture/finalization");
		status(jobs, 200);
		const finalizationJobs = array(jobs.body, "finalization jobs").map(item => record(item));
		assert.equal(finalizationJobs.length, 2);
		assert.ok(finalizationJobs.every(job => job.status === "completed" && job.verified === 1 || job.verified === true));
	});
});

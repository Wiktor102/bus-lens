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

async function finalizeSession(request: HttpRequest, captureId: string, sessionId: string): Promise<JsonRecord> {
	const result = await request(`/api/captures/${encodeURIComponent(captureId)}/sessions/${encodeURIComponent(sessionId)}/finalize`, {
		method: "POST",
		body: {}
	});
	status(result, 200);
	return record(result.body);
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

test("HTTP framing drafts accept a pending marker section while recording", async () => {
	await withHttpService(async ({ request }) => {
		await createCanonical(request, "pending-marker-capture");
		await startSession(request, "pending-marker-capture", "pending-marker-session");
		const appended = await appendChunk(request, "pending-marker-capture", "pending-marker-session", {
			requestId: "pending-marker-data-0",
			sequence: 0,
			expectedStartOffset: 0,
			timestamp: 100,
			direction: "rx",
			bytes: [0xaa, 0x01, 0x02]
		});
		status(appended, 200);

		const pendingDraft = await request("/api/captures/pending-marker-capture/framing-draft", {
			method: "PATCH",
			body: {
				expectedRevision: 0,
				sections: [{ start: 0, framingMode: "marker", frameMarker: "", markerPosition: "start" }]
			}
		});
		status(pendingDraft, 200);
		assert.equal(record(pendingDraft.body).revision, 1);

		const markerDraft = await request("/api/captures/pending-marker-capture/framing-draft", {
			method: "PATCH",
			body: {
				expectedRevision: 1,
				sections: [{ start: 0, framingMode: "marker", frameMarker: "AA", markerPosition: "end" }]
			}
		});
		status(markerDraft, 200);
		assert.equal(record(markerDraft.body).revision, 2);
	});
});

test("HTTP framing drafts stay draft-only while recording and stale reframes are rejected", async () => {
	await withHttpService(async ({ request, service }) => {
		await createCanonical(request, "framing-capture");
		await startSession(request, "framing-capture", "framing-session");
		const draft = await request("/api/captures/framing-capture/framing-draft", {
			method: "PATCH",
			body: { expectedRevision: 0, sections: framingSections(3) }
		});
		status(draft, 200);
		const firstDraft = record(draft.body);
		assert.equal(firstDraft.revision, 1);
		assert.deepEqual(firstDraft.sections, framingSections(3));
		const profilesWhileRecording = service.database
			.prepare("SELECT COUNT(*) AS count FROM framing_profiles WHERE capture_id = @id")
			.get({ id: "framing-capture" }) as { count: number };
		assert.equal(profilesWhileRecording.count, 0);

		const newerDraft = await request("/api/captures/framing-capture/framing-draft", {
			method: "PATCH",
			body: { expectedRevision: 1, sections: framingSections(4) }
		});
		status(newerDraft, 200);
		assert.equal(record(newerDraft.body).revision, 2);

		await appendChunk(request, "framing-capture", "framing-session", {
			requestId: "framing-data-0",
			sequence: 0,
			expectedStartOffset: 0,
			timestamp: 300,
			direction: "rx",
			bytes: [0x01, 0x02, 0x03, 0x04]
		}).then(result => status(result, 200));
		const finalization = await finalizeSession(request, "framing-capture", "framing-session");
		const profileId = String(finalization.profileId);
		assert.equal(finalization.dataRevision, 1);

		const profiles = await request("/api/captures/framing-capture/profiles");
		status(profiles, 200);
		const materializedProfiles = array(profiles.body, "framing profiles").map(item => record(item));
		const initialProfile = materializedProfiles.find(profile => profile.id === profileId);
		assert.ok(initialProfile);
		if (initialProfile && initialProfile.sections !== undefined) {
			assert.equal(record(array(initialProfile.sections, "initial profile sections")[0]).frameSize, 4);
		}

		const reframed = await request("/api/captures/framing-capture/framing-revisions", {
			method: "POST",
			body: {
				expectedActiveProfileId: profileId,
				expectedDataRevision: 1,
				sections: framingSections(2),
				algorithmVersion: 1
			}
		});
		status(reframed, 200);
		const newProfile = record(reframed.body);
		assert.equal(typeof newProfile.profileId, "string");
		assert.notEqual(newProfile.profileId, profileId);
		assert.equal(newProfile.sourceDataRevision, 1);
		assert.equal(newProfile.verified, true);

		const staleReframe = await request("/api/captures/framing-capture/framing-revisions", {
			method: "POST",
			body: {
				expectedActiveProfileId: profileId,
				expectedDataRevision: 1,
				sections: framingSections(1),
				algorithmVersion: 1
			}
		});
		conflict(staleReframe, "CONFLICT", { expectedActiveProfileId: profileId, expectedDataRevision: 1 });

		const profilesAfterStale = await request("/api/captures/framing-capture/profiles");
		status(profilesAfterStale, 200);
		const finalProfiles = array(profilesAfterStale.body, "profiles after stale reframe").map(item => record(item));
		assert.equal(finalProfiles.length, 2);
		assert.equal(finalProfiles.filter(profile => Boolean(profile.isActive)).length, 1);
		assert.equal(finalProfiles.find(profile => Boolean(profile.isActive))?.id, newProfile.profileId);

		const activeDocument = await request("/api/captures/framing-capture");
		status(activeDocument, 200);
		const activeSections = array(documentBody(activeDocument).frameSections, "active framing sections");
		const sectionId = String(record(activeSections[0]).id);
		const sectionView = await request(`/api/captures/framing-capture/framing-sections/${encodeURIComponent(sectionId)}/view`, {
			method: "PATCH",
			body: { profileId: newProfile.profileId, collapsed: true }
		});
		status(sectionView, 200);
		assert.equal(record(sectionView.body).sectionId, sectionId);
		assert.equal(record(sectionView.body).collapsed, true);
		assert.equal(record(sectionView.body).profileId, newProfile.profileId);

		const afterView = await request("/api/captures/framing-capture");
		status(afterView, 200);
		assert.equal(record(array(documentBody(afterView).frameSections, "sections after view update")[0]).collapsed, true);
		const profilesAfterView = await request("/api/captures/framing-capture/profiles");
		status(profilesAfterView, 200);
		assert.equal(array(profilesAfterView.body, "profiles after view update").length, 2);
	});
});

test("HTTP note CRUD preserves stable range raw-span evidence", async () => {
	await withHttpService(async ({ request }) => {
		await createCanonical(request, "note-capture");
		await startSession(request, "note-capture", "note-session");
		await appendThreeChunks(request, "note-capture", "note-session");
		const finalization = await finalizeSession(request, "note-capture", "note-session");
		const profileId = String(finalization.profileId);
		const target = {
			kind: "range",
			profileId,
			startOrdinal: 0,
			endOrdinal: 1,
			startRawOffset: 0,
			endRawOffset: 3
		};

		const created = await request("/api/captures/note-capture/notes", {
			method: "POST",
			body: { text: "stable range", target }
		});
		status(created, 201);
		const createdBody = record(created.body);
		const note = record(createdBody.note ?? createdBody);
		assert.equal(typeof note.id, "string");
		assert.equal(createdBody.contentRevision, 1);
		const createdTarget = record(note.target);
		assert.equal(createdTarget.kind, "range");
		assert.equal(createdTarget.profileId, profileId);
		assert.equal(createdTarget.startRawOffset, 0);
		assert.equal(createdTarget.endRawOffset, 3);
		const noteId = String(note.id);

		const listed = await request("/api/captures/note-capture/notes");
		status(listed, 200);
		const listedNote = array(listed.body, "notes").map(item => record(item)).find(item => item.id === noteId);
		assert.ok(listedNote);
		assert.equal(record(listedNote?.target).startRawOffset, 0);
		assert.equal(record(listedNote?.target).endRawOffset, 3);

		const updated = await request(`/api/captures/note-capture/notes/${encodeURIComponent(noteId)}`, {
			method: "PATCH",
			body: { text: "updated stable range", target }
		});
		status(updated, 200);
		const updatedBody = record(updated.body);
		assert.equal(updatedBody.contentRevision, 2);
		assert.equal(record(record(updatedBody.note ?? updatedBody).target).endRawOffset, 3);

		const deleted = await request(`/api/captures/note-capture/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });
		status(deleted, 200);
		assert.equal(record(deleted.body).contentRevision, 3);
		const afterDelete = await request("/api/captures/note-capture/notes");
		status(afterDelete, 200);
		assert.deepEqual(afterDelete.body, []);
	});
});

test("HTTP byte and frame visibility use separate overrides and leave raw chunk BLOBs unchanged", async () => {
	await withHttpService(async ({ request, service }) => {
		await createCanonical(request, "visibility-capture");
		await startSession(request, "visibility-capture", "visibility-session");
		await appendThreeChunks(request, "visibility-capture", "visibility-session");
		const finalization = await finalizeSession(request, "visibility-capture", "visibility-session");
		const profileId = String(finalization.profileId);
		const frameWindow = await request("/api/canonical/captures/visibility-capture/frames?offset=0&limit=1");
		status(frameWindow, 200);
		const frames = array(record(frameWindow.body).frames, "frame window");
		assert.ok(frames.length > 0);
		const frameId = String(record(frames[0]).id);
		const rawBefore = service.database
			.prepare("SELECT bytes FROM raw_chunks WHERE capture_id = @id ORDER BY chunk_index LIMIT 1")
			.get({ id: "visibility-capture" }) as { bytes: Buffer };
		const bytesBefore = Buffer.from(rawBefore.bytes);

		const byteVisibility = await request("/api/captures/visibility-capture/bytes/1/visibility", {
			method: "PUT",
			body: { hidden: true }
		});
		status(byteVisibility, 200);
		assert.equal(record(byteVisibility.body).hidden, true);
		assert.equal(record(byteVisibility.body).contentRevision, 1);

		const frameVisibility = await request(`/api/captures/visibility-capture/frames/${encodeURIComponent(frameId)}/visibility`, {
			method: "PUT",
			body: { hidden: true }
		});
		status(frameVisibility, 200);
		const frameVisibilityBody = record(frameVisibility.body);
		assert.equal(frameVisibilityBody.hidden, true);
		assert.equal(frameVisibilityBody.profileId, profileId);
		assert.equal(frameVisibilityBody.contentRevision, 2);

		const deleteByteVisibility = await request("/api/captures/visibility-capture/bytes/1/visibility", { method: "DELETE" });
		status(deleteByteVisibility, 204);
		const deleteFrameVisibility = await request(`/api/captures/visibility-capture/frames/${encodeURIComponent(frameId)}/visibility`, {
			method: "DELETE"
		});
		status(deleteFrameVisibility, 204);

		const rawAfter = service.database
			.prepare("SELECT bytes FROM raw_chunks WHERE capture_id = @id ORDER BY chunk_index LIMIT 1")
			.get({ id: "visibility-capture" }) as { bytes: Buffer };
		assert.deepEqual(Buffer.from(rawAfter.bytes), bytesBefore);
	});
});

test("HTTP clear data preserves metadata and capture notes, while duplicate and delete stay command-scoped", async () => {
	await withHttpService(async ({ request, service }) => {
		await createCanonical(request, "ops-capture");
		await startSession(request, "ops-capture", "ops-session");
		await appendThreeChunks(request, "ops-capture", "ops-session");
		const finalization = await finalizeSession(request, "ops-capture", "ops-session");
		const profileId = String(finalization.profileId);
		const captureNote = await request("/api/captures/ops-capture/notes", {
			method: "POST",
			body: { text: "keep this capture note", target: { kind: "capture" } }
		});
		status(captureNote, 201);
		const rangeNote = await request("/api/captures/ops-capture/notes", {
			method: "POST",
			body: {
				text: "remove this range note",
				target: {
					kind: "range",
					profileId,
					startOrdinal: 0,
					endOrdinal: 1,
					startRawOffset: 0,
					endRawOffset: 3
				}
			}
		});
		status(rangeNote, 201);

		const clear = await request("/api/captures/ops-capture/data", { method: "DELETE" });
		status(clear, 200);
		const clearBody = record(clear.body);
		assert.equal(clearBody.captureId, "ops-capture");
		assert.equal(clearBody.clearedByteCount, 5);
		assert.ok(Number(clearBody.dataRevision) > 3);

		const afterClear = await request("/api/captures/ops-capture");
		status(afterClear, 200);
		const clearedDocument = documentBody(afterClear);
		assert.equal(clearedDocument.name, "HTTP command capture");
		assert.deepEqual(clearedDocument.byteStream, []);
		const clearedOverview = await request("/api/canonical/captures/ops-capture/overview");
		status(clearedOverview, 200);
		const clearedOverviewBody = record(clearedOverview.body);
		assert.equal(clearedOverviewBody.rawByteCount, 0);
		assert.equal(clearedOverviewBody.frameCount, 0);
		assert.equal(clearedOverviewBody.activeProfile, null);

		const notesAfterClear = await request("/api/captures/ops-capture/notes");
		status(notesAfterClear, 200);
		const remainingNotes = array(notesAfterClear.body, "notes after clear").map(item => record(item));
		assert.equal(remainingNotes.length, 1);
		assert.equal(remainingNotes[0].text, "keep this capture note");
		assert.equal(record(remainingNotes[0].target).kind, "capture");

		const rawChunks = service.database
			.prepare("SELECT COUNT(*) AS count FROM raw_chunks WHERE capture_id = @id")
			.get({ id: "ops-capture" }) as { count: number };
		const sessions = service.database
			.prepare("SELECT COUNT(*) AS count FROM capture_sessions WHERE capture_id = @id")
			.get({ id: "ops-capture" }) as { count: number };
		assert.equal(rawChunks.count, 0);
		assert.equal(sessions.count, 0);

		const duplicate = await request("/api/captures/ops-capture/duplicate", {
			method: "POST",
			body: { duplicateCaptureId: "ops-copy" }
		});
		status(duplicate, 201);
		const duplicateBody = record(duplicate.body);
		assert.equal(duplicateBody.sourceCaptureId, "ops-capture");
		assert.equal(duplicateBody.captureId, "ops-copy");
		assert.equal(duplicateBody.name, "HTTP command capture · copy");

		const copyRead = await request("/api/captures/ops-copy");
		status(copyRead, 200);
		assert.equal(documentBody(copyRead).name, "HTTP command capture · copy");
		assert.deepEqual(documentBody(copyRead).byteStream, []);
		const copyNotes = await request("/api/captures/ops-copy/notes");
		status(copyNotes, 200);
		assert.equal(array(copyNotes.body, "duplicated notes").length, 1);

		const deleteCopy = await request("/api/captures/ops-copy", { method: "DELETE" });
		status(deleteCopy, 204);
		const deletedCopyRead = await request("/api/captures/ops-copy");
		status(deletedCopyRead, 404);

		const deleteSource = await request("/api/captures/ops-capture", { method: "DELETE" });
		status(deleteSource, 204);
		const deletedSourceRead = await request("/api/captures/ops-capture");
		status(deletedSourceRead, 404);
	});
});

function legacyCaptureDocument(id: string, name: string): JsonRecord {
	return {
		id,
		name,
		description: "legacy JSON capture",
		view: "raw",
		baudRate: 19200,
		inputFormat: "binary",
		params: [{ key: "legacy", value: "yes" }],
		byteStream: [
			{ rawOffset: 0, value: 0x51, timestamp: 400, direction: "rx" },
			{ rawOffset: 1, value: 0x52, timestamp: 410, direction: "tx" }
		],
		frameSections: [{ id: "legacy-section", start: 0, framingMode: "length", frameSize: 2 }],
		messages: [{
			id: "legacy-message",
			timestamp: 400,
			bytes: [0x51, 0x52],
			byteTimestamps: [400, 410],
			rawOffsets: [0, 1]
		}],
		notes: []
	};
}

test("HTTP generic capture PUT rejects canonical storage but remains available for legacy JSON", async () => {
	await withHttpService(async ({ request, service }) => {
		await createCanonical(request, "put-canonical");
		const canonicalPut = await request("/api/captures/put-canonical", {
			method: "PUT",
			body: { id: "put-canonical", name: "must use metadata command", byteStream: [] }
		});
		conflict(canonicalPut, "canonical-command-required");
		const canonicalDocuments = service.database
			.prepare("SELECT COUNT(*) AS count FROM capture_documents WHERE id = @id")
			.get({ id: "put-canonical" }) as { count: number };
		assert.equal(canonicalDocuments.count, 0);

		const legacy = legacyCaptureDocument("put-legacy", "Legacy before update");
		const legacyPut = await request("/api/captures/put-legacy", { method: "PUT", body: legacy });
		status(legacyPut, 200);
		assert.equal(documentBody(legacyPut).name, "Legacy before update");
		const legacyUpdate = await request("/api/captures/put-legacy", {
			method: "PUT",
			body: { ...legacy, name: "Legacy updated through PUT" }
		});
		status(legacyUpdate, 200);
		assert.equal(documentBody(legacyUpdate).name, "Legacy updated through PUT");
		const legacyDocuments = service.database
			.prepare("SELECT COUNT(*) AS count FROM capture_documents WHERE id = @id")
			.get({ id: "put-legacy" }) as { count: number };
		assert.equal(legacyDocuments.count, 1);
	});
});

test("HTTP explicit legacy conversion creates one verified backup and canonical reads ignore it", async () => {
	await withHttpService(async ({ request, service }) => {
		const legacy = legacyCaptureDocument("convert-legacy", "Convertible legacy capture");
		const seeded = await request("/api/captures/convert-legacy", { method: "PUT", body: legacy });
		status(seeded, 200);
		const beforeDocuments = service.database
			.prepare("SELECT COUNT(*) AS count FROM capture_documents WHERE id = @id")
			.get({ id: "convert-legacy" }) as { count: number };
		const beforeBackups = service.database
			.prepare("SELECT COUNT(*) AS count FROM capture_backups WHERE capture_id = @id")
			.get({ id: "convert-legacy" }) as { count: number };
		assert.equal(beforeDocuments.count, 1);
		assert.equal(beforeBackups.count, 0);

		const converted = await request("/api/captures/convert-legacy/convert", { method: "POST", body: {} });
		status(converted, 200);
		assert.equal(record(converted.body).verified, true);

		const documentsAfter = service.database
			.prepare("SELECT COUNT(*) AS count FROM capture_documents WHERE id = @id")
			.get({ id: "convert-legacy" }) as { count: number };
		const backupsAfter = service.database
			.prepare("SELECT COUNT(*) AS count FROM capture_backups WHERE capture_id = @id")
			.get({ id: "convert-legacy" }) as { count: number };
		const verifiedBackups = service.database
			.prepare("SELECT COUNT(*) AS count FROM capture_backups WHERE capture_id = @id AND verified = 1")
			.get({ id: "convert-legacy" }) as { count: number };
		assert.equal(documentsAfter.count, 0);
		assert.equal(backupsAfter.count, 1);
		assert.equal(verifiedBackups.count, 1);

		const backup = await request("/api/captures/convert-legacy/backup");
		status(backup, 200);
		assert.ok([1, true].includes(record(backup.body).verified as number | boolean));
		const normalBeforePoison = await request("/api/captures/convert-legacy");
		status(normalBeforePoison, 200);
		assert.equal(documentBody(normalBeforePoison).name, "Convertible legacy capture");

		service.database
			.prepare("UPDATE capture_backups SET document_json = @documentJson WHERE capture_id = @id")
			.run({
				id: "convert-legacy",
				documentJson: JSON.stringify({ ...legacy, name: "backup must not be read" })
			});
		const normalAfterPoison = await request("/api/captures/convert-legacy");
		status(normalAfterPoison, 200);
		assert.equal(documentBody(normalAfterPoison).name, "Convertible legacy capture");
		assert.deepEqual(
			array(documentBody(normalAfterPoison).byteStream, "converted byteStream").map(item => record(item).value),
			[0x51, 0x52]
		);

		const wholeDocumentPut = await request("/api/captures/convert-legacy", {
			method: "PUT",
			body: { ...legacy, name: "must use canonical command" }
		});
		conflict(wholeDocumentPut, "canonical-command-required");
	});
});

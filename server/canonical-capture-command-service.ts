import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.ts";

export const CANONICAL_STORAGE_STATUS = "canonical" as const;
export const CANONICALIZATION_FAILED_STORAGE_STATUS = "canonicalization-failed" as const;
export const CANONICAL_RETENTION_LIMIT = 50_000;

export type CanonicalStorageStatus =
	| typeof CANONICAL_STORAGE_STATUS
	| typeof CANONICALIZATION_FAILED_STORAGE_STATUS
	| (string & {});

export type CanonicalCommandCode =
	| "VALIDATION_ERROR"
	| "NOT_FOUND"
	| "CONFLICT"
	| "IDEMPOTENCY_CONFLICT"
	| "STORAGE_ERROR";

export type CanonicalCommandErrorDetails = Readonly<Record<string, unknown>>;

export class CanonicalCaptureCommandError extends Error {
	readonly code: CanonicalCommandCode;
	readonly details: CanonicalCommandErrorDetails;

	constructor(code: CanonicalCommandCode, message: string, details: CanonicalCommandErrorDetails = {}) {
		super(message);
		this.name = "CanonicalCaptureCommandError";
		this.code = code;
		this.details = details;
	}
}

export class CanonicalCaptureValidationError extends CanonicalCaptureCommandError {
	constructor(message: string, details: CanonicalCommandErrorDetails = {}) {
		super("VALIDATION_ERROR", message, details);
		this.name = "CanonicalCaptureValidationError";
	}
}

export class CanonicalCaptureNotFoundError extends CanonicalCaptureCommandError {
	constructor(captureId: string) {
		super("NOT_FOUND", `canonical capture ${captureId} was not found`, { captureId });
		this.name = "CanonicalCaptureNotFoundError";
	}
}

export class CanonicalCaptureConflictError extends CanonicalCaptureCommandError {
	constructor(message: string, details: CanonicalCommandErrorDetails = {}) {
		super("CONFLICT", message, details);
		this.name = "CanonicalCaptureConflictError";
	}
}

export class CanonicalCaptureIdempotencyConflictError extends CanonicalCaptureCommandError {
	constructor(message: string, details: CanonicalCommandErrorDetails = {}) {
		super("IDEMPOTENCY_CONFLICT", message, details);
		this.name = "CanonicalCaptureIdempotencyConflictError";
	}
}

export type CanonicalCaptureCommandDependencies = {
	nowIso?: () => string;
	generateId?: () => string;
};

export type OrderedCaptureParameter = Readonly<{
	key: string;
	value: string;
}>;

export type CreateCaptureRequest = Readonly<{
	captureId?: string;
	id?: string;
	requestHash?: string;
	name?: string;
	description?: string;
	controllerView?: string;
	view?: string;
	baudRate?: number;
	inputFormat?: string;
	folderId?: string | null;
	parameters?: readonly OrderedCaptureParameter[];
	}>;

export type CaptureMetadataPatch = Readonly<{
	name?: string;
	description?: string;
	controllerView?: string;
	view?: string;
	baudRate?: number;
	inputFormat?: string;
	folderId?: string | null;
	parameters?: readonly OrderedCaptureParameter[];
}>;

export type PatchMetadataRequest = Readonly<{
	captureId: string;
	patch: CaptureMetadataPatch;
	expectedMetadataRevision?: number;
}>;

export type CaptureStorageStatusResponse = Readonly<{
	captureId: string;
	status: CanonicalStorageStatus | null;
	updatedAt: string | null;
	lastError: string | null;
}>;

export type CaptureSessionStatus = "recording" | "finalizing" | "finalized" | "failed" | "stopped" | (string & {});

export type CaptureSessionState = Readonly<{
	captureId: string;
	ordinal: number;
	id: string;
	status: CaptureSessionStatus;
	firstReceivedAt: number | null;
	lastReceivedAt: number | null;
	startedAt: string | null;
	finalizedAt: string | null;
	nextChunkSequence: number;
	nextRawOffset: number;
}>;

export type StartSessionRequest = Readonly<{
	captureId: string;
	sessionId?: string;
	startedAt?: string;
}>;

export type StartSessionResponse = Readonly<{
	captureId: string;
	session: CaptureSessionState;
	dataRevision: number;
}>;

export type RawChunkSegment = Readonly<{
	bytes: readonly number[] | Uint8Array | Buffer;
	timestamps?: readonly number[];
	directions?: readonly string[];
	direction?: string;
	sessionIds?: readonly (string | null | undefined)[];
	sessionId?: string | null;
}>;

export type RawChunkPayload = Readonly<{
	segments?: readonly RawChunkSegment[];
	bytes?: readonly number[] | Uint8Array | Buffer;
	timestamps?: readonly number[];
	directions?: readonly string[];
	sessionIds?: readonly (string | null | undefined)[];
}>;

export type AppendChunkRequest = Readonly<{
	captureId: string;
	sessionId: string;
	requestId: string;
	sequence: number;
	expectedStartOffset: number;
	segments?: readonly RawChunkSegment[];
	payload?: RawChunkPayload | readonly RawChunkSegment[] | readonly number[] | Uint8Array | Buffer;
	bytes?: readonly number[] | Uint8Array | Buffer;
	timestamps?: readonly number[];
	directions?: readonly string[];
	sessionIds?: readonly (string | null | undefined)[];
	expectedDataRevision?: number;
}>;

export type AppendChunkResponse = Readonly<{
	captureId: string;
	sessionId: string;
	requestId: string;
	sequence: number;
	payloadHash: string;
	acceptedStartOffset: number;
	acceptedEndOffset: number;
	nextRawOffset: number;
	nextSequence: number;
	dataRevision: number;
	idempotent: boolean;
}>;

export type FramingSectionRequest = Readonly<{
	id?: string;
	start: number;
	framingMode: "length" | "marker" | "time";
	frameSize?: number;
	frameMarker?: string;
	markerPosition?: "start" | "end";
	frameTimeGap?: number;
	collapseRuns?: boolean;
	collapsed?: boolean;
}>;

export type FramingDraftState = Readonly<{
	captureId: string;
	revision: number;
	sections: readonly FramingSectionRequest[];
	updatedAt: string;
}>;

export type UpdateFramingDraftRequest = Readonly<{
	captureId: string;
	sections: readonly FramingSectionRequest[];
	expectedRevision?: number;
}>;

export type UpdateFramingDraftResponse = FramingDraftState;

export type FinalizeSessionRequest = Readonly<{
	captureId: string;
	sessionId: string;
	expectedDataRevision?: number;
}>;

export type FinalizationJobState = Readonly<{
	id: string;
	captureId: string;
	sessionId: string | null;
	profileId: string | null;
	status: "pending" | "running" | "completed" | "failed" | (string & {});
	sourceDataRevision: number | null;
	verified: boolean;
	error: string | null;
	createdAt: string;
	updatedAt: string;
}>;

export type FinalizeSessionResponse = Readonly<{
	captureId: string;
	session: CaptureSessionState;
	profileId: string;
	profileVersion: number;
	dataRevision: number;
	retainedStartOffset: number;
	job: FinalizationJobState;
	idempotent: boolean;
}>;

export type ReframeRequest = Readonly<{
	captureId: string;
	sections: readonly FramingSectionRequest[];
	expectedActiveProfileId?: string | null;
	expectedProfileId?: string | null;
	expectedDataRevision: number;
	algorithmVersion?: number;
}>;

export type ReframeResponse = Readonly<{
	captureId: string;
	profileId: string;
	version: number;
	sourceDataRevision: number;
	retainedStartOffset: number;
	verified: boolean;
}>;

export type ByteVisibilityRequest = Readonly<{
	captureId: string;
	rawOffset: number;
	hidden: boolean;
}>;

export type FrameVisibilityRequest = Readonly<{
	captureId: string;
	profileId?: string;
	frameId?: string;
	startRawOffset?: number;
	endRawOffset?: number;
	hidden: boolean;
}>;

export type VisibilityResponse = Readonly<{
	captureId: string;
	profileId?: string;
	frameId?: string;
	startRawOffset: number;
	endRawOffset: number;
	hidden: boolean;
	contentRevision: number;
}>;

export type CanonicalNoteTarget =
	| Readonly<{ kind: "capture" }>
	| Readonly<{ kind: "byte"; rawOffset: number }>
	| Readonly<{
			kind: "frame";
			profileId?: string | null;
			frameId?: string;
			rawOffsets?: readonly number[];
			startRawOffset?: number;
			endRawOffset?: number;
		}>
	| Readonly<{
			kind: "range";
			profileId?: string | null;
			startRow?: number;
			endRow?: number;
			startRawOffset?: number;
			endRawOffset?: number;
		}>
	| Readonly<{ kind: "sequence-group"; sequenceKey: string; profileId?: string | null }>
	| Readonly<{ kind: "sequence"; startRawOffset: number; endRawOffset: number }>
	| Readonly<{ kind: "pattern"; sequenceKey: string }>
	| Readonly<{ kind: "legacy-sequence"; startRow: number; endRow: number }>;

export type CanonicalNote = Readonly<{
	id: string;
	captureId: string;
	text: string;
	createdAt: string;
	updatedAt: string | null;
	target: CanonicalNoteTarget;
}>;

export type CreateNoteRequest = Readonly<{
	captureId: string;
	noteId?: string;
	id?: string;
	text: string;
	target: CanonicalNoteTarget;
	createdAt?: string | number;
}>;

export type UpdateNoteRequest = Readonly<{
	captureId: string;
	noteId: string;
	text?: string;
	target?: CanonicalNoteTarget;
}>;

export type DeleteNoteRequest = Readonly<{
	captureId: string;
	noteId: string;
}>;

export type NoteResponse = Readonly<{
	note: CanonicalNote;
	contentRevision: number;
}>;

export type ClearCaptureDataRequest = Readonly<{
	captureId: string;
}>;

export type ClearCaptureDataResponse = Readonly<{
	captureId: string;
	dataRevision: number;
	contentRevision: number;
	clearedByteCount: number;
}>;

export type DuplicateCaptureRequest = Readonly<{
	captureId: string;
	duplicateCaptureId?: string;
	id?: string;
}>;

export type DuplicateCaptureResponse = Readonly<{
	sourceCaptureId: string;
	captureId: string;
	name: string;
	dataRevision: number;
	metadataRevision: number;
	contentRevision: number;
}>;

export type DeleteCaptureResponse = Readonly<{
	captureId: string;
	deleted: boolean;
}>;

export type CaptureProfileState = Readonly<{
	id: string;
	version: number;
	algorithmVersion: number;
	isActive: boolean;
	sourceDataRevision: number | null;
	retainedStartOffset: number | null;
	verified: boolean;
}>;

export type CaptureState = Readonly<{
	captureId: string;
	name: string;
	description: string;
	controllerView: string;
	baudRate: number | null;
	inputFormat: string;
	folderId: string | null;
	lifecycle: string;
	byteCount: number;
	createdAt: string;
	updatedAt: string;
	dataRevision: number;
	metadataRevision: number;
	contentRevision: number;
	retainedStartOffset: number;
	activeProfile: CaptureProfileState | null;
	storage: CaptureStorageStatusResponse;
	parameters: readonly OrderedCaptureParameter[];
	sessions: readonly CaptureSessionState[];
	draft: FramingDraftState | null;
	byteVisibility: readonly Readonly<{ rawOffset: number; hidden: boolean }>[];
	frameVisibility: readonly Readonly<{
		profileId: string;
		startRawOffset: number;
		endRawOffset: number;
		hidden: boolean;
	}>[];
	notes: readonly CanonicalNote[];
}>;

export type CanonicalCaptureCommandResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; error: CanonicalCaptureCommandError }>;

export function sha256Hex(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stableSerialize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(item => stableSerialize(item)).join(",")}]`;
	return `{${Object.keys(value as Record<string, unknown>)
		.sort()
		.map(key => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`)
		.join(",")}}`;
}

function requiredString(value: unknown, field: string): string {
	const result = String(value ?? "").trim();
	if (!result) throw new CanonicalCaptureValidationError(`${field} is required`, { field });
	return result;
}

function optionalString(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	return String(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result < 0) {
		throw new CanonicalCaptureValidationError(`${field} must be a non-negative integer`, { field, value });
	}
	return result;
}

function optionalPositiveNumber(value: unknown, field: string): number | null {
	if (value === undefined || value === null || value === "") return null;
	const result = Number(value);
	if (!Number.isFinite(result) || result <= 0) {
		throw new CanonicalCaptureValidationError(`${field} must be a positive number`, { field, value });
	}
	return result;
}

function normalizedParameters(parameters: readonly OrderedCaptureParameter[] | undefined): OrderedCaptureParameter[] {
	if (parameters === undefined) return [];
	return parameters.map((parameter, position) => {
		if (!isRecord(parameter)) throw new CanonicalCaptureValidationError("capture parameter must be an object", { position });
		const key = requiredString(parameter.key, `parameters[${position}].key`);
		return { key, value: String(parameter.value ?? "") };
	});
}

function normalizedCaptureId(request: CreateCaptureRequest, generateId: () => string): string {
	const supplied = request.captureId ?? request.id;
	return supplied === undefined ? requiredString(generateId(), "captureId") : requiredString(supplied, "captureId");
}

function captureCreationHash(request: CreateCaptureRequest, captureId: string): string {
	const supplied = optionalString(request.requestHash)?.trim();
	if (supplied) return supplied;
	return sha256Hex(
		stableSerialize({
			captureId: request.captureId ?? request.id ? captureId : null,
			name: String(request.name ?? "Untitled capture"),
			description: String(request.description ?? ""),
			controllerView: String(request.controllerView ?? request.view ?? ""),
			baudRate: request.baudRate === undefined ? 115200 : request.baudRate,
			inputFormat: String(request.inputFormat ?? ""),
			folderId: request.folderId ?? null,
			parameters: normalizedParameters(request.parameters)
		})
	);
}

function isoFrom(value: string | number | undefined, fallback: string): string {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
	const parsed = Date.parse(String(value));
	if (!Number.isFinite(parsed)) throw new CanonicalCaptureValidationError("timestamp must be an ISO date or epoch milliseconds");
	return new Date(parsed).toISOString();
}

type CaptureRow = {
	id: string;
	name: string;
	description: string;
	controller_view: string;
	baud_rate: number | null;
	input_format: string;
	lifecycle: string;
	byte_count: number;
	created_at: string;
	updated_at: string;
	folder_id: string | null;
	data_revision: number;
	metadata_revision: number;
	content_revision: number;
	retained_start_offset: number;
	active_framing_profile_id: string | null;
};

type NoteRow = {
	id: string;
	capture_id: string;
	text: string;
	created_at: string;
	updated_at: string | null;
	target_kind: string;
	raw_offset: number | null;
	profile_id: string | null;
	raw_offsets_json: string | null;
	start_offset: number | null;
	end_offset: number | null;
	sequence_key: string | null;
	start_row: number | null;
	end_row: number | null;
};

function noteTargetFromRow(row: NoteRow): CanonicalNoteTarget {
	if (row.target_kind === "byte") return { kind: "byte", rawOffset: row.raw_offset ?? 0 };
	if (row.target_kind === "frame") {
		const rawOffsets = row.raw_offsets_json ? (JSON.parse(row.raw_offsets_json) as number[]) : undefined;
		return { kind: "frame", profileId: row.profile_id, ...(rawOffsets ? { rawOffsets } : {}) };
	}
	if (row.target_kind === "range") {
		return {
			kind: "range",
			profileId: row.profile_id,
			...(row.start_row === null ? {} : { startRow: row.start_row }),
			...(row.end_row === null ? {} : { endRow: row.end_row }),
			...(row.start_offset === null ? {} : { startRawOffset: row.start_offset }),
			...(row.end_offset === null ? {} : { endRawOffset: row.end_offset })
		};
	}
	if (row.target_kind === "sequence-group" || row.target_kind === "pattern") {
		return { kind: row.target_kind === "pattern" ? "pattern" : "sequence-group", sequenceKey: row.sequence_key ?? "" };
	}
	if (row.target_kind === "sequence") {
		return { kind: "sequence", startRawOffset: row.start_offset ?? 0, endRawOffset: row.end_offset ?? 0 };
	}
	if (row.target_kind === "legacy-sequence") {
		return { kind: "legacy-sequence", startRow: row.start_row ?? 1, endRow: row.end_row ?? row.start_row ?? 1 };
	}
	return { kind: "capture" };
}

export class CanonicalCaptureCommandService {
	protected readonly database: SqliteDatabase;
	protected readonly nowIso: () => string;
	protected readonly generateId: () => string;

	constructor(database: SqliteDatabase, dependencies: CanonicalCaptureCommandDependencies = {}) {
		this.database = database;
		this.nowIso = dependencies.nowIso ?? (() => new Date().toISOString());
		this.generateId = dependencies.generateId ?? randomUUID;
	}

	createCapture(request: CreateCaptureRequest): CaptureState {
		const captureId = normalizedCaptureId(request, this.generateId);
		const requestHash = captureCreationHash(request, captureId);
		const name = String(request.name ?? "Untitled capture");
		const description = String(request.description ?? "");
		const controllerView = String(request.controllerView ?? request.view ?? "");
		const baudRate = request.baudRate === undefined ? 115200 : optionalPositiveNumber(request.baudRate, "baudRate");
		const inputFormat = String(request.inputFormat ?? "");
		const folderId = request.folderId === undefined ? null : optionalString(request.folderId);
		const parameters = normalizedParameters(request.parameters);
		const now = this.nowIso();

		const transaction = this.database.transaction(() => {
			const existingByHash = this.database
				.prepare("SELECT id, create_request_hash FROM captures WHERE create_request_hash = @requestHash")
				.get({ requestHash }) as { id: string; create_request_hash: string } | undefined;
			if (existingByHash) {
				if ((request.captureId ?? request.id) !== undefined && existingByHash.id !== captureId) {
					throw new CanonicalCaptureIdempotencyConflictError("create request hash belongs to another capture", {
						requestHash,
						expectedCaptureId: captureId,
						actualCaptureId: existingByHash.id
					});
				}
				return existingByHash.id;
			}

			const existing = this.database.prepare("SELECT id, create_request_hash FROM captures WHERE id = @captureId").get({ captureId }) as
				| { id: string; create_request_hash: string | null }
				| undefined;
			if (existing) {
				if (existing.create_request_hash === requestHash) return captureId;
				throw new CanonicalCaptureIdempotencyConflictError("capture id already exists with a different create request", {
					captureId,
					expectedRequestHash: requestHash,
					actualRequestHash: existing.create_request_hash
				});
			}

			this.database
				.prepare(
					`INSERT INTO captures
					 (id, name, description, controller_view, baud_rate, input_format, lifecycle, byte_count,
					  created_at, updated_at, folder_id, data_revision, metadata_revision, content_revision,
					  retained_start_offset, create_request_hash)
					 VALUES (@id, @name, @description, @controllerView, @baudRate, @inputFormat, 'stopped', 0,
					  @createdAt, @updatedAt, @folderId, 0, 0, 0, 0, @requestHash)`
				)
				.run({
					id: captureId,
					name,
					description,
					controllerView,
					baudRate,
					inputFormat,
					createdAt: now,
					updatedAt: now,
					folderId,
					requestHash
				});
			const insertParameter = this.database.prepare(
				"INSERT INTO capture_parameters (capture_id, position, key_text, value_text) VALUES (@captureId, @position, @keyText, @valueText)"
			);
			parameters.forEach((parameter, position) =>
				insertParameter.run({ captureId, position, keyText: parameter.key, valueText: parameter.value })
			);
			this.database
				.prepare(
					`INSERT INTO capture_storage (capture_id, status, updated_at, last_error)
					 VALUES (@captureId, @status, @updatedAt, NULL)`
				)
				.run({ captureId, status: CANONICAL_STORAGE_STATUS, updatedAt: now });
			return captureId;
		});

		const id = transaction() as string;
		return this.getCaptureState(id);
	}

	getStorageStatus(captureId: string): CaptureStorageStatusResponse {
		const id = requiredString(captureId, "captureId");
		const row = this.database
			.prepare("SELECT capture_id, status, updated_at, last_error FROM capture_storage WHERE capture_id = @captureId")
			.get({ captureId: id }) as
			| { capture_id: string; status: string; updated_at: string; last_error: string | null }
			| undefined;
		return {
			captureId: id,
			status: row?.status ?? null,
			updatedAt: row?.updated_at ?? null,
			lastError: row?.last_error ?? null
		};
	}

	getCaptureState(captureId: string): CaptureState {
		const id = requiredString(captureId, "captureId");
		const row = this.database
			.prepare(
				`SELECT id, name, description, controller_view, baud_rate, input_format, lifecycle, byte_count,
						created_at, updated_at, folder_id, data_revision, metadata_revision, content_revision,
						retained_start_offset, active_framing_profile_id
				 FROM captures WHERE id = @captureId`
			)
			.get({ captureId: id }) as CaptureRow | undefined;
		if (!row) throw new CanonicalCaptureNotFoundError(id);

		const parameters = this.database
			.prepare("SELECT position, key_text, value_text FROM capture_parameters WHERE capture_id = @captureId ORDER BY position")
			.all({ captureId: id }) as Array<{ position: number; key_text: string; value_text: string }>;
		const sessions = this.database
			.prepare(
				`SELECT capture_id, ordinal, id, status, first_received_at, last_received_at, started_at, finalized_at,
						next_chunk_sequence, next_raw_offset
				 FROM capture_sessions WHERE capture_id = @captureId ORDER BY ordinal`
			)
			.all({ captureId: id }) as Array<{
				capture_id: string;
				ordinal: number;
				id: string;
				status: string;
				first_received_at: number | null;
				last_received_at: number | null;
				started_at: string | null;
				finalized_at: string | null;
				next_chunk_sequence: number;
				next_raw_offset: number;
			}>;
		const activeProfile = row.active_framing_profile_id
			? (this.database
					.prepare(
						"SELECT id, version, algorithm_version, is_active, source_data_revision, retained_start_offset, verified FROM framing_profiles WHERE id = @profileId"
					)
					.get({ profileId: row.active_framing_profile_id }) as
					| {
							id: string;
							version: number;
							algorithm_version: number;
							is_active: number;
							source_data_revision: number | null;
							retained_start_offset: number | null;
							verified: number;
						}
					| undefined)
			: undefined;
		const draftRow = this.database
			.prepare("SELECT capture_id, revision, sections_json, updated_at FROM framing_drafts WHERE capture_id = @captureId ORDER BY revision DESC LIMIT 1")
			.get({ captureId: id }) as { capture_id: string; revision: number; sections_json: string; updated_at: string } | undefined;
		const byteVisibility = this.database
			.prepare("SELECT raw_offset, hidden FROM raw_byte_visibility WHERE capture_id = @captureId ORDER BY raw_offset")
			.all({ captureId: id }) as Array<{ raw_offset: number; hidden: number }>;
		const frameVisibility = this.database
			.prepare(
				"SELECT profile_id, start_raw_offset, end_raw_offset, hidden FROM frame_visibility WHERE capture_id = @captureId ORDER BY profile_id, start_raw_offset, end_raw_offset"
			)
			.all({ captureId: id }) as Array<{
				profile_id: string;
				start_raw_offset: number;
				end_raw_offset: number;
				hidden: number;
			}>;
		const notes = this.database
			.prepare(
				`SELECT id, capture_id, text, created_at, updated_at, target_kind, raw_offset, profile_id,
						raw_offsets_json, start_offset, end_offset, sequence_key, start_row, end_row
				 FROM stable_notes WHERE capture_id = @captureId ORDER BY created_at, id`
			)
			.all({ captureId: id }) as NoteRow[];

		return {
			captureId: row.id,
			name: row.name,
			description: row.description,
			controllerView: row.controller_view,
			baudRate: row.baud_rate,
			inputFormat: row.input_format,
			folderId: row.folder_id,
			lifecycle: row.lifecycle,
			byteCount: row.byte_count,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			dataRevision: row.data_revision,
			metadataRevision: row.metadata_revision,
			contentRevision: row.content_revision,
			retainedStartOffset: row.retained_start_offset,
			activeProfile: activeProfile
				? {
						id: activeProfile.id,
						version: activeProfile.version,
						algorithmVersion: activeProfile.algorithm_version,
						isActive: Boolean(activeProfile.is_active),
						sourceDataRevision: activeProfile.source_data_revision,
						retainedStartOffset: activeProfile.retained_start_offset,
						verified: Boolean(activeProfile.verified)
					}
				: null,
			storage: this.getStorageStatus(id),
			parameters: parameters.map(parameter => ({ key: parameter.key_text, value: parameter.value_text })),
			sessions: sessions.map(session => ({
				captureId: session.capture_id,
				ordinal: session.ordinal,
				id: session.id,
				status: session.status,
				firstReceivedAt: session.first_received_at,
				lastReceivedAt: session.last_received_at,
				startedAt: session.started_at,
				finalizedAt: session.finalized_at,
				nextChunkSequence: session.next_chunk_sequence,
				nextRawOffset: session.next_raw_offset
			})),
			draft: draftRow
				? {
						captureId: draftRow.capture_id,
						revision: draftRow.revision,
						sections: JSON.parse(draftRow.sections_json) as FramingSectionRequest[],
						updatedAt: draftRow.updated_at
					}
				: null,
			byteVisibility: byteVisibility.map(item => ({ rawOffset: item.raw_offset, hidden: Boolean(item.hidden) })),
			frameVisibility: frameVisibility.map(item => ({
				profileId: item.profile_id,
				startRawOffset: item.start_raw_offset,
				endRawOffset: item.end_raw_offset,
				hidden: Boolean(item.hidden)
			})),
			notes: notes.map(note => ({
				id: note.id,
				captureId: note.capture_id,
				text: note.text,
				createdAt: note.created_at,
				updatedAt: note.updated_at,
				target: noteTargetFromRow(note)
			}))
		};
	}

	patchMetadata(_request: PatchMetadataRequest): CaptureState {
		throw new Error("CanonicalCaptureCommandService.patchMetadata is not implemented");
	}

	startSession(_request: StartSessionRequest): StartSessionResponse {
		throw new Error("CanonicalCaptureCommandService.startSession is not implemented");
	}

	appendChunk(_request: AppendChunkRequest): AppendChunkResponse {
		throw new Error("CanonicalCaptureCommandService.appendChunk is not implemented");
	}

	finalizeSession(_request: FinalizeSessionRequest): FinalizeSessionResponse {
		throw new Error("CanonicalCaptureCommandService.finalizeSession is not implemented");
	}

	updateFramingDraft(_request: UpdateFramingDraftRequest): UpdateFramingDraftResponse {
		throw new Error("CanonicalCaptureCommandService.updateFramingDraft is not implemented");
	}

	reframe(_request: ReframeRequest): ReframeResponse {
		throw new Error("CanonicalCaptureCommandService.reframe is not implemented");
	}

	setByteVisibility(_request: ByteVisibilityRequest): VisibilityResponse {
		throw new Error("CanonicalCaptureCommandService.setByteVisibility is not implemented");
	}

	deleteByteVisibility(_captureId: string, _rawOffset: number): Readonly<{ contentRevision: number }> {
		throw new Error("CanonicalCaptureCommandService.deleteByteVisibility is not implemented");
	}

	setFrameVisibility(_request: FrameVisibilityRequest): VisibilityResponse {
		throw new Error("CanonicalCaptureCommandService.setFrameVisibility is not implemented");
	}

	deleteFrameVisibility(_request: Omit<FrameVisibilityRequest, "hidden">): Readonly<{ contentRevision: number }> {
		throw new Error("CanonicalCaptureCommandService.deleteFrameVisibility is not implemented");
	}

	createNote(_request: CreateNoteRequest): NoteResponse {
		throw new Error("CanonicalCaptureCommandService.createNote is not implemented");
	}

	updateNote(_request: UpdateNoteRequest): NoteResponse {
		throw new Error("CanonicalCaptureCommandService.updateNote is not implemented");
	}

	deleteNote(_request: DeleteNoteRequest): Readonly<{ contentRevision: number }> {
		throw new Error("CanonicalCaptureCommandService.deleteNote is not implemented");
	}

	clearCaptureData(_request: ClearCaptureDataRequest): ClearCaptureDataResponse {
		throw new Error("CanonicalCaptureCommandService.clearCaptureData is not implemented");
	}

	duplicateCapture(_request: DuplicateCaptureRequest): DuplicateCaptureResponse {
		throw new Error("CanonicalCaptureCommandService.duplicateCapture is not implemented");
	}

	deleteCapture(_captureId: string): DeleteCaptureResponse {
		throw new Error("CanonicalCaptureCommandService.deleteCapture is not implemented");
	}

}

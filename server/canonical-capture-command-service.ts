import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.ts";
import {
	buildCanonicalMaterialization,
	normalizeSectionsForConversion,
	persistCanonicalMaterializationRows,
	verifyCanonicalMaterializationRows,
	type CaptureSection,
	type RawByteRecord,
	type NormalizedSection
} from "./canonical.ts";

export const CANONICAL_STORAGE_STATUS = "canonical" as const;
export const CANONICALIZATION_FAILED_STORAGE_STATUS = "canonicalization-failed" as const;
export const CANONICAL_RETENTION_LIMIT = 50_000;
export const ALLOW_AGENT_AUTHORED_NOTES_SETTING = "allow_agent_authored_notes" as const;

export type CanonicalStorageStatus =
	| typeof CANONICAL_STORAGE_STATUS
	| typeof CANONICALIZATION_FAILED_STORAGE_STATUS
	| (string & {});

export type CanonicalCommandCode =
	| "VALIDATION_ERROR"
	| "NOT_FOUND"
	| "CONFLICT"
	| "ANNOTATION_DISABLED"
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

export class CanonicalCaptureAnnotationDisabledError extends CanonicalCaptureCommandError {
	constructor() {
		super("ANNOTATION_DISABLED", "Agent-authored notes are disabled in Bus Lens settings");
		this.name = "CanonicalCaptureAnnotationDisabledError";
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
	framing: readonly FramingSectionRequest[] | Readonly<{ sections: readonly FramingSectionRequest[] }>;
	name?: string;
	description?: string;
	controllerView?: string;
	view?: string;
	baudRate?: number;
	inputFormat: "binary";
	folderId?: string | null;
	parameters?: readonly OrderedCaptureParameter[];
	}>;

export type CaptureMetadataPatch = Readonly<{
	name?: string;
	description?: string;
	controllerView?: string;
	view?: string;
	baudRate?: number;
	inputFormat?: "binary";
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
	timestamp?: number;
	direction?: string;
	timestamps?: readonly number[];
	directions?: readonly string[];
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
	sections: readonly Omit<FramingSectionRequest, "collapseRuns" | "collapsed">[];
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

export type FramingSectionViewRequest = Readonly<{
	captureId: string;
	profileId: string;
	sectionId: string;
	collapseRuns?: boolean;
	collapsed?: boolean;
}>;

export type FramingSectionViewResponse = Readonly<{
	captureId: string;
	profileId: string;
	sectionId: string;
	collapseRuns: boolean;
	collapsed: boolean;
	contentRevision: number;
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
			startOrdinal?: number;
			endOrdinal?: number;
			startRow?: number;
			endRow?: number;
			startRawOffset?: number;
			endRawOffset?: number;
		}>
	| Readonly<{ kind: "raw-range"; startRawOffset: number; endRawOffset: number }>
	| Readonly<{
			kind: "frame-range";
			profileId: string;
			startOrdinal: number;
			endOrdinal: number;
		}>
	| Readonly<{ kind: "sequence-group"; groupId?: string; sequenceKey?: string; profileId?: string | null }>
	| Readonly<{ kind: "sequence"; startRawOffset: number; endRawOffset: number }>
	| Readonly<{ kind: "pattern"; sequenceKey: string }>
	| Readonly<{ kind: "legacy-sequence"; startRow: number; endRow: number }>;

export type CanonicalNote = Readonly<{
	id: string;
	captureId: string;
	text: string;
	createdAt: string;
	updatedAt: string | null;
	authorType: "human" | "agent";
	reportedClientName?: string;
	reportedClientVersion?: string;
	protocolVersion?: string;
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

export type AgentNoteAttribution = Readonly<{
	authorType: "agent";
	reportedClientName: string;
	reportedClientVersion?: string;
	protocolVersion: string;
}>;

export type CreateAgentNoteRequest = Readonly<{
	captureId: string;
	noteId?: string;
	text: string;
	target: CanonicalNoteTarget;
	profileId?: string;
	profileVersion?: number;
	sourceDataRevision?: number;
	attribution: AgentNoteAttribution;
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
			inputFormat: request.inputFormat,
			framing: request.framing,
			folderId: request.folderId ?? null,
			parameters: normalizedParameters(request.parameters)
		})
	);
}

function framingSectionsFrom(value: CreateCaptureRequest["framing"] | readonly FramingSectionRequest[]): readonly FramingSectionRequest[] {
	if (Array.isArray(value)) return value;
	if (isRecord(value) && Array.isArray(value.sections)) return value.sections as readonly FramingSectionRequest[];
	throw new CanonicalCaptureValidationError("framing sections are required");
}

function normalizeFramingSections(
	value: CreateCaptureRequest["framing"] | readonly FramingSectionRequest[],
	generateId: () => string,
	includeViewState = true
): FramingSectionRequest[] {
	const sections = framingSectionsFrom(value);
	if (!sections.length) throw new CanonicalCaptureValidationError("at least one framing section is required");
	let previousStart = -1;
	return sections.map((section, index) => {
		if (!isRecord(section)) throw new CanonicalCaptureValidationError("framing section must be an object", { index });
		const start = nonNegativeInteger(section.start, `framing[${index}].start`);
		if (start < previousStart) throw new CanonicalCaptureValidationError("framing sections must be ordered by start", { index });
		if (index === 0 && start !== 0) throw new CanonicalCaptureValidationError("the first framing section must start at raw offset 0");
		previousStart = start;
		const framingMode = section.framingMode;
		if (framingMode !== "length" && framingMode !== "marker" && framingMode !== "time") {
			throw new CanonicalCaptureValidationError("framing mode must be length, marker, or time", { index, framingMode });
		}
		const frameSize = section.frameSize === undefined ? undefined : nonNegativeInteger(section.frameSize, `framing[${index}].frameSize`);
		const frameTimeGap = section.frameTimeGap === undefined ? undefined : Number(section.frameTimeGap);
		if (framingMode === "length" && (!frameSize || frameSize < 1)) {
			throw new CanonicalCaptureValidationError("length framing requires a positive frameSize", { index });
		}
		if (framingMode === "time" && (frameTimeGap === undefined || !Number.isFinite(frameTimeGap) || frameTimeGap <= 0)) {
			throw new CanonicalCaptureValidationError("time framing requires a positive frameTimeGap", { index });
		}
		const frameMarker = String(section.frameMarker ?? "").trim();
		// An empty marker is a pending section: the shared domain engine frames
		// zero messages until marker bytes are set, so persistence must accept it.
		const markerPosition = section.markerPosition ?? "start";
		if (markerPosition !== "start" && markerPosition !== "end") {
			throw new CanonicalCaptureValidationError("markerPosition must be start or end", { index });
		}
		return {
			id: requiredString(section.id ?? generateId(), `framing[${index}].id`),
			start,
			framingMode,
			...(frameSize === undefined ? {} : { frameSize }),
			frameMarker,
			markerPosition,
			...(frameTimeGap === undefined ? {} : { frameTimeGap }),
			...(includeViewState
				? { collapseRuns: Boolean(section.collapseRuns), collapsed: Boolean(section.collapsed) }
				: {})
		};
	});
}

type StoredFramingSectionRow = {
	id: string;
	start_offset: number;
	framing_mode: string;
	frame_length: number | null;
	marker_bytes: string | null;
	marker_position: string | null;
	time_gap_ms: number | null;
	collapse_runs: number;
	collapsed: number;
};

function markerTextFromStoredBytes(value: string | null): string {
	if (!value) return "";
	try {
		const bytes = JSON.parse(value) as unknown;
		if (!Array.isArray(bytes)) return "";
		return bytes
			.map(Number)
			.filter(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
			.map(byte => byte.toString(16).padStart(2, "0").toUpperCase())
			.join(" ");
	} catch {
		return "";
	}
}

function framingRequestsFromStoredSections(rows: readonly StoredFramingSectionRow[]): FramingSectionRequest[] {
	return rows.map(row => ({
		id: row.id,
		start: row.start_offset,
		framingMode: row.framing_mode as FramingSectionRequest["framingMode"],
		frameSize: row.frame_length ?? 3,
		frameMarker: markerTextFromStoredBytes(row.marker_bytes),
		markerPosition: row.marker_position === "end" ? "end" : "start",
		frameTimeGap: row.time_gap_ms ?? 5,
		collapseRuns: Boolean(row.collapse_runs),
		collapsed: Boolean(row.collapsed)
	}));
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
	sequence_group_id: string | null;
	author_type: "human" | "agent";
	reported_client_name: string | null;
	reported_client_version: string | null;
	protocol_version: string | null;
};

type FlattenedChunk = {
	bytes: Buffer;
	timestamps: number[];
	directions: string[];
	sessionIds: Array<string | null>;
};

function numbersFromBytes(value: readonly number[] | Uint8Array | Buffer, field: string): number[] {
	const values = Buffer.isBuffer(value) ? [...value] : Array.from(value as ArrayLike<number>);
	return values.map((item, index) => {
		const byte = Number(item);
		if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
			throw new CanonicalCaptureValidationError(`${field}[${index}] must be a byte`, { field, index, value: item });
		}
		return byte;
	});
}

function normalizedDirection(value: unknown, field: string): "rx" | "tx" {
	if (value !== "rx" && value !== "tx") throw new CanonicalCaptureValidationError(`${field} must be rx or tx`, { field, value });
	return value;
}

function segmentFrom(value: unknown, index: number): RawChunkSegment {
	if (!isRecord(value) || value.bytes === undefined) {
		throw new CanonicalCaptureValidationError(`segments[${index}] must contain bytes`, { index });
	}
	return value as unknown as RawChunkSegment;
}

function flattenChunkPayload(request: AppendChunkRequest): FlattenedChunk {
	let segments: RawChunkSegment[] = [];
	let fallbackBytes: readonly number[] | Uint8Array | Buffer | undefined;
	let fallbackTimestamps: readonly number[] | undefined;
	let fallbackDirections: readonly string[] | undefined;
	let fallbackSessionIds: readonly (string | null | undefined)[] | undefined;
	if (request.segments !== undefined) {
		segments = request.segments.map(segmentFrom);
	} else if (request.payload !== undefined) {
		if (Array.isArray(request.payload)) {
			if (request.payload.length === 0 || typeof request.payload[0] === "number") fallbackBytes = request.payload as readonly number[];
			else segments = request.payload.map(segmentFrom);
		} else if (isRecord(request.payload) && request.payload.segments !== undefined) {
			segments = (request.payload.segments as readonly unknown[]).map(segmentFrom);
			fallbackBytes = request.payload.bytes as readonly number[] | Uint8Array | Buffer | undefined;
			fallbackTimestamps = request.payload.timestamps as readonly number[] | undefined;
			fallbackDirections = request.payload.directions as readonly string[] | undefined;
			fallbackSessionIds = request.payload.sessionIds as readonly (string | null | undefined)[] | undefined;
		} else if (isRecord(request.payload) && request.payload.bytes !== undefined) {
			fallbackBytes = request.payload.bytes as readonly number[] | Uint8Array | Buffer;
			fallbackTimestamps = request.payload.timestamps as readonly number[] | undefined;
			fallbackDirections = request.payload.directions as readonly string[] | undefined;
			fallbackSessionIds = request.payload.sessionIds as readonly (string | null | undefined)[] | undefined;
		} else {
			fallbackBytes = request.payload as readonly number[] | Uint8Array | Buffer;
		}
	} else if (request.bytes !== undefined) {
		fallbackBytes = request.bytes;
		fallbackTimestamps = request.timestamps;
		fallbackDirections = request.directions;
		fallbackSessionIds = request.sessionIds;
	}
	if (fallbackBytes !== undefined) {
		segments.push({ bytes: fallbackBytes, timestamps: fallbackTimestamps, directions: fallbackDirections, sessionIds: fallbackSessionIds });
	}
	if (!segments.length) throw new CanonicalCaptureValidationError("append payload must contain at least one segment");

	const bytes: number[] = [];
	const timestamps: number[] = [];
	const directions: string[] = [];
	const sessionIds: Array<string | null> = [];
	segments.forEach((segment, segmentIndex) => {
		const segmentBytes = numbersFromBytes(segment.bytes, `segments[${segmentIndex}].bytes`);
		const segmentTimestamps = segment.timestamps === undefined
			? segment.timestamp === undefined
				? []
				: segmentBytes.map(() => Number(segment.timestamp))
			: segment.timestamps.map(Number);
		const segmentDirections = segment.directions === undefined
			? segment.direction === undefined
				? []
				: segmentBytes.map(() => normalizedDirection(segment.direction, `segments[${segmentIndex}].direction`))
			: segment.directions.map((direction, index) => normalizedDirection(direction, `segments[${segmentIndex}].directions[${index}]`));
		const segmentSessionIds = segment.sessionIds === undefined ? [] : segment.sessionIds.map(sessionId => sessionId ? String(sessionId) : null);
		if (segmentTimestamps.length && segmentTimestamps.length !== segmentBytes.length) {
			throw new CanonicalCaptureValidationError("segment timestamps must match segment byte count", { segmentIndex });
		}
		if (segmentDirections.length && segmentDirections.length !== segmentBytes.length) {
			throw new CanonicalCaptureValidationError("segment directions must match segment byte count", { segmentIndex });
		}
		if (segmentSessionIds.length && segmentSessionIds.length !== segmentBytes.length) {
			throw new CanonicalCaptureValidationError("segment sessionIds must match segment byte count", { segmentIndex });
		}
		segmentBytes.forEach((byte, index) => {
			const timestamp = segmentTimestamps[index] ?? 0;
			if (!Number.isFinite(timestamp)) throw new CanonicalCaptureValidationError("segment timestamp must be finite", { segmentIndex, index });
			bytes.push(byte);
			timestamps.push(timestamp);
			directions.push(segmentDirections[index] || "rx");
			sessionIds.push(segmentSessionIds[index] ?? (segment.sessionId ? String(segment.sessionId) : null));
		});
	});
	if (!bytes.length) throw new CanonicalCaptureValidationError("append payload must contain at least one byte");
	return { bytes: Buffer.from(bytes), timestamps, directions, sessionIds };
}

function chunkPayloadHash(payload: FlattenedChunk): string {
	return sha256Hex(
		stableSerialize({
			bytes: [...payload.bytes],
			timestamps: payload.timestamps,
			directions: payload.directions,
			sessionIds: payload.sessionIds
		})
	);
}

function appendSemanticHash(captureId: string, sessionId: string, sequence: number, expectedStartOffset: number, payload: FlattenedChunk): string {
	return sha256Hex(
		stableSerialize({
			captureId,
			sessionId,
			sequence,
			expectedStartOffset,
			payloadHash: chunkPayloadHash(payload)
		})
	);
}

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
			...(row.start_row === null ? {} : { startOrdinal: row.start_row }),
			...(row.end_row === null ? {} : { endOrdinal: row.end_row }),
			...(row.start_offset === null ? {} : { startRawOffset: row.start_offset }),
			...(row.end_offset === null ? {} : { endRawOffset: row.end_offset })
		};
	}
	if (row.target_kind === "frame-range") {
		return {
			kind: "frame-range",
			profileId: row.profile_id ?? "",
			startOrdinal: row.start_row ?? 0,
			endOrdinal: row.end_row ?? row.start_row ?? 0
		};
	}
	if (row.target_kind === "raw-range") {
		return { kind: "raw-range", startRawOffset: row.start_offset ?? 0, endRawOffset: row.end_offset ?? row.start_offset ?? 0 };
	}
	if (row.target_kind === "sequence-group" || row.target_kind === "pattern") {
		if (row.target_kind === "sequence-group") {
			return {
				kind: "sequence-group",
				groupId: row.sequence_group_id ?? undefined,
				sequenceKey: row.sequence_key ?? undefined,
				profileId: row.profile_id
			};
		}
		return { kind: "pattern", sequenceKey: row.sequence_key ?? "" };
	}
	if (row.target_kind === "sequence") {
		return { kind: "sequence", startRawOffset: row.start_offset ?? 0, endRawOffset: row.end_offset ?? 0 };
	}
	if (row.target_kind === "legacy-sequence") {
		return { kind: "legacy-sequence", startRow: row.start_row ?? 1, endRow: row.end_row ?? row.start_row ?? 1 };
	}
	return { kind: "capture" };
}

function safeNoteRawOffset(value: number | null): number | null {
	return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function noteRawOffsets(row: NoteRow): number[] | null {
	if (!row.raw_offsets_json) return null;
	try {
		const parsed = JSON.parse(row.raw_offsets_json) as unknown;
		if (!Array.isArray(parsed)) return null;
		const offsets = parsed.map(Number);
		return offsets.every(offset => Number.isSafeInteger(offset) && offset >= 0) ? offsets : null;
	} catch {
		return null;
	}
}

/**
 * Return the last raw byte explicitly referenced by a note, when its target
 * shape carries a raw span. A missing span is deliberately represented as
 * null: retention must not discard a stable target merely because an older
 * compatibility row cannot prove where its evidence was stored.
 */
function noteRawSpanEnd(row: NoteRow): number | null {
	if (row.target_kind === "byte") return safeNoteRawOffset(row.raw_offset);
	const explicitEnd = safeNoteRawOffset(row.end_offset);
	if (row.target_kind === "frame") {
		const offsets = noteRawOffsets(row) ?? [];
		const ends = explicitEnd === null ? offsets : [...offsets, explicitEnd];
		return ends.length ? Math.max(...ends) : null;
	}
	if (row.target_kind === "range" || row.target_kind === "raw-range" || row.target_kind === "frame-range" || row.target_kind === "sequence" || row.target_kind === "legacy-sequence") return explicitEnd;
	return null;
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

	private requireCanonicalStorage(captureId: string): void {
		const row = this.database
			.prepare("SELECT status FROM capture_storage WHERE capture_id = @captureId")
			.get({ captureId }) as { status: string } | undefined;
		if (!row || row.status !== CANONICAL_STORAGE_STATUS) {
			throw new CanonicalCaptureConflictError("capture storage is not canonical", {
				captureId,
				status: row?.status ?? null,
				requiredStatus: CANONICAL_STORAGE_STATUS
			});
		}
	}

	/**
	 * Older canonicalized captures predate the framing-draft seed. Repair that
	 * narrow piece of state at the command boundary so an existing archive can
	 * start a new live session without requiring a manual database migration.
	 */
	private ensureFramingDraft(captureId: string, dataRevision: number): void {
		const existing = this.database
			.prepare("SELECT 1 FROM framing_drafts WHERE capture_id = @captureId LIMIT 1")
			.get({ captureId });
		if (existing) return;

		const profile = this.database
			.prepare(
				`SELECT id, source_data_revision
				 FROM framing_profiles
				 WHERE capture_id = @captureId AND is_active = 1
				 ORDER BY version DESC LIMIT 1`
			)
			.get({ captureId }) as { id: string; source_data_revision: number | null } | undefined;
		if (!profile) {
			throw new CanonicalCaptureConflictError("framing draft is missing", { captureId });
		}

		const sections = this.database
			.prepare(
				`SELECT id, start_offset, framing_mode, frame_length, marker_bytes, marker_position,
						time_gap_ms, collapse_runs, collapsed
				 FROM framing_sections WHERE capture_id = @captureId AND profile_id = @profileId ORDER BY position`
			)
			.all({ captureId, profileId: profile.id }) as StoredFramingSectionRow[];
		if (!sections.length) {
			throw new CanonicalCaptureConflictError("framing draft is missing", { captureId });
		}

		const now = this.nowIso();
		this.database
			.prepare(
				`INSERT INTO framing_drafts
					(capture_id, revision, sections_json, source_data_revision, created_at, updated_at)
				 VALUES (@captureId, 0, @sectionsJson, @sourceDataRevision, @createdAt, @updatedAt)`
			)
			.run({
				captureId,
				sectionsJson: JSON.stringify(framingRequestsFromStoredSections(sections)),
				sourceDataRevision: profile.source_data_revision ?? dataRevision,
				createdAt: now,
				updatedAt: now
			});
	}

	private repairFramingDraftIfProfileExists(captureId: string, dataRevision: number): void {
		const draft = this.database
			.prepare("SELECT 1 FROM framing_drafts WHERE capture_id = @captureId LIMIT 1")
			.get({ captureId });
		if (draft) return;
		const profile = this.database
			.prepare("SELECT 1 FROM framing_profiles WHERE capture_id = @captureId AND is_active = 1 LIMIT 1")
			.get({ captureId });
		if (profile) this.ensureFramingDraft(captureId, dataRevision);
	}

	createCapture(request: CreateCaptureRequest): CaptureState {
		const captureId = normalizedCaptureId(request, this.generateId);
		if (request.inputFormat !== "binary") {
			throw new CanonicalCaptureValidationError("inputFormat must be exactly binary", { inputFormat: request.inputFormat });
		}
		const framingSections = normalizeFramingSections(request.framing, this.generateId);
		const requestHash = captureCreationHash(request, captureId);
		const name = String(request.name ?? "Untitled capture");
		const description = String(request.description ?? "");
		const controllerView = String(request.controllerView ?? request.view ?? "");
		const baudRate = request.baudRate === undefined ? 115200 : optionalPositiveNumber(request.baudRate, "baudRate");
		const inputFormat = request.inputFormat;
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
					 VALUES (@id, @name, @description, @controllerView, @baudRate, @inputFormat, 'finalized', 0,
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
					`INSERT INTO framing_drafts (capture_id, revision, sections_json, updated_at)
					 VALUES (@captureId, 0, @sectionsJson, @updatedAt)`
				)
				.run({ captureId, sectionsJson: JSON.stringify(framingSections), updatedAt: now });
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
						raw_offsets_json, start_offset, end_offset, sequence_key, start_row, end_row, sequence_group_id,
						author_type, reported_client_name, reported_client_version, protocol_version
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
					authorType: note.author_type,
					...(note.reported_client_name ? { reportedClientName: note.reported_client_name } : {}),
					...(note.reported_client_version ? { reportedClientVersion: note.reported_client_version } : {}),
					...(note.protocol_version ? { protocolVersion: note.protocol_version } : {}),
					target: noteTargetFromRow(note)
				}))
		};
	}

	private readSession(captureId: string, sessionId: string): CaptureSessionState {
		const row = this.database
			.prepare(
				`SELECT capture_id, ordinal, id, status, first_received_at, last_received_at, started_at, finalized_at,
						next_chunk_sequence, next_raw_offset
				 FROM capture_sessions WHERE capture_id = @captureId AND id = @sessionId`
			)
			.get({ captureId, sessionId }) as
			| {
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
				}
			| undefined;
		if (!row) throw new CanonicalCaptureNotFoundError(`session ${sessionId} in capture ${captureId}`);
		return {
			captureId: row.capture_id,
			ordinal: row.ordinal,
			id: row.id,
			status: row.status,
			firstReceivedAt: row.first_received_at,
			lastReceivedAt: row.last_received_at,
			startedAt: row.started_at,
			finalizedAt: row.finalized_at,
			nextChunkSequence: row.next_chunk_sequence,
			nextRawOffset: row.next_raw_offset
		};
	}

	private assertSessionAppendCompleteness(
		captureId: string,
		sessionId: string,
		session: { next_chunk_sequence: number; next_raw_offset: number }
	): void {
		const requests = this.database
			.prepare(
				`SELECT sequence, expected_start_offset, accepted_start_offset, accepted_end_offset,
						next_raw_offset, next_sequence
				 FROM raw_chunk_requests
				 WHERE capture_id = @captureId AND session_id = @sessionId
				 ORDER BY sequence`
			)
			.all({ captureId, sessionId }) as Array<{
				sequence: number;
				expected_start_offset: number;
				accepted_start_offset: number;
				accepted_end_offset: number;
				next_raw_offset: number;
				next_sequence: number;
			}>;
		if (requests.length !== session.next_chunk_sequence) {
			throw new CanonicalCaptureConflictError("session chunk acknowledgements are incomplete", {
				captureId,
				sessionId,
				expectedSequence: session.next_chunk_sequence,
				actualSequence: requests.length,
				expectedStartOffset: session.next_raw_offset
			});
		}

		let previousNextOffset: number | undefined;
		for (const [index, request] of requests.entries()) {
			const expectedStartOffset = previousNextOffset ?? request.expected_start_offset;
			if (
				request.sequence !== index ||
				request.expected_start_offset !== expectedStartOffset ||
				request.accepted_start_offset !== expectedStartOffset ||
				request.accepted_end_offset <= request.accepted_start_offset ||
				request.next_raw_offset !== request.accepted_end_offset ||
				request.next_sequence !== index + 1
			) {
				throw new CanonicalCaptureConflictError("session chunk acknowledgements are not continuous", {
					captureId,
					sessionId,
					sequence: request.sequence,
					expectedSequence: index,
					actualSequence: request.sequence,
					expectedStartOffset,
					actualStartOffset: request.accepted_start_offset,
					nextRawOffset: request.next_raw_offset,
					nextSequence: request.next_sequence
				});
			}
			previousNextOffset = request.next_raw_offset;
		}
		if (previousNextOffset !== undefined && previousNextOffset !== session.next_raw_offset) {
			throw new CanonicalCaptureConflictError("session next raw offset is not acknowledged by its final chunk", {
				captureId,
				sessionId,
				expectedSequence: session.next_chunk_sequence,
				actualSequence: requests.length,
				expectedStartOffset: session.next_raw_offset,
				actualStartOffset: previousNextOffset
			});
		}

		const chunks = this.database
			.prepare(
				`SELECT start_offset, byte_count, session_id, session_ids_json
				 FROM raw_chunks WHERE capture_id = @captureId ORDER BY start_offset`
			)
			.all({ captureId }) as Array<{
				start_offset: number;
				byte_count: number;
				session_id: string | null;
				session_ids_json: string;
			}>;
		for (const request of requests) {
			let coveredOffset = request.accepted_start_offset;
			const coveringChunks = chunks.filter(chunk => {
				const end = chunk.start_offset + chunk.byte_count;
				return chunk.start_offset >= request.accepted_start_offset && chunk.start_offset < request.accepted_end_offset && end <= request.accepted_end_offset;
			});
			for (const chunk of coveringChunks) {
				if (chunk.start_offset !== coveredOffset) {
					throw new CanonicalCaptureConflictError("session raw chunks contain a gap or overlap", {
						captureId,
						sessionId,
						sequence: request.sequence,
						expectedSequence: request.sequence,
						actualSequence: request.sequence,
						expectedStartOffset: coveredOffset,
						actualStartOffset: chunk.start_offset
					});
				}
				const sessionIds = JSON.parse(chunk.session_ids_json || "[]") as Array<string | null>;
				if (chunk.session_id !== sessionId || sessionIds.some(value => value !== sessionId)) {
					throw new CanonicalCaptureConflictError("session raw chunk identity does not match its acknowledgement", {
						captureId,
						sessionId,
						sequence: request.sequence,
						chunkStartOffset: chunk.start_offset
					});
				}
				coveredOffset += chunk.byte_count;
			}
			if (coveredOffset !== request.accepted_end_offset) {
				throw new CanonicalCaptureConflictError("session acknowledgement has no complete raw chunk span", {
					captureId,
					sessionId,
					sequence: request.sequence,
					expectedSequence: request.sequence,
					actualSequence: request.sequence,
					expectedStartOffset: request.accepted_end_offset,
					actualStartOffset: coveredOffset
				});
			}
		}
	}

	private readRawStream(captureId: string, retainedStartOffset: number): Array<RawByteRecord & { rawOffset: number }> {
		const visibilityRows = this.database
			.prepare("SELECT raw_offset, hidden FROM raw_byte_visibility WHERE capture_id = @captureId")
			.all({ captureId }) as Array<{ raw_offset: number; hidden: number }>;
		const visibility = new Map(visibilityRows.map(row => [row.raw_offset, Boolean(row.hidden)]));
		const chunks = this.database
			.prepare(
				"SELECT bytes, timestamps_json, directions_json, hidden_json, start_offset, session_id, session_ids_json FROM raw_chunks WHERE capture_id = @captureId ORDER BY chunk_index"
			)
			.all({ captureId }) as Array<{
				bytes: Buffer;
				timestamps_json: string;
				directions_json: string;
				hidden_json: string;
				start_offset: number;
				session_id: string | null;
				session_ids_json: string;
			}>;
		const stream: Array<RawByteRecord & { rawOffset: number }> = [];
		for (const chunk of chunks) {
			const bytes = chunk.bytes instanceof Buffer ? [...chunk.bytes] : Array.from(new Uint8Array(chunk.bytes as unknown as Uint8Array));
			const timestamps = JSON.parse(chunk.timestamps_json) as number[];
			const directions = JSON.parse(chunk.directions_json) as string[];
			const hidden = JSON.parse(chunk.hidden_json) as boolean[];
			const sessionIds = JSON.parse(chunk.session_ids_json || "[]") as Array<string | null>;
			for (let index = 0; index < bytes.length; index++) {
				const rawOffset = chunk.start_offset + index;
				if (rawOffset < retainedStartOffset) continue;
				const sessionId = sessionIds[index] || chunk.session_id || undefined;
				stream.push({
					rawOffset,
					value: bytes[index],
					timestamp: Number(timestamps[index] ?? 0),
					direction: directions[index] || "rx",
					hidden: visibility.has(rawOffset) ? Boolean(visibility.get(rawOffset)) : Boolean(hidden[index]),
					...(sessionId ? { sessionId } : {})
				});
			}
		}
		return stream;
	}

	private readFramingSections(captureId: string, retainedStartOffset: number, stream: Array<RawByteRecord & { rawOffset: number }>): NormalizedSection[] {
		const draft = this.database
			.prepare("SELECT sections_json FROM framing_drafts WHERE capture_id = @captureId ORDER BY revision DESC LIMIT 1")
			.get({ captureId }) as { sections_json: string } | undefined;
		const rawSections = draft
			? (JSON.parse(draft.sections_json) as CaptureSection[])
			: ([{ start: retainedStartOffset, framingMode: "length", frameSize: 3 }] as CaptureSection[]);
		return normalizeSectionsForConversion(rawSections, stream, 3, this.generateId as () => string, retainedStartOffset)
			.map(section => ({ ...section, id: this.generateId() }));
	}

	private readFinalizationJob(jobId: string): FinalizationJobState {
		const row = this.database
			.prepare(
				`SELECT id, capture_id, session_id, profile_id, status, source_data_revision, verified, error, created_at, updated_at
				 FROM finalization_jobs WHERE id = @jobId`
			)
			.get({ jobId }) as
			| {
					id: string;
					capture_id: string;
					session_id: string | null;
					profile_id: string | null;
					status: string;
					source_data_revision: number | null;
					verified: number;
					error: string | null;
					created_at: string;
					updated_at: string;
				}
			| undefined;
		if (!row) throw new CanonicalCaptureNotFoundError(`finalization job ${jobId}`);
		return {
			id: row.id,
			captureId: row.capture_id,
			sessionId: row.session_id,
			profileId: row.profile_id,
			status: row.status,
			sourceDataRevision: row.source_data_revision,
			verified: Boolean(row.verified),
			error: row.error,
			createdAt: row.created_at,
			updatedAt: row.updated_at
		};
	}

	patchMetadata(_request: PatchMetadataRequest): CaptureState {
		const captureId = requiredString(_request.captureId, "captureId");
		if (!isRecord(_request.patch)) throw new CanonicalCaptureValidationError("metadata patch must be an object");
		const patch = _request.patch;
		const expectedRevision = _request.expectedMetadataRevision === undefined
			? undefined
			: nonNegativeInteger(_request.expectedMetadataRevision, "expectedMetadataRevision");
		const transaction = this.database.transaction(() => {
			const row = this.database
				.prepare(
					"SELECT name, description, controller_view, baud_rate, input_format, folder_id, metadata_revision FROM captures WHERE id = @captureId"
				)
				.get({ captureId }) as
				| {
						name: string;
						description: string;
						controller_view: string;
						baud_rate: number | null;
						input_format: string;
						folder_id: string | null;
						metadata_revision: number;
					}
				| undefined;
			if (!row) throw new CanonicalCaptureNotFoundError(captureId);
			this.requireCanonicalStorage(captureId);
			if (expectedRevision !== undefined && row.metadata_revision !== expectedRevision) {
				throw new CanonicalCaptureConflictError("metadata revision does not match", {
					captureId,
					expectedMetadataRevision: expectedRevision,
					actualMetadataRevision: row.metadata_revision
				});
			}

			const values: Record<string, unknown> = {
				name: row.name,
				description: row.description,
				controllerView: row.controller_view,
				baudRate: row.baud_rate,
				inputFormat: row.input_format,
				folderId: row.folder_id
			};
			if (Object.prototype.hasOwnProperty.call(patch, "name")) values.name = String(patch.name ?? "");
		if (Object.prototype.hasOwnProperty.call(patch, "description")) values.description = String(patch.description ?? "");
		if (Object.prototype.hasOwnProperty.call(patch, "controllerView") || Object.prototype.hasOwnProperty.call(patch, "view")) {
			values.controllerView = String(patch.controllerView ?? patch.view ?? "");
		}
		if (Object.prototype.hasOwnProperty.call(patch, "baudRate")) values.baudRate = optionalPositiveNumber(patch.baudRate, "baudRate");
		if (Object.prototype.hasOwnProperty.call(patch, "inputFormat")) {
			if (patch.inputFormat !== "binary") {
				throw new CanonicalCaptureValidationError("inputFormat must be exactly binary", { inputFormat: patch.inputFormat });
			}
			values.inputFormat = patch.inputFormat;
		}
		if (Object.prototype.hasOwnProperty.call(patch, "folderId")) values.folderId = optionalString(patch.folderId);

		this.database
			.prepare(
				`UPDATE captures
				 SET name = @name, description = @description, controller_view = @controllerView,
					 baud_rate = @baudRate, input_format = @inputFormat, folder_id = @folderId,
					 metadata_revision = metadata_revision + 1, updated_at = @updatedAt
				 WHERE id = @captureId`
			)
			.run({ ...values, captureId, updatedAt: this.nowIso() });

		if (Object.prototype.hasOwnProperty.call(patch, "parameters")) {
			const parameters = normalizedParameters(patch.parameters);
			this.database.prepare("DELETE FROM capture_parameters WHERE capture_id = @captureId").run({ captureId });
			const insertParameter = this.database.prepare(
				"INSERT INTO capture_parameters (capture_id, position, key_text, value_text) VALUES (@captureId, @position, @keyText, @valueText)"
			);
			parameters.forEach((parameter, position) =>
				insertParameter.run({ captureId, position, keyText: parameter.key, valueText: parameter.value })
			);
		}
		this.database
			.prepare("UPDATE capture_storage SET updated_at = @updatedAt WHERE capture_id = @captureId")
			.run({ captureId, updatedAt: this.nowIso() });
		});
		transaction();
		return this.getCaptureState(captureId);
	}

	startSession(request: StartSessionRequest): StartSessionResponse {
		const captureId = requiredString(request.captureId, "captureId");
		const requestedSessionId = request.sessionId === undefined ? undefined : requiredString(request.sessionId, "sessionId");
		const startedAt = isoFrom(request.startedAt, this.nowIso());
		const transaction = this.database.transaction(() => {
			const capture = this.database
				.prepare("SELECT byte_count, data_revision FROM captures WHERE id = @captureId")
				.get({ captureId }) as { byte_count: number; data_revision: number } | undefined;
			if (!capture) throw new CanonicalCaptureNotFoundError(captureId);
			this.requireCanonicalStorage(captureId);
			this.ensureFramingDraft(captureId, capture.data_revision);

			if (requestedSessionId) {
				const existing = this.database
					.prepare("SELECT id, status FROM capture_sessions WHERE capture_id = @captureId AND id = @sessionId")
					.get({ captureId, sessionId: requestedSessionId }) as { id: string; status: string } | undefined;
				if (existing) {
					if (existing.status === "recording") return { sessionId: existing.id, dataRevision: capture.data_revision };
					throw new CanonicalCaptureConflictError("session id has already been finalized", {
						captureId,
						sessionId: requestedSessionId,
						status: existing.status
					});
				}
			}

			const active = this.database
				.prepare(
					"SELECT id, status FROM capture_sessions WHERE capture_id = @captureId AND status IN ('recording','finalizing') ORDER BY ordinal DESC LIMIT 1"
				)
				.get({ captureId }) as { id: string; status: string } | undefined;
			if (active) {
				throw new CanonicalCaptureConflictError("capture already has an active recording session", {
					captureId,
					activeSessionId: active.id,
					activeSessionStatus: active.status
				});
			}
			const ordinalRow = this.database
				.prepare("SELECT COALESCE(MAX(ordinal), -1) AS ordinal FROM capture_sessions WHERE capture_id = @captureId")
				.get({ captureId }) as { ordinal: number };
			const offsetRow = this.database
				.prepare("SELECT COALESCE(MAX(next_raw_offset), 0) AS next_raw_offset FROM capture_sessions WHERE capture_id = @captureId")
				.get({ captureId }) as { next_raw_offset: number };
			const sessionId = requestedSessionId ?? requiredString(this.generateId(), "sessionId");
			const nextRawOffset = Math.max(capture.byte_count, offsetRow.next_raw_offset);
			this.database
				.prepare(
					`INSERT INTO capture_sessions
					 (capture_id, ordinal, id, status, started_at, finalized_at, next_chunk_sequence, next_raw_offset,
					  first_received_at, last_received_at)
					 VALUES (@captureId, @ordinal, @sessionId, 'recording', @startedAt, NULL, 0, @nextRawOffset, NULL, NULL)`
				)
				.run({
					captureId,
					ordinal: ordinalRow.ordinal + 1,
					sessionId,
					startedAt,
					nextRawOffset
				});
			const updatedAt = this.nowIso();
			this.database.prepare("UPDATE captures SET lifecycle = 'recording', updated_at = @updatedAt WHERE id = @captureId").run({ captureId, updatedAt });
			this.database
				.prepare("UPDATE capture_storage SET status = @status, updated_at = @updatedAt, last_error = NULL WHERE capture_id = @captureId")
				.run({ captureId, status: CANONICAL_STORAGE_STATUS, updatedAt });
			return { sessionId, dataRevision: capture.data_revision };
		});
		const result = transaction() as { sessionId: string; dataRevision: number };
		return {
			captureId,
			session: this.readSession(captureId, result.sessionId),
			dataRevision: result.dataRevision
		};
	}

	appendChunk(request: AppendChunkRequest): AppendChunkResponse {
		const captureId = requiredString(request.captureId, "captureId");
		const sessionId = requiredString(request.sessionId, "sessionId");
		const requestId = requiredString(request.requestId, "requestId");
		const sequence = nonNegativeInteger(request.sequence, "sequence");
		const expectedStartOffset = nonNegativeInteger(request.expectedStartOffset, "expectedStartOffset");
		const expectedDataRevision = request.expectedDataRevision === undefined
			? undefined
			: nonNegativeInteger(request.expectedDataRevision, "expectedDataRevision");
		const flattened = flattenChunkPayload(request);
		if (flattened.sessionIds.some(value => value !== null && value !== sessionId)) {
			throw new CanonicalCaptureValidationError("segment session id must match request session id", { sessionId });
		}
		flattened.sessionIds = flattened.sessionIds.map(() => sessionId);
		const payloadHash = appendSemanticHash(captureId, sessionId, sequence, expectedStartOffset, flattened);
		const transaction = this.database.transaction(() => {
			const existingRequest = this.database
				.prepare(
					`SELECT request_id, session_id, sequence, expected_start_offset, payload_hash,
							accepted_start_offset, accepted_end_offset, next_raw_offset, next_sequence, data_revision
					 FROM raw_chunk_requests WHERE capture_id = @captureId AND request_id = @requestId`
				)
				.get({ captureId, requestId }) as
				| {
						request_id: string;
						session_id: string;
						sequence: number;
						expected_start_offset: number;
						payload_hash: string;
						accepted_start_offset: number;
						accepted_end_offset: number;
						next_raw_offset: number;
						next_sequence: number;
						data_revision: number;
					}
				| undefined;
			if (existingRequest) {
				if (existingRequest.payload_hash !== payloadHash) {
					throw new CanonicalCaptureIdempotencyConflictError("append request id was reused with a different payload", {
						captureId,
						requestId,
						existingPayloadHash: existingRequest.payload_hash,
						payloadHash,
						existingSessionId: existingRequest.session_id,
						existingSequence: existingRequest.sequence,
						existingExpectedStartOffset: existingRequest.expected_start_offset,
						requestedSessionId: sessionId,
						requestedSequence: sequence,
						requestedExpectedStartOffset: expectedStartOffset
					});
				}
				return {
					captureId,
					sessionId: existingRequest.session_id,
					requestId,
					sequence: existingRequest.sequence,
					payloadHash,
					acceptedStartOffset: existingRequest.accepted_start_offset,
					acceptedEndOffset: existingRequest.accepted_end_offset,
						nextRawOffset: existingRequest.next_raw_offset,
						nextSequence: existingRequest.next_sequence,
						dataRevision: existingRequest.data_revision
				} satisfies AppendChunkResponse;
			}

			const capture = this.database
				.prepare("SELECT byte_count, data_revision, retained_start_offset FROM captures WHERE id = @captureId")
				.get({ captureId }) as { byte_count: number; data_revision: number; retained_start_offset: number } | undefined;
			if (!capture) throw new CanonicalCaptureNotFoundError(captureId);
			this.requireCanonicalStorage(captureId);
			if (expectedDataRevision !== undefined && expectedDataRevision !== capture.data_revision) {
				throw new CanonicalCaptureConflictError("data revision does not match", {
					captureId,
					expectedDataRevision,
					actualDataRevision: capture.data_revision
				});
			}
			const session = this.database
				.prepare(
					"SELECT status, next_chunk_sequence, next_raw_offset, first_received_at, last_received_at FROM capture_sessions WHERE capture_id = @captureId AND id = @sessionId"
				)
				.get({ captureId, sessionId }) as
				| {
						status: string;
						next_chunk_sequence: number;
						next_raw_offset: number;
						first_received_at: number | null;
						last_received_at: number | null;
					}
				| undefined;
			if (!session) throw new CanonicalCaptureNotFoundError(`session ${sessionId} in capture ${captureId}`);
			if (session.status !== "recording") {
				throw new CanonicalCaptureConflictError("session is not recording", { captureId, sessionId, status: session.status });
			}
			const expectedSequenceMatches = session.next_chunk_sequence === sequence;
			const expectedOffsetMatches = session.next_raw_offset === expectedStartOffset;
			if (!expectedSequenceMatches || !expectedOffsetMatches) {
				throw new CanonicalCaptureConflictError("append sequence or offset does not match durable session state", {
					captureId,
					sessionId,
					expectedSequence: session.next_chunk_sequence,
					actualSequence: sequence,
					expectedStartOffset: session.next_raw_offset,
					actualStartOffset: expectedStartOffset
				});
			}

			const acceptedStartOffset = expectedStartOffset;
			const acceptedEndOffset = acceptedStartOffset + flattened.bytes.length;
			const nextRawOffset = acceptedEndOffset;
			const nextSequence = sequence + 1;
			const chunkIndexRow = this.database
				.prepare("SELECT COALESCE(MAX(chunk_index), -1) AS chunk_index FROM raw_chunks WHERE capture_id = @captureId")
				.get({ captureId }) as { chunk_index: number };
			this.database
				.prepare(
					`INSERT INTO raw_chunks
					 (capture_id, chunk_index, start_offset, byte_count, bytes, timestamps_json, directions_json,
					  hidden_json, session_id, session_ids_json)
					 VALUES (@captureId, @chunkIndex, @startOffset, @byteCount, @bytes, @timestampsJson,
					  @directionsJson, @hiddenJson, @sessionId, @sessionIdsJson)`
				)
				.run({
					captureId,
					chunkIndex: chunkIndexRow.chunk_index + 1,
					startOffset: acceptedStartOffset,
					byteCount: flattened.bytes.length,
					bytes: flattened.bytes,
					timestampsJson: JSON.stringify(flattened.timestamps),
					directionsJson: JSON.stringify(flattened.directions),
					hiddenJson: JSON.stringify(Array.from({ length: flattened.bytes.length }, () => false)),
					sessionId,
					sessionIdsJson: JSON.stringify(flattened.sessionIds)
				});
			const nextDataRevision = capture.data_revision + 1;
			const retainedStartOffset = Math.max(capture.retained_start_offset, Math.max(0, nextRawOffset - CANONICAL_RETENTION_LIMIT));
			let clearedRetainedNotes = 0;
			if (retainedStartOffset > capture.retained_start_offset) {
				clearedRetainedNotes = this.pruneStableNotesOutsideRetainedWindow(captureId, retainedStartOffset);
			}
			const receivedTimestamps = flattened.timestamps.filter((_, index) => flattened.directions[index] !== "tx");
			const firstReceivedAt = receivedTimestamps.length
				? Math.min(session.first_received_at ?? Number.POSITIVE_INFINITY, ...receivedTimestamps)
				: session.first_received_at;
			const lastReceivedAt = receivedTimestamps.length
				? Math.max(session.last_received_at ?? Number.NEGATIVE_INFINITY, ...receivedTimestamps)
				: session.last_received_at;
			this.database
				.prepare(
					`INSERT INTO raw_chunk_requests
					 (capture_id, request_id, session_id, sequence, expected_start_offset, payload_hash,
					  accepted_start_offset, accepted_end_offset, next_raw_offset, next_sequence, data_revision, created_at)
					 VALUES (@captureId, @requestId, @sessionId, @sequence, @expectedStartOffset, @payloadHash,
					  @acceptedStartOffset, @acceptedEndOffset, @nextRawOffset, @nextSequence, @dataRevision, @createdAt)`
				)
				.run({
					captureId,
					requestId,
					sessionId,
					sequence,
					expectedStartOffset,
					payloadHash,
					acceptedStartOffset,
					acceptedEndOffset,
					nextRawOffset,
					nextSequence,
					dataRevision: nextDataRevision,
					createdAt: this.nowIso()
				});
			this.database
				.prepare(
					`UPDATE capture_sessions
					 SET next_chunk_sequence = @nextSequence, next_raw_offset = @nextRawOffset,
						 first_received_at = @firstReceivedAt, last_received_at = @lastReceivedAt
					 WHERE capture_id = @captureId AND id = @sessionId`
				)
				.run({ captureId, sessionId, nextSequence, nextRawOffset, firstReceivedAt, lastReceivedAt });
			this.database
				.prepare(
					`UPDATE captures
					 SET byte_count = byte_count + @byteCount, data_revision = @dataRevision,
						 retained_start_offset = @retainedStartOffset,
						 content_revision = content_revision + CASE WHEN @clearedRetainedNotes > 0 THEN 1 ELSE 0 END,
						 updated_at = @updatedAt
					 WHERE id = @captureId`
				)
				.run({ captureId, byteCount: flattened.bytes.length, dataRevision: nextDataRevision, retainedStartOffset, clearedRetainedNotes, updatedAt: this.nowIso() });
			this.database
				.prepare("UPDATE capture_storage SET updated_at = @updatedAt, last_error = NULL WHERE capture_id = @captureId")
				.run({ captureId, updatedAt: this.nowIso() });
			return {
				captureId,
				sessionId,
				requestId,
				sequence,
				payloadHash,
				acceptedStartOffset,
				acceptedEndOffset,
					nextRawOffset,
					nextSequence,
					dataRevision: nextDataRevision
			} satisfies AppendChunkResponse;
		});
		return transaction() as AppendChunkResponse;
	}

	finalizeSession(request: FinalizeSessionRequest): FinalizeSessionResponse {
		const captureId = requiredString(request.captureId, "captureId");
		const sessionId = requiredString(request.sessionId, "sessionId");
		const expectedDataRevision = request.expectedDataRevision === undefined
			? undefined
			: nonNegativeInteger(request.expectedDataRevision, "expectedDataRevision");
		const preparation = this.database.transaction(() => {
			const capture = this.database
				.prepare("SELECT data_revision, retained_start_offset FROM captures WHERE id = @captureId")
				.get({ captureId }) as { data_revision: number; retained_start_offset: number } | undefined;
			if (!capture) throw new CanonicalCaptureNotFoundError(captureId);
			this.requireCanonicalStorage(captureId);
			if (expectedDataRevision !== undefined && expectedDataRevision !== capture.data_revision) {
				throw new CanonicalCaptureConflictError("data revision does not match", {
					captureId,
					expectedDataRevision,
					actualDataRevision: capture.data_revision
				});
			}
			const session = this.database
				.prepare(
					"SELECT status, next_chunk_sequence, next_raw_offset FROM capture_sessions WHERE capture_id = @captureId AND id = @sessionId"
				)
				.get({ captureId, sessionId }) as
				| { status: string; next_chunk_sequence: number; next_raw_offset: number }
				| undefined;
			if (!session) throw new CanonicalCaptureNotFoundError(`session ${sessionId} in capture ${captureId}`);
			if (session.status === "finalized") {
				const completed = this.database
					.prepare(
						`SELECT id, profile_id FROM finalization_jobs
						 WHERE capture_id = @captureId AND session_id = @sessionId AND status = 'completed' AND verified = 1
						 ORDER BY updated_at DESC LIMIT 1`
					)
					.get({ captureId, sessionId }) as { id: string; profile_id: string | null } | undefined;
				if (!completed?.profile_id) {
					throw new CanonicalCaptureConflictError("session is already finalized without a verified finalization job", { captureId, sessionId });
				}
				const profile = this.database
					.prepare("SELECT version FROM framing_profiles WHERE id = @profileId")
					.get({ profileId: completed.profile_id }) as { version: number } | undefined;
				if (!profile) throw new CanonicalCaptureConflictError("completed finalization profile is missing", { captureId, sessionId });
				return {
					captureId,
					sessionId,
					dataRevision: capture.data_revision,
					retainedStartOffset: capture.retained_start_offset,
					profileId: completed.profile_id,
					profileVersion: profile.version,
					jobId: completed.id,
					idempotent: true
				};
			}
			if (!["recording", "stopped", "failed", "finalizing"].includes(session.status)) {
				throw new CanonicalCaptureConflictError("session cannot be finalized from its current state", { captureId, sessionId, status: session.status });
			}
			this.assertSessionAppendCompleteness(captureId, sessionId, session);
			const profileVersionRow = this.database
				.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM framing_profiles WHERE capture_id = @captureId")
				.get({ captureId }) as { version: number };
			const profileVersion = profileVersionRow.version + 1;
			const profileId = requiredString(this.generateId(), "profileId");
			const now = this.nowIso();
			const existingJob = this.database
				.prepare(
					`SELECT id, status, profile_id
					 FROM finalization_jobs
					 WHERE capture_id = @captureId AND session_id = @sessionId
					   AND source_data_revision = @sourceDataRevision
					 ORDER BY updated_at DESC LIMIT 1`
				)
				.get({ captureId, sessionId, sourceDataRevision: capture.data_revision }) as
				| { id: string; status: string; profile_id: string | null }
				| undefined;
			const jobId = existingJob?.id ?? requiredString(this.generateId(), "finalizationJobId");
			if (existingJob) {
				if (existingJob.status === "completed" && existingJob.profile_id) {
					const profile = this.database
						.prepare("SELECT version, verified FROM framing_profiles WHERE id = @profileId")
						.get({ profileId: existingJob.profile_id }) as { version: number; verified: number } | undefined;
					if (profile?.verified) {
						return {
							captureId,
							sessionId,
							dataRevision: capture.data_revision,
							retainedStartOffset: capture.retained_start_offset,
							profileId: existingJob.profile_id,
							profileVersion: profile.version,
							jobId,
							idempotent: true
						};
					}
				}
				this.database
					.prepare(
						`UPDATE finalization_jobs
						 SET status = 'pending', profile_id = NULL, updated_at = @updatedAt,
							 error = NULL, verified = 0
						 WHERE id = @jobId`
					)
					.run({ jobId, updatedAt: now });
			} else {
				this.database
					.prepare(
						`INSERT INTO finalization_jobs
						 (id, capture_id, session_id, profile_id, source_data_revision, status, created_at, updated_at, error, verified)
						 VALUES (@id, @captureId, @sessionId, NULL, @sourceDataRevision, 'pending', @createdAt, @updatedAt, NULL, 0)`
					)
					.run({ id: jobId, captureId, sessionId, sourceDataRevision: capture.data_revision, createdAt: now, updatedAt: now });
			}
			this.database
				.prepare("UPDATE finalization_jobs SET status = 'running', updated_at = @updatedAt WHERE id = @jobId")
				.run({ jobId, updatedAt: this.nowIso() });
			this.database
				.prepare("UPDATE capture_sessions SET status = 'finalizing', finalized_at = NULL WHERE capture_id = @captureId AND id = @sessionId")
				.run({ captureId, sessionId });
			this.database
				.prepare("UPDATE captures SET lifecycle = 'stopped', updated_at = @updatedAt WHERE id = @captureId")
				.run({ captureId, updatedAt: this.nowIso() });
			return {
				captureId,
				sessionId,
				dataRevision: capture.data_revision,
				retainedStartOffset: capture.retained_start_offset,
				profileId,
				profileVersion,
				jobId,
				idempotent: false
			};
		});

		const prepared = preparation() as {
			captureId: string;
			sessionId: string;
			dataRevision: number;
			retainedStartOffset: number;
			profileId: string;
			profileVersion: number;
			jobId: string;
			idempotent: boolean;
		};
		if (prepared.idempotent) {
			return {
				captureId,
				session: this.readSession(captureId, sessionId),
				profileId: prepared.profileId,
				profileVersion: prepared.profileVersion,
				dataRevision: prepared.dataRevision,
				retainedStartOffset: prepared.retainedStartOffset,
				job: this.readFinalizationJob(prepared.jobId),
				idempotent: true
			};
		}

		try {
			const stream = this.readRawStream(captureId, prepared.retainedStartOffset);
			const sections = this.readFramingSections(captureId, prepared.retainedStartOffset, stream);
			const materialization = buildCanonicalMaterialization(stream, sections, { generateId: this.generateId });
			const activation = this.database.transaction(() => {
				const capture = this.database
					.prepare("SELECT data_revision, retained_start_offset FROM captures WHERE id = @captureId")
					.get({ captureId }) as { data_revision: number; retained_start_offset: number } | undefined;
				if (!capture) throw new CanonicalCaptureNotFoundError(captureId);
				this.requireCanonicalStorage(captureId);
				if (capture.data_revision !== prepared.dataRevision || capture.retained_start_offset !== prepared.retainedStartOffset) {
					throw new CanonicalCaptureConflictError("capture changed while finalization was materializing", {
						captureId,
						sourceDataRevision: prepared.dataRevision,
						actualDataRevision: capture.data_revision,
						sourceRetainedStartOffset: prepared.retainedStartOffset,
						actualRetainedStartOffset: capture.retained_start_offset
					});
				}
				const session = this.database
					.prepare("SELECT status FROM capture_sessions WHERE capture_id = @captureId AND id = @sessionId")
					.get({ captureId, sessionId }) as { status: string } | undefined;
				if (!session || session.status !== "finalizing") throw new CanonicalCaptureConflictError("session is no longer finalizing", { captureId, sessionId });
				const now = this.nowIso();
				// The profile snapshot includes lifecycle. Finalization commits the
				// capture as finalized below, so make that state visible before the
				// profile metadata trigger captures its immutable values.
				this.database.prepare("UPDATE captures SET lifecycle = 'finalized' WHERE id = @captureId").run({ captureId });
				this.database
					.prepare(
						`INSERT INTO framing_profiles
						 (id, capture_id, version, algorithm_version, is_active, created_at, updated_at,
						  source_data_revision, retained_start_offset, verified)
						 VALUES (@id, @captureId, @version, 1, 0, @createdAt, @updatedAt,
						  @sourceDataRevision, @retainedStartOffset, 0)`
					)
					.run({
						id: prepared.profileId,
						captureId,
						version: prepared.profileVersion,
						createdAt: now,
						updatedAt: now,
						sourceDataRevision: prepared.dataRevision,
						retainedStartOffset: prepared.retainedStartOffset
					});
				persistCanonicalMaterializationRows(this.database, captureId, prepared.profileId, prepared.profileVersion, materialization, this.generateId);
				const verification = verifyCanonicalMaterializationRows(this.database, prepared.profileId, materialization);
				if (!verification.ok) throw new CanonicalCaptureCommandError("STORAGE_ERROR", verification.details || "canonical materialization verification failed", { captureId });
				this.database
					.prepare("UPDATE framing_profiles SET verified = 1, updated_at = @updatedAt WHERE id = @profileId")
					.run({ profileId: prepared.profileId, updatedAt: now });
				this.database.prepare("UPDATE framing_profiles SET is_active = 0 WHERE capture_id = @captureId").run({ captureId });
				this.database.prepare("UPDATE framing_profiles SET is_active = 1 WHERE id = @profileId").run({ profileId: prepared.profileId });
				this.database
					.prepare("UPDATE captures SET active_framing_profile_id = @profileId, lifecycle = 'finalized', updated_at = @updatedAt WHERE id = @captureId")
					.run({ captureId, profileId: prepared.profileId, updatedAt: now });
				this.database
					.prepare("UPDATE capture_sessions SET status = 'finalized', finalized_at = @finalizedAt WHERE capture_id = @captureId AND id = @sessionId")
					.run({ captureId, sessionId, finalizedAt: now });
				this.database
					.prepare(
						"UPDATE finalization_jobs SET status = 'completed', profile_id = @profileId, updated_at = @updatedAt, error = NULL, verified = 1 WHERE id = @jobId"
					)
					.run({ jobId: prepared.jobId, profileId: prepared.profileId, updatedAt: now });
				this.database
					.prepare("UPDATE capture_storage SET status = @status, updated_at = @updatedAt, last_error = NULL WHERE capture_id = @captureId")
					.run({ captureId, status: CANONICAL_STORAGE_STATUS, updatedAt: now });
			});
			activation();
			return {
				captureId,
				session: this.readSession(captureId, sessionId),
				profileId: prepared.profileId,
				profileVersion: prepared.profileVersion,
				dataRevision: prepared.dataRevision,
				retainedStartOffset: prepared.retainedStartOffset,
				job: this.readFinalizationJob(prepared.jobId),
				idempotent: false
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const markFailed = this.database.transaction(() => {
				this.database
					.prepare("UPDATE finalization_jobs SET status = 'failed', updated_at = @updatedAt, error = @error, verified = 0 WHERE id = @jobId")
					.run({ jobId: prepared.jobId, updatedAt: this.nowIso(), error: message });
				this.database
					.prepare("UPDATE capture_sessions SET status = 'failed' WHERE capture_id = @captureId AND id = @sessionId")
					.run({ captureId, sessionId });
				this.database
					.prepare("UPDATE captures SET lifecycle = 'stopped', updated_at = @updatedAt WHERE id = @captureId")
					.run({ captureId, updatedAt: this.nowIso() });
				this.database
					.prepare("UPDATE capture_storage SET updated_at = @updatedAt, last_error = @error WHERE capture_id = @captureId")
					.run({ captureId, updatedAt: this.nowIso(), error: message });
			});
			try {
				markFailed();
			} catch {
				// Preserve the original materialization error if failure bookkeeping is unavailable.
			}
			if (error instanceof CanonicalCaptureCommandError) throw error;
			throw new CanonicalCaptureCommandError("STORAGE_ERROR", message, { captureId, sessionId });
		}
	}

	updateFramingDraft(request: UpdateFramingDraftRequest): UpdateFramingDraftResponse {
		const captureId = requiredString(request.captureId, "captureId");
		const expectedRevision = request.expectedRevision === undefined
			? undefined
			: nonNegativeInteger(request.expectedRevision, "expectedRevision");
		const sections = normalizeFramingSections(request.sections, this.generateId);
		const transaction = this.database.transaction(() => {
			const capture = this.database
				.prepare("SELECT lifecycle, data_revision FROM captures WHERE id = @captureId")
				.get({ captureId }) as { lifecycle: string; data_revision: number } | undefined;
			if (!capture) throw new CanonicalCaptureNotFoundError(captureId);
			this.requireCanonicalStorage(captureId);
			if (capture.lifecycle !== "recording") {
				throw new CanonicalCaptureConflictError("framing drafts can only be updated while recording", {
					captureId,
					lifecycle: capture.lifecycle
				});
			}
			this.ensureFramingDraft(captureId, capture.data_revision);

			const draft = this.database
				.prepare("SELECT revision FROM framing_drafts WHERE capture_id = @captureId ORDER BY revision DESC LIMIT 1")
				.get({ captureId }) as { revision: number } | undefined;
			if (!draft) throw new CanonicalCaptureConflictError("framing draft is missing", { captureId });
			if (expectedRevision !== undefined && draft.revision !== expectedRevision) {
				throw new CanonicalCaptureConflictError("framing draft revision does not match", {
					captureId,
					expectedRevision,
					actualRevision: draft.revision
				});
			}

			const revision = draft.revision + 1;
			const updatedAt = this.nowIso();
			this.database
				.prepare(
					`INSERT INTO framing_drafts (capture_id, revision, sections_json, updated_at)
					 VALUES (@captureId, @revision, @sectionsJson, @updatedAt)`
				)
				.run({ captureId, revision, sectionsJson: JSON.stringify(sections), updatedAt });
			return { captureId, revision, sections, updatedAt };
		});
		return transaction() as UpdateFramingDraftResponse;
	}

	reframe(request: ReframeRequest): ReframeResponse {
		const captureId = requiredString(request.captureId, "captureId");
		if (request.expectedActiveProfileId === undefined || request.expectedActiveProfileId === null) {
			throw new CanonicalCaptureValidationError("expectedActiveProfileId is required", {
				captureId,
				expectedActiveProfileId: request.expectedActiveProfileId ?? null
			});
		}
		const expectedActiveProfileId = requiredString(request.expectedActiveProfileId, "expectedActiveProfileId");
		const expectedDataRevision = nonNegativeInteger(request.expectedDataRevision, "expectedDataRevision");
		const algorithmVersion = request.algorithmVersion === undefined
			? 1
			: nonNegativeInteger(request.algorithmVersion, "algorithmVersion");
		if (!Array.isArray(request.sections)) throw new CanonicalCaptureValidationError("framing sections are required");
		const requestedSections = normalizeFramingSections(
			request.sections.map(section => ({ ...section, id: undefined })),
			this.generateId,
			false
		);

		const preparation = this.database.transaction(() => {
			const capture = this.database
				.prepare(
					"SELECT data_revision, retained_start_offset, lifecycle, active_framing_profile_id FROM captures WHERE id = @captureId"
				)
				.get({ captureId }) as
				| {
						data_revision: number;
						retained_start_offset: number;
						lifecycle: string;
						active_framing_profile_id: string | null;
					}
				| undefined;
			if (!capture) throw new CanonicalCaptureNotFoundError(captureId);
			this.requireCanonicalStorage(captureId);
			if (capture.lifecycle !== "finalized") {
				throw new CanonicalCaptureConflictError("capture must be finalized before reframing", {
					captureId,
					lifecycle: capture.lifecycle
				});
			}
			if (capture.data_revision !== expectedDataRevision) {
				throw new CanonicalCaptureConflictError("data revision does not match", {
					captureId,
					expectedDataRevision,
					actualDataRevision: capture.data_revision
				});
			}
			if (capture.active_framing_profile_id !== expectedActiveProfileId) {
				throw new CanonicalCaptureConflictError("active framing profile does not match", {
					captureId,
					expectedActiveProfileId,
					actualActiveProfileId: capture.active_framing_profile_id,
					expectedDataRevision,
					actualDataRevision: capture.data_revision
				});
			}

			const activeProfile = this.database
				.prepare("SELECT version, is_active, verified FROM framing_profiles WHERE id = @profileId AND capture_id = @captureId")
				.get({ captureId, profileId: expectedActiveProfileId }) as
				| { version: number; is_active: number; verified: number }
				| undefined;
			if (!activeProfile || !activeProfile.is_active || !activeProfile.verified) {
				throw new CanonicalCaptureConflictError("expected active framing profile is not verified and active", {
					captureId,
					expectedActiveProfileId
				});
			}
			const versionRow = this.database
				.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM framing_profiles WHERE capture_id = @captureId")
				.get({ captureId }) as { version: number };
			return {
				dataRevision: capture.data_revision,
				retainedStartOffset: capture.retained_start_offset,
				activeProfileVersion: activeProfile.version,
				profileVersion: versionRow.version + 1,
				profileId: requiredString(this.generateId(), "profileId")
			};
		});

		const prepared = preparation() as {
			dataRevision: number;
			retainedStartOffset: number;
			activeProfileVersion: number;
			profileVersion: number;
			profileId: string;
		};
		const stream = this.readRawStream(captureId, prepared.retainedStartOffset);
		const sections = normalizeSectionsForConversion(
			requestedSections as CaptureSection[],
			stream,
			3,
			this.generateId,
			prepared.retainedStartOffset
		).map(section => ({ ...section, id: requiredString(this.generateId(), "sectionId") }));
		const materialization = buildCanonicalMaterialization(stream, sections, { generateId: this.generateId });

		const activation = this.database.transaction(() => {
			const capture = this.database
				.prepare(
					"SELECT data_revision, retained_start_offset, lifecycle, active_framing_profile_id FROM captures WHERE id = @captureId"
				)
				.get({ captureId }) as
				| {
						data_revision: number;
						retained_start_offset: number;
						lifecycle: string;
						active_framing_profile_id: string | null;
					}
				| undefined;
			if (!capture) throw new CanonicalCaptureNotFoundError(captureId);
			this.requireCanonicalStorage(captureId);
			if (
				capture.lifecycle !== "finalized" ||
				capture.data_revision !== prepared.dataRevision ||
				capture.retained_start_offset !== prepared.retainedStartOffset ||
				capture.active_framing_profile_id !== expectedActiveProfileId
			) {
				throw new CanonicalCaptureConflictError("capture changed while reframing was materializing", {
					captureId,
					expectedActiveProfileId,
					actualActiveProfileId: capture.active_framing_profile_id,
					expectedDataRevision: prepared.dataRevision,
					actualDataRevision: capture.data_revision,
					expectedRetainedStartOffset: prepared.retainedStartOffset,
					actualRetainedStartOffset: capture.retained_start_offset
				});
			}
			const activeProfile = this.database
				.prepare("SELECT version, is_active, verified FROM framing_profiles WHERE id = @profileId AND capture_id = @captureId")
				.get({ captureId, profileId: expectedActiveProfileId }) as
				| { version: number; is_active: number; verified: number }
				| undefined;
			const versionRow = this.database
				.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM framing_profiles WHERE capture_id = @captureId")
				.get({ captureId }) as { version: number };
			if (
				!activeProfile ||
				!activeProfile.is_active ||
				!activeProfile.verified ||
				activeProfile.version !== prepared.activeProfileVersion ||
				versionRow.version + 1 !== prepared.profileVersion
			) {
				throw new CanonicalCaptureConflictError("active framing profile changed while reframing was materializing", {
					captureId,
					expectedActiveProfileId,
					expectedActiveProfileVersion: prepared.activeProfileVersion,
					actualActiveProfileVersion: activeProfile?.version ?? null
				});
			}

			const now = this.nowIso();
			this.database
				.prepare(
					`INSERT INTO framing_profiles
					 (id, capture_id, version, algorithm_version, is_active, created_at, updated_at,
					  source_data_revision, retained_start_offset, verified)
					 VALUES (@id, @captureId, @version, @algorithmVersion, 0, @createdAt, @updatedAt,
					  @sourceDataRevision, @retainedStartOffset, 0)`
				)
				.run({
					id: prepared.profileId,
					captureId,
					version: prepared.profileVersion,
					algorithmVersion,
					createdAt: now,
					updatedAt: now,
					sourceDataRevision: prepared.dataRevision,
					retainedStartOffset: prepared.retainedStartOffset
				});
			persistCanonicalMaterializationRows(
				this.database,
				captureId,
				prepared.profileId,
				prepared.profileVersion,
				materialization,
				this.generateId
			);
			const verification = verifyCanonicalMaterializationRows(this.database, prepared.profileId, materialization);
			if (!verification.ok) {
				throw new CanonicalCaptureCommandError(
					"STORAGE_ERROR",
					verification.details || "canonical materialization verification failed",
					{ captureId, profileId: prepared.profileId }
				);
			}
			this.database
				.prepare("UPDATE framing_profiles SET verified = 1, updated_at = @updatedAt WHERE id = @profileId")
				.run({ profileId: prepared.profileId, updatedAt: now });
			this.database.prepare("UPDATE framing_profiles SET is_active = 0 WHERE capture_id = @captureId").run({ captureId });
			this.database.prepare("UPDATE framing_profiles SET is_active = 1 WHERE id = @profileId").run({ profileId: prepared.profileId });
			this.database
				.prepare("UPDATE captures SET active_framing_profile_id = @profileId, updated_at = @updatedAt WHERE id = @captureId")
				.run({ captureId, profileId: prepared.profileId, updatedAt: now });
		});

		try {
			activation();
		} catch (error) {
			if (error instanceof CanonicalCaptureCommandError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new CanonicalCaptureCommandError("STORAGE_ERROR", message, { captureId, profileId: prepared.profileId });
		}
		return {
			captureId,
			profileId: prepared.profileId,
			version: prepared.profileVersion,
			sourceDataRevision: prepared.dataRevision,
			retainedStartOffset: prepared.retainedStartOffset,
			verified: true
		};
	}

	/**
	 * Persist section presentation state without creating a new framing profile.
	 * Collapse state changes the way an acknowledged profile is displayed, not
	 * the raw spans or the identities of its frames.
	 */
	updateFramingSectionView(request: FramingSectionViewRequest): FramingSectionViewResponse {
		const captureId = requiredString(request.captureId, "captureId");
		const profileId = requiredString(request.profileId, "profileId");
		const sectionId = requiredString(request.sectionId, "sectionId");
		if (request.collapseRuns === undefined && request.collapsed === undefined) {
			throw new CanonicalCaptureValidationError("section view state must include collapseRuns or collapsed", {
				captureId,
				profileId,
				sectionId
			});
		}

		const transaction = this.database.transaction(() => {
			const capture = this.database
				.prepare(
					"SELECT lifecycle, active_framing_profile_id FROM captures WHERE id = @captureId"
				)
				.get({ captureId }) as
				| { lifecycle: string; active_framing_profile_id: string | null }
				| undefined;
			if (!capture) throw new CanonicalCaptureNotFoundError(captureId);
			this.requireCanonicalStorage(captureId);
			if (capture.lifecycle !== "finalized") {
				throw new CanonicalCaptureConflictError("section view state can only be updated for a finalized capture", {
					captureId,
					lifecycle: capture.lifecycle
				});
			}
			if (capture.active_framing_profile_id !== profileId) {
				throw new CanonicalCaptureConflictError("active framing profile does not match", {
					captureId,
					expectedActiveProfileId: profileId,
					actualActiveProfileId: capture.active_framing_profile_id
				});
			}

			const section = this.database
				.prepare(
					`SELECT position, start_offset, collapse_runs, collapsed
					 FROM framing_sections
					 WHERE id = @sectionId AND capture_id = @captureId AND profile_id = @profileId`
				)
				.get({ captureId, profileId, sectionId }) as
				| { position: number; start_offset: number; collapse_runs: number; collapsed: number }
				| undefined;
			if (!section) throw new CanonicalCaptureNotFoundError(`${captureId}/sections/${sectionId}`);

			const collapseRuns = request.collapseRuns === undefined
				? Boolean(section.collapse_runs)
				: Boolean(request.collapseRuns);
			const collapsed = request.collapsed === undefined
				? Boolean(section.collapsed)
				: Boolean(request.collapsed);
			this.database
				.prepare(
					`UPDATE framing_sections
					 SET collapse_runs = @collapseRuns, collapsed = @collapsed
					 WHERE id = @sectionId AND capture_id = @captureId AND profile_id = @profileId`
				)
				.run({ captureId, profileId, sectionId, collapseRuns: collapseRuns ? 1 : 0, collapsed: collapsed ? 1 : 0 });

			// Keep the next recording draft aligned with the acknowledged view state.
			// Draft section IDs are intentionally not trusted as canonical identities,
			// so use the active profile's stable position/start when updating it.
			const draft = this.database
				.prepare(
					"SELECT revision, sections_json FROM framing_drafts WHERE capture_id = @captureId ORDER BY revision DESC LIMIT 1"
				)
				.get({ captureId }) as { revision: number; sections_json: string } | undefined;
			if (draft) {
				const sections = JSON.parse(draft.sections_json) as unknown;
				if (Array.isArray(sections)) {
					const matchesSectionStart = (candidate: unknown): candidate is Record<string, unknown> => {
						if (!isRecord(candidate)) return false;
						const normalizedStart = Number(candidate.start);
						return Number.isSafeInteger(normalizedStart) && normalizedStart >= 0 && normalizedStart === section.start_offset;
					};
					const positionalCandidate = sections[section.position];
					const draftSection = matchesSectionStart(positionalCandidate)
						? positionalCandidate
						: sections.find(matchesSectionStart);
					if (draftSection) {
						draftSection.collapseRuns = collapseRuns;
						draftSection.collapsed = collapsed;
						this.database
							.prepare(
								"UPDATE framing_drafts SET sections_json = @sectionsJson, updated_at = @updatedAt WHERE capture_id = @captureId AND revision = @revision"
							)
							.run({ captureId, revision: draft.revision, sectionsJson: JSON.stringify(sections), updatedAt: this.nowIso() });
					}
				}
			}

			return {
				collapseRuns,
				collapsed,
				contentRevision: this.incrementContentRevision(captureId)
			};
		});
		const result = transaction() as { collapseRuns: boolean; collapsed: boolean; contentRevision: number };
		return { captureId, profileId, sectionId, ...result };
	}

	private incrementContentRevision(captureId: string): number {
		const result = this.database
			.prepare(
				`UPDATE captures
				 SET content_revision = content_revision + 1, updated_at = @updatedAt
				 WHERE id = @captureId
				 RETURNING content_revision`
			)
			.get({ captureId, updatedAt: this.nowIso() }) as { content_revision: number } | undefined;
		if (!result) throw new CanonicalCaptureNotFoundError(captureId);
		return result.content_revision;
	}

	private requireRawOffset(captureId: string, rawOffset: number): void {
		const row = this.database
			.prepare(
				`SELECT 1 FROM raw_chunks
				 WHERE capture_id = @captureId
				   AND start_offset <= @rawOffset
				   AND start_offset + byte_count > @rawOffset
				 LIMIT 1`
			)
			.get({ captureId, rawOffset });
		if (!row) throw new CanonicalCaptureNotFoundError(`${captureId}/bytes/${rawOffset}`);
	}

	private pruneStableNotesOutsideRetainedWindow(captureId: string, retainedStartOffset: number): number {
		const notes = this.database
			.prepare(
				`SELECT id, capture_id, text, created_at, updated_at, target_kind, raw_offset, profile_id,
						raw_offsets_json, start_offset, end_offset, sequence_key, start_row, end_row, sequence_group_id
				 FROM stable_notes WHERE capture_id = @captureId`
			)
			.all({ captureId }) as NoteRow[];
		const sequenceGroupEndOffsets = new Map<string, number | null>();
		const deleteNote = this.database.prepare("DELETE FROM stable_notes WHERE capture_id = @captureId AND id = @noteId");
		let deleted = 0;
		for (const note of notes) {
			let rawSpanEnd = noteRawSpanEnd(note);
			if (note.target_kind === "sequence-group" && rawSpanEnd === null && note.sequence_group_id) {
				if (!sequenceGroupEndOffsets.has(note.sequence_group_id)) {
					const occurrence = this.database
						.prepare("SELECT MAX(end_raw_offset) AS end_raw_offset FROM sequence_occurrences WHERE group_id = @groupId")
						.get({ groupId: note.sequence_group_id }) as { end_raw_offset: number | null } | undefined;
					sequenceGroupEndOffsets.set(note.sequence_group_id, occurrence?.end_raw_offset ?? null);
				}
				rawSpanEnd = sequenceGroupEndOffsets.get(note.sequence_group_id) ?? null;
			}
			// The retained window is inclusive at retainedStartOffset. Delete only
			// when every known byte in the target's span is before that boundary.
			if (rawSpanEnd === null || rawSpanEnd >= retainedStartOffset) continue;
			deleted += deleteNote.run({ captureId, noteId: note.id }).changes;
		}
		return deleted;
	}

	private resolveFrameSpan(request: Omit<FrameVisibilityRequest, "hidden">): {
		profileId: string;
		frameId?: string;
		startRawOffset: number;
		endRawOffset: number;
	} {
		const captureId = requiredString(request.captureId, "captureId");
		if (request.frameId) {
			const frameId = requiredString(request.frameId, "frameId");
			const row = this.database
				.prepare("SELECT profile_id, raw_offsets_json FROM materialized_frames WHERE id = @frameId AND capture_id = @captureId")
				.get({ captureId, frameId }) as { profile_id: string; raw_offsets_json: string } | undefined;
			if (!row) throw new CanonicalCaptureNotFoundError(`${captureId}/frames/${frameId}`);
			const offsets = JSON.parse(row.raw_offsets_json) as number[];
			if (!offsets.length) throw new CanonicalCaptureConflictError("frame has no stable raw span", { captureId, frameId });
			return {
				profileId: row.profile_id,
				frameId,
				startRawOffset: Math.min(...offsets),
				endRawOffset: Math.max(...offsets)
			};
		}
		const profileId = requiredString(request.profileId, "profileId");
		const startRawOffset = nonNegativeInteger(request.startRawOffset, "startRawOffset");
		const endRawOffset = nonNegativeInteger(request.endRawOffset, "endRawOffset");
		if (endRawOffset < startRawOffset) throw new CanonicalCaptureValidationError("endRawOffset must not precede startRawOffset");
		const profile = this.database
			.prepare("SELECT 1 FROM framing_profiles WHERE id = @profileId AND capture_id = @captureId")
			.get({ captureId, profileId });
		if (!profile) throw new CanonicalCaptureNotFoundError(`${captureId}/profiles/${profileId}`);
		return { profileId, startRawOffset, endRawOffset };
	}

	setByteVisibility(request: ByteVisibilityRequest): VisibilityResponse {
		const captureId = requiredString(request.captureId, "captureId");
		const rawOffset = nonNegativeInteger(request.rawOffset, "rawOffset");
		const transaction = this.database.transaction(() => {
			this.requireCanonicalStorage(captureId);
			this.requireRawOffset(captureId, rawOffset);
			this.database
				.prepare(
					`INSERT INTO raw_byte_visibility (capture_id, raw_offset, hidden)
					 VALUES (@captureId, @rawOffset, @hidden)
					 ON CONFLICT(capture_id, raw_offset) DO UPDATE SET hidden = excluded.hidden`
				)
				.run({ captureId, rawOffset, hidden: request.hidden ? 1 : 0 });
			return this.incrementContentRevision(captureId);
		});
		const contentRevision = transaction() as number;
		return { captureId, startRawOffset: rawOffset, endRawOffset: rawOffset, hidden: Boolean(request.hidden), contentRevision };
	}

	deleteByteVisibility(captureIdValue: string, rawOffsetValue: number): Readonly<{ contentRevision: number }> {
		const captureId = requiredString(captureIdValue, "captureId");
		const rawOffset = nonNegativeInteger(rawOffsetValue, "rawOffset");
		const transaction = this.database.transaction(() => {
			this.requireCanonicalStorage(captureId);
			this.database.prepare("DELETE FROM raw_byte_visibility WHERE capture_id = @captureId AND raw_offset = @rawOffset").run({ captureId, rawOffset });
			return this.incrementContentRevision(captureId);
		});
		return { contentRevision: transaction() as number };
	}

	setFrameVisibility(request: FrameVisibilityRequest): VisibilityResponse {
		const captureId = requiredString(request.captureId, "captureId");
		const transaction = this.database.transaction(() => {
			this.requireCanonicalStorage(captureId);
			const span = this.resolveFrameSpan(request);
			this.database
				.prepare(
					`INSERT INTO frame_visibility (capture_id, profile_id, start_raw_offset, end_raw_offset, hidden)
					 VALUES (@captureId, @profileId, @startRawOffset, @endRawOffset, @hidden)
					 ON CONFLICT(capture_id, profile_id, start_raw_offset, end_raw_offset)
					 DO UPDATE SET hidden = excluded.hidden`
				)
				.run({ captureId, ...span, hidden: request.hidden ? 1 : 0 });
			return { span, contentRevision: this.incrementContentRevision(captureId) };
		});
		const result = transaction() as { span: ReturnType<CanonicalCaptureCommandService["resolveFrameSpan"]>; contentRevision: number };
		return { captureId, ...result.span, hidden: Boolean(request.hidden), contentRevision: result.contentRevision };
	}

	deleteFrameVisibility(request: Omit<FrameVisibilityRequest, "hidden">): Readonly<{ contentRevision: number }> {
		const captureId = requiredString(request.captureId, "captureId");
		const transaction = this.database.transaction(() => {
			this.requireCanonicalStorage(captureId);
			const span = this.resolveFrameSpan(request);
			this.database
				.prepare(
					`DELETE FROM frame_visibility
					 WHERE capture_id = @captureId AND profile_id = @profileId
					   AND start_raw_offset = @startRawOffset AND end_raw_offset = @endRawOffset`
				)
				.run({ captureId, ...span });
			return this.incrementContentRevision(captureId);
		});
		return { contentRevision: transaction() as number };
	}

	private resolveNoteTarget(captureId: string, target: CanonicalNoteTarget): Record<string, string | number | null> {
		if (!target || typeof target !== "object" || !("kind" in target)) {
			throw new CanonicalCaptureValidationError("note target is required");
		}
		const empty = {
			rawOffset: null,
			profileId: null,
			rawOffsetsJson: null,
			startOffset: null,
			endOffset: null,
			sequenceKey: null,
			startRow: null,
			endRow: null,
			frameId: null,
			sequenceGroupId: null
		};
		if (target.kind === "capture") return { targetKind: "capture", ...empty };
		if (target.kind === "byte") {
			const rawOffset = nonNegativeInteger(target.rawOffset, "target.rawOffset");
			this.requireRawOffset(captureId, rawOffset);
			return { targetKind: "byte", ...empty, rawOffset };
		}
		if (target.kind === "frame") {
			if (target.frameId) {
				const span = this.resolveFrameSpan({ captureId, frameId: target.frameId });
				const row = this.database.prepare("SELECT raw_offsets_json FROM materialized_frames WHERE id = @frameId").get({ frameId: target.frameId }) as { raw_offsets_json: string };
				return {
					targetKind: "frame",
					...empty,
					profileId: span.profileId,
					frameId: target.frameId,
					rawOffsetsJson: row.raw_offsets_json,
					startOffset: span.startRawOffset,
					endOffset: span.endRawOffset
				};
			}
			const profileId = requiredString(target.profileId, "target.profileId");
			const rawOffsets = (target.rawOffsets ?? []).map((offset, index) => nonNegativeInteger(offset, `target.rawOffsets[${index}]`));
			if (!rawOffsets.length) throw new CanonicalCaptureValidationError("frame note requires rawOffsets or frameId");
			const profile = this.database.prepare("SELECT 1 FROM framing_profiles WHERE id = @profileId AND capture_id = @captureId").get({ captureId, profileId });
			if (!profile) throw new CanonicalCaptureNotFoundError(`${captureId}/profiles/${profileId}`);
			for (const rawOffset of rawOffsets) this.requireRawOffset(captureId, rawOffset);
			return {
				targetKind: "frame",
				...empty,
				profileId,
				rawOffsetsJson: JSON.stringify(rawOffsets),
				startOffset: Math.min(...rawOffsets),
				endOffset: Math.max(...rawOffsets)
			};
		}
		if (target.kind === "range") {
			const profileId = requiredString(target.profileId, "target.profileId");
			const capture = this.database.prepare("SELECT active_framing_profile_id FROM captures WHERE id = @captureId").get({ captureId }) as { active_framing_profile_id: string | null };
			if (capture.active_framing_profile_id !== profileId) {
				throw new CanonicalCaptureConflictError("range notes must target the active profile", {
					captureId,
					expectedActiveProfileId: profileId,
					actualActiveProfileId: capture.active_framing_profile_id
				});
			}
			const startOrdinal = nonNegativeInteger(target.startOrdinal ?? target.startRow, "target.startOrdinal");
			const endOrdinal = nonNegativeInteger(target.endOrdinal ?? target.endRow, "target.endOrdinal");
			if (endOrdinal < startOrdinal) throw new CanonicalCaptureValidationError("target.endOrdinal must not precede startOrdinal");
			const frames = this.database
				.prepare(
					`SELECT raw_offsets_json FROM materialized_frames
					 WHERE capture_id = @captureId AND profile_id = @profileId
					   AND ordinal >= @startOrdinal AND ordinal <= @endOrdinal
					 ORDER BY ordinal`
				)
				.all({ captureId, profileId, startOrdinal, endOrdinal }) as Array<{ raw_offsets_json: string }>;
			if (!frames.length) throw new CanonicalCaptureValidationError("range note resolves to no active frames");
			const offsets = frames.flatMap(frame => JSON.parse(frame.raw_offsets_json) as number[]);
			if (!offsets.length) throw new CanonicalCaptureValidationError("range note resolves to no raw-span evidence");
			return {
				targetKind: "range",
				...empty,
				profileId,
				startOffset: Math.min(...offsets),
				endOffset: Math.max(...offsets),
				startRow: startOrdinal,
				endRow: endOrdinal
			};
		}
		if (target.kind === "frame-range") {
			const profileId = requiredString(target.profileId, "target.profileId");
			const startOrdinal = nonNegativeInteger(target.startOrdinal, "target.startOrdinal");
			const endOrdinal = nonNegativeInteger(target.endOrdinal, "target.endOrdinal");
			if (endOrdinal < startOrdinal) throw new CanonicalCaptureValidationError("target.endOrdinal must not precede target.startOrdinal");
			const frames = this.database
				.prepare(
					`SELECT raw_offsets_json FROM materialized_frames
					 WHERE capture_id = @captureId AND profile_id = @profileId
					   AND ordinal >= @startOrdinal AND ordinal <= @endOrdinal
					 ORDER BY ordinal`
				)
				.all({ captureId, profileId, startOrdinal, endOrdinal }) as Array<{ raw_offsets_json: string }>;
			if (!frames.length) throw new CanonicalCaptureValidationError("frame range resolves to no evidence");
			if (frames.length !== endOrdinal - startOrdinal + 1) throw new CanonicalCaptureValidationError("frame range does not cover all requested ordinals");
			const offsets = frames.flatMap(frame => JSON.parse(frame.raw_offsets_json) as number[]);
			if (!offsets.length) throw new CanonicalCaptureValidationError("frame range resolves to no raw-span evidence");
			return { targetKind: "frame-range", ...empty, profileId, startOffset: Math.min(...offsets), endOffset: Math.max(...offsets), startRow: startOrdinal, endRow: endOrdinal };
		}
		if (target.kind === "raw-range") {
			const startOffset = nonNegativeInteger(target.startRawOffset, "target.startRawOffset");
			const endOffset = nonNegativeInteger(target.endRawOffset, "target.endRawOffset");
			if (endOffset < startOffset) throw new CanonicalCaptureValidationError("target.endRawOffset must not precede target.startRawOffset");
			this.requireRawOffset(captureId, startOffset);
			this.requireRawOffset(captureId, endOffset);
			return { targetKind: "raw-range", ...empty, startOffset, endOffset };
		}
		if (target.kind === "pattern") {
			const sequenceKey = requiredString(target.sequenceKey, "target.sequenceKey");
			return { targetKind: "pattern", ...empty, sequenceKey };
		}
		if (target.kind === "sequence-group") {
			const groupId = requiredString(target.groupId, "target.groupId");
			const row = this.database
				.prepare("SELECT id, profile_id, key_text FROM sequence_groups WHERE id = @groupId AND capture_id = @captureId")
				.get({ captureId, groupId }) as { id: string; profile_id: string; key_text: string } | undefined;
			if (!row) throw new CanonicalCaptureNotFoundError(`${captureId}/sequence-groups/${groupId}`);
			if (target.profileId && target.profileId !== row.profile_id) {
				throw new CanonicalCaptureConflictError("sequence group profile does not match", { captureId, groupId, expectedProfileId: target.profileId, actualProfileId: row.profile_id });
			}
			return { targetKind: "sequence-group", ...empty, profileId: row.profile_id, sequenceKey: row.key_text, sequenceGroupId: row.id };
		}
		throw new CanonicalCaptureValidationError("new notes require a stable canonical target", { kind: target.kind });
	}

	private readNote(captureId: string, noteId: string): CanonicalNote {
		const row = this.database
			.prepare(
				`SELECT id, capture_id, text, created_at, updated_at, target_kind, raw_offset, profile_id,
				        raw_offsets_json, start_offset, end_offset, sequence_key, start_row, end_row, sequence_group_id,
				        author_type, reported_client_name, reported_client_version, protocol_version
				 FROM stable_notes WHERE capture_id = @captureId AND id = @noteId`
			)
			.get({ captureId, noteId }) as NoteRow | undefined;
		if (!row) throw new CanonicalCaptureNotFoundError(`${captureId}/notes/${noteId}`);
		return {
			id: row.id,
			captureId: row.capture_id,
			text: row.text,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			authorType: row.author_type,
			...(row.reported_client_name ? { reportedClientName: row.reported_client_name } : {}),
			...(row.reported_client_version ? { reportedClientVersion: row.reported_client_version } : {}),
			...(row.protocol_version ? { protocolVersion: row.protocol_version } : {}),
			target: noteTargetFromRow(row)
		};
	}

	createNote(request: CreateNoteRequest): NoteResponse {
		const captureId = requiredString(request.captureId, "captureId");
		const noteId = requiredString(request.noteId ?? request.id ?? this.generateId(), "noteId");
		const text = requiredString(request.text, "text");
		const createdAt = isoFrom(request.createdAt, this.nowIso());
		const transaction = this.database.transaction(() => {
			this.requireCanonicalStorage(captureId);
			const target = this.resolveNoteTarget(captureId, request.target);
			try {
				this.database
					.prepare(
						`INSERT INTO stable_notes
						 (id, capture_id, text, created_at, target_kind, raw_offset, profile_id, raw_offsets_json,
						  start_offset, end_offset, sequence_key, start_row, end_row, frame_id, sequence_group_id)
						 VALUES (@noteId, @captureId, @text, @createdAt, @targetKind, @rawOffset, @profileId, @rawOffsetsJson,
						  @startOffset, @endOffset, @sequenceKey, @startRow, @endRow, @frameId, @sequenceGroupId)`
					)
					.run({ noteId, captureId, text, createdAt, ...target });
			} catch (error) {
				if (String(error).includes("UNIQUE constraint")) throw new CanonicalCaptureConflictError("note id already exists", { captureId, noteId });
				throw error;
			}
			return this.incrementContentRevision(captureId);
		});
		const contentRevision = transaction() as number;
		return { note: this.readNote(captureId, noteId), contentRevision };
	}

	public isAgentNotesEnabled(): boolean {
		const row = this.database
			.prepare("SELECT value_json FROM application_settings WHERE key = @key")
			.get({ key: ALLOW_AGENT_AUTHORED_NOTES_SETTING }) as { value_json: string } | undefined;
		if (!row) return false;
		try {
			return JSON.parse(row.value_json) === true;
		} catch {
			return false;
		}
	}

	createAgentNote(request: CreateAgentNoteRequest): NoteResponse {
		const captureId = requiredString(request.captureId, "captureId");
		const noteId = requiredString(request.noteId ?? this.generateId(), "noteId");
		const text = requiredString(request.text, "text");
		if (text.length > 4_000) throw new CanonicalCaptureValidationError("agent note text must be at most 4000 characters");
		const attribution = request.attribution;
		const reportedClientName = requiredString(attribution.reportedClientName, "attribution.reportedClientName");
		const protocolVersion = requiredString(attribution.protocolVersion, "attribution.protocolVersion");
		if (reportedClientName.length > 200 || protocolVersion.length > 80 || attribution.reportedClientVersion && attribution.reportedClientVersion.length > 80) {
			throw new CanonicalCaptureValidationError("agent note attribution metadata is too long");
		}
		const targetNeedsProfile = request.target.kind === "frame" || request.target.kind === "frame-range" || request.target.kind === "sequence-group";
		const profileFieldsPresent = request.profileId !== undefined || request.profileVersion !== undefined || request.sourceDataRevision !== undefined;
		if (targetNeedsProfile && (request.profileId === undefined || request.profileVersion === undefined || request.sourceDataRevision === undefined)) {
			throw new CanonicalCaptureValidationError("agent evidence targets require profileId, profileVersion, and sourceDataRevision");
		}
		if (profileFieldsPresent && (request.profileId === undefined || request.profileVersion === undefined || request.sourceDataRevision === undefined)) {
			throw new CanonicalCaptureValidationError("profileId, profileVersion, and sourceDataRevision must be supplied together");
		}
		if (request.profileVersion !== undefined && (!Number.isSafeInteger(request.profileVersion) || request.profileVersion < 1)) throw new CanonicalCaptureValidationError("profileVersion must be a positive integer");
		if (request.sourceDataRevision !== undefined && (!Number.isSafeInteger(request.sourceDataRevision) || request.sourceDataRevision < 0)) throw new CanonicalCaptureValidationError("sourceDataRevision must be a non-negative integer");
		const transaction = this.database.transaction(() => {
			if (!this.isAgentNotesEnabled()) throw new CanonicalCaptureAnnotationDisabledError();
			this.requireCanonicalStorage(captureId);
			const target = this.resolveNoteTarget(captureId, request.target);
			if (request.profileId !== undefined) {
				const profile = this.database
					.prepare("SELECT id, version, source_data_revision, verified FROM framing_profiles WHERE id = @profileId AND capture_id = @captureId")
					.get({ captureId, profileId: request.profileId }) as { id: string; version: number; source_data_revision: number; verified: number } | undefined;
				if (!profile) throw new CanonicalCaptureNotFoundError(`${captureId}/profiles/${request.profileId}`);
				if (profile.version !== request.profileVersion || profile.source_data_revision !== request.sourceDataRevision || !profile.verified) throw new CanonicalCaptureConflictError("agent note profile revision is not available", { captureId, profileId: request.profileId, profileVersion: request.profileVersion, sourceDataRevision: request.sourceDataRevision });
				if (target.profileId && target.profileId !== request.profileId) throw new CanonicalCaptureConflictError("agent note target does not match its profile revision", { captureId, targetProfileId: target.profileId, profileId: request.profileId });
			}
			try {
				this.database
					.prepare(
						`INSERT INTO stable_notes
						 (id, capture_id, text, created_at, target_kind, raw_offset, profile_id, raw_offsets_json,
						  start_offset, end_offset, sequence_key, start_row, end_row, frame_id, sequence_group_id,
						  author_type, reported_client_name, reported_client_version, protocol_version)
						 VALUES (@noteId, @captureId, @text, @createdAt, @targetKind, @rawOffset, @profileId, @rawOffsetsJson,
						  @startOffset, @endOffset, @sequenceKey, @startRow, @endRow, @frameId, @sequenceGroupId,
						  'agent', @reportedClientName, @reportedClientVersion, @protocolVersion)`
					)
					.run({ noteId, captureId, text, createdAt: this.nowIso(), ...target, reportedClientName, reportedClientVersion: attribution.reportedClientVersion ?? null, protocolVersion });
			} catch (error) {
				if (String(error).includes("UNIQUE constraint")) throw new CanonicalCaptureConflictError("note id already exists", { captureId, noteId });
				throw error;
			}
			return this.incrementContentRevision(captureId);
		});
		const contentRevision = transaction() as number;
		return { note: this.readNote(captureId, noteId), contentRevision };
	}

	updateNote(request: UpdateNoteRequest): NoteResponse {
		const captureId = requiredString(request.captureId, "captureId");
		const noteId = requiredString(request.noteId, "noteId");
		const transaction = this.database.transaction(() => {
			this.requireCanonicalStorage(captureId);
			const existing = this.readNote(captureId, noteId);
			const text = request.text === undefined ? existing.text : requiredString(request.text, "text");
			const target = request.target === undefined ? this.resolveNoteTarget(captureId, existing.target) : this.resolveNoteTarget(captureId, request.target);
			this.database
				.prepare(
					`UPDATE stable_notes SET text = @text, updated_at = @updatedAt, target_kind = @targetKind,
					 raw_offset = @rawOffset, profile_id = @profileId, raw_offsets_json = @rawOffsetsJson,
					 start_offset = @startOffset, end_offset = @endOffset, sequence_key = @sequenceKey,
					 start_row = @startRow, end_row = @endRow, frame_id = @frameId, sequence_group_id = @sequenceGroupId
					 WHERE capture_id = @captureId AND id = @noteId`
				)
				.run({ captureId, noteId, text, updatedAt: this.nowIso(), ...target });
			return this.incrementContentRevision(captureId);
		});
		const contentRevision = transaction() as number;
		return { note: this.readNote(captureId, noteId), contentRevision };
	}

	deleteNote(request: DeleteNoteRequest): Readonly<{ contentRevision: number }> {
		const captureId = requiredString(request.captureId, "captureId");
		const noteId = requiredString(request.noteId, "noteId");
		const transaction = this.database.transaction(() => {
			this.requireCanonicalStorage(captureId);
			const result = this.database.prepare("DELETE FROM stable_notes WHERE capture_id = @captureId AND id = @noteId").run({ captureId, noteId });
			if (!result.changes) throw new CanonicalCaptureNotFoundError(`${captureId}/notes/${noteId}`);
			return this.incrementContentRevision(captureId);
		});
		return { contentRevision: transaction() as number };
	}

	clearCaptureData(request: ClearCaptureDataRequest): ClearCaptureDataResponse {
		const captureId = requiredString(request.captureId, "captureId");
		const transaction = this.database.transaction(() => {
			const capture = this.database
				.prepare("SELECT byte_count, data_revision, content_revision FROM captures WHERE id = @captureId")
				.get({ captureId }) as
				| { byte_count: number; data_revision: number; content_revision: number }
				| undefined;
			if (!capture) throw new CanonicalCaptureNotFoundError(captureId);
			this.requireCanonicalStorage(captureId);
			const activeSession = this.database
				.prepare(
					"SELECT id, status FROM capture_sessions WHERE capture_id = @captureId AND status IN ('recording','finalizing') ORDER BY ordinal DESC LIMIT 1"
				)
				.get({ captureId }) as { id: string; status: string } | undefined;
			if (activeSession) {
				throw new CanonicalCaptureConflictError("capture cannot be cleared while a session is recording or finalizing", {
					captureId,
					activeSessionId: activeSession.id,
					activeSessionStatus: activeSession.status
				});
			}
			// Preserve the draft for older canonical captures before deleting the
			// profile rows that can be used to reconstruct it.
			this.repairFramingDraftIfProfileExists(captureId, capture.data_revision);

			// Framing drafts, parameters, canonical metadata, and capture-level notes
			// are the durable operator context for a capture. Everything below is
			// evidence or a derived/materialized view of that evidence.
			this.database.prepare("DELETE FROM raw_chunk_requests WHERE capture_id = @captureId").run({ captureId });
			this.database.prepare("DELETE FROM raw_chunks WHERE capture_id = @captureId").run({ captureId });
			this.database.prepare("DELETE FROM capture_sessions WHERE capture_id = @captureId").run({ captureId });
			this.database.prepare("DELETE FROM raw_byte_visibility WHERE capture_id = @captureId").run({ captureId });
			this.database.prepare("DELETE FROM frame_visibility WHERE capture_id = @captureId").run({ captureId });
			this.database
				.prepare("DELETE FROM stable_notes WHERE capture_id = @captureId AND target_kind <> 'capture'")
				.run({ captureId });
			this.database.prepare("DELETE FROM finalization_jobs WHERE capture_id = @captureId").run({ captureId });
			// The canonical schema cascades sections, frames, statistics, and
			// sequence analysis from the profile rows.
			this.database.prepare("DELETE FROM framing_profiles WHERE capture_id = @captureId").run({ captureId });

			const updated = this.database
				.prepare(
					`UPDATE captures
					 SET active_framing_profile_id = NULL,
						 byte_count = 0,
						 retained_start_offset = 0,
						 lifecycle = 'finalized',
						 data_revision = data_revision + 1,
						 content_revision = content_revision + 1,
						 updated_at = @updatedAt
					 WHERE id = @captureId
					 RETURNING data_revision, content_revision`
				)
				.get({ captureId, updatedAt: this.nowIso() }) as
				| { data_revision: number; content_revision: number }
				| undefined;
			if (!updated) throw new CanonicalCaptureNotFoundError(captureId);
			return {
				captureId,
				dataRevision: updated.data_revision,
				contentRevision: updated.content_revision,
				clearedByteCount: capture.byte_count
			} satisfies ClearCaptureDataResponse;
		});
		return transaction() as ClearCaptureDataResponse;
	}

	duplicateCapture(request: DuplicateCaptureRequest): DuplicateCaptureResponse {
		const sourceCaptureId = requiredString(request.captureId, "captureId");
		const requestedDuplicateId = request.duplicateCaptureId ?? request.id;
		const duplicateCaptureId = requiredString(requestedDuplicateId ?? this.generateId(), "duplicateCaptureId");
		const duplicateRequestHash = sha256Hex(
			stableSerialize({ operation: "duplicateCapture", sourceCaptureId, duplicateCaptureId })
		);

		type SourceProfile = {
			id: string;
			version: number;
			algorithm_version: number;
			is_active: number;
			created_at: string;
			updated_at: string;
			source_data_revision: number;
			retained_start_offset: number;
			verified: number;
		};
		type SourceProfileMetadataSnapshot = {
			profile_id: string;
			capture_id: string;
			name: string;
			description: string;
			controller_view: string;
			baud_rate: number | null;
			input_format: string;
			lifecycle: string;
			byte_count: number;
			folder_id: string | null;
			data_revision: number;
			metadata_revision: number;
			content_revision: number;
			retained_start_offset: number;
			parameters_json: string;
			created_at: string;
		};
		type SourceSection = {
			id: string;
			profile_id: string;
			start_offset: number;
			position: number;
			framing_mode: string;
			frame_length: number | null;
			marker_bytes: string | null;
			marker_position: string | null;
			time_gap_ms: number | null;
			collapse_runs: number;
			collapsed: number;
		};
			type SourceFrame = {
			id: string;
			profile_id: string;
			profile_version: number;
			ordinal: number;
			section_id: string;
			raw_offsets_json: string;
			bytes_json: string;
			timestamps_json: string;
			directions_json: string;
			hidden: number;
				signature: string;
			};
			type SourceTransitionPosition = {
				profile_id: string;
				section_id: string;
				from_signature: string;
				to_signature: string;
				position: number;
				changed_count: number;
				transition_count: number;
			};
		type SourceSession = {
			ordinal: number;
			id: string;
			first_received_at: number | null;
			last_received_at: number | null;
			status: string;
			started_at: string | null;
			finalized_at: string | null;
			next_chunk_sequence: number;
			next_raw_offset: number;
		};
		type SourceRawChunk = {
			chunk_index: number;
			start_offset: number;
			byte_count: number;
			bytes: Buffer;
			timestamps_json: string;
			directions_json: string;
			hidden_json: string;
			session_id: string | null;
			session_ids_json: string;
		};
		type SourceRequest = {
			request_id: string;
			session_id: string;
			sequence: number;
			expected_start_offset: number;
			payload_hash: string;
			accepted_start_offset: number;
			accepted_end_offset: number;
			next_raw_offset: number;
			next_sequence: number;
			data_revision: number;
			created_at: string;
		};
		type SourceDraft = {
			revision: number;
			sections_json: string;
			source_data_revision: number;
			created_at: string;
			updated_at: string;
		};
		type SourceVisibility = {
			raw_offset: number;
		hidden: number;
		};
		type SourceFrameVisibility = {
			profile_id: string;
			start_raw_offset: number;
			end_raw_offset: number;
			hidden: number;
		};
		type SourceNote = {
			id: string;
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
			message_id: string | null;
			byte_position: number | null;
			frame_id: string | null;
			sequence_group_id: string | null;
			author_type: "human" | "agent";
			reported_client_name: string | null;
			reported_client_version: string | null;
			protocol_version: string | null;
		};
		type SourceJob = {
			id: string;
			session_id: string | null;
			profile_id: string | null;
			status: string;
			created_at: string;
			updated_at: string;
			error: string | null;
			verified: number;
			data_revision: number;
			source_data_revision: number | null;
			attempt_count: number;
			next_attempt_at: string | null;
			lease_token: string | null;
			lease_expires_at: string | null;
			started_at: string | null;
			completed_at: string | null;
		};

		const transaction = this.database.transaction(() => {
			const source = this.database
				.prepare(
					`SELECT id, name, description, controller_view, baud_rate, input_format, lifecycle, byte_count,
							created_at, updated_at, folder_id, data_revision, metadata_revision, content_revision,
							retained_start_offset, active_framing_profile_id
					 FROM captures WHERE id = @captureId`
				)
				.get({ captureId: sourceCaptureId }) as CaptureRow | undefined;
			if (!source) throw new CanonicalCaptureNotFoundError(sourceCaptureId);
			this.requireCanonicalStorage(sourceCaptureId);

			const target = this.database
				.prepare("SELECT id, create_request_hash FROM captures WHERE id = @captureId")
				.get({ captureId: duplicateCaptureId }) as { id: string; create_request_hash: string | null } | undefined;
			if (target) {
				if (target.create_request_hash === duplicateRequestHash) {
					this.requireCanonicalStorage(duplicateCaptureId);
					return duplicateCaptureId;
				}
				throw new CanonicalCaptureIdempotencyConflictError("duplicate capture id already exists", {
					captureId: duplicateCaptureId,
					sourceCaptureId,
					expectedRequestHash: duplicateRequestHash,
					actualRequestHash: target.create_request_hash
				});
			}
			if (duplicateCaptureId === sourceCaptureId) {
				throw new CanonicalCaptureIdempotencyConflictError("duplicate capture id must differ from source capture", {
					captureId: duplicateCaptureId,
					sourceCaptureId
				});
			}
			const occupiedCompatibilityRow = this.database
				.prepare(
					`SELECT 1 FROM capture_storage WHERE capture_id = @captureId
					 UNION ALL SELECT 1 FROM capture_documents WHERE id = @captureId
					 UNION ALL SELECT 1 FROM capture_backups WHERE capture_id = @captureId
					 LIMIT 1`
				)
				.get({ captureId: duplicateCaptureId });
			if (occupiedCompatibilityRow) {
				throw new CanonicalCaptureIdempotencyConflictError("duplicate capture id is already reserved", {
					captureId: duplicateCaptureId,
					sourceCaptureId
				});
			}
			if (source.lifecycle !== "finalized") {
				throw new CanonicalCaptureConflictError("capture must be finalized before duplication", {
					captureId: sourceCaptureId,
					lifecycle: source.lifecycle
				});
			}
			// A duplicate must retain a live framing draft even when the source is
			// an older canonical capture that predates draft seeding. Repair it
			// before reading the rows that will be copied below; otherwise clearing
			// the duplicate would also remove the only profile from which the draft
			// could be reconstructed.
			this.repairFramingDraftIfProfileExists(sourceCaptureId, source.data_revision);

			const profiles = this.database
				.prepare(
					`SELECT id, version, algorithm_version, is_active, created_at, updated_at,
							source_data_revision, retained_start_offset, verified
					 FROM framing_profiles WHERE capture_id = @captureId ORDER BY version`
				)
				.all({ captureId: sourceCaptureId }) as SourceProfile[];
			const profileIds = profiles.map(profile => profile.id);
			const profileMetadataSnapshots = this.database
				.prepare(
					`SELECT profile_id, capture_id, name, description, controller_view, baud_rate,
							input_format, lifecycle, byte_count, folder_id, data_revision,
							metadata_revision, content_revision, retained_start_offset, parameters_json,
							created_at
					 FROM framing_profile_metadata_snapshots
					 WHERE capture_id = @captureId
					 ORDER BY profile_id`
				)
				.all({ captureId: sourceCaptureId }) as SourceProfileMetadataSnapshot[];
			const sections = this.database
				.prepare(
					`SELECT id, profile_id, start_offset, position, framing_mode, frame_length, marker_bytes,
							marker_position, time_gap_ms, collapse_runs, collapsed
					 FROM framing_sections WHERE capture_id = @captureId ORDER BY profile_id, position`
				)
				.all({ captureId: sourceCaptureId }) as SourceSection[];
			const frames = this.database
				.prepare(
					`SELECT id, profile_id, profile_version, ordinal, section_id, raw_offsets_json, bytes_json,
							timestamps_json, directions_json, hidden, signature
					 FROM materialized_frames WHERE capture_id = @captureId ORDER BY profile_version, ordinal`
				)
				.all({ captureId: sourceCaptureId }) as SourceFrame[];
			const sessions = this.database
				.prepare(
					`SELECT ordinal, id, first_received_at, last_received_at, status, started_at, finalized_at,
							next_chunk_sequence, next_raw_offset
					 FROM capture_sessions WHERE capture_id = @captureId ORDER BY ordinal`
				)
				.all({ captureId: sourceCaptureId }) as SourceSession[];
			const rawChunks = this.database
				.prepare(
					`SELECT chunk_index, start_offset, byte_count, bytes, timestamps_json, directions_json,
							hidden_json, session_id, session_ids_json
					 FROM raw_chunks WHERE capture_id = @captureId ORDER BY chunk_index`
				)
				.all({ captureId: sourceCaptureId }) as SourceRawChunk[];
			const rawRequests = this.database
				.prepare(
					`SELECT request_id, session_id, sequence, expected_start_offset, payload_hash,
							accepted_start_offset, accepted_end_offset, next_raw_offset, next_sequence,
							data_revision, created_at
					 FROM raw_chunk_requests WHERE capture_id = @captureId ORDER BY rowid`
				)
				.all({ captureId: sourceCaptureId }) as SourceRequest[];
			const drafts = this.database
				.prepare(
					`SELECT revision, sections_json, source_data_revision, created_at, updated_at
					 FROM framing_drafts WHERE capture_id = @captureId ORDER BY revision`
				)
				.all({ captureId: sourceCaptureId }) as SourceDraft[];
			const byteVisibility = this.database
				.prepare("SELECT raw_offset, hidden FROM raw_byte_visibility WHERE capture_id = @captureId ORDER BY raw_offset")
				.all({ captureId: sourceCaptureId }) as SourceVisibility[];
			const frameVisibility = this.database
				.prepare(
					`SELECT profile_id, start_raw_offset, end_raw_offset, hidden
					 FROM frame_visibility WHERE capture_id = @captureId ORDER BY profile_id, start_raw_offset, end_raw_offset`
				)
				.all({ captureId: sourceCaptureId }) as SourceFrameVisibility[];
			const notes = this.database
				.prepare(
					`SELECT id, text, created_at, updated_at, target_kind, raw_offset, profile_id,
							raw_offsets_json, start_offset, end_offset, sequence_key, start_row, end_row,
							message_id, byte_position, frame_id, sequence_group_id, author_type,
							reported_client_name, reported_client_version, protocol_version
					 FROM stable_notes WHERE capture_id = @captureId ORDER BY created_at, id`
				)
				.all({ captureId: sourceCaptureId }) as SourceNote[];
			const jobs = this.database
				.prepare(
					`SELECT id, session_id, profile_id, status, created_at, updated_at, error, verified,
							data_revision, source_data_revision, attempt_count, next_attempt_at, lease_token,
							lease_expires_at, started_at, completed_at
					 FROM finalization_jobs WHERE capture_id = @captureId ORDER BY created_at, id`
				)
				.all({ captureId: sourceCaptureId }) as SourceJob[];

			const analysisFrameSignatures = this.database
				.prepare("SELECT profile_id, signature, count FROM frame_signatures WHERE profile_id IN (SELECT id FROM framing_profiles WHERE capture_id = @captureId)")
				.all({ captureId: sourceCaptureId }) as Array<{ profile_id: string; signature: string; count: number }>;
			const analysisTransitions = this.database
				.prepare("SELECT profile_id, from_signature, to_signature, count, diffs FROM frame_transitions WHERE profile_id IN (SELECT id FROM framing_profiles WHERE capture_id = @captureId)")
				.all({ captureId: sourceCaptureId }) as Array<{ profile_id: string; from_signature: string; to_signature: string; count: number; diffs: number }>;
			const analysisTransitionPositions = this.database
				.prepare(
					`SELECT profile_id, section_id, from_signature, to_signature, position, changed_count, transition_count
					 FROM frame_transition_positions
					 WHERE profile_id IN (SELECT id FROM framing_profiles WHERE capture_id = @captureId)`
				)
				.all({ captureId: sourceCaptureId }) as SourceTransitionPosition[];
			const analysisByteStatistics = this.database
				.prepare("SELECT profile_id, position, value, count FROM byte_statistics WHERE profile_id IN (SELECT id FROM framing_profiles WHERE capture_id = @captureId)")
				.all({ captureId: sourceCaptureId }) as Array<{ profile_id: string; position: number; value: number; count: number }>;
			const analysisBitStatistics = this.database
				.prepare("SELECT profile_id, position, bit, percentage, variance FROM bit_statistics WHERE profile_id IN (SELECT id FROM framing_profiles WHERE capture_id = @captureId)")
				.all({ captureId: sourceCaptureId }) as Array<{ profile_id: string; position: number; bit: number; percentage: number; variance: string }>;
			const sequenceGroups = this.database
				.prepare("SELECT id, profile_id, key_text, signatures_json, score, length FROM sequence_groups WHERE capture_id = @captureId ORDER BY profile_id, id")
				.all({ captureId: sourceCaptureId }) as Array<{ id: string; profile_id: string; key_text: string; signatures_json: string; score: number; length: number }>;
			const sequenceOccurrences = this.database
				.prepare(
					`SELECT group_id, occurrence_index, offset, start_frame_ordinal, start_raw_offset, end_raw_offset, length
					 FROM sequence_occurrences WHERE group_id IN (SELECT id FROM sequence_groups WHERE capture_id = @captureId)
					 ORDER BY group_id, occurrence_index, offset`
				)
				.all({ captureId: sourceCaptureId }) as Array<{
					group_id: string;
					occurrence_index: number;
					offset: number;
					start_frame_ordinal: number;
					start_raw_offset: number;
					end_raw_offset: number;
					length: number;
				}>;

			const sourceIdentityIds = new Set<string>([
				sourceCaptureId,
				...profileIds,
				...sections.map(section => section.id),
				...frames.map(frame => frame.id),
				...sessions.map(session => session.id),
				...notes.map(note => note.id),
				...jobs.map(job => job.id),
				...sequenceGroups.map(group => group.id),
				...rawRequests.map(rawRequest => rawRequest.request_id)
			]);
			const allocatedIds = new Set(sourceIdentityIds);
			const identityTables = [
				"captures",
				"framing_profiles",
				"framing_sections",
				"materialized_frames",
				"sequence_groups",
				"stable_notes",
				"finalization_jobs",
				"capture_sessions"
			] as const;
			const idTaken = (id: string): boolean => identityTables.some(table => Boolean(this.database.prepare(`SELECT 1 FROM ${table} WHERE id = @id LIMIT 1`).get({ id })));
			const freshId = (field: string): string => {
				for (let attempt = 0; attempt < 100; attempt += 1) {
					const candidate = requiredString(this.generateId(), field);
					if (allocatedIds.has(candidate) || idTaken(candidate)) continue;
					allocatedIds.add(candidate);
					return candidate;
				}
				throw new CanonicalCaptureConflictError(`could not allocate a fresh ${field}`, { sourceCaptureId });
			};
			allocatedIds.add(duplicateCaptureId);

			const profileIdsBySource = new Map(profiles.map(profile => [profile.id, freshId("profileId")]));
			const sectionIdsBySource = new Map<string, string>();
			const freshSectionId = (sourceId: string | null | undefined): string => {
				if (sourceId && sectionIdsBySource.has(sourceId)) return sectionIdsBySource.get(sourceId)!;
				const id = freshId("sectionId");
				if (sourceId) sectionIdsBySource.set(sourceId, id);
				return id;
			};
			sections.forEach(section => freshSectionId(section.id));
			const frameIdsBySource = new Map(frames.map(frame => [frame.id, freshId("frameId")]));
			const sessionIdsBySource = new Map(sessions.map(session => [session.id, freshId("sessionId")]));
			const noteIdsBySource = new Map(notes.map(note => [note.id, freshId("noteId")]));
			const groupIdsBySource = new Map(sequenceGroups.map(group => [group.id, freshId("sequenceGroupId")]));
			const jobIdsBySource = new Map(jobs.map(job => [job.id, freshId("finalizationJobId")]));
			const requestIdsBySource = new Map(rawRequests.map(rawRequest => [rawRequest.request_id, freshId("requestId")]));
			const sourceSectionId = (id: string): string => sectionIdsBySource.get(id) ?? freshSectionId(id);
			const sourceProfileId = (id: string | null): string | null => (id === null ? null : profileIdsBySource.get(id) ?? null);
			const sourceSessionId = (id: string | null): string | null => (id === null ? null : sessionIdsBySource.get(id) ?? null);
			const sourceFrameId = (id: string | null): string | null => (id === null ? null : frameIdsBySource.get(id) ?? null);
			const sourceGroupId = (id: string | null): string | null => (id === null ? null : groupIdsBySource.get(id) ?? null);

			const cloneDraftSections = (sectionsJson: string): string => {
				const parsed: unknown = JSON.parse(sectionsJson);
				if (!Array.isArray(parsed)) return sectionsJson;
				return JSON.stringify(
					parsed.map(section => {
						if (!isRecord(section)) return section;
						const sourceId = typeof section.id === "string" && section.id.trim() ? section.id : undefined;
						return { ...section, id: freshSectionId(sourceId) };
					})
				);
			};

			const now = this.nowIso();
			this.database
				.prepare(
					`INSERT INTO captures
					 (id, name, description, controller_view, baud_rate, input_format, lifecycle, byte_count,
					  created_at, updated_at, folder_id, data_revision, metadata_revision, content_revision,
					  retained_start_offset, create_request_hash, active_framing_profile_id)
					 VALUES (@id, @name, @description, @controllerView, @baudRate, @inputFormat, @lifecycle, @byteCount,
					  @createdAt, @updatedAt, @folderId, @dataRevision, @metadataRevision, @contentRevision,
					  @retainedStartOffset, @createRequestHash, @activeProfileId)`
				)
				.run({
					id: duplicateCaptureId,
					name: `${source.name} · copy`,
					description: source.description,
					controllerView: source.controller_view,
					baudRate: source.baud_rate,
					inputFormat: source.input_format,
					lifecycle: source.lifecycle,
					byteCount: source.byte_count,
					createdAt: now,
					updatedAt: now,
					folderId: source.folder_id,
					dataRevision: source.data_revision,
					metadataRevision: source.metadata_revision,
					contentRevision: source.content_revision,
					retainedStartOffset: source.retained_start_offset,
					createRequestHash: duplicateRequestHash,
					activeProfileId: source.active_framing_profile_id ? profileIdsBySource.get(source.active_framing_profile_id) ?? null : null
				});
			this.database
				.prepare("INSERT INTO capture_storage (capture_id, status, created_at, updated_at, last_error) VALUES (@captureId, @status, @createdAt, @updatedAt, NULL)")
				.run({ captureId: duplicateCaptureId, status: CANONICAL_STORAGE_STATUS, createdAt: now, updatedAt: now });

			const insertParameter = this.database.prepare(
				"INSERT INTO capture_parameters (capture_id, position, key_text, value_text) VALUES (@captureId, @position, @keyText, @valueText)"
			);
			const parameters = this.database
				.prepare("SELECT position, key_text, value_text FROM capture_parameters WHERE capture_id = @captureId ORDER BY position")
				.all({ captureId: sourceCaptureId }) as Array<{ position: number; key_text: string; value_text: string }>;
			parameters.forEach(parameter =>
				insertParameter.run({ captureId: duplicateCaptureId, position: parameter.position, keyText: parameter.key_text, valueText: parameter.value_text })
			);

			const insertDraft = this.database.prepare(
				`INSERT INTO framing_drafts (capture_id, revision, sections_json, source_data_revision, created_at, updated_at)
				 VALUES (@captureId, @revision, @sectionsJson, @sourceDataRevision, @createdAt, @updatedAt)`
			);
			drafts.forEach(draft =>
				insertDraft.run({
					captureId: duplicateCaptureId,
					revision: draft.revision,
					sectionsJson: cloneDraftSections(draft.sections_json),
					sourceDataRevision: draft.source_data_revision,
					createdAt: draft.created_at,
					updatedAt: draft.updated_at
				})
			);

			const insertSession = this.database.prepare(
				`INSERT INTO capture_sessions
				 (capture_id, ordinal, id, first_received_at, last_received_at, status, started_at, finalized_at, next_chunk_sequence, next_raw_offset)
				 VALUES (@captureId, @ordinal, @id, @firstReceivedAt, @lastReceivedAt, @status, @startedAt, @finalizedAt, @nextChunkSequence, @nextRawOffset)`
			);
			sessions.forEach(session =>
				insertSession.run({
					captureId: duplicateCaptureId,
					ordinal: session.ordinal,
					id: sessionIdsBySource.get(session.id),
					firstReceivedAt: session.first_received_at,
					lastReceivedAt: session.last_received_at,
					status: session.status,
					startedAt: session.started_at,
					finalizedAt: session.finalized_at,
					nextChunkSequence: session.next_chunk_sequence,
					nextRawOffset: session.next_raw_offset
				})
			);

			const insertRawChunk = this.database.prepare(
				`INSERT INTO raw_chunks
				 (capture_id, chunk_index, start_offset, byte_count, bytes, timestamps_json, directions_json, hidden_json, session_id, session_ids_json)
				 VALUES (@captureId, @chunkIndex, @startOffset, @byteCount, @bytes, @timestampsJson, @directionsJson, @hiddenJson, @sessionId, @sessionIdsJson)`
			);
			rawChunks.forEach(chunk => {
				const sourceSessionIds = JSON.parse(chunk.session_ids_json || "[]") as Array<string | null>;
				insertRawChunk.run({
					captureId: duplicateCaptureId,
					chunkIndex: chunk.chunk_index,
					startOffset: chunk.start_offset,
					byteCount: chunk.byte_count,
					bytes: chunk.bytes,
					timestampsJson: chunk.timestamps_json,
					directionsJson: chunk.directions_json,
					hiddenJson: chunk.hidden_json,
					sessionId: sourceSessionId(chunk.session_id),
					sessionIdsJson: JSON.stringify(sourceSessionIds.map(sourceSessionId))
				});
			});

			const insertRequest = this.database.prepare(
				`INSERT INTO raw_chunk_requests
				 (capture_id, request_id, session_id, sequence, expected_start_offset, payload_hash, accepted_start_offset,
				  accepted_end_offset, next_raw_offset, next_sequence, data_revision, created_at)
				 VALUES (@captureId, @requestId, @sessionId, @sequence, @expectedStartOffset, @payloadHash, @acceptedStartOffset,
				  @acceptedEndOffset, @nextRawOffset, @nextSequence, @dataRevision, @createdAt)`
			);
			rawRequests.forEach(rawRequest =>
				insertRequest.run({
					captureId: duplicateCaptureId,
					requestId: requestIdsBySource.get(rawRequest.request_id),
					sessionId: sessionIdsBySource.get(rawRequest.session_id),
					sequence: rawRequest.sequence,
					expectedStartOffset: rawRequest.expected_start_offset,
					payloadHash: rawRequest.payload_hash,
					acceptedStartOffset: rawRequest.accepted_start_offset,
					acceptedEndOffset: rawRequest.accepted_end_offset,
					nextRawOffset: rawRequest.next_raw_offset,
					nextSequence: rawRequest.next_sequence,
					dataRevision: rawRequest.data_revision,
					createdAt: rawRequest.created_at
				})
			);

			const insertProfile = this.database.prepare(
				`INSERT INTO framing_profiles
				 (id, capture_id, version, algorithm_version, is_active, created_at, updated_at, source_data_revision, retained_start_offset, verified)
				 VALUES (@id, @captureId, @version, @algorithmVersion, @isActive, @createdAt, @updatedAt, @sourceDataRevision, @retainedStartOffset, @verified)`
			);
			profiles.forEach(profile =>
				insertProfile.run({
					id: profileIdsBySource.get(profile.id),
					captureId: duplicateCaptureId,
					version: profile.version,
					algorithmVersion: profile.algorithm_version,
					isActive: profile.is_active,
					createdAt: profile.created_at,
					updatedAt: profile.updated_at,
					sourceDataRevision: profile.source_data_revision,
					retainedStartOffset: profile.retained_start_offset,
					verified: profile.verified
				})
			);

			const insertProfileMetadataSnapshot = this.database.prepare(
				`INSERT OR REPLACE INTO framing_profile_metadata_snapshots
					(profile_id, capture_id, name, description, controller_view, baud_rate,
					 input_format, lifecycle, byte_count, folder_id, data_revision,
					 metadata_revision, content_revision, retained_start_offset, parameters_json,
					 created_at)
				 VALUES (@profileId, @captureId, @name, @description, @controllerView, @baudRate,
					 @inputFormat, @lifecycle, @byteCount, @folderId, @dataRevision,
					 @metadataRevision, @contentRevision, @retainedStartOffset, @parametersJson,
					 @createdAt)`
			);
			profileMetadataSnapshots.forEach(snapshot => {
				const profileId = profileIdsBySource.get(snapshot.profile_id);
				if (!profileId) {
					throw new CanonicalCaptureConflictError("profile metadata snapshot has no duplicated profile", {
						captureId: sourceCaptureId,
						profileId: snapshot.profile_id
					});
				}
				insertProfileMetadataSnapshot.run({
					profileId,
					captureId: duplicateCaptureId,
					name: snapshot.name,
					description: snapshot.description,
					controllerView: snapshot.controller_view,
					baudRate: snapshot.baud_rate,
					inputFormat: snapshot.input_format,
					lifecycle: snapshot.lifecycle,
					byteCount: snapshot.byte_count,
					folderId: snapshot.folder_id,
					dataRevision: snapshot.data_revision,
					metadataRevision: snapshot.metadata_revision,
					contentRevision: snapshot.content_revision,
					retainedStartOffset: snapshot.retained_start_offset,
					parametersJson: snapshot.parameters_json,
					createdAt: snapshot.created_at
				});
			});

			const insertSection = this.database.prepare(
				`INSERT INTO framing_sections
				 (id, profile_id, capture_id, start_offset, position, framing_mode, frame_length, marker_bytes, marker_position, time_gap_ms, collapse_runs, collapsed)
				 VALUES (@id, @profileId, @captureId, @startOffset, @position, @framingMode, @frameLength, @markerBytes, @markerPosition, @timeGapMs, @collapseRuns, @collapsed)`
			);
			sections.forEach(section =>
				insertSection.run({
					id: sourceSectionId(section.id),
					profileId: profileIdsBySource.get(section.profile_id),
					captureId: duplicateCaptureId,
					startOffset: section.start_offset,
					position: section.position,
					framingMode: section.framing_mode,
					frameLength: section.frame_length,
					markerBytes: section.marker_bytes,
					markerPosition: section.marker_position,
					timeGapMs: section.time_gap_ms,
					collapseRuns: section.collapse_runs,
					collapsed: section.collapsed
				})
			);

			const insertFrame = this.database.prepare(
				`INSERT INTO materialized_frames
				 (id, capture_id, profile_id, profile_version, ordinal, section_id, raw_offsets_json, bytes_json, timestamps_json, directions_json, hidden, signature)
				 VALUES (@id, @captureId, @profileId, @profileVersion, @ordinal, @sectionId, @rawOffsetsJson, @bytesJson, @timestampsJson, @directionsJson, @hidden, @signature)`
			);
				frames.forEach(frame =>
				insertFrame.run({
					id: frameIdsBySource.get(frame.id),
					captureId: duplicateCaptureId,
					profileId: profileIdsBySource.get(frame.profile_id),
					profileVersion: frame.profile_version,
					ordinal: frame.ordinal,
					sectionId: sourceSectionId(frame.section_id),
					rawOffsetsJson: frame.raw_offsets_json,
					bytesJson: frame.bytes_json,
					timestampsJson: frame.timestamps_json,
					directionsJson: frame.directions_json,
					hidden: frame.hidden,
					signature: frame.signature
					})
				);
				const insertTransitionPosition = this.database.prepare(
					`INSERT INTO frame_transition_positions
					 (profile_id, section_id, from_signature, to_signature, position, changed_count, transition_count)
					 VALUES (@profileId, @sectionId, @fromSignature, @toSignature, @position, @changedCount, @transitionCount)`
				);
				analysisTransitionPositions.forEach(row =>
					insertTransitionPosition.run({
						profileId: profileIdsBySource.get(row.profile_id),
						sectionId: sourceSectionId(row.section_id),
						fromSignature: row.from_signature,
						toSignature: row.to_signature,
						position: row.position,
						changedCount: row.changed_count,
						transitionCount: row.transition_count
					})
				);

				const insertFrameSignature = this.database.prepare("INSERT INTO frame_signatures (profile_id, signature, count) VALUES (@profileId, @signature, @count)");
			analysisFrameSignatures.forEach(row => insertFrameSignature.run({ profileId: profileIdsBySource.get(row.profile_id), signature: row.signature, count: row.count }));
			const insertTransition = this.database.prepare("INSERT INTO frame_transitions (profile_id, from_signature, to_signature, count, diffs) VALUES (@profileId, @fromSignature, @toSignature, @count, @diffs)");
			analysisTransitions.forEach(row => insertTransition.run({ profileId: profileIdsBySource.get(row.profile_id), fromSignature: row.from_signature, toSignature: row.to_signature, count: row.count, diffs: row.diffs }));
			const insertByteStatistic = this.database.prepare("INSERT INTO byte_statistics (profile_id, position, value, count) VALUES (@profileId, @position, @value, @count)");
			analysisByteStatistics.forEach(row => insertByteStatistic.run({ profileId: profileIdsBySource.get(row.profile_id), position: row.position, value: row.value, count: row.count }));
			const insertBitStatistic = this.database.prepare("INSERT INTO bit_statistics (profile_id, position, bit, percentage, variance) VALUES (@profileId, @position, @bit, @percentage, @variance)");
			analysisBitStatistics.forEach(row => insertBitStatistic.run({ profileId: profileIdsBySource.get(row.profile_id), position: row.position, bit: row.bit, percentage: row.percentage, variance: row.variance }));

			const insertGroup = this.database.prepare(
				`INSERT INTO sequence_groups (id, capture_id, profile_id, key_text, signatures_json, score, length)
				 VALUES (@id, @captureId, @profileId, @keyText, @signaturesJson, @score, @length)`
			);
			sequenceGroups.forEach(group =>
				insertGroup.run({
					id: groupIdsBySource.get(group.id),
					captureId: duplicateCaptureId,
					profileId: profileIdsBySource.get(group.profile_id),
					keyText: group.key_text,
					signaturesJson: group.signatures_json,
					score: group.score,
					length: group.length
				})
			);
			const insertOccurrence = this.database.prepare(
				`INSERT INTO sequence_occurrences
				 (group_id, occurrence_index, offset, start_frame_ordinal, start_raw_offset, end_raw_offset, length)
				 VALUES (@groupId, @occurrenceIndex, @offset, @startFrameOrdinal, @startRawOffset, @endRawOffset, @length)`
			);
			sequenceOccurrences.forEach(occurrence =>
				insertOccurrence.run({
					groupId: groupIdsBySource.get(occurrence.group_id),
					occurrenceIndex: occurrence.occurrence_index,
					offset: occurrence.offset,
					startFrameOrdinal: occurrence.start_frame_ordinal,
					startRawOffset: occurrence.start_raw_offset,
					endRawOffset: occurrence.end_raw_offset,
					length: occurrence.length
				})
			);

			const insertByteVisibility = this.database.prepare("INSERT INTO raw_byte_visibility (capture_id, raw_offset, hidden) VALUES (@captureId, @rawOffset, @hidden)");
			byteVisibility.forEach(row => insertByteVisibility.run({ captureId: duplicateCaptureId, rawOffset: row.raw_offset, hidden: row.hidden }));
			const insertFrameVisibility = this.database.prepare(
				"INSERT INTO frame_visibility (capture_id, profile_id, start_raw_offset, end_raw_offset, hidden) VALUES (@captureId, @profileId, @startRawOffset, @endRawOffset, @hidden)"
			);
			frameVisibility.forEach(row => insertFrameVisibility.run({ captureId: duplicateCaptureId, profileId: profileIdsBySource.get(row.profile_id), startRawOffset: row.start_raw_offset, endRawOffset: row.end_raw_offset, hidden: row.hidden }));

			const insertNote = this.database.prepare(
				`INSERT INTO stable_notes
				 (id, capture_id, text, created_at, updated_at, target_kind, raw_offset, profile_id, raw_offsets_json,
					 start_offset, end_offset, sequence_key, start_row, end_row, message_id, byte_position, frame_id, sequence_group_id,
					 author_type, reported_client_name, reported_client_version, protocol_version)
					 VALUES (@id, @captureId, @text, @createdAt, @updatedAt, @targetKind, @rawOffset, @profileId, @rawOffsetsJson,
					  @startOffset, @endOffset, @sequenceKey, @startRow, @endRow, @messageId, @bytePosition, @frameId, @sequenceGroupId,
					  @authorType, @reportedClientName, @reportedClientVersion, @protocolVersion)`
			);
			notes.forEach(note =>
				insertNote.run({
					id: noteIdsBySource.get(note.id),
					captureId: duplicateCaptureId,
					text: note.text,
					createdAt: note.created_at,
					updatedAt: note.updated_at,
					targetKind: note.target_kind,
					rawOffset: note.raw_offset,
					profileId: sourceProfileId(note.profile_id),
					rawOffsetsJson: note.raw_offsets_json,
					startOffset: note.start_offset,
					endOffset: note.end_offset,
					sequenceKey: note.sequence_key,
					startRow: note.start_row,
					endRow: note.end_row,
					messageId: note.message_id,
					bytePosition: note.byte_position,
					frameId: sourceFrameId(note.frame_id),
					sequenceGroupId: sourceGroupId(note.sequence_group_id),
					authorType: note.author_type,
					reportedClientName: note.reported_client_name,
					reportedClientVersion: note.reported_client_version,
					protocolVersion: note.protocol_version
				})
			);

			const insertJob = this.database.prepare(
				`INSERT INTO finalization_jobs
				 (id, capture_id, session_id, profile_id, status, created_at, updated_at, error, verified, data_revision,
				  source_data_revision, attempt_count, next_attempt_at, lease_token, lease_expires_at, started_at, completed_at)
				 VALUES (@id, @captureId, @sessionId, @profileId, @status, @createdAt, @updatedAt, @error, @verified, @dataRevision,
				  @sourceDataRevision, @attemptCount, @nextAttemptAt, @leaseToken, @leaseExpiresAt, @startedAt, @completedAt)`
			);
			jobs.forEach(job =>
				insertJob.run({
					id: jobIdsBySource.get(job.id),
					captureId: duplicateCaptureId,
					sessionId: sourceSessionId(job.session_id),
					profileId: sourceProfileId(job.profile_id),
					status: job.status,
					createdAt: job.created_at,
					updatedAt: job.updated_at,
					error: job.error,
					verified: job.verified,
					dataRevision: job.data_revision,
					sourceDataRevision: job.source_data_revision,
					attemptCount: job.attempt_count,
					nextAttemptAt: job.next_attempt_at,
					leaseToken: job.lease_token,
					leaseExpiresAt: job.lease_expires_at,
					startedAt: job.started_at,
					completedAt: job.completed_at
				})
			);

			return duplicateCaptureId;
		});

		const captureId = transaction() as string;
		const state = this.getCaptureState(captureId);
		return {
			sourceCaptureId,
			captureId,
			name: state.name,
			dataRevision: state.dataRevision,
			metadataRevision: state.metadataRevision,
			contentRevision: state.contentRevision
		};
	}

	deleteCapture(captureIdValue: string): DeleteCaptureResponse {
		const captureId = requiredString(captureIdValue, "captureId");
		const transaction = this.database.transaction(() => {
			const capture = this.database.prepare("SELECT id FROM captures WHERE id = @captureId").get({ captureId });
			if (!capture) throw new CanonicalCaptureNotFoundError(captureId);
			this.requireCanonicalStorage(captureId);

			// captures owns the canonical child graph; foreign-key cascades remove
			// chunks, sessions, profiles, materializations, analysis, and notes.
			// Conversion jobs deliberately do not use a captures foreign key so a
			// failed conversion can retain its durable failure record; delete them
			// explicitly with the capture instead.
			this.database.prepare("DELETE FROM finalization_jobs WHERE capture_id = @captureId").run({ captureId });
			this.database.prepare("DELETE FROM captures WHERE id = @captureId").run({ captureId });
			this.database.prepare("DELETE FROM capture_storage WHERE capture_id = @captureId").run({ captureId });
			this.database.prepare("DELETE FROM archive_order WHERE entity_type = 'capture' AND entity_id = @captureId").run({ captureId });
			this.database
				.prepare("UPDATE archive_state SET active_capture_id = NULL, updated_at = @updatedAt WHERE active_capture_id = @captureId")
				.run({ captureId, updatedAt: this.nowIso() });
			// These compatibility rows are not FK children of captures. Remove only
			// the deleted capture's rows so another capture remains untouched.
			this.database.prepare("DELETE FROM capture_documents WHERE id = @captureId").run({ captureId });
			this.database.prepare("DELETE FROM capture_backups WHERE capture_id = @captureId").run({ captureId });
			return { captureId, deleted: true } satisfies DeleteCaptureResponse;
		});
		return transaction() as DeleteCaptureResponse;
	}

}

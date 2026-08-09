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

export class CanonicalCaptureCommandService {
	protected readonly database: SqliteDatabase;
	protected readonly nowIso: () => string;
	protected readonly generateId: () => string;

	constructor(database: SqliteDatabase, dependencies: CanonicalCaptureCommandDependencies = {}) {
		this.database = database;
		this.nowIso = dependencies.nowIso ?? (() => new Date().toISOString());
		this.generateId = dependencies.generateId ?? randomUUID;
	}

	createCapture(_request: CreateCaptureRequest): CaptureState {
		throw new Error("CanonicalCaptureCommandService.createCapture is not implemented");
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

	getStorageStatus(_captureId: string): CaptureStorageStatusResponse {
		throw new Error("CanonicalCaptureCommandService.getStorageStatus is not implemented");
	}

	getCaptureState(_captureId: string): CaptureState {
		throw new Error("CanonicalCaptureCommandService.getCaptureState is not implemented");
	}
}

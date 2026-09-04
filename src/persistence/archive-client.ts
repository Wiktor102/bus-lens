import type {
	AppState,
	SendHistoryEntry,
	SendQueueEntry,
	SendSettings,
	StoredFolder
} from "../shared/app-state.ts";
import type { Capture } from "../features/capture/capture-framing.ts";
import type { CaptureInputFormat } from "../features/capture/capture-format.ts";

export type CanonicalStorageStatus = "canonical" | "converting" | "canonicalization-failed" | (string & {});

export type CanonicalizationStatus = "legacy-not-canonicalized" | "converting" | "canonical" | "failed";

export type CanonicalizationVerification = Readonly<{
	rawBytesMatched: boolean;
	framesMatched: boolean;
	sectionsMatched: boolean;
	notesMatched: boolean;
	analysisMatched: boolean;
}>;

export type CanonicalizationPreflight = Readonly<{
	captureId: string;
	status: CanonicalizationStatus;
	storageStatus: CanonicalStorageStatus | null;
	existingStorageStatus: CanonicalStorageStatus | null;
	captureSize: number;
	byteCount: number;
	messageCount: number;
	noteCount: number;
	recordingActive: boolean;
	isRecording: boolean;
	eligible: boolean;
	estimatedEligibility: "eligible" | "already-canonical" | "converting" | "recording-active" | "missing" | "invalid";
	activeJobId?: string;
	verification?: CanonicalizationVerification | null;
	error?: string;
}>;

export type CanonicalizationJob = Readonly<{
	id: string;
	captureId: string;
	status: "pending" | "running" | "completed" | "failed";
	progress: number;
	verified: boolean;
	verification: CanonicalizationVerification | null;
	report: Record<string, unknown> | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
}>;

export type LegacyBackupResponse = Readonly<{
	captureId: string;
	source: "legacy-document" | "recovery-backup";
	documentJson: string;
	document: Capture | null;
	verified: boolean;
}>;

export type CaptureStorageStatusResponse = Readonly<{
	captureId: string;
	status: CanonicalStorageStatus | null;
	updatedAt: string | null;
	lastError: string | null;
}>;

export type OrderedCaptureParameter = Readonly<{
	key: string;
	value: string;
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

/** Framing input for an immutable profile; section presentation is store-owned. */
export type ReframeSectionRequest = Omit<FramingSectionRequest, "collapseRuns" | "collapsed">;

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
	inputFormat: CaptureInputFormat;
	folderId?: string | null;
	parameters?: readonly OrderedCaptureParameter[];
}>;

export type CaptureMetadataPatch = Readonly<{
	name?: string;
	description?: string;
	controllerView?: string;
	view?: string;
	baudRate?: number;
	inputFormat?: CaptureInputFormat;
	folderId?: string | null;
	parameters?: readonly OrderedCaptureParameter[];
}>;

export type PatchMetadataRequest = Readonly<{
	captureId: string;
	patch: CaptureMetadataPatch;
	expectedMetadataRevision?: number;
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
	sessionId: string;
	nextChunkSequence: number;
	nextRawOffset: number;
	dataRevision: number;
}>;

export type RawChunkBytes = readonly number[] | Uint8Array;

export type RawChunkSegment = Readonly<{
	bytes: RawChunkBytes;
	timestamp?: number;
	direction?: string;
	timestamps?: readonly number[];
	directions?: readonly string[];
	sessionIds?: readonly (string | null | undefined)[];
	sessionId?: string | null;
}>;

export type RawChunkPayload = Readonly<{
	segments?: readonly RawChunkSegment[];
	bytes?: RawChunkBytes;
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
	payload?: RawChunkPayload | readonly RawChunkSegment[] | RawChunkBytes;
	bytes?: RawChunkBytes;
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
	sections: readonly ReframeSectionRequest[];
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
	frameId?: string;
	profileId?: string;
	startRawOffset?: number;
	endRawOffset?: number;
	hidden: boolean;
}>;

export type DeleteFrameVisibilityRequest = Readonly<{
	captureId: string;
	frameId: string;
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

export type ContentRevisionResponse = Readonly<{
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

/**
 * The archive/sidebar projection.  This intentionally has no messages,
 * byteStream, or other streaming payloads; it is safe to retain in Query.
 */
export type CaptureListItem = Readonly<{
	id: string;
	name: string;
	description: string;
	view: string;
	folderId: string | null;
	params: readonly OrderedCaptureParameter[];
	messageCount: number;
	storageStatus?: "legacy-not-canonicalized" | "converting" | "canonical" | "canonicalization-failed";
	lifecycle?: string;
	byteCount?: number;
	createdAt?: string;
	updatedAt?: string;
}>;

export type CanonicalCaptureSummary = Readonly<{
	id: string;
	status: "canonical" | "legacy-not-canonicalized" | "converting" | "canonicalization-failed";
	name: string;
	lifecycle: string | null;
	byteCount: number | null;
	createdAt: string;
	updatedAt: string;
	folderId: string | null;
}>;

export type ArchiveCaptureOrder = Readonly<{
	id: string;
	folderId: string | null;
	position: number;
}>;

export type ArchiveFolderOrder = Readonly<{
	id: string;
	position: number;
}>;

/** The server-owned index that determines archive order, folders, and selection. */
export type ArchiveIndex = Readonly<{
	activeId: string | null;
	unfiledCollapsed: boolean;
	captures: readonly ArchiveCaptureOrder[];
	folders: readonly ArchiveFolderOrder[];
}>;

/**
 * The browser-side command boundary. Whole capture documents are deliberately
 * absent: the only document save is the explicitly named legacy escape hatch.
 */
export interface CaptureWriter {
	createCapture(request: CreateCaptureRequest): Promise<CaptureState>;
	patchMetadata(request: PatchMetadataRequest): Promise<CaptureState>;
	startSession(request: StartSessionRequest): Promise<StartSessionResponse>;
	appendChunk(request: AppendChunkRequest): Promise<AppendChunkResponse>;
	finalizeSession(request: FinalizeSessionRequest): Promise<FinalizeSessionResponse>;
	updateFramingDraft(request: UpdateFramingDraftRequest): Promise<UpdateFramingDraftResponse>;
	reframe(request: ReframeRequest): Promise<ReframeResponse>;
	updateFramingSectionView(request: FramingSectionViewRequest): Promise<FramingSectionViewResponse>;
	setByteVisibility(request: ByteVisibilityRequest): Promise<VisibilityResponse>;
	deleteByteVisibility(captureId: string, rawOffset: number): Promise<void>;
	setFrameVisibility(request: FrameVisibilityRequest): Promise<VisibilityResponse>;
	deleteFrameVisibility(request: DeleteFrameVisibilityRequest): Promise<void>;
	listNotes(captureId: string): Promise<readonly CanonicalNote[]>;
	createNote(request: CreateNoteRequest): Promise<NoteResponse>;
	updateNote(request: UpdateNoteRequest): Promise<NoteResponse>;
	deleteNote(request: DeleteNoteRequest): Promise<ContentRevisionResponse>;
	clearData(request: ClearCaptureDataRequest): Promise<ClearCaptureDataResponse>;
	duplicate(request: DuplicateCaptureRequest): Promise<DuplicateCaptureResponse>;
	delete(captureId: string): Promise<void>;
}

export type MigrationReport = {
	fingerprint: string;
	captures: number;
	folders: number;
	rawBytes: number;
	notes: number;
	queueEntries: number;
	historyEntries: number;
};

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as object).sort().map(key => [key, canonicalize((value as Record<string, unknown>)[key])]));
	return value;
}

function jsonSafe(value: unknown): unknown {
	if (value instanceof Uint8Array) return Array.from(value);
	if (Array.isArray(value)) return value.map(jsonSafe);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)]));
	}
	return value;
}

export async function archiveFingerprint(archive: AppState): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(archive)));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function archiveReport(archive: AppState, fingerprint: string): MigrationReport {
	return {
		fingerprint,
		captures: archive.captures.length,
		folders: archive.folders.length,
		rawBytes: archive.captures.reduce((total, capture) => total + (capture.byteStream?.length ?? 0), 0),
		notes: archive.captures.reduce((total, capture) => total + (capture.notes?.length ?? 0) + Object.keys(capture.annotations ?? {}).length, 0),
		queueEntries: archive.sendQueue?.length ?? 0,
		historyEntries: archive.sendHistory?.length ?? 0
	};
}

async function request<T>(path: string, init?: RequestInit, projectId?: string | null): Promise<T> {
	const headers: Record<string, string> = { "content-type": "application/json", ...(init?.headers as Record<string, string> ?? {}) };
	if (projectId) headers["x-bus-lens-project"] = projectId;
	const response = await fetch(`/api${path}`, { ...init, headers });
	if (!response.ok) throw new Error(`Archive service ${response.status}: ${await response.text()}`);
	return response.status === 204 ? (undefined as T) : (await response.json() as T);
}

function capturePath(captureId: string): string {
	return `/captures/${encodeURIComponent(String(captureId))}`;
}

function notePath(captureId: string, noteId?: string): string {
	return `${capturePath(captureId)}/notes${noteId === undefined ? "" : `/${encodeURIComponent(String(noteId))}`}`;
}

function requestBody(body: unknown): RequestInit {
	return { body: JSON.stringify(jsonSafe(body)) };
}

function documentWithId<T extends object>(record: { id?: string; document: T }): T {
	const id = record.id || (record.document as { id?: unknown }).id;
	return id ? { ...record.document, id } as T : record.document;
}

export type ProjectSummary = Readonly<{
	id: string;
	name: string;
	dbPath: string;
	createdAt: string;
	lastUsedAt: string;
}>;

export type ArchiveClientOptions = Readonly<{
	/** Returns the project every request is routed to; absent means Default. */
	getActiveProjectId?: () => string | null | undefined;
}>;

export class ArchiveClient implements CaptureWriter {
	private readonly getActiveProjectId: () => string | null | undefined;

	constructor(options: ArchiveClientOptions = {}) {
		this.getActiveProjectId = options.getActiveProjectId ?? (() => null);
	}

	/** Every archive request is routed through here so project routing stays one line. */
	private send<T>(path: string, init?: RequestInit): Promise<T> {
		return request<T>(path, init, this.getActiveProjectId());
	}

	async listProjects(): Promise<ProjectSummary[]> {
		const payload = await this.send<{ projects: ProjectSummary[] }>("/projects");
		return Array.isArray(payload.projects) ? payload.projects : [];
	}

	async createProject(name: string): Promise<ProjectSummary> {
		return this.send<ProjectSummary>("/projects", { method: "POST", ...requestBody({ name }) });
	}

	async renameProject(projectId: string, name: string): Promise<ProjectSummary> {
		return this.send<ProjectSummary>(`/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", ...requestBody({ name }) });
	}

	async deleteProject(projectId: string): Promise<void> {
		await this.send<void>(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
	}

	async health(): Promise<void> { await this.send("/health"); }
	async load(): Promise<AppState> {
		const archive = await this.send<{
			captures: Array<{ id?: string; document: Capture }>;
			folders: Array<{ id?: string; document: StoredFolder }>;
			index: { activeId: string | null; unfiledCollapsed: boolean };
			queue: Array<{ id?: string; document: Record<string, unknown> }>;
			history: Array<{ id?: string; document: Record<string, unknown> }>;
			settings: Record<string, unknown>;
		}>("/archive");
		return {
			captures: archive.captures.map(documentWithId),
			folders: archive.folders.map(documentWithId),
			activeId: archive.index.activeId,
			unfiledCollapsed: archive.index.unfiledCollapsed,
			sendQueue: archive.queue.map(documentWithId) as AppState["sendQueue"],
			sendHistory: archive.history.map(documentWithId) as AppState["sendHistory"],
			sendSettings: archive.settings.send as AppState["sendSettings"]
		};
	}
	async loadArchiveIndex(): Promise<ArchiveIndex> {
		return this.send<ArchiveIndex>("/archive-index");
	}
	async listCaptures(): Promise<CaptureListItem[]> {
		const records = await this.send<Array<{ id?: string; document: CaptureListItem }>>("/captures");
		return records.map(documentWithId);
	}
	async listFolders(): Promise<StoredFolder[]> {
		const records = await this.send<Array<{ id?: string; document: StoredFolder }>>("/folders");
		return records.map(documentWithId);
	}
	async listQueue(): Promise<SendQueueEntry[]> {
		const records = await this.send<Array<{ id?: string; document: Record<string, unknown> }>>("/queue");
		return records.map(documentWithId) as SendQueueEntry[];
	}
	async listHistory(): Promise<SendHistoryEntry[]> {
		const records = await this.send<Array<{ id?: string; document: Record<string, unknown> }>>("/history");
		return records.map(documentWithId) as SendHistoryEntry[];
	}
	async loadSettings(): Promise<Partial<SendSettings>> {
		const settings = await this.send<{ send?: Record<string, unknown> }>("/settings");
		return (settings.send ?? {}) as Partial<SendSettings>;
	}
	async migrate(archive: AppState): Promise<MigrationReport> {
		const fingerprint = await archiveFingerprint(archive);
		const report = archiveReport(archive, fingerprint);
		await this.send("/migrations/local-storage", { method: "POST", ...requestBody({ fingerprint, archive, report }) });
		return report;
	}
	async listCaptureSummaries(): Promise<CanonicalCaptureSummary[]> {
		const summaries = await this.send<unknown>("/canonical/captures");
		if (!Array.isArray(summaries)) return [];
		return summaries.filter((summary): summary is CanonicalCaptureSummary => {
			if (!summary || typeof summary !== "object") return false;
			const value = summary as Record<string, unknown>;
			return typeof value.id === "string" && (
				value.status === "canonical" ||
				value.status === "legacy-not-canonicalized" ||
				value.status === "converting" ||
				value.status === "canonicalization-failed"
			);
		});
	}

	async getCanonicalizationPreflight(captureId: string): Promise<CanonicalizationPreflight> {
		return this.send<CanonicalizationPreflight>(`${capturePath(captureId)}/canonicalization`, { method: "GET" });
	}

	async startCanonicalization(captureId: string): Promise<CanonicalizationJob> {
		return this.send<CanonicalizationJob>(`${capturePath(captureId)}/canonicalization`, { method: "POST", ...requestBody({}) });
	}

	async getCanonicalizationJob(captureId: string, jobId: string): Promise<CanonicalizationJob> {
		return this.send<CanonicalizationJob>(
			`${capturePath(captureId)}/canonicalization/jobs/${encodeURIComponent(jobId)}`,
			{ method: "GET" }
		);
	}

	async getLegacyBackup(captureId: string): Promise<LegacyBackupResponse> {
		return this.send<LegacyBackupResponse>(`${capturePath(captureId)}/legacy-backup`, { method: "GET" });
	}

	/** Persist a legacy JSON capture only while its server storage is unconverted. */
	async saveLegacyCaptureDocument(capture: Capture): Promise<void> {
		await this.send(capturePath(String(capture.id)), { method: "PUT", ...requestBody(capture) });
	}

	async loadCapture(captureId: string): Promise<Capture> {
		const record = await this.send<{ id?: string; document: Capture }>(capturePath(captureId));
		return documentWithId(record);
	}

	async saveFolder(folder: StoredFolder): Promise<void> { await this.send(`/folders/${encodeURIComponent(folder.id)}`, { method: "PUT", ...requestBody(folder) }); }
	async deleteCapture(captureId: string): Promise<void> { await this.delete(captureId); }
	async deleteFolder(folderId: string): Promise<void> { await this.send(`/folders/${encodeURIComponent(folderId)}`, { method: "DELETE" }); }
	async saveQueueItem(item: SendQueueEntry, position?: number): Promise<void> {
		if (!item.id) throw new Error("queue item id is required");
		await this.send(`/queue/${encodeURIComponent(item.id)}`, { method: "PUT", ...requestBody({ ...item, ...(position === undefined ? {} : { position }) }) });
	}
	async deleteQueueItem(queueItemId: string): Promise<void> { await this.send(`/queue/${encodeURIComponent(queueItemId)}`, { method: "DELETE" }); }
	async saveHistoryItem(item: SendHistoryEntry): Promise<void> {
		const id = typeof item.id === "string" ? item.id : "";
		if (!id) throw new Error("history item id is required");
		await this.send(`/history/${encodeURIComponent(id)}`, { method: "PUT", ...requestBody(item) });
	}
	async deleteHistoryItem(historyItemId: string): Promise<void> { await this.send(`/history/${encodeURIComponent(historyItemId)}`, { method: "DELETE" }); }
	async saveArchiveIndex(index: ArchiveIndex): Promise<void> {
		await this.send("/archive-index", { method: "PUT", ...requestBody(index) });
	}
	async saveSendState(state: AppState): Promise<void> {
		await Promise.all((state.sendQueue ?? []).map((item, index) => this.send(`/queue/${encodeURIComponent(String(item.id ?? `queue-${index}`))}`, { method: "PUT", ...requestBody(item) })));
		await Promise.all((state.sendHistory ?? []).map((item, index) => this.send(`/history/${encodeURIComponent(String(item.id ?? `history-${index}`))}`, { method: "PUT", ...requestBody(item) })));
	}
	async saveSettings(settings: Partial<SendSettings> | undefined): Promise<void> { await this.send("/settings/send", { method: "PUT", ...requestBody(settings ?? {}) }); }
	async setApplicationSetting(key: string, value: unknown): Promise<void> {
		await this.send(`/settings/${encodeURIComponent(key)}`, { method: "PUT", ...requestBody(value) });
	}

	async createCapture(command: CreateCaptureRequest): Promise<CaptureState> {
		return this.send<CaptureState>("/captures", { method: "POST", ...requestBody(command) });
	}

	async patchMetadata(command: PatchMetadataRequest): Promise<CaptureState> {
		return this.send<CaptureState>(`${capturePath(command.captureId)}/metadata`, { method: "PATCH", ...requestBody({
			patch: command.patch,
			expectedMetadataRevision: command.expectedMetadataRevision
		}) });
	}

	async startSession(command: StartSessionRequest): Promise<StartSessionResponse> {
		return this.send<StartSessionResponse>(`${capturePath(command.captureId)}/sessions`, { method: "POST", ...requestBody({
			sessionId: command.sessionId,
			startedAt: command.startedAt
		}) });
	}

	async appendChunk(command: AppendChunkRequest): Promise<AppendChunkResponse> {
		const { captureId: _captureId, ...body } = command;
		return this.send<AppendChunkResponse>(`${capturePath(command.captureId)}/raw-chunks`, { method: "POST", ...requestBody(body) });
	}

	async finalizeSession(command: FinalizeSessionRequest): Promise<FinalizeSessionResponse> {
		return this.send<FinalizeSessionResponse>(
			`${capturePath(command.captureId)}/sessions/${encodeURIComponent(command.sessionId)}/finalize`,
			{ method: "POST", ...requestBody({ expectedDataRevision: command.expectedDataRevision }) }
		);
	}

	async updateFramingDraft(command: UpdateFramingDraftRequest): Promise<UpdateFramingDraftResponse> {
		return this.send<UpdateFramingDraftResponse>(`${capturePath(command.captureId)}/framing-draft`, { method: "PATCH", ...requestBody({
			sections: command.sections,
			expectedRevision: command.expectedRevision
		}) });
	}

	async reframe(command: ReframeRequest): Promise<ReframeResponse> {
		const { captureId: _captureId, ...body } = command;
		return this.send<ReframeResponse>(`${capturePath(command.captureId)}/framing-revisions`, { method: "POST", ...requestBody(body) });
	}

	async updateFramingSectionView(command: FramingSectionViewRequest): Promise<FramingSectionViewResponse> {
		const { captureId: _captureId, sectionId: _sectionId, profileId: _profileId, ...body } = command;
		return this.send<FramingSectionViewResponse>(
			`${capturePath(command.captureId)}/framing-sections/${encodeURIComponent(command.sectionId)}/view`,
			{ method: "PATCH", ...requestBody({ profileId: command.profileId, ...body }) }
		);
	}

	async setByteVisibility(command: ByteVisibilityRequest): Promise<VisibilityResponse> {
		return this.send<VisibilityResponse>(`${capturePath(command.captureId)}/bytes/${encodeURIComponent(String(command.rawOffset))}/visibility`, { method: "PUT", ...requestBody({ hidden: command.hidden }) });
	}

	async deleteByteVisibility(captureId: string, rawOffset: number): Promise<void> {
		await this.send<void>(`${capturePath(captureId)}/bytes/${encodeURIComponent(String(rawOffset))}/visibility`, { method: "DELETE" });
	}

	async setFrameVisibility(command: FrameVisibilityRequest): Promise<VisibilityResponse> {
		if (!command.frameId) throw new Error("frameId is required for the frame visibility endpoint");
		return this.send<VisibilityResponse>(`${capturePath(command.captureId)}/frames/${encodeURIComponent(command.frameId)}/visibility`, { method: "PUT", ...requestBody({ hidden: command.hidden }) });
	}

	async deleteFrameVisibility(command: DeleteFrameVisibilityRequest): Promise<void> {
		await this.send<void>(`${capturePath(command.captureId)}/frames/${encodeURIComponent(command.frameId)}/visibility`, { method: "DELETE" });
	}

	async listNotes(captureId: string): Promise<readonly CanonicalNote[]> {
		return this.send<readonly CanonicalNote[]>(notePath(captureId), { method: "GET" });
	}

	async createNote(command: CreateNoteRequest): Promise<NoteResponse> {
		const { captureId: _captureId, ...body } = command;
		return this.send<NoteResponse>(notePath(command.captureId), { method: "POST", ...requestBody(body) });
	}

	async updateNote(command: UpdateNoteRequest): Promise<NoteResponse> {
		const { captureId: _captureId, noteId: _noteId, ...body } = command;
		return this.send<NoteResponse>(notePath(command.captureId, command.noteId), { method: "PATCH", ...requestBody(body) });
	}

	async deleteNote(command: DeleteNoteRequest): Promise<ContentRevisionResponse> {
		return this.send<ContentRevisionResponse>(notePath(command.captureId, command.noteId), { method: "DELETE" });
	}

	async clearData(command: ClearCaptureDataRequest): Promise<ClearCaptureDataResponse> {
		return this.send<ClearCaptureDataResponse>(`${capturePath(command.captureId)}/data`, { method: "DELETE" });
	}

	async clearCaptureData(command: ClearCaptureDataRequest): Promise<ClearCaptureDataResponse> {
		return this.clearData(command);
	}

	async duplicate(command: DuplicateCaptureRequest): Promise<DuplicateCaptureResponse> {
		const { captureId: _captureId, ...body } = command;
		return this.send<DuplicateCaptureResponse>(`${capturePath(command.captureId)}/duplicate`, { method: "POST", ...requestBody(body) });
	}

	async duplicateCapture(command: DuplicateCaptureRequest): Promise<DuplicateCaptureResponse> {
		return this.duplicate(command);
	}

	async delete(captureId: string): Promise<void> {
		await this.send<void>(capturePath(captureId), { method: "DELETE" });
	}
}

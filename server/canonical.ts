import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.ts";
import {
	deriveTransitionPositionAggregates,
	persistTransitionPositionAggregates,
	type TransitionPositionAggregate
} from "./transition-positions.ts";

// Server-side canonical conversion uses the same domain engines the UI uses.
// We import the DOM-independent modules directly so verification can compare
// identical framing/analysis results.
import {
	interpretSectionRanges,
	markerBytes as parseMarkerBytes
} from "../src/domain/framing.ts";
import {
	countSignatures,
	deriveAnalysisStatistics,
	recognizeRepeatedPatterns
} from "../src/domain/analysis.ts";
import {
	reconstructLegacyByteStream,
	type LegacyFramedMessage
} from "../src/features/capture/capture-summary.ts";

// Reuse capture normalization/preview so converted frames stay byte-identical
// to the JSON-document interpretation. Dynamic import would be circular, so we
// inline the minimal helpers needed to keep the comparison deterministic.
export type RawByteRecord = {
	value: number;
	timestamp: number;
	direction?: string;
	sessionId?: string;
	hidden?: boolean;
	rawOffset?: number;
};

export type CaptureSection = {
	id?: string;
	start?: number;
	framingMode?: string;
	frameMode?: string;
	previewMode?: string;
	frameSize?: number;
	frameMarker?: string;
	markerConfigured?: boolean;
	markerPosition?: string;
	frameTimeGap?: number;
	collapseRuns?: boolean;
	collapsed?: boolean;
};

type FramedMessage = {
	bytes: number[];
	hiddenBytes?: boolean[];
};

type CaptureDocument = Record<string, unknown> & {
	id?: string;
	name?: string;
	createdAt?: string;
	byteStream?: RawByteRecord[];
	frameSections?: CaptureSection[];
	messages?: Array<FramedMessage & {
		id?: string;
		timestamp?: number;
		byteTimestamps?: number[];
		hidden?: boolean;
		directions?: string[];
		sectionId?: string;
		rawOffsets?: number[];
		_rawPositions?: number[];
		_byteStart?: number;
		_byteEnd?: number;
	}>;
	notes?: Array<Record<string, unknown>>;
	annotations?: Record<string, unknown>;
	patternRemarks?: Record<string, unknown>;
	params?: unknown[];
	previewMode?: string;
	frameSize?: number;
	frameMarker?: string;
	markerConfigured?: boolean;
	markerPosition?: string;
	frameTimeGap?: number;
	nextRawOffset?: number;
	folderId?: string | null;
	lifecycle?: string;
	captureSessions?: Array<{
		id?: string;
		firstReceivedAt?: number;
		lastReceivedAt?: number;
	}>;
};

type CaptureSessionRecord = {
	id: string;
	firstReceivedAt?: number;
	lastReceivedAt?: number;
};

type LegacyAnnotationTarget = {
	messageId: string;
	bytePosition: number | null;
};

function legacyAnnotationTarget(key: string): LegacyAnnotationTarget {
	const separator = key.indexOf(":");
	if (separator < 0) return { messageId: key, bytePosition: null };
	const bytePosition = Number(key.slice(separator + 1));
	return {
		messageId: key.slice(0, separator),
		bytePosition: Number.isSafeInteger(bytePosition) && bytePosition >= 0 ? bytePosition : null
	};
}

function numericRawOffsets(value: unknown): number[] | null {
	if (!Array.isArray(value)) return null;
	const offsets = value.map(Number);
	return offsets.every(offset => Number.isSafeInteger(offset) && offset >= 0) ? offsets : null;
}

function legacyRawOffsetsForMessage(message: Record<string, unknown> | undefined, byteStream?: RawByteRecord[]): number[] | null {
	if (!message) return null;
	const persisted = numericRawOffsets(message.rawOffsets) || numericRawOffsets(message._rawPositions);
	if (persisted) return persisted;
	const start = Number(message._byteStart);
	if (!Number.isSafeInteger(start) || start < 0 || !Array.isArray(message.bytes)) return null;
	return message.bytes.map((_, index) => byteStream?.[start + index]?.rawOffset ?? start + index);
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------
const DEFAULT_CHUNK_SIZE = 4096;

export function chunkRawBytes(
	byteStream: RawByteRecord[],
	chunkSize = DEFAULT_CHUNK_SIZE
): Array<{
	startOffset: number;
	bytes: Buffer;
	timestamps: number[];
	directions: string[];
	hidden: boolean[];
	sessionIds: Array<string | null>;
}> {
	const chunks: Array<{
		startOffset: number;
		bytes: Buffer;
		timestamps: number[];
		directions: string[];
		hidden: boolean[];
		sessionIds: Array<string | null>;
	}> = [];
	for (let offset = 0; offset < byteStream.length; offset += chunkSize) {
		const slice = byteStream.slice(offset, offset + chunkSize);
		chunks.push({
			startOffset: slice[0]?.rawOffset ?? offset,
			bytes: Buffer.from(slice.map(r => r.value & 0xff)),
			timestamps: slice.map(r => r.timestamp),
			directions: slice.map(r => r.direction || "rx"),
			hidden: slice.map(r => Boolean(r.hidden)),
			sessionIds: slice.map(r => r.sessionId ?? null)
		});
	}
	return chunks;
}

// ---------------------------------------------------------------------------
// Framing helpers — mirrors src/features/capture/capture-framing.ts semantics
// ---------------------------------------------------------------------------
function normalizeFramingMode(value: unknown): "length" | "marker" | "time" {
	const mode = String(value || "").trim().toLowerCase();
	if (mode === "marker") return "marker";
	if (mode === "time" || mode === "time-gap" || mode === "timegap") return "time";
	return "length";
}
function normalizeMarkerPosition(value: unknown): "start" | "end" {
	return String(value || "").trim().toLowerCase() === "end" ? "end" : "start";
}
function normalizeFrameSize(value: unknown, fallback = 3): number {
	const n = Math.floor(Number(value));
	return Math.max(1, Math.min(1024, n || fallback));
}
function normalizeFrameTimeGap(value: unknown, fallback = 5): number {
	const n = Number(value);
	return Math.max(0.01, n || fallback);
}
function normalizeMarker(value: unknown, configured = true): string {
	if (!configured) return "";
	return parseMarkerBytes(value).map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}
function sectionModeValue(section: CaptureSection): unknown {
	return section.framingMode ?? section.frameMode ?? section.previewMode;
}
function normalizeSectionSettings(section: CaptureSection) {
	const configured = section.markerConfigured === undefined ? true : Boolean(section.markerConfigured);
	return {
		framingMode: normalizeFramingMode(sectionModeValue(section)),
		frameSize: normalizeFrameSize(section.frameSize),
		frameMarker: normalizeMarker(section.frameMarker, configured),
		markerPosition: normalizeMarkerPosition(section.markerPosition),
		frameTimeGap: normalizeFrameTimeGap(section.frameTimeGap)
	};
}

export type NormalizedSection = {
	id: string;
	start: number;
	framingMode: "length" | "marker" | "time";
	frameSize: number;
	frameMarker: string;
	markerPosition: "start" | "end";
	frameTimeGap: number;
	collapseRuns: boolean;
	collapsed: boolean;
};

export function normalizeSectionsForConversion(
	sections: CaptureSection[],
	byteStream: RawByteRecord[],
	fallbackFrameSize = 3,
	generateSectionId: () => string = randomUUID as unknown as () => string,
	firstOffsetOverride = 0
): NormalizedSection[] {
	const firstOffset = byteStream[0]?.rawOffset ?? firstOffsetOverride;
	const lastOffset = byteStream.at(-1)?.rawOffset ?? 0;
	const byStart = new Map<number, CaptureSection>();
	(sections || [])
		.filter(s => Boolean(s && typeof s === "object"))
		.forEach(section => {
			const start = Math.max(firstOffset, Math.min(lastOffset, Math.floor(Number(section.start) || firstOffset)));
			const settings = normalizeSectionSettings(section);
			byStart.set(start, {
				start,
				...settings,
				collapseRuns: Boolean(section.collapseRuns),
				collapsed: Boolean(section.collapsed)
			});
		});
	if (!byStart.has(firstOffset)) {
		byStart.set(firstOffset, {
			start: firstOffset,
			framingMode: "length",
			frameSize: fallbackFrameSize,
			frameMarker: "",
			markerPosition: "start" as const,
			frameTimeGap: 5,
			collapseRuns: false,
			collapsed: false
		});
	}
	return [...byStart.values()]
		.sort((a, b) => (a.start as number) - (b.start as number))
		.map(s => ({
			// Legacy section ids were capture-local. Allocate canonical ids after
			// section normalization so every materialized profile gets identities
			// that are independent of the source document.
			id: generateSectionId(),
			start: s.start as number,
			framingMode: s.framingMode as "length" | "marker" | "time",
			frameSize: s.frameSize as number,
			frameMarker: s.frameMarker as string,
			markerPosition: s.markerPosition as "start" | "end",
			frameTimeGap: s.frameTimeGap as number,
			collapseRuns: Boolean(s.collapseRuns),
			collapsed: Boolean(s.collapsed)
		}));
}

function hexByte(byte: number): string {
	return byte.toString(16).padStart(2, "0").toUpperCase();
}
function visibleEntries(message: FramedMessage): Array<{ value: number; rawPosition: number }> {
	return message.bytes
		.map((value, rawPosition) => ({ value, rawPosition}))
		.filter(({ rawPosition }) => !message.hiddenBytes?.[rawPosition]);
}
function signatureForMessage(message: FramedMessage): string {
	return visibleEntries(message).map(({ value }) => hexByte(value)).join(" ");
}

export type ExistingMessage = {
	id?: string;
	sectionId?: string;
	hidden?: boolean;
	bytes: number[];
	rawOffsets?: number[];
	_rawPositions?: number[];
	_byteStart?: number;
	_byteEnd?: number;
};

function legacyMessageRawOffsets(message: ExistingMessage): number[] {
	const persistedOffsets = [message.rawOffsets, message._rawPositions].find(offsets => Array.isArray(offsets) && offsets.length);
	if (persistedOffsets) {
		return persistedOffsets
			.map(offset => normalizedRawOffset(offset))
			.filter((offset): offset is number => offset !== undefined);
	}
	const start = normalizedRawOffset(message._byteStart);
	if (start === undefined) return [];
	const end = normalizedRawOffset(message._byteEnd);
	const length = end !== undefined && end >= start ? end - start : message.bytes.length;
	return Array.from({ length: Math.max(0, length) }, (_, index) => start + index);
}

function rawOffsetsKey(rawOffsets: readonly number[]): string {
	return rawOffsets.join(",");
}

function rawSpanKey(rawOffsets: readonly number[]): string | undefined {
	if (!rawOffsets.length) return undefined;
	return `${rawOffsets[0]}:${rawOffsets.at(-1)}`;
}

type ExistingMessageIndex = {
	byRawOffsets: Map<string, ExistingMessage>;
	byRawSpan: Map<string, ExistingMessage>;
};

function indexExistingMessages(messages: readonly ExistingMessage[] = []): ExistingMessageIndex {
	const byRawOffsets = new Map<string, ExistingMessage>();
	const byRawSpan = new Map<string, ExistingMessage>();
	for (const message of messages) {
		const rawOffsets = legacyMessageRawOffsets(message);
		if (!rawOffsets.length) continue;
		byRawOffsets.set(rawOffsetsKey(rawOffsets), message);
		const span = rawSpanKey(rawOffsets);
		if (span) byRawSpan.set(span, message);
	}
	return { byRawOffsets, byRawSpan };
}

function findExistingMessage(index: ExistingMessageIndex, rawOffsets: readonly number[]): ExistingMessage | undefined {
	return index.byRawOffsets.get(rawOffsetsKey(rawOffsets)) || index.byRawSpan.get(rawSpanKey(rawOffsets) || "");
}

// Materialize frames from a compact hidden-filtered stream using domain engine.
export function materializeFramesFromStream(
	stream: Array<RawByteRecord & { rawOffset: number }>,
	sections: NormalizedSection[],
	generateId: () => string = randomUUID as unknown as () => string,
	existingMessages: readonly ExistingMessage[] = []
): Array<{
	id: string;
	ordinal: number;
	sectionId: string;
	rawOffsets: number[];
	bytes: number[];
	timestamps: number[];
	directions: string[];
	hidden: boolean;
	signature: string;
}> {
	type PreviewRecord = {
		value: number;
		timestamp: number;
		rawPosition: number;
		source: RawByteRecord & { rawOffset: number };
	};
	const existingMessagesByIdentity = indexExistingMessages(existingMessages);
	const preview = stream
		.filter(record => !record.hidden)
		.map(record => ({
			value: record.value,
			timestamp: record.timestamp,
			rawPosition: record.rawOffset,
			source: record
		}));
	// sections are already normalized and sorted
	const ranges: Array<[number, number, string]> = [];
	sections.forEach((section, idx) => {
		const start = preview.findIndex(r => r.rawPosition >= section.start);
		const nextRawStart = sections[idx + 1]?.start;
		const nextStart = nextRawStart === undefined ? -1 : preview.findIndex(r => r.rawPosition >= nextRawStart);
		const end = nextStart < 0 ? preview.length : nextStart;
		if (start < 0 || start >= end) return;
		const settings = {
			framingMode: section.framingMode,
			frameSize: section.frameSize,
			frameMarker: section.frameMarker,
			markerPosition: section.markerPosition,
			frameTimeGap: section.frameTimeGap
		};
		const sub = interpretSectionRanges({ stream: preview as PreviewRecord[], start, end, settings });
		for (const [s, e] of sub) ranges.push([s, e, section.id]);
	});
	return ranges
		.filter(([s, e]) => e > s)
		.map(([start, end, sectionId], ordinal) => {
			const records = preview.slice(start, end);
			const rawOffsets = records.map(r => r.rawPosition);
			const previous = findExistingMessage(existingMessagesByIdentity, rawOffsets);
			// Preview records retain their source records, avoiding a linear stream
			// lookup for every frame byte.
			const bytes = records.map(record => record.value);
			const timestamps = records.map(record => record.timestamp);
			const directions = records.map(record => record.source.direction || "rx");
			const hidden = Boolean(previous?.hidden);
			const sig = bytes.map(hexByte).join(" ");
			return {
				id: previous?.id || generateId(),
				ordinal,
				sectionId,
				rawOffsets,
				bytes,
				timestamps,
				directions,
				hidden,
				signature: sig
			};
		});
}

// ---------------------------------------------------------------------------
// Normalization of rawOffsets and lifecycle - mirrors capture-framing
// ---------------------------------------------------------------------------
function normalizedRawOffset(value: unknown): number | undefined {
	const offset = Number(value);
	return Number.isInteger(offset) && offset >= 0 ? offset : undefined;
}
function ensureRawOffsets(byteStream: RawByteRecord[], nextRawOffset?: number): number {
	let next = normalizedRawOffset(nextRawOffset) ?? 0;
	for (const r of byteStream) {
		const off = normalizedRawOffset(r.rawOffset);
		if (off !== undefined) next = Math.max(next, off + 1);
	}
	for (const r of byteStream) {
		if (normalizedRawOffset(r.rawOffset) === undefined) r.rawOffset = next++;
	}
	return Math.max(next, ...byteStream.map(r => (r.rawOffset ?? 0) + 1), 0);
}

function finiteTimestamp(value: unknown): number | undefined {
	const timestamp = Number(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function normalizeSessionData(
	document: CaptureDocument,
	byteStream: Array<RawByteRecord & { rawOffset?: number }>,
	generateId: () => string
): { byteStream: Array<RawByteRecord & { rawOffset?: number }>; sessions: CaptureSessionRecord[] } {
	const sessions: CaptureSessionRecord[] = [];
	const byId = new Map<string, CaptureSessionRecord>();
	for (const candidate of Array.isArray(document.captureSessions) ? document.captureSessions : []) {
		const id = String(candidate?.id || "").trim();
		if (!id || byId.has(id)) continue;
		const session: CaptureSessionRecord = { id };
		const firstReceivedAt = finiteTimestamp(candidate.firstReceivedAt);
		const lastReceivedAt = finiteTimestamp(candidate.lastReceivedAt);
		if (firstReceivedAt !== undefined) session.firstReceivedAt = firstReceivedAt;
		if (lastReceivedAt !== undefined) session.lastReceivedAt = lastReceivedAt;
		byId.set(id, session);
		sessions.push(session);
	}

	const ensureSession = (id: string): CaptureSessionRecord => {
		const existing = byId.get(id);
		if (existing) return existing;
		const session: CaptureSessionRecord = { id };
		byId.set(id, session);
		sessions.push(session);
		return session;
	};

	let fallbackSessionId: string | undefined;
	const sessionIdForRecord = (record: RawByteRecord): string | undefined => {
		const explicit = typeof record.sessionId === "string" && record.sessionId.trim() ? record.sessionId.trim() : undefined;
		if (explicit) return explicit;
		if (sessions.length === 1) return sessions[0].id;
		if (sessions.length === 0) {
			fallbackSessionId ||= generateId();
			return fallbackSessionId;
		}
		return undefined;
	};

	const normalizedStream = byteStream.map(record => {
		const sessionId = sessionIdForRecord(record);
		if (!sessionId) return record;
		const session = ensureSession(sessionId);
		if (record.direction !== "tx") {
			const timestamp = finiteTimestamp(record.timestamp);
			if (timestamp !== undefined) {
				if (session.firstReceivedAt === undefined || timestamp < session.firstReceivedAt) session.firstReceivedAt = timestamp;
				if (session.lastReceivedAt === undefined || timestamp > session.lastReceivedAt) session.lastReceivedAt = timestamp;
			}
		}
		return record.sessionId === sessionId ? record : { ...record, sessionId };
	});

	return { byteStream: normalizedStream, sessions };
}

function normalizeDocumentForConversion(
	doc: CaptureDocument,
	generateId: () => string = randomUUID as unknown as () => string,
	generateSectionId: () => string = generateId
): CaptureDocument {
	// Minimal normalization sufficient for verification: ensure byteStream, sections, etc
	const cloned: CaptureDocument = JSON.parse(JSON.stringify(doc));
	if (!Array.isArray(cloned.byteStream)) {
		cloned.byteStream = reconstructLegacyByteStream(
			(Array.isArray(cloned.messages) ? cloned.messages : []) as LegacyFramedMessage[]
		);
	}
	if (!Array.isArray(cloned.frameSections) || !cloned.frameSections.length) {
		// migrate legacy global framing
		const legacyMode = normalizeFramingMode(cloned.previewMode);
		const configured = cloned.markerConfigured === undefined ? Boolean(cloned.frameMarker && cloned.frameMarker !== "0A") : Boolean(cloned.markerConfigured);
		const firstOff = ensureRawOffsets(cloned.byteStream as RawByteRecord[], cloned.nextRawOffset);
		// ensure offsets first
		ensureRawOffsets(cloned.byteStream as RawByteRecord[], cloned.nextRawOffset);
		const firstOffset = (cloned.byteStream as RawByteRecord[])[0]?.rawOffset ?? 0;
		cloned.frameSections = [
			{
				start: firstOffset,
				framingMode: legacyMode,
				frameSize: normalizeFrameSize(cloned.frameSize),
				frameMarker: normalizeMarker(cloned.frameMarker, configured),
				markerPosition: normalizeMarkerPosition(cloned.markerPosition),
				frameTimeGap: normalizeFrameTimeGap(cloned.frameTimeGap),
				collapseRuns: false,
				collapsed: false
			}
		];
	}
	ensureRawOffsets(cloned.byteStream as RawByteRecord[], cloned.nextRawOffset);
	(cloned.byteStream as RawByteRecord[]).forEach(r => {
		r.direction ||= "rx";
		r.hidden = Boolean(r.hidden);
	});
	const normalizedSessionData = normalizeSessionData(
		cloned,
		cloned.byteStream as Array<RawByteRecord & { rawOffset?: number }>,
		generateId
	);
	cloned.byteStream = normalizedSessionData.byteStream;
	cloned.captureSessions = normalizedSessionData.sessions;
	// Normalize sections
	const sections = normalizeSectionsForConversion(
		(cloned.frameSections as CaptureSection[]) || [],
		cloned.byteStream as RawByteRecord[],
		normalizeFrameSize(cloned.frameSize),
		generateSectionId
	);
	cloned.frameSections = sections as unknown as CaptureSection[];
	// Derive messages via materialization (hidden filtered)
	const stream = (cloned.byteStream as Array<RawByteRecord & { rawOffset: number }>);
	const frames = materializeFramesFromStream(stream, sections, generateId, cloned.messages || []);
	cloned.messages = frames.map(f => ({
		id: f.id,
		timestamp: f.timestamps[0] ?? Date.now(),
		byteTimestamps: f.timestamps,
		bytes: f.bytes,
		directions: f.directions,
		hidden: f.hidden,
		hiddenBytes: f.bytes.map(() => false),
		sectionId: f.sectionId,
		rawOffsets: f.rawOffsets,
		_rawPositions: f.rawOffsets,
		_byteStart: 0,
		_byteEnd: f.bytes.length
	}));
	return cloned;
}

type MaterializedFrame = ReturnType<typeof materializeFramesFromStream>[number];

export type CanonicalMaterialization = {
	stream: Array<RawByteRecord & { rawOffset: number }>;
	sections: NormalizedSection[];
	frames: ReturnType<typeof materializeFramesFromStream>;
	signatures: ReturnType<typeof countSignatures>;
	stats: ReturnType<typeof deriveAnalysisStatistics>;
	patterns: ReturnType<typeof recognizeRepeatedPatterns>;
};

/**
 * Build the complete canonical derived view from one raw stream. Callers may
 * pass a stream whose `hidden` flags already include independent visibility
 * overrides; this helper never reads persistence or mutates the stream.
 */
export function buildCanonicalMaterialization(
	stream: Array<RawByteRecord & { rawOffset: number }>,
	sections: NormalizedSection[],
	options: { generateId?: () => string; existingMessages?: readonly ExistingMessage[] } = {}
): CanonicalMaterialization {
	const generateId = (options.generateId ?? randomUUID) as unknown as () => string;
	const frames = materializeFramesFromStream(stream, sections, generateId, options.existingMessages ?? []);
	const analysisFrames = frames.map(frame => ({ signature: frame.signature, bytes: frame.bytes }));
	const stats = deriveAnalysisStatistics(analysisFrames);
	const signatures = countSignatures(analysisFrames.map(frame => frame.signature));
	const patterns = recognizeRepeatedPatterns(
		frames.map((frame, index) => ({ signature: frame.signature, originalIndex: index, sectionId: frame.sectionId }))
	);
	return { stream, sections, frames, signatures, stats, patterns };
}
type SectionBoundary = { id: string; start: number; mode: string };

type PersistedConversion = {
	byteCount: number;
	byteStream: Array<RawByteRecord & { rawOffset: number }>;
	captureSessions: CaptureSessionRecord[];
	sections: SectionBoundary[];
	frames: MaterializedFrame[];
	signatures: ReturnType<typeof countSignatures>;
	stats: ReturnType<typeof deriveAnalysisStatistics>;
	transitionPositions: TransitionPositionAggregate[];
	patterns: ReturnType<typeof recognizeRepeatedPatterns>;
};

function readPersistedConversion(database: SqliteDatabase, captureId: string, profileId: string): PersistedConversion {
	const capture = database.prepare("SELECT byte_count FROM captures WHERE id = @captureId").get({ captureId }) as
		| { byte_count: number }
		| undefined;
	if (!capture) throw new Error(`canonical capture ${captureId} was not persisted`);

	const chunks = database
		.prepare("SELECT bytes, timestamps_json, directions_json, hidden_json, start_offset, session_id, session_ids_json FROM raw_chunks WHERE capture_id = @captureId ORDER BY chunk_index")
		.all({ captureId }) as Array<{
		bytes: Buffer;
		timestamps_json: string;
		directions_json: string;
		hidden_json: string;
		start_offset: number;
		session_id: string | null;
		session_ids_json: string;
	}>;
	const byteStream: Array<RawByteRecord & { rawOffset: number }> = [];
	for (const chunk of chunks) {
		const timestamps: number[] = JSON.parse(chunk.timestamps_json) as number[];
		const directions: string[] = JSON.parse(chunk.directions_json) as string[];
		const hidden: boolean[] = JSON.parse(chunk.hidden_json) as boolean[];
		const sessionIds: Array<string | null> = JSON.parse(chunk.session_ids_json || "[]") as Array<string | null>;
		const bytes = chunk.bytes instanceof Buffer ? [...chunk.bytes] : Array.from(new Uint8Array(chunk.bytes as unknown as Uint8Array));
		for (let index = 0; index < bytes.length; index++) {
			const sessionId = sessionIds[index] || chunk.session_id || undefined;
			byteStream.push({
				rawOffset: chunk.start_offset + index,
				value: bytes[index],
				timestamp: timestamps[index] ?? 0,
				direction: directions[index] || "rx",
				hidden: Boolean(hidden[index]),
				...(sessionId ? { sessionId } : {})
			});
		}
	}
	const captureSessions = database
		.prepare("SELECT id, first_received_at, last_received_at FROM capture_sessions WHERE capture_id = @captureId ORDER BY ordinal")
		.all({ captureId }) as Array<{ id: string; first_received_at: number | null; last_received_at: number | null }>;

	const sections = database
		.prepare("SELECT id, start_offset, framing_mode FROM framing_sections WHERE profile_id = @profileId ORDER BY position")
		.all({ profileId }) as Array<{ id: string; start_offset: number; framing_mode: string }>;

	const frameRows = database
		.prepare(
			"SELECT id, ordinal, section_id, raw_offsets_json, bytes_json, timestamps_json, directions_json, hidden, signature FROM materialized_frames WHERE profile_id = @profileId ORDER BY ordinal"
		)
		.all({ profileId }) as Array<{
		id: string;
		ordinal: number;
		section_id: string;
		raw_offsets_json: string;
		bytes_json: string;
		timestamps_json: string;
		directions_json: string;
		hidden: number;
		signature: string;
	}>;
	const frames: MaterializedFrame[] = frameRows.map(frame => ({
		id: frame.id,
		ordinal: frame.ordinal,
		sectionId: frame.section_id,
		rawOffsets: JSON.parse(frame.raw_offsets_json) as number[],
		bytes: JSON.parse(frame.bytes_json) as number[],
		timestamps: JSON.parse(frame.timestamps_json) as number[],
		directions: JSON.parse(frame.directions_json) as string[],
		hidden: Boolean(frame.hidden),
		signature: frame.signature
	}));

	const signatureRows = database
		.prepare("SELECT signature, count FROM frame_signatures WHERE profile_id = @profileId ORDER BY rowid")
		.all({ profileId }) as Array<{ signature: string; count: number }>;
	const signatures = new Map(signatureRows.map(row => [row.signature, row.count]));

	const transitionRows = database
		.prepare("SELECT from_signature, to_signature, count, diffs FROM frame_transitions WHERE profile_id = @profileId ORDER BY rowid")
		.all({ profileId }) as Array<{ from_signature: string; to_signature: string; count: number; diffs: number }>;
	const transitionPositionRows = database
		.prepare(
			`SELECT section_id, from_signature, to_signature, position, changed_count, transition_count
			 FROM frame_transition_positions WHERE profile_id = @profileId
			 ORDER BY section_id, from_signature, to_signature, position`
		)
		.all({ profileId }) as Array<{
		section_id: string;
		from_signature: string;
		to_signature: string;
		position: number;
		changed_count: number;
		transition_count: number;
	}>;

	const vocabularyRows = database
		.prepare("SELECT position, value, count FROM byte_statistics WHERE profile_id = @profileId ORDER BY position, rowid")
		.all({ profileId }) as Array<{ position: number; value: number; count: number }>;
	const vocabularyByPosition = new Map<number, Array<{ value: number; count: number }>>();
	for (const row of vocabularyRows) {
		const values = vocabularyByPosition.get(row.position) || [];
		values.push({ value: row.value, count: row.count });
		vocabularyByPosition.set(row.position, values);
	}
	const vocabularyWidth = Math.max(-1, ...vocabularyRows.map(row => row.position));
	const vocabulary = Array.from({ length: vocabularyWidth + 1 }, (_, position) => vocabularyByPosition.get(position) || []);

	const bitRows = database
		.prepare("SELECT position, bit, percentage, variance FROM bit_statistics WHERE profile_id = @profileId ORDER BY position, rowid")
		.all({ profileId }) as Array<{ position: number; bit: number; percentage: number; variance: string }>;
	const bitsByPosition = new Map<number, Array<{ bit: number; percentage: number; variance: string }>>();
	for (const row of bitRows) {
		const bits = bitsByPosition.get(row.position) || [];
		bits.push({ bit: row.bit, percentage: row.percentage, variance: row.variance });
		bitsByPosition.set(row.position, bits);
	}
	const bitWidth = Math.max(-1, ...bitRows.map(row => row.position));
	const bitVariance = Array.from({ length: bitWidth + 1 }, (_, position) => bitsByPosition.get(position) || []);

	const groupRows = database
		.prepare("SELECT id, key_text, signatures_json, score, length FROM sequence_groups WHERE profile_id = @profileId ORDER BY rowid")
		.all({ profileId }) as Array<{ id: string; key_text: string; signatures_json: string; score: number; length: number }>;
	const groupIndexById = new Map(groupRows.map((group, index) => [group.id, index]));
	const occurrenceRows = database
		.prepare(
			`SELECT group_id, occurrence_index, offset, start_frame_ordinal
			 FROM sequence_occurrences
			 WHERE group_id IN (SELECT id FROM sequence_groups WHERE profile_id = @profileId)
			 ORDER BY rowid`
		)
		.all({ profileId }) as Array<{
		group_id: string;
		occurrence_index: number;
		offset: number;
		start_frame_ordinal: number;
	}>;
	const startsByGroup = new Map<string, Map<number, number>>();
	const orderedOccurrences = [...occurrenceRows].sort((a, b) => {
		const groupA = groupIndexById.get(a.group_id) ?? Number.MAX_SAFE_INTEGER;
		const groupB = groupIndexById.get(b.group_id) ?? Number.MAX_SAFE_INTEGER;
		return groupA - groupB || a.occurrence_index - b.occurrence_index || a.offset - b.offset;
	});
	const membership: Array<{ groupIndex: number; originalIndex: number; occurrenceIndex: number; offset: number }> = [];
	for (const row of orderedOccurrences) {
		const groupIndex = groupIndexById.get(row.group_id);
		if (groupIndex === undefined) throw new Error(`sequence occurrence ${row.group_id} has no group`);
		const starts = startsByGroup.get(row.group_id) || new Map<number, number>();
		starts.set(row.occurrence_index, row.start_frame_ordinal);
		startsByGroup.set(row.group_id, starts);
		membership.push({
			groupIndex,
			originalIndex: row.start_frame_ordinal + row.offset,
			occurrenceIndex: row.occurrence_index,
			offset: row.offset
		});
	}
	const patterns = {
		groups: groupRows.map(group => ({
			key: group.key_text,
			length: group.length,
			starts: [...(startsByGroup.get(group.id) || new Map()).entries()]
				.sort(([left], [right]) => left - right)
				.map(([, start]) => start),
			signatures: JSON.parse(group.signatures_json) as string[],
			score: group.score
		})),
		membership
	};

	return {
		byteCount: capture.byte_count,
		byteStream,
		captureSessions: captureSessions.map(session => ({
			id: session.id,
			...(session.first_received_at === null ? {} : { firstReceivedAt: session.first_received_at }),
			...(session.last_received_at === null ? {} : { lastReceivedAt: session.last_received_at })
		})),
		sections: sections.map(section => ({ id: section.id, start: section.start_offset, mode: section.framing_mode })),
		frames,
		signatures,
		stats: {
			signatures: signatureRows.map(row => ({ signature: row.signature, count: row.count })),
			vocabulary,
			bitVariance,
				transitions: transitionRows.map(row => ({ from: row.from_signature, to: row.to_signature, count: row.count, diffs: row.diffs }))
			},
			transitionPositions: transitionPositionRows.map(row => ({
				sectionId: row.section_id,
				fromSignature: row.from_signature,
				toSignature: row.to_signature,
				position: row.position,
				changedCount: row.changed_count,
				transitionCount: row.transition_count
			})),
			patterns,
	};
}

export type VerificationReport = {
	messageCount: { expected: number; actual: number; ok: boolean };
	rawByteCount: { expected: number; actual: number; ok: boolean };
	sectionBoundaries: { expected: Array<{ id: string; start: number; mode: string }>; actual: Array<{ id: string; start: number; mode: string }>; ok: boolean };
	signaturesOk: boolean;
	byteStatisticsOk: boolean;
	bitStatisticsOk: boolean;
	transitionsOk: boolean;
	transitionPositionsOk: boolean;
	sequenceGroupsOk: boolean;
	messageVisibilityOk: boolean;
	sessionIdentityOk: boolean;
	overallOk: boolean;
	details?: string;
};

function verifyMessageVisibility(
	originalDoc: CaptureDocument,
	frames: ReadonlyArray<ReturnType<typeof materializeFramesFromStream>[number]>,
	retainedStartOffset?: number
): boolean {
	const legacyMessages = (Array.isArray(originalDoc.messages) ? originalDoc.messages : []) as ExistingMessage[];
	if (!legacyMessages.length) return true;

	const framesByRawOffsets = new Map<string, ReturnType<typeof materializeFramesFromStream>[number]>();
	const framesByRawSpan = new Map<string, ReturnType<typeof materializeFramesFromStream>[number]>();
	for (const frame of frames) {
		framesByRawOffsets.set(rawOffsetsKey(frame.rawOffsets), frame);
		const span = rawSpanKey(frame.rawOffsets);
		if (span) framesByRawSpan.set(span, frame);
	}

	for (const message of legacyMessages) {
		const rawOffsets = legacyMessageRawOffsets(message);
		if (!rawOffsets.length) {
			// A hidden message without a stable span cannot be safely carried
			// forward, so fail verification instead of making it visible.
			if (Boolean(message.hidden)) return false;
			continue;
		}
		if (retainedStartOffset !== undefined) {
			const hasRetainedBytes = rawOffsets.some(offset => offset >= retainedStartOffset);
			const hasEvictedBytes = rawOffsets.some(offset => offset < retainedStartOffset);
			// A frame straddling the rolling boundary is intentionally rebuilt from
			// the retained suffix, so there is no legacy frame identity to compare.
			if (!hasRetainedBytes || (hasEvictedBytes && hasRetainedBytes)) continue;
		}
		const frame = framesByRawOffsets.get(rawOffsetsKey(rawOffsets)) || framesByRawSpan.get(rawSpanKey(rawOffsets) || "");
		if (!frame) {
			if (Boolean(message.hidden)) return false;
			continue;
		}
		if (Boolean(message.hidden) !== frame.hidden) return false;
	}
	return true;
}

function verifyConversion(
	originalDoc: CaptureDocument,
	normalized: CaptureDocument,
	persisted: PersistedConversion,
	options: {
		sourceMessages?: Array<FramedMessage & { id?: string; sectionId?: string; rawOffsets?: number[]; _rawPositions?: number[] }>;
		expectedSections?: NormalizedSection[];
		retainedStartOffset?: number;
	} = {}
): VerificationReport {
	// A document with an explicit messages array gives us an independent legacy
	// source to validate. Raw-only documents have no message source, so their
	// normalized framing is the source representation for this comparison.
	const sourceMessages = (options.sourceMessages || (Array.isArray(originalDoc.messages) && originalDoc.messages.length > 0 ? originalDoc.messages : normalized.messages || [])) as Array<
		FramedMessage & { id?: string; sectionId?: string }
	>;
	const expectedMessages = sourceMessages.length;
	const actualMessages = persisted.frames.length;
	const expectedRawBytes = (normalized.byteStream as RawByteRecord[])?.length ?? 0;
	const actualRawBytes = persisted.byteCount;
	const expectedSessions = (Array.isArray(normalized.captureSessions) ? normalized.captureSessions : []) as CaptureSessionRecord[];
	const actualSessions = persisted.captureSessions;
	const sessionIdentityOk = JSON.stringify(expectedSessions) === JSON.stringify(actualSessions);
	const rawBytesOk =
		expectedRawBytes === persisted.byteStream.length &&
		(normalized.byteStream as RawByteRecord[]).every((expected, index) => {
			const actual = persisted.byteStream[index];
			return (
				actual !== undefined &&
				(expected.value & 0xff) === actual.value &&
				(expected.timestamp ?? 0) === actual.timestamp &&
				(expected.direction || "rx") === actual.direction &&
				Boolean(expected.hidden) === Boolean(actual.hidden) &&
				(expected.sessionId || undefined) === (actual.sessionId || undefined) &&
				(expected.rawOffset ?? index) === actual.rawOffset
			);
		});
	const messageVisibilityOk = verifyMessageVisibility(originalDoc, persisted.frames, options.retainedStartOffset);

	const expectedSections = (options.expectedSections || (normalized.frameSections as NormalizedSection[]) || []).map(s => ({
		id: s.id,
		start: s.start,
		mode: s.framingMode
	}));
	const actualSections = persisted.sections.map(section => ({
		id: section.id,
		start: section.start,
		mode: section.mode
	}));
	const sectionsOk = JSON.stringify(expectedSections) === JSON.stringify(actualSections);

	// Derive expected analysis from the original messages, never from the rebuilt
	// messages on `normalized`. Rebuilding is the conversion under test.
	const expectedStats = deriveAnalysisStatistics(
		sourceMessages.map(m => ({
			signature: signatureForMessage(m),
			bytes: visibleEntries(m).map(e => e.value)
		}))
	);
	const sortedStats = (stats: ReturnType<typeof deriveAnalysisStatistics>) => ({
		signatures: [...stats.signatures].sort((a, b) => a.signature.localeCompare(b.signature)),
		vocabulary: stats.vocabulary.map(values => [...values].sort((a, b) => a.value - b.value)),
		bitVariance: stats.bitVariance.map(values =>
			values
				.map(cell => ({ bit: cell.bit, variance: cell.variance, percentage: cell.percentage }))
				.sort((a, b) => a.bit - b.bit)
		),
		transitions: [...stats.transitions].sort((a, b) => `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`))
	});
	const expectedSortedStats = sortedStats(expectedStats);
	const actualSortedStats = sortedStats(persisted.stats);
	const statsOk = JSON.stringify(expectedSortedStats) === JSON.stringify(actualSortedStats);

	const expectedFrameSignatures = sourceMessages.map(signatureForMessage);
	const actualFrameSignatures = persisted.frames.map(frame => frame.signature);
	const persistedSignatureCounts = [...countSignatures(actualFrameSignatures).entries()].sort(([a], [b]) => a.localeCompare(b));
	const storedSignatureCounts = [...persisted.signatures.entries()].sort(([a], [b]) => a.localeCompare(b));
	const frameSignaturesOk = JSON.stringify(expectedFrameSignatures) === JSON.stringify(actualFrameSignatures);
	const frameDataOk =
		sourceMessages.length === persisted.frames.length &&
		sourceMessages.every((message, index) => {
			const frame = persisted.frames[index];
			const expectedBytes = visibleEntries(message).map(entry => entry.value);
			const sourceRawOffsets = (message as Record<string, unknown>).rawOffsets || (message as Record<string, unknown>)._rawPositions;
			const expectedRawOffsets = Array.isArray(sourceRawOffsets)
				? visibleEntries(message).map(entry => sourceRawOffsets[entry.rawPosition])
				: undefined;
			return (
				JSON.stringify(expectedBytes) === JSON.stringify(frame?.bytes) &&
				(expectedRawOffsets === undefined || JSON.stringify(expectedRawOffsets) === JSON.stringify(frame?.rawOffsets))
			);
		});
	const signaturesOk =
		frameSignaturesOk &&
		frameDataOk &&
		JSON.stringify(persistedSignatureCounts) === JSON.stringify(storedSignatureCounts) &&
		JSON.stringify(expectedSortedStats.signatures) === JSON.stringify(actualSortedStats.signatures);

	const transitionsOk = JSON.stringify(expectedSortedStats.transitions) === JSON.stringify(actualSortedStats.transitions);
	const transitionPositionsOk = JSON.stringify(deriveTransitionPositionAggregates(persisted.frames)) === JSON.stringify(persisted.transitionPositions);
	const byteStatsOk = JSON.stringify(expectedSortedStats.vocabulary) === JSON.stringify(actualSortedStats.vocabulary);
	const bitStatsOk = JSON.stringify(expectedSortedStats.bitVariance) === JSON.stringify(actualSortedStats.bitVariance);

	// Sequence groups are also compared with the original message stream and the
	// rows read back from canonical storage.
	// Section ids are intentionally regenerated at the canonical boundary.
	// Compare pattern membership using the regenerated id for the matching raw
	// span, otherwise repeated legacy ids across sections would make a valid
	// conversion look different during verification.
	const normalizedMessages = (normalized.messages || []) as ExistingMessage[];
	const normalizedMessageIndex = indexExistingMessages(normalizedMessages);
	const expectedPatterns = recognizeRepeatedPatterns(
		sourceMessages.map((message, idx) => {
			const normalizedMessage =
				findExistingMessage(normalizedMessageIndex, legacyMessageRawOffsets(message as ExistingMessage)) || normalizedMessages[idx];
			return {
				signature: signatureForMessage(message),
				originalIndex: idx,
				sectionId: normalizedMessage?.sectionId
			};
		})
	);
	const seqOk = JSON.stringify(expectedPatterns) === JSON.stringify(persisted.patterns);

	const overallOk =
		expectedMessages === actualMessages &&
		expectedRawBytes === actualRawBytes &&
		rawBytesOk &&
		sectionsOk &&
		signaturesOk && transitionsOk && transitionPositionsOk && byteStatsOk && bitStatsOk && seqOk && messageVisibilityOk && sessionIdentityOk;

	return {
		messageCount: { expected: expectedMessages, actual: actualMessages, ok: expectedMessages === actualMessages },
		rawByteCount: { expected: expectedRawBytes, actual: actualRawBytes, ok: expectedRawBytes === actualRawBytes && rawBytesOk },
		sectionBoundaries: { expected: expectedSections, actual: actualSections, ok: sectionsOk },
		signaturesOk,
		byteStatisticsOk: byteStatsOk,
		bitStatisticsOk: bitStatsOk,
		transitionsOk,
		transitionPositionsOk,
		sequenceGroupsOk: seqOk,
		messageVisibilityOk,
		sessionIdentityOk,
		overallOk,
		details: overallOk
			? undefined
			: `mismatch: messages ${expectedMessages} vs ${actualMessages}, bytes ${expectedRawBytes} vs ${actualRawBytes}, statsOk=${statsOk}, transitionPositionsOk=${transitionPositionsOk}, messageVisibilityOk=${messageVisibilityOk}, sessionIdentityOk=${sessionIdentityOk}`
	};
}

// ---------------------------------------------------------------------------
// Main conversion entry point — transactional + backup
// ---------------------------------------------------------------------------
export type ConversionResult = {
	captureId: string;
	ok: boolean;
	verified: boolean;
	report: VerificationReport;
	error?: string;
};

export function lifecycleForDocument(doc: CaptureDocument): string {
	const valid = new Set(["recording", "stopped", "finalized", "failed"]);
	const raw = String(doc.lifecycle || "").toLowerCase();
	if (valid.has(raw)) return raw;
	// Default for migrated captures: finalized if has frames, recording otherwise?
	return "finalized";
}

const LEGACY_STORAGE_STATUS = "legacy-not-canonicalized" as const;
const CANONICAL_STORAGE_STATUS = "canonical" as const;
const CANONICALIZATION_FAILED_STORAGE_STATUS = "canonicalization-failed" as const;
const CANONICAL_RETENTION_LIMIT = 50_000;

type LegacyParameter = { key: string; value: string };

function readCaptureStorageStatus(database: SqliteDatabase, captureId: string): string | undefined {
	const row = database
		.prepare("SELECT status FROM capture_storage WHERE capture_id = @captureId")
		.get({ captureId }) as { status: string } | undefined;
	return row?.status;
}

function ensureLegacyCaptureStorage(
	database: SqliteDatabase,
	captureId: string,
	createdAt: string,
	updatedAt: string
): void {
	database
		.prepare(
			`INSERT INTO capture_storage (capture_id, status, created_at, updated_at, last_error)
			 VALUES (@captureId, @status, @createdAt, @updatedAt, NULL)
			 ON CONFLICT (capture_id) DO NOTHING`
		)
		.run({ captureId, status: LEGACY_STORAGE_STATUS, createdAt, updatedAt });
}

function legacyParameters(document: CaptureDocument): LegacyParameter[] {
	if (!Array.isArray(document.params)) return [];
	return document.params.map((candidate, position) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			throw new Error(`capture parameter ${position} must be an object`);
		}
		const parameter = candidate as Record<string, unknown>;
		const key = String(parameter.key ?? "").trim();
		if (!key) throw new Error(`capture parameter ${position} has no key`);
		return { key, value: String(parameter.value ?? "") };
	});
}

function positiveLegacyBaudRate(document: CaptureDocument): number | null {
	const value = Number((document as Record<string, unknown>).baudRate);
	return Number.isFinite(value) && value > 0 ? value : null;
}

function canonicalMetadata(document: CaptureDocument): {
	description: string;
	controllerView: string;
	baudRate: number | null;
	inputFormat: string;
} {
	const source = document as Record<string, unknown>;
	return {
		description: String(source.description ?? ""),
		controllerView: String(source.controllerView ?? source.view ?? ""),
		baudRate: positiveLegacyBaudRate(document),
		inputFormat: String(source.inputFormat ?? "")
	};
}

function markCanonicalizationFailed(
	database: SqliteDatabase,
	captureId: string,
	error: string,
	nowIso: () => string,
	report?: VerificationReport
): void {
	try {
		const transaction = database.transaction(() => {
			const now = nowIso();
			// A failed attempt must not leave an incidental canonical graph behind.
			// finalization_jobs is intentionally independent of the canonical graph, so
			// the failure record can survive this cleanup while the legacy document
			// remains authoritative.
			database.prepare("DELETE FROM captures WHERE id = @captureId").run({ captureId });
			database.prepare("DELETE FROM finalization_jobs WHERE capture_id = @captureId AND id <> @jobId").run({
				captureId,
				jobId: `conv-${captureId}`
			});
			database.prepare("DELETE FROM capture_backups WHERE capture_id = @captureId").run({ captureId });
			database
				.prepare(
					`INSERT INTO capture_storage (capture_id, status, created_at, updated_at, last_error)
					 VALUES (@captureId, @status, @createdAt, @updatedAt, @error)
					 ON CONFLICT (capture_id) DO UPDATE SET
						 status = excluded.status,
						 updated_at = excluded.updated_at,
						 last_error = excluded.last_error
					 WHERE capture_storage.status <> @canonicalStatus`
				)
				.run({
					captureId,
					status: CANONICALIZATION_FAILED_STORAGE_STATUS,
					createdAt: now,
					updatedAt: now,
					error,
					canonicalStatus: CANONICAL_STORAGE_STATUS
				});

			database
				.prepare(
					`INSERT INTO finalization_jobs
						(id, capture_id, status, created_at, updated_at, error, verified, completed_at, verification_report_json)
						VALUES (@id, @captureId, 'failed', @createdAt, @updatedAt, @error, 0, NULL, @reportJson)
						ON CONFLICT (id) DO UPDATE SET
							status = 'failed', updated_at = excluded.updated_at, error = excluded.error, verified = 0,
							completed_at = NULL, profile_id = NULL, verification_report_json = excluded.verification_report_json`
				)
				.run({ id: `conv-${captureId}`, captureId, createdAt: now, updatedAt: now, error, reportJson: report ? JSON.stringify(report) : null });
		});
		transaction();
	} catch {
		// The conversion error is the useful result. Failure bookkeeping must not
		// hide it when an older database is missing an optional canonical table.
	}
}

function sourceMessagesFromFrames(
	frames: ReadonlyArray<ReturnType<typeof materializeFramesFromStream>[number]>
): Array<FramedMessage & { id: string; sectionId: string; rawOffsets: number[]; _rawPositions: number[] }> {
	return frames.map(frame => ({
		id: frame.id,
		sectionId: frame.sectionId,
		bytes: frame.bytes,
		rawOffsets: frame.rawOffsets,
		_rawPositions: frame.rawOffsets,
		hidden: frame.hidden,
		hiddenBytes: frame.bytes.map(() => false)
	}));
}

export function convertCaptureDocumentToCanonical(
	database: SqliteDatabase,
	captureId: string,
	options: { algorithmVersion?: number; generateId?: () => string; nowIso?: () => string } = {}
): ConversionResult {
	const nowIso = options.nowIso ?? (() => new Date().toISOString());
	const generateId = (options.generateId ?? randomUUID) as unknown as () => string;
	const algorithmVersion = options.algorithmVersion ?? 1;

	// Only the explicit storage row can authorize canonical reads. A canonical
	// row without that status is incidental/partial state and must not short-
	// circuit the legacy conversion.
	if (readCaptureStorageStatus(database, captureId) === CANONICAL_STORAGE_STATUS) {
		return { captureId, ok: true, verified: true, report: null as unknown as VerificationReport };
	}

	const row = database.prepare("SELECT document_json, created_at, updated_at FROM capture_documents WHERE id = @id").get({ id: captureId }) as
		| { document_json: string; created_at: string; updated_at: string }
		| undefined;
	if (!row) {
		return { captureId, ok: false, verified: false, report: null as unknown as VerificationReport, error: "capture document not found" };
	}

	let doc: CaptureDocument;
	try {
		doc = JSON.parse(row.document_json) as CaptureDocument;
	} catch (e) {
		const error = String(e);
		markCanonicalizationFailed(database, captureId, error, nowIso);
		return { captureId, ok: false, verified: false, report: null as unknown as VerificationReport, error };
	}

	try {
		ensureLegacyCaptureStorage(database, captureId, row.created_at, row.updated_at);
	} catch (e) {
		const error = String(e);
		markCanonicalizationFailed(database, captureId, error, nowIso);
		return { captureId, ok: false, verified: false, report: null as unknown as VerificationReport, error };
	}

	// Normalize and materialize BEFORE touching DB, so failed conversion leaves JSON active
	let normalized: CaptureDocument;
	let stream: Array<RawByteRecord & { rawOffset: number }>;
	let activeStream: Array<RawByteRecord & { rawOffset: number }>;
	let sections: NormalizedSection[];
	let frames: ReturnType<typeof materializeFramesFromStream>;
	let signatures: Map<string, number>;
	let stats: ReturnType<typeof deriveAnalysisStatistics>;
	let patterns: ReturnType<typeof recognizeRepeatedPatterns>;
	let byteCount: number;
	let retainedStartOffset: number;
	let parameters: LegacyParameter[];
	let report: VerificationReport;
	try {
		normalized = normalizeDocumentForConversion(doc, generateId);
		stream = (normalized.byteStream as Array<RawByteRecord & { rawOffset: number }>);
		byteCount = stream.length;
		const lastRawOffset = stream.at(-1)?.rawOffset ?? -1;
		retainedStartOffset = Math.max(0, lastRawOffset + 1 - CANONICAL_RETENTION_LIMIT);
		activeStream = stream.filter(record => record.rawOffset >= retainedStartOffset);
		sections = normalizeSectionsForConversion(
			normalized.frameSections as unknown as CaptureSection[],
			activeStream,
			normalizeFrameSize(normalized.frameSize),
			generateId,
			retainedStartOffset
		);
		frames = materializeFramesFromStream(activeStream, sections, generateId, normalized.messages || []);
		const occupiedFrameIds = new Set(
			(database.prepare("SELECT id FROM materialized_frames").all() as Array<{ id: string }>).map(row => row.id)
		);
		frames = frames.map(frame => {
			const id = allocateCanonicalId(frame.id, occupiedFrameIds, generateId);
			return id === frame.id ? frame : { ...frame, id };
		});
		// Derive analysis from frames
		const analysisFrames = frames.map(f => ({ signature: f.signature, bytes: f.bytes }));
		stats = deriveAnalysisStatistics(analysisFrames);
		signatures = countSignatures(analysisFrames.map(f => f.signature));
		patterns = recognizeRepeatedPatterns(
			frames.map((f, idx) => ({ signature: f.signature, originalIndex: idx, sectionId: f.sectionId }))
		);
		parameters = legacyParameters(doc);
		report = verifyConversion(doc, normalized, {
				byteCount,
				byteStream: stream,
				captureSessions: (normalized.captureSessions || []) as CaptureSessionRecord[],
				sections: sections.map(section => ({ id: section.id, start: section.start, mode: section.framingMode })),
					frames,
					signatures,
					stats,
					transitionPositions: deriveTransitionPositionAggregates(frames),
					patterns
			}, {
				sourceMessages: activeStream.length === stream.length ? undefined : sourceMessagesFromFrames(frames),
				expectedSections: sections,
				retainedStartOffset: activeStream.length === stream.length ? undefined : retainedStartOffset
			});
	} catch (e) {
		report = {
			messageCount: { expected: 0, actual: 0, ok: false },
			rawByteCount: { expected: 0, actual: 0, ok: false },
			sectionBoundaries: { expected: [], actual: [], ok: false },
			signaturesOk: false,
			byteStatisticsOk: false,
				bitStatisticsOk: false,
				transitionsOk: false,
				transitionPositionsOk: false,
				sequenceGroupsOk: false,
			messageVisibilityOk: false,
			sessionIdentityOk: false,
			overallOk: false,
			details: String(e)
		};
		const error = String(e);
		markCanonicalizationFailed(database, captureId, error, nowIso, report);
		return { captureId, ok: false, verified: false, report, error };
	}

	if (!report.overallOk) {
		const error = report.details || "verification failed";
		markCanonicalizationFailed(database, captureId, error, nowIso, report);
		return { captureId, ok: false, verified: false, report, error };
	}

	// Verification succeeded — now perform atomic canonical writes + backup
	try {
		const transaction = database.transaction(() => {
			const now = nowIso();
			// Rows under a non-canonical storage status are not authoritative. Clear
			// any incidental/failed canonical materialization before rebuilding it.
			database.prepare("DELETE FROM captures WHERE id = @id").run({ id: captureId });
			database.prepare("DELETE FROM finalization_jobs WHERE capture_id = @captureId AND id <> @jobId").run({
				captureId,
				jobId: `conv-${captureId}`
			});
			const metadata = canonicalMetadata(doc);
			// captures
			database
				.prepare(
					`INSERT INTO captures
					 (id, name, description, controller_view, baud_rate, input_format, lifecycle, byte_count,
					  created_at, updated_at, folder_id, data_revision, metadata_revision, content_revision,
					  retained_start_offset)
					 VALUES (@id, @name, @description, @controllerView, @baudRate, @inputFormat, @lifecycle, @byteCount,
					  @createdAt, @updatedAt, @folderId, 1, 1, 1, @retainedStartOffset)`
				)
				.run({
					id: captureId,
					name: String(doc.name || "Untitled capture"),
					description: metadata.description,
					controllerView: metadata.controllerView,
					baudRate: metadata.baudRate,
					inputFormat: metadata.inputFormat,
					lifecycle: lifecycleForDocument(doc),
					byteCount,
					createdAt: String(doc.createdAt || now),
					updatedAt: now,
					folderId: doc.folderId ? String(doc.folderId) : null,
					retainedStartOffset
				});

			const insertParameter = database.prepare(
				"INSERT INTO capture_parameters (capture_id, position, key_text, value_text) VALUES (@captureId, @position, @keyText, @valueText)"
			);
			parameters.forEach((parameter, position) =>
				insertParameter.run({ captureId, position, keyText: parameter.key, valueText: parameter.value })
			);

			// A converted capture must retain the framing draft that represents its
			// current profile.  Live sessions update this draft before their bytes are
			// finalized; without the seed row, the first framing edit after
			// canonicalization fails with "framing draft is missing".
			database
				.prepare(
					`INSERT INTO framing_drafts
						(capture_id, revision, sections_json, source_data_revision, created_at, updated_at)
					 VALUES (@captureId, 0, @sectionsJson, 1, @createdAt, @updatedAt)`
				)
				.run({
					captureId,
					sectionsJson: JSON.stringify(sections),
					createdAt: String(doc.createdAt || now),
					updatedAt: now
				});

			// Session records preserve explicit capture-session metadata, including
			// sessions that have no bytes after filtering. Per-byte identities are
			// stored separately on each raw chunk below.
			const captureSessions = (normalized.captureSessions || []) as CaptureSessionRecord[];
			const sessionNextRawOffset = new Map<string, number>();
			for (const record of stream) {
				if (!record.sessionId) continue;
				sessionNextRawOffset.set(record.sessionId, Math.max(sessionNextRawOffset.get(record.sessionId) ?? 0, record.rawOffset + 1));
			}
			for (let ordinal = 0; ordinal < captureSessions.length; ordinal++) {
				const session = captureSessions[ordinal];
				database
					.prepare(
						`INSERT INTO capture_sessions
						 (capture_id, ordinal, id, status, finalized_at, next_chunk_sequence, next_raw_offset,
						  first_received_at, last_received_at)
						 VALUES (@captureId, @ordinal, @id, 'finalized', @finalizedAt, 0, @nextRawOffset,
						  @firstReceivedAt, @lastReceivedAt)`
					)
					.run({
						captureId,
						ordinal,
						id: session.id,
						finalizedAt: now,
						nextRawOffset: sessionNextRawOffset.get(session.id) ?? 0,
						firstReceivedAt: session.firstReceivedAt ?? null,
						lastReceivedAt: session.lastReceivedAt ?? null
					});
			}

			// raw chunks
			const chunks = chunkRawBytes(stream);
			for (let i = 0; i < chunks.length; i++) {
				const ch = chunks[i];
				database
					.prepare(
						`INSERT INTO raw_chunks (capture_id, chunk_index, start_offset, byte_count, bytes, timestamps_json, directions_json, hidden_json, session_id, session_ids_json)
						 VALUES (@captureId, @chunkIndex, @startOffset, @byteCount, @bytes, @timestampsJson, @directionsJson, @hiddenJson, @sessionId, @sessionIdsJson)`
					)
					.run({
						captureId,
						chunkIndex: i,
						startOffset: ch.startOffset,
						byteCount: ch.bytes.length,
						bytes: ch.bytes,
						timestampsJson: JSON.stringify(ch.timestamps),
						directionsJson: JSON.stringify(ch.directions),
						hiddenJson: JSON.stringify(ch.hidden),
						sessionId: ch.sessionIds.every(sessionId => sessionId === ch.sessionIds[0]) ? ch.sessionIds[0] : null,
						sessionIdsJson: JSON.stringify(ch.sessionIds)
					});
			}

			// framing profile v1 active
			const profileId = generateId();
				database
					.prepare(
						`INSERT INTO framing_profiles
						 (id, capture_id, version, algorithm_version, is_active, created_at, updated_at,
						  source_data_revision, retained_start_offset, verified)
						 VALUES (@id, @captureId, 1, @algorithmVersion, 0, @createdAt, @updatedAt,
						  1, @retainedStartOffset, 0)`
					)
					.run({
						id: profileId,
						captureId,
						algorithmVersion,
						createdAt: now,
						updatedAt: now,
						retainedStartOffset
					});

			// sections
			for (let i = 0; i < sections.length; i++) {
				const s = sections[i];
				database
					.prepare(
						`INSERT INTO framing_sections (id, profile_id, capture_id, start_offset, position, framing_mode, frame_length, marker_bytes, marker_position, time_gap_ms, collapse_runs, collapsed)
						 VALUES (@id, @profileId, @captureId, @startOffset, @position, @framingMode, @frameLength, @markerBytes, @markerPosition, @timeGapMs, @collapseRuns, @collapsed)`
					)
					.run({
						id: s.id,
						profileId,
						captureId,
						startOffset: s.start,
						position: i,
						framingMode: s.framingMode,
						frameLength: s.framingMode === "length" ? s.frameSize : null,
						markerBytes: s.framingMode === "marker" ? JSON.stringify(parseMarkerBytes(s.frameMarker)) : null,
						markerPosition: s.framingMode === "marker" ? s.markerPosition : null,
						timeGapMs: s.framingMode === "time" ? s.frameTimeGap : null,
						collapseRuns: s.collapseRuns ? 1 : 0,
						collapsed: s.collapsed ? 1 : 0
					});
			}

			// materialized frames
				for (const f of frames) {
					database
					.prepare(
						`INSERT INTO materialized_frames (id, capture_id, profile_id, profile_version, ordinal, section_id, raw_offsets_json, bytes_json, timestamps_json, directions_json, hidden, signature)
						 VALUES (@id, @captureId, @profileId, @profileVersion, @ordinal, @sectionId, @rawOffsetsJson, @bytesJson, @timestampsJson, @directionsJson, @hidden, @signature)`
					)
					.run({
						id: f.id,
						captureId,
						profileId,
						profileVersion: 1,
						ordinal: f.ordinal,
						sectionId: f.sectionId,
						rawOffsetsJson: JSON.stringify(f.rawOffsets),
						bytesJson: JSON.stringify(f.bytes),
						timestampsJson: JSON.stringify(f.timestamps),
						directionsJson: JSON.stringify(f.directions),
						hidden: f.hidden ? 1 : 0,
						signature: f.signature
						});
				}
				persistTransitionPositionAggregates(database, profileId, frames);

				// signatures
			for (const [sig, count] of signatures.entries()) {
				database.prepare(`INSERT INTO frame_signatures (profile_id, signature, count) VALUES (@profileId, @signature, @count)`).run({
					profileId,
					signature: sig,
					count
				});
			}
			// transitions
			for (const tr of stats.transitions) {
				database
					.prepare(
						`INSERT INTO frame_transitions (profile_id, from_signature, to_signature, count, diffs) VALUES (@profileId, @fromSignature, @toSignature, @count, @diffs)`
					)
					.run({
						profileId,
						fromSignature: tr.from,
						toSignature: tr.to,
						count: tr.count,
						diffs: tr.diffs
					});
			}
			// byte statistics
			for (let pos = 0; pos < stats.vocabulary.length; pos++) {
				for (const entry of stats.vocabulary[pos] as Array<{ value: number; count: number }>) {
					database
						.prepare(`INSERT INTO byte_statistics (profile_id, position, value, count) VALUES (@profileId, @position, @value, @count)`)
						.run({ profileId, position: pos, value: entry.value, count: entry.count });
				}
			}
			// bit statistics
			for (let pos = 0; pos < stats.bitVariance.length; pos++) {
				for (const cell of stats.bitVariance[pos] as Array<{ bit: number; percentage: number; variance: string }>) {
					database
						.prepare(
							`INSERT INTO bit_statistics (profile_id, position, bit, percentage, variance) VALUES (@profileId, @position, @bit, @percentage, @variance)`
						)
						.run({
							profileId,
							position: pos,
							bit: cell.bit,
							percentage: cell.percentage,
							variance: cell.variance
						});
				}
			}
			// sequence groups + occurrences
			const sigByOrdinal = frames.map(f => f.signature);
			for (let gi = 0; gi < patterns.groups.length; gi++) {
				const g = patterns.groups[gi];
				const groupId = generateId();
				database
					.prepare(
						`INSERT INTO sequence_groups (id, capture_id, profile_id, key_text, signatures_json, score, length)
						 VALUES (@id, @captureId, @profileId, @keyText, @signaturesJson, @score, @length)`
					)
					.run({
						id: groupId,
						captureId,
						profileId,
						keyText: g.key,
						signaturesJson: JSON.stringify(g.signatures),
						score: g.score,
						length: g.length
					});
				// occurrences: patterns.membership maps to groups
				const occByGroup = new Map<number, Array<{ occurrenceIndex: number; offset: number; originalIndex: number }>>();
				for (const m of patterns.membership) {
					if (m.groupIndex !== gi) continue;
					const list = occByGroup.get(m.occurrenceIndex) || [];
					list.push(m);
					occByGroup.set(m.occurrenceIndex, list);
				}
				for (const [occurrenceIndex, members] of occByGroup.entries()) {
					// members sorted by offset; derive start frame ordinal
					members.sort((a,b)=>a.offset-b.offset);
					const startOrdinal = Math.min(...members.map(m=> {
						// originalIndex maps to ordinal via frames index
						return frames.findIndex(f=> f.ordinal === m.originalIndex) >=0 ? m.originalIndex : members[0].originalIndex;
					}));
					// Use first member's raw offsets for boundaries
					const startFrame = frames[members[0].originalIndex];
					const endFrame = frames[members[members.length-1].originalIndex];
					const startRaw = startFrame?.rawOffsets[0] ?? 0;
					const endRaw = endFrame?.rawOffsets.at(-1) ?? startRaw;
					for (const mem of members) {
						database
							.prepare(
								`INSERT INTO sequence_occurrences (group_id, occurrence_index, offset, start_frame_ordinal, start_raw_offset, end_raw_offset, length)
								 VALUES (@groupId, @occurrenceIndex, @offset, @startFrameOrdinal, @startRawOffset, @endRawOffset, @length)`
							)
							.run({
								groupId,
								occurrenceIndex,
								offset: mem.offset,
								startFrameOrdinal: startOrdinal,
								startRawOffset: startRaw,
								endRawOffset: endRaw,
								length: g.length
							});
					}
				}
			}

			// Verify the rows that will become authoritative, rather than only the
			// in-memory materialization used to populate them.
			report = verifyConversion(doc, normalized, readPersistedConversion(database, captureId, profileId), {
				sourceMessages: activeStream.length === stream.length ? undefined : sourceMessagesFromFrames(frames),
				expectedSections: sections,
				retainedStartOffset: activeStream.length === stream.length ? undefined : retainedStartOffset
			});
			if (!report.overallOk) throw new Error(report.details || "canonical conversion verification failed");

			// Keep the raw chunk BLOBs immutable while exposing the legacy visibility
			// state through the Phase 2.5 override tables.
			const insertRawVisibility = database.prepare(
				"INSERT INTO raw_byte_visibility (capture_id, raw_offset, hidden) VALUES (@captureId, @rawOffset, @hidden)"
			);
			for (const record of stream) {
				insertRawVisibility.run({ captureId, rawOffset: record.rawOffset, hidden: record.hidden ? 1 : 0 });
			}
			const insertFrameVisibility = database.prepare(
				`INSERT INTO frame_visibility
				 (capture_id, profile_id, start_raw_offset, end_raw_offset, hidden)
				 VALUES (@captureId, @profileId, @startRawOffset, @endRawOffset, @hidden)`
			);
			for (const frame of frames) {
				const startRawOffset = frame.rawOffsets[0];
				const endRawOffset = frame.rawOffsets.at(-1);
				if (startRawOffset === undefined || endRawOffset === undefined) continue;
				insertFrameVisibility.run({
					captureId,
					profileId,
					startRawOffset,
					endRawOffset,
					hidden: frame.hidden ? 1 : 0
				});
			}

			database.prepare("UPDATE framing_profiles SET verified = 1, is_active = 1, updated_at = @updatedAt WHERE id = @profileId").run({
				profileId,
				updatedAt: now
			});
			database.prepare("UPDATE captures SET active_framing_profile_id = @profileId WHERE id = @captureId").run({ captureId, profileId });

			// The recovery copy is written only after every canonical row has been
			// read back and verified. It is the one durable JSON recovery row; normal
			// canonical reads do not consult it.
			database
				.prepare(
					`INSERT INTO capture_backups
					 (capture_id, document_json, migrated_at, verified, verification_report_json)
					 VALUES (@captureId, @documentJson, @migratedAt, 1, @reportJson)
					 ON CONFLICT (capture_id) DO UPDATE SET
						 document_json = excluded.document_json,
						 migrated_at = excluded.migrated_at,
						 verified = 1,
						 verification_report_json = excluded.verification_report_json`
				)
				.run({
					captureId,
					documentJson: row.document_json,
					migratedAt: now,
					reportJson: JSON.stringify(report)
				});

			// stable notes: map capture.notes and annotations
			const notes = (doc.notes as Array<Record<string, unknown>>) || [];
			const usedNoteIds = new Set(
				(database.prepare("SELECT id FROM stable_notes").all() as Array<{ id: string }>).map(row => row.id)
			);
			for (const note of notes) {
				const id = allocateCanonicalId(note.id, usedNoteIds, generateId);
				const text = String(note.text || "");
				const createdAt = String(note.createdAt ? new Date(Number(note.createdAt)).toISOString() : now);
				const type = String(note.type || "capture");
				if (type === "sequence") {
					// Legacy sequence notes use 1-based row ranges; keep as legacy-sequence target
					const start = Number(note.start) || 1;
					const end = Number(note.end) || start;
					database
						.prepare(
							`INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind, start_row, end_row)
							 VALUES (@id, @captureId, @text, @createdAt, 'legacy-sequence', @startRow, @endRow)`
						)
						.run({ id, captureId, text, createdAt, startRow: start, endRow: end });
				} else if (type === "capture") {
					database
						.prepare(
							`INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind) VALUES (@id, @captureId, @text, @createdAt, 'capture')`
						)
						.run({ id, captureId, text, createdAt });
				} else {
					// Unknown types treat as capture
					database
						.prepare(
							`INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind) VALUES (@id, @captureId, @text, @createdAt, 'capture')`
						)
						.run({ id, captureId, text, createdAt });
				}
			}
			const annotations = (doc.annotations as Record<string, Record<string, unknown>>) || {};
			const sourceMessages = Array.isArray(doc.messages) ? (doc.messages as Array<Record<string, unknown>>) : [];
			const sourceByteStream = Array.isArray(doc.byteStream) ? (doc.byteStream as RawByteRecord[]) : [];
			for (const [key, val] of Object.entries(annotations)) {
				const id = allocateCanonicalId(undefined, usedNoteIds, generateId);
				const text = String(val.text || "");
				const createdAt = String(val.createdAt ? new Date(Number(val.createdAt)).toISOString() : now);
				const target = legacyAnnotationTarget(key);
				const sourceMessage = sourceMessages.find(message => String(message.id) === target.messageId);
				const normalizedMessage = (normalized.messages as Array<Record<string, unknown>>)?.find(
					message => String(message.id) === target.messageId
				);
				const rawOffsets =
					legacyRawOffsetsForMessage(sourceMessage, sourceByteStream) || legacyRawOffsetsForMessage(normalizedMessage);
				if (target.bytePosition !== null) {
					// byte note: resolve raw offset from message id + position if possible
					// For stability, we attach to absolute raw offset: try to find message's rawOffsets
					let rawOffset: number | null = null;
					if (rawOffsets) rawOffset = rawOffsets[target.bytePosition] ?? null;
					database
						.prepare(
							`INSERT INTO stable_notes
							 (id, capture_id, text, created_at, target_kind, raw_offset, message_id, byte_position)
							 VALUES (@id, @captureId, @text, @createdAt, 'byte', @rawOffset, @messageId, @bytePosition)`
						)
						.run({
							id,
							captureId,
							text,
							createdAt,
							rawOffset,
							messageId: target.messageId,
							bytePosition: target.bytePosition
						});
				} else {
					// frame/message note: attach to profile + raw span
					database
						.prepare(
							`INSERT INTO stable_notes
							 (id, capture_id, text, created_at, target_kind, profile_id, raw_offsets_json, message_id)
							 VALUES (@id, @captureId, @text, @createdAt, 'frame', @profileId, @rawOffsetsJson, @messageId)`
						)
						.run({
							id,
							captureId,
							text,
							createdAt,
							profileId,
							rawOffsetsJson: rawOffsets ? JSON.stringify(rawOffsets) : null,
							messageId: target.messageId
						});
				}
			}
			// pattern remarks -> pattern notes
			const patternRemarks = (doc.patternRemarks as Record<string, Record<string, unknown>>) || {};
			for (const [patternKey, val] of Object.entries(patternRemarks)) {
				const id = allocateCanonicalId(undefined, usedNoteIds, generateId);
				const text = String(val.text || "");
				const createdAt = now;
				database
					.prepare(
						`INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind, sequence_key)
						 VALUES (@id, @captureId, @text, @createdAt, 'pattern', @sequenceKey)`
					)
					.run({ id, captureId, text, createdAt, sequenceKey: patternKey });
			}

			// finalization job completed
			database
				.prepare(
					`INSERT INTO finalization_jobs
						(id, capture_id, status, created_at, updated_at, profile_id, data_revision,
						 source_data_revision, completed_at, error, verified, verification_report_json)
						VALUES (@id, @captureId, 'completed', @createdAt, @updatedAt, @profileId, 1,
						 1, @completedAt, NULL, 1, @reportJson)
						ON CONFLICT (id) DO UPDATE SET
							status = 'completed',
							updated_at = excluded.updated_at,
							profile_id = excluded.profile_id,
							data_revision = excluded.data_revision,
							source_data_revision = excluded.source_data_revision,
							completed_at = excluded.completed_at,
							error = NULL,
							verified = 1,
							verification_report_json = excluded.verification_report_json`
				)
				.run({ id: `conv-${captureId}`, captureId, profileId, createdAt: now, updatedAt: now, completedAt: now, reportJson: JSON.stringify(report) });

			// Switch authority last. If any canonical write, verification, backup, or
			// document deletion fails, SQLite rolls the entire conversion back.
			database.prepare("DELETE FROM capture_documents WHERE id = @captureId").run({ captureId });
			database
				.prepare(
					`UPDATE capture_storage
					 SET status = @status, updated_at = @updatedAt, last_error = NULL
					 WHERE capture_id = @captureId`
				)
				.run({ captureId, status: CANONICAL_STORAGE_STATUS, updatedAt: now });
		});
		transaction();
		return { captureId, ok: true, verified: true, report };
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		markCanonicalizationFailed(database, captureId, error, nowIso);
		return { captureId, ok: false, verified: false, report, error };
	}
}

type CanonicalRawChunkRow = {
	bytes: Buffer;
	timestamps_json: string;
	directions_json: string;
	hidden_json: string;
	start_offset: number;
	session_id: string | null;
	session_ids_json: string;
};

function canonicalRawMatches(
	database: SqliteDatabase,
	captureId: string,
	stream: Array<RawByteRecord & { rawOffset: number }>
): boolean {
	const chunks = database
		.prepare("SELECT bytes, timestamps_json, directions_json, hidden_json, start_offset, session_id, session_ids_json FROM raw_chunks WHERE capture_id = @captureId ORDER BY chunk_index")
		.all({ captureId }) as CanonicalRawChunkRow[];
	let streamIndex = 0;
	for (const chunk of chunks) {
		const timestamps: number[] = JSON.parse(chunk.timestamps_json) as number[];
		const directions: string[] = JSON.parse(chunk.directions_json) as string[];
		const hidden: boolean[] = JSON.parse(chunk.hidden_json) as boolean[];
		const sessionIds: Array<string | null> = JSON.parse(chunk.session_ids_json || "[]") as Array<string | null>;
		const bytes = chunk.bytes instanceof Buffer ? [...chunk.bytes] : Array.from(new Uint8Array(chunk.bytes as unknown as Uint8Array));
		for (let index = 0; index < bytes.length; index++) {
			const raw = stream[streamIndex++];
			if (!raw) return false;
			if (
				raw.rawOffset !== chunk.start_offset + index ||
				(Number(raw.value) & 0xff) !== bytes[index] ||
				raw.timestamp !== (timestamps[index] ?? 0) ||
				(raw.direction || "rx") !== (directions[index] || "rx") ||
				Boolean(raw.hidden) !== Boolean(hidden[index]) ||
				(raw.sessionId || undefined) !== (sessionIds[index] || chunk.session_id || undefined)
			) {
				return false;
			}
		}
	}
	return streamIndex === stream.length;
}

function canonicalSessionsMatch(database: SqliteDatabase, captureId: string, sessions: CaptureSessionRecord[]): boolean {
	const rows = database
		.prepare("SELECT ordinal, id, first_received_at, last_received_at FROM capture_sessions WHERE capture_id = @captureId ORDER BY ordinal")
		.all({ captureId }) as Array<{ ordinal: number; id: string; first_received_at: number | null; last_received_at: number | null }>;
	if (rows.length !== sessions.length) return false;
	return rows.every((row, index) => {
		const expected = sessions[index];
		return (
			row.ordinal === index &&
			row.id === expected.id &&
			(row.first_received_at ?? undefined) === (expected.firstReceivedAt ?? undefined) &&
			(row.last_received_at ?? undefined) === (expected.lastReceivedAt ?? undefined)
		);
	});
}

type CanonicalSectionRow = {
	start_offset: number;
	framing_mode: string;
	frame_length: number | null;
	marker_bytes: string | null;
	marker_position: string | null;
	time_gap_ms: number | null;
	collapse_runs: number;
	collapsed: number;
};

function canonicalFramingMatches(database: SqliteDatabase, captureId: string, sections: NormalizedSection[]): boolean {
	const activeProfile = database
		.prepare("SELECT id FROM framing_profiles WHERE capture_id = @captureId AND is_active = 1 LIMIT 1")
		.get({ captureId }) as { id: string } | undefined;
	if (!activeProfile) return false;
	const stored = database
		.prepare(
			"SELECT start_offset, framing_mode, frame_length, marker_bytes, marker_position, time_gap_ms, collapse_runs, collapsed FROM framing_sections WHERE profile_id = @profileId ORDER BY position"
		)
		.all({ profileId: activeProfile.id }) as CanonicalSectionRow[];
	if (stored.length !== sections.length) return false;
	return stored.every((row, index) => {
		const section = sections[index];
		const expectedMarker = section.framingMode === "marker" ? JSON.stringify(parseMarkerBytes(section.frameMarker)) : null;
		return (
			row.start_offset === section.start &&
			row.framing_mode === section.framingMode &&
			row.frame_length === (section.framingMode === "length" ? section.frameSize : null) &&
			row.marker_bytes === expectedMarker &&
			row.marker_position === (section.framingMode === "marker" ? section.markerPosition : null) &&
			row.time_gap_ms === (section.framingMode === "time" ? section.frameTimeGap : null) &&
			Boolean(row.collapse_runs) === section.collapseRuns &&
			Boolean(row.collapsed) === section.collapsed
		);
	});
}

function updateCanonicalMetadata(
	database: SqliteDatabase,
	captureId: string,
	document: CaptureDocument,
	byteCount: number,
	updatedAt: string
): void {
	const existing = database.prepare("SELECT created_at FROM captures WHERE id = @id").get({ id: captureId }) as { created_at: string } | undefined;
	if (!existing) throw new Error(`capture ${captureId} not found in canonical store`);
	database
		.prepare(
			`UPDATE captures
			 SET name = @name,
				 lifecycle = @lifecycle,
				 byte_count = @byteCount,
				 created_at = @createdAt,
				 updated_at = @updatedAt,
				 folder_id = @folderId
			 WHERE id = @id`
		)
		.run({
			id: captureId,
			name: String(document.name || "Untitled capture"),
			lifecycle: lifecycleForDocument(document),
			byteCount,
			createdAt: String(document.createdAt || existing.created_at),
			updatedAt,
			folderId: document.folderId ? String(document.folderId) : null
		});
}

function noteCreatedAt(value: unknown, fallback: string): string {
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
	if (typeof value === "string" && value.trim()) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return new Date(numeric).toISOString();
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
	}
	return fallback;
}

function noteObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function allocateCanonicalId(preferred: unknown, used: Set<string>, generateId: () => string): string {
	let candidate = String(preferred ?? "").trim();
	for (let attempt = 0; attempt < 32; attempt++) {
		if (candidate && !used.has(candidate)) {
			used.add(candidate);
			return candidate;
		}
		candidate = String(generateId()).trim();
	}

	const base = candidate || "canonical-id";
	let suffix = 1;
	while (used.has(`${base}-${suffix}`)) suffix++;
	const fallback = `${base}-${suffix}`;
	used.add(fallback);
	return fallback;
}

function allocateNoteId(preferred: unknown, used: Set<string>, generateId: () => string): string {
	const initial = String(preferred ?? "").trim() || String(generateId()).trim() || "note";
	let candidate = initial;
	let suffix = 1;
	while (used.has(candidate)) {
		const generated = String(generateId()).trim();
		candidate = generated && !used.has(generated) ? generated : `${initial}-${suffix++}`;
	}
	used.add(candidate);
	return candidate;
}

function messageRawOffsets(document: CaptureDocument, messageId: string): number[] | null {
	const messages = Array.isArray(document.messages) ? document.messages : [];
	const message = messages.find(candidate => String(candidate?.id || "") === messageId);
	if (!message) return null;
	const persistedOffsets = (value: unknown): number[] | null => {
		if (!Array.isArray(value)) return null;
		const offsets = value.map(Number);
		return offsets.every(offset => Number.isSafeInteger(offset) && offset >= 0) ? offsets : null;
	};
	const offsets = persistedOffsets(message.rawOffsets) || persistedOffsets(message._rawPositions);
	if (offsets) return offsets;
	const start = Number(message._byteStart);
	return Number.isSafeInteger(start) && start >= 0 && Array.isArray(message.bytes)
		? message.bytes.map((_, index) => start + index)
		: null;
}

function replaceCanonicalNotes(
	database: SqliteDatabase,
	captureId: string,
	document: CaptureDocument,
	now: string,
	generateId: () => string
): void {
	database.prepare("DELETE FROM stable_notes WHERE capture_id = @captureId").run({ captureId });
	const usedIds = new Set<string>();
	const insertCaptureNote = database.prepare(
		"INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind, start_row, end_row) VALUES (@id, @captureId, @text, @createdAt, @targetKind, @startRow, @endRow)"
	);
	const insertSimpleNote = database.prepare(
		"INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind) VALUES (@id, @captureId, @text, @createdAt, @targetKind)"
	);
	const insertByteNote = database.prepare(
		"INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind, raw_offset, message_id, byte_position) VALUES (@id, @captureId, @text, @createdAt, 'byte', @rawOffset, @messageId, @bytePosition)"
	);
	const insertFrameNote = database.prepare(
		"INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind, profile_id, raw_offsets_json, message_id) VALUES (@id, @captureId, @text, @createdAt, 'frame', @profileId, @rawOffsetsJson, @messageId)"
	);
	const insertPatternNote = database.prepare(
		"INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind, sequence_key) VALUES (@id, @captureId, @text, @createdAt, 'pattern', @sequenceKey)"
	);
	const activeProfile = database
		.prepare("SELECT id FROM framing_profiles WHERE capture_id = @captureId AND is_active = 1 LIMIT 1")
		.get({ captureId }) as { id: string } | undefined;

	for (const value of Array.isArray(document.notes) ? document.notes : []) {
		const note = noteObject(value);
		const type = String(note.type || "capture");
		const id = allocateNoteId(note.id, usedIds, generateId);
		const text = String(note.text || "");
		const createdAt = noteCreatedAt(note.createdAt, now);
		if (type === "sequence" || type === "legacy-sequence") {
			const start = Number(note.start) || 1;
			const end = Number(note.end) || start;
			insertCaptureNote.run({ id, captureId, text, createdAt, targetKind: "legacy-sequence", startRow: start, endRow: end });
		} else {
			insertSimpleNote.run({ id, captureId, text, createdAt, targetKind: "capture" });
		}
	}

	const annotations = noteObject(document.annotations);
	for (const [key, rawValue] of Object.entries(annotations)) {
		const value = noteObject(rawValue);
		const id = allocateNoteId(key, usedIds, generateId);
		const text = String(value.text || "");
		const createdAt = noteCreatedAt(value.createdAt, now);
		const target = legacyAnnotationTarget(key);
		if (target.bytePosition !== null) {
			const messageId = target.messageId;
			const position = target.bytePosition;
			const offsets = messageRawOffsets(document, messageId);
			const rawOffset = offsets && Number.isInteger(position) ? offsets[position] : null;
			insertByteNote.run({
				id,
				captureId,
				text,
				createdAt,
				rawOffset: Number.isSafeInteger(rawOffset) ? rawOffset : null,
				messageId,
				bytePosition: position
			});
		} else {
			const messageId = target.messageId;
			const offsets = messageRawOffsets(document, key);
			insertFrameNote.run({
				id,
				captureId,
				text,
				createdAt,
				profileId: activeProfile?.id ?? null,
				rawOffsetsJson: offsets ? JSON.stringify(offsets) : null,
				messageId
			});
		}
	}

	const patternRemarks = noteObject(document.patternRemarks);
	for (const [sequenceKey, rawValue] of Object.entries(patternRemarks)) {
		const value = noteObject(rawValue);
		const id = allocateNoteId(`pattern:${sequenceKey}`, usedIds, generateId);
		insertPatternNote.run({
			id,
			captureId,
			text: String(value.text || ""),
			createdAt: noteCreatedAt(value.updatedAt, now),
			sequenceKey
		});
	}
}

/**
 * Synchronize a normal document save with the canonical representation.
 * The caller owns the surrounding transaction so the shadow JSON row and
 * canonical tables commit or roll back together.
 */
export function updateCanonicalCapture(
	database: SqliteDatabase,
	captureId: string,
	document: Record<string, unknown>,
	options: { generateId?: () => string; nowIso?: () => string } = {}
): void {
	const generateId = (options.generateId ?? randomUUID) as unknown as () => string;
	const now = (options.nowIso ?? (() => new Date().toISOString()))();
	const normalized = normalizeDocumentForConversion(document as CaptureDocument, generateId);
	const stream = normalized.byteStream as Array<RawByteRecord & { rawOffset: number }>;
	const sections = normalized.frameSections as unknown as NormalizedSection[];
	const captureSessions = (normalized.captureSessions || []) as CaptureSessionRecord[];

	if (!canonicalRawMatches(database, captureId, stream) || !canonicalSessionsMatch(database, captureId, captureSessions)) {
		// Raw chunks are immutable for a given canonical materialization. A byte
		// edit therefore starts a fresh materialization; stale framing profiles
		// cannot remain attached to a different byte stream.
		// Normal saves may carry a message preview from before the raw edit. The
		// raw stream is the edited source in this path, so persist its rebuilt
		// preview before invoking the strict source-vs-canonical verification.
		const rebuiltDocument = {
			...document,
			byteStream: normalized.byteStream,
			frameSections: normalized.frameSections,
			messages: normalized.messages,
			captureSessions: normalized.captureSessions
		};
		database
			.prepare("UPDATE capture_documents SET document_json = @documentJson WHERE id = @id")
			.run({ id: captureId, documentJson: JSON.stringify(rebuiltDocument) });
		database.prepare("DELETE FROM finalization_jobs WHERE capture_id = @captureId").run({ captureId });
		database.prepare("DELETE FROM captures WHERE id = @id").run({ id: captureId });
		const result = convertCaptureDocumentToCanonical(database, captureId, {
			nowIso: () => now,
			generateId
		});
		if (!result.verified) throw new Error(result.error || result.report?.details || `canonical update failed for capture ${captureId}`);
		replaceCanonicalNotes(database, captureId, document as CaptureDocument, now, generateId);
		return;
	}

	updateCanonicalMetadata(database, captureId, document as CaptureDocument, stream.length, now);
	if (!canonicalFramingMatches(database, captureId, sections)) {
		createFramingRevision(
			database,
			captureId,
			sections.map(section => ({
				// Section ids are scoped to the materialized profile. Generate new
				// ids for a revision so the previous profile remains queryable.
				id: undefined,
				start: section.start,
				framingMode: section.framingMode,
				frameSize: section.frameSize,
				frameMarker: section.frameMarker,
				markerPosition: section.markerPosition,
				frameTimeGap: section.frameTimeGap,
				collapseRuns: section.collapseRuns,
				collapsed: section.collapsed
			})),
			{ nowIso: () => now, generateId }
		);
	}
	replaceCanonicalNotes(database, captureId, document as CaptureDocument, now, generateId);
}

// ---------------------------------------------------------------------------
// Reframing: create new profile, materialize completely, activate atomically
// ---------------------------------------------------------------------------
export type ReframingInputSection = {
	id?: string;
	start: number;
	framingMode: "length" | "marker" | "time";
	frameSize?: number;
	frameMarker?: string;
	markerPosition?: "start" | "end";
	frameTimeGap?: number;
	collapseRuns?: boolean;
	collapsed?: boolean;
};

/**
 * Persist all immutable derived rows for a profile. The caller owns the
 * transaction and the profile row; activation is deliberately separate so a
 * caller can verify every row before swapping the active profile.
 */
export function persistCanonicalMaterializationRows(
	database: SqliteDatabase,
	captureId: string,
	profileId: string,
	profileVersion: number,
	materialization: CanonicalMaterialization,
	generateId: () => string = randomUUID as unknown as () => string
): void {
	const { sections, frames, signatures, stats, patterns } = materialization;
	for (let i = 0; i < sections.length; i++) {
		const section = sections[i];
		database
			.prepare(
				`INSERT INTO framing_sections
				 (id, profile_id, capture_id, start_offset, position, framing_mode, frame_length,
				  marker_bytes, marker_position, time_gap_ms, collapse_runs, collapsed)
				 VALUES (@id, @profileId, @captureId, @startOffset, @position, @framingMode,
				  @frameLength, @markerBytes, @markerPosition, @timeGapMs, @collapseRuns, @collapsed)`
			)
			.run({
				id: section.id,
				profileId,
				captureId,
				startOffset: section.start,
				position: i,
				framingMode: section.framingMode,
				frameLength: section.framingMode === "length" ? section.frameSize : null,
				markerBytes: section.framingMode === "marker" ? JSON.stringify(parseMarkerBytes(section.frameMarker)) : null,
				markerPosition: section.framingMode === "marker" ? section.markerPosition : null,
				timeGapMs: section.framingMode === "time" ? section.frameTimeGap : null,
				collapseRuns: section.collapseRuns ? 1 : 0,
				collapsed: section.collapsed ? 1 : 0
			});
	}

	for (const frame of frames) {
		database
			.prepare(
				`INSERT INTO materialized_frames
				 (id, capture_id, profile_id, profile_version, ordinal, section_id, raw_offsets_json,
				  bytes_json, timestamps_json, directions_json, hidden, signature)
				 VALUES (@id, @captureId, @profileId, @profileVersion, @ordinal, @sectionId,
				  @rawOffsetsJson, @bytesJson, @timestampsJson, @directionsJson, @hidden, @signature)`
			)
			.run({
				id: frame.id,
				captureId,
				profileId,
				profileVersion,
				ordinal: frame.ordinal,
				sectionId: frame.sectionId,
				rawOffsetsJson: JSON.stringify(frame.rawOffsets),
				bytesJson: JSON.stringify(frame.bytes),
				timestampsJson: JSON.stringify(frame.timestamps),
				directionsJson: JSON.stringify(frame.directions),
				hidden: frame.hidden ? 1 : 0,
				signature: frame.signature
			});
	}
	persistTransitionPositionAggregates(database, profileId, frames);

	for (const [signature, count] of signatures.entries()) {
		database
			.prepare("INSERT INTO frame_signatures (profile_id, signature, count) VALUES (@profileId, @signature, @count)")
			.run({ profileId, signature, count });
	}
	for (const transition of stats.transitions) {
		database
			.prepare(
				"INSERT INTO frame_transitions (profile_id, from_signature, to_signature, count, diffs) VALUES (@profileId, @fromSignature, @toSignature, @count, @diffs)"
			)
			.run({
				profileId,
				fromSignature: transition.from,
				toSignature: transition.to,
				count: transition.count,
				diffs: transition.diffs
			});
	}
	for (let position = 0; position < stats.vocabulary.length; position++) {
		for (const entry of stats.vocabulary[position] as Array<{ value: number; count: number }>) {
			database
				.prepare("INSERT INTO byte_statistics (profile_id, position, value, count) VALUES (@profileId, @position, @value, @count)")
				.run({ profileId, position, value: entry.value, count: entry.count });
		}
	}
	for (let position = 0; position < stats.bitVariance.length; position++) {
		for (const cell of stats.bitVariance[position] as Array<{ bit: number; percentage: number; variance: string }>) {
			database
				.prepare(
					"INSERT INTO bit_statistics (profile_id, position, bit, percentage, variance) VALUES (@profileId, @position, @bit, @percentage, @variance)"
				)
				.run({ profileId, position, bit: cell.bit, percentage: cell.percentage, variance: cell.variance });
		}
	}
	for (let groupIndex = 0; groupIndex < patterns.groups.length; groupIndex++) {
		const group = patterns.groups[groupIndex];
		const groupId = generateId();
		database
			.prepare(
				`INSERT INTO sequence_groups (id, capture_id, profile_id, key_text, signatures_json, score, length)
				 VALUES (@id, @captureId, @profileId, @keyText, @signaturesJson, @score, @length)`
			)
			.run({
				id: groupId,
				captureId,
				profileId,
				keyText: group.key,
				signaturesJson: JSON.stringify(group.signatures),
				score: group.score,
				length: group.length
			});
		const membersByOccurrence = new Map<number, Array<{ occurrenceIndex: number; offset: number; originalIndex: number }>>();
		for (const member of patterns.membership) {
			if (member.groupIndex !== groupIndex) continue;
			const members = membersByOccurrence.get(member.occurrenceIndex) || [];
			members.push(member);
			membersByOccurrence.set(member.occurrenceIndex, members);
		}
		for (const [occurrenceIndex, members] of membersByOccurrence.entries()) {
			members.sort((left, right) => left.offset - right.offset);
			const startOrdinal = members[0].originalIndex;
			const startRawOffset = frames[members[0].originalIndex]?.rawOffsets[0] ?? 0;
			const endRawOffset = frames[members[members.length - 1].originalIndex]?.rawOffsets.at(-1) ?? startRawOffset;
			for (const member of members) {
				database
					.prepare(
						`INSERT INTO sequence_occurrences
						 (group_id, occurrence_index, offset, start_frame_ordinal, start_raw_offset, end_raw_offset, length)
						 VALUES (@groupId, @occurrenceIndex, @offset, @startFrameOrdinal, @startRawOffset, @endRawOffset, @length)`
					)
					.run({
						groupId,
						occurrenceIndex,
						offset: member.offset,
						startFrameOrdinal: startOrdinal,
						startRawOffset,
						endRawOffset,
						length: group.length
					});
			}
		}
	}
}

/** Verify rows after persistence, before a caller activates the profile. */
export function verifyCanonicalMaterializationRows(
	database: SqliteDatabase,
	profileId: string,
	materialization: CanonicalMaterialization
): { ok: boolean; details?: string } {
	const rows = database
		.prepare(
			"SELECT ordinal, section_id, raw_offsets_json, bytes_json, timestamps_json, directions_json, hidden, signature FROM materialized_frames WHERE profile_id = @profileId ORDER BY ordinal"
		)
		.all({ profileId }) as Array<{
			ordinal: number;
			section_id: string;
			raw_offsets_json: string;
			bytes_json: string;
			timestamps_json: string;
			directions_json: string;
			hidden: number;
			signature: string;
		}>;
	if (rows.length !== materialization.frames.length) return { ok: false, details: "materialized frame count mismatch" };
	for (let index = 0; index < rows.length; index++) {
		const expected = materialization.frames[index];
		const actual = rows[index];
		if (
			actual.ordinal !== expected.ordinal ||
			actual.section_id !== expected.sectionId ||
			JSON.stringify(JSON.parse(actual.raw_offsets_json)) !== JSON.stringify(expected.rawOffsets) ||
			JSON.stringify(JSON.parse(actual.bytes_json)) !== JSON.stringify(expected.bytes) ||
			JSON.stringify(JSON.parse(actual.timestamps_json)) !== JSON.stringify(expected.timestamps) ||
			JSON.stringify(JSON.parse(actual.directions_json)) !== JSON.stringify(expected.directions) ||
			Boolean(actual.hidden) !== expected.hidden ||
			actual.signature !== expected.signature
		) {
			return { ok: false, details: `materialized frame ${index} mismatch` };
		}
	}
	const actualTransitionPositions = database
		.prepare(
			`SELECT section_id, from_signature, to_signature, position, changed_count, transition_count
			 FROM frame_transition_positions WHERE profile_id = @profileId
			 ORDER BY section_id, from_signature, to_signature, position`
		)
		.all({ profileId }) as Array<{
		section_id: string;
		from_signature: string;
		to_signature: string;
		position: number;
		changed_count: number;
		transition_count: number;
	}>;
	const expectedTransitionPositions = deriveTransitionPositionAggregates(materialization.frames);
	const actualTransitionPositionValues = actualTransitionPositions.map(row => ({
		sectionId: row.section_id,
		fromSignature: row.from_signature,
		toSignature: row.to_signature,
		position: row.position,
		changedCount: row.changed_count,
		transitionCount: row.transition_count
	}));
	if (JSON.stringify(actualTransitionPositionValues) !== JSON.stringify(expectedTransitionPositions)) {
		return { ok: false, details: "transition position aggregate mismatch" };
	}
	return { ok: true };
}

export function createFramingRevision(
	database: SqliteDatabase,
	captureId: string,
	newSections: ReframingInputSection[],
	options: { algorithmVersion?: number; generateId?: () => string; nowIso?: () => string } = {}
): { profileId: string; version: number } {
	const nowIso = options.nowIso ?? (() => new Date().toISOString());
	const generateId = (options.generateId ?? randomUUID) as unknown as () => string;
	const algorithmVersion = options.algorithmVersion ?? 1;

	const capture = database.prepare("SELECT id FROM captures WHERE id = @id").get({ id: captureId }) as { id: string } | undefined;
	if (!capture) throw new Error(`capture ${captureId} not found in canonical store`);

	const active = database
		.prepare("SELECT id, version FROM framing_profiles WHERE capture_id = @captureId ORDER BY version DESC LIMIT 1")
		.get({ captureId }) as { id: string; version: number } | undefined;
	const nextVersion = (active?.version ?? 0) + 1;

	// Load raw byte stream from chunks (reassemble)
	const chunks = database
		.prepare("SELECT bytes, timestamps_json, directions_json, hidden_json, start_offset FROM raw_chunks WHERE capture_id = @captureId ORDER BY chunk_index")
		.all({ captureId }) as Array<{
		bytes: Buffer;
		timestamps_json: string;
		directions_json: string;
		hidden_json: string;
		start_offset: number;
	}>;
	const stream: Array<RawByteRecord & { rawOffset: number }> = [];
	for (const ch of chunks) {
		const timestamps: number[] = JSON.parse(ch.timestamps_json) as number[];
		const directions: string[] = JSON.parse(ch.directions_json) as string[];
		const hidden: boolean[] = JSON.parse(ch.hidden_json) as boolean[];
		const bytes = ch.bytes instanceof Buffer ? [...ch.bytes] : Array.from(new Uint8Array(ch.bytes as unknown as Uint8Array));
		for (let i = 0; i < bytes.length; i++) {
			stream.push({
				rawOffset: ch.start_offset + i,
				value: bytes[i],
				timestamp: timestamps[i] ?? 0,
				direction: directions[i] || "rx",
				hidden: Boolean(hidden[i])
			});
		}
	}
	// Normalize sections: ensure sorted, stable ids
	const now = nowIso();
	const normalizedSections: NormalizedSection[] = newSections
		.map((s, idx) => ({
			id: s.id || generateId(),
			start: Math.floor(s.start),
			framingMode: s.framingMode,
			frameSize: s.frameSize ?? 3,
			frameMarker: s.frameMarker ?? "",
			markerPosition: (s.markerPosition ?? "start") as "start" | "end",
			frameTimeGap: s.frameTimeGap ?? 5,
			collapseRuns: Boolean(s.collapseRuns),
			collapsed: Boolean(s.collapsed),
			// position determined by sort below
			_unused: idx
		}))
		.sort((a, b) => a.start - b.start)
		.map((s, position) => ({
			id: s.id,
			start: s.start,
			framingMode: s.framingMode,
			frameSize: s.frameSize,
			frameMarker: s.frameMarker,
			markerPosition: s.markerPosition,
			frameTimeGap: s.frameTimeGap,
			collapseRuns: s.collapseRuns,
			collapsed: s.collapsed,
			position
		})) as unknown as NormalizedSection[];

	if (!normalizedSections.length) throw new Error("at least one framing section is required");

	const frames = materializeFramesFromStream(stream, normalizedSections as unknown as NormalizedSection[], generateId);
	const analysisFrames = frames.map(f => ({ signature: f.signature, bytes: f.bytes }));
	const stats = deriveAnalysisStatistics(analysisFrames);
	const signatures = countSignatures(analysisFrames.map(f => f.signature));
	const patterns = recognizeRepeatedPatterns(
		frames.map((f, idx) => ({ signature: f.signature, originalIndex: idx, sectionId: f.sectionId }))
	);

	// Atomic swap: insert new profile + sections + frames, then activate new profile while keeping previous available.
	const tx = database.transaction(() => {
		const newProfileId = generateId();
		database
			.prepare(
				`INSERT INTO framing_profiles (id, capture_id, version, algorithm_version, is_active, created_at, updated_at)
				 VALUES (@id, @captureId, @version, @algorithmVersion, 0, @createdAt, @updatedAt)`
			)
			.run({
				id: newProfileId,
				captureId,
				version: nextVersion,
				algorithmVersion,
				createdAt: now,
				updatedAt: now
			});
		// sections
		for (let i = 0; i < normalizedSections.length; i++) {
			const s = normalizedSections[i];
			database
				.prepare(
					`INSERT INTO framing_sections (id, profile_id, capture_id, start_offset, position, framing_mode, frame_length, marker_bytes, marker_position, time_gap_ms, collapse_runs, collapsed)
					 VALUES (@id, @profileId, @captureId, @startOffset, @position, @framingMode, @frameLength, @markerBytes, @markerPosition, @timeGapMs, @collapseRuns, @collapsed)`
				)
				.run({
					id: s.id,
					profileId: newProfileId,
					captureId,
					startOffset: s.start,
					position: i,
					framingMode: s.framingMode,
					frameLength: s.framingMode === "length" ? s.frameSize : null,
					markerBytes: s.framingMode === "marker" ? JSON.stringify(parseMarkerBytes(s.frameMarker)) : null,
					markerPosition: s.framingMode === "marker" ? s.markerPosition : null,
					timeGapMs: s.framingMode === "time" ? s.frameTimeGap : null,
					collapseRuns: s.collapseRuns ? 1 : 0,
					collapsed: s.collapsed ? 1 : 0
				});
		}
		// frames
		for (const f of frames) {
			database
				.prepare(
					`INSERT INTO materialized_frames (id, capture_id, profile_id, profile_version, ordinal, section_id, raw_offsets_json, bytes_json, timestamps_json, directions_json, hidden, signature)
					 VALUES (@id, @captureId, @profileId, @profileVersion, @ordinal, @sectionId, @rawOffsetsJson, @bytesJson, @timestampsJson, @directionsJson, @hidden, @signature)`
				)
				.run({
					id: f.id,
					captureId,
					profileId: newProfileId,
					profileVersion: nextVersion,
					ordinal: f.ordinal,
					sectionId: f.sectionId,
					rawOffsetsJson: JSON.stringify(f.rawOffsets),
					bytesJson: JSON.stringify(f.bytes),
					timestampsJson: JSON.stringify(f.timestamps),
					directionsJson: JSON.stringify(f.directions),
					hidden: f.hidden ? 1 : 0,
					signature: f.signature
					});
		}
		persistTransitionPositionAggregates(database, newProfileId, frames);
		// signatures/transitions/byte/bit/sequences truncated then repopulated for new profile only (previous retained)
		for (const [sig, count] of signatures.entries()) {
			database.prepare(`INSERT INTO frame_signatures (profile_id, signature, count) VALUES (@profileId, @signature, @count)`).run({
				profileId: newProfileId, signature: sig, count
			});
		}
		for (const tr of stats.transitions) {
			database
				.prepare(
					`INSERT INTO frame_transitions (profile_id, from_signature, to_signature, count, diffs) VALUES (@profileId, @fromSignature, @toSignature, @count, @diffs)`
				)
				.run({
					profileId: newProfileId,
					fromSignature: tr.from,
					toSignature: tr.to,
					count: tr.count,
					diffs: tr.diffs
				});
		}
		for (let pos = 0; pos < stats.vocabulary.length; pos++) {
			for (const entry of stats.vocabulary[pos] as Array<{ value: number; count: number }>) {
				database.prepare(`INSERT INTO byte_statistics (profile_id, position, value, count) VALUES (@profileId, @position, @value, @count)`).run({
					profileId: newProfileId, position: pos, value: entry.value, count: entry.count
				});
			}
		}
		for (let pos = 0; pos < stats.bitVariance.length; pos++) {
			for (const cell of stats.bitVariance[pos] as Array<{ bit: number; percentage: number; variance: string }>) {
				database
					.prepare(
						`INSERT INTO bit_statistics (profile_id, position, bit, percentage, variance) VALUES (@profileId, @position, @bit, @percentage, @variance)`
					)
					.run({
						profileId: newProfileId, position: pos, bit: cell.bit, percentage: cell.percentage, variance: cell.variance
					});
			}
		}
		// sequence groups truncated for new profile
		for (let gi = 0; gi < patterns.groups.length; gi++) {
			const g = patterns.groups[gi];
			const groupId = generateId();
			database
				.prepare(
					`INSERT INTO sequence_groups (id, capture_id, profile_id, key_text, signatures_json, score, length)
					 VALUES (@id, @captureId, @profileId, @keyText, @signaturesJson, @score, @length)`
				)
				.run({
					id: groupId,
					captureId,
					profileId: newProfileId,
					keyText: g.key,
					signaturesJson: JSON.stringify(g.signatures),
					score: g.score,
					length: g.length
				});
			const occByGroup = new Map<number, Array<{ occurrenceIndex: number; offset: number; originalIndex: number }>>();
			for (const m of patterns.membership) {
				if (m.groupIndex !== gi) continue;
				const list = occByGroup.get(m.occurrenceIndex) || [];
				list.push(m);
				occByGroup.set(m.occurrenceIndex, list);
			}
			for (const [occurrenceIndex, members] of occByGroup.entries()) {
				members.sort((a,b)=>a.offset-b.offset);
				const startOrdinal = members[0].originalIndex;
				const startRaw = frames[members[0].originalIndex]?.rawOffsets[0] ?? 0;
				const endRaw = frames[members[members.length-1].originalIndex]?.rawOffsets.at(-1) ?? startRaw;
				for (const mem of members) {
					database
						.prepare(
							`INSERT INTO sequence_occurrences (group_id, occurrence_index, offset, start_frame_ordinal, start_raw_offset, end_raw_offset, length)
							 VALUES (@groupId, @occurrenceIndex, @offset, @startFrameOrdinal, @startRawOffset, @endRawOffset, @length)`
						)
						.run({
							groupId,
							occurrenceIndex,
							offset: mem.offset,
							startFrameOrdinal: startOrdinal,
							startRawOffset: startRaw,
							endRawOffset: endRaw,
							length: g.length
						});
				}
			}
		}

		// At this point new revision is fully materialized; now atomically activate.
		database.prepare("UPDATE framing_profiles SET is_active = 0 WHERE capture_id = @captureId").run({ captureId });
		database.prepare("UPDATE framing_profiles SET is_active = 1 WHERE id = @id").run({ id: newProfileId });
		database.prepare("UPDATE captures SET active_framing_profile_id = @profileId, updated_at = @now WHERE id = @id").run({
			profileId: newProfileId, id: captureId, now
		});
		return newProfileId;
	});

	const profileId = tx();
	return { profileId, version: nextVersion };
}

// ---------------------------------------------------------------------------
// Helpers for mixed-state reads
// ---------------------------------------------------------------------------
export function isCaptureConverted(database: SqliteDatabase, captureId: string): boolean {
	return readCaptureStorageStatus(database, captureId) === CANONICAL_STORAGE_STATUS;
}

export function getActiveProfile(database: SqliteDatabase, captureId: string): { id: string; version: number } | undefined {
	return database
		.prepare("SELECT id, version FROM framing_profiles WHERE capture_id = @captureId AND is_active = 1 LIMIT 1")
		.get({ captureId }) as { id: string; version: number } | undefined;
}

export function getPreviousProfiles(database: SqliteDatabase, captureId: string): Array<{ id: string; version: number; is_active: number }> {
	return database
		.prepare("SELECT id, version, is_active FROM framing_profiles WHERE capture_id = @captureId ORDER BY version DESC")
		.all({ captureId }) as Array<{ id: string; version: number; is_active: number }>;
}

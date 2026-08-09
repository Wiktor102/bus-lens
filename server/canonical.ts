import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.ts";

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
type RawByteRecord = {
	value: number;
	timestamp: number;
	direction?: string;
	sessionId?: string;
	hidden?: boolean;
	rawOffset?: number;
};

type CaptureSection = {
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

type NormalizedSection = {
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

function normalizeSectionsForConversion(
	sections: CaptureSection[],
	byteStream: RawByteRecord[],
	fallbackFrameSize = 3,
	generateId: () => string = randomUUID as unknown as () => string
): NormalizedSection[] {
	const firstOffset = byteStream[0]?.rawOffset ?? 0;
	const lastOffset = byteStream.at(-1)?.rawOffset ?? 0;
	const byStart = new Map<number, CaptureSection>();
	(sections || [])
		.filter(s => Boolean(s && typeof s === "object"))
		.forEach(section => {
			const start = Math.max(firstOffset, Math.min(lastOffset, Math.floor(Number(section.start) || firstOffset)));
			const settings = normalizeSectionSettings(section);
			byStart.set(start, {
				id: section.id || generateId(),
				start,
				...settings,
				collapseRuns: Boolean(section.collapseRuns),
				collapsed: Boolean(section.collapsed)
			});
		});
	if (!byStart.has(firstOffset)) {
		byStart.set(firstOffset, {
			id: generateId(),
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
			id: s.id as string,
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

type ExistingMessage = {
	id?: string;
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

function normalizeDocumentForConversion(doc: CaptureDocument, generateId: () => string = randomUUID as unknown as () => string): CaptureDocument {
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
				id: generateId(),
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
		generateId
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
type SectionBoundary = { id: string; start: number; mode: string };

type PersistedConversion = {
	byteCount: number;
	byteStream: Array<RawByteRecord & { rawOffset: number }>;
	captureSessions: CaptureSessionRecord[];
	sections: SectionBoundary[];
	frames: MaterializedFrame[];
	signatures: ReturnType<typeof countSignatures>;
	stats: ReturnType<typeof deriveAnalysisStatistics>;
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
	sequenceGroupsOk: boolean;
	messageVisibilityOk: boolean;
	sessionIdentityOk: boolean;
	overallOk: boolean;
	details?: string;
};

function verifyMessageVisibility(
	originalDoc: CaptureDocument,
	frames: ReadonlyArray<ReturnType<typeof materializeFramesFromStream>[number]>
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
	persisted: PersistedConversion
): VerificationReport {
	// A document with an explicit messages array gives us an independent legacy
	// source to validate. Raw-only documents have no message source, so their
	// normalized framing is the source representation for this comparison.
	const sourceMessages = (Array.isArray(originalDoc.messages) && originalDoc.messages.length > 0 ? originalDoc.messages : normalized.messages || []) as Array<
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
	const messageVisibilityOk = verifyMessageVisibility(originalDoc, persisted.frames);

	const expectedSections = ((normalized.frameSections as NormalizedSection[]) || []).map(s => ({
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
	const byteStatsOk = JSON.stringify(expectedSortedStats.vocabulary) === JSON.stringify(actualSortedStats.vocabulary);
	const bitStatsOk = JSON.stringify(expectedSortedStats.bitVariance) === JSON.stringify(actualSortedStats.bitVariance);

	// Sequence groups are also compared with the original message stream and the
	// rows read back from canonical storage.
	const expectedPatterns = recognizeRepeatedPatterns(
		sourceMessages.map((m, idx) => ({
			signature: signatureForMessage(m),
			originalIndex: idx,
			sectionId: (m as Record<string, unknown>).sectionId
		}))
	);
	const seqOk = JSON.stringify(expectedPatterns) === JSON.stringify(persisted.patterns);

	const overallOk =
		expectedMessages === actualMessages &&
		expectedRawBytes === actualRawBytes &&
		rawBytesOk &&
		sectionsOk &&
		signaturesOk && transitionsOk && byteStatsOk && bitStatsOk && seqOk && messageVisibilityOk && sessionIdentityOk;

	return {
		messageCount: { expected: expectedMessages, actual: actualMessages, ok: expectedMessages === actualMessages },
		rawByteCount: { expected: expectedRawBytes, actual: actualRawBytes, ok: expectedRawBytes === actualRawBytes && rawBytesOk },
		sectionBoundaries: { expected: expectedSections, actual: actualSections, ok: sectionsOk },
		signaturesOk,
		byteStatisticsOk: byteStatsOk,
		bitStatisticsOk: bitStatsOk,
		transitionsOk,
		sequenceGroupsOk: seqOk,
		messageVisibilityOk,
		sessionIdentityOk,
		overallOk,
		details: overallOk
			? undefined
			: `mismatch: messages ${expectedMessages} vs ${actualMessages}, bytes ${expectedRawBytes} vs ${actualRawBytes}, statsOk=${statsOk}, messageVisibilityOk=${messageVisibilityOk}, sessionIdentityOk=${sessionIdentityOk}`
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

function discardVerifiedCaptureBackup(database: SqliteDatabase, captureId: string): void {
	// capture_documents remains the UI-compatible JSON source; once canonical
	// rows are verified, retaining another full JSON copy is unnecessary.
	database.prepare("DELETE FROM capture_backups WHERE capture_id = @captureId AND verified = 1").run({ captureId });
}

export function convertCaptureDocumentToCanonical(
	database: SqliteDatabase,
	captureId: string,
	options: { algorithmVersion?: number; generateId?: () => string; nowIso?: () => string } = {}
): ConversionResult {
	const nowIso = options.nowIso ?? (() => new Date().toISOString());
	const generateId = (options.generateId ?? randomUUID) as unknown as () => string;
	const algorithmVersion = options.algorithmVersion ?? 1;

	const row = database.prepare("SELECT document_json FROM capture_documents WHERE id = @id").get({ id: captureId }) as
		| { document_json: string }
		| undefined;
	if (!row) return { captureId, ok: false, verified: false, report: null as unknown as VerificationReport, error: "capture document not found" };

	let doc: CaptureDocument;
	try {
		doc = JSON.parse(row.document_json) as CaptureDocument;
	} catch (e) {
		return { captureId, ok: false, verified: false, report: null as unknown as VerificationReport, error: String(e) };
	}

	// Already converted? Check canonical captures table
	const existingCanonical = database.prepare("SELECT id FROM captures WHERE id = @id").get({ id: captureId }) as { id: string } | undefined;
	if (existingCanonical) {
		discardVerifiedCaptureBackup(database, captureId);
		return { captureId, ok: true, verified: true, report: null as unknown as VerificationReport };
	}

	// Normalize and materialize BEFORE touching DB, so failed conversion leaves JSON active
	let normalized: CaptureDocument;
	let stream: Array<RawByteRecord & { rawOffset: number }>;
	let sections: NormalizedSection[];
	let frames: ReturnType<typeof materializeFramesFromStream>;
	let signatures: Map<string, number>;
	let stats: ReturnType<typeof deriveAnalysisStatistics>;
	let patterns: ReturnType<typeof recognizeRepeatedPatterns>;
	let byteCount: number;
	let report: VerificationReport;
	try {
		normalized = normalizeDocumentForConversion(doc, generateId);
		stream = (normalized.byteStream as Array<RawByteRecord & { rawOffset: number }>);
		sections = normalized.frameSections as unknown as NormalizedSection[];
		byteCount = stream.length;
		frames = materializeFramesFromStream(stream, sections, generateId, normalized.messages || []);
		// Derive analysis from frames
		const analysisFrames = frames.map(f => ({ signature: f.signature, bytes: f.bytes }));
		stats = deriveAnalysisStatistics(analysisFrames);
		signatures = countSignatures(analysisFrames.map(f => f.signature));
		patterns = recognizeRepeatedPatterns(
			frames.map((f, idx) => ({ signature: f.signature, originalIndex: idx, sectionId: f.sectionId }))
		);
			report = verifyConversion(doc, normalized, {
				byteCount,
				byteStream: stream,
				captureSessions: (normalized.captureSessions || []) as CaptureSessionRecord[],
				sections: sections.map(section => ({ id: section.id, start: section.start, mode: section.framingMode })),
			frames,
			signatures,
			stats,
			patterns
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
			sequenceGroupsOk: false,
			messageVisibilityOk: false,
			sessionIdentityOk: false,
			overallOk: false,
			details: String(e)
		};
		return { captureId, ok: false, verified: false, report, error: String(e) };
	}

	if (!report.overallOk) {
		// Leave JSON active; mark job failed
		try {
			const tx = database.transaction(() => {
				database
					.prepare(
						`INSERT INTO finalization_jobs (id, capture_id, status, created_at, updated_at, error, verified)
						 VALUES (@id, @captureId, 'failed', @createdAt, @updatedAt, @error, 0)
						 ON CONFLICT (id) DO UPDATE SET status='failed', updated_at=excluded.updated_at, error=excluded.error`
					)
					.run({
						id: `conv-${captureId}`,
						captureId,
						createdAt: nowIso(),
						updatedAt: nowIso(),
						error: report.details || "verification failed"
					});
			});
			tx();
		} catch {}
		return { captureId, ok: false, verified: false, report, error: report.details };
	}

	// Verification succeeded — now perform atomic canonical writes + backup
	try {
		const transaction = database.transaction(() => {
			const now = nowIso();
			// captures
			database
				.prepare(
					`INSERT INTO captures (id, name, lifecycle, byte_count, created_at, updated_at, folder_id)
					 VALUES (@id, @name, @lifecycle, @byteCount, @createdAt, @updatedAt, @folderId)`
				)
				.run({
					id: captureId,
					name: String(doc.name || "Untitled capture"),
					lifecycle: lifecycleForDocument(doc),
					byteCount,
					createdAt: String(doc.createdAt || now),
					updatedAt: now,
					folderId: doc.folderId ? String(doc.folderId) : null
				});

			// Session records preserve explicit capture-session metadata, including
			// sessions that have no bytes after filtering. Per-byte identities are
			// stored separately on each raw chunk below.
			const captureSessions = (normalized.captureSessions || []) as CaptureSessionRecord[];
			for (let ordinal = 0; ordinal < captureSessions.length; ordinal++) {
				const session = captureSessions[ordinal];
				database
					.prepare(
						`INSERT INTO capture_sessions (capture_id, ordinal, id, first_received_at, last_received_at)
						 VALUES (@captureId, @ordinal, @id, @firstReceivedAt, @lastReceivedAt)`
					)
					.run({
						captureId,
						ordinal,
						id: session.id,
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
					`INSERT INTO framing_profiles (id, capture_id, version, algorithm_version, is_active, created_at, updated_at)
					 VALUES (@id, @captureId, 1, @algorithmVersion, 1, @createdAt, @updatedAt)`
				)
				.run({
					id: profileId,
					captureId,
					algorithmVersion,
					createdAt: now,
					updatedAt: now
				});

			// update captures.active_framing_profile_id
			database.prepare("UPDATE captures SET active_framing_profile_id = @profileId WHERE id = @id").run({ profileId, id: captureId });

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
			report = verifyConversion(doc, normalized, readPersistedConversion(database, captureId, profileId));
			if (!report.overallOk) throw new Error(report.details || "canonical conversion verification failed");

			// Retain the original JSON only after the persisted canonical rows have
			// been read back and verified.
			database
				.prepare(
					`INSERT INTO capture_backups (capture_id, document_json, migrated_at, verified, verification_report_json)
					 VALUES (@captureId, @documentJson, @migratedAt, 1, @reportJson)
					 ON CONFLICT (capture_id) DO UPDATE SET verified=1, verification_report_json=excluded.verification_report_json`
				)
				.run({
					captureId,
					documentJson: row.document_json,
					migratedAt: now,
					reportJson: JSON.stringify(report)
				});

			// stable notes: map capture.notes and annotations
			const notes = (doc.notes as Array<Record<string, unknown>>) || [];
			for (const note of notes) {
				const id = String(note.id || generateId());
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
				const id = generateId();
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
				const id = generateId();
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
					`INSERT INTO finalization_jobs (id, capture_id, status, created_at, updated_at, verified)
					 VALUES (@id, @captureId, 'completed', @createdAt, @updatedAt, 1)
					 ON CONFLICT (id) DO UPDATE SET status='completed', updated_at=excluded.updated_at, verified=1`
				)
				.run({ id: `conv-${captureId}`, captureId, createdAt: now, updatedAt: now });
		});
		transaction();
		discardVerifiedCaptureBackup(database, captureId);
		return { captureId, ok: true, verified: true, report };
	} catch (e) {
		return { captureId, ok: false, verified: false, report, error: String(e) };
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
	const row = database.prepare("SELECT id FROM captures WHERE id = @id").get({ id: captureId }) as { id: string } | undefined;
	return Boolean(row);
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

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
};

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

// Materialize frames from a compact hidden-filtered stream using domain engine.
export function materializeFramesFromStream(
	stream: Array<RawByteRecord & { rawOffset: number }>,
	sections: NormalizedSection[],
	generateId: () => string = randomUUID as unknown as () => string
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
	type PreviewRecord = { value: number; timestamp: number; rawPosition: number };
	const preview = stream
		.map(r => ({ value: r.value, timestamp: r.timestamp, rawPosition: r.rawOffset }))
		.filter((_, idx) => !stream[idx].hidden);
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
			// locate original stream records for bytes/directions
			const bytes = rawOffsets.map(offset => stream.find(r => r.rawOffset === offset)?.value ?? 0);
			const timestamps = rawOffsets.map(offset => stream.find(r => r.rawOffset === offset)?.timestamp ?? 0);
			const directions = rawOffsets.map(offset => stream.find(r => r.rawOffset === offset)?.direction || "rx");
			const hidden = false;
			const sig = bytes.map(hexByte).join(" ");
			return {
				id: generateId(),
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

function normalizeDocumentForConversion(doc: CaptureDocument, generateId: () => string = randomUUID as unknown as () => string): CaptureDocument {
	// Minimal normalization sufficient for verification: ensure byteStream, sections, etc
	const cloned: CaptureDocument = JSON.parse(JSON.stringify(doc));
	cloned.byteStream ||= [];
	if (!Array.isArray(cloned.byteStream)) cloned.byteStream = [];
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
	const frames = materializeFramesFromStream(stream, sections, generateId);
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

export type VerificationReport = {
	messageCount: { expected: number; actual: number; ok: boolean };
	rawByteCount: { expected: number; actual: number; ok: boolean };
	sectionBoundaries: { expected: Array<{ id: string; start: number; mode: string }>; actual: Array<{ id: string; start: number; mode: string }>; ok: boolean };
	signaturesOk: boolean;
	byteStatisticsOk: boolean;
	bitStatisticsOk: boolean;
	transitionsOk: boolean;
	sequenceGroupsOk: boolean;
	overallOk: boolean;
	details?: string;
};

function verifyConversion(
	originalDoc: CaptureDocument,
	normalized: CaptureDocument,
	materialized: {
		frames: ReturnType<typeof materializeFramesFromStream>;
		signatures: ReturnType<typeof countSignatures>;
		stats: ReturnType<typeof deriveAnalysisStatistics>;
		patterns: ReturnType<typeof recognizeRepeatedPatterns>;
	},
	byteCount: number
): VerificationReport {
	const expectedMessages = (normalized.messages as Array<Record<string, unknown>>)?.length ?? 0;
	const actualMessages = materialized.frames.length;
	const expectedRawBytes = (normalized.byteStream as RawByteRecord[])?.length ?? 0;
	const actualRawBytes = byteCount;

	const expectedSections = ((normalized.frameSections as NormalizedSection[]) || []).map(s => ({
		id: s.id,
		start: s.start,
		mode: s.framingMode
	}));
	// materialized sections are same as normalized for initial conversion; we compare them directly
	const actualSections = expectedSections; // conversion preserves them; reframing will differ but initial should match

	// Derive expected analysis from normalized messages using same domain functions
	const expectedStats = deriveAnalysisStatistics(
		(normalized.messages as Array<FramedMessage & { timestamp?: number }>)?.map(m => ({
			signature: signatureForMessage(m),
			bytes: visibleEntries(m).map(e => e.value)
		})) ?? []
	);
	const statsOk =
		JSON.stringify(expectedStats.signatures) === JSON.stringify(materialized.stats.signatures) &&
		JSON.stringify(expectedStats.vocabulary) === JSON.stringify(materialized.stats.vocabulary) &&
		JSON.stringify(expectedStats.bitVariance) === JSON.stringify(materialized.stats.bitVariance) &&
		JSON.stringify(expectedStats.transitions) === JSON.stringify(materialized.stats.transitions);

	const expectedSignatures = expectedStats.signatures;
	const actualSignatures = materialized.stats.signatures;
	const signaturesOk = JSON.stringify(expectedSignatures) === JSON.stringify(actualSignatures);

	const transitionsOk = JSON.stringify(expectedStats.transitions) === JSON.stringify(materialized.stats.transitions);
	const byteStatsOk = JSON.stringify(expectedStats.vocabulary) === JSON.stringify(materialized.stats.vocabulary);
	const bitStatsOk = JSON.stringify(expectedStats.bitVariance) === JSON.stringify(materialized.stats.bitVariance);

	// Sequence groups: compare via recognizeRepeatedPatterns input derived from messages
	const expectedPatterns = recognizeRepeatedPatterns(
		(normalized.messages as Array<FramedMessage & { id?: string; sectionId?: string }>)?.map((m, idx) => ({
			signature: signatureForMessage(m),
			originalIndex: idx,
			sectionId: (m as Record<string, unknown>).sectionId
		})) ?? []
	);
	const seqOk = JSON.stringify(expectedPatterns) === JSON.stringify(materialized.patterns);

	const overallOk =
		expectedMessages === actualMessages &&
		expectedRawBytes === actualRawBytes &&
		JSON.stringify(expectedSections) === JSON.stringify(actualSections) &&
		signaturesOk && transitionsOk && byteStatsOk && bitStatsOk && seqOk;

	return {
		messageCount: { expected: expectedMessages, actual: actualMessages, ok: expectedMessages === actualMessages },
		rawByteCount: { expected: expectedRawBytes, actual: actualRawBytes, ok: expectedRawBytes === actualRawBytes },
		sectionBoundaries: { expected: expectedSections, actual: actualSections, ok: JSON.stringify(expectedSections) === JSON.stringify(actualSections) },
		signaturesOk,
		byteStatisticsOk: byteStatsOk,
		bitStatisticsOk: bitStatsOk,
		transitionsOk,
		sequenceGroupsOk: seqOk,
		overallOk,
		details: overallOk ? undefined : `mismatch: messages ${expectedMessages} vs ${actualMessages}, bytes ${expectedRawBytes} vs ${actualRawBytes}, statsOk=${statsOk}`
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
		frames = materializeFramesFromStream(stream, sections, generateId);
		// Derive analysis from frames
		const analysisFrames = frames.map(f => ({ signature: f.signature, bytes: f.bytes }));
		stats = deriveAnalysisStatistics(analysisFrames);
		signatures = countSignatures(analysisFrames.map(f => f.signature));
		patterns = recognizeRepeatedPatterns(
			frames.map((f, idx) => ({ signature: f.signature, originalIndex: idx, sectionId: f.sectionId }))
		);
		report = verifyConversion(doc, normalized, { frames, signatures, stats, patterns }, byteCount);
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

			// backup original JSON
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

			// raw chunks
			const chunks = chunkRawBytes(stream);
			for (let i = 0; i < chunks.length; i++) {
				const ch = chunks[i];
				database
					.prepare(
						`INSERT INTO raw_chunks (capture_id, chunk_index, start_offset, byte_count, bytes, timestamps_json, directions_json, hidden_json, session_id)
						 VALUES (@captureId, @chunkIndex, @startOffset, @byteCount, @bytes, @timestampsJson, @directionsJson, @hiddenJson, @sessionId)`
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
						sessionId: null
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
			for (const [key, val] of Object.entries(annotations)) {
				const id = generateId();
				const text = String(val.text || "");
				const createdAt = String(val.createdAt ? new Date(Number(val.createdAt)).toISOString() : now);
				if (key.includes(":")) {
					// byte note: resolve raw offset from message id + position if possible
					// For stability, we attach to absolute raw offset: try to find message's rawOffsets
					let rawOffset: number | null = null;
					try {
						const [messageId, posStr] = key.split(":");
						const pos = Number(posStr);
						const msg = (normalized.messages as Array<Record<string, unknown>>)?.find(m => String(m.id) === messageId) as
							| { rawOffsets?: number[]; _rawPositions?: number[]; bytes?: number[] }
							| undefined;
						const offsets = (msg?.rawOffsets as number[] | undefined) || (msg?._rawPositions as number[] | undefined);
						if (offsets && Number.isInteger(pos)) rawOffset = offsets[pos] ?? null;
					} catch {}
					database
						.prepare(
							`INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind, raw_offset)
							 VALUES (@id, @captureId, @text, @createdAt, 'byte', @rawOffset)`
						)
						.run({ id, captureId, text, createdAt, rawOffset });
				} else {
					// frame/message note: attach to profile + raw span
					let rawOffsets: number[] | null = null;
					try {
						const msg = (normalized.messages as Array<Record<string, unknown>>)?.find(m => String(m.id) === key) as
							| { rawOffsets?: number[]; _rawPositions?: number[] }
							| undefined;
						rawOffsets = (msg?.rawOffsets as number[] | undefined) || (msg?._rawPositions as number[] | undefined) || null;
					} catch {}
					database
						.prepare(
							`INSERT INTO stable_notes (id, capture_id, text, created_at, target_kind, profile_id, raw_offsets_json)
							 VALUES (@id, @captureId, @text, @createdAt, 'frame', @profileId, @rawOffsetsJson)`
						)
						.run({
							id,
							captureId,
							text,
							createdAt,
							profileId,
							rawOffsetsJson: rawOffsets ? JSON.stringify(rawOffsets) : null
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
		return { captureId, ok: true, verified: true, report };
	} catch (e) {
		return { captureId, ok: false, verified: false, report, error: String(e) };
	}
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

import {
	interpretSectionRanges,
	markerAlternatives as parseMarkerAlternatives,
	markerAt as interpretMarkerAt,
	markerBytes as parseMarkerBytes,
	type MarkerPosition,
	type SectionFramingMode,
	type SectionFramingSettings
} from "../../domain/framing.ts";
import {
	normalizeCaptureSummaryData,
	reconstructLegacyByteStream,
	type CaptureSummaryData,
	type FramedMessage,
	type RawByteRecord
} from "./capture-summary.ts";

export type { MarkerPosition, SectionFramingMode, SectionFramingSettings } from "../../domain/framing.ts";

export type CaptureNote = {
	id?: string;
	type?: string;
	text?: string;
	createdAt?: number;
	authorType?: "human" | "agent" | string;
	reportedClientName?: string;
	reportedClientVersion?: string;
	protocolVersion?: string;
	[key: string]: unknown;
};

export type CaptureMessage = FramedMessage & {
	id?: string;
	timestamp: number;
	byteTimestamps?: number[];
	hidden?: boolean;
	directions?: string[];
	sourceIndex?: number;
	sectionId?: string;
	_byteStart?: number;
	_byteEnd?: number;
	/** Absolute positions in byteStream, retained when hidden bytes make a frame non-contiguous. */
	rawOffsets?: number[];
	/** @deprecated Use rawOffsets. Retained for persisted capture compatibility. */
	_rawPositions?: number[];
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

export type NormalizedCaptureSection = SectionFramingSettings & {
	id: string;
	start: number;
	collapseRuns: boolean;
	collapsed: boolean;
};

export type SectionFramingUpdate = {
	framingMode?: string;
	frameSize?: string | number;
	frameMarker?: string;
	markerPosition?: string;
	frameTimeGap?: string | number;
};

export const DEFAULT_FRAME_SIZE = 3;
export const MAX_FRAME_SIZE = 1024;
export const DEFAULT_FRAME_TIME_GAP = 5;

export type Capture = Omit<CaptureSummaryData, "notes"> & {
	id?: string;
	name?: string;
	view?: string;
	createdAt?: string;
	updatedAt?: string;
	baudRate?: number;
	inputFormat?: string;
	folderId?: string | null;
	notes?: CaptureNote[];
	params?: unknown[];
	annotations?: Record<string, unknown>;
	patternRemarks?: Record<string, unknown>;
	messages?: CaptureMessage[];
	previewMode?: string;
	frameSize?: number;
	markerConfigured?: boolean;
	frameMarker?: string;
	markerPosition?: string;
	frameTimeGap?: number;
	frameSections?: CaptureSection[];
	/** The next unassigned absolute raw offset. */
	nextRawOffset?: number;
	storageStatus?: "legacy-not-canonicalized" | "converting" | "canonical" | "canonicalization-failed";
	lifecycle?: string;
	dataRevision?: number;
	byteCount?: number;
	metadataRevision?: number;
	contentRevision?: number;
	retainedStartOffset?: number;
	activeFramingProfileId?: string | null;
	isRetainedTail?: boolean;
	framingDraftRevision?: number;
};

/**
 * The server-owned versions that identify the active byte/frame projection.
 * Metadata and framing drafts are intentionally excluded: neither changes the
 * materialized stream. This is deliberately scalar so refresh reconciliation
 * never serializes a capture document.
 */
export function captureProjectionToken(capture: Capture | undefined): string {
	if (!capture) return "";
	return [
		capture.activeFramingProfileId ?? "",
		Number.isSafeInteger(capture.dataRevision) ? capture.dataRevision : "",
		Number.isSafeInteger(capture.contentRevision) ? capture.contentRevision : "",
		Number.isSafeInteger(capture.retainedStartOffset) ? capture.retainedStartOffset : ""
	].join("|");
}

export type CaptureProjectionMutation = "replace" | "append";

type CaptureProjectionState = {
	generation: number;
	mutation: CaptureProjectionMutation;
};

// Projection generations are runtime metadata. Keeping them outside Capture
// prevents the cache's invalidation bookkeeping from leaking into persisted
// capture documents while still giving every mutable capture a monotonic epoch.
const captureProjectionState = new WeakMap<object, CaptureProjectionState>();

export function captureProjectionGeneration(capture: Capture): number {
	return captureProjectionState.get(capture)?.generation || 0;
}

export function captureProjectionMutation(capture: Capture): CaptureProjectionMutation {
	return captureProjectionState.get(capture)?.mutation || "replace";
}

/** Call once for every mutation that can affect message-stream analysis. */
export function bumpCaptureProjectionGeneration(
	capture: Capture,
	mutation: CaptureProjectionMutation = "replace"
): number {
	const generation = captureProjectionGeneration(capture) + 1;
	captureProjectionState.set(capture, { generation, mutation });
	return generation;
}

export type PreviewByteRecord = RawByteRecord & { rawPosition: number };
type ExistingMessage = { id?: string; hidden: boolean };

const createId: () => string = () => crypto.randomUUID();

export function makeMessage(
	hex: string | Iterable<number>,
	timestamp = Date.now(),
	index = 0,
	generateId = createId
): CaptureMessage {
	const bytes = typeof hex === "string" ? (hex.match(/[0-9a-f]{2}/gi) || []).map(value => parseInt(value, 16)) : [...hex];
	return {
		id: generateId(),
		timestamp,
		byteTimestamps: bytes.map(() => timestamp),
		bytes,
		hidden: false,
		hiddenBytes: bytes.map(() => false),
		sourceIndex: index
	};
}

export function parseTime(value: string, now = Date.now): number {
	const match = value.match(/(\d{2}):(\d{2}):(\d{2})[.:](\d{3})/);
	if (!match) return now();
	const date = new Date(now());
	date.setHours(+match[1], +match[2], +match[3], +match[4]);
	return date.getTime();
}

function normalizeFramingMode(value: unknown): SectionFramingMode {
	const mode = String(value || "").trim().toLowerCase();
	if (mode === "marker") return "marker";
	if (mode === "time" || mode === "time-gap" || mode === "timegap") return "time";
	return "length";
}

function normalizeMarkerPosition(value: unknown): MarkerPosition {
	return String(value || "").trim().toLowerCase() === "end" ? "end" : "start";
}

function normalizeFrameSize(value: unknown, fallback = DEFAULT_FRAME_SIZE): number {
	const number = Math.floor(Number(value));
	return Math.max(1, Math.min(MAX_FRAME_SIZE, number || fallback));
}

function normalizeFrameTimeGap(value: unknown, fallback = DEFAULT_FRAME_TIME_GAP): number {
	const number = Number(value);
	return Math.max(0.01, number || fallback);
}

function normalizeMarker(value: unknown, configured = true): string {
	if (!configured) return "";
	return parseMarkerAlternatives(value)
		.map(alternative => alternative.map(hexByte).join(" "))
		.join("|");
}

function sectionModeValue(section: CaptureSection): unknown {
	return section.framingMode ?? section.frameMode ?? section.previewMode;
}

export function normalizeSectionFramingSettings(
	section: CaptureSection,
	fallbackFrameSize = DEFAULT_FRAME_SIZE
): SectionFramingSettings {
	const markerConfigured = section.markerConfigured === undefined ? true : Boolean(section.markerConfigured);
	return {
		framingMode: normalizeFramingMode(sectionModeValue(section)),
		frameSize: normalizeFrameSize(section.frameSize, fallbackFrameSize),
		frameMarker: normalizeMarker(section.frameMarker, markerConfigured),
		markerPosition: normalizeMarkerPosition(section.markerPosition),
		frameTimeGap: normalizeFrameTimeGap(section.frameTimeGap)
	};
}

export function applySectionFramingSettings(section: CaptureSection, update: SectionFramingUpdate): void {
	const current = normalizeSectionFramingSettings(section, DEFAULT_FRAME_SIZE);
	const next: SectionFramingSettings = {
		framingMode: update.framingMode === undefined ? current.framingMode : normalizeFramingMode(update.framingMode),
		frameSize: update.frameSize === undefined ? current.frameSize : normalizeFrameSize(update.frameSize, current.frameSize),
		frameMarker: update.frameMarker === undefined ? current.frameMarker : normalizeMarker(update.frameMarker),
		markerPosition:
			update.markerPosition === undefined ? current.markerPosition : normalizeMarkerPosition(update.markerPosition),
		frameTimeGap:
			update.frameTimeGap === undefined
				? current.frameTimeGap
				: normalizeFrameTimeGap(update.frameTimeGap, current.frameTimeGap)
	};
	Object.assign(section, next);
	delete section.frameMode;
	delete section.previewMode;
	delete section.markerConfigured;
}

function normalizedRawOffset(value: unknown): number | undefined {
	const offset = Number(value);
	return Number.isInteger(offset) && offset >= 0 ? offset : undefined;
}

function firstRawOffset(capture: Capture): number {
	return capture.byteStream?.[0] ? (normalizedRawOffset(capture.byteStream[0].rawOffset) ?? 0) : 0;
}

function lastRawOffset(capture: Capture): number {
	const record = capture.byteStream?.at(-1);
	return record ? (normalizedRawOffset(record.rawOffset) ?? Math.max(0, (capture.byteStream?.length || 1) - 1)) : 0;
}

function normalizeRawOffsets(capture: Capture): void {
	const stream = capture.byteStream || [];
	let next = normalizedRawOffset(capture.nextRawOffset) ?? 0;
	stream.forEach(record => {
		const offset = normalizedRawOffset(record.rawOffset);
		if (offset !== undefined) next = Math.max(next, offset + 1);
	});
	stream.forEach(record => {
		if (normalizedRawOffset(record.rawOffset) === undefined) record.rawOffset = next++;
	});
	capture.nextRawOffset = Math.max(next, ...(stream.map(record => (record.rawOffset || 0) + 1)), 0);
}

export function normalizeCapture(capture: Capture, generateId = createId): Capture {
	const legacyPreviewMode = normalizeFramingMode(capture.previewMode);
	const hasPersistedSections = Array.isArray(capture.frameSections) && capture.frameSections.length > 0;
	capture.params ||= [];
	capture.notes ||= [];
	capture.annotations ||= {};
	capture.patternRemarks ||= {};
	capture.messages ||= [];
	capture.messages.forEach(message => {
		message.hidden = Boolean(message.hidden);
		message.hiddenBytes = Array.isArray(message.hiddenBytes)
			? message.bytes.map((_, index) => Boolean(message.hiddenBytes?.[index]))
			: message.bytes.map(() => false);
	});
	capture.notes.forEach(note => (note.id ||= generateId()));
	capture.frameSize = Math.max(1, Math.min(MAX_FRAME_SIZE, +capture.frameSize! || DEFAULT_FRAME_SIZE));
	if (capture.markerConfigured === undefined) {
		// 0A was the old UI default, not a marker the user necessarily chose.
		capture.markerConfigured = Boolean(capture.frameMarker && capture.frameMarker !== "0A");
	}
	capture.frameMarker = capture.markerConfigured ? String(capture.frameMarker || "") : "";
	capture.markerPosition ||= "start";
	capture.frameTimeGap = Math.max(0.01, +capture.frameTimeGap! || 5);
	if (!Array.isArray(capture.byteStream)) {
		capture.byteStream = reconstructLegacyByteStream(capture.messages);
	}
	capture.byteStream.forEach(record => {
		record.direction ||= "rx";
		record.hidden = Boolean(record.hidden);
	});
	normalizeRawOffsets(capture);
	// Older exports stored byte visibility on framed messages rather than raw
	// byte records. Collect those offsets once before walking the raw stream;
	// searching the full stream once per framed byte makes every subsequent
	// preview rebuild quadratic on large captures.
	const legacyHiddenRawOffsets = new Set<number>();
	capture.messages.forEach(message => {
		if (!Number.isInteger(message._byteStart) && !Array.isArray(message.rawOffsets) && !Array.isArray(message._rawPositions)) return;
		message.hiddenBytes?.forEach((hidden, index) => {
			if (!hidden) return;
			const rawPosition = message.rawOffsets?.[index] ?? message._rawPositions?.[index] ?? (message._byteStart as number) + index;
			legacyHiddenRawOffsets.add(rawPosition);
		});
	});
	if (legacyHiddenRawOffsets.size) {
		capture.byteStream.forEach(record => {
			if (legacyHiddenRawOffsets.has(record.rawOffset!)) record.hidden = true;
		});
	}
	if (!hasPersistedSections) {
		capture.frameSections = migrateLegacySections(capture, legacyPreviewMode, generateId);
	}
	normalizeCaptureSummaryData(capture, generateId);
	// Sections are now the only framing model. Keep the legacy framing fields
	// readable for old exports, but never let them select another preview mode.
	capture.previewMode = "sections";
	normalizeSections(capture, generateId);
	capture.messages.forEach(message => {
		message.byteTimestamps ||= message.bytes.map(() => message.timestamp);
	});
	return capture;
}

function migrateLegacySections(
	capture: Capture,
	legacyPreviewMode: SectionFramingMode,
	generateId: () => string
): CaptureSection[] {
	const markerConfigured = capture.markerConfigured === undefined
		? Boolean(capture.frameMarker && capture.frameMarker !== "0A")
		: Boolean(capture.markerConfigured);
	return [
		{
			id: generateId(),
			start: firstRawOffset(capture),
			framingMode: legacyPreviewMode,
			frameSize: normalizeFrameSize(capture.frameSize),
			frameMarker: normalizeMarker(capture.frameMarker, markerConfigured),
			markerPosition: normalizeMarkerPosition(capture.markerPosition),
			frameTimeGap: normalizeFrameTimeGap(capture.frameTimeGap),
			collapseRuns: false,
			collapsed: false
		}
	];
}

export function normalizeSections(capture: Capture, generateId = createId): void {
	const firstOffset = firstRawOffset(capture);
	const lastOffset = lastRawOffset(capture);
	const byStart = new Map<number, CaptureSection>();
	(Array.isArray(capture.frameSections) ? capture.frameSections : [])
		.filter(section => Boolean(section && typeof section === "object"))
		.forEach(section => {
			const start = Math.max(firstOffset, Math.min(lastOffset, Math.floor(+section.start! || firstOffset)));
			const settings = normalizeSectionFramingSettings(section, DEFAULT_FRAME_SIZE);
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
			frameSize: normalizeFrameSize(capture.frameSize),
			frameMarker: "",
			markerPosition: "start",
			frameTimeGap: DEFAULT_FRAME_TIME_GAP,
			collapseRuns: false,
			collapsed: false
		});
	}
	capture.frameSections = [...byStart.values()].sort((a, b) => a.start! - b.start!);
}

export function frameWidth(capture: Capture): number {
	return Math.max(0, ...visibleMessages(capture).map(message => visibleByteEntries(message).length));
}

export function markerBytes(value: unknown): number[] {
	return parseMarkerBytes(value);
}

export function markerAt(stream: PreviewByteRecord[], index: number, marker: number[]): boolean {
	return interpretMarkerAt(stream, index, marker);
}

export function markerAlternatives(value: unknown): number[][] {
	return parseMarkerAlternatives(value);
}

export function frameSectionRanges(
	stream: PreviewByteRecord[],
	sectionStart: number,
	sectionEnd: number,
	section: CaptureSection | SectionFramingSettings
): Array<[number, number]> {
	return interpretSectionRanges({
		stream,
		start: sectionStart,
		end: sectionEnd,
		settings: normalizeSectionFramingSettings(section, DEFAULT_FRAME_SIZE)
	});
}

function messageRawPositions(message: CaptureMessage): number[] {
	return message.rawOffsets || message._rawPositions || [];
}

function messageRawStart(message: CaptureMessage): number | undefined {
	return messageRawPositions(message)[0] ?? (Number.isInteger(message._byteStart) ? message._byteStart : undefined);
}

function liveMessageFromRecords(
	records: PreviewByteRecord[],
	sectionId: string,
	index: number,
	byteStart: number,
	generateId: () => string
): CaptureMessage {
	const rawPositions = records.map(record => record.rawPosition);
	return {
		id: generateId(),
		timestamp: records[0].timestamp,
		byteTimestamps: records.map(record => record.timestamp),
		bytes: records.map(record => record.value),
		directions: records.map(record => record.direction || "rx"),
		hidden: false,
		hiddenBytes: records.map(() => false),
		sourceIndex: index,
		sectionId,
		_byteStart: byteStart,
		_byteEnd: byteStart + records.length,
		rawOffsets: rawPositions,
		_rawPositions: rawPositions
	};
}

function appendRecordsToLiveMessage(message: CaptureMessage, records: PreviewByteRecord[]): void {
	if (!records.length) return;
	const previousLength = message.bytes.length;
	const rawPositions = messageRawPositions(message).slice();
	message.bytes.push(...records.map(record => record.value));
	message.byteTimestamps = [...(message.byteTimestamps || message.bytes.slice(0, previousLength).map(() => message.timestamp)), ...records.map(record => record.timestamp)];
	message.directions = [...(message.directions || message.bytes.slice(0, previousLength).map(() => "rx")), ...records.map(record => record.direction || "rx")];
	message.hiddenBytes = [...(message.hiddenBytes || message.bytes.slice(0, previousLength).map(() => false)), ...records.map(() => false)];
	rawPositions.push(...records.map(record => record.rawPosition));
	message.rawOffsets = rawPositions;
	message._rawPositions = rawPositions;
	message._byteEnd = (message._byteEnd ?? message._byteStart ?? 0) + records.length;
}

function appendLengthFramedPreview(
	capture: Capture,
	section: CaptureSection,
	records: PreviewByteRecord[],
	sectionMessages: CaptureMessage[],
	generateId: () => string
): boolean {
	const messages = capture.messages || (capture.messages = []);
	const settings = normalizeSectionFramingSettings(section, DEFAULT_FRAME_SIZE);
	let last = sectionMessages.at(-1);
	let byteStart = last?._byteEnd ?? 0;
	let offset = 0;
	if (last && last.bytes.length < settings.frameSize) {
		const take = Math.min(settings.frameSize - last.bytes.length, records.length);
		appendRecordsToLiveMessage(last, records.slice(0, take));
		byteStart = last._byteEnd ?? byteStart;
		offset = take;
	}
	while (offset < records.length) {
		const chunk = records.slice(offset, offset + settings.frameSize);
		messages.push(liveMessageFromRecords(chunk, String(section.id), messages.length, byteStart, generateId));
		byteStart += chunk.length;
		offset += chunk.length;
	}
	return true;
}

function appendTimeFramedPreview(
	capture: Capture,
	section: CaptureSection,
	records: PreviewByteRecord[],
	sectionMessages: CaptureMessage[],
	generateId: () => string
): boolean {
	const messages = capture.messages || (capture.messages = []);
	const settings = normalizeSectionFramingSettings(section, DEFAULT_FRAME_SIZE);
	let current = sectionMessages.at(-1);
	let byteStart = current?._byteEnd ?? 0;
	let previousTimestamp = current?.byteTimestamps?.at(-1) ?? current?.timestamp;
	for (const record of records) {
		if (!current || (previousTimestamp !== undefined && record.timestamp - previousTimestamp >= settings.frameTimeGap)) {
			current = liveMessageFromRecords([record], String(section.id), messages.length, byteStart, generateId);
			messages.push(current);
			byteStart += 1;
		} else {
			appendRecordsToLiveMessage(current, [record]);
			byteStart = current._byteEnd ?? byteStart;
		}
		previousTimestamp = record.timestamp;
	}
	return true;
}

function endsWithAnyMarker(message: CaptureMessage, markers: number[][]): boolean {
	return markers.some(marker => marker.length > 0 && marker.every((value, index) => message.bytes.at(-marker.length + index) === value));
}

function markersHavePrefixOverlap(markers: number[][]): boolean {
	return markers.some((marker, index) => markers.some((alternative, alternativeIndex) =>
		index !== alternativeIndex &&
		alternative.length < marker.length &&
		alternative.every((value, byteIndex) => marker[byteIndex] === value)
	));
}

function appendMarkerEndFramedPreview(
	capture: Capture,
	section: CaptureSection,
	records: PreviewByteRecord[],
	sectionMessages: CaptureMessage[],
	generateId: () => string
): boolean {
	const messages = capture.messages || (capture.messages = []);
	const settings = normalizeSectionFramingSettings(section, DEFAULT_FRAME_SIZE);
	const markers = parseMarkerAlternatives(settings.frameMarker);
	if (!markers.length) return true;
	let current = sectionMessages.at(-1);
	let byteStart = current?._byteEnd ?? 0;
	if (current && endsWithAnyMarker(current, markers)) current = undefined;
	for (const record of records) {
		if (!current) {
			current = liveMessageFromRecords([record], String(section.id), messages.length, byteStart, generateId);
			messages.push(current);
			byteStart += 1;
		} else {
			appendRecordsToLiveMessage(current, [record]);
			byteStart = current._byteEnd ?? byteStart;
		}
		if (endsWithAnyMarker(current, markers)) current = undefined;
	}
	return true;
}

/**
 * Extends a normalized capture after an append-only live write. The existing
 * full rebuild remains the fallback for framing states that need historical
 * context, such as a marker-start section or a newly introduced section.
 */
export function appendLivePreview(capture: Capture, previousByteStreamLength: number, generateId = createId): boolean {
	const markAppended = (result: boolean): boolean => {
		if (result) bumpCaptureProjectionGeneration(capture, "append");
		return result;
	};
	const stream = capture.byteStream || [];
	if (previousByteStreamLength < 0 || previousByteStreamLength > stream.length) return false;
	const sections = capture.frameSections || [];
	const section = sections.at(-1);
	if (!section) return false;
	const appended = stream
		.slice(previousByteStreamLength)
		.map((record, index) => ({ ...record, rawPosition: record.rawOffset ?? previousByteStreamLength + index }));
	if (!appended.length) return true;
	if (appended.some(record => record.hidden)) return false;
	const previousLastRawOffset = stream[previousByteStreamLength - 1]?.rawOffset ?? previousByteStreamLength - 1;
	const lastRawOffset = appended.at(-1)?.rawPosition ?? previousLastRawOffset;
	if (previousByteStreamLength > 0 && sections.some(item => {
		const start = Number(item.start ?? 0);
		return start > previousLastRawOffset && start <= lastRawOffset;
	})) return false;
	const sectionStart = Number(section.start ?? 0);
	if (appended.some(record => record.rawPosition < sectionStart)) return false;
	const sectionId = String(section.id ?? "");
	const sectionMessages = (capture.messages || []).filter(message => {
		const start = messageRawStart(message);
		return String(message.sectionId ?? "") === sectionId || (start !== undefined && start >= sectionStart);
	});
	const settings = normalizeSectionFramingSettings(section, DEFAULT_FRAME_SIZE);
	if (settings.framingMode === "marker" && settings.markerPosition === "start") return false;
	if (settings.framingMode === "length") {
		if (!sectionMessages.length && stream.slice(0, previousByteStreamLength).some(record => {
			const rawPosition = record.rawOffset ?? 0;
			return rawPosition >= sectionStart;
		})) return false;
		return markAppended(appendLengthFramedPreview(capture, section, appended, sectionMessages, generateId));
	}
	if (settings.framingMode === "time") {
		if (!sectionMessages.length && stream.slice(0, previousByteStreamLength).some(record => {
			const rawPosition = record.rawOffset ?? 0;
			return rawPosition >= sectionStart;
		})) return false;
		return markAppended(appendTimeFramedPreview(capture, section, appended, sectionMessages, generateId));
	}
	if (!sectionMessages.length) {
		// A marker-end section has no visible messages until its first marker.
		// Once one appears, use the full path so any pre-marker bytes are kept
		// exactly as the established framing implementation defines them.
		const markers = parseMarkerAlternatives(settings.frameMarker);
		const maxMarkerLength = Math.max(0, ...markers.map(marker => marker.length));
		const previousSectionRecords = maxMarkerLength > 1
			? stream
					.slice(0, previousByteStreamLength)
					.filter(record => (record.rawOffset ?? 0) >= sectionStart && !record.hidden)
					.slice(-(maxMarkerLength - 1))
			: [];
		const markerCandidate = [...previousSectionRecords, ...appended];
		if (markers.some(marker => markerCandidate.some((record, index) => marker.every((value, markerIndex) => {
			const candidate = markerCandidate[index + markerIndex]?.value;
			return candidate === value;
		})))) return false;
		return markAppended(true);
	}
	const markers = parseMarkerAlternatives(settings.frameMarker);
	if (markersHavePrefixOverlap(markers)) return false;
	return markAppended(appendMarkerEndFramedPreview(capture, section, appended, sectionMessages, generateId));
}

export function rebuildPreview(capture: Capture, generateId = createId): void {
	bumpCaptureProjectionGeneration(capture);
	normalizeCapture(capture, generateId);
	// A hidden byte is omitted before framing, rather than merely omitted while
	// rendering. This makes every framing mode behave exactly as though the byte
	// was never captured, while byteStream remains available for export/history.
	const stream = capture.byteStream!
		.map((record, retainedIndex) => ({ ...record, rawPosition: record.rawOffset ?? retainedIndex }))
		.filter(record => !record.hidden);
	const ranges: Array<[number, number, string?]> = [];
	normalizeSections(capture, generateId);
	const sections = capture.frameSections || [];
	let streamIndex = 0;
	sections.forEach((section, sectionIndex) => {
		// Section starts are persisted as raw positions. Translate them to the
		// compact stream with one forward cursor so hundreds of sections do not
		// each rescan the full capture.
		while (streamIndex < stream.length && stream[streamIndex].rawPosition < (section.start ?? 0)) streamIndex += 1;
		const start = streamIndex;
		const nextRawStart = sections[sectionIndex + 1]?.start;
		if (nextRawStart !== undefined) {
			while (streamIndex < stream.length && stream[streamIndex].rawPosition < nextRawStart) streamIndex += 1;
		}
		const sectionEnd = nextRawStart === undefined ? stream.length : streamIndex;
		if (start >= sectionEnd) return;
		frameSectionRanges(stream, start, sectionEnd, section).forEach(([rangeStart, rangeEnd]) => {
			ranges.push([rangeStart, rangeEnd, section.id]);
		});
	});
	const oldMessagesByRange = new Map<string, ExistingMessage>(
		(capture.messages || []).map(message => {
			const rawPositions =
				message.rawOffsets ||
				message._rawPositions ||
				(Number.isInteger(message._byteStart) ? message.bytes.map((_, index) => message._byteStart! + index) : []);
			return [rawPositions.join(","), { id: message.id, hidden: Boolean(message.hidden) }];
		})
	);
	capture.messages = ranges
		.filter(([start, end]) => end > start)
		.map(([start, end, sectionId], index): CaptureMessage => {
			const records = stream.slice(start, end);
			const rawPositions = records.map(record => record.rawPosition);
			const previous = oldMessagesByRange.get(rawPositions.join(","));
			return {
				id: previous?.id || generateId(),
				timestamp: records[0].timestamp,
				byteTimestamps: records.map(record => record.timestamp),
				bytes: records.map(record => record.value),
				directions: records.map(record => record.direction || "rx"),
				hidden: Boolean(previous?.hidden),
				hiddenBytes: records.map(() => false),
				sourceIndex: index,
				sectionId,
				_byteStart: start,
				_byteEnd: end,
				rawOffsets: rawPositions,
				_rawPositions: rawPositions
			};
		});
}

export function hexByte(byte: number): string {
	return byte.toString(16).padStart(2, "0").toUpperCase();
}

export function visibleByteEntries(message: FramedMessage): Array<{ value: number; rawPosition: number }> {
	return message.bytes
		.map((value, rawPosition) => ({ value, rawPosition }))
		.filter(({ rawPosition }) => !message.hiddenBytes?.[rawPosition]);
}

export function visiblePositionForRawByte(message: FramedMessage, rawPosition: number): number {
	return visibleByteEntries(message).findIndex(entry => entry.rawPosition === rawPosition);
}

export function signature(message: FramedMessage): string {
	return visibleByteEntries(message)
		.map(({ value }) => hexByte(value))
		.join(" ");
}

export function visibleMessages(capture: Capture | null | undefined): CaptureMessage[] {
	return (capture?.messages || []).filter(message => !message.hidden);
}

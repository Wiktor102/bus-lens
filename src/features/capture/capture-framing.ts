import {
	interpretSectionRanges,
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
	return markerBytes(value)
		.map(hexByte)
		.join(" ");
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
	// byte records. Copy it across before the preview is rebuilt.
	capture.messages.forEach(message => {
		if (!Number.isInteger(message._byteStart) && !Array.isArray(message.rawOffsets) && !Array.isArray(message._rawPositions)) return;
		message.hiddenBytes?.forEach((hidden, index) => {
			const rawPosition = message.rawOffsets?.[index] ?? message._rawPositions?.[index] ?? (message._byteStart as number) + index;
			const rawByte = capture.byteStream?.find(record => record.rawOffset === rawPosition);
				if (hidden && rawByte) rawByte.hidden = true;
		});
	});
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

export function rebuildPreview(capture: Capture, generateId = createId): void {
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
	sections.forEach((section, sectionIndex) => {
		// Section starts are persisted as raw positions. Translate them to the
		// compact stream so deleting bytes before a section shifts it naturally.
		const start = stream.findIndex(record => record.rawPosition >= (section.start ?? 0));
		const nextRawStart = sections[sectionIndex + 1]?.start;
		const nextStart = nextRawStart === undefined ? -1 : stream.findIndex(record => record.rawPosition >= nextRawStart);
		const sectionEnd = nextStart < 0 ? stream.length : nextStart;
		if (start < 0 || start >= sectionEnd) return;
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

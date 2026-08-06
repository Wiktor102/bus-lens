import {
	normalizeCaptureSummaryData,
	type CaptureSummaryData,
	type FramedMessage,
	type RawByteRecord
} from "./capture-summary.ts";

export type CaptureNote = {
	id?: string;
	type?: string;
	text?: string;
	createdAt?: number;
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
	_rawPositions?: number[];
};

export type CaptureSection = {
	id?: string;
	start?: number;
	frameSize?: number;
	collapseRuns?: boolean;
	collapsed?: boolean;
};

const DEFAULT_FRAME_SIZE = 3;
const MAX_FRAME_SIZE = 1024;

export type Capture = Omit<CaptureSummaryData, "notes"> & {
	id?: string;
	name?: string;
	view?: string;
	createdAt?: string;
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
};

type PreviewByteRecord = RawByteRecord & { rawPosition: number };
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

export function normalizeCapture(capture: Capture, generateId = createId): Capture {
	const legacyPreviewMode = String(capture.previewMode || "length");
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
		capture.byteStream = capture.messages.flatMap(message =>
			message.bytes.map((value, index) => ({
				value,
				timestamp: message.byteTimestamps?.[index] ?? message.timestamp,
				hidden: Boolean(message.hiddenBytes?.[index])
			}))
		);
	}
	capture.byteStream.forEach(record => {
		record.direction ||= "rx";
		record.hidden = Boolean(record.hidden);
	});
	// Older exports stored byte visibility on framed messages rather than raw
	// byte records. Copy it across before the preview is rebuilt.
	capture.messages.forEach(message => {
		if (!Number.isInteger(message._byteStart) && !Array.isArray(message._rawPositions)) return;
		message.hiddenBytes?.forEach((hidden, index) => {
			const rawPosition = message._rawPositions?.[index] ?? (message._byteStart as number) + index;
			if (hidden && capture.byteStream?.[rawPosition]) capture.byteStream[rawPosition].hidden = true;
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
	legacyPreviewMode: string,
	generateId: () => string
): CaptureSection[] {
	if (legacyPreviewMode !== "marker" && legacyPreviewMode !== "time") return [];

	// Marker and time framing could produce variable-length messages. Preserve
	// those existing boundaries by making each legacy message its own section.
	let fallbackStart = 0;
	const sections: CaptureSection[] = [];
	for (const message of capture.messages || []) {
		if (!message.bytes.length) continue;
		const rawPositions =
			message._rawPositions && message._rawPositions.length === message.bytes.length
				? message._rawPositions
				: Number.isInteger(message._byteStart)
					? message.bytes.map((_, index) => message._byteStart! + index)
					: message.bytes.map((_, index) => fallbackStart + index);
		const start = rawPositions[0];
		if (!Number.isInteger(start)) continue;
		sections.push({
			id: message.sectionId || generateId(),
			start,
			frameSize: Math.max(1, Math.min(MAX_FRAME_SIZE, message.bytes.length)),
			collapseRuns: false,
			collapsed: false
		});
		fallbackStart = Math.max(fallbackStart, rawPositions[rawPositions.length - 1] + 1);
	}
	return sections;
}

export function normalizeSections(capture: Capture, generateId = createId): void {
	const streamLength = capture.byteStream?.length || 0;
	const byStart = new Map<number, CaptureSection>();
	(Array.isArray(capture.frameSections) ? capture.frameSections : [])
		.filter(section => Boolean(section && typeof section === "object"))
		.forEach(section => {
			const start = Math.max(0, Math.min(Math.max(0, streamLength - 1), Math.floor(+section.start! || 0)));
			byStart.set(start, {
				id: section.id || generateId(),
				start,
				frameSize: Math.max(1, Math.min(MAX_FRAME_SIZE, Math.floor(+section.frameSize! || capture.frameSize || DEFAULT_FRAME_SIZE))),
				collapseRuns: Boolean(section.collapseRuns),
				collapsed: Boolean(section.collapsed)
			});
		});
	if (!byStart.has(0)) {
		byStart.set(0, {
			id: generateId(),
			start: 0,
			frameSize: capture.frameSize || DEFAULT_FRAME_SIZE,
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
	return (String(value).match(/[0-9a-f]{2}/gi) || []).map(byte => parseInt(byte, 16));
}

export function markerAt(stream: PreviewByteRecord[], index: number, marker: number[]): boolean {
	return marker.length > 0 && marker.every((value, offset) => stream[index + offset]?.value === value);
}

export function rebuildPreview(capture: Capture, generateId = createId): void {
	normalizeCapture(capture, generateId);
	// A hidden byte is omitted before framing, rather than merely omitted while
	// rendering. This makes every framing mode behave exactly as though the byte
	// was never captured, while byteStream remains available for export/history.
	const stream = capture.byteStream!
		.map((record, rawPosition) => ({ ...record, rawPosition }))
		.filter(record => !record.hidden);
	const ranges: Array<[number, number, string?]> = [];
	normalizeSections(capture, generateId);
	const sections = capture.frameSections as Array<Required<CaptureSection>>;
	sections.forEach((section, sectionIndex) => {
		// Section starts are persisted as raw positions. Translate them to the
		// compact stream so deleting bytes before a section shifts it naturally.
		const start = stream.findIndex(record => record.rawPosition >= section.start);
		const nextRawStart = sections[sectionIndex + 1]?.start;
		const nextStart = nextRawStart === undefined ? -1 : stream.findIndex(record => record.rawPosition >= nextRawStart);
		const sectionEnd = nextStart < 0 ? stream.length : nextStart;
		if (start < 0) return;
		for (let offset = start; offset < sectionEnd; offset += section.frameSize) {
			ranges.push([offset, Math.min(offset + section.frameSize, sectionEnd), section.id]);
		}
	});
	const oldMessagesByRange = new Map<string, ExistingMessage>(
		(capture.messages || []).map(message => {
			const rawPositions =
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

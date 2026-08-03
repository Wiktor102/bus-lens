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
};

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
	capture.previewMode ||= "length";
	capture.frameSize = Math.max(1, +capture.frameSize! || 3);
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
	normalizeCaptureSummaryData(capture, generateId);
	normalizeSections(capture, generateId);
	capture.messages.forEach(message => {
		message.byteTimestamps ||= message.bytes.map(() => message.timestamp);
	});
	return capture;
}

export function normalizeSections(capture: Capture, generateId = createId): void {
	const streamLength = capture.byteStream?.length || 0;
	const byStart = new Map<number, CaptureSection>();
	(Array.isArray(capture.frameSections) ? capture.frameSections : []).forEach(section => {
		const start = Math.max(0, Math.min(Math.max(0, streamLength - 1), Math.floor(+section.start! || 0)));
		byStart.set(start, {
			id: section.id || generateId(),
			start,
			frameSize: Math.max(1, Math.min(1024, Math.floor(+section.frameSize! || capture.frameSize || 3))),
			collapseRuns: Boolean(section.collapseRuns)
		});
	});
	if (!byStart.has(0)) {
		byStart.set(0, {
			id: generateId(),
			start: 0,
			frameSize: capture.frameSize,
			collapseRuns: false
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
	if (capture.previewMode === "marker") {
		const marker = markerBytes(capture.frameMarker);
		if (capture.markerPosition === "end") {
			let start = 0;
			let foundMarker = false;
			for (let index = 0; index < stream.length; index++) {
				if (markerAt(stream, index, marker)) {
					foundMarker = true;
					const end = index + marker.length;
					ranges.push([start, end]);
					start = end;
					index = end - 1;
				}
			}
			if (foundMarker && start < stream.length) ranges.push([start, stream.length]);
		} else {
			let start = -1;
			for (let index = 0; index < stream.length; index++) {
				if (!markerAt(stream, index, marker)) continue;
				if (start >= 0 && index > start) ranges.push([start, index]);
				start = index;
				index += marker.length - 1;
			}
			if (start >= 0 && start < stream.length) ranges.push([start, stream.length]);
		}
	} else if (capture.previewMode === "time") {
		if (stream.length) {
			let start = 0;
			for (let index = 1; index < stream.length; index++) {
				if (stream[index].timestamp - stream[index - 1].timestamp >= capture.frameTimeGap!) {
					ranges.push([start, index]);
					start = index;
				}
			}
			ranges.push([start, stream.length]);
		}
	} else if (capture.previewMode === "sections") {
		normalizeSections(capture);
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
	} else {
		for (let start = 0; start < stream.length; start += capture.frameSize!) {
			ranges.push([start, Math.min(start + capture.frameSize!, stream.length)]);
		}
	}
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

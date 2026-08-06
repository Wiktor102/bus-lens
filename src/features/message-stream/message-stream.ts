import {
	frameWidth,
	hexByte,
	signature,
	visibleByteEntries,
	visibleMessages,
	type Capture,
	type CaptureMessage,
	type CaptureSection
} from "../capture/capture-framing.ts";
import {
	colorForByte,
	getCounts,
	recognizeMessagePatterns,
	rowsWithDelta,
	summarizeRunCadence,
	transitionFrames,
	type MessagePatterns,
	type PatternGroup,
	type PatternMembership,
	type TransitionFrame
} from "../analysis/analysis.ts";
import { collapseAdjacentRuns, countVisibleRowsByPatternOccurrence } from "../analysis/collapse-runs.ts";
import type { DisplayMode, ViewStateSnapshot } from "../../shared/view-state.ts";

export const VIRTUAL_ROW_HEIGHT = 41;
export const VIRTUAL_SECTION_HEIGHT = 48;
export const VIRTUAL_OVERSCAN = 8;

export type MessageStreamSequenceNote = {
	text: string;
	start: number;
	end: number;
};

export type MessageStreamAnnotation = {
	text: string;
};

type MessageStreamBaseRow = CaptureMessage & {
	id: string;
	_originalStart: number;
	_originalEnd: number;
	_hasSequenceNote: boolean;
	_patternOccurrence: string | null;
	_runStart: number;
	_runEnd: number;
	_runMessages: CaptureMessage[];
	_repeats: number;
};

export type MessageStreamRow = MessageStreamBaseRow & {
	_cadence: number | null;
	_cadenceStable: boolean;
	_intervals: number[];
	_delta: number | null;
};

export type MessageStreamSection = {
	id: string;
	start: number;
	frameSize: number;
	collapseRuns: boolean;
};

export type MessageStreamPatterns = {
	groups: PatternGroup[];
	membership: Map<number, PatternMembership>;
};

export type MessageStreamEntry =
	| {
		type: "section";
		key: string;
		section: MessageStreamSection;
		sectionNumber: number | undefined;
	}
	| {
		type: "message";
		key: string;
		row: MessageStreamRow;
		rowIndex: number;
	};

export type MessageStreamSnapshot = {
	captureId: string | null;
	filterQuery: string;
	mode: DisplayMode;
	highlight: boolean;
	matchingRows: MessageStreamRow[];
	entries: MessageStreamEntry[];
	frames: TransitionFrame[][];
	signatureCounts: Map<string, number>;
	countsByPosition: Map<number, number>[];
	patterns: MessageStreamPatterns;
	patternNumbers: Map<string, number>;
	visiblePatternRowCounts: Map<string, number>;
	sequenceNotes: MessageStreamSequenceNote[];
	annotations: Record<string, MessageStreamAnnotation>;
	visibleCount: string;
	patternCount: string;
	hasVisibleMessages: boolean;
	hasMatchingRows: boolean;
	emptyState: {
		title: string;
		description: string;
	};
};

function emptyMessageStreamSnapshot(): MessageStreamSnapshot {
	return {
		captureId: null,
		filterQuery: "",
		mode: "hex",
		highlight: true,
		matchingRows: [],
		entries: [],
		frames: [],
		signatureCounts: new Map(),
		countsByPosition: [],
		patterns: { groups: [], membership: new Map() },
		patternNumbers: new Map(),
		visiblePatternRowCounts: new Map(),
		sequenceNotes: [],
		annotations: {},
		visibleCount: "0 rows",
		patternCount: "0 groups",
		hasVisibleMessages: false,
		hasMatchingRows: false,
		emptyState: {
			title: "No captures in the archive",
			description: "Create a capture or import a monitor dump to begin."
		}
	};
}

export const EMPTY_MESSAGE_STREAM_SNAPSHOT = emptyMessageStreamSnapshot();

export function formatTime(ms: number): string {
	return new Date(ms).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		fractionalSecondDigits: 3
	});
}

export function formatDelta(ms: number | null): string {
	if (ms === null) return "—";
	if (ms >= 60000) return `${(ms / 60000).toFixed(1)} min`;
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
	return `${ms.toFixed(1)} ms`;
}

function copyMessage(message: CaptureMessage): CaptureMessage & { id: string } {
	return {
		...message,
		id: String(message.id ?? ""),
		bytes: [...message.bytes],
		byteTimestamps: message.byteTimestamps ? [...message.byteTimestamps] : undefined,
		hiddenBytes: message.hiddenBytes ? [...message.hiddenBytes] : undefined,
		directions: message.directions ? [...message.directions] : undefined,
		_rawPositions: message._rawPositions ? [...message._rawPositions] : undefined
	};
}

function copySection(section: CaptureSection, index: number): MessageStreamSection {
	return {
		id: String(section.id ?? `section-${index}`),
		start: Number(section.start || 0),
		frameSize: Number(section.frameSize || 1),
		collapseRuns: Boolean(section.collapseRuns)
	};
}

function copySections(capture: Capture): MessageStreamSection[] {
	const sourceSections = capture.frameSections?.length
		? capture.frameSections
		: [{ id: "section-0", start: 0, frameSize: capture.frameSize || 3, collapseRuns: false }];
	return sourceSections.map(copySection);
}

function sectionIdForMessage(message: CaptureMessage, sections: MessageStreamSection[]): string | undefined {
	if (message.sectionId && sections.some(section => section.id === message.sectionId)) return String(message.sectionId);
	const rawStart = message._rawPositions?.[0] ?? message._byteStart ?? 0;
	return sections.reduce<MessageStreamSection | undefined>(
		(current, section) => (section.start <= rawStart ? section : current),
		undefined
	)?.id;
}

function copyPatternGroup(group: PatternGroup): PatternGroup {
	return {
		...group,
		starts: [...group.starts],
		signatures: [...group.signatures]
	};
}

function copyPatterns(patterns: MessagePatterns): MessageStreamPatterns {
	const groups = patterns.groups.map(copyPatternGroup);
	const groupsById = new Map(groups.map(group => [group.id, group]));
	const membership = new Map<number, PatternMembership>();
	patterns.membership.forEach((member, originalIndex) => {
		const group = groupsById.get(member.group.id);
		if (group) membership.set(originalIndex, { ...member, group });
	});
	return { groups, membership };
}

function copyRow(row: MessageStreamRow): MessageStreamRow {
	return {
		...copyMessage(row),
		_originalStart: row._originalStart,
		_originalEnd: row._originalEnd,
		_hasSequenceNote: row._hasSequenceNote,
		_patternOccurrence: row._patternOccurrence,
		_runStart: row._runStart,
		_runEnd: row._runEnd,
		_runMessages: row._runMessages.map(copyMessage),
		_repeats: row._repeats,
		_cadence: row._cadence,
		_cadenceStable: row._cadenceStable,
		_intervals: [...row._intervals],
		_delta: row._delta
	};
}

function copyAnnotations(capture: Capture): Record<string, MessageStreamAnnotation> {
	const annotations: Record<string, MessageStreamAnnotation> = {};
	Object.entries(capture.annotations || {}).forEach(([key, value]) => {
		const annotation = value && typeof value === "object" ? (value as { text?: unknown }) : {};
		annotations[key] = { text: String(annotation.text || "") };
	});
	return annotations;
}

function copySequenceNotes(capture: Capture): MessageStreamSequenceNote[] {
	return (capture.notes || [])
		.filter(note => note.type === "sequence")
		.map(note => ({
			text: String(note.text || ""),
			start: Number(note.start || 0),
			end: Number(note.end || 0)
		}));
}

function filterRows(
	capture: Capture,
	viewState: ViewStateSnapshot,
	patterns: MessagePatterns,
	sections: MessageStreamSection[]
) {
	const sequenceNoteRows = new Set<number>();
	const maxMessageIndex = (capture.messages?.length || 0) - 1;
	for (const note of capture.notes || []) {
		if (note.type !== "sequence") continue;
		const start = Math.max(0, Math.trunc(Number(note.start)) - 1);
		const end = Math.min(maxMessageIndex, Math.trunc(Number(note.end)) - 1);
		if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
		for (let index = start; index <= end; index++) sequenceNoteRows.add(index);
	}

	let rows = (capture.messages || [])
		.map((sourceMessage, originalIndex): MessageStreamBaseRow => {
			const message = copyMessage(sourceMessage);
			message.sectionId ||= sectionIdForMessage(message, sections);
			const patternMember = patterns.membership.get(originalIndex);
			return {
				...message,
				_originalStart: originalIndex,
				_originalEnd: originalIndex,
				_hasSequenceNote: sequenceNoteRows.has(originalIndex),
				_patternOccurrence: patternMember ? `${patternMember.group.id}:${patternMember.occurrenceIndex}` : null,
				_runStart: message.timestamp,
				_runEnd: message.timestamp,
				_runMessages: [copyMessage(message)],
				_repeats: 1
			};
		})
		.filter(message => !message.hidden);

	const query = viewState.filterQuery.trim().toUpperCase();
	if (query) {
		const pattern = query
			.split(/\s+/)
			.map(x =>
				x === "??" || x === "**"
					? "[0-9A-F]{2}"
					: x.replace(/[^0-9A-F?]/g, "").replaceAll("?", "[0-9A-F]")
			)
			.join("\\s+");
		try {
			const re = new RegExp(pattern);
			rows = rows.filter(row => re.test(signature(row)));
		} catch {}
	}

	const sectionsById = new Map(sections.map(section => [section.id, section]));
	if (viewState.collapseRuns || capture.previewMode === "sections") {
		rows = collapseAdjacentRuns(
			rows,
			row =>
				capture.previewMode === "sections"
					? Boolean(sectionsById.get(String(row.sectionId ?? ""))?.collapseRuns)
					: viewState.collapseRuns,
			signature
		);
	}

	return rowsWithDelta(rows.map(summarizeRunCadence)).map(copyRow);
}

export function deriveMessageStreamSnapshot(
	capture: Capture | null | undefined,
	viewState: ViewStateSnapshot
): MessageStreamSnapshot {
	if (!capture) return { ...EMPTY_MESSAGE_STREAM_SNAPSHOT, filterQuery: viewState.filterQuery, mode: viewState.displayMode, highlight: viewState.showFrameChanges };

	const sections = copySections(capture);
	const rawPatterns = recognizeMessagePatterns(capture);
	const patterns = copyPatterns(rawPatterns);
	const matchingRows = filterRows(capture, viewState, rawPatterns, sections);
	const visible = visibleMessages(capture);
	const signatureCounts = getCounts(visible);
	const countsByPosition = Array.from({ length: frameWidth(capture) }, (_, position) => {
		const counts = new Map<number, number>();
		visible.forEach(message => {
			const byte = visibleByteEntries(message)[position]?.value;
			if (byte !== undefined) counts.set(byte, (counts.get(byte) || 0) + 1);
		});
		return counts;
	});
	const highlight = viewState.showFrameChanges;
	const frames = highlight
		? transitionFrames(matchingRows)
		: matchingRows.map(row => visibleByteEntries(row).map(() => ({ incoming: null, outgoing: null })));
	const patternNumbers = new Map(patterns.groups.map((group, index) => [group.id, index + 1]));
	const visiblePatternRowCounts = countVisibleRowsByPatternOccurrence(matchingRows);
	const sectionsById = new Map(sections.map(section => [section.id, section]));
	const sectionNumbers = new Map(sections.map((section, index) => [section.id, index + 1]));
	const entries: MessageStreamEntry[] = [];
	let previousSectionId: string | undefined;
	matchingRows.forEach((row, rowIndex) => {
		const rowSectionId = row.sectionId === undefined ? undefined : String(row.sectionId);
		if (rowSectionId !== previousSectionId) {
			const section = rowSectionId ? sectionsById.get(rowSectionId) : undefined;
			if (section) {
				entries.push({
					type: "section",
					key: `section:${section.id}:${row._originalStart}`,
					section,
					sectionNumber: sectionNumbers.get(section.id)
				});
			}
		}
		entries.push({ type: "message", key: `message:${row.id}`, row, rowIndex });
		previousSectionId = rowSectionId;
	});

	const telegramCount = matchingRows.reduce((sum, row) => sum + row._repeats, 0);
	const visibleSummary = matchingRows.length
		? `${matchingRows.length.toLocaleString()} row${matchingRows.length === 1 ? "" : "s"}`
		: "0 rows";
	const hasVisibleMessages = visible.length > 0;
	const hasMatchingRows = matchingRows.length > 0;

	return {
		captureId: String(capture.id ?? ""),
		filterQuery: viewState.filterQuery,
		mode: viewState.displayMode,
		highlight,
		matchingRows,
		entries,
		frames,
		signatureCounts,
		countsByPosition,
		patterns,
		patternNumbers,
		visiblePatternRowCounts,
		sequenceNotes: copySequenceNotes(capture),
		annotations: copyAnnotations(capture),
		visibleCount:
			telegramCount === matchingRows.length
				? visibleSummary
				: `${visibleSummary} · ${telegramCount.toLocaleString()} telegrams`,
		patternCount: `${patterns.groups.length} group${patterns.groups.length === 1 ? "" : "s"}`,
		hasVisibleMessages,
		hasMatchingRows,
		emptyState: {
			title: hasVisibleMessages
				? "No messages match this filter"
				: capture.messages?.length
					? "No visible messages in this capture"
					: "No messages in this capture",
			description: hasVisibleMessages
				? "Try a different byte pattern."
				: capture.messages?.length
					? "Hidden messages and bytes remain in the capture and JSON export."
					: "Connect a serial port and start capture, or import a monitor dump."
		}
	};
}

export function renderRepeatPillData(message: MessageStreamRow): {
	title: string;
	steady: boolean;
	range: string;
	cadence: string;
} {
	const min = Math.min(...message._intervals);
	const max = Math.max(...message._intervals);
	const range = message._intervals.length
		? `${formatDelta(min)}${min === max ? "" : `–${formatDelta(max)}`}`
		: "—";
	return {
		title: `${message._repeats} consecutive identical telegrams · interval ${range}`,
		steady: message._cadenceStable,
		range,
		cadence:
			message._cadenceStable && message._cadence !== null
				? `≈ ${formatDelta(Math.round(message._cadence))}`
				: "varied"
	};
}

export { colorForByte, hexByte, signature, visibleByteEntries };

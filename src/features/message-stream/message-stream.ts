import {
	frameWidth,
	hexByte,
	normalizeSectionFramingSettings,
	signature,
	visibleByteEntries,
	visibleMessages,
	captureProjectionGeneration,
	captureProjectionMutation,
	type Capture,
	type CaptureMessage,
	type CaptureSection,
	type MarkerPosition,
	type SectionFramingMode
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
import {
	getSectionMoveAvailabilityFromMetadata,
	precomputeSectionMoveMetadata,
	type SectionMoveMetadata,
	type SectionMoveAvailability
} from "../capture/section-repositioning.ts";
import { getSectionViewPreference, type DisplayMode, type ViewStateSnapshot } from "../../shared/view-state.ts";

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
	framingMode: SectionFramingMode;
	frameSize: number;
	frameMarker: string;
	markerPosition: MarkerPosition;
	frameTimeGap: number;
	collapseRuns: boolean;
	collapsed: boolean;
	moveAvailability: SectionMoveAvailability;
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
		type: "marker-prompt";
		key: string;
		section: MessageStreamSection;
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
	retainedTail: boolean;
	durableByteCount: number;
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
		retainedTail: false,
		durableByteCount: 0,
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
	const rawOffsets = message.rawOffsets ? [...message.rawOffsets] : undefined;
	const rawPositions = message._rawPositions
		? message._rawPositions === message.rawOffsets
			? rawOffsets
			: [...message._rawPositions]
		: undefined;
	return {
		...message,
		id: String(message.id ?? ""),
		bytes: [...message.bytes],
		byteTimestamps: message.byteTimestamps ? [...message.byteTimestamps] : undefined,
		hiddenBytes: message.hiddenBytes ? [...message.hiddenBytes] : undefined,
		directions: message.directions ? [...message.directions] : undefined,
		rawOffsets,
		_rawPositions: rawPositions
	};
}

function copySection(
	section: CaptureSection,
	index: number,
	capture: Capture,
	viewState: ViewStateSnapshot,
	movement: SectionMoveMetadata
): MessageStreamSection {
	const id = String(section.id ?? `section-${index}`);
	const settings = normalizeSectionFramingSettings(section);
	const rawStart = Number(section.start || 0);
	const preference = getSectionViewPreference(viewState, String(capture.id ?? ""), rawStart);
	return {
		id,
		start: rawStart,
		...settings,
		collapseRuns: preference?.collapseRuns ?? Boolean(section.collapseRuns),
		collapsed: preference?.collapsed ?? Boolean(section.collapsed),
		moveAvailability: getSectionMoveAvailabilityFromMetadata(movement, id)
	};
}

function sourceSections(capture: Capture): CaptureSection[] {
	return capture.frameSections?.length
		? capture.frameSections
		: [{ id: "section-0", start: 0, frameSize: capture.frameSize || 3, collapseRuns: false, collapsed: false }];
}

function copySections(capture: Capture, viewState: ViewStateSnapshot): MessageStreamSection[] {
	const movement = precomputeSectionMoveMetadata(capture);
	return sourceSections(capture).map((section, index) => copySection(section, index, capture, viewState, movement));
}

function assembleSectionPresentation(
	capture: Capture,
	viewState: ViewStateSnapshot,
	sections: MessageStreamSection[]
): MessageStreamSection[] {
	const sourceById = new Map(sourceSections(capture).map((section, index) => [String(section.id ?? `section-${index}`), section]));
	return sections.map(section => {
		const source = sourceById.get(section.id);
		const preference = getSectionViewPreference(viewState, String(capture.id ?? ""), section.start);
		const collapsed = preference?.collapsed ?? Boolean(source?.collapsed);
		return section.collapsed === collapsed ? section : { ...section, collapsed };
	});
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
	sections: MessageStreamSection[],
	startIndex = 0
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
		.slice(startIndex)
		.map((sourceMessage, offset): MessageStreamBaseRow => {
			const originalIndex = startIndex + offset;
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
				_runMessages: [message],
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

	return rowsWithDelta(rows.map(summarizeRunCadence));
}

function buildEntries(
	capture: Capture,
	viewState: ViewStateSnapshot,
	sections: MessageStreamSection[],
	matchingRows: MessageStreamRow[]
): MessageStreamEntry[] {
	const sectionsById = new Map(sections.map(section => [section.id, section]));
	const sectionNumbers = new Map(sections.map((section, index) => [section.id, index + 1]));
	const entries: MessageStreamEntry[] = [];
	const rowsBySection = new Map<string, Array<{ row: MessageStreamRow; rowIndex: number }>>();
	const unsectionedRows: Array<{ row: MessageStreamRow; rowIndex: number }> = [];
	matchingRows.forEach((row, rowIndex) => {
		const sectionId = row.sectionId === undefined ? undefined : String(row.sectionId);
		if (!sectionId || !sectionsById.has(sectionId)) unsectionedRows.push({ row, rowIndex });
		else {
			const sectionRows = rowsBySection.get(sectionId);
			if (sectionRows) sectionRows.push({ row, rowIndex });
			else rowsBySection.set(sectionId, [{ row, rowIndex }]);
		}
	});
	sections.forEach(section => {
		const sectionRows = rowsBySection.get(section.id) || [];
		if (sectionRows.length) {
			entries.push({
				type: "section",
				key: `section:${section.id}:${sectionRows[0].row._originalStart}`,
				section,
				sectionNumber: sectionNumbers.get(section.id)
			});
			if (!section.collapsed) {
				sectionRows.forEach(({ row, rowIndex }) =>
					entries.push({ type: "message", key: `message:${row.id}`, row, rowIndex })
				);
			}
		} else if (!viewState.filterQuery.trim() && capture.byteStream?.length) {
			entries.push({
				type: "section",
				key: `section:${section.id}:empty`,
				section,
				sectionNumber: sectionNumbers.get(section.id)
			});
			if (section.framingMode === "marker" && !section.frameMarker) {
				entries.push({ type: "marker-prompt", key: `marker-prompt:${section.id}`, section });
			}
		}
	});
	unsectionedRows.forEach(({ row, rowIndex }) => entries.push({ type: "message", key: `message:${row.id}`, row, rowIndex }));
	return entries;
}

type MessageStreamAnalysisProjection = {
	sections: MessageStreamSection[];
	matchingRows: MessageStreamRow[];
	frames: TransitionFrame[][];
	signatureCounts: Map<string, number>;
	countsByPosition: Map<number, number>[];
	patterns: MessageStreamPatterns;
	patternNumbers: Map<string, number>;
	visiblePatternRowCounts: Map<string, number>;
	visibleMessageCount: number;
	telegramCount: number;
};

type AnalysisProjectionKey = {
	projectionGeneration: number;
	framingKey: string;
	filterQuery: string;
	collapseRuns: boolean;
	sectionCollapseRunsKey: string;
	showFrameChanges: boolean;
	patternRemarksKey: string;
	notesKey: string;
};

type AnalysisProjectionCacheEntry = {
	key: AnalysisProjectionKey;
	projection: MessageStreamAnalysisProjection;
};

const analysisProjectionCache = new WeakMap<object, AnalysisProjectionCacheEntry>();

type LiveMessageSummary = {
	visible: boolean;
	signature: string;
	bytes: number[];
};

type LiveSnapshotCache = {
	snapshot: MessageStreamSnapshot;
	projectionGeneration: number;
	sections: MessageStreamSection[];
	messageCount: number;
	lastSectionMessageCount: number;
	byteStreamLength: number;
	firstRawOffset: number | undefined;
	tailStart: number;
	tailRowIndex: number;
	prefixLastMessageId: string | undefined;
	tailMessages: LiveMessageSummary[];
	visibleMessageCount: number;
	telegramCount: number;
	collapseRuns: boolean;
	framingKey: string;
	sectionViewKey: string;
	patternRemarksKey: string;
	notesKey: string;
	annotationsKey: string;
};

const liveSnapshotCache = new WeakMap<object, LiveSnapshotCache>();

function framingKey(capture: Capture): string {
	return JSON.stringify(
		{
			previewMode: capture.previewMode,
			frameSize: capture.frameSize,
			frameMarker: capture.frameMarker,
			markerPosition: capture.markerPosition,
			frameTimeGap: capture.frameTimeGap,
			sections: sourceSections(capture).map(section => [
				section.id,
				section.start,
				section.framingMode,
				section.frameSize,
				section.frameMarker,
				section.markerPosition,
				section.frameTimeGap
			])
		}
	);
}

function sectionViewKey(capture: Capture, viewState: ViewStateSnapshot): string {
	return JSON.stringify(viewState.sectionPreferences[String(capture.id ?? "")] || {});
}

function sectionCollapseRunsKey(capture: Capture, viewState: ViewStateSnapshot): string {
	return JSON.stringify(
		sourceSections(capture).map((section, index) => {
			const rawStart = Number(section.start || 0);
			const preference = getSectionViewPreference(viewState, String(capture.id ?? ""), rawStart);
			return [
				String(section.id ?? `section-${index}`),
				rawStart,
				preference?.collapseRuns ?? Boolean(section.collapseRuns)
			];
		})
	);
}

function patternRemarksKey(capture: Capture): string {
	return JSON.stringify(capture.patternRemarks || {});
}

function notesKey(capture: Capture): string {
	return JSON.stringify(capture.notes || []);
}

function annotationsKey(capture: Capture): string {
	return JSON.stringify(capture.annotations || {});
}

function analysisProjectionKey(capture: Capture, viewState: ViewStateSnapshot): AnalysisProjectionKey {
	return {
		projectionGeneration: captureProjectionGeneration(capture),
		framingKey: framingKey(capture),
		filterQuery: viewState.filterQuery,
		collapseRuns: viewState.collapseRuns || capture.previewMode === "sections",
		sectionCollapseRunsKey: sectionCollapseRunsKey(capture, viewState),
		showFrameChanges: viewState.showFrameChanges,
		patternRemarksKey: patternRemarksKey(capture),
		notesKey: notesKey(capture)
	};
}

function sameAnalysisProjectionKey(left: AnalysisProjectionKey, right: AnalysisProjectionKey): boolean {
	return (
		left.projectionGeneration === right.projectionGeneration &&
		left.framingKey === right.framingKey &&
		left.filterQuery === right.filterQuery &&
		left.collapseRuns === right.collapseRuns &&
		left.sectionCollapseRunsKey === right.sectionCollapseRunsKey &&
		left.showFrameChanges === right.showFrameChanges &&
		left.patternRemarksKey === right.patternRemarksKey &&
		left.notesKey === right.notesKey
	);
}

function deriveMessageStreamAnalysisProjection(
	capture: Capture,
	viewState: ViewStateSnapshot
): MessageStreamAnalysisProjection {
	const sections = copySections(capture, viewState);
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
	const frames = viewState.showFrameChanges
		? transitionFrames(matchingRows)
		: matchingRows.map(row => visibleByteEntries(row).map(() => ({ incoming: null, outgoing: null })));
	return {
		sections,
		matchingRows,
		frames,
		signatureCounts,
		countsByPosition,
		patterns,
		patternNumbers: new Map(patterns.groups.map((group, index) => [group.id, index + 1])),
		visiblePatternRowCounts: countVisibleRowsByPatternOccurrence(matchingRows),
		visibleMessageCount: visible.length,
		telegramCount: matchingRows.reduce((sum, row) => sum + row._repeats, 0)
	};
}

function getMessageStreamAnalysisProjection(
	capture: Capture,
	viewState: ViewStateSnapshot
): MessageStreamAnalysisProjection {
	const key = analysisProjectionKey(capture, viewState);
	const cached = analysisProjectionCache.get(capture);
	if (cached && sameAnalysisProjectionKey(cached.key, key)) return cached.projection;
	const projection = deriveMessageStreamAnalysisProjection(capture, viewState);
	analysisProjectionCache.set(capture, { key, projection });
	return projection;
}

function liveMessageSummary(message: CaptureMessage): LiveMessageSummary {
	const bytes = visibleByteEntries(message).map(entry => entry.value);
	return { visible: !message.hidden, signature: bytes.map(hexByte).join(" "), bytes };
}

function messageCountInLastSection(capture: Capture, section: MessageStreamSection): number {
	return (capture.messages || []).reduce((count, message) => {
		const rawStart = message._rawPositions?.[0] ?? message._byteStart ?? -1;
		return count + (String(message.sectionId ?? "") === section.id || rawStart >= section.start ? 1 : 0);
	}, 0);
}

function liveSections(capture: Capture, cached: LiveSnapshotCache): MessageStreamSection[] {
	const last = cached.sections.at(-1);
	if (!last) return cached.sections;
	const sectionCount = cached.lastSectionMessageCount + Math.max(0, (capture.messages?.length || 0) - cached.messageCount);
	const streamLength = capture.byteStream?.length || 0;
	const byteAfter = last.start + 1 < streamLength;
	const messageAfter = sectionCount >= 2;
	if (last.moveAvailability["byte-after"] === byteAfter && last.moveAvailability["message-after"] === messageAfter) {
		return cached.sections;
	}
	return [
		...cached.sections.slice(0, -1),
		{
			...last,
			moveAvailability: {
				...last.moveAvailability,
				"byte-after": byteAfter,
				"message-after": messageAfter
			}
		}
	];
}

function liveTailStart(
	capture: Capture,
	snapshot: MessageStreamSnapshot,
	collapseRuns: boolean
): number {
	const messageCount = capture.messages?.length || 0;
	if (!messageCount) return 0;
	if (!collapseRuns) return messageCount - 1;
	const lastRow = snapshot.matchingRows.at(-1);
	return lastRow && lastRow._originalEnd === messageCount - 1
		? Math.max(0, lastRow._originalStart)
		: messageCount - 1;
}

function rememberLiveSnapshot(
	capture: Capture,
	snapshot: MessageStreamSnapshot,
	sections: MessageStreamSection[],
	viewState: ViewStateSnapshot,
	collapseRuns: boolean,
	visibleMessageCount = (capture.messages || []).reduce((count, message) => count + (message.hidden ? 0 : 1), 0),
	telegramCount = snapshot.matchingRows.reduce((sum, row) => sum + row._repeats, 0),
	lastSectionMessageCount = sections.length ? messageCountInLastSection(capture, sections.at(-1)!) : 0,
	tailMessages?: LiveMessageSummary[]
): void {
	const messages = capture.messages || [];
	const tailStart = liveTailStart(capture, snapshot, collapseRuns);
	const tailRowIndex = snapshot.matchingRows.findIndex(row => row._originalEnd >= tailStart);
	liveSnapshotCache.set(capture, {
		snapshot,
		projectionGeneration: captureProjectionGeneration(capture),
		sections,
		messageCount: messages.length,
		lastSectionMessageCount,
		byteStreamLength: capture.byteStream?.length || 0,
		firstRawOffset: capture.byteStream?.[0]?.rawOffset,
		tailStart,
		tailRowIndex: tailRowIndex < 0 ? snapshot.matchingRows.length : tailRowIndex,
		prefixLastMessageId: tailStart > 0 ? String(messages[tailStart - 1]?.id ?? "") : undefined,
		tailMessages: tailMessages ?? messages.slice(tailStart).map(liveMessageSummary),
		visibleMessageCount,
		telegramCount,
		collapseRuns,
		framingKey: framingKey(capture),
		sectionViewKey: sectionViewKey(capture, viewState),
		patternRemarksKey: patternRemarksKey(capture),
		notesKey: notesKey(capture),
		annotationsKey: annotationsKey(capture)
	});
}

function canReuseLiveSnapshot(
	capture: Capture,
	viewState: ViewStateSnapshot,
	cached: LiveSnapshotCache
): boolean {
	const messages = capture.messages || [];
	const stream = capture.byteStream || [];
	const generationDelta = captureProjectionGeneration(capture) - cached.projectionGeneration;
	if (
		cached.snapshot.captureId !== String(capture.id ?? "") ||
		cached.snapshot.filterQuery !== viewState.filterQuery ||
		cached.snapshot.mode !== viewState.displayMode ||
		cached.snapshot.highlight !== viewState.showFrameChanges ||
		cached.collapseRuns !== (viewState.collapseRuns || capture.previewMode === "sections") ||
		cached.framingKey !== framingKey(capture) ||
		cached.sectionViewKey !== sectionViewKey(capture, viewState) ||
		cached.patternRemarksKey !== patternRemarksKey(capture) ||
		cached.notesKey !== notesKey(capture) ||
		cached.annotationsKey !== annotationsKey(capture) ||
		(generationDelta !== 0 &&
			(captureProjectionMutation(capture) !== "append" || generationDelta !== 1)) ||
		messages.length < cached.messageCount ||
		stream.length < cached.byteStreamLength ||
		stream[0]?.rawOffset !== cached.firstRawOffset
	) return false;
	return cached.tailStart === 0 || String(messages[cached.tailStart - 1]?.id ?? "") === cached.prefixLastMessageId;
}

function adjustLiveCounts(
	signatureCounts: Map<string, number>,
	countsByPosition: Map<number, number>[],
	summary: LiveMessageSummary,
	delta: 1 | -1
): void {
	if (!summary.visible) return;
	const nextCount = (signatureCounts.get(summary.signature) || 0) + delta;
	if (nextCount > 0) signatureCounts.set(summary.signature, nextCount);
	else signatureCounts.delete(summary.signature);
	for (let position = 0; position < summary.bytes.length; position += 1) {
		const counts = countsByPosition[position] || (countsByPosition[position] = new Map());
		const next = (counts.get(summary.bytes[position]) || 0) + delta;
		if (next > 0) counts.set(summary.bytes[position], next);
		else counts.delete(summary.bytes[position]);
	}
}

function liveFrames(
	previous: MessageStreamSnapshot,
	matchingRows: MessageStreamRow[],
	prefixRowCount: number,
	highlight: boolean
): TransitionFrame[][] {
	if (!highlight) {
		return [
			...previous.frames.slice(0, prefixRowCount),
			...matchingRows.slice(prefixRowCount).map(row => visibleByteEntries(row).map(() => ({ incoming: null, outgoing: null })))
		];
	}
	const boundaryStart = Math.max(0, prefixRowCount - 1);
	return [
		...previous.frames.slice(0, boundaryStart),
		...transitionFrames(matchingRows.slice(boundaryStart))
	];
}

function snapshotFromParts({
	capture,
	viewState,
	matchingRows,
	entries,
	frames,
	signatureCounts,
	countsByPosition,
	patterns,
	patternNumbers,
	visiblePatternRowCounts,
	visibleMessageCount,
	telegramCount
}: {
	capture: Capture;
	viewState: ViewStateSnapshot;
	matchingRows: MessageStreamRow[];
	entries: MessageStreamEntry[];
	frames: TransitionFrame[][];
	signatureCounts: Map<string, number>;
	countsByPosition: Map<number, number>[];
	patterns: MessageStreamPatterns;
	patternNumbers: Map<string, number>;
	visiblePatternRowCounts: Map<string, number>;
	visibleMessageCount: number;
	telegramCount: number;
}): MessageStreamSnapshot {
	const visibleSummary = matchingRows.length
		? `${matchingRows.length.toLocaleString()} row${matchingRows.length === 1 ? "" : "s"}`
		: "0 rows";
	const hasVisibleMessages = visibleMessageCount > 0;
	const hasMatchingRows = matchingRows.length > 0;
	return {
		captureId: String(capture.id ?? ""),
		filterQuery: viewState.filterQuery,
		mode: viewState.displayMode,
		highlight: viewState.showFrameChanges,
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
		retainedTail: Boolean(capture.isRetainedTail || (capture.retainedStartOffset ?? 0) > 0),
		durableByteCount: Number(capture.byteCount ?? capture.byteStream?.length ?? 0),
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

function projectionFromSnapshot(
	snapshot: MessageStreamSnapshot,
	sections: MessageStreamSection[],
	visibleMessageCount: number
): MessageStreamAnalysisProjection {
	return {
		sections,
		matchingRows: snapshot.matchingRows,
		frames: snapshot.frames,
		signatureCounts: snapshot.signatureCounts,
		countsByPosition: snapshot.countsByPosition,
		patterns: snapshot.patterns,
		patternNumbers: snapshot.patternNumbers,
		visiblePatternRowCounts: snapshot.visiblePatternRowCounts,
		visibleMessageCount,
		telegramCount: snapshot.matchingRows.reduce((sum, row) => sum + row._repeats, 0)
	};
}

function rememberMessageStreamAnalysisProjection(
	capture: Capture,
	viewState: ViewStateSnapshot,
	projection: MessageStreamAnalysisProjection
): void {
	analysisProjectionCache.set(capture, {
		key: analysisProjectionKey(capture, viewState),
		projection
	});
}

function deriveLiveMessageStreamSnapshot(
	capture: Capture,
	viewState: ViewStateSnapshot,
	cached: LiveSnapshotCache
): MessageStreamSnapshot | undefined {
	if (!canReuseLiveSnapshot(capture, viewState, cached)) return undefined;
	const previous = cached.snapshot;
	const sections = liveSections(capture, cached);
	const oldTailRows = previous.matchingRows.slice(cached.tailRowIndex);
	const prefixRows = previous.matchingRows.slice(0, cached.tailRowIndex);
	const tailRows = filterRows(capture, viewState, previous.patterns, sections, cached.tailStart);
	if (tailRows.length) {
		const previousRow = prefixRows.at(-1);
		const firstTailRow = tailRows[0];
		tailRows[0] = {
			...firstTailRow,
			_delta:
				previousRow && firstTailRow._originalStart === previousRow._originalEnd + 1
					? firstTailRow._runStart - previousRow._runEnd
					: null
		};
	}
	const matchingRows = [...prefixRows, ...tailRows];
	const signatureCounts = new Map(previous.signatureCounts);
	const countsByPosition = previous.countsByPosition.map(counts => new Map(counts));
	const currentTailMessages = (capture.messages || []).slice(cached.tailStart).map(liveMessageSummary);
	let oldVisibleMessageCount = 0;
	let currentVisibleMessageCount = 0;
	cached.tailMessages.forEach(summary => {
		if (summary.visible) oldVisibleMessageCount += 1;
		adjustLiveCounts(signatureCounts, countsByPosition, summary, -1);
	});
	currentTailMessages.forEach(summary => {
		if (summary.visible) currentVisibleMessageCount += 1;
		adjustLiveCounts(signatureCounts, countsByPosition, summary, 1);
	});
	const visiblePatternRowCounts = new Map(previous.visiblePatternRowCounts);
	oldTailRows.forEach(row => {
		if (!row._patternOccurrence) return;
		const next = (visiblePatternRowCounts.get(row._patternOccurrence) || 0) - 1;
		if (next > 0) visiblePatternRowCounts.set(row._patternOccurrence, next);
		else visiblePatternRowCounts.delete(row._patternOccurrence);
	});
	tailRows.forEach(row => {
		if (!row._patternOccurrence) return;
		visiblePatternRowCounts.set(row._patternOccurrence, (visiblePatternRowCounts.get(row._patternOccurrence) || 0) + 1);
	});
	const telegramCount =
		cached.telegramCount - oldTailRows.reduce((sum, row) => sum + row._repeats, 0) + tailRows.reduce((sum, row) => sum + row._repeats, 0);
	const snapshot = snapshotFromParts({
		capture,
		viewState,
		matchingRows,
		entries: buildEntries(capture, viewState, sections, matchingRows),
		frames: liveFrames(previous, matchingRows, prefixRows.length, viewState.showFrameChanges),
		signatureCounts,
		countsByPosition,
		patterns: previous.patterns,
		patternNumbers: previous.patternNumbers,
		visiblePatternRowCounts,
		visibleMessageCount: cached.visibleMessageCount - oldVisibleMessageCount + currentVisibleMessageCount,
		telegramCount
	});
	rememberMessageStreamAnalysisProjection(
		capture,
		viewState,
		projectionFromSnapshot(
			snapshot,
			sections,
			cached.visibleMessageCount - oldVisibleMessageCount + currentVisibleMessageCount
		)
	);
	const nextTailStart = liveTailStart(capture, snapshot, viewState.collapseRuns || capture.previewMode === "sections");
	const tailOffset = nextTailStart - cached.tailStart;
	const nextTailMessages = tailOffset >= 0 && tailOffset <= currentTailMessages.length
		? currentTailMessages.slice(tailOffset)
		: undefined;
	rememberLiveSnapshot(
		capture,
		snapshot,
		sections,
		viewState,
		viewState.collapseRuns || capture.previewMode === "sections",
		cached.visibleMessageCount - oldVisibleMessageCount + currentVisibleMessageCount,
		telegramCount,
		cached.lastSectionMessageCount + Math.max(0, (capture.messages?.length || 0) - cached.messageCount),
		nextTailMessages
	);
	return snapshot;
}

export type MessageStreamDeriveOptions = {
	live?: boolean;
};

export function deriveMessageStreamSnapshot(
	capture: Capture | null | undefined,
	viewState: ViewStateSnapshot,
	options: MessageStreamDeriveOptions = {}
): MessageStreamSnapshot {
	if (!capture) return { ...EMPTY_MESSAGE_STREAM_SNAPSHOT, filterQuery: viewState.filterQuery, mode: viewState.displayMode, highlight: viewState.showFrameChanges };

	const cached = options.live ? liveSnapshotCache.get(capture) : undefined;
	if (options.live) {
		const liveSnapshot = cached && deriveLiveMessageStreamSnapshot(capture, viewState, cached);
		if (liveSnapshot) return liveSnapshot;
	}
	const projection = getMessageStreamAnalysisProjection(capture, viewState);
	const sections = assembleSectionPresentation(capture, viewState, projection.sections);
	const snapshot = snapshotFromParts({
		capture,
		viewState,
		matchingRows: projection.matchingRows,
		entries: buildEntries(capture, viewState, sections, projection.matchingRows),
		frames: projection.frames,
		signatureCounts: projection.signatureCounts,
		countsByPosition: projection.countsByPosition,
		patterns: projection.patterns,
		patternNumbers: projection.patternNumbers,
		visiblePatternRowCounts: projection.visiblePatternRowCounts,
		visibleMessageCount: projection.visibleMessageCount,
		telegramCount: projection.telegramCount
	});
	rememberLiveSnapshot(
		capture,
		snapshot,
		sections,
		viewState,
		viewState.collapseRuns || capture.previewMode === "sections",
		projection.visibleMessageCount,
		projection.telegramCount
	);
	return snapshot;
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

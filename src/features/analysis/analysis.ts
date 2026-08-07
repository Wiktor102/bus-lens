import {
	countSignatures,
	deriveAnalysisStatistics,
	recognizeRepeatedPatterns,
	rowsWithDelta as deriveRowsWithDelta,
	summarizeRunCadence as deriveRunCadence
} from "../../domain/analysis.ts";
import {
	frameWidth,
	hexByte,
	signature,
	visibleByteEntries,
	visibleMessages,
	type Capture,
	type CaptureMessage
} from "../capture/capture-framing.ts";
import type { FramedMessage } from "../capture/capture-summary.ts";

export const BYTE_COLORS = [
	"#79D8E7",
	"#CBF45A",
	"#F2B84B",
	"#B99AF7",
	"#FF8178",
	"#69D5A5",
	"#7DA9FF",
	"#E48AC2",
	"#5BD6C8",
	"#F08C62",
	"#A8B7FF",
	"#E76F7B"
] as const;

const TRANSITION_COLORS = ["#36C8E8", "#9E65F4", "#F39C4A", "#E35D91", "#5A8FFF", "#49C88A"] as const;
const PATTERN_COLORS = [
	"#42D9C8",
	"#B6E94A",
	"#FFB44C",
	"#B58AF4",
	"#F7788A",
	"#66A3FF",
	"#E987D0",
	"#72D28D",
	"#F08B5D",
	"#A6B2FF"
] as const;
const MIN_PATTERN_LENGTH = 2;
const MAX_PATTERN_LENGTH = 8;

export type MessageRow = CaptureMessage & {
	_originalStart: number;
	_originalEnd: number;
	_hasSequenceNote: boolean;
	_patternOccurrence: string | null;
	_runStart: number;
	_runEnd: number;
	_runMessages: CaptureMessage[];
	_repeats: number;
};

export type CadenceRow = MessageRow & {
	_cadence: number | null;
	_cadenceStable: boolean;
	_intervals: number[];
};

export type DeltaRow = CadenceRow & {
	_delta: number | null;
};

export type PatternGroup = {
	key: string;
	length: number;
	starts: number[];
	signatures: string[];
	score: number;
	id: string;
	color: string;
	remark: string;
};

export type PatternMembership = {
	group: PatternGroup;
	occurrenceIndex: number;
	offset: number;
};

export type MessagePatterns = {
	groups: PatternGroup[];
	membership: Map<number, PatternMembership>;
};

export type TransitionDescriptor = {
	color: string;
	lane: number;
	label: string;
};

export type TransitionFrame = {
	incoming: (TransitionDescriptor & { start: boolean; end: boolean }) | null;
	outgoing: (TransitionDescriptor & { start: boolean; end: boolean }) | null;
};

export type SignatureFrequency = {
	signature: string;
	count: number;
	width: number;
	percentage: number;
};

export type VocabularyValue = {
	value: number;
	hex: string;
	count: number;
};

export type VocabularyRow = {
	label: string;
	values: VocabularyValue[];
};

export type BitCell = {
	bit: number;
	variance: string;
	percentage: number;
};

export type BitRow = {
	label: string;
	cells: BitCell[];
};

export type TransitionRow = {
	from: string;
	to: string;
	count: number;
	diffs: number;
};

export type AnalysisSnapshot = {
	captureId: string | null;
	signatures: SignatureFrequency[];
	vocabulary: VocabularyRow[];
	bitVariance: BitRow[];
	transitions: TransitionRow[];
};

export const EMPTY_ANALYSIS_SNAPSHOT: AnalysisSnapshot = {
	captureId: null,
	signatures: [],
	vocabulary: [],
	bitVariance: [],
	transitions: []
};

export function hashText(value: string): number {
	let hash = 2166136261;
	for (const char of value) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

export function colorForByte(byte: number): string {
	const paletteIndex = (byte * 13 + (byte >> 4) * 7) % BYTE_COLORS.length;
	return BYTE_COLORS[paletteIndex];
}

export function colorForTransition(key: string): string {
	return TRANSITION_COLORS[hashText(key) % TRANSITION_COLORS.length];
}

export function colorForPattern(key: string): string {
	return PATTERN_COLORS[hashText(key) % PATTERN_COLORS.length];
}

export function getCounts(messages: readonly FramedMessage[]): Map<string, number> {
	return countSignatures(messages.map(signature));
}

export function rowsWithDelta<Row extends { _originalStart: number; _originalEnd: number; _runStart: number; _runEnd: number }>(
	rows: readonly Row[]
): Array<Row & { _delta: number | null }> {
	return deriveRowsWithDelta(rows);
}

export function summarizeRunCadence<Row extends { _runMessages: Array<{ timestamp: number }> }>(
	message: Row
): Row & { _cadence: number | null; _cadenceStable: boolean; _intervals: number[] } {
	return deriveRunCadence(message);
}

type PatternCacheEntry = {
	key: string;
	result: MessagePatterns;
};

const patternRecognitionCache = new WeakMap<object, PatternCacheEntry>();

function patternRemarkText(capture: Capture, key: string): string {
	const remark = capture.patternRemarks?.[key];
	return remark && typeof remark === "object" ? String((remark as { text?: unknown }).text || "") : "";
}

export function recognizeMessagePatterns(capture?: Capture | null): MessagePatterns {
	const messageEntries = (capture?.messages || [])
		.map((message, originalIndex) => ({ message, originalIndex }))
		.filter(({ message }) => !message.hidden);
	if (!capture || messageEntries.length < MIN_PATTERN_LENGTH * 2) return { groups: [], membership: new Map() };
	const cacheKey = [
		capture.byteStream?.length || 0,
		messageEntries.length,
		JSON.stringify((capture.messages || []).map(message => Boolean(message.hidden))),
		JSON.stringify((capture.messages || []).map(message => message.hiddenBytes || [])),
		capture.previewMode,
		capture.frameSize,
		capture.frameMarker,
		capture.markerPosition,
		capture.frameTimeGap,
		JSON.stringify(
			(capture.frameSections || []).map(
				({ start, framingMode, frameSize, frameMarker, markerPosition, frameTimeGap }) =>
					[start, framingMode, frameSize, frameMarker, markerPosition, frameTimeGap]
			)
		),
		JSON.stringify(capture.patternRemarks || {})
	].join("|");
	const cached = patternRecognitionCache.get(capture);
	if (cached?.key === cacheKey) return cached.result;
	const recognized = recognizeRepeatedPatterns(
		messageEntries.map(({ message, originalIndex }) => ({ signature: signature(message), originalIndex, sectionId: message.sectionId }))
	);
	const groups: PatternGroup[] = recognized.groups.map(candidate => ({
		...candidate,
		starts: [...candidate.starts],
		signatures: [...candidate.signatures],
		id: `pattern-${hashText(candidate.key).toString(36)}`,
		color: colorForPattern(candidate.key),
		remark: patternRemarkText(capture, candidate.key)
	}));
	const membership = new Map<number, PatternMembership>(
		recognized.membership.map(entry => [
			entry.originalIndex,
			{ group: groups[entry.groupIndex], occurrenceIndex: entry.occurrenceIndex, offset: entry.offset }
		])
	);
	const result = { groups, membership };
	patternRecognitionCache.set(capture, { key: cacheKey, result });
	return result;
}

export function transitionFrames<Row extends CaptureMessage & { _originalStart: number; _originalEnd: number; sectionId?: string }>(
	rows: readonly Row[]
): TransitionFrame[][] {
	const byteRows = rows.map(visibleByteEntries);
	const frames: TransitionFrame[][] = byteRows.map(row => row.map(() => ({ incoming: null, outgoing: null })));
	for (let rowIndex = 0; rowIndex < rows.length - 1; rowIndex++) {
		const fromRow = rows[rowIndex];
		const toRow = rows[rowIndex + 1];
		if (toRow._originalStart !== fromRow._originalEnd + 1 || toRow.sectionId !== fromRow.sectionId) continue;
		const fromBytes = byteRows[rowIndex];
		const toBytes = byteRows[rowIndex + 1];
		const comparable = Math.min(fromBytes.length, toBytes.length);
		const unchanged = Array.from({ length: comparable }, (_, position) => position).filter(
			position => fromBytes[position].value === toBytes[position].value
		);
		const changed = Array.from({ length: comparable }, (_, position) => position).filter(
			position => fromBytes[position].value !== toBytes[position].value
		);
		if (!unchanged.length || !changed.length) continue;

		const groups: number[][] = [];
		changed.forEach(position => {
			const group = groups.at(-1);
			if (group && position === group.at(-1)! + 1) group.push(position);
			else groups.push([position]);
		});

		groups.forEach(group => {
			const start = group[0];
			const end = group.at(-1)!;
			const from = group.map(position => hexByte(fromBytes[position].value)).join(" ");
			const to = group.map(position => hexByte(toBytes[position].value)).join(" ");
			const key = `${from}→${to}`;
			const descriptor: TransitionDescriptor = {
				color: colorForTransition(key),
				lane: hashText(key) % 3,
				label: `${from} → ${to}`
			};
			group.forEach(position => {
				frames[rowIndex][position].outgoing = {
					...descriptor,
					start: position === start,
					end: position === end
				};
				frames[rowIndex + 1][position].incoming = {
					...descriptor,
					start: position === start,
					end: position === end
				};
			});
		});
	}
	return frames;
}

export function deriveAnalysisSnapshot(capture?: Capture | null): AnalysisSnapshot {
	if (!capture) return EMPTY_ANALYSIS_SNAPSHOT;
	const messages = visibleMessages(capture);
	const statistics = deriveAnalysisStatistics(
		messages.map(message => ({
			signature: signature(message),
			bytes: visibleByteEntries(message).map(entry => entry.value)
		}))
	);
	const maxCount = statistics.signatures[0]?.count || 1;
	return {
		captureId: capture.id ? String(capture.id) : null,
		signatures: statistics.signatures.slice(0, 10).map(({ signature, count }) => ({
			signature,
			count,
			width: (count / maxCount) * 100,
			percentage: Math.round((count / messages.length) * 100)
		})),
		vocabulary: statistics.vocabulary.map((values, position) => ({
			label: `BYTE ${position + 1}`,
			values: values.map(({ value, count }) => ({ value, hex: hexByte(value), count }))
		})),
		bitVariance: statistics.bitVariance.map((cells, position) => ({ label: `BYTE ${position + 1}`, cells: [...cells] })),
		transitions: [...statistics.transitions]
	};
}

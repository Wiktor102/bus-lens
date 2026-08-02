import {
	frameWidth,
	hexByte,
	signature,
	visibleByteEntries,
	visibleMessages,
	type Capture,
	type CaptureMessage
} from "./capture-framing.ts";
import type { FramedMessage } from "./capture-summary.ts";

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
	const counts = new Map<string, number>();
	messages.forEach(message => counts.set(signature(message), (counts.get(signature(message)) || 0) + 1));
	return counts;
}

export function rowsWithDelta<Row extends { _originalStart: number; _originalEnd: number; _runStart: number; _runEnd: number }>(
	rows: readonly Row[]
): Array<Row & { _delta: number | null }> {
	return rows.map((row, index) => ({
		...row,
		_delta: index && row._originalStart === rows[index - 1]._originalEnd + 1 ? row._runStart - rows[index - 1]._runEnd : null
	}));
}

export function summarizeRunCadence<Row extends { _runMessages: Array<{ timestamp: number }> }>(
	message: Row
): Row & { _cadence: number | null; _cadenceStable: boolean; _intervals: number[] } {
	const intervals = message._runMessages
		.slice(1)
		.map((item, index) => item.timestamp - message._runMessages[index].timestamp)
		.filter(interval => Number.isFinite(interval) && interval >= 0);
	if (!intervals.length) return { ...message, _cadence: null, _cadenceStable: false, _intervals: intervals };
	const sorted = [...intervals].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	const tolerance = Math.max(2, median * 0.1);
	const stable = intervals.every(interval => Math.abs(interval - median) <= tolerance);
	const average = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
	return { ...message, _cadence: stable ? average : null, _cadenceStable: stable, _intervals: intervals };
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
	const messages = messageEntries.map(({ message }) => message);
	if (!capture || messages.length < MIN_PATTERN_LENGTH * 2) return { groups: [], membership: new Map() };
	const cacheKey = [
		capture.byteStream?.length || 0,
		messages.length,
		JSON.stringify((capture.messages || []).map(message => Boolean(message.hidden))),
		JSON.stringify((capture.messages || []).map(message => message.hiddenBytes || [])),
		capture.previewMode,
		capture.frameSize,
		capture.frameMarker,
		capture.markerPosition,
		capture.frameTimeGap,
		JSON.stringify((capture.frameSections || []).map(({ start, frameSize }) => [start, frameSize])),
		JSON.stringify(capture.patternRemarks || {})
	].join("|");
	const cached = patternRecognitionCache.get(capture);
	if (cached?.key === cacheKey) return cached.result;
	const signatures = messages.map(signature);
	const candidates: Array<{
		key: string;
		length: number;
		starts: number[];
		signatures: string[];
		score: number;
	}> = [];
	const maxLength = Math.min(MAX_PATTERN_LENGTH, Math.floor(messages.length / 2));

	for (let length = MIN_PATTERN_LENGTH; length <= maxLength; length++) {
		const startsByKey = new Map<string, number[]>();
		for (let start = 0; start + length <= messages.length; start++) {
			const window = messages.slice(start, start + length);
			if (
				messageEntries.slice(start, start + length).some(
					(entry, offset) => offset && entry.originalIndex !== messageEntries[start].originalIndex + offset
				)
			)
				continue;
			if (window.some((message, offset) => offset && message.sectionId !== window[0].sectionId)) continue;
			const parts = signatures.slice(start, start + length);
			// A run of one identical telegram is already represented by repeat collapsing;
			// sequence recognition is reserved for exchanges with at least two states.
			if (new Set(parts).size < 2) continue;
			// Do not report A-B-A-B as a four-message pattern when A-B is the
			// underlying repeated exchange.
			const hasShorterPeriod = Array.from(
				{ length: Math.floor(length / 2) - 1 },
				(_, index) => index + MIN_PATTERN_LENGTH
			).some(period => length % period === 0 && parts.every((part, index) => part === parts[index % period]));
			if (hasShorterPeriod) continue;
			const key = parts.join(" → ");
			const starts = startsByKey.get(key) || [];
			starts.push(start);
			startsByKey.set(key, starts);
		}
		startsByKey.forEach((starts, key) => {
			const nonOverlapping: number[] = [];
			starts.forEach(start => {
				if (!nonOverlapping.length || start >= nonOverlapping.at(-1)! + length) nonOverlapping.push(start);
			});
			if (nonOverlapping.length >= 2) {
				candidates.push({
					key,
					length,
					starts: nonOverlapping,
					signatures: key.split(" → "),
					score: length * nonOverlapping.length
				});
			}
		});
	}

	// Prefer the candidates that explain the most rows, then the longer exchange.
	// Each table row receives one edge color, keeping dense captures legible.
	candidates.sort(
		(a, b) => b.score - a.score || b.length - a.length || b.starts.length - a.starts.length || a.key.localeCompare(b.key)
	);
	const claimed = new Set<number>();
	const groups: PatternGroup[] = [];
	const groupStartIndexes = new Map<string, number[]>();
	for (const candidate of candidates) {
		const availableStarts = candidate.starts.filter(start => {
			for (let offset = 0; offset < candidate.length; offset++) {
				if (claimed.has(start + offset)) return false;
			}
			return true;
		});
		if (availableStarts.length < 2) continue;
		const group: PatternGroup = {
			...candidate,
			id: `pattern-${hashText(candidate.key).toString(36)}`,
			starts: availableStarts.map(start => messageEntries[start].originalIndex),
			color: colorForPattern(candidate.key),
			remark: patternRemarkText(capture, candidate.key)
		};
		groups.push(group);
		groupStartIndexes.set(group.id, availableStarts);
		availableStarts.forEach(start => {
			for (let offset = 0; offset < candidate.length; offset++) claimed.add(start + offset);
		});
	}

	const membership = new Map<number, PatternMembership>();
	groups.forEach(group =>
		groupStartIndexes.get(group.id)!.forEach((start, occurrenceIndex) => {
			for (let offset = 0; offset < group.length; offset++) {
				membership.set(messageEntries[start + offset].originalIndex, { group, occurrenceIndex, offset });
			}
		})
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
	const counts = [...getCounts(messages).entries()].sort((a, b) => b[1] - a[1]);
	const maxCount = counts[0]?.[1] || 1;
	const signatureRows = counts.slice(0, 10).map(([value, count]) => ({
		signature: value,
		count,
		width: (count / maxCount) * 100,
		percentage: Math.round((count / messages.length) * 100)
	}));

	const vocabulary = Array.from({ length: frameWidth(capture) }, (_, position): VocabularyRow => {
		const values = new Map<number, number>();
		messages.forEach(message => {
			const byte = visibleByteEntries(message)[position]?.value;
			if (byte !== undefined) values.set(byte, (values.get(byte) || 0) + 1);
		});
		return {
			label: `BYTE ${position + 1}`,
			values: [...values.entries()]
				.sort((a, b) => b[1] - a[1])
				.map(([value, count]) => ({ value, hex: hexByte(value), count }))
		};
	});

	const bitVariance = Array.from({ length: frameWidth(capture) }, (_, position): BitRow => {
		const bytes = messages.map(message => visibleByteEntries(message)[position]?.value).filter(value => value !== undefined);
		return {
			label: `BYTE ${position + 1}`,
			cells: Array.from({ length: 8 }, (_, index) => {
				const bit = 7 - index;
				const ones = bytes.filter(value => (value! >> bit) & 1).length;
				const ratio = bytes.length ? ones / bytes.length : 0;
				return {
					bit,
					variance: (Math.min(ratio, 1 - ratio) * 2).toFixed(2),
					percentage: Math.round(ratio * 100)
				};
			})
		};
	});

	const transitionCounts = new Map<string, number>();
	messages.slice(1).forEach((message, index) => {
		const from = signature(messages[index]);
		const to = signature(message);
		if (from !== to) transitionCounts.set(`${from}|${to}`, (transitionCounts.get(`${from}|${to}`) || 0) + 1);
	});
	const transitions = [...transitionCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 12)
		.map(([key, count]) => {
			const [from, to] = key.split("|");
			const diffs = from.split(" ").filter((value, index) => value !== to.split(" ")[index]).length;
			return { from, to, count, diffs };
		});

	return {
		captureId: capture.id ? String(capture.id) : null,
		signatures: signatureRows,
		vocabulary,
		bitVariance,
		transitions
	};
}

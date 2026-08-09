export type AnalysisFrame = Readonly<{
	signature: string;
	bytes: readonly number[];
}>;

export type SignatureCount = Readonly<{
	signature: string;
	count: number;
}>;

export type VocabularyValueCount = Readonly<{
	value: number;
	count: number;
}>;

export type BitVarianceCell = Readonly<{
	bit: number;
	variance: string;
	percentage: number;
}>;

export type TransitionCount = Readonly<{
	from: string;
	to: string;
	count: number;
	diffs: number;
}>;

export type AnalysisStatistics = Readonly<{
	signatures: readonly SignatureCount[];
	vocabulary: readonly (readonly VocabularyValueCount[])[];
	bitVariance: readonly (readonly BitVarianceCell[])[];
	transitions: readonly TransitionCount[];
}>;

export function countSignatures(signatures: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	signatures.forEach(signature => counts.set(signature, (counts.get(signature) || 0) + 1));
	return counts;
}

export function deriveAnalysisStatistics(frames: readonly AnalysisFrame[]): AnalysisStatistics {
	const signatures = frames.map(frame => frame.signature);
	const signatureCounts = [...countSignatures(signatures).entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([signature, count]) => ({ signature, count }));
	const width = Math.max(0, ...frames.map(frame => frame.bytes.length));
	const vocabulary = Array.from({ length: width }, (_, position) => {
		const values = new Map<number, number>();
		frames.forEach(frame => {
			const byte = frame.bytes[position];
			if (byte !== undefined) values.set(byte, (values.get(byte) || 0) + 1);
		});
		return [...values.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
	});
	const bitVariance = Array.from({ length: width }, (_, position) => {
		const bytes = frames.map(frame => frame.bytes[position]).filter((value): value is number => value !== undefined);
		return Array.from({ length: 8 }, (_, index) => {
			const bit = 7 - index;
			const ones = bytes.filter(value => (value >> bit) & 1).length;
			const ratio = bytes.length ? ones / bytes.length : 0;
			return {
				bit,
				variance: (Math.min(ratio, 1 - ratio) * 2).toFixed(2),
				percentage: Math.round(ratio * 100)
			};
		});
	});
	const transitionCounts = new Map<string, number>();
	signatures.slice(1).forEach((to, index) => {
		const from = signatures[index];
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
	return { signatures: signatureCounts, vocabulary, bitVariance, transitions };
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

export type PatternMessage = Readonly<{
	signature: string;
	originalIndex: number;
	sectionId?: unknown;
}>;

export type PatternCandidate = Readonly<{
	key: string;
	length: number;
	starts: readonly number[];
	signatures: readonly string[];
	score: number;
}>;

export type PatternOccurrenceMembership = Readonly<{
	groupIndex: number;
	originalIndex: number;
	occurrenceIndex: number;
	offset: number;
}>;

export type RepeatedPatterns = Readonly<{
	groups: readonly PatternCandidate[];
	membership: readonly PatternOccurrenceMembership[];
}>;

export function recognizeRepeatedPatterns(messages: readonly PatternMessage[]): RepeatedPatterns {
	const minLength = 2;
	const maxLength = 8;
	if (messages.length < minLength * 2) return { groups: [], membership: [] };
	const signatures = messages.map(message => message.signature);
	const candidates: PatternCandidate[] = [];
	const maximumLength = Math.min(maxLength, Math.floor(messages.length / 2));

	for (let length = minLength; length <= maximumLength; length++) {
		const startsByKey = new Map<string, number[]>();
		for (let start = 0; start + length <= messages.length; start++) {
			const window = messages.slice(start, start + length);
			if (window.some((message, offset) => offset && message.originalIndex !== messages[start].originalIndex + offset)) continue;
			if (window.some((message, offset) => offset && message.sectionId !== window[0].sectionId)) continue;
			const parts = signatures.slice(start, start + length);
			if (new Set(parts).size < 2) continue;
			const hasShorterPeriod = Array.from({ length: Math.floor(length / 2) - 1 }, (_, index) => index + minLength).some(
				period => length % period === 0 && parts.every((part, index) => part === parts[index % period])
			);
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
				candidates.push({ key, length, starts: nonOverlapping, signatures: key.split(" → "), score: length * nonOverlapping.length });
			}
		});
	}

	candidates.sort((a, b) => b.score - a.score || b.length - a.length || b.starts.length - a.starts.length || a.key.localeCompare(b.key));
	const claimed = new Set<number>();
	const groups: PatternCandidate[] = [];
	const startsByGroup: number[][] = [];
	for (const candidate of candidates) {
		const availableStarts = candidate.starts.filter(start => {
			for (let offset = 0; offset < candidate.length; offset++) {
				if (claimed.has(start + offset)) return false;
			}
			return true;
		});
		if (availableStarts.length < 2) continue;
		const groupIndex = groups.length;
		groups.push({ ...candidate, starts: availableStarts.map(start => messages[start].originalIndex) });
		startsByGroup.push(availableStarts);
		availableStarts.forEach(start => {
			for (let offset = 0; offset < candidate.length; offset++) claimed.add(start + offset);
		});
		if (groupIndex !== groups.length - 1) throw new Error("Pattern group indexing invariant failed");
	}
	const membership: PatternOccurrenceMembership[] = [];
	startsByGroup.forEach((starts, groupIndex) => {
		const group = groups[groupIndex];
		starts.forEach((start, occurrenceIndex) => {
			for (let offset = 0; offset < group.length; offset++) {
				membership.push({ groupIndex, originalIndex: messages[start + offset].originalIndex, occurrenceIndex, offset });
			}
		});
	});
	return { groups, membership };
}

type CollapsibleRow = {
	sectionId?: string;
	timestamp: number;
	_originalStart: number;
	_originalEnd: number;
	_hasSequenceNote: boolean;
	_patternOccurrence: string | null;
	_runEnd: number;
	_runMessages: unknown[];
	_repeats: number;
};

export function collapseAdjacentRuns<Row extends CollapsibleRow>(
	rows: Row[],
	shouldCollapse: (row: Row) => boolean,
	getSignature: (row: Row) => string
) {
	const collapsed: Row[] = [];
	rows.forEach(row => {
		const last = collapsed.at(-1);
		const isAdjacent =
			last && row._originalStart === last._originalEnd + 1 && row.sectionId === last.sectionId;
		if (
			last &&
			shouldCollapse(row) &&
			isAdjacent &&
			!last._hasSequenceNote &&
			!row._hasSequenceNote &&
			last._patternOccurrence === row._patternOccurrence &&
			getSignature(last) === getSignature(row)
		) {
			last._repeats++;
			last._originalEnd = row._originalEnd;
			last._runEnd = row.timestamp;
			last._runMessages.push(row);
		} else {
			collapsed.push(row);
		}
	});
	return collapsed;
}

export function countVisibleRowsByPatternOccurrence(
	rows: Array<{ _patternOccurrence: string | null }>
) {
	const counts = new Map<string, number>();
	rows.forEach(row => {
		if (row._patternOccurrence === null) return;
		counts.set(row._patternOccurrence, (counts.get(row._patternOccurrence) || 0) + 1);
	});
	return counts;
}

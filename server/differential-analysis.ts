import {
	AgentQueryError,
	type AgentSnapshotReference
} from "./agent-contracts.ts";

export const AGENT_DIFFERENTIAL_ALIGNMENT_MODES = [
	"ordinal",
	"raw-relative",
	"timestamp-nearest",
	"signature-sequence"
] as const;

export const MAX_DIFFERENTIAL_FRAMES = 1_000;

export type AgentDifferentialAlignmentMode = typeof AGENT_DIFFERENTIAL_ALIGNMENT_MODES[number];

export type AgentDifferentialMessageFilters = Readonly<{
	ordinalFrom?: number;
	ordinalTo?: number;
	frameOrdinalFrom?: number;
	frameOrdinalTo?: number;
	rawOffsetFrom?: number;
	rawOffsetTo?: number;
	timestampFrom?: number;
	timestampTo?: number;
	sectionId?: string;
	direction?: string;
	exactSignature?: string;
	signature?: string;
	wildcardHexPattern?: string;
	hidden?: "include" | "visible-only" | "hidden-only";
	notePresence?: "any" | "with-note" | "without-note";
	sequenceGroupId?: string;
}>;

export type AgentDifferentialScope = Readonly<{
	sectionId?: string;
	frameLength?: number;
	exactSignature?: string;
	wildcardHexPattern?: string;
	direction?: string;
}>;

export type AgentCaptureDifferenceInput = Readonly<{
	baseline: Readonly<{
		snapshot: AgentSnapshotReference;
		label: string;
		filters?: AgentDifferentialMessageFilters;
	}>;
	changed: Readonly<{
		snapshot: AgentSnapshotReference;
		label: string;
		filters?: AgentDifferentialMessageFilters;
	}>;
	alignment: Readonly<{
		mode: AgentDifferentialAlignmentMode;
		maximumTimestampDeltaMs?: number;
	}>;
	scope?: AgentDifferentialScope;
	minimumSupport?: number;
	cursor?: string;
	limit?: number;
}>;

export type NormalizedDifferentialMessageFilters = Readonly<{
	ordinalFrom?: number;
	ordinalTo?: number;
	rawOffsetFrom?: number;
	rawOffsetTo?: number;
	timestampFrom?: number;
	timestampTo?: number;
	sectionId?: string;
	direction?: string;
	exactSignature?: string;
	wildcardHexPattern?: string;
	wildcardTokens?: readonly (number | null)[];
	hidden: "include" | "visible-only" | "hidden-only";
	notePresence: "any" | "with-note" | "without-note";
	sequenceGroupId?: string;
}>;

export type NormalizedDifferentialScope = Readonly<{
	sectionId?: string;
	frameLength?: number;
	exactSignature?: string;
	wildcardHexPattern?: string;
	wildcardTokens?: readonly (number | null)[];
	direction?: string;
}>;

export type DifferentialFrame = Readonly<{
	id: string;
	ordinal: number;
	sectionId: string;
	bytes: readonly number[];
	timestamps: readonly number[];
	directions: readonly string[];
	hidden: boolean;
	signature: string;
	rawOffsets: readonly number[];
	timestamp: number | null;
	rawStart: number | null;
}>;

export type DifferentialAlignedPair = Readonly<{
	baseline: DifferentialFrame;
	changed: DifferentialFrame;
	quality: number;
	timestampDeltaMs: number | null;
}>;

export type AgentValueCount = Readonly<{
	value: number;
	count: number;
}>;

export type AgentMaskCount = Readonly<{
	mask: string;
	count: number;
}>;

export type AgentDifferentialEvidence = Readonly<{
	baselineFrameIds: readonly string[];
	changedFrameIds: readonly string[];
	evidenceTruncated: boolean;
}>;

export type AgentDifferentialScoreComponents = Readonly<{
	supportFactor: number;
	changeConsistency: number;
	directionConsistency: number;
	familySpecificity: number;
	alignmentQuality: number;
}>;

export type AgentDifferentialCandidate = Readonly<{
	sectionId: string;
	frameFamily: string;
	bytePosition: number;
	bitMask: string;
	baselineValues: readonly AgentValueCount[];
	changedValues: readonly AgentValueCount[];
	xorMasks: readonly AgentMaskCount[];
	setCount: number;
	clearCount: number;
	support: number;
	pairedFrameCount: number;
	changeConsistency: number;
	directionConsistency: number;
	score: number;
	scoreComponents: AgentDifferentialScoreComponents;
	evidence: AgentDifferentialEvidence;
	}>;

export type AgentDifferentialPositionSummary = Readonly<{
	sectionId: string;
	frameFamily: string;
	bytePosition: number;
	pairedFrameCount: number;
	observedFrameCount: number;
	changedPairCount: number;
	changeConsistency: number;
}>;

export type AgentDifferentialLengthChange = Readonly<{
	sectionId: string;
	frameFamily: string;
	baselineLength: number;
	changedLength: number;
	support: number;
	pairedFrameCount: number;
}>;

export type AgentDifferentialDifferenceSummary = Readonly<{
	invariantPositions: readonly AgentDifferentialPositionSummary[];
	conditionallyChangingPositions: readonly AgentDifferentialPositionSummary[];
	alwaysChangingPositions: readonly AgentDifferentialPositionSummary[];
	lengthChanges: readonly AgentDifferentialLengthChange[];
	truncated: boolean;
}>;

export type AgentDifferentialSnapshotSummary = Readonly<{
	label: string;
	snapshot: AgentSnapshotReference;
	totalFrameCount: number;
	filteredFrameCount: number;
	excludedFrameCount: number;
}>;

export type AgentDifferentialAlignmentSummary = Readonly<{
	mode: AgentDifferentialAlignmentMode;
	pairedFrameCount: number;
	baselineUnpairedFrameCount: number;
	changedUnpairedFrameCount: number;
	insertedFrameCount: number;
	deletedFrameCount: number;
	excludedFrameCount: Readonly<{ baseline: number; changed: number }>;
	unpairedFrameCount: Readonly<{ baseline: number; changed: number }>;
	maximumTimestampDeltaMs?: number;
}>;

export type AgentCaptureDifferenceResult = Readonly<{
	baseline: AgentDifferentialSnapshotSummary;
	changed: AgentDifferentialSnapshotSummary;
	alignment: AgentDifferentialAlignmentSummary;
	differenceSummary: AgentDifferentialDifferenceSummary;
	candidateFields: readonly AgentDifferentialCandidate[];
}>;

type WildcardToken = number | null;

type NormalizableMessageFilters = AgentDifferentialMessageFilters | undefined;

type NormalizableScope = AgentDifferentialScope | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) throw new AgentQueryError("invalid-input", `${label} is required`, { label });
	return text;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw new AgentQueryError("invalid-input", `${label} must be a non-negative integer`, { label });
	}
	return Number(value);
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
	const parsed = optionalNonNegativeInteger(value, label);
	if (parsed === 0) throw new AgentQueryError("invalid-input", `${label} must be a positive integer`, { label });
	return parsed;
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new AgentQueryError("invalid-input", `${label} must be a finite number`, { label });
	}
	return value;
}

function normalizedSignature(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredText(value, label).toUpperCase().replace(/\s+/g, " ");
}

function parseWildcardPattern(value: unknown, boundedByRange: boolean, label = "wildcardHexPattern"): { pattern: string; tokens: readonly WildcardToken[] } | undefined {
	if (value === undefined) return undefined;
	const pattern = requiredText(value, label);
	const rawTokens = pattern.split(/[\s,:-]+/).filter(Boolean);
	if (!rawTokens.length) throw new AgentQueryError("invalid-input", `${label} must contain hexadecimal bytes`, { pattern });
	const tokens = rawTokens.map(token => {
		if (token === "??") return null;
		if (!/^[0-9a-f]{2}$/i.test(token)) {
			throw new AgentQueryError("invalid-input", `${label} must use two-digit hexadecimal bytes or ??`, { pattern, token });
		}
		return Number.parseInt(token, 16);
	});
	if (tokens[0] === null && !boundedByRange) {
		throw new AgentQueryError("wildcard-too-broad", "A wildcard must begin with a literal byte or include both bounds of an ordinal or timestamp range", { pattern });
	}
	return { pattern: rawTokens.map(token => token.toUpperCase()).join(" "), tokens };
}

function normalizedRange(
	from: number | undefined,
	to: number | undefined,
	fromLabel: string,
	toLabel: string
): { from?: number; to?: number } {
	if (from !== undefined && to !== undefined && from > to) {
		throw new AgentQueryError("invalid-input", `${fromLabel} must not exceed ${toLabel}`, { [fromLabel]: from, [toLabel]: to });
	}
	return {
		...(from === undefined ? {} : { from }),
		...(to === undefined ? {} : { to })
	};
}

export function normalizeDifferentialMessageFilters(input: NormalizableMessageFilters): NormalizedDifferentialMessageFilters {
	if (input !== undefined && !isRecord(input)) throw new AgentQueryError("invalid-input", "Message filters must be an object", { label: "filters" });
	const value = input ?? {};
	const ordinalFrom = optionalNonNegativeInteger(value.ordinalFrom ?? value.frameOrdinalFrom, "ordinalFrom");
	const ordinalTo = optionalNonNegativeInteger(value.ordinalTo ?? value.frameOrdinalTo, "ordinalTo");
	const rawOffsetFromRequested = optionalNonNegativeInteger(value.rawOffsetFrom, "rawOffsetFrom");
	const rawOffsetToRequested = optionalNonNegativeInteger(value.rawOffsetTo, "rawOffsetTo");
	const rawOffsetFrom = rawOffsetFromRequested ?? rawOffsetToRequested;
	const rawOffsetTo = rawOffsetToRequested ?? rawOffsetFromRequested;
	const timestampFrom = optionalFiniteNumber(value.timestampFrom, "timestampFrom");
	const timestampTo = optionalFiniteNumber(value.timestampTo, "timestampTo");
	normalizedRange(ordinalFrom, ordinalTo, "ordinalFrom", "ordinalTo");
	normalizedRange(rawOffsetFrom, rawOffsetTo, "rawOffsetFrom", "rawOffsetTo");
	normalizedRange(timestampFrom, timestampTo, "timestampFrom", "timestampTo");
	const wildcard = parseWildcardPattern(
		value.wildcardHexPattern,
		ordinalFrom !== undefined && ordinalTo !== undefined || timestampFrom !== undefined && timestampTo !== undefined
	);
	const hidden = value.hidden ?? "include";
	if (hidden !== "include" && hidden !== "visible-only" && hidden !== "hidden-only") {
		throw new AgentQueryError("invalid-input", "hidden must be include, visible-only, or hidden-only", { value: hidden });
	}
	const notePresence = value.notePresence ?? "any";
	if (notePresence !== "any" && notePresence !== "with-note" && notePresence !== "without-note") {
		throw new AgentQueryError("invalid-input", "notePresence must be any, with-note, or without-note", { value: notePresence });
	}
	return {
		...(ordinalFrom === undefined ? {} : { ordinalFrom }),
		...(ordinalTo === undefined ? {} : { ordinalTo }),
		...(rawOffsetFrom === undefined ? {} : { rawOffsetFrom }),
		...(rawOffsetTo === undefined ? {} : { rawOffsetTo }),
		...(timestampFrom === undefined ? {} : { timestampFrom }),
		...(timestampTo === undefined ? {} : { timestampTo }),
		...(value.sectionId === undefined ? {} : { sectionId: requiredText(value.sectionId, "sectionId") }),
		...(value.direction === undefined ? {} : { direction: requiredText(value.direction, "direction").toLowerCase() }),
		...(normalizedSignature(value.exactSignature ?? value.signature, "exactSignature") ? { exactSignature: normalizedSignature(value.exactSignature ?? value.signature, "exactSignature") } : {}),
		...(wildcard ? { wildcardHexPattern: wildcard.pattern, wildcardTokens: wildcard.tokens } : {}),
		hidden,
		notePresence,
		...(value.sequenceGroupId === undefined ? {} : { sequenceGroupId: requiredText(value.sequenceGroupId, "sequenceGroupId") })
	};
}

export function normalizeDifferentialScope(input: NormalizableScope): NormalizedDifferentialScope {
	if (input !== undefined && !isRecord(input)) throw new AgentQueryError("invalid-input", "scope must be an object", { label: "scope" });
	const value = input ?? {};
	const frameLength = optionalPositiveInteger(value.frameLength, "frameLength");
	const wildcard = parseWildcardPattern(value.wildcardHexPattern, false);
	return {
		...(value.sectionId === undefined ? {} : { sectionId: requiredText(value.sectionId, "scope.sectionId") }),
		...(frameLength === undefined ? {} : { frameLength }),
		...(normalizedSignature(value.exactSignature, "scope.exactSignature") ? { exactSignature: normalizedSignature(value.exactSignature, "scope.exactSignature") } : {}),
		...(wildcard ? { wildcardHexPattern: wildcard.pattern, wildcardTokens: wildcard.tokens } : {}),
		...(value.direction === undefined ? {} : { direction: requiredText(value.direction, "scope.direction").toLowerCase() })
	};
}

export type DifferentialFramePredicate = Readonly<{
	sql: string;
	params: Readonly<Record<string, unknown>>;
}>;

/**
 * Build the SQL part shared by differential frame selection and its count.
 * The caller supplies the profile predicate because the two snapshots have
 * separate profile IDs. Message filters and report scope are deliberately
 * rendered independently so a request cannot accidentally replace one with
 * the other when both contain the same field.
 */
export function differentialFramePredicate(
	filters: NormalizedDifferentialMessageFilters | NormalizedDifferentialScope,
	parameterPrefix: string,
	alias = "frames"
): DifferentialFramePredicate {
	const clauses: string[] = [];
	const params: Record<string, unknown> = {};
	const parameter = (name: string): string => `${parameterPrefix}${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`;
	const put = (name: string, value: unknown): void => { params[parameter(name)] = value; };
	const hasFilterShape = "hidden" in filters;
	const wildcardTokens = filters.wildcardTokens;

	if (hasFilterShape && filters.ordinalFrom !== undefined) { clauses.push(`${alias}.ordinal >= @${parameter("ordinalFrom")}`); put("ordinalFrom", filters.ordinalFrom); }
	if (hasFilterShape && filters.ordinalTo !== undefined) { clauses.push(`${alias}.ordinal <= @${parameter("ordinalTo")}`); put("ordinalTo", filters.ordinalTo); }
	if (hasFilterShape && filters.rawOffsetFrom !== undefined && filters.rawOffsetTo !== undefined) {
		clauses.push(`CAST(json_extract(${alias}.raw_offsets_json, '$[#-1]') AS INTEGER) >= @${parameter("rawOffsetFrom")}`);
		clauses.push(`CAST(json_extract(${alias}.raw_offsets_json, '$[0]') AS INTEGER) <= @${parameter("rawOffsetTo")}`);
		put("rawOffsetFrom", filters.rawOffsetFrom);
		put("rawOffsetTo", filters.rawOffsetTo);
	}
	if (hasFilterShape && filters.timestampFrom !== undefined) {
		clauses.push(`EXISTS (SELECT 1 FROM json_each(${alias}.timestamps_json) timestamp_values WHERE CAST(timestamp_values.value AS REAL) >= @${parameter("timestampFrom")})`);
		put("timestampFrom", filters.timestampFrom);
	}
	if (hasFilterShape && filters.timestampTo !== undefined) {
		clauses.push(`EXISTS (SELECT 1 FROM json_each(${alias}.timestamps_json) timestamp_values WHERE CAST(timestamp_values.value AS REAL) <= @${parameter("timestampTo")})`);
		put("timestampTo", filters.timestampTo);
	}
	if (filters.sectionId !== undefined) { clauses.push(`${alias}.section_id = @${parameter("sectionId")}`); put("sectionId", filters.sectionId); }
	if (filters.direction !== undefined) {
		clauses.push(`EXISTS (SELECT 1 FROM json_each(${alias}.directions_json) direction_values WHERE LOWER(CAST(direction_values.value AS TEXT)) = @${parameter("direction")})`);
		put("direction", filters.direction);
	}
	if (filters.exactSignature !== undefined) { clauses.push(`${alias}.signature = @${parameter("exactSignature")}`); put("exactSignature", filters.exactSignature); }
	if ("frameLength" in filters && filters.frameLength !== undefined) {
		clauses.push(`json_array_length(${alias}.bytes_json) = @${parameter("frameLength")}`);
		put("frameLength", filters.frameLength);
	}
	if (wildcardTokens) {
		clauses.push(`json_array_length(${alias}.bytes_json) >= @${parameter("wildcardLength")}`);
		put("wildcardLength", wildcardTokens.length);
		wildcardTokens.forEach((token, index) => {
			if (token === null) return;
			clauses.push(`CAST(json_extract(${alias}.bytes_json, '$[${index}]') AS INTEGER) = @${parameter(`wildcard${index}`)}`);
			put(`wildcard${index}`, token);
		});
	}
	if (hasFilterShape && filters.hidden === "visible-only") clauses.push(`${alias}.hidden = 0`);
	if (hasFilterShape && filters.hidden === "hidden-only") clauses.push(`${alias}.hidden = 1`);
	if (hasFilterShape && filters.notePresence !== "any") {
		const noteExists = `EXISTS (
			SELECT 1 FROM stable_notes notes
			WHERE notes.capture_id = ${alias}.capture_id
			  AND (
				notes.frame_id = ${alias}.id
				OR notes.profile_id = ${alias}.profile_id AND notes.start_row IS NOT NULL AND notes.end_row IS NOT NULL AND notes.start_row <= ${alias}.ordinal AND notes.end_row >= ${alias}.ordinal
				OR notes.profile_id = ${alias}.profile_id AND notes.start_offset IS NOT NULL AND notes.end_offset IS NOT NULL AND notes.end_offset >= json_extract(${alias}.raw_offsets_json, '$[0]') AND notes.start_offset <= json_extract(${alias}.raw_offsets_json, '$[#-1]')
				OR notes.raw_offset IS NOT NULL AND notes.raw_offset >= json_extract(${alias}.raw_offsets_json, '$[0]') AND notes.raw_offset <= json_extract(${alias}.raw_offsets_json, '$[#-1]')
			  )
		)`;
		clauses.push(filters.notePresence === "with-note" ? noteExists : `NOT ${noteExists}`);
	}
	if (hasFilterShape && filters.sequenceGroupId !== undefined) {
		clauses.push(`EXISTS (
			SELECT 1 FROM sequence_occurrences sequence_membership
			JOIN sequence_groups sequence_group
			  ON sequence_group.id = sequence_membership.group_id
			 AND sequence_group.profile_id = ${alias}.profile_id
			 AND sequence_group.capture_id = ${alias}.capture_id
			WHERE sequence_membership.group_id = @${parameter("sequenceGroupId")}
			  AND sequence_membership.start_frame_ordinal <= ${alias}.ordinal
			  AND sequence_membership.start_frame_ordinal + sequence_membership.length > ${alias}.ordinal
		)`);
		put("sequenceGroupId", filters.sequenceGroupId);
	}
	return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

export function frameTimestamp(frame: Pick<DifferentialFrame, "timestamps">): number | null {
	return frame.timestamps.find(timestamp => typeof timestamp === "number" && Number.isFinite(timestamp)) ?? null;
}

function frameRawStart(frame: Pick<DifferentialFrame, "rawOffsets">): number | null {
	const offsets = frame.rawOffsets.filter(Number.isSafeInteger);
	return offsets.length ? Math.min(...offsets) : null;
}

export function makeDifferentialFrame(frame: Omit<DifferentialFrame, "timestamp" | "rawStart">): DifferentialFrame {
	return { ...frame, timestamp: frameTimestamp(frame), rawStart: frameRawStart(frame) };
}

function frameOrder(left: DifferentialFrame, right: DifferentialFrame): number {
	return left.ordinal - right.ordinal || left.id.localeCompare(right.id);
}

function timestampOrder(left: DifferentialFrame, right: DifferentialFrame): number {
	const leftTimestamp = left.timestamp;
	const rightTimestamp = right.timestamp;
	if (leftTimestamp === null && rightTimestamp !== null) return 1;
	if (leftTimestamp !== null && rightTimestamp === null) return -1;
	return (leftTimestamp ?? 0) - (rightTimestamp ?? 0) || frameOrder(left, right);
}

function rawRelativeOrder(left: DifferentialFrame, right: DifferentialFrame): number {
	const leftOffset = left.rawStart;
	const rightOffset = right.rawStart;
	if (leftOffset === null && rightOffset !== null) return 1;
	if (leftOffset !== null && rightOffset === null) return -1;
	return (leftOffset ?? 0) - (rightOffset ?? 0) || frameOrder(left, right);
}

export type DifferentialAlignment = Readonly<{
	pairs: readonly DifferentialAlignedPair[];
	baselineUnpaired: readonly DifferentialFrame[];
	changedUnpaired: readonly DifferentialFrame[];
	insertedFrameCount: number;
	deletedFrameCount: number;
	}>;

export function alignOrdinal(
	baseline: readonly DifferentialFrame[],
	changed: readonly DifferentialFrame[],
	mode: "ordinal" | "raw-relative"
): DifferentialAlignment {
	const left = [...baseline].sort(mode === "raw-relative" ? rawRelativeOrder : frameOrder);
	const right = [...changed].sort(mode === "raw-relative" ? rawRelativeOrder : frameOrder);
	const pairCount = Math.min(left.length, right.length);
	const pairs = Array.from({ length: pairCount }, (_value, index) => ({
		baseline: left[index]!,
		changed: right[index]!,
		quality: 1,
		timestampDeltaMs: left[index]!.timestamp !== null && right[index]!.timestamp !== null ? Math.abs(left[index]!.timestamp! - right[index]!.timestamp!) : null
	}));
	return {
		pairs,
		baselineUnpaired: left.slice(pairCount),
		changedUnpaired: right.slice(pairCount),
		insertedFrameCount: right.length - pairCount,
		deletedFrameCount: left.length - pairCount
	};
}

export function alignTimestampNearest(
	baseline: readonly DifferentialFrame[],
	changed: readonly DifferentialFrame[],
	maximumTimestampDeltaMs: number
): DifferentialAlignment {
	const orderedBaseline = [...baseline].sort(timestampOrder);
	const orderedChanged = [...changed].sort(timestampOrder);
	const used = new Set<string>();
	const pairs: DifferentialAlignedPair[] = [];
	const baselineUnpaired: DifferentialFrame[] = [];
	for (const baselineFrame of orderedBaseline) {
		if (baselineFrame.timestamp === null) {
			baselineUnpaired.push(baselineFrame);
			continue;
		}
		const candidates = orderedChanged
			.filter(changedFrame => changedFrame.timestamp !== null && !used.has(changedFrame.id))
			.map(changedFrame => ({
				frame: changedFrame,
				delta: Math.abs(changedFrame.timestamp! - baselineFrame.timestamp!)
			}))
			.filter(candidate => candidate.delta <= maximumTimestampDeltaMs)
			.sort((left, right) => left.delta - right.delta
				|| (left.frame.timestamp ?? 0) - (right.frame.timestamp ?? 0)
				|| frameOrder(left.frame, right.frame));
		const selected = candidates[0];
		if (!selected) {
			baselineUnpaired.push(baselineFrame);
			continue;
		}
		used.add(selected.frame.id);
		pairs.push({
			baseline: baselineFrame,
			changed: selected.frame,
			quality: maximumTimestampDeltaMs === 0 ? 1 : Math.max(0, 1 - selected.delta / maximumTimestampDeltaMs),
			timestampDeltaMs: selected.delta
		});
	}
	const changedUnpaired = orderedChanged.filter(frame => !used.has(frame.id));
	return {
		pairs: pairs.sort((left, right) => frameOrder(left.baseline, right.baseline)),
		baselineUnpaired,
		changedUnpaired,
		insertedFrameCount: changedUnpaired.length,
		deletedFrameCount: baselineUnpaired.length
	};
}

type AlignmentAction = "pair" | "delete" | "insert";

export const MAX_SIGNATURE_ALIGNMENT_FRAMES = 250;

export function alignSignatureSequence(
	baseline: readonly DifferentialFrame[],
	changed: readonly DifferentialFrame[]
): DifferentialAlignment {
	if (baseline.length > MAX_SIGNATURE_ALIGNMENT_FRAMES || changed.length > MAX_SIGNATURE_ALIGNMENT_FRAMES) {
		throw new AgentQueryError(
			"invalid-input",
			`signature-sequence alignment accepts at most ${MAX_SIGNATURE_ALIGNMENT_FRAMES} filtered frames per side`,
			{ maximumFramesPerSide: MAX_SIGNATURE_ALIGNMENT_FRAMES, baselineFrames: baseline.length, changedFrames: changed.length }
		);
	}
	const rows = baseline.length + 1;
	const columns = changed.length + 1;
	const scores = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
	const actions = Array.from({ length: rows }, () => Array<AlignmentAction | undefined>(columns).fill(undefined));
	for (let index = 1; index < rows; index += 1) {
		scores[index]![0] = scores[index - 1]![0]! - 2;
		actions[index]![0] = "delete";
	}
	for (let index = 1; index < columns; index += 1) {
		scores[0]![index] = scores[0]![index - 1]! - 2;
		actions[0]![index] = "insert";
	}
	for (let row = 1; row < rows; row += 1) {
		for (let column = 1; column < columns; column += 1) {
			const baselineFrame = baseline[row - 1]!;
			const changedFrame = changed[column - 1]!;
			const diagonal = scores[row - 1]![column - 1]! + (baselineFrame.signature === changedFrame.signature ? 3 : -1);
			const deletion = scores[row - 1]![column]! - 2;
			const insertion = scores[row]![column - 1]! - 2;
			// Prefer a real pair, then a baseline deletion, then a changed insertion.
			// This makes equal-score paths stable across runtimes and preserves the
			// evidence order used by the cursor and follow-up queries.
			if (diagonal >= deletion && diagonal >= insertion) {
				scores[row]![column] = diagonal;
				actions[row]![column] = "pair";
			} else if (deletion >= insertion) {
				scores[row]![column] = deletion;
				actions[row]![column] = "delete";
			} else {
				scores[row]![column] = insertion;
				actions[row]![column] = "insert";
			}
		}
	}

	const pairs: DifferentialAlignedPair[] = [];
	const baselineUnpaired: DifferentialFrame[] = [];
	const changedUnpaired: DifferentialFrame[] = [];
	let row = baseline.length;
	let column = changed.length;
	while (row > 0 || column > 0) {
		const action = actions[row]![column];
		if (action === "pair") {
			const baselineFrame = baseline[row - 1]!;
			const changedFrame = changed[column - 1]!;
			pairs.push({
				baseline: baselineFrame,
				changed: changedFrame,
				quality: baselineFrame.signature === changedFrame.signature ? 1 : 0.5,
				timestampDeltaMs: baselineFrame.timestamp !== null && changedFrame.timestamp !== null ? Math.abs(baselineFrame.timestamp - changedFrame.timestamp) : null
			});
			row -= 1;
			column -= 1;
		} else if (action === "delete" || column === 0) {
			baselineUnpaired.push(baseline[row - 1]!);
			row -= 1;
		} else {
			changedUnpaired.push(changed[column - 1]!);
			column -= 1;
		}
	}
	pairs.reverse();
	baselineUnpaired.reverse();
	changedUnpaired.reverse();
	return {
		pairs,
		baselineUnpaired,
		changedUnpaired,
		insertedFrameCount: changedUnpaired.length,
		deletedFrameCount: baselineUnpaired.length
	};
}

function roundScore(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function bitMask(bit: number): string {
	return `0x${(1 << bit).toString(16).padStart(2, "0").toUpperCase()}`;
}

function sortedValueCounts(values: Map<number, number>): AgentValueCount[] {
	return [...values.entries()]
		.sort((left, right) => right[1] - left[1] || left[0] - right[0])
		.map(([value, count]) => ({ value, count }));
}

function sortedMaskCounts(values: Map<number, number>): AgentMaskCount[] {
	return [...values.entries()]
		.sort((left, right) => right[1] - left[1] || left[0] - right[0])
		.map(([mask, count]) => ({ mask: bitMask(mask), count }));
}

function familyText(pair: DifferentialAlignedPair): string {
	return `${pair.baseline.signature} → ${pair.changed.signature}`;
}

type PositionStats = {
	presentCount: number;
	changedCount: number;
	baselineValues: Map<number, number>;
	changedValues: Map<number, number>;
	bitStats: Map<number, {
		support: number;
		setCount: number;
		clearCount: number;
		baselineValues: Map<number, number>;
		changedValues: Map<number, number>;
		xorMasks: Map<number, number>;
		baselineEvidence: string[];
		changedEvidence: string[];
	}>;
};

type FamilyStats = {
	sectionId: string;
	frameFamily: string;
	pairs: number;
	qualitySum: number;
	positions: Map<number, PositionStats>;
	lengths: Map<string, { baselineLength: number; changedLength: number; count: number }>;
};

function positionStats(): PositionStats {
	return {
		presentCount: 0,
		changedCount: 0,
		baselineValues: new Map(),
		changedValues: new Map(),
		bitStats: new Map()
	};
}

function increment(map: Map<number, number>, key: number): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function addBitStatistics(stats: PositionStats, baseline: number, changed: number, pair: DifferentialAlignedPair): void {
	const xor = baseline ^ changed;
	for (let bit = 0; bit < 8; bit += 1) {
		const mask = 1 << bit;
		if ((xor & mask) === 0) continue;
		const bitStats = stats.bitStats.get(bit) ?? {
			support: 0,
			setCount: 0,
			clearCount: 0,
			baselineValues: new Map<number, number>(),
			changedValues: new Map<number, number>(),
			xorMasks: new Map<number, number>(),
			baselineEvidence: [],
			changedEvidence: []
		};
		bitStats.support += 1;
		if ((baseline & mask) === 0 && (changed & mask) !== 0) bitStats.setCount += 1;
		if ((baseline & mask) !== 0 && (changed & mask) === 0) bitStats.clearCount += 1;
		increment(bitStats.baselineValues, baseline);
		increment(bitStats.changedValues, changed);
		increment(bitStats.xorMasks, xor);
		bitStats.baselineEvidence.push(pair.baseline.id);
		bitStats.changedEvidence.push(pair.changed.id);
		stats.bitStats.set(bit, bitStats);
	}
}

function boundedPositionSummaries(
	values: AgentDifferentialPositionSummary[],
	maximum: number
): { values: AgentDifferentialPositionSummary[]; truncated: boolean } {
	values.sort((left, right) => left.sectionId.localeCompare(right.sectionId)
		|| left.frameFamily.localeCompare(right.frameFamily)
		|| left.bytePosition - right.bytePosition);
	return { values: values.slice(0, maximum), truncated: values.length > maximum };
}

const MAX_DIFFERENTIAL_POSITION_SUMMARIES = 48;
const MAX_DIFFERENTIAL_LENGTH_SUMMARIES = 24;
const MAX_DIFFERENTIAL_EVIDENCE_IDS = 8;

/**
 * Aggregate only observable byte/bit correlations. The function intentionally
 * emits candidateFields: it never assigns a semantic field name or persists a
 * conclusion. Ranking is deterministic and its components are returned with
 * every candidate so a caller can audit why one candidate precedes another.
 */
export function calculateDifferentialEvidence(
	pairs: readonly DifferentialAlignedPair[],
	minimumSupport: number
): Readonly<{
	candidateFields: readonly AgentDifferentialCandidate[];
	differenceSummary: AgentDifferentialDifferenceSummary;
}> {
	const families = new Map<string, FamilyStats>();
	for (const pair of pairs) {
		const sectionId = pair.baseline.sectionId;
		const frameFamily = familyText(pair);
		const key = `${sectionId}\u0000${frameFamily}`;
		const family = families.get(key) ?? {
			sectionId,
			frameFamily,
			pairs: 0,
			qualitySum: 0,
			positions: new Map(),
			lengths: new Map()
		};
		family.pairs += 1;
		family.qualitySum += pair.quality;
		const lengthKey = `${pair.baseline.bytes.length}\u0000${pair.changed.bytes.length}`;
		const length = family.lengths.get(lengthKey) ?? { baselineLength: pair.baseline.bytes.length, changedLength: pair.changed.bytes.length, count: 0 };
		length.count += 1;
		family.lengths.set(lengthKey, length);
		const maximumLength = Math.max(pair.baseline.bytes.length, pair.changed.bytes.length);
		for (let position = 0; position < maximumLength; position += 1) {
			const baselineValue = pair.baseline.bytes[position];
			const changedValue = pair.changed.bytes[position];
			if (baselineValue === undefined || changedValue === undefined) continue;
			const stats = family.positions.get(position) ?? positionStats();
			stats.presentCount += 1;
			increment(stats.baselineValues, baselineValue);
			increment(stats.changedValues, changedValue);
			if (baselineValue !== changedValue) {
				stats.changedCount += 1;
				addBitStatistics(stats, baselineValue, changedValue, pair);
			}
			family.positions.set(position, stats);
		}
		families.set(key, family);
	}

	const familyList = [...families.values()].sort((left, right) => left.sectionId.localeCompare(right.sectionId) || left.frameFamily.localeCompare(right.frameFamily));
	const familyCountBySection = new Map<string, number>();
	for (const family of familyList) familyCountBySection.set(family.sectionId, (familyCountBySection.get(family.sectionId) ?? 0) + 1);
	const invariantPositions: AgentDifferentialPositionSummary[] = [];
	const conditionallyChangingPositions: AgentDifferentialPositionSummary[] = [];
	const alwaysChangingPositions: AgentDifferentialPositionSummary[] = [];
	const lengthChanges: AgentDifferentialLengthChange[] = [];
	const candidates: AgentDifferentialCandidate[] = [];

	for (const family of familyList) {
		for (const [position, stats] of family.positions) {
			if (stats.presentCount !== family.pairs) continue;
			const positionSummary: AgentDifferentialPositionSummary = {
				sectionId: family.sectionId,
				frameFamily: family.frameFamily,
				bytePosition: position,
				pairedFrameCount: family.pairs,
				observedFrameCount: stats.presentCount,
				changedPairCount: stats.changedCount,
				changeConsistency: family.pairs ? roundScore(stats.changedCount / family.pairs) : 0
			};
			if (stats.changedCount === 0) invariantPositions.push(positionSummary);
			else if (stats.changedCount === family.pairs) alwaysChangingPositions.push(positionSummary);
			else conditionallyChangingPositions.push(positionSummary);
		}
		for (const length of family.lengths.values()) {
			if (length.baselineLength === length.changedLength) continue;
			lengthChanges.push({
				sectionId: family.sectionId,
				frameFamily: family.frameFamily,
				baselineLength: length.baselineLength,
				changedLength: length.changedLength,
				support: length.count,
				pairedFrameCount: family.pairs
			});
		}
		for (const [position, stats] of family.positions) {
			for (const [bit, bitStats] of stats.bitStats) {
				if (bitStats.support < minimumSupport) continue;
				const changeConsistency = family.pairs ? bitStats.support / family.pairs : 0;
				const directionConsistency = bitStats.support ? Math.max(bitStats.setCount, bitStats.clearCount) / bitStats.support : 0;
				const supportFactor = Math.min(1, bitStats.support / Math.max(3, minimumSupport));
				const familySpecificity = 1 / Math.max(1, familyCountBySection.get(family.sectionId) ?? 1);
				const alignmentQuality = family.pairs ? family.qualitySum / family.pairs : 0;
				const scoreComponents = {
					supportFactor: roundScore(supportFactor),
					changeConsistency: roundScore(changeConsistency),
					directionConsistency: roundScore(directionConsistency),
					familySpecificity: roundScore(familySpecificity),
					alignmentQuality: roundScore(alignmentQuality)
				};
				const score = roundScore(scoreComponents.supportFactor
					* scoreComponents.changeConsistency
					* scoreComponents.directionConsistency
					* scoreComponents.familySpecificity
					* scoreComponents.alignmentQuality);
				candidates.push({
					sectionId: family.sectionId,
					frameFamily: family.frameFamily,
					bytePosition: position,
					bitMask: bitMask(bit),
					baselineValues: sortedValueCounts(bitStats.baselineValues),
					changedValues: sortedValueCounts(bitStats.changedValues),
					xorMasks: sortedMaskCounts(bitStats.xorMasks),
					setCount: bitStats.setCount,
					clearCount: bitStats.clearCount,
					support: bitStats.support,
					pairedFrameCount: family.pairs,
					changeConsistency: scoreComponents.changeConsistency,
					directionConsistency: scoreComponents.directionConsistency,
					score,
					scoreComponents,
					evidence: {
						baselineFrameIds: bitStats.baselineEvidence.slice(0, MAX_DIFFERENTIAL_EVIDENCE_IDS),
						changedFrameIds: bitStats.changedEvidence.slice(0, MAX_DIFFERENTIAL_EVIDENCE_IDS),
						evidenceTruncated: bitStats.support > MAX_DIFFERENTIAL_EVIDENCE_IDS
					}
				});
			}
		}
	}

	const invariant = boundedPositionSummaries(invariantPositions, MAX_DIFFERENTIAL_POSITION_SUMMARIES);
	const conditional = boundedPositionSummaries(conditionallyChangingPositions, MAX_DIFFERENTIAL_POSITION_SUMMARIES);
	const always = boundedPositionSummaries(alwaysChangingPositions, MAX_DIFFERENTIAL_POSITION_SUMMARIES);
	lengthChanges.sort((left, right) => left.sectionId.localeCompare(right.sectionId)
		|| left.frameFamily.localeCompare(right.frameFamily)
		|| left.baselineLength - right.baselineLength
		|| left.changedLength - right.changedLength);
	const boundedLengths = lengthChanges.slice(0, MAX_DIFFERENTIAL_LENGTH_SUMMARIES);
	candidates.sort((left, right) => right.score - left.score
		|| left.sectionId.localeCompare(right.sectionId)
		|| left.frameFamily.localeCompare(right.frameFamily)
		|| left.bytePosition - right.bytePosition
		|| left.bitMask.localeCompare(right.bitMask));
	return {
		candidateFields: candidates,
		differenceSummary: {
			invariantPositions: invariant.values,
			conditionallyChangingPositions: conditional.values,
			alwaysChangingPositions: always.values,
			lengthChanges: boundedLengths,
			truncated: invariant.truncated || conditional.truncated || always.truncated || lengthChanges.length > boundedLengths.length
		}
	};
}

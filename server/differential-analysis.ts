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
/**
 * Bounds the total number of JSON array elements materialized by one
 * differential request. The count includes bytes, timestamps, raw offsets,
 * and directions on both snapshots; frame count alone is not a sufficient
 * memory bound for canonical rows.
 */
export const MAX_DIFFERENTIAL_ANALYZED_ELEMENTS = 250_000;

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
	/** Persistent canonical database identity; regenerated globally for each capture/profile. */
	sectionId: string;
	/** Comparison-local structural fingerprint; never a persisted section identity. */
	sectionKey?: string;
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
	/** Baseline canonical section ID; retained as the legacy sectionId alias. */
	sectionId: string;
	baselineSectionId: string;
	changedSectionId: string;
	/** Comparison-local structural fingerprint; only meaningful with both snapshots. */
	sectionFingerprint: string;
	frameFamily: string;
	changedFrameFamily: string;
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
	/** Baseline canonical section ID; retained as the legacy sectionId alias. */
	sectionId: string;
	baselineSectionId: string;
	changedSectionId: string;
	/** Comparison-local structural fingerprint; only meaningful with both snapshots. */
	sectionFingerprint: string;
	frameFamily: string;
	bytePosition: number;
	pairedFrameCount: number;
	observedFrameCount: number;
	changedPairCount: number;
	changeConsistency: number;
}>;

export type AgentDifferentialLengthChange = Readonly<{
	/** Baseline canonical section ID; retained as the legacy sectionId alias. */
	sectionId: string;
	baselineSectionId: string;
	changedSectionId: string;
	/** Comparison-local structural fingerprint; only meaningful with both snapshots. */
	sectionFingerprint: string;
	frameFamily: string;
	changedFrameFamily: string;
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
	analyzedElementCount: number;
}>;

export type AgentDifferentialPairCompatibility = Readonly<{
	compatiblePairCount: number;
	incompatiblePairCount: number;
	sectionMismatchCount: number;
	frameFamilyMismatchCount: number;
	lengthMismatchCount: number;
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
	pairCompatibility: AgentDifferentialPairCompatibility;
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
	let minimum: number | null = null;
	for (const offset of frame.rawOffsets) {
		if (!Number.isSafeInteger(offset)) continue;
		if (minimum === null || offset < minimum) minimum = offset;
	}
	return minimum;
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

type AlignmentAction = "pair" | "delete" | "insert";

const ALIGNMENT_ACTION_PRIORITY: Readonly<Record<AlignmentAction, number>> = {
	insert: 0,
	delete: 1,
	pair: 2
};

function isBetterAlignmentCell(
	candidate: { count: number; cost: number; action: AlignmentAction },
	current: { count: number; cost: number; action: AlignmentAction }
): boolean {
	if (candidate.count !== current.count) return candidate.count > current.count;
	if (candidate.cost !== current.cost) return candidate.cost < current.cost;
	return ALIGNMENT_ACTION_PRIORITY[candidate.action] > ALIGNMENT_ACTION_PRIORITY[current.action];
}

function minimumRawStart(frames: readonly DifferentialFrame[]): number | null {
	let minimum: number | null = null;
	for (const frame of frames) {
		if (frame.rawStart === null) continue;
		if (minimum === null || frame.rawStart < minimum) minimum = frame.rawStart;
	}
	return minimum;
}

export function alignOrdinal(
	baseline: readonly DifferentialFrame[],
	changed: readonly DifferentialFrame[],
	mode: "ordinal" | "raw-relative",
	baselineRawOrigin?: number | null,
	changedRawOrigin?: number | null
): DifferentialAlignment {
	if (mode === "raw-relative") return alignRawRelative(baseline, changed, baselineRawOrigin, changedRawOrigin);
	const left = [...baseline].sort(frameOrder);
	const right = [...changed].sort(frameOrder);
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

/**
 * Match only equal retained-raw positions after normalizing each snapshot to
 * its profile's first retained raw position. This is deliberately exact: a
 * boundary shift is reported as insertion/deletion evidence instead of being
 * silently converted into an ordinal pair. Duplicate positions, if present
 * in legacy data, are paired in stable frame order and never reused.
 */
export function alignRawRelative(
	baseline: readonly DifferentialFrame[],
	changed: readonly DifferentialFrame[],
	baselineRawOrigin?: number | null,
	changedRawOrigin?: number | null
): DifferentialAlignment {
	const baselineOrigin = baselineRawOrigin ?? minimumRawStart(baseline);
	const changedOrigin = changedRawOrigin ?? minimumRawStart(changed);
	const changedByRelativeOffset = new Map<number, DifferentialFrame[]>();
	const changedWithoutOffset: DifferentialFrame[] = [];
	for (const frame of [...changed].sort(rawRelativeOrder)) {
		if (frame.rawStart === null || changedOrigin === null) {
			changedWithoutOffset.push(frame);
			continue;
		}
		const relativeOffset = frame.rawStart - changedOrigin;
		const entries = changedByRelativeOffset.get(relativeOffset) ?? [];
		entries.push(frame);
		changedByRelativeOffset.set(relativeOffset, entries);
	}

	const pairs: DifferentialAlignedPair[] = [];
	const baselineUnpaired: DifferentialFrame[] = [];
	const usedChanged = new Set<string>();
	for (const frame of [...baseline].sort(rawRelativeOrder)) {
		if (frame.rawStart === null || baselineOrigin === null) {
			baselineUnpaired.push(frame);
			continue;
		}
		const relativeOffset = frame.rawStart - baselineOrigin;
		const candidates = changedByRelativeOffset.get(relativeOffset) ?? [];
		const changedFrame = candidates.find(candidate => !usedChanged.has(candidate.id));
		if (!changedFrame) {
			baselineUnpaired.push(frame);
			continue;
		}
		usedChanged.add(changedFrame.id);
		pairs.push({
			baseline: frame,
			changed: changedFrame,
			quality: 1,
			timestampDeltaMs: frame.timestamp !== null && changedFrame.timestamp !== null
				? Math.abs(frame.timestamp - changedFrame.timestamp)
				: null
		});
	}
	const changedUnpaired = [
		...changedWithoutOffset,
		...changed.filter(frame => !usedChanged.has(frame.id) && frame.rawStart !== null && changedOrigin !== null)
	].sort(rawRelativeOrder);
	return {
		pairs: pairs.sort((left, right) => frameOrder(left.baseline, right.baseline)),
		baselineUnpaired: baselineUnpaired.sort(rawRelativeOrder),
		changedUnpaired,
		insertedFrameCount: changedUnpaired.length,
		deletedFrameCount: baselineUnpaired.length
	};
}

export function alignTimestampNearest(
	baseline: readonly DifferentialFrame[],
	changed: readonly DifferentialFrame[],
	maximumTimestampDeltaMs: number
): DifferentialAlignment {
	// For one-dimensional timestamps, an optimal absolute-distance matching has
	// a non-crossing ordering. Dynamic programming therefore gives maximum
	// cardinality first, then minimum total timestamp distance, with stable
	// action precedence for equal-score paths.
	const orderedBaseline = [...baseline].sort(timestampOrder);
	const orderedChanged = [...changed].sort(timestampOrder);
	const timestampedBaseline = orderedBaseline.filter((frame): frame is DifferentialFrame & { timestamp: number } => frame.timestamp !== null);
	const timestampedChanged = orderedChanged.filter((frame): frame is DifferentialFrame & { timestamp: number } => frame.timestamp !== null);
	const rows = timestampedBaseline.length + 1;
	const columns = timestampedChanged.length + 1;
	const counts = Array.from({ length: rows }, () => new Int32Array(columns));
	const costs = Array.from({ length: rows }, () => new Float64Array(columns));
	const actions = Array.from({ length: rows }, () => new Uint8Array(columns));
	const actionFor = (value: number): AlignmentAction => value === 1 ? "pair" : value === 2 ? "delete" : "insert";
	for (let row = 1; row < rows; row += 1) actions[row]![0] = 2;
	for (let column = 1; column < columns; column += 1) actions[0]![column] = 3;
	for (let row = 1; row < rows; row += 1) {
		for (let column = 1; column < columns; column += 1) {
			const baselineFrame = timestampedBaseline[row - 1]!;
			const changedFrame = timestampedChanged[column - 1]!;
			let best = {
				count: counts[row - 1]![column]!,
				cost: costs[row - 1]![column]!,
				action: "delete" as AlignmentAction
			};
			const insertion = {
				count: counts[row]![column - 1]!,
				cost: costs[row]![column - 1]!,
				action: "insert" as AlignmentAction
			};
			if (isBetterAlignmentCell(insertion, best)) best = insertion;
			const delta = Math.abs(baselineFrame.timestamp - changedFrame.timestamp);
			if (delta <= maximumTimestampDeltaMs) {
				const pair = {
					count: counts[row - 1]![column - 1]! + 1,
					cost: costs[row - 1]![column - 1]! + delta,
					action: "pair" as AlignmentAction
				};
				if (isBetterAlignmentCell(pair, best)) best = pair;
			}
			counts[row]![column] = best.count;
			costs[row]![column] = best.cost;
			actions[row]![column] = best.action === "pair" ? 1 : best.action === "delete" ? 2 : 3;
		}
	}
	const pairs: DifferentialAlignedPair[] = [];
	const baselineUnpaired: DifferentialFrame[] = orderedBaseline.filter(frame => frame.timestamp === null);
	const changedUnpaired: DifferentialFrame[] = orderedChanged.filter(frame => frame.timestamp === null);
	let row = timestampedBaseline.length;
	let column = timestampedChanged.length;
	while (row > 0 || column > 0) {
		const action = actionFor(actions[row]![column]!);
		if (action === "pair") {
			const baselineFrame = timestampedBaseline[row - 1]!;
			const changedFrame = timestampedChanged[column - 1]!;
			const delta = Math.abs(baselineFrame.timestamp - changedFrame.timestamp);
			pairs.push({
				baseline: baselineFrame,
				changed: changedFrame,
				quality: maximumTimestampDeltaMs === 0 ? 1 : Math.max(0, 1 - delta / maximumTimestampDeltaMs),
				timestampDeltaMs: delta
			});
			row -= 1;
			column -= 1;
		} else if (action === "delete") {
			baselineUnpaired.push(timestampedBaseline[row - 1]!);
			row -= 1;
		} else {
			changedUnpaired.push(timestampedChanged[column - 1]!);
			column -= 1;
		}
	}
	pairs.reverse();
	return {
		pairs: pairs.sort((left, right) => frameOrder(left.baseline, right.baseline)),
		baselineUnpaired: baselineUnpaired.sort(timestampOrder),
		changedUnpaired: changedUnpaired.sort(timestampOrder),
		insertedFrameCount: changedUnpaired.length,
		deletedFrameCount: baselineUnpaired.length
	};
}

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
			const deletion = scores[row - 1]![column]!;
			const insertion = scores[row]![column - 1]!;
			const compatibleSubstitution = baselineFrame.ordinal === changedFrame.ordinal
				&& sectionKey(baselineFrame) === sectionKey(changedFrame);
			// This is an exact-signature LCS, not an edit-distance substitution
			// matcher. A substitution is therefore represented explicitly as one
			// deleted baseline frame plus one inserted changed frame. That avoids
			// allowing a mismatching diagonal to hide an insertion or deletion.
			if (baselineFrame.signature === changedFrame.signature
				&& scores[row - 1]![column - 1]! + 1 >= deletion
				&& scores[row - 1]![column - 1]! + 1 >= insertion) {
				scores[row]![column] = scores[row - 1]![column - 1]! + 1;
				actions[row]![column] = "pair";
			} else if (compatibleSubstitution && scores[row - 1]![column - 1]! >= deletion && scores[row - 1]![column - 1]! >= insertion) {
				// Keep ordinally aligned replacements together so changed bytes can
				// participate in candidate analysis instead of becoming delete/insert
				// evidence only. Exact-signature matches still receive the stronger LCS
				// score above, preserving insertion/deletion behavior around anchors.
				scores[row]![column] = scores[row - 1]![column - 1]!;
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

function byteMask(mask: number): string {
	return `0x${mask.toString(16).padStart(2, "0").toUpperCase()}`;
}

function sortedValueCounts(values: Map<number, number>): AgentValueCount[] {
	return [...values.entries()]
		.sort((left, right) => right[1] - left[1] || left[0] - right[0])
		.map(([value, count]) => ({ value, count }));
}

function sortedMaskCounts(values: Map<number, number>): AgentMaskCount[] {
	return [...values.entries()]
		.sort((left, right) => right[1] - left[1] || left[0] - right[0])
		.map(([mask, count]) => ({ mask: byteMask(mask), count }));
}

function familyText(pair: DifferentialAlignedPair): string {
	// A signature is observable evidence, not a semantic field name. Keep both
	// sides in the grouping key so two unrelated changed families cannot
	// contaminate one another while a repeated controlled mutation can still
	// accumulate support.
	return pair.baseline.signature;
}

function changedFamilyText(pair: DifferentialAlignedPair): string {
	return pair.changed.signature;
}

function sectionKey(frame: DifferentialFrame): string {
	return frame.sectionKey ?? frame.sectionId;
}

export function differentialPairCompatibility(pair: DifferentialAlignedPair): {
	sectionCompatible: boolean;
	lengthCompatible: boolean;
	frameFamilyChanged: boolean;
} {
	return {
		sectionCompatible: sectionKey(pair.baseline) === sectionKey(pair.changed),
		lengthCompatible: pair.baseline.bytes.length === pair.changed.bytes.length,
		frameFamilyChanged: pair.baseline.signature !== pair.changed.signature
	};
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
	baselineSectionId: string;
	changedSectionId: string;
	sectionFingerprint: string;
	sectionKey: string;
	frameFamily: string;
	changedFrameFamily: string;
	pairs: number;
	qualitySum: number;
	positions: Map<number, PositionStats>;
};

type LengthChangeStats = {
	sectionId: string;
	baselineSectionId: string;
	changedSectionId: string;
	sectionFingerprint: string;
	frameFamily: string;
	changedFrameFamily: string;
	baselineLength: number;
	changedLength: number;
	support: number;
	pairedFrameCount: number;
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
	pairCompatibility: AgentDifferentialPairCompatibility;
}> {
	const families = new Map<string, FamilyStats>();
	const observedLengthChanges = new Map<string, LengthChangeStats>();
	let compatiblePairCount = 0;
	let incompatiblePairCount = 0;
	let sectionMismatchCount = 0;
	let frameFamilyMismatchCount = 0;
	let lengthMismatchCount = 0;
	for (const pair of pairs) {
		const compatibility = differentialPairCompatibility(pair);
		if (compatibility.frameFamilyChanged) frameFamilyMismatchCount += 1;
		if (!compatibility.sectionCompatible) sectionMismatchCount += 1;
		if (!compatibility.lengthCompatible) lengthMismatchCount += 1;
		if (!compatibility.sectionCompatible || !compatibility.lengthCompatible) {
			incompatiblePairCount += 1;
			if (compatibility.sectionCompatible) {
				const key = `${sectionKey(pair.baseline)}\u0000${pair.baseline.signature}\u0000${pair.changed.signature}\u0000${pair.baseline.bytes.length}\u0000${pair.changed.bytes.length}`;
				const existing = observedLengthChanges.get(key);
				if (existing) {
					existing.support += 1;
					existing.pairedFrameCount += 1;
				} else {
					observedLengthChanges.set(key, {
						sectionId: pair.baseline.sectionId,
						baselineSectionId: pair.baseline.sectionId,
						changedSectionId: pair.changed.sectionId,
						sectionFingerprint: sectionKey(pair.baseline),
						frameFamily: familyText(pair),
						changedFrameFamily: changedFamilyText(pair),
						baselineLength: pair.baseline.bytes.length,
						changedLength: pair.changed.bytes.length,
						support: 1,
						pairedFrameCount: 1
					});
				}
			}
			continue;
		}
		compatiblePairCount += 1;
		const sectionId = pair.baseline.sectionId;
		const frameFamily = familyText(pair);
		const changedFrameFamily = changedFamilyText(pair);
		const structuralSectionKey = sectionKey(pair.baseline);
		const key = `${structuralSectionKey}\u0000${frameFamily}\u0000${changedFrameFamily}`;
		const family = families.get(key) ?? {
			sectionId,
			baselineSectionId: pair.baseline.sectionId,
			changedSectionId: pair.changed.sectionId,
			sectionFingerprint: structuralSectionKey,
			sectionKey: structuralSectionKey,
			frameFamily,
			changedFrameFamily,
			pairs: 0,
			qualitySum: 0,
			positions: new Map()
		};
		family.pairs += 1;
		family.qualitySum += pair.quality;
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

	const familyList = [...families.values()].sort((left, right) => left.sectionId.localeCompare(right.sectionId)
		|| left.frameFamily.localeCompare(right.frameFamily)
		|| left.changedFrameFamily.localeCompare(right.changedFrameFamily));
	const familyCountBySection = new Map<string, number>();
	for (const family of familyList) familyCountBySection.set(family.sectionKey, (familyCountBySection.get(family.sectionKey) ?? 0) + 1);
	const invariantPositions: AgentDifferentialPositionSummary[] = [];
	const conditionallyChangingPositions: AgentDifferentialPositionSummary[] = [];
	const alwaysChangingPositions: AgentDifferentialPositionSummary[] = [];
	const lengthChanges: AgentDifferentialLengthChange[] = [...observedLengthChanges.values()];
	const candidates: AgentDifferentialCandidate[] = [];

	for (const family of familyList) {
		for (const [position, stats] of family.positions) {
			if (stats.presentCount !== family.pairs) continue;
			const positionSummary: AgentDifferentialPositionSummary = {
				sectionId: family.sectionId,
				baselineSectionId: family.baselineSectionId,
				changedSectionId: family.changedSectionId,
				sectionFingerprint: family.sectionFingerprint,
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
		for (const [position, stats] of family.positions) {
			for (const [bit, bitStats] of stats.bitStats) {
				if (bitStats.support < minimumSupport) continue;
				const changeConsistency = family.pairs ? bitStats.support / family.pairs : 0;
				const directionConsistency = bitStats.support ? Math.max(bitStats.setCount, bitStats.clearCount) / bitStats.support : 0;
				const supportFactor = Math.min(1, bitStats.support / Math.max(3, minimumSupport));
				const familySpecificity = 1 / Math.max(1, familyCountBySection.get(family.sectionKey) ?? 1);
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
					baselineSectionId: family.baselineSectionId,
					changedSectionId: family.changedSectionId,
					sectionFingerprint: family.sectionFingerprint,
					frameFamily: family.frameFamily,
					changedFrameFamily: family.changedFrameFamily,
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
		|| left.changedFrameFamily.localeCompare(right.changedFrameFamily)
		|| left.baselineLength - right.baselineLength
		|| left.changedLength - right.changedLength);
	const boundedLengths = lengthChanges.slice(0, MAX_DIFFERENTIAL_LENGTH_SUMMARIES);
	candidates.sort((left, right) => right.score - left.score
		|| left.sectionId.localeCompare(right.sectionId)
		|| left.frameFamily.localeCompare(right.frameFamily)
		|| left.changedFrameFamily.localeCompare(right.changedFrameFamily)
		|| left.bytePosition - right.bytePosition
		|| left.bitMask.localeCompare(right.bitMask));
	return {
		candidateFields: candidates,
		pairCompatibility: {
			compatiblePairCount,
			incompatiblePairCount,
			sectionMismatchCount,
			frameFamilyMismatchCount,
			lengthMismatchCount
		},
		differenceSummary: {
			invariantPositions: invariant.values,
			conditionallyChangingPositions: conditional.values,
			alwaysChangingPositions: always.values,
			lengthChanges: boundedLengths,
			truncated: invariant.truncated || conditional.truncated || always.truncated || lengthChanges.length > boundedLengths.length
		}
	};
}

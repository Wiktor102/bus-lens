import { Buffer } from "node:buffer";
import type { SqliteDatabase } from "./database.ts";
import {
	AGENT_NORMAL_RESPONSE_BYTES,
	AgentQueryError,
	assertCursorFilters,
	assertEncodedResponseSize,
	boundedLimit,
	decodeAgentCursor,
	encodeAgentCursor,
	makeAgentResponse,
	stableJson,
	type AgentCursorPayload,
	type AgentPageTruncationReason,
	type AgentResponse,
	type AgentSnapshotReference
} from "./agent-contracts.ts";
import {
	AGENT_DIFFERENTIAL_ALIGNMENT_MODES,
	MAX_DIFFERENTIAL_ANALYZED_ELEMENTS,
	MAX_DIFFERENTIAL_FRAMES,
	MAX_SIGNATURE_ALIGNMENT_FRAMES,
	alignRawRelative,
	alignOrdinal,
	alignSignatureSequence,
	alignTimestampNearest,
	calculateDifferentialEvidence,
	differentialFramePredicate,
	makeDifferentialFrame,
	normalizeDifferentialMessageFilters,
	normalizeDifferentialScope,
	type AgentCaptureDifferenceInput,
	type AgentCaptureDifferenceResult,
	type AgentDifferentialAlignmentMode,
	type DifferentialAlignedPair,
	type DifferentialFrame,
	type NormalizedDifferentialMessageFilters,
	type NormalizedDifferentialScope
} from "./differential-analysis.ts";

export type {
	AgentCaptureDifferenceInput,
	AgentCaptureDifferenceResult,
	AgentDifferentialAlignmentMode,
	AgentDifferentialAlignmentSummary,
	AgentDifferentialCandidate,
	AgentDifferentialDifferenceSummary,
	AgentDifferentialLengthChange,
	AgentDifferentialMessageFilters,
	AgentDifferentialPositionSummary,
	AgentDifferentialScope,
	AgentDifferentialSnapshotSummary,
	AgentDifferentialEvidence,
	AgentDifferentialPairCompatibility,
	AgentDifferentialScoreComponents,
	AgentMaskCount,
	AgentValueCount
} from "./differential-analysis.ts";

export const DEFAULT_FRAME_WINDOW_LIMIT = 50;
export const MAX_FRAME_WINDOW_LIMIT = 200;
export const DEFAULT_CAPTURE_DISCOVERY_LIMIT = 20;
export const MAX_CAPTURE_DISCOVERY_LIMIT = 100;
export const MAX_CONTEXT_PARAMETER_FILTERS = 64;
const MAX_BYTE_STATISTICS_COMPARISON_POSITIONS = 1;
const MAX_TRANSITION_CHANGED_POSITION_SET = 128;

export type CanonicalCaptureStatus = "canonical" | "legacy-not-canonicalized" | "converting" | "canonicalization-failed";

export type CanonicalCaptureSummary = {
	id: string;
	status: CanonicalCaptureStatus;
	name: string;
	lifecycle: string | null;
	byteCount: number | null;
	createdAt: string;
	updatedAt: string;
	folderId: string | null;
};

export type CanonicalCaptureOverview = CanonicalCaptureSummary & {
	rawByteCount: number | null;
	frameCount: number | null;
	activeProfile: { id: string; version: number; algorithmVersion: number } | null;
};

export type CanonicalFrame = {
	id: string;
	ordinal: number;
	sectionId: string;
	rawOffsets: number[];
	bytes: number[];
	timestamps: number[];
	directions: string[];
	hidden: boolean;
	signature: string;
};

export type CanonicalFrameWindow = {
	capture: CanonicalCaptureSummary;
	status: CanonicalCaptureStatus;
	offset: number;
	limit: number;
	totalFrames: number | null;
	hasMore: boolean;
	frames: CanonicalFrame[];
};

export type CaptureDiscoveryFiltersInput = Readonly<{
	nameSearch?: string;
	name?: string;
	folderId?: string | null;
	controllerView?: string;
	view?: string;
	contextParameters?: Readonly<Record<string, string>> | readonly Readonly<{ key: string; value: string }>[];
	parameters?: Readonly<Record<string, string>> | readonly Readonly<{ key: string; value: string }>[];
	createdFrom?: string;
	createdTo?: string;
	lifecycle?: string;
	storageStatus?: CanonicalCaptureStatus | readonly CanonicalCaptureStatus[];
	storage?: CanonicalCaptureStatus | readonly CanonicalCaptureStatus[];
	cursor?: string;
	limit?: number;
}>;

export type NormalizedCaptureDiscoveryFilters = Readonly<{
	nameSearch: string;
	folderId: string | null | undefined;
	controllerView: string | undefined;
	contextParameters: readonly Readonly<{ key: string; value: string }>[];
	createdFrom: string | undefined;
	createdTo: string | undefined;
	lifecycle: string | undefined;
	storageStatus: readonly CanonicalCaptureStatus[];
}>;

export type AgentCaptureSummary = Readonly<{
	id: string;
	status: CanonicalCaptureStatus;
	name: string;
	description: string;
	controllerView: string;
	parameters: readonly Readonly<{ key: string; value: string }>[];
	parametersTruncated?: boolean;
	folderId: string | null;
	lifecycle: string | null;
	byteCount: number | null;
	frameCount: number | null;
	createdAt: string;
	updatedAt: string;
	dataRevision: number | null;
	metadataRevision: number | null;
	contentRevision: number | null;
	retainedStartOffset: number | null;
	activeProfile: Readonly<{
		id: string;
		version: number;
		algorithmVersion: number;
		sourceDataRevision: number;
		retainedStartOffset: number;
		verified: boolean;
		isActive: boolean;
	}> | null;
	conversionGuidance?: string;
}>;

export type AgentCaptureDiscovery = Readonly<{
	captures: readonly AgentCaptureSummary[];
}>;

export type AgentFramingSection = Readonly<{
	id: string;
	position: number;
	startOffset: number;
	framingMode: string;
	frameLength: number | null;
	marker: string | null;
	markerPosition: string | null;
	timeGapMs: number | null;
	collapseRuns: boolean;
	collapsed: boolean;
}>;

export type AgentNoteSummary = Readonly<{
	id: string;
	targetKind: string;
	textPreview: string;
	createdAt: string;
	profileId: string | null;
	rawOffset: number | null;
	startOffset: number | null;
	endOffset: number | null;
	sequenceGroupId: string | null;
	authorType: "human" | "agent";
	reportedClientName?: string;
	reportedClientVersion?: string;
	protocolVersion?: string;
}>;

export type AgentSequenceSummary = Readonly<{
	id: string;
	signatures: readonly string[];
	length: number;
	occurrenceCount: number;
	sections: readonly string[];
	cadenceMs: number | null;
	remark: string | null;
	firstOccurrence: Readonly<{ occurrenceNumber: number; startOrdinal: number; timestamp: number | null }> | null;
	lastOccurrence: Readonly<{ occurrenceNumber: number; startOrdinal: number; timestamp: number | null }> | null;
}>;

export type AgentCaptureOverview = Readonly<{
	capture: AgentCaptureSummary;
	snapshot: AgentSnapshotReference | null;
	sections: readonly AgentFramingSection[];
	counts: Readonly<{
		rawBytes: number | null;
		framedBytes: number | null;
		frames: number | null;
		visibleFrames: number | null;
	}>;
	notes: readonly AgentNoteSummary[];
	topSignatures: readonly Readonly<{ signature: string; count: number }>[];
	topTransitions: readonly Readonly<{ fromSignature: string; toSignature: string; count: number; changedPositions: number }>[];
	bytePositions: readonly Readonly<{ position: number; applicableFrameCount: number; vocabularySize: number; variance: string | null }>[];
	sequenceGroups: readonly AgentSequenceSummary[];
	availableBounds: Readonly<{
		raw: Readonly<{ startOffset: number | null; endOffset: number | null }>;
		frames: Readonly<{ startOrdinal: number | null; endOrdinal: number | null }>;
	}>;
	conversionGuidance?: string;
}>;

export type AgentMessageQueryInput = Readonly<{
	captureId: string;
	profileId?: string;
	profileVersion?: number;
	sourceDataRevision?: number;
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
	cursor?: string;
	limit?: number;
}>;

export type AgentMessage = Readonly<{
	frameId: string;
	ordinal: number;
	timestamp: number | null;
	deltaMs: number | null;
	sectionId: string;
	hex: string;
	rawSpan: Readonly<{ startOffset: number | null; endOffset: number | null }>;
	direction: string;
	hidden: boolean;
	sequenceMembership: readonly Readonly<{ groupId: string; occurrenceNumber: number; offset: number }>[];
	noteReferences: readonly string[];
}>;

export type AgentMessageQueryResult = Readonly<{
	messages: readonly AgentMessage[];
}>;

export type AgentMessageContextInput = Readonly<{
	frameId: string;
	captureId?: string;
	profileId?: string;
	profileVersion?: number;
	sourceDataRevision?: number;
	rowsBefore?: number;
	rowsAfter?: number;
}>;

export type AgentMessageContext = Readonly<{
	centerFrameId: string;
	rowsBefore: number;
	rowsAfter: number;
	messages: readonly AgentMessage[];
}>;

export type AgentSequenceGroupsInput = Readonly<{
	captureId: string;
	profileId?: string;
	profileVersion?: number;
	sourceDataRevision?: number;
	cursor?: string;
	limit?: number;
}>;

export type AgentSequenceGroupsResult = Readonly<{
	groups: readonly AgentSequenceSummary[];
}>;

export type AgentSequenceOccurrencesInput = Readonly<{
	captureId?: string;
	groupId: string;
	profileId?: string;
	profileVersion?: number;
	sourceDataRevision?: number;
	cursor?: string;
	limit?: number;
	includeContext?: boolean;
	contextBefore?: number;
	contextAfter?: number;
}>;

export type AgentSequenceOccurrence = Readonly<{
	occurrenceNumber: number;
	startingOrdinal: number;
	rawSpan: Readonly<{ startOffset: number; endOffset: number }>;
	timestamp: number | null;
	context?: readonly AgentMessage[];
}>;

export type AgentSequenceOccurrencesResult = Readonly<{
	groupId: string;
	occurrences: readonly AgentSequenceOccurrence[];
}>;

export type AgentByteStatisticsInput = Readonly<{
	captureId: string;
	profileId?: string;
	profileVersion?: number;
	sourceDataRevision?: number;
	positions: readonly number[];
	scope?: AgentByteStatisticsScope;
}>;

export type AgentByteStatisticsScope = Readonly<{
	sectionId?: string;
	frameLength?: number;
	exactSignature?: string;
	wildcardHexPattern?: string;
	direction?: string;
}>;

export type AgentByteStatistics = Readonly<{
	position: number;
	vocabulary: readonly Readonly<{ value: number; count: number }>[];
	bitOnePercentages: readonly Readonly<{ bit: number; percentage: number }>[];
	variance: string | null;
	applicableFrameCount: number;
}>;

export type AgentByteStatisticsResult = Readonly<{
	scope: AgentByteStatisticsScope;
	matchedFrameCount: number;
	positions: readonly AgentByteStatistics[];
}>;

export type AgentTransitionsInput = Readonly<{
	captureId: string;
	profileId?: string;
	profileVersion?: number;
	sourceDataRevision?: number;
	sourceSignature?: string;
	fromSignature?: string;
	destinationSignature?: string;
	toSignature?: string;
	sectionId?: string;
	changedPositions?: readonly number[];
	changedPositionMatch?: "all" | "any";
	minimumCount?: number;
	cursor?: string;
	limit?: number;
}>;

export type AgentTransitionPositionCount = Readonly<{
	position: number;
	changedCount: number;
}>;

export type AgentTransitionPercentage = Readonly<{
	position: number;
	percentage: number;
}>;

export type AgentTransition = Readonly<{
	fromSignature: string;
	toSignature: string;
	count: number;
	transitionCount: number;
	requestedPositions: readonly number[];
	changedPositionCounts: readonly AgentTransitionPositionCount[];
	changedPercentages: readonly AgentTransitionPercentage[];
	changedPositions: readonly number[];
	changedPositionCount: number;
	changedPositionSetTruncated?: boolean;
	sectionId?: string;
}>;

export type AgentTransitionsResult = Readonly<{
	transitions: readonly AgentTransition[];
}>;

export type AgentRawReadInput = Readonly<{
	captureId: string;
	rawOffset?: number;
	offset?: number;
	length?: number;
	byteCount?: number;
	hiddenPolicy?: "mask" | "include" | "omit";
}>;

export type AgentRawRead = Readonly<{
	requestedBounds: Readonly<{ startOffset: number; endOffset: number }>;
	availableBounds: Readonly<{ startOffset: number | null; endOffset: number | null }>;
	returnedByteCount: number;
	exposedByteCount: number;
	hex: string;
	timestamps: Readonly<{ base: number | null; deltas: readonly (number | null)[] }>;
	directions: readonly Readonly<{ value: string; count: number }>[];
	visibility: readonly Readonly<{ hidden: boolean; count: number }>[];
	truncated: boolean;
}>;

export const AGENT_COMPARISON_CATEGORIES = ["metadata", "sections", "signatures", "transitions", "byte-statistics", "sequence-groups"] as const;
export type AgentComparisonCategory = typeof AGENT_COMPARISON_CATEGORIES[number];

export type AgentComparisonSnapshot = AgentSnapshotReference;

export type AgentOperationTemplate = Readonly<{
	tool: string;
	reason: string;
	fixedArguments: Record<string, unknown>;
	argumentBindings: Record<string, string>;
}>;

export type AgentCompareCapturesInput = Readonly<{
	left: AgentComparisonSnapshot;
	right: AgentComparisonSnapshot;
	categories?: readonly AgentComparisonCategory[];
	limits?: Readonly<Partial<Record<AgentComparisonCategory, number>>>;
	cursors?: Readonly<Partial<Record<AgentComparisonCategory, string>>>;
}>;

export type AgentComparisonPage<T> = Readonly<{
	items: readonly T[];
	returned: number;
	nextCursor?: string;
	truncated: boolean;
	operationTemplates: readonly AgentOperationTemplate[];
}>;

export type AgentComparisonDifference = Readonly<{
	field: string;
	left: unknown;
	right: unknown;
}>;

export type AgentSignatureDelta = Readonly<{
	signature: string;
	leftCount: number;
	rightCount: number;
	delta: number;
}>;

export type AgentTransitionDelta = Readonly<{
	fromSignature: string;
	toSignature: string;
	leftCount: number;
	rightCount: number;
	delta: number;
	leftChangedPositions: number;
	rightChangedPositions: number;
}>;

export type AgentBytePositionDelta = Readonly<{
	position: number;
	leftVocabulary: readonly Readonly<{ value: number; count: number }>[];
	rightVocabulary: readonly Readonly<{ value: number; count: number }>[];
	vocabularyChanges: readonly Readonly<{ value: number; leftCount: number; rightCount: number; delta: number }>[];
	leftVariance: string | null;
	rightVariance: string | null;
	leftBitOnePercentages: readonly Readonly<{ bit: number; percentage: number }>[];
	rightBitOnePercentages: readonly Readonly<{ bit: number; percentage: number }>[];
	}>;

export type AgentSequenceGroupDelta = Readonly<{
	key: string;
	leftGroupId: string | null;
	rightGroupId: string | null;
	leftOccurrenceCount: number;
	rightOccurrenceCount: number;
	leftLength: number | null;
	rightLength: number | null;
	delta: number;
}>;

export type AgentComparisonResult = Readonly<{
	left: AgentComparisonSnapshot;
	right: AgentComparisonSnapshot;
	categories: Readonly<Partial<Record<AgentComparisonCategory, AgentComparisonPage<unknown> | Readonly<{ differences: readonly AgentComparisonDifference[] }>>>>;
}>;

type CanonicalSummaryRow = {
	id: string;
	name: string;
	lifecycle: string;
	byte_count: number;
	created_at: string;
	updated_at: string;
	folder_id: string | null;
};

type LegacySummaryRow = {
	id: string;
	name: unknown;
	lifecycle: unknown;
	byte_count: unknown;
	folder_id: unknown;
	created_at: string;
	updated_at: string;
	status: "legacy-not-canonicalized" | "converting" | "canonicalization-failed";
};

type FrameRow = {
	id: string;
	ordinal: number;
	section_id: string;
	raw_offsets_json: string;
	bytes_json: string;
	timestamps_json: string;
	directions_json: string;
	hidden: number;
	signature: string;
};

type DiscoveryRow = {
	id: string;
	name: unknown;
	description: unknown;
	controller_view: unknown;
	lifecycle: unknown;
	byte_count: unknown;
	created_at: string;
	updated_at: string;
	folder_id: unknown;
	status: CanonicalCaptureStatus;
	data_revision: unknown;
	metadata_revision: unknown;
	content_revision: unknown;
	retained_start_offset: unknown;
	profile_id: string | null;
	profile_version: number | null;
	algorithm_version: number | null;
	profile_source_data_revision: number | null;
	profile_retained_start_offset: number | null;
	profile_verified: number | null;
	profile_is_active: number | null;
	frame_count: number | null;
	raw_start_offset: number | null;
	raw_end_offset: number | null;
	frame_start_ordinal: number | null;
	frame_end_ordinal: number | null;
};

type ProfileRow = {
	id: string;
	capture_id: string;
	version: number;
	algorithm_version: number;
	is_active: number;
	source_data_revision: number | null;
	retained_start_offset: number | null;
	verified: number;
};

type AnalysisFrameRow = FrameRow & {
	capture_id: string;
	profile_id: string;
};

type WildcardToken = number | null;

type NormalizedMessageFilters = Readonly<{
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
	wildcardTokens?: readonly WildcardToken[];
	hidden: "include" | "visible-only" | "hidden-only";
	notePresence: "any" | "with-note" | "without-note";
	sequenceGroupId?: string;
}>;

type NormalizedByteStatisticsScope = Readonly<{
	scope: AgentByteStatisticsScope;
	wildcardTokens?: readonly WildcardToken[];
}>;

type SequenceGroupRow = {
	id: string;
	key_text: string;
	signatures_json: string;
	length: number;
	occurrence_count: number;
	first_ordinal: number | null;
	last_ordinal: number | null;
};

type SequenceOccurrenceRow = {
	occurrence_number: number;
	starting_ordinal: number;
	start_raw_offset: number;
	end_raw_offset: number;
};

type RawChunkRow = {
	start_offset: number;
	byte_count: number;
	bytes: Buffer;
	timestamps_json: string;
	directions_json: string;
	hidden_json: string;
};

type DifferentialSectionRow = {
	id: string;
	position: number;
	start_offset: number;
	framing_mode: string;
	frame_length: number | null;
	marker_bytes: string | null;
	marker_position: string | null;
	time_gap_ms: number | null;
	collapse_runs: number;
	collapsed: number;
};

type DifferentialFramePlan = Readonly<{
	profileId: string;
	parameterPrefix: string;
	predicates: string;
	predicateParameters: Readonly<Record<string, unknown>>;
	totalFrameCount: number;
	filteredFrameCount: number;
	analyzedElementCount: number;
	excludedFrameCount: number;
	rawOrigin: number | null;
	sectionKeys: ReadonlyMap<string, string>;
}>;

function differentialSectionKey(section: DifferentialSectionRow, rawOrigin: number | null): string {
	return JSON.stringify({
		position: section.position,
		startOffset: section.start_offset - (rawOrigin ?? 0),
		framingMode: section.framing_mode,
		frameLength: section.frame_length,
		markerBytes: section.marker_bytes,
		markerPosition: section.marker_position,
		timeGapMs: section.time_gap_ms,
		collapseRuns: Boolean(section.collapse_runs),
		collapsed: Boolean(section.collapsed)
	});
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function stringValue(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function nonNegativeInteger(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function jsonArray<T>(value: string): T[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed as T[] : [];
	} catch {
		return [];
	}
}

function canonicalSummary(row: CanonicalSummaryRow): CanonicalCaptureSummary {
	return {
		id: row.id,
		status: "canonical",
		name: row.name,
		lifecycle: row.lifecycle,
		byteCount: row.byte_count,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		folderId: row.folder_id
	};
}

function legacySummary(row: LegacySummaryRow): CanonicalCaptureSummary {
	return {
		id: row.id,
		status: row.status,
		name: optionalString(row.name) ?? "Untitled capture",
		lifecycle: optionalString(row.lifecycle),
		byteCount: nonNegativeInteger(row.byte_count),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		folderId: optionalString(row.folder_id)
	};
}

function normalizeParameterFilters(
	value: CaptureDiscoveryFiltersInput["contextParameters"]
): readonly Readonly<{ key: string; value: string }>[] {
	if (!value) return [];
	const entries = Array.isArray(value)
		? value.map(item => ({ key: String(item.key ?? "").trim(), value: String(item.value ?? "") }))
		: Object.entries(value).map(([key, item]) => ({ key: key.trim(), value: String(item) }));
	const uniqueEntries = [...new Map(entries.filter(item => item.key.length > 0).map(item => [JSON.stringify([item.key, item.value]), item] as const)).values()];
	if (uniqueEntries.length > MAX_CONTEXT_PARAMETER_FILTERS) {
		throw new AgentQueryError(
			"invalid-input",
			`contextParameters must contain no more than ${MAX_CONTEXT_PARAMETER_FILTERS} unique entries`,
			{ label: "contextParameters", maximum: MAX_CONTEXT_PARAMETER_FILTERS, received: uniqueEntries.length }
		);
	}
	return uniqueEntries.sort((left, right) => left.key.localeCompare(right.key) || left.value.localeCompare(right.value));
}

function normalizeStatusFilters(value: CaptureDiscoveryFiltersInput["storageStatus"]): readonly CanonicalCaptureStatus[] {
	if (!value) return [];
	const values = Array.isArray(value) ? value : [value];
	return [...new Set(values.map(String))] as CanonicalCaptureStatus[];
}

export function normalizeCaptureDiscoveryFilters(input: CaptureDiscoveryFiltersInput = {}): NormalizedCaptureDiscoveryFilters {
	const nameSearch = String(input.nameSearch ?? input.name ?? "").trim().toLocaleLowerCase();
	const controllerViewValue = input.controllerView ?? input.view;
	const controllerView = controllerViewValue === undefined ? undefined : String(controllerViewValue).trim();
	const createdFrom = input.createdFrom === undefined ? undefined : String(input.createdFrom).trim();
	const createdTo = input.createdTo === undefined ? undefined : String(input.createdTo).trim();
	const lifecycle = input.lifecycle === undefined ? undefined : String(input.lifecycle).trim();
	if (createdFrom && createdTo && createdFrom > createdTo) {
		throw new AgentQueryError("invalid-input", "createdFrom must be before createdTo", { createdFrom, createdTo });
	}
	return {
		nameSearch,
		folderId: input.folderId === undefined ? undefined : input.folderId === null ? null : String(input.folderId),
		controllerView: controllerView || undefined,
		contextParameters: normalizeParameterFilters(input.contextParameters ?? input.parameters),
		createdFrom: createdFrom || undefined,
		createdTo: createdTo || undefined,
		lifecycle: lifecycle || undefined,
		storageStatus: normalizeStatusFilters(input.storageStatus ?? input.storage)
	};
}

function paramsObject(filters: NormalizedCaptureDiscoveryFilters): Record<string, unknown> {
	return {
		nameSearch: filters.nameSearch,
		folderId: filters.folderId,
		controllerView: filters.controllerView,
		contextParameters: filters.contextParameters,
		createdFrom: filters.createdFrom,
		createdTo: filters.createdTo,
		lifecycle: filters.lifecycle,
		storageStatus: filters.storageStatus
	};
}

function capturePredicate(alias: string, filters: NormalizedCaptureDiscoveryFilters, canonical: boolean): { sql: string; params: Record<string, unknown> } {
	const clauses: string[] = [];
	const params: Record<string, unknown> = {};
	const nameExpression = canonical
		? `${alias}.name`
		: `COALESCE(CAST(json_extract(${alias}.document_json, '$.name') AS TEXT), '')`;
	const folderExpression = canonical ? `${alias}.folder_id` : `json_extract(${alias}.document_json, '$.folderId')`;
	const viewExpression = canonical ? `${alias}.controller_view` : `json_extract(${alias}.document_json, '$.view')`;
	if (filters.nameSearch) {
		clauses.push(`LOWER(COALESCE(${nameExpression}, '')) LIKE @nameSearch`);
		params.nameSearch = `%${filters.nameSearch}%`;
	}
	if (filters.folderId !== undefined) {
		clauses.push(filters.folderId === null ? `${folderExpression} IS NULL` : `${folderExpression} = @folderId`);
		if (filters.folderId !== null) params.folderId = filters.folderId;
	}
	if (filters.controllerView) {
		clauses.push(`${viewExpression} = @controllerView`);
		params.controllerView = filters.controllerView;
	}
	if (filters.createdFrom) {
		clauses.push(`${alias}.created_at >= @createdFrom`);
		params.createdFrom = filters.createdFrom;
	}
	if (filters.createdTo) {
		clauses.push(`${alias}.created_at <= @createdTo`);
		params.createdTo = filters.createdTo;
	}
	if (filters.lifecycle) {
		const lifecycleExpression = canonical ? `${alias}.lifecycle` : `json_extract(${alias}.document_json, '$.lifecycle')`;
		clauses.push(`${lifecycleExpression} = @lifecycle`);
		params.lifecycle = filters.lifecycle;
	}
	filters.contextParameters.forEach((parameter, index) => {
		const key = `parameterKey${index}`;
		const value = `parameterValue${index}`;
		if (canonical) {
			clauses.push(`EXISTS (SELECT 1 FROM capture_parameters cp${index}
				WHERE cp${index}.capture_id = ${alias}.id
				  AND cp${index}.key_text = @${key}
				  AND cp${index}.value_text = @${value})`);
		} else {
			clauses.push(`EXISTS (SELECT 1 FROM json_each(${alias}.document_json, '$.params') parameter${index}
				WHERE json_extract(parameter${index}.value, '$.key') = @${key}
				  AND CAST(json_extract(parameter${index}.value, '$.value') AS TEXT) = @${value})`);
		}
		params[key] = parameter.key;
		params[value] = parameter.value;
	});
	return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

function markerText(value: string | null): string | null {
	if (!value) return null;
	const bytes = jsonArray<number>(value);
	return bytes.length ? bytes.map(byte => Number(byte).toString(16).padStart(2, "0").toUpperCase()).join(" ") : null;
}

function previewText(text: string, max = 240): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new AgentQueryError("invalid-input", `${label} must be a finite number`, { label });
	}
	return value;
}

function normalizedSignature(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	const text = requiredText(value, label).toUpperCase().replace(/\s+/g, " ");
	return text;
}

function normalizedChangedPositions(value: readonly number[] | undefined): number[] {
	const positions = value?.map((position, index) => optionalNonNegativeInteger(position, `changedPositions[${index}]`)) ?? [];
	if (positions.length > 32) throw new AgentQueryError("invalid-input", "At most 32 changed positions may be requested", { maximum: 32 });
	return [...new Set(positions.filter((position): position is number => position !== undefined))].sort((left, right) => left - right);
}

function normalizedChangedPositionMatch(value: unknown): "all" | "any" {
	if (value === undefined || value === "all") return "all";
	if (value === "any") return "any";
	throw new AgentQueryError("invalid-input", "changedPositionMatch must be all or any", { value });
}

function parseWildcardPattern(value: unknown): { pattern: string; tokens: readonly WildcardToken[] } | undefined {
	if (value === undefined) return undefined;
	const pattern = requiredText(value, "wildcardHexPattern");
	const rawTokens = pattern.split(/[\s,:-]+/).filter(Boolean);
	if (!rawTokens.length) throw new AgentQueryError("invalid-input", "wildcardHexPattern must contain hexadecimal bytes", { pattern });
	const tokens = rawTokens.map(token => {
		if (token === "??") return null;
		if (!/^[0-9a-f]{2}$/i.test(token)) {
			throw new AgentQueryError("invalid-input", "wildcardHexPattern must use two-digit hexadecimal bytes or ??", { pattern, token });
		}
		return Number.parseInt(token, 16);
	});
	return { pattern: rawTokens.map(token => token.toUpperCase()).join(" "), tokens };
}

function assertWildcardPatternIsBounded(
	wildcard: { pattern: string; tokens: readonly WildcardToken[] } | undefined,
	boundedByRange: boolean
): void {
	if (wildcard && wildcard.tokens[0] === null && !boundedByRange) {
		throw new AgentQueryError("wildcard-too-broad", "A wildcard must begin with a literal byte or include both bounds of an ordinal or timestamp range", { pattern: wildcard.pattern });
	}
}

function normalizeMessageFilters(input: AgentMessageQueryInput): NormalizedMessageFilters {
	const ordinalFrom = optionalNonNegativeInteger(input.ordinalFrom ?? input.frameOrdinalFrom, "ordinalFrom");
	const ordinalTo = optionalNonNegativeInteger(input.ordinalTo ?? input.frameOrdinalTo, "ordinalTo");
	const requestedRawOffsetFrom = optionalNonNegativeInteger(input.rawOffsetFrom, "rawOffsetFrom");
	const requestedRawOffsetTo = optionalNonNegativeInteger(input.rawOffsetTo, "rawOffsetTo");
	const rawOffsetFrom = requestedRawOffsetFrom ?? requestedRawOffsetTo;
	const rawOffsetTo = requestedRawOffsetTo ?? requestedRawOffsetFrom;
	const timestampFrom = optionalFiniteNumber(input.timestampFrom, "timestampFrom");
	const timestampTo = optionalFiniteNumber(input.timestampTo, "timestampTo");
	if (ordinalFrom !== undefined && ordinalTo !== undefined && ordinalFrom > ordinalTo) {
		throw new AgentQueryError("invalid-input", "ordinalFrom must not exceed ordinalTo", { ordinalFrom, ordinalTo });
	}
	if (rawOffsetFrom !== undefined && rawOffsetTo !== undefined && rawOffsetFrom > rawOffsetTo) {
		throw new AgentQueryError("invalid-input", "rawOffsetFrom must not exceed rawOffsetTo", { rawOffsetFrom, rawOffsetTo });
	}
	if (timestampFrom !== undefined && timestampTo !== undefined && timestampFrom > timestampTo) {
		throw new AgentQueryError("invalid-input", "timestampFrom must not exceed timestampTo", { timestampFrom, timestampTo });
	}
	const wildcard = parseWildcardPattern(input.wildcardHexPattern);
	assertWildcardPatternIsBounded(wildcard, ordinalFrom !== undefined && ordinalTo !== undefined || timestampFrom !== undefined && timestampTo !== undefined);
	const hidden = input.hidden ?? "include";
	const notePresence = input.notePresence ?? "any";
	return {
		...(ordinalFrom === undefined ? {} : { ordinalFrom }),
		...(ordinalTo === undefined ? {} : { ordinalTo }),
		...(rawOffsetFrom === undefined ? {} : { rawOffsetFrom }),
		...(rawOffsetTo === undefined ? {} : { rawOffsetTo }),
		...(timestampFrom === undefined ? {} : { timestampFrom }),
		...(timestampTo === undefined ? {} : { timestampTo }),
		...(input.sectionId ? { sectionId: requiredText(input.sectionId, "sectionId") } : {}),
		...(input.direction ? { direction: requiredText(input.direction, "direction").toLowerCase() } : {}),
		...(normalizedSignature(input.exactSignature ?? input.signature, "exactSignature") ? { exactSignature: normalizedSignature(input.exactSignature ?? input.signature, "exactSignature") } : {}),
		...(wildcard ? { wildcardHexPattern: wildcard.pattern, wildcardTokens: wildcard.tokens } : {}),
		hidden,
		notePresence,
		...(input.sequenceGroupId ? { sequenceGroupId: requiredText(input.sequenceGroupId, "sequenceGroupId") } : {})
	};
}

function normalizeByteStatisticsScope(input: AgentByteStatisticsInput["scope"]): NormalizedByteStatisticsScope {
	if (input === undefined) return { scope: {} };
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new AgentQueryError("invalid-input", "scope must be an object with at least one filter");
	}
	const sectionId = input.sectionId === undefined ? undefined : requiredText(input.sectionId, "sectionId");
	const frameLength = input.frameLength === undefined ? undefined : optionalNonNegativeInteger(input.frameLength, "frameLength");
	if (frameLength === 0) throw new AgentQueryError("invalid-input", "frameLength must be a positive integer", { label: "frameLength" });
	const exactSignature = input.exactSignature === undefined ? undefined : normalizedSignature(input.exactSignature, "exactSignature");
	const wildcard = parseWildcardPattern(input.wildcardHexPattern);
	assertWildcardPatternIsBounded(wildcard, false);
	const direction = input.direction === undefined ? undefined : requiredText(input.direction, "direction").toLowerCase();
	const scope: AgentByteStatisticsScope = {
		...(sectionId === undefined ? {} : { sectionId }),
		...(frameLength === undefined ? {} : { frameLength }),
		...(exactSignature === undefined ? {} : { exactSignature }),
		...(wildcard === undefined ? {} : { wildcardHexPattern: wildcard.pattern }),
		...(direction === undefined ? {} : { direction })
	};
	if (!Object.keys(scope).length) throw new AgentQueryError("invalid-input", "scope must contain at least one filter");
	return { scope, ...(wildcard ? { wildcardTokens: wildcard.tokens } : {}) };
}

function byteStatisticsFramePredicate(
	normalizedScope: NormalizedByteStatisticsScope,
	alias = "frames"
): { sql: string; params: Record<string, unknown> } {
	const clauses: string[] = [];
	const params: Record<string, unknown> = {};
	const scope = normalizedScope.scope;
	if (scope.sectionId !== undefined) {
		clauses.push(`${alias}.section_id = @scopeSectionId`);
		params.scopeSectionId = scope.sectionId;
	}
	if (scope.frameLength !== undefined) {
		clauses.push(`json_array_length(${alias}.bytes_json) = @scopeFrameLength`);
		params.scopeFrameLength = scope.frameLength;
	}
	if (scope.exactSignature !== undefined) {
		clauses.push(`${alias}.signature = @scopeExactSignature`);
		params.scopeExactSignature = scope.exactSignature;
	}
	if (scope.direction !== undefined) {
		clauses.push(`EXISTS (SELECT 1 FROM json_each(${alias}.directions_json) direction_values WHERE LOWER(CAST(direction_values.value AS TEXT)) = @scopeDirection)`);
		params.scopeDirection = scope.direction;
	}
	if (normalizedScope.wildcardTokens) {
		clauses.push(`json_array_length(${alias}.bytes_json) >= @scopeWildcardLength`);
		params.scopeWildcardLength = normalizedScope.wildcardTokens.length;
		normalizedScope.wildcardTokens.forEach((token, index) => {
			if (token === null) return;
			clauses.push(`CAST(json_extract(${alias}.bytes_json, '$[${index}]') AS INTEGER) = @scopeWildcard${index}`);
			params[`scopeWildcard${index}`] = token;
		});
	}
	return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

function timestampFromFrame(row: Pick<FrameRow, "timestamps_json">): number | null {
	const timestamp = jsonArray<number>(row.timestamps_json).find(value => typeof value === "number" && Number.isFinite(value));
	return timestamp ?? null;
}

function compactHex(bytes: readonly number[]): string {
	return bytes.map(byte => Number(byte).toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function frameRawSpan(row: Pick<FrameRow, "raw_offsets_json">): { startOffset: number | null; endOffset: number | null } {
	const offsets = jsonArray<number>(row.raw_offsets_json).filter(Number.isSafeInteger);
	return offsets.length ? { startOffset: Math.min(...offsets), endOffset: Math.max(...offsets) } : { startOffset: null, endOffset: null };
}

function frameDirectionSummary(row: Pick<FrameRow, "directions_json">): string {
	const directions = [...new Set(jsonArray<string>(row.directions_json).map(value => String(value).trim().toUpperCase()).filter(Boolean))];
	return directions.length === 1 ? directions[0] : directions.length ? "MIXED" : "UNKNOWN";
}

function wildcardMatches(bytes: readonly number[], tokens: readonly WildcardToken[]): boolean {
	return bytes.length >= tokens.length && tokens.every((token, index) => token === null || bytes[index] === token);
}

function runLength<T>(values: readonly T[], equals: (left: T, right: T) => boolean): Array<{ value: T; count: number }> {
	const runs: Array<{ value: T; count: number }> = [];
	for (const value of values) {
		const last = runs.at(-1);
		if (last && equals(last.value, value)) last.count += 1;
		else runs.push({ value, count: 1 });
	}
	return runs;
}

type SizeBoundedPageInfo = Readonly<{
	requestedLimit: number;
	effectiveLimit: number;
	truncationReason?: AgentPageTruncationReason;
}>;

function responseFitsNormalLimit(value: unknown): boolean {
	try {
		assertEncodedResponseSize(value);
		return true;
	} catch (error) {
		if (error instanceof AgentQueryError && error.code === "response-too-large") return false;
		throw error;
	}
}

function selectSizeBoundedPage<Row, Response>(
	rows: readonly Row[],
	requestedLimit: number,
	render: (pageRows: readonly Row[], page: SizeBoundedPageInfo) => Response
): Response {
	const requestedSize = Math.min(rows.length, requestedLimit);
	const renderCandidate = (size: number): Response => {
		const truncationReason: AgentPageTruncationReason | undefined = size < requestedSize
			? "response-size"
			: rows.length > size
				? "page-limit"
				: undefined;
		return render(rows.slice(0, size), {
			requestedLimit,
			effectiveLimit: size,
			...(truncationReason ? { truncationReason } : {})
		});
	};

	const requestedResponse = renderCandidate(requestedSize);
	if (responseFitsNormalLimit(requestedResponse)) return requestedResponse;
	if (requestedSize <= 1) {
		assertEncodedResponseSize(requestedResponse, true);
		return requestedResponse;
	}

	let low = 1;
	let high = requestedSize - 1;
	let bestResponse: Response | undefined;
	while (low <= high) {
		const candidateSize = Math.floor((low + high + 1) / 2);
		const candidateResponse = renderCandidate(candidateSize);
		if (responseFitsNormalLimit(candidateResponse)) {
			bestResponse = candidateResponse;
			low = candidateSize + 1;
		} else {
			high = candidateSize - 1;
		}
	}
	if (bestResponse !== undefined) return bestResponse;

	const singleResponse = renderCandidate(1);
	assertEncodedResponseSize(singleResponse, true);
	return singleResponse;
}

export class CanonicalQueryService {
	private readonly database: SqliteDatabase;

	constructor(database: SqliteDatabase) {
		this.database = database;
	}

	private getCanonicalSummary(captureId: string): CanonicalCaptureSummary | undefined {
		const row = this.database.prepare(
			`SELECT captures.id, captures.name, captures.lifecycle, captures.byte_count,
			        captures.created_at, captures.updated_at, captures.folder_id
			 FROM capture_storage
			 JOIN captures ON captures.id = capture_storage.capture_id
			 WHERE capture_storage.capture_id = @captureId AND capture_storage.status = 'canonical'`
		).get({ captureId }) as CanonicalSummaryRow | undefined;
		return row ? canonicalSummary(row) : undefined;
	}

	private getLegacySummary(captureId: string): CanonicalCaptureSummary | undefined {
		const row = this.database.prepare(
			`SELECT documents.id,
					json_extract(document_json, '$.name') AS name,
					json_extract(document_json, '$.lifecycle') AS lifecycle,
					json_extract(document_json, '$.byteCount') AS byte_count,
					json_extract(document_json, '$.folderId') AS folder_id,
					documents.created_at, documents.updated_at, capture_storage.status
			 FROM capture_storage
			 JOIN capture_documents AS documents ON documents.id = capture_storage.capture_id
			 WHERE capture_storage.capture_id = @captureId
			   AND capture_storage.status IN ('legacy-not-canonicalized','converting','canonicalization-failed')`
		).get({ captureId }) as LegacySummaryRow | undefined;
		return row ? legacySummary(row) : undefined;
	}

	getCaptureSummary(captureId: string): CanonicalCaptureSummary | undefined {
		return this.getCanonicalSummary(captureId) ?? this.getLegacySummary(captureId);
	}

	listCaptureSummaries(): CanonicalCaptureSummary[] {
		const canonical = this.database.prepare(
			`SELECT captures.id, captures.name, captures.lifecycle, captures.byte_count,
			        captures.created_at, captures.updated_at, captures.folder_id
			 FROM capture_storage
			 JOIN captures ON captures.id = capture_storage.capture_id
			 WHERE capture_storage.status = 'canonical'
			 ORDER BY captures.updated_at DESC, captures.id ASC`
		).all() as CanonicalSummaryRow[];
		const legacy = this.database.prepare(
			`SELECT documents.id,
					json_extract(document_json, '$.name') AS name,
					json_extract(document_json, '$.lifecycle') AS lifecycle,
					json_extract(document_json, '$.byteCount') AS byte_count,
					json_extract(document_json, '$.folderId') AS folder_id,
					documents.created_at, documents.updated_at, capture_storage.status
			 FROM capture_storage
			 JOIN capture_documents AS documents ON documents.id = capture_storage.capture_id
			 WHERE capture_storage.status IN ('legacy-not-canonicalized','converting','canonicalization-failed')
			 ORDER BY documents.updated_at DESC, documents.id ASC`
		).all() as LegacySummaryRow[];
		return [...canonical.map(canonicalSummary), ...legacy.map(legacySummary)].sort(
			(left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
		);
	}

	private readParameters(captureId: string, canonical: boolean): { parameters: Array<{ key: string; value: string }>; truncated: boolean } {
		if (canonical) {
			const rows = this.database.prepare(
				`SELECT key_text, value_text FROM capture_parameters
				 WHERE capture_id = @captureId ORDER BY position LIMIT 33`
			).all({ captureId }) as Array<{ key_text: string; value_text: string }>;
			return {
				parameters: rows.slice(0, 32).map(row => ({ key: row.key_text, value: row.value_text })),
				truncated: rows.length > 32
			};
		}
		const rows = this.database.prepare(
			`SELECT json_extract(parameter.value, '$.key') AS key_text,
			        CAST(json_extract(parameter.value, '$.value') AS TEXT) AS value_text
			 FROM capture_documents AS documents, json_each(documents.document_json, '$.params') AS parameter
			 WHERE documents.id = @captureId
			 ORDER BY CAST(parameter.key AS INTEGER) LIMIT 33`
		).all({ captureId }) as Array<{ key_text: unknown; value_text: unknown }>;
		return {
			parameters: rows.slice(0, 32).flatMap(row => {
				const key = optionalString(row.key_text);
				return key ? [{ key, value: stringValue(row.value_text) }] : [];
			}),
			truncated: rows.length > 32
		};
	}

	private readDiscoveryRows(filters: NormalizedCaptureDiscoveryFilters, limit: number, cursor?: string, captureId?: string): DiscoveryRow[] {
		const canonicalPredicate = capturePredicate("captures", filters, true);
		const legacyPredicate = capturePredicate("documents", filters, false);
		const cursorPayload = cursor ? decodeAgentCursor(cursor, "capture-discovery") : undefined;
		if (cursorPayload) assertCursorFilters(cursorPayload, paramsObject(filters));
		const cursorParams = cursorPayload?.key ?? {};
		const keyset = cursorPayload ? " AND (updated_at < @cursorUpdatedAt OR (updated_at = @cursorUpdatedAt AND id > @cursorId))" : "";
		const requestedCapture = captureId ? " AND id = @requestedCaptureId" : "";
		const statusFilter = filters.storageStatus.length
			? " AND status IN (" + filters.storageStatus.map((_status, index) => `@storageStatus${index}`).join(", ") + ")"
			: "";
		const params = {
			...canonicalPredicate.params,
			...legacyPredicate.params,
			cursorUpdatedAt: cursorParams.updatedAt,
			cursorId: cursorParams.id,
			requestedCaptureId: captureId,
			...Object.fromEntries(filters.storageStatus.map((status, index) => [`storageStatus${index}`, status])),
			limit: limit + 1
		};
		const rows = this.database.prepare(
			`SELECT id, name, description, controller_view, lifecycle, byte_count, created_at, updated_at, folder_id,
			        status, data_revision, metadata_revision, content_revision, retained_start_offset,
			        profile_id, profile_version, algorithm_version, profile_source_data_revision,
			        profile_retained_start_offset, profile_verified, profile_is_active, frame_count,
			        raw_start_offset, raw_end_offset, frame_start_ordinal, frame_end_ordinal
			 FROM (
				 SELECT captures.id,
				        captures.name,
				        captures.description,
				        captures.controller_view,
				        captures.lifecycle,
				        captures.byte_count,
				        captures.created_at,
				        captures.updated_at,
				        captures.folder_id,
				        capture_storage.status,
				        captures.data_revision,
				        captures.metadata_revision,
				        captures.content_revision,
				        captures.retained_start_offset,
				        profiles.id AS profile_id,
				        profiles.version AS profile_version,
				        profiles.algorithm_version,
				        profiles.source_data_revision AS profile_source_data_revision,
				        profiles.retained_start_offset AS profile_retained_start_offset,
				        profiles.verified AS profile_verified,
				        profiles.is_active AS profile_is_active,
				        (SELECT COUNT(*) FROM materialized_frames frame_count_rows WHERE frame_count_rows.profile_id = profiles.id) AS frame_count,
				        (SELECT MIN(start_offset) FROM raw_chunks WHERE raw_chunks.capture_id = captures.id) AS raw_start_offset,
				        (SELECT MAX(start_offset + byte_count - 1) FROM raw_chunks WHERE raw_chunks.capture_id = captures.id) AS raw_end_offset,
				        (SELECT MIN(ordinal) FROM materialized_frames frame_start_rows WHERE frame_start_rows.profile_id = profiles.id) AS frame_start_ordinal,
				        (SELECT MAX(ordinal) FROM materialized_frames frame_end_rows WHERE frame_end_rows.profile_id = profiles.id) AS frame_end_ordinal
				 FROM captures
				 JOIN capture_storage ON capture_storage.capture_id = captures.id AND capture_storage.status = 'canonical'
				 LEFT JOIN framing_profiles profiles ON profiles.id = captures.active_framing_profile_id
				 WHERE 1 = 1${canonicalPredicate.sql}
				 UNION ALL
				 SELECT documents.id,
				        json_extract(documents.document_json, '$.name'),
				        json_extract(documents.document_json, '$.description'),
				        json_extract(documents.document_json, '$.view'),
				        json_extract(documents.document_json, '$.lifecycle'),
				        json_extract(documents.document_json, '$.byteCount'),
				        documents.created_at,
				        documents.updated_at,
				        json_extract(documents.document_json, '$.folderId'),
				        capture_storage.status,
				        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
				        NULL, NULL, NULL, NULL
				 FROM capture_documents documents
				 JOIN capture_storage ON capture_storage.capture_id = documents.id AND capture_storage.status <> 'canonical'
				 WHERE 1 = 1${legacyPredicate.sql}
			 )
			 WHERE 1 = 1${requestedCapture}${statusFilter}${keyset}
			 ORDER BY updated_at DESC, id ASC
			 LIMIT @limit`
		).all(params) as DiscoveryRow[];
		return rows;
	}

	private mapAgentCaptureSummary(row: DiscoveryRow): AgentCaptureSummary {
		const canonical = row.status === "canonical";
		const parameters = this.readParameters(row.id, canonical);
		return {
			id: row.id,
			status: row.status,
			name: optionalString(row.name) ?? "Untitled capture",
			description: optionalString(row.description) ?? "",
			controllerView: optionalString(row.controller_view) ?? "",
			parameters: parameters.parameters,
			...(parameters.truncated ? { parametersTruncated: true } : {}),
			folderId: optionalString(row.folder_id),
			lifecycle: optionalString(row.lifecycle),
			byteCount: nonNegativeInteger(row.byte_count),
			frameCount: nonNegativeInteger(row.frame_count),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			dataRevision: nonNegativeInteger(row.data_revision),
			metadataRevision: nonNegativeInteger(row.metadata_revision),
			contentRevision: nonNegativeInteger(row.content_revision),
			retainedStartOffset: nonNegativeInteger(row.retained_start_offset),
			activeProfile: row.profile_id && row.profile_version !== null
				? {
					id: row.profile_id,
					version: row.profile_version,
					algorithmVersion: row.algorithm_version ?? 1,
					sourceDataRevision: row.profile_source_data_revision ?? 0,
					retainedStartOffset: row.profile_retained_start_offset ?? 0,
					verified: Boolean(row.profile_verified),
					isActive: Boolean(row.profile_is_active)
				}
				: null,
			...(canonical ? {} : { conversionGuidance: "Convert this legacy capture in the Bus Lens UI before requesting analytical evidence." })
		};
	}

	queryCaptureDiscovery(input: CaptureDiscoveryFiltersInput = {}): AgentResponse<AgentCaptureDiscovery> {
		const filters = normalizeCaptureDiscoveryFilters(input);
		const requestedLimit = boundedLimit(input.limit, DEFAULT_CAPTURE_DISCOVERY_LIMIT, MAX_CAPTURE_DISCOVERY_LIMIT);
		const rows = this.readDiscoveryRows(filters, requestedLimit, input.cursor);
		let pageRows = rows.slice(0, requestedLimit);
		let effectiveLimit = requestedLimit;
		let hasMore = rows.length > pageRows.length;
		const mappedRows = () => pageRows.map(row => this.mapAgentCaptureSummary(row));
		// A caller may request the maximum page size, but the encoded response
		// target still wins. Rows are complete records; only the number of rows is
		// reduced and the keyset cursor makes the reduction explicit to the caller.
		while (pageRows.length > 1) {
			const estimated = Buffer.byteLength(JSON.stringify({ captures: mappedRows() }), "utf8");
			if (estimated <= AGENT_NORMAL_RESPONSE_BYTES) break;
			pageRows = pageRows.slice(0, Math.max(1, Math.floor(pageRows.length / 2)));
			effectiveLimit = pageRows.length;
			hasMore = true;
		}
		const last = pageRows.at(-1);
		const nextCursor = hasMore && last
			? encodeAgentCursor({
				contractVersion: 1,
				scope: "capture-discovery",
				filters: paramsObject(filters),
				key: { updatedAt: last.updated_at, id: last.id }
			})
			: undefined;
		const response = makeAgentResponse({
			data: { captures: mappedRows() },
			appliedFilters: paramsObject(filters),
			requestedLimit,
			effectiveLimit,
			returned: pageRows.length,
			nextCursor,
			truncationReason: effectiveLimit < requestedLimit ? "response-size" : hasMore ? "page-limit" : undefined,
			truncated: hasMore,
			suggestedOperations: hasMore ? [{ tool: "list_captures", reason: "More captures match these filters", arguments: { cursor: nextCursor } }] : []
		});
		assertEncodedResponseSize(response);
		return response;
	}

	private resolveProfile(captureId: string, requested?: Partial<AgentSnapshotReference>): { profile: ProfileRow; snapshot: AgentSnapshotReference } {
		const capture = this.database.prepare(
			"SELECT id, data_revision, active_framing_profile_id FROM captures WHERE id = @captureId"
		).get({ captureId }) as { id: string; data_revision: number; active_framing_profile_id: string | null } | undefined;
		if (!capture) throw new AgentQueryError("not-found", "Capture was not found", { captureId });
		const profileId = requested?.profileId ?? capture.active_framing_profile_id;
		if (!profileId) throw new AgentQueryError("evidence-missing", "Capture has no framing profile", { captureId });
		const profile = this.database.prepare(
			`SELECT id, capture_id, version, algorithm_version, is_active, source_data_revision,
			        retained_start_offset, verified
			 FROM framing_profiles WHERE id = @profileId AND capture_id = @captureId`
		).get({ profileId, captureId }) as ProfileRow | undefined;
		if (!profile) throw new AgentQueryError("snapshot-mismatch", "The requested framing profile is not available for this capture", { captureId, profileId });
		if (requested?.profileVersion !== undefined && profile.version !== requested.profileVersion) {
			throw new AgentQueryError("snapshot-mismatch", "The requested framing profile version is not available", { captureId, profileId, profileVersion: requested.profileVersion });
		}
		const sourceDataRevision = profile.source_data_revision ?? capture.data_revision;
		if (requested?.sourceDataRevision !== undefined && sourceDataRevision !== requested.sourceDataRevision) {
			throw new AgentQueryError("snapshot-mismatch", "The requested source data revision is not available", { captureId, profileId, sourceDataRevision: requested.sourceDataRevision });
		}
		return {
			profile,
			snapshot: { captureId, profileId: profile.id, profileVersion: profile.version, sourceDataRevision }
		};
	}

	private activeAnalysisSnapshot(captureId: string): AgentSnapshotReference | undefined {
		const row = this.database.prepare(
			`SELECT profiles.id AS profile_id, profiles.version AS profile_version,
			        COALESCE(profiles.source_data_revision, captures.data_revision) AS source_data_revision,
			        profiles.verified
			 FROM captures
			 JOIN framing_profiles profiles ON profiles.id = captures.active_framing_profile_id
			 WHERE captures.id = @captureId`
		).get({ captureId }) as {
			profile_id: string;
			profile_version: number;
			source_data_revision: number;
			verified: number;
		} | undefined;
		if (!row || !row.verified) return undefined;
		return {
			captureId,
			profileId: row.profile_id,
			profileVersion: row.profile_version,
			sourceDataRevision: row.source_data_revision
		};
	}

	private readAgentOverview(captureId: string, requested?: Partial<AgentSnapshotReference>): AgentCaptureOverview {
		const summary = this.getCaptureSummary(captureId);
		if (!summary) throw new AgentQueryError("not-found", "Capture was not found", { captureId });
		const agentSummaryRow = this.readDiscoveryRows(normalizeCaptureDiscoveryFilters({}), 1, undefined, captureId)[0];
		if (!agentSummaryRow) throw new AgentQueryError("not-found", "Capture was not found", { captureId });
		const capture = this.mapAgentCaptureSummary(agentSummaryRow);
		if (summary.status !== "canonical") {
			return {
				capture,
				snapshot: null,
				sections: [],
				counts: { rawBytes: null, framedBytes: null, frames: null, visibleFrames: null },
				notes: [],
				topSignatures: [],
				topTransitions: [],
				bytePositions: [],
				sequenceGroups: [],
				availableBounds: { raw: { startOffset: null, endOffset: null }, frames: { startOrdinal: null, endOrdinal: null } },
				conversionGuidance: "Convert this legacy capture in the Bus Lens UI before requesting analytical evidence."
			};
		}
		const { profile, snapshot } = this.resolveProfile(captureId, requested);
		const sections = this.database.prepare(
			`SELECT id, position, start_offset, framing_mode, frame_length, marker_bytes, marker_position,
			        time_gap_ms, collapse_runs, collapsed
			 FROM framing_sections WHERE profile_id = @profileId ORDER BY position`
		).all({ profileId: profile.id }) as Array<{
			id: string; position: number; start_offset: number; framing_mode: string; frame_length: number | null;
			marker_bytes: string | null; marker_position: string | null; time_gap_ms: number | null; collapse_runs: number; collapsed: number;
		}>;
		const frameCount = (this.database.prepare("SELECT COUNT(*) AS count FROM materialized_frames WHERE profile_id = @profileId").get({ profileId: profile.id }) as { count: number }).count;
		const visibleFrames = (this.database.prepare("SELECT COUNT(*) AS count FROM materialized_frames WHERE profile_id = @profileId AND hidden = 0").get({ profileId: profile.id }) as { count: number }).count;
		const framedBytes = (this.database.prepare(
			"SELECT COALESCE(SUM(json_array_length(bytes_json)), 0) AS count FROM materialized_frames WHERE profile_id = @profileId"
		).get({ profileId: profile.id }) as { count: number }).count;
		const rawBounds = this.database.prepare(
			"SELECT MIN(start_offset) AS start_offset, MAX(start_offset + byte_count - 1) AS end_offset FROM raw_chunks WHERE capture_id = @captureId"
		).get({ captureId }) as { start_offset: number | null; end_offset: number | null };
		const frameBounds = this.database.prepare(
			"SELECT MIN(ordinal) AS start_ordinal, MAX(ordinal) AS end_ordinal FROM materialized_frames WHERE profile_id = @profileId"
		).get({ profileId: profile.id }) as { start_ordinal: number | null; end_ordinal: number | null };
		const noteRows = this.database.prepare(
			`SELECT id, target_kind, text, created_at, profile_id, raw_offset, start_offset, end_offset, sequence_group_id,
			        author_type, reported_client_name, reported_client_version, protocol_version
			 FROM stable_notes
			 WHERE capture_id = @captureId AND (profile_id IS NULL OR profile_id = @profileId)
			 ORDER BY created_at DESC LIMIT 17`
		).all({ captureId, profileId: profile.id }) as Array<{ id: string; target_kind: string; text: string; created_at: string; profile_id: string | null; raw_offset: number | null; start_offset: number | null; end_offset: number | null; sequence_group_id: string | null; author_type: "human" | "agent"; reported_client_name: string | null; reported_client_version: string | null; protocol_version: string | null }>;
		const signatureRows = this.database.prepare(
			"SELECT signature, count FROM frame_signatures WHERE profile_id = @profileId ORDER BY count DESC, signature ASC LIMIT 13"
		).all({ profileId: profile.id }) as Array<{ signature: string; count: number }>;
		const transitionRows = this.database.prepare(
			`SELECT from_signature, to_signature, count, diffs
			 FROM frame_transitions WHERE profile_id = @profileId
			 ORDER BY count DESC, from_signature ASC, to_signature ASC LIMIT 13`
		).all({ profileId: profile.id }) as Array<{ from_signature: string; to_signature: string; count: number; diffs: number }>;
		const byteRows = this.database.prepare(
			`SELECT position, SUM(count) AS applicable_frame_count, COUNT(*) AS vocabulary_size
			 FROM byte_statistics WHERE profile_id = @profileId
			 GROUP BY position ORDER BY position LIMIT 33`
		).all({ profileId: profile.id }) as Array<{ position: number; applicable_frame_count: number; vocabulary_size: number }>;
		const varianceRows = this.database.prepare(
			"SELECT position, variance FROM bit_statistics WHERE profile_id = @profileId GROUP BY position ORDER BY position LIMIT 33"
		).all({ profileId: profile.id }) as Array<{ position: number; variance: string }>;
		const varianceByPosition = new Map(varianceRows.map(row => [row.position, row.variance]));
		const groupRows = this.database.prepare(
			`SELECT groups.id, groups.key_text, groups.signatures_json, groups.length,
			        COUNT(DISTINCT occurrences.occurrence_index) AS occurrence_count,
			        MIN(occurrences.start_frame_ordinal) AS first_ordinal,
			        MAX(occurrences.start_frame_ordinal) AS last_ordinal,
			        MIN(occurrences.start_raw_offset) AS first_raw_offset,
			        MAX(occurrences.end_raw_offset) AS last_raw_offset
			 FROM sequence_groups groups
			 LEFT JOIN sequence_occurrences occurrences ON occurrences.group_id = groups.id
			 WHERE groups.capture_id = @captureId AND groups.profile_id = @profileId
			 GROUP BY groups.id ORDER BY occurrence_count DESC, groups.id ASC LIMIT 13`
		).all({ captureId, profileId: profile.id }) as Array<{ id: string; key_text: string; signatures_json: string; length: number; occurrence_count: number; first_ordinal: number | null; last_ordinal: number | null; first_raw_offset: number | null; last_raw_offset: number | null }>;
		const sequenceGroups: AgentSequenceSummary[] = groupRows.slice(0, 12).map(row => {
			const occurrenceTimes = this.database.prepare(
				`SELECT occurrence_index, start_frame_ordinal, MIN(timestamps_json) AS timestamps_json
				 FROM sequence_occurrences
				 LEFT JOIN materialized_frames ON materialized_frames.profile_id = @profileId AND materialized_frames.ordinal = sequence_occurrences.start_frame_ordinal
				 WHERE group_id = @groupId GROUP BY occurrence_index, start_frame_ordinal
				 ORDER BY occurrence_index LIMIT 1`
			).get({ profileId: profile.id, groupId: row.id }) as { occurrence_index: number; start_frame_ordinal: number; timestamps_json: string | null } | undefined;
			const lastOccurrence = this.database.prepare(
				`SELECT occurrence_index, start_frame_ordinal
				 FROM sequence_occurrences WHERE group_id = @groupId ORDER BY occurrence_index DESC LIMIT 1`
			).get({ groupId: row.id }) as { occurrence_index: number; start_frame_ordinal: number } | undefined;
			const note = this.database.prepare(
				`SELECT text FROM stable_notes
				 WHERE capture_id = @captureId
				   AND (profile_id IS NULL OR profile_id = @profileId)
				   AND (sequence_group_id = @groupId OR (target_kind = 'pattern' AND sequence_key = @sequenceKey))
				 ORDER BY created_at DESC LIMIT 1`
			).get({ captureId, profileId: profile.id, groupId: row.id, sequenceKey: row.key_text }) as { text: string } | undefined;
			return {
				id: row.id,
				signatures: jsonArray<string>(row.signatures_json),
				length: row.length,
				occurrenceCount: row.occurrence_count,
				sections: [],
				cadenceMs: null,
				remark: note ? previewText(note.text) : null,
				firstOccurrence: occurrenceTimes ? { occurrenceNumber: occurrenceTimes.occurrence_index, startOrdinal: occurrenceTimes.start_frame_ordinal, timestamp: occurrenceTimes.timestamps_json ? (jsonArray<number>(occurrenceTimes.timestamps_json)[0] ?? null) : null } : null,
				lastOccurrence: lastOccurrence ? { occurrenceNumber: lastOccurrence.occurrence_index, startOrdinal: lastOccurrence.start_frame_ordinal, timestamp: null } : null
			};
		});
		return {
			capture,
			snapshot,
			sections: sections.map(section => ({
				id: section.id,
				position: section.position,
				startOffset: section.start_offset,
				framingMode: section.framing_mode,
				frameLength: section.frame_length,
				marker: markerText(section.marker_bytes),
				markerPosition: section.marker_position,
				timeGapMs: section.time_gap_ms,
				collapseRuns: Boolean(section.collapse_runs),
				collapsed: Boolean(section.collapsed)
			})),
			counts: { rawBytes: capture.byteCount, framedBytes, frames: frameCount, visibleFrames },
			notes: noteRows.slice(0, 16).map(row => ({ id: row.id, targetKind: row.target_kind, textPreview: previewText(row.text), createdAt: row.created_at, profileId: row.profile_id, rawOffset: row.raw_offset, startOffset: row.start_offset, endOffset: row.end_offset, sequenceGroupId: row.sequence_group_id, authorType: row.author_type, ...(row.reported_client_name ? { reportedClientName: row.reported_client_name } : {}), ...(row.reported_client_version ? { reportedClientVersion: row.reported_client_version } : {}), ...(row.protocol_version ? { protocolVersion: row.protocol_version } : {}) })),
			topSignatures: signatureRows.slice(0, 12),
			topTransitions: transitionRows.slice(0, 12).map(row => ({ fromSignature: row.from_signature, toSignature: row.to_signature, count: row.count, changedPositions: row.diffs })),
			bytePositions: byteRows.slice(0, 32).map(row => ({ position: row.position, applicableFrameCount: row.applicable_frame_count, vocabularySize: row.vocabulary_size, variance: varianceByPosition.get(row.position) ?? null })),
			sequenceGroups,
			availableBounds: { raw: { startOffset: rawBounds.start_offset, endOffset: rawBounds.end_offset }, frames: { startOrdinal: frameBounds.start_ordinal, endOrdinal: frameBounds.end_ordinal } }
		};
	}

	queryCaptureOverview(captureId: string, snapshot?: Partial<AgentSnapshotReference>): AgentResponse<AgentCaptureOverview> {
		const data = this.readAgentOverview(captureId, snapshot);
		const response = makeAgentResponse({
			data,
			appliedFilters: { captureId, ...(snapshot ?? {}) },
			snapshot: data.snapshot ?? undefined,
			truncated: false,
			suggestedOperations: data.snapshot ? [{ tool: "query_messages", reason: "Inspect selected evidence after reviewing the bounded overview", arguments: { captureId, profileId: data.snapshot.profileId, profileVersion: data.snapshot.profileVersion, sourceDataRevision: data.snapshot.sourceDataRevision } }] : []
		});
		assertEncodedResponseSize(response);
		return response;
	}

	getCaptureOverview(captureId: string): CanonicalCaptureOverview | undefined {
		const summary = this.getCaptureSummary(captureId);
		if (!summary) return undefined;
		if (summary.status !== "canonical") {
			return { ...summary, rawByteCount: null, frameCount: null, activeProfile: null };
		}

		const profile = this.database.prepare(
			`SELECT framing_profiles.id, framing_profiles.version, framing_profiles.algorithm_version AS algorithmVersion
			 FROM captures
			 JOIN framing_profiles ON framing_profiles.id = captures.active_framing_profile_id
			 WHERE captures.id = @captureId LIMIT 1`
		).get({ captureId }) as { id: string; version: number; algorithmVersion: number } | undefined;
		const frameCount = profile
			? (this.database.prepare("SELECT COUNT(*) AS count FROM materialized_frames WHERE profile_id = @profileId").get({ profileId: profile.id }) as { count: number }).count
			: 0;
		return {
			...summary,
			rawByteCount: summary.byteCount,
			frameCount,
			activeProfile: profile ?? null
		};
	}

	getFrameWindow(captureId: string, offset = 0, limit = DEFAULT_FRAME_WINDOW_LIMIT): CanonicalFrameWindow | undefined {
		if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("frame window offset must be a non-negative integer");
		if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("frame window limit must be a positive integer");
		const boundedFrameLimit = Math.min(limit, MAX_FRAME_WINDOW_LIMIT);
		const summary = this.getCaptureSummary(captureId);
		if (!summary) return undefined;
		if (summary.status !== "canonical") {
			return { capture: summary, status: summary.status, offset, limit: boundedFrameLimit, totalFrames: null, hasMore: false, frames: [] };
		}

		const profile = this.database.prepare(
			`SELECT framing_profiles.id FROM captures
			 JOIN framing_profiles ON framing_profiles.id = captures.active_framing_profile_id
			 WHERE captures.id = @captureId LIMIT 1`
		).get({ captureId }) as { id: string } | undefined;
		if (!profile) return { capture: summary, status: summary.status, offset, limit: boundedFrameLimit, totalFrames: 0, hasMore: false, frames: [] };
		const totalFrames = (this.database.prepare("SELECT COUNT(*) AS count FROM materialized_frames WHERE profile_id = @profileId").get({ profileId: profile.id }) as { count: number }).count;
		const rows = this.database.prepare(
			`SELECT id, ordinal, section_id, raw_offsets_json, bytes_json, timestamps_json,
			        directions_json, hidden, signature
			 FROM materialized_frames
			 WHERE profile_id = @profileId
			   AND ordinal >= @offset
			 ORDER BY ordinal
			 LIMIT @limit`
		).all({ profileId: profile.id, limit: boundedFrameLimit, offset }) as FrameRow[];
		return {
			capture: summary,
			status: summary.status,
			offset,
			limit: boundedFrameLimit,
			totalFrames,
			hasMore: offset + rows.length < totalFrames,
			frames: rows.map(row => ({
				id: row.id,
				ordinal: row.ordinal,
				sectionId: row.section_id,
				rawOffsets: jsonArray<number>(row.raw_offsets_json),
				bytes: jsonArray<number>(row.bytes_json),
				timestamps: jsonArray<number>(row.timestamps_json),
				directions: jsonArray<string>(row.directions_json),
				hidden: Boolean(row.hidden),
				signature: row.signature
			}))
		};
	}

	private resolveAnalysisProfile(captureId: string, requested?: Partial<AgentSnapshotReference>): { profile: ProfileRow; snapshot: AgentSnapshotReference } {
		const storage = this.database
			.prepare("SELECT status FROM capture_storage WHERE capture_id = @captureId")
			.get({ captureId }) as { status: CanonicalCaptureStatus } | undefined;
		if (storage?.status === "legacy-not-canonicalized" || storage?.status === "converting" || storage?.status === "canonicalization-failed") {
			throw new AgentQueryError("legacy-not-canonicalized", "This capture is not canonicalized; convert it in the Bus Lens UI before requesting analytical evidence", { captureId, status: storage.status });
		}
		if (!storage) throw new AgentQueryError("not-found", "Capture was not found", { captureId });
		const resolved = this.resolveProfile(captureId, requested);
		if (!resolved.profile.verified) throw new AgentQueryError("evidence-missing", "The requested framing profile is not verified", { captureId, profileId: resolved.profile.id });
		return resolved;
	}

	private mapAnalysisMessages(rows: readonly AnalysisFrameRow[], previousTimestamp: number | null = null): AgentMessage[] {
		if (!rows.length) return [];
		const minOrdinal = rows[0].ordinal;
		const maxOrdinal = rows.at(-1)?.ordinal ?? minOrdinal;
		const profileId = rows[0].profile_id;
		const captureId = rows[0].capture_id;
		const memberships = this.database.prepare(
			`SELECT groups.id AS group_id, occurrences.occurrence_index, occurrences.offset,
			        occurrences.start_frame_ordinal, occurrences.length
			 FROM sequence_groups groups
			 JOIN sequence_occurrences occurrences ON occurrences.group_id = groups.id
			 WHERE groups.profile_id = @profileId
			   AND occurrences.start_frame_ordinal <= @maxOrdinal
			   AND occurrences.start_frame_ordinal + occurrences.length > @minOrdinal
			 ORDER BY occurrences.start_frame_ordinal, groups.id, occurrences.occurrence_index`
		).all({ profileId, minOrdinal, maxOrdinal }) as Array<{
			group_id: string;
			occurrence_index: number;
			offset: number;
			start_frame_ordinal: number;
			length: number;
		}>;
		const membershipByOrdinal = new Map<number, Array<{ groupId: string; occurrenceNumber: number; offset: number }>>();
		for (const membership of memberships) {
			const ordinal = membership.start_frame_ordinal + membership.offset;
			if (ordinal < minOrdinal || ordinal > maxOrdinal) continue;
			const list = membershipByOrdinal.get(ordinal) ?? [];
			list.push({ groupId: membership.group_id, occurrenceNumber: membership.occurrence_index, offset: membership.offset });
			membershipByOrdinal.set(ordinal, list);
		}
		const spans = rows.map(row => frameRawSpan(row)).filter(span => span.startOffset !== null && span.endOffset !== null);
		const minRawOffset = spans.length ? Math.min(...spans.map(span => span.startOffset as number)) : null;
		const maxRawOffset = spans.length ? Math.max(...spans.map(span => span.endOffset as number)) : null;
		const framePlaceholders = rows.map((_row, index) => `@frameId${index}`);
		const noteRows = minRawOffset === null || maxRawOffset === null
			? []
			: this.database.prepare(
				`SELECT id, frame_id, profile_id, raw_offset, start_offset, end_offset, start_row, end_row
				 FROM stable_notes
				 WHERE capture_id = @captureId
				   AND (
					 frame_id IN (${framePlaceholders.join(", ")})
					 OR (profile_id = @profileId AND start_row IS NOT NULL AND end_row IS NOT NULL AND start_row <= @maxOrdinal AND end_row >= @minOrdinal)
					 OR (profile_id = @profileId AND start_offset IS NOT NULL AND end_offset IS NOT NULL AND end_offset >= @minRawOffset AND start_offset <= @maxRawOffset)
					 OR (raw_offset BETWEEN @minRawOffset AND @maxRawOffset)
				   )
				 ORDER BY created_at, id`
			).all({
				captureId,
				profileId,
				maxOrdinal,
				minOrdinal,
				minRawOffset,
				maxRawOffset,
				...Object.fromEntries(rows.map((row, index) => [`frameId${index}`, row.id]))
			}) as Array<{
				id: string;
				frame_id: string | null;
				profile_id: string | null;
				raw_offset: number | null;
				start_offset: number | null;
				end_offset: number | null;
				start_row: number | null;
				end_row: number | null;
			}>;
		const messages: AgentMessage[] = [];
		let priorTimestamp = previousTimestamp;
		for (const row of rows) {
			const timestamp = timestampFromFrame(row);
			const span = frameRawSpan(row);
			const notes = noteRows.filter(note =>
				note.frame_id === row.id
				|| note.profile_id === profileId && note.start_row !== null && note.end_row !== null && note.start_row <= row.ordinal && note.end_row >= row.ordinal
				|| note.profile_id === profileId && note.start_offset !== null && note.end_offset !== null && span.startOffset !== null && span.endOffset !== null && note.end_offset >= span.startOffset && note.start_offset <= span.endOffset
				|| note.raw_offset !== null && span.startOffset !== null && span.endOffset !== null && note.raw_offset >= span.startOffset && note.raw_offset <= span.endOffset
			).map(note => note.id);
			messages.push({
				frameId: row.id,
				ordinal: row.ordinal,
				timestamp,
				deltaMs: timestamp === null || priorTimestamp === null ? null : timestamp - priorTimestamp,
				sectionId: row.section_id,
				hex: compactHex(jsonArray<number>(row.bytes_json)),
				rawSpan: span,
				direction: frameDirectionSummary(row),
				hidden: Boolean(row.hidden),
				sequenceMembership: membershipByOrdinal.get(row.ordinal) ?? [],
				noteReferences: [...new Set(notes)]
			});
			if (timestamp !== null) priorTimestamp = timestamp;
		}
		return messages;
	}

	private previousFrameTimestamp(profileId: string, ordinal: number): number | null {
		const row = this.database.prepare(
			`SELECT timestamps_json FROM materialized_frames
			 WHERE profile_id = @profileId AND ordinal < @ordinal
			 ORDER BY ordinal DESC LIMIT 1`
		).get({ profileId, ordinal }) as { timestamps_json: string } | undefined;
		return row ? timestampFromFrame(row) : null;
	}

	queryMessages(input: AgentMessageQueryInput): AgentResponse<AgentMessageQueryResult> {
		const captureId = requiredText(input.captureId, "captureId");
		const filters = normalizeMessageFilters(input);
		const requestedSnapshot: Partial<AgentSnapshotReference> = {
			...(input.profileId ? { profileId: requiredText(input.profileId, "profileId") } : {}),
			...(input.profileVersion === undefined ? {} : { profileVersion: optionalNonNegativeInteger(input.profileVersion, "profileVersion") }),
			...(input.sourceDataRevision === undefined ? {} : { sourceDataRevision: optionalNonNegativeInteger(input.sourceDataRevision, "sourceDataRevision") })
		};
		const filterScope = { captureId, ...filters, requestedSnapshot };
		const cursorPayload = input.cursor ? decodeAgentCursor(input.cursor, "message-query", ["ordinal", "id"]) : undefined;
		if (cursorPayload) assertCursorFilters(cursorPayload, filterScope, cursorPayload.snapshot);
		const requested = cursorPayload?.snapshot ? { ...cursorPayload.snapshot, ...requestedSnapshot } : requestedSnapshot;
		const { profile, snapshot } = this.resolveAnalysisProfile(captureId, requested);
		if (cursorPayload && stableJson(cursorPayload.snapshot) !== stableJson(snapshot)) {
			throw new AgentQueryError("invalid-cursor", "The pagination cursor is bound to a different profile revision", { reason: "snapshot-mismatch" });
		}
		const limit = boundedLimit(input.limit, DEFAULT_FRAME_WINDOW_LIMIT, MAX_FRAME_WINDOW_LIMIT);
		const clauses = ["profile_id = @profileId"];
		const params: Record<string, unknown> = { profileId: profile.id, limit: limit + 1 };
		if (filters.ordinalFrom !== undefined) { clauses.push("ordinal >= @ordinalFrom"); params.ordinalFrom = filters.ordinalFrom; }
		if (filters.ordinalTo !== undefined) { clauses.push("ordinal <= @ordinalTo"); params.ordinalTo = filters.ordinalTo; }
		if (filters.rawOffsetFrom !== undefined && filters.rawOffsetTo !== undefined) {
			clauses.push("CAST(json_extract(raw_offsets_json, '$[#-1]') AS INTEGER) >= @rawOffsetFrom");
			clauses.push("CAST(json_extract(raw_offsets_json, '$[0]') AS INTEGER) <= @rawOffsetTo");
			params.rawOffsetFrom = filters.rawOffsetFrom;
			params.rawOffsetTo = filters.rawOffsetTo;
		}
		if (filters.sectionId) { clauses.push("section_id = @sectionId"); params.sectionId = filters.sectionId; }
		if (filters.exactSignature) { clauses.push("signature = @exactSignature"); params.exactSignature = filters.exactSignature; }
		if (filters.hidden === "visible-only") clauses.push("hidden = 0");
		if (filters.hidden === "hidden-only") clauses.push("hidden = 1");
		if (filters.timestampFrom !== undefined) {
			clauses.push("EXISTS (SELECT 1 FROM json_each(materialized_frames.timestamps_json) timestamp_values WHERE CAST(timestamp_values.value AS REAL) >= @timestampFrom)");
			params.timestampFrom = filters.timestampFrom;
		}
		if (filters.timestampTo !== undefined) {
			clauses.push("EXISTS (SELECT 1 FROM json_each(materialized_frames.timestamps_json) timestamp_values WHERE CAST(timestamp_values.value AS REAL) <= @timestampTo)");
			params.timestampTo = filters.timestampTo;
		}
		if (filters.direction) {
			clauses.push("EXISTS (SELECT 1 FROM json_each(materialized_frames.directions_json) direction_values WHERE LOWER(CAST(direction_values.value AS TEXT)) = @direction)");
			params.direction = filters.direction;
		}
		if (filters.wildcardTokens) {
			clauses.push("json_array_length(bytes_json) >= @wildcardLength");
			params.wildcardLength = filters.wildcardTokens.length;
			filters.wildcardTokens.forEach((token, index) => {
				if (token === null) return;
				clauses.push(`CAST(json_extract(bytes_json, '$[${index}]') AS INTEGER) = @wildcard${index}`);
				params[`wildcard${index}`] = token;
			});
		}
		if (filters.notePresence !== "any") {
			const noteExists = `EXISTS (
				SELECT 1 FROM stable_notes notes
				WHERE notes.capture_id = materialized_frames.capture_id
				  AND (
					notes.frame_id = materialized_frames.id
					OR notes.profile_id = materialized_frames.profile_id AND notes.start_row IS NOT NULL AND notes.end_row IS NOT NULL AND notes.start_row <= materialized_frames.ordinal AND notes.end_row >= materialized_frames.ordinal
					OR notes.profile_id = materialized_frames.profile_id AND notes.start_offset IS NOT NULL AND notes.end_offset IS NOT NULL AND notes.end_offset >= json_extract(materialized_frames.raw_offsets_json, '$[0]') AND notes.start_offset <= json_extract(materialized_frames.raw_offsets_json, '$[#-1]')
					OR notes.raw_offset IS NOT NULL AND notes.raw_offset >= json_extract(materialized_frames.raw_offsets_json, '$[0]') AND notes.raw_offset <= json_extract(materialized_frames.raw_offsets_json, '$[#-1]')
				  )
			)`;
			clauses.push(filters.notePresence === "with-note" ? noteExists : `NOT ${noteExists}`);
		}
		if (filters.sequenceGroupId) {
			clauses.push(`EXISTS (
				SELECT 1 FROM sequence_occurrences sequence_membership
				JOIN sequence_groups sequence_group
				  ON sequence_group.id = sequence_membership.group_id
				 AND sequence_group.profile_id = materialized_frames.profile_id
				 AND sequence_group.capture_id = materialized_frames.capture_id
				WHERE sequence_membership.group_id = @sequenceGroupId
				  AND sequence_membership.start_frame_ordinal <= materialized_frames.ordinal
				  AND sequence_membership.start_frame_ordinal + sequence_membership.length > materialized_frames.ordinal
			)`);
			params.sequenceGroupId = filters.sequenceGroupId;
		}
		if (cursorPayload) {
			clauses.push("(ordinal > @cursorOrdinal OR (ordinal = @cursorOrdinal AND id > @cursorId))");
			params.cursorOrdinal = cursorPayload.key.ordinal;
			params.cursorId = cursorPayload.key.id;
		}
		const rows = this.database.prepare(
			`SELECT id, capture_id, profile_id, ordinal, section_id, raw_offsets_json, bytes_json,
			        timestamps_json, directions_json, hidden, signature
			 FROM materialized_frames
			 WHERE ${clauses.join(" AND ")}
			 ORDER BY ordinal ASC, id ASC
			 LIMIT @limit`
		).all(params) as AnalysisFrameRow[];
		return selectSizeBoundedPage(rows, limit, (pageRows, page) => {
			const previousTimestamp = pageRows.length ? this.previousFrameTimestamp(profile.id, pageRows[0].ordinal) : null;
			const messages = this.mapAnalysisMessages(pageRows, previousTimestamp);
			const hasMore = rows.length > pageRows.length;
			const last = pageRows.at(-1);
			const nextCursor = hasMore && last
				? encodeAgentCursor({ contractVersion: 1, scope: "message-query", filters: filterScope, snapshot, key: { ordinal: last.ordinal, id: last.id } })
				: undefined;
			return makeAgentResponse({
				data: { messages },
				appliedFilters: filterScope,
				snapshot,
				requestedLimit: page.requestedLimit,
				returned: messages.length,
				effectiveLimit: page.effectiveLimit,
				nextCursor,
				truncationReason: page.truncationReason,
				truncated: hasMore,
				suggestedOperations: messages.length ? [{ tool: "get_message_context", reason: "Inspect neighboring frames around a selected stable frame", arguments: { frameId: messages[0].frameId } }] : []
			});
		});
	}

	getMessageContext(input: AgentMessageContextInput): AgentResponse<AgentMessageContext> {
		const frameId = requiredText(input.frameId, "frameId");
		const rowsBefore = boundedLimit(input.rowsBefore, 10, 100, "rowsBefore");
		const rowsAfter = boundedLimit(input.rowsAfter, 10, 100, "rowsAfter");
		const frame = this.database.prepare(
			`SELECT id, capture_id, profile_id, ordinal, section_id, raw_offsets_json, bytes_json,
			        timestamps_json, directions_json, hidden, signature
			 FROM materialized_frames WHERE id = @frameId`
		).get({ frameId }) as AnalysisFrameRow | undefined;
		if (!frame) throw new AgentQueryError("evidence-missing", "The requested frame evidence is no longer available", { frameId });
		if (input.captureId && input.captureId !== frame.capture_id) throw new AgentQueryError("snapshot-mismatch", "The frame does not belong to the requested capture", { frameId, captureId: input.captureId });
		const requested: Partial<AgentSnapshotReference> = {
			profileId: input.profileId ?? frame.profile_id,
			...(input.profileVersion === undefined ? {} : { profileVersion: input.profileVersion }),
			...(input.sourceDataRevision === undefined ? {} : { sourceDataRevision: input.sourceDataRevision })
		};
		const { profile, snapshot } = this.resolveAnalysisProfile(frame.capture_id, requested);
		if (profile.id !== frame.profile_id) throw new AgentQueryError("snapshot-mismatch", "The frame belongs to a different historical profile revision", { frameId, profileId: frame.profile_id, requestedProfileId: profile.id });
		const rows = this.database.prepare(
			`SELECT id, capture_id, profile_id, ordinal, section_id, raw_offsets_json, bytes_json,
			        timestamps_json, directions_json, hidden, signature
			 FROM materialized_frames
			 WHERE profile_id = @profileId
			   AND ordinal BETWEEN @startOrdinal AND @endOrdinal
			 ORDER BY ordinal ASC, id ASC
			 LIMIT @limit`
		).all({ profileId: profile.id, startOrdinal: Math.max(0, frame.ordinal - rowsBefore), endOrdinal: frame.ordinal + rowsAfter, limit: rowsBefore + rowsAfter + 1 }) as AnalysisFrameRow[];
		const previousTimestamp = rows.length ? this.previousFrameTimestamp(profile.id, rows[0].ordinal) : null;
		const response = makeAgentResponse({
			data: { centerFrameId: frameId, rowsBefore, rowsAfter, messages: this.mapAnalysisMessages(rows, previousTimestamp) },
			appliedFilters: { frameId, rowsBefore, rowsAfter },
			snapshot,
			truncated: false,
			suggestedOperations: [{ tool: "query_messages", reason: "Search more frames with the same snapshot", arguments: { captureId: frame.capture_id, profileId: snapshot.profileId, profileVersion: snapshot.profileVersion, sourceDataRevision: snapshot.sourceDataRevision } }]
		});
		assertEncodedResponseSize(response);
		return response;
	}

	private readSequenceGroupSummary(row: SequenceGroupRow, captureId: string, profileId: string): AgentSequenceSummary {
		const sections = this.database.prepare(
			`SELECT DISTINCT frames.section_id
			 FROM sequence_occurrences occurrences
			 JOIN materialized_frames frames
			   ON frames.profile_id = @profileId
			  AND frames.ordinal >= occurrences.start_frame_ordinal
			  AND frames.ordinal < occurrences.start_frame_ordinal + occurrences.length
			 WHERE occurrences.group_id = @groupId
			 ORDER BY frames.section_id`
		).all({ profileId, groupId: row.id }) as Array<{ section_id: string }>;
		const occurrenceStarts = this.database.prepare(
			`SELECT occurrence_index, MIN(start_frame_ordinal) AS start_ordinal
			 FROM sequence_occurrences WHERE group_id = @groupId
			 GROUP BY occurrence_index ORDER BY occurrence_index LIMIT 65`
		).all({ groupId: row.id }) as Array<{ occurrence_index: number; start_ordinal: number }>;
		const timestamps = occurrenceStarts.map(occurrence => {
			const frame = this.database.prepare(
				"SELECT timestamps_json FROM materialized_frames WHERE profile_id = @profileId AND ordinal = @ordinal"
			).get({ profileId, ordinal: occurrence.start_ordinal }) as { timestamps_json: string } | undefined;
			return frame ? timestampFromFrame(frame) : null;
		});
		const cadenceValues = timestamps.slice(1).flatMap((timestamp, index) => timestamp !== null && timestamps[index] !== null ? [timestamp - (timestamps[index] as number)] : []);
		const first = this.database.prepare(
			`SELECT occurrence_index, MIN(start_frame_ordinal) AS start_ordinal,
			        MIN(start_raw_offset) AS start_raw_offset, MAX(end_raw_offset) AS end_raw_offset
			 FROM sequence_occurrences WHERE group_id = @groupId
			 GROUP BY occurrence_index ORDER BY occurrence_index ASC LIMIT 1`
		).get({ groupId: row.id }) as { occurrence_index: number; start_ordinal: number; start_raw_offset: number; end_raw_offset: number } | undefined;
		const last = this.database.prepare(
			`SELECT occurrence_index, MIN(start_frame_ordinal) AS start_ordinal
			 FROM sequence_occurrences WHERE group_id = @groupId
			 GROUP BY occurrence_index ORDER BY occurrence_index DESC LIMIT 1`
		).get({ groupId: row.id }) as { occurrence_index: number; start_ordinal: number } | undefined;
		const firstTimestamp = first ? this.database.prepare(
			"SELECT timestamps_json FROM materialized_frames WHERE profile_id = @profileId AND ordinal = @ordinal"
		).get({ profileId, ordinal: first.start_ordinal }) as { timestamps_json: string } | undefined : undefined;
		const lastTimestamp = last ? this.database.prepare(
			"SELECT timestamps_json FROM materialized_frames WHERE profile_id = @profileId AND ordinal = @ordinal"
		).get({ profileId, ordinal: last.start_ordinal }) as { timestamps_json: string } | undefined : undefined;
		const note = this.database.prepare(
			`SELECT text FROM stable_notes
			 WHERE capture_id = @captureId
			   AND (profile_id IS NULL OR profile_id = @profileId)
			   AND (sequence_group_id = @groupId OR (target_kind = 'pattern' AND sequence_key = @sequenceKey))
			 ORDER BY created_at DESC, id DESC LIMIT 1`
		).get({ captureId, profileId, groupId: row.id, sequenceKey: row.key_text }) as { text: string } | undefined;
		return {
			id: row.id,
			signatures: jsonArray<string>(row.signatures_json),
			length: row.length,
			occurrenceCount: row.occurrence_count,
			sections: sections.map(section => section.section_id),
			cadenceMs: cadenceValues.length ? cadenceValues.reduce((sum, value) => sum + value, 0) / cadenceValues.length : null,
			remark: note ? previewText(note.text) : null,
			firstOccurrence: first ? { occurrenceNumber: first.occurrence_index, startOrdinal: first.start_ordinal, timestamp: firstTimestamp ? timestampFromFrame(firstTimestamp) : null } : null,
			lastOccurrence: last ? { occurrenceNumber: last.occurrence_index, startOrdinal: last.start_ordinal, timestamp: lastTimestamp ? timestampFromFrame(lastTimestamp) : null } : null
		};
	}

	getSequenceGroups(input: AgentSequenceGroupsInput): AgentResponse<AgentSequenceGroupsResult> {
		const captureId = requiredText(input.captureId, "captureId");
		const requestedSnapshot: Partial<AgentSnapshotReference> = {
			...(input.profileId ? { profileId: requiredText(input.profileId, "profileId") } : {}),
			...(input.profileVersion === undefined ? {} : { profileVersion: optionalNonNegativeInteger(input.profileVersion, "profileVersion") }),
			...(input.sourceDataRevision === undefined ? {} : { sourceDataRevision: optionalNonNegativeInteger(input.sourceDataRevision, "sourceDataRevision") })
		};
		const filterScope = { captureId, requestedSnapshot };
		const cursorPayload = input.cursor ? decodeAgentCursor(input.cursor, "sequence-groups", ["occurrenceCount", "id"]) : undefined;
		if (cursorPayload) assertCursorFilters(cursorPayload, filterScope, cursorPayload.snapshot);
		const requested = cursorPayload?.snapshot ? { ...cursorPayload.snapshot, ...requestedSnapshot } : requestedSnapshot;
		const { profile, snapshot } = this.resolveAnalysisProfile(captureId, requested);
		if (cursorPayload && stableJson(cursorPayload.snapshot) !== stableJson(snapshot)) throw new AgentQueryError("invalid-cursor", "The pagination cursor is bound to a different profile revision", { reason: "snapshot-mismatch" });
		const limit = boundedLimit(input.limit, DEFAULT_CAPTURE_DISCOVERY_LIMIT, MAX_CAPTURE_DISCOVERY_LIMIT);
		const params: Record<string, unknown> = { captureId, profileId: profile.id, limit: limit + 1 };
		const cursorSql = cursorPayload ? " WHERE occurrence_count < @cursorOccurrenceCount OR (occurrence_count = @cursorOccurrenceCount AND id > @cursorId)" : "";
		if (cursorPayload) {
			params.cursorOccurrenceCount = cursorPayload.key.occurrenceCount;
			params.cursorId = cursorPayload.key.id;
		}
		const rows = this.database.prepare(
			`SELECT id, key_text, signatures_json, length, occurrence_count, first_ordinal, last_ordinal
			 FROM (
				 SELECT groups.id, groups.key_text, groups.signatures_json, groups.length,
				        COUNT(DISTINCT occurrences.occurrence_index) AS occurrence_count,
				        MIN(occurrences.start_frame_ordinal) AS first_ordinal,
				        MAX(occurrences.start_frame_ordinal) AS last_ordinal
				 FROM sequence_groups groups
				 LEFT JOIN sequence_occurrences occurrences ON occurrences.group_id = groups.id
				 WHERE groups.capture_id = @captureId AND groups.profile_id = @profileId
				 GROUP BY groups.id
			 ) groups_summary
			${cursorSql}
			 ORDER BY occurrence_count DESC, id ASC
			 LIMIT @limit`
		).all(params) as SequenceGroupRow[];
		return selectSizeBoundedPage(rows, limit, (pageRows, page) => {
			const groups = pageRows.map(row => this.readSequenceGroupSummary(row, captureId, profile.id));
			const hasMore = rows.length > pageRows.length;
			const last = pageRows.at(-1);
			const nextCursor = hasMore && last
				? encodeAgentCursor({ contractVersion: 1, scope: "sequence-groups", filters: filterScope, snapshot, key: { occurrenceCount: last.occurrence_count, id: last.id } })
				: undefined;
			return makeAgentResponse({
				data: { groups },
				appliedFilters: filterScope,
				snapshot,
				requestedLimit: page.requestedLimit,
				returned: groups.length,
				effectiveLimit: page.effectiveLimit,
				nextCursor,
				truncationReason: page.truncationReason,
				truncated: hasMore,
				suggestedOperations: groups.length ? [{ tool: "get_sequence_occurrences", reason: "Inspect the bounded occurrences of a selected repeated sequence", arguments: { captureId, groupId: groups[0].id, profileId: snapshot.profileId, profileVersion: snapshot.profileVersion, sourceDataRevision: snapshot.sourceDataRevision } }] : []
			});
		});
	}

	getSequenceOccurrences(input: AgentSequenceOccurrencesInput): AgentResponse<AgentSequenceOccurrencesResult> {
		const groupId = requiredText(input.groupId, "groupId");
		const group = this.database.prepare(
			`SELECT id, capture_id, profile_id, key_text, signatures_json, length,
			        0 AS occurrence_count, NULL AS first_ordinal, NULL AS last_ordinal
			 FROM sequence_groups WHERE id = @groupId`
		).get({ groupId }) as (SequenceGroupRow & { capture_id: string; profile_id: string }) | undefined;
		if (!group) throw new AgentQueryError("evidence-missing", "The requested sequence group is no longer available", { groupId });
		if (input.captureId && input.captureId !== group.capture_id) throw new AgentQueryError("snapshot-mismatch", "The sequence group does not belong to the requested capture", { groupId, captureId: input.captureId });
		const captureId = group.capture_id;
		const requestedSnapshot: Partial<AgentSnapshotReference> = {
			profileId: input.profileId ?? group.profile_id,
			...(input.profileVersion === undefined ? {} : { profileVersion: optionalNonNegativeInteger(input.profileVersion, "profileVersion") }),
			...(input.sourceDataRevision === undefined ? {} : { sourceDataRevision: optionalNonNegativeInteger(input.sourceDataRevision, "sourceDataRevision") })
		};
		const includeContext = Boolean(input.includeContext);
		const contextBefore = includeContext ? boundedLimit(input.contextBefore, 3, 10, "contextBefore") : 0;
		const contextAfter = includeContext ? boundedLimit(input.contextAfter, 3, 10, "contextAfter") : 0;
		const filterScope = { captureId, groupId, includeContext, contextBefore, contextAfter, requestedSnapshot };
		const cursorPayload = input.cursor ? decodeAgentCursor(input.cursor, "sequence-occurrences", ["occurrenceNumber", "id"]) : undefined;
		if (cursorPayload) assertCursorFilters(cursorPayload, filterScope, cursorPayload.snapshot);
		const requested = cursorPayload?.snapshot ? { ...cursorPayload.snapshot, ...requestedSnapshot } : requestedSnapshot;
		const { profile, snapshot } = this.resolveAnalysisProfile(captureId, requested);
		if (profile.id !== group.profile_id) throw new AgentQueryError("snapshot-mismatch", "The sequence group belongs to a different profile revision", { groupId, profileId: group.profile_id });
		if (cursorPayload && stableJson(cursorPayload.snapshot) !== stableJson(snapshot)) throw new AgentQueryError("invalid-cursor", "The pagination cursor is bound to a different profile revision", { reason: "snapshot-mismatch" });
		const limit = boundedLimit(input.limit, DEFAULT_CAPTURE_DISCOVERY_LIMIT, MAX_CAPTURE_DISCOVERY_LIMIT);
		const params: Record<string, unknown> = { groupId, limit: limit + 1 };
		const cursorSql = cursorPayload ? " AND occurrence_index > @cursorOccurrenceNumber" : "";
		if (cursorPayload) params.cursorOccurrenceNumber = cursorPayload.key.occurrenceNumber;
		const rows = this.database.prepare(
			`SELECT occurrence_index AS occurrence_number,
			        MIN(start_frame_ordinal) AS starting_ordinal,
			        MIN(start_raw_offset) AS start_raw_offset,
			        MAX(end_raw_offset) AS end_raw_offset
			 FROM sequence_occurrences
			 WHERE group_id = @groupId${cursorSql}
			 GROUP BY occurrence_index
			 ORDER BY occurrence_index ASC
			 LIMIT @limit`
		).all(params) as SequenceOccurrenceRow[];
		return selectSizeBoundedPage(rows, limit, (pageRows, page) => {
			let firstStartingFrameId: string | undefined;
			const occurrences = pageRows.map(row => {
				const frame = this.database.prepare("SELECT id, timestamps_json FROM materialized_frames WHERE profile_id = @profileId AND ordinal = @ordinal").get({ profileId: profile.id, ordinal: row.starting_ordinal }) as { id: string; timestamps_json: string } | undefined;
				if (firstStartingFrameId === undefined && frame) firstStartingFrameId = frame.id;
				let context: readonly AgentMessage[] | undefined;
				if (input.includeContext) {
					const contextRows = this.database.prepare(
						`SELECT id, capture_id, profile_id, ordinal, section_id, raw_offsets_json, bytes_json,
						        timestamps_json, directions_json, hidden, signature
						 FROM materialized_frames
						 WHERE profile_id = @profileId AND ordinal BETWEEN @startOrdinal AND @endOrdinal
						 ORDER BY ordinal ASC, id ASC LIMIT @limit`
					).all({ profileId: profile.id, startOrdinal: Math.max(0, row.starting_ordinal - contextBefore), endOrdinal: row.starting_ordinal + contextAfter, limit: contextBefore + contextAfter + 1 }) as AnalysisFrameRow[];
					context = this.mapAnalysisMessages(contextRows, contextRows.length ? this.previousFrameTimestamp(profile.id, contextRows[0].ordinal) : null);
				}
				return {
					occurrenceNumber: row.occurrence_number,
					startingOrdinal: row.starting_ordinal,
					rawSpan: { startOffset: row.start_raw_offset, endOffset: row.end_raw_offset },
					timestamp: frame ? timestampFromFrame(frame) : null,
					...(context ? { context } : {})
				};
			});
			const hasMore = rows.length > pageRows.length;
			const last = pageRows.at(-1);
			const nextCursor = hasMore && last
				? encodeAgentCursor({ contractVersion: 1, scope: "sequence-occurrences", filters: filterScope, snapshot, key: { occurrenceNumber: last.occurrence_number, id: groupId } })
				: undefined;
			return makeAgentResponse({
				data: { groupId, occurrences },
				appliedFilters: filterScope,
				snapshot,
				requestedLimit: page.requestedLimit,
				returned: occurrences.length,
				effectiveLimit: page.effectiveLimit,
				nextCursor,
				truncationReason: page.truncationReason,
				truncated: hasMore,
				suggestedOperations: firstStartingFrameId ? [{ tool: "get_message_context", reason: "Inspect a frame near this occurrence", arguments: { frameId: firstStartingFrameId } }] : []
			});
		});
	}

	getByteStatistics(input: AgentByteStatisticsInput): AgentResponse<AgentByteStatisticsResult> {
		const captureId = requiredText(input.captureId, "captureId");
		if (!Array.isArray(input.positions) || input.positions.length === 0) throw new AgentQueryError("invalid-input", "positions must contain at least one byte position");
		if (input.positions.length > 32) throw new AgentQueryError("invalid-input", "At most 32 byte positions may be requested", { maximum: 32 });
		const positions = [...new Set(input.positions.map((position, index) => optionalNonNegativeInteger(position, `positions[${index}]`) as number))].sort((left, right) => left - right);
		const normalizedScope = normalizeByteStatisticsScope(input.scope);
		const scoped = Object.keys(normalizedScope.scope).length > 0;
		const requested: Partial<AgentSnapshotReference> = {
			...(input.profileId ? { profileId: requiredText(input.profileId, "profileId") } : {}),
			...(input.profileVersion === undefined ? {} : { profileVersion: optionalNonNegativeInteger(input.profileVersion, "profileVersion") }),
			...(input.sourceDataRevision === undefined ? {} : { sourceDataRevision: optionalNonNegativeInteger(input.sourceDataRevision, "sourceDataRevision") })
		};
		const { profile, snapshot } = this.resolveAnalysisProfile(captureId, requested);
		const placeholders = positions.map((_position, index) => `@position${index}`);
		const positionParameters = Object.fromEntries(positions.map((position, index) => [`position${index}`, position]));
		const vocabularyRows: Array<{ position: number; value: number; count: number }> = [];
		const bitsByPosition = new Map<number, Array<{ bit: number; percentage: number }>>();
		const varianceByPosition = new Map<number, string>();
		const applicableFrameCountByPosition = new Map<number, number>();
		let matchedFrameCount: number;
		if (!scoped) {
			const parameters = { profileId: profile.id, ...positionParameters };
			matchedFrameCount = (this.database.prepare(
				"SELECT COUNT(*) AS count FROM materialized_frames WHERE profile_id = @profileId"
			).get({ profileId: profile.id }) as { count: number }).count;
			vocabularyRows.push(...this.database.prepare(
				`SELECT position, value, count FROM byte_statistics
				 WHERE profile_id = @profileId AND position IN (${placeholders.join(", ")})
				 ORDER BY position ASC, value ASC`
			).all(parameters) as Array<{ position: number; value: number; count: number }>);
			const bitRows = this.database.prepare(
				`SELECT position, bit, percentage, variance FROM bit_statistics
				 WHERE profile_id = @profileId AND position IN (${placeholders.join(", ")})
				 ORDER BY position ASC, bit ASC`
			).all(parameters) as Array<{ position: number; bit: number; percentage: number; variance: string }>;
			for (const row of bitRows) {
				(bitsByPosition.get(row.position) ?? (bitsByPosition.set(row.position, []), bitsByPosition.get(row.position)!)).push({ bit: row.bit, percentage: row.percentage });
				varianceByPosition.set(row.position, row.variance);
			}
		} else {
			const predicate = byteStatisticsFramePredicate(normalizedScope, "frames");
			const frameParameters = { profileId: profile.id, ...predicate.params };
			matchedFrameCount = (this.database.prepare(
				`SELECT COUNT(*) AS count FROM materialized_frames AS frames
				 WHERE frames.profile_id = @profileId${predicate.sql}`
			).get(frameParameters) as { count: number }).count;
			const scopedParameters = { ...frameParameters, ...positionParameters };
			const scopedBytes = `
				WITH matched_frames AS (
					SELECT frames.bytes_json
					FROM materialized_frames AS frames
					WHERE frames.profile_id = @profileId${predicate.sql}
				), expanded_bytes AS (
					SELECT CAST(byte_values.key AS INTEGER) AS position,
					       CAST(byte_values.value AS INTEGER) AS value
					FROM matched_frames
					CROSS JOIN json_each(matched_frames.bytes_json) AS byte_values
					WHERE CAST(byte_values.key AS INTEGER) IN (${placeholders.join(", ")})
				)`;
			vocabularyRows.push(...this.database.prepare(
				`${scopedBytes}
				 SELECT position, value, COUNT(*) AS count
				 FROM expanded_bytes
				 GROUP BY position, value
				 ORDER BY position ASC, value ASC`
			).all(scopedParameters) as Array<{ position: number; value: number; count: number }>);
			const bitRows = this.database.prepare(
				`${scopedBytes}, bit_values(bit) AS (VALUES (0), (1), (2), (3), (4), (5), (6), (7))
				 SELECT position, bit_values.bit AS bit, COUNT(*) AS applicable_frame_count,
				        SUM(CASE WHEN ((value >> bit_values.bit) & 1) = 1 THEN 1 ELSE 0 END) AS bit_one_count
				 FROM expanded_bytes
				 CROSS JOIN bit_values
				 GROUP BY position, bit_values.bit
				 ORDER BY position ASC, bit_values.bit ASC`
			).all(scopedParameters) as Array<{ position: number; bit: number; applicable_frame_count: number; bit_one_count: number }>;
			for (const row of bitRows) {
				const denominator = Number(row.applicable_frame_count);
				const ratio = denominator ? Number(row.bit_one_count) / denominator : 0;
				(bitsByPosition.get(row.position) ?? (bitsByPosition.set(row.position, []), bitsByPosition.get(row.position)!)).push({
					bit: row.bit,
					percentage: Math.round(ratio * 100)
				});
				applicableFrameCountByPosition.set(row.position, denominator);
				varianceByPosition.set(row.position, (Math.min(ratio, 1 - ratio) * 2).toFixed(2));
			}
		}
		const vocabularyByPosition = new Map<number, Array<{ value: number; count: number }>>();
		for (const row of vocabularyRows) (vocabularyByPosition.get(row.position) ?? (vocabularyByPosition.set(row.position, []), vocabularyByPosition.get(row.position)!)).push({ value: row.value, count: row.count });
		const data = {
			scope: normalizedScope.scope,
			matchedFrameCount,
			positions: positions.map(position => {
				const vocabulary = vocabularyByPosition.get(position) ?? [];
				return {
					position,
					vocabulary,
					bitOnePercentages: bitsByPosition.get(position) ?? [],
					variance: varianceByPosition.get(position) ?? null,
					applicableFrameCount: applicableFrameCountByPosition.get(position) ?? vocabulary.reduce((sum, row) => sum + row.count, 0)
				};
			})
		};
		const response = makeAgentResponse({
			data,
			appliedFilters: { captureId, positions, scope: normalizedScope.scope },
			snapshot,
			requestedLimit: positions.length,
			effectiveLimit: positions.length,
			returned: positions.length,
			truncated: false,
			suggestedOperations: [{ tool: "query_messages", reason: "Relate byte variation to the bounded frames that contain it", arguments: { captureId, profileId: snapshot.profileId, profileVersion: snapshot.profileVersion, sourceDataRevision: snapshot.sourceDataRevision } }]
		});
		assertEncodedResponseSize(response);
		return response;
	}

	private readIndexedTransitions(
		profileId: string,
		filters: AgentTransitionsInput,
		minimumCount: number,
		requestedLimit: number,
		cursor?: AgentCursorPayload
	): AgentTransition[] {
		const sourceSignature = normalizedSignature(filters.sourceSignature ?? filters.fromSignature, "sourceSignature");
		const destinationSignature = normalizedSignature(filters.destinationSignature ?? filters.toSignature, "destinationSignature");
		const sectionId = filters.sectionId === undefined ? undefined : requiredText(filters.sectionId, "sectionId");
		const requestedPositions = normalizedChangedPositions(filters.changedPositions);
		const changedPositionMatch = normalizedChangedPositionMatch(filters.changedPositionMatch);
		const positionClauses = ["profile_id = @profileId"];
		const params: Record<string, unknown> = {
			profileId,
			minimumCount,
			familyLimit: requestedLimit + 1,
			maxChangedPositions: MAX_TRANSITION_CHANGED_POSITION_SET,
			requestedPositionCount: requestedPositions.length
		};
		if (sourceSignature) {
			positionClauses.push("from_signature = @sourceSignature");
			params.sourceSignature = sourceSignature;
		}
		if (destinationSignature) {
			positionClauses.push("to_signature = @destinationSignature");
			params.destinationSignature = destinationSignature;
		}
		if (sectionId) {
			positionClauses.push("section_id = @sectionId");
			params.sectionId = sectionId;
		}
		if (requestedPositions.length) params.requestedPositionsJson = JSON.stringify(requestedPositions);
		if (cursor) {
			params.cursorCount = cursor.key.count;
			params.cursorFromSignature = cursor.key.fromSignature;
			params.cursorToSignature = cursor.key.toSignature;
			params.cursorSectionId = cursor.key.sectionId;
		}

		const requestedPositionSet = requestedPositions.length
			? "position IN (SELECT CAST(value AS INTEGER) FROM json_each(@requestedPositionsJson))"
			: "0";
		const matchingCte = requestedPositions.length
			? `,
		matching_families AS (
			SELECT section_id, from_signature, to_signature
			FROM position_rows
			GROUP BY section_id, from_signature, to_signature
			HAVING COUNT(DISTINCT CASE WHEN ${requestedPositionSet} THEN position END) ${changedPositionMatch === "all" ? "= @requestedPositionCount" : "> 0"}
		)`
			: "";
		const matchingJoin = requestedPositions.length
			? `JOIN matching_families matches
				ON matches.section_id = stats.section_id
			   AND matches.from_signature = stats.from_signature
			   AND matches.to_signature = stats.to_signature`
			: "";
		const cursorSql = cursor
			? `AND (
				stats.transition_count < @cursorCount
				OR (stats.transition_count = @cursorCount AND (
					stats.from_signature > @cursorFromSignature
					OR (stats.from_signature = @cursorFromSignature AND (
						stats.to_signature > @cursorToSignature
						OR (stats.to_signature = @cursorToSignature AND stats.section_id > @cursorSectionId)
					))
				))
			)`
			: "";
		const positionSelection = requestedPositions.length
			? `ranked.position_rank <= @maxChangedPositions OR ranked.position IN (SELECT CAST(value AS INTEGER) FROM json_each(@requestedPositionsJson))`
			: "ranked.position_rank <= @maxChangedPositions";
		const rows = this.database.prepare(
			`WITH position_rows AS (
				SELECT section_id, from_signature, to_signature, position, changed_count, transition_count
				FROM frame_transition_positions
				WHERE ${positionClauses.join(" AND ")}
			), family_stats AS (
				SELECT section_id, from_signature, to_signature,
				       MAX(transition_count) AS transition_count,
				       COUNT(*) AS changed_position_count
				FROM position_rows
				GROUP BY section_id, from_signature, to_signature
			)${matchingCte}, top_families AS (
				SELECT stats.section_id, stats.from_signature, stats.to_signature,
				       stats.transition_count, stats.changed_position_count
				FROM family_stats stats
				${matchingJoin}
				WHERE stats.transition_count >= @minimumCount
				${cursorSql}
				ORDER BY stats.transition_count DESC, stats.from_signature ASC, stats.to_signature ASC, stats.section_id ASC
				LIMIT @familyLimit
			), ranked_positions AS (
				SELECT positions.section_id, positions.from_signature, positions.to_signature,
				       positions.position, positions.changed_count,
				       ROW_NUMBER() OVER (
					       PARTITION BY positions.section_id, positions.from_signature, positions.to_signature
					       ORDER BY positions.position ASC
				       ) AS position_rank
				FROM position_rows positions
				JOIN top_families families
				  ON families.section_id = positions.section_id
				 AND families.from_signature = positions.from_signature
				 AND families.to_signature = positions.to_signature
			)
			SELECT families.section_id, families.from_signature, families.to_signature,
			       families.transition_count, families.changed_position_count,
			       ranked.position, ranked.changed_count, ranked.position_rank
			FROM top_families families
			LEFT JOIN ranked_positions ranked
			  ON ranked.section_id = families.section_id
			 AND ranked.from_signature = families.from_signature
			 AND ranked.to_signature = families.to_signature
			 AND (${positionSelection})
			ORDER BY families.transition_count DESC, families.from_signature ASC, families.to_signature ASC,
			         families.section_id ASC, ranked.position ASC`
		).all(params) as Array<{
			section_id: string;
			from_signature: string;
			to_signature: string;
			transition_count: number;
			changed_position_count: number;
			position: number | null;
			changed_count: number | null;
			position_rank: number | null;
		}>;

		type TransitionGroup = {
			fromSignature: string;
			toSignature: string;
			sectionId: string;
			count: number;
			changedPositionCount: number;
			boundedChangedPositions: Set<number>;
			changedCounts: Map<number, number>;
		};
		const groups = new Map<string, TransitionGroup>();
		for (const row of rows) {
			const key = `${row.section_id}\u0000${row.from_signature}\u0000${row.to_signature}`;
			const group = groups.get(key) ?? {
				fromSignature: row.from_signature,
				toSignature: row.to_signature,
				sectionId: row.section_id,
				count: row.transition_count,
				changedPositionCount: row.changed_position_count,
				boundedChangedPositions: new Set<number>(),
				changedCounts: new Map<number, number>()
			};
			if (row.position !== null) {
				group.changedCounts.set(row.position, row.changed_count ?? 0);
				if ((row.position_rank ?? MAX_TRANSITION_CHANGED_POSITION_SET + 1) <= MAX_TRANSITION_CHANGED_POSITION_SET) {
					group.boundedChangedPositions.add(row.position);
				}
			}
			groups.set(key, group);
		}

		return [...groups.values()].map(group => {
			const boundedChangedPositions = [...group.boundedChangedPositions].sort((left, right) => left - right);
			const positionsForCounts = requestedPositions.length
				? requestedPositions
				: boundedChangedPositions;
			const changedPositionCounts = positionsForCounts.map(position => ({
				position,
				changedCount: group.changedCounts.get(position) ?? 0
			}));
			const changedPercentages = changedPositionCounts.map(item => ({
				position: item.position,
				percentage: group.count ? Math.round((item.changedCount / group.count) * 100) : 0
			}));
			return {
				fromSignature: group.fromSignature,
				toSignature: group.toSignature,
				count: group.count,
				transitionCount: group.count,
				requestedPositions,
				changedPositionCounts,
				changedPercentages,
				changedPositions: boundedChangedPositions,
				changedPositionCount: group.changedPositionCount,
				...(group.changedPositionCount > boundedChangedPositions.length ? { changedPositionSetTruncated: true } : {}),
				sectionId: group.sectionId
			};
		});
	}

	getTransitions(input: AgentTransitionsInput): AgentResponse<AgentTransitionsResult> {
		const captureId = requiredText(input.captureId, "captureId");
		const requested: Partial<AgentSnapshotReference> = {
			...(input.profileId ? { profileId: requiredText(input.profileId, "profileId") } : {}),
			...(input.profileVersion === undefined ? {} : { profileVersion: optionalNonNegativeInteger(input.profileVersion, "profileVersion") }),
			...(input.sourceDataRevision === undefined ? {} : { sourceDataRevision: optionalNonNegativeInteger(input.sourceDataRevision, "sourceDataRevision") })
		};
		const sourceSignature = normalizedSignature(input.sourceSignature ?? input.fromSignature, "sourceSignature");
		const destinationSignature = normalizedSignature(input.destinationSignature ?? input.toSignature, "destinationSignature");
		const sectionId = input.sectionId === undefined ? undefined : requiredText(input.sectionId, "sectionId");
		const changedPositions = normalizedChangedPositions(input.changedPositions);
		const changedPositionMatch = normalizedChangedPositionMatch(input.changedPositionMatch);
		const minimumCount = input.minimumCount === undefined ? 1 : boundedLimit(input.minimumCount, 1, Number.MAX_SAFE_INTEGER, "minimumCount");
		const hasIndexedFilters = Boolean(sectionId || changedPositions.length);
		const cursor = input.cursor
			? decodeAgentCursor(input.cursor, "transitions", hasIndexedFilters ? ["count", "fromSignature", "toSignature", "sectionId"] : ["count", "fromSignature", "toSignature"])
			: undefined;
		const cursorFilters = {
			captureId,
			sourceSignature,
			destinationSignature,
			sectionId,
			changedPositions,
			changedPositionMatch,
			minimumCount
		};
		const appliedFilters = { ...cursorFilters, requested };
		if (cursor?.snapshot) {
			for (const field of ["profileId", "profileVersion", "sourceDataRevision"] as const) {
				const requestedValue = requested[field];
				if (requestedValue !== undefined && requestedValue !== cursor.snapshot[field]) {
					throw new AgentQueryError("invalid-cursor", "The pagination cursor is bound to a different profile revision", { reason: "snapshot-mismatch", field });
				}
			}
		}
		const resolvedRequest = cursor?.snapshot ? { ...cursor.snapshot, ...requested } : requested;
		const { profile, snapshot } = this.resolveAnalysisProfile(captureId, resolvedRequest);
		if (cursor) {
			assertCursorFilters(cursor, cursorFilters, cursor.snapshot);
			if (stableJson(cursor.snapshot) !== stableJson(snapshot)) {
				throw new AgentQueryError("invalid-cursor", "The pagination cursor is bound to a different profile revision", { reason: "snapshot-mismatch" });
			}
		}

		const requestedLimit = boundedLimit(input.limit, DEFAULT_CAPTURE_DISCOVERY_LIMIT, MAX_CAPTURE_DISCOVERY_LIMIT);
		if (hasIndexedFilters) {
			const pageTransitions = this.readIndexedTransitions(profile.id, {
				...input,
				captureId,
				...(sourceSignature ? { sourceSignature } : {}),
				...(destinationSignature ? { destinationSignature } : {}),
				...(sectionId ? { sectionId } : {}),
				changedPositions,
				changedPositionMatch
			}, minimumCount, requestedLimit, cursor);
			const response = selectSizeBoundedPage(pageTransitions, requestedLimit, (pageRows, page) => {
				const last = pageRows.at(-1);
				const hasMore = pageTransitions.length > pageRows.length;
				const nextCursor = hasMore && last
					? encodeAgentCursor({
						contractVersion: 1,
						scope: "transitions",
						filters: cursorFilters,
						snapshot,
						key: { count: last.count, fromSignature: last.fromSignature, toSignature: last.toSignature, sectionId: last.sectionId ?? null }
					})
					: undefined;
				return makeAgentResponse({
					data: { transitions: pageRows },
					appliedFilters,
					snapshot,
					requestedLimit: page.requestedLimit,
					effectiveLimit: page.effectiveLimit,
					returned: pageRows.length,
					nextCursor,
					truncationReason: page.truncationReason,
					truncated: Boolean(page.truncationReason),
					suggestedOperations: pageRows.length ? [{ tool: "query_messages", reason: "Inspect frames that participate in a selected transition", arguments: { captureId, profileId: snapshot.profileId, profileVersion: snapshot.profileVersion, sourceDataRevision: snapshot.sourceDataRevision, exactSignature: pageRows[0].fromSignature } }] : []
				});
			});
			return response;
		}

		const clauses = ["profile_id = @profileId", "count >= @minimumCount"];
		const params: Record<string, unknown> = { profileId: profile.id, minimumCount, limit: requestedLimit + 1 };
		if (sourceSignature) { clauses.push("from_signature = @sourceSignature"); params.sourceSignature = sourceSignature; }
		if (destinationSignature) { clauses.push("to_signature = @destinationSignature"); params.destinationSignature = destinationSignature; }
		const cursorSql = cursor ? " AND (count < @cursorCount OR (count = @cursorCount AND (from_signature > @cursorFromSignature OR (from_signature = @cursorFromSignature AND to_signature > @cursorToSignature))))" : "";
		if (cursor) {
			params.cursorCount = cursor.key.count;
			params.cursorFromSignature = cursor.key.fromSignature;
			params.cursorToSignature = cursor.key.toSignature;
		}
		const rows = this.database.prepare(
			`SELECT from_signature, to_signature, count, diffs
			 FROM frame_transitions WHERE ${clauses.join(" AND ")}${cursorSql}
			 ORDER BY count DESC, from_signature ASC, to_signature ASC LIMIT @limit`
		).all(params) as Array<{ from_signature: string; to_signature: string; count: number; diffs: number }>;
		const pageRows = rows.slice(0, requestedLimit);
		const hasMore = rows.length > pageRows.length;
		const transitions = pageRows.map(row => ({
			fromSignature: row.from_signature,
			toSignature: row.to_signature,
			count: row.count,
			transitionCount: row.count,
			requestedPositions: [],
			changedPositionCounts: [],
			changedPercentages: [],
			changedPositions: [],
			changedPositionCount: row.diffs
		}));
		const last = pageRows.at(-1);
		const nextCursor = hasMore && last
			? encodeAgentCursor({ contractVersion: 1, scope: "transitions", filters: cursorFilters, snapshot, key: { count: last.count, fromSignature: last.from_signature, toSignature: last.to_signature } })
			: undefined;
		const response = makeAgentResponse({
			data: { transitions },
			appliedFilters,
			snapshot,
			requestedLimit,
			effectiveLimit: transitions.length,
			returned: transitions.length,
			nextCursor,
			truncationReason: hasMore ? "page-limit" : undefined,
			truncated: hasMore,
			suggestedOperations: transitions.length ? [{ tool: "query_messages", reason: "Inspect frames that participate in a selected transition", arguments: { captureId, profileId: snapshot.profileId, profileVersion: snapshot.profileVersion, sourceDataRevision: snapshot.sourceDataRevision, exactSignature: transitions[0].fromSignature } }] : []
		});
		assertEncodedResponseSize(response);
		return response;
	}

	private resolveDifferentialSnapshot(reference: AgentSnapshotReference): AgentSnapshotReference {
		const captureId = requiredText(reference?.captureId, "snapshot.captureId");
		const profileId = requiredText(reference?.profileId, "snapshot.profileId");
		const profileVersion = optionalNonNegativeInteger(reference?.profileVersion, "snapshot.profileVersion");
		const sourceDataRevision = optionalNonNegativeInteger(reference?.sourceDataRevision, "snapshot.sourceDataRevision");
		if (profileVersion === undefined || sourceDataRevision === undefined) {
			throw new AgentQueryError("invalid-input", "Differential snapshots require captureId, profileId, profileVersion, and sourceDataRevision");
		}
		return this.resolveAnalysisProfile(captureId, { profileId, profileVersion, sourceDataRevision }).snapshot;
	}

	private assertDifferentialScopeExists(
		scope: NormalizedDifferentialScope,
		baselineProfileId: string,
		changedProfileId: string
	): void {
		if (scope.sectionId === undefined) return;
		const exists = (profileId: string): boolean => Boolean(this.database.prepare(
			"SELECT 1 FROM framing_sections WHERE profile_id = @profileId AND id = @sectionId LIMIT 1"
		).get({ profileId, sectionId: scope.sectionId }));
		const baselineExists = exists(baselineProfileId);
		const changedExists = exists(changedProfileId);
		if (!baselineExists || !changedExists) {
			throw new AgentQueryError(
				"invalid-input",
				"scope.sectionId must identify a section in both pinned snapshots; use baseline.filters.sectionId and changed.filters.sectionId for snapshot-local section IDs",
				{ sectionId: scope.sectionId, baselineExists, changedExists }
			);
		}
	}

	private prepareDifferentialFrames(
		profileId: string,
		filters: NormalizedDifferentialMessageFilters,
		scope: NormalizedDifferentialScope,
		parameterPrefix: string
	): DifferentialFramePlan {
		const filterPredicate = differentialFramePredicate(filters, `${parameterPrefix}Filter`);
		const scopePredicate = differentialFramePredicate(scope, `${parameterPrefix}Scope`);
		const predicates = `${filterPredicate.sql}${scopePredicate.sql}`;
		const predicateParameters = {
			profileId,
			...filterPredicate.params,
			...scopePredicate.params
		};
		const totalFrameCount = (this.database.prepare(
			"SELECT COUNT(*) AS count FROM materialized_frames WHERE profile_id = @profileId"
		).get({ profileId }) as { count: number }).count;
		const filteredFrameCount = (this.database.prepare(
			`SELECT COUNT(*) AS count FROM materialized_frames AS frames WHERE frames.profile_id = @profileId${predicates}`
		).get(predicateParameters) as { count: number }).count;
		if (filteredFrameCount > MAX_DIFFERENTIAL_FRAMES) {
			throw new AgentQueryError(
				"invalid-input",
				`Differential alignment accepts at most ${MAX_DIFFERENTIAL_FRAMES} filtered frames per side`,
				{ maximumFramesPerSide: MAX_DIFFERENTIAL_FRAMES, filteredFrameCount, parameterPrefix }
			);
		}
		const analyzedElementCount = (this.database.prepare(
			`SELECT COALESCE(SUM(
				json_array_length(frames.bytes_json)
				+ json_array_length(frames.timestamps_json)
				+ json_array_length(frames.raw_offsets_json)
				+ json_array_length(frames.directions_json)
			), 0) AS count
			 FROM materialized_frames AS frames
			 WHERE frames.profile_id = @profileId${predicates}`
		).get(predicateParameters) as { count: number }).count;
		const rawOrigin = (this.database.prepare(
			`SELECT MIN(CAST(json_extract(raw_offsets_json, '$[0]') AS INTEGER)) AS raw_origin
			 FROM materialized_frames WHERE profile_id = @profileId`
		).get({ profileId }) as { raw_origin: number | null }).raw_origin;
		const sectionRows = this.database.prepare(
			`SELECT id, position, start_offset, framing_mode, frame_length, marker_bytes,
					marker_position, time_gap_ms, collapse_runs, collapsed
			 FROM framing_sections WHERE profile_id = @profileId ORDER BY position`
		).all({ profileId }) as DifferentialSectionRow[];
		const sectionKeys = new Map(sectionRows.map(section => [section.id, differentialSectionKey(section, rawOrigin)]));
		return {
			profileId,
			parameterPrefix,
			predicates,
			predicateParameters,
			totalFrameCount,
			filteredFrameCount,
			analyzedElementCount,
			excludedFrameCount: Math.max(0, totalFrameCount - filteredFrameCount),
			rawOrigin,
			sectionKeys
		};
	}

	private readDifferentialFrames(plan: DifferentialFramePlan): { frames: DifferentialFrame[]; totalFrameCount: number; filteredFrameCount: number; excludedFrameCount: number; analyzedElementCount: number } {
		if (plan.analyzedElementCount > MAX_DIFFERENTIAL_ANALYZED_ELEMENTS) {
			throw new AgentQueryError(
				"invalid-input",
				`Differential analysis exceeds the ${MAX_DIFFERENTIAL_ANALYZED_ELEMENTS}-element byte/position budget`,
				{ maximumAnalyzedElements: MAX_DIFFERENTIAL_ANALYZED_ELEMENTS, analyzedElements: plan.analyzedElementCount, parameterPrefix: plan.parameterPrefix }
			);
		}
		const rows = this.database.prepare(
			`SELECT id, ordinal, section_id, raw_offsets_json, bytes_json, timestamps_json,
			        directions_json, hidden, signature
			 FROM materialized_frames AS frames
			 WHERE frames.profile_id = @profileId${plan.predicates}
			 ORDER BY ordinal ASC, id ASC
			 LIMIT @differentialLimit`
		).all({ ...plan.predicateParameters, differentialLimit: MAX_DIFFERENTIAL_FRAMES + 1 }) as Array<{
			id: string;
			ordinal: number;
			section_id: string;
			raw_offsets_json: string;
			bytes_json: string;
			timestamps_json: string;
			directions_json: string;
			hidden: number;
			signature: string;
		}>;
		const frames = rows.map(row => makeDifferentialFrame({
			id: row.id,
			ordinal: row.ordinal,
			sectionId: row.section_id,
			sectionKey: plan.sectionKeys.get(row.section_id),
			bytes: jsonArray<number>(row.bytes_json).map(Number),
			timestamps: jsonArray<number>(row.timestamps_json).map(Number),
			directions: jsonArray<string>(row.directions_json).map(String),
			hidden: Boolean(row.hidden),
			signature: row.signature,
			rawOffsets: jsonArray<number>(row.raw_offsets_json).map(Number)
		}));
		return {
			frames,
			totalFrameCount: plan.totalFrameCount,
			filteredFrameCount: plan.filteredFrameCount,
			excludedFrameCount: plan.excludedFrameCount,
			analyzedElementCount: plan.analyzedElementCount
		};
	}

	analyzeCaptureDifference(input: AgentCaptureDifferenceInput): AgentResponse<AgentCaptureDifferenceResult> {
		const baselineLabel = requiredText(input?.baseline?.label, "baseline.label");
		const changedLabel = requiredText(input?.changed?.label, "changed.label");
		const baselineSnapshot = this.resolveDifferentialSnapshot(input?.baseline?.snapshot);
		const changedSnapshot = this.resolveDifferentialSnapshot(input?.changed?.snapshot);
		const baselineFilters = normalizeDifferentialMessageFilters(input.baseline.filters);
		const changedFilters = normalizeDifferentialMessageFilters(input.changed.filters);
		const scope = normalizeDifferentialScope(input.scope);
		if (!input.alignment || typeof input.alignment !== "object") {
			throw new AgentQueryError("invalid-input", "alignment is required", { label: "alignment" });
		}
		const requestedMode = input.alignment.mode;
		if (!AGENT_DIFFERENTIAL_ALIGNMENT_MODES.includes(requestedMode as AgentDifferentialAlignmentMode)) {
			throw new AgentQueryError("invalid-input", "alignment.mode must be ordinal, raw-relative, timestamp-nearest, or signature-sequence", { mode: requestedMode });
		}
		const mode = requestedMode as AgentDifferentialAlignmentMode;
		if (mode !== "timestamp-nearest" && input.alignment.maximumTimestampDeltaMs !== undefined) {
			throw new AgentQueryError("invalid-input", "maximumTimestampDeltaMs is only valid for timestamp-nearest alignment", { mode });
		}
		const requestedTimestampDelta = optionalFiniteNumber(input.alignment.maximumTimestampDeltaMs, "maximumTimestampDeltaMs");
		if (requestedTimestampDelta !== undefined && requestedTimestampDelta < 0) {
			throw new AgentQueryError("invalid-input", "maximumTimestampDeltaMs must be non-negative", { maximumTimestampDeltaMs: requestedTimestampDelta });
		}
		if (requestedTimestampDelta !== undefined && requestedTimestampDelta > 60_000) {
			throw new AgentQueryError("invalid-input", "maximumTimestampDeltaMs must not exceed 60000", { maximum: 60_000 });
		}
		const maximumTimestampDeltaMs = mode === "timestamp-nearest" ? requestedTimestampDelta ?? 1_000 : undefined;
		const minimumSupport = boundedLimit(input.minimumSupport, 1, MAX_DIFFERENTIAL_FRAMES, "minimumSupport");
		const requestedLimit = boundedLimit(input.limit, DEFAULT_CAPTURE_DISCOVERY_LIMIT, MAX_CAPTURE_DISCOVERY_LIMIT, "limit");
		const cursorFilters = {
			baseline: { snapshot: baselineSnapshot, label: baselineLabel, filters: baselineFilters },
			changed: { snapshot: changedSnapshot, label: changedLabel, filters: changedFilters },
			alignment: { mode, ...(maximumTimestampDeltaMs === undefined ? {} : { maximumTimestampDeltaMs }) },
			scope,
			minimumSupport
		};
		const cursor = input.cursor ? decodeAgentCursor(input.cursor, "capture-difference", ["score", "sectionId", "frameFamily", "changedFrameFamily", "bytePosition", "bitMask"]) : undefined;
		if (cursor) {
			assertCursorFilters(cursor, cursorFilters, baselineSnapshot);
			if (stableJson(cursor.snapshot) !== stableJson(baselineSnapshot)) {
				throw new AgentQueryError("invalid-cursor", "The pagination cursor is bound to a different baseline snapshot", { reason: "snapshot-mismatch" });
			}
		}

		this.assertDifferentialScopeExists(scope, baselineSnapshot.profileId, changedSnapshot.profileId);
		// Prepare both sides before materializing any JSON arrays. The aggregate
		// budget is intentionally total across the pinned snapshots, not merely a
		// per-side frame-count check.
		const baselinePlan = this.prepareDifferentialFrames(baselineSnapshot.profileId, baselineFilters, scope, "baseline");
		const changedPlan = this.prepareDifferentialFrames(changedSnapshot.profileId, changedFilters, scope, "changed");
		const analyzedElementCount = baselinePlan.analyzedElementCount + changedPlan.analyzedElementCount;
		if (analyzedElementCount > MAX_DIFFERENTIAL_ANALYZED_ELEMENTS) {
			throw new AgentQueryError(
				"invalid-input",
				`Differential analysis exceeds the ${MAX_DIFFERENTIAL_ANALYZED_ELEMENTS}-element total byte/position budget`,
				{
					maximumAnalyzedElements: MAX_DIFFERENTIAL_ANALYZED_ELEMENTS,
					analyzedElements: analyzedElementCount,
					baselineAnalyzedElements: baselinePlan.analyzedElementCount,
					changedAnalyzedElements: changedPlan.analyzedElementCount
				}
			);
		}
		const baselineRead = this.readDifferentialFrames(baselinePlan);
		const changedRead = this.readDifferentialFrames(changedPlan);
		if (mode === "signature-sequence" && (baselineRead.frames.length > MAX_SIGNATURE_ALIGNMENT_FRAMES || changedRead.frames.length > MAX_SIGNATURE_ALIGNMENT_FRAMES)) {
			throw new AgentQueryError(
				"invalid-input",
				`signature-sequence alignment accepts at most ${MAX_SIGNATURE_ALIGNMENT_FRAMES} filtered frames per side`,
				{ maximumFramesPerSide: MAX_SIGNATURE_ALIGNMENT_FRAMES, baselineFrames: baselineRead.frames.length, changedFrames: changedRead.frames.length }
			);
		}
		let alignmentResult: {
			pairs: readonly DifferentialAlignedPair[];
			baselineUnpaired: readonly DifferentialFrame[];
			changedUnpaired: readonly DifferentialFrame[];
			insertedFrameCount: number;
			deletedFrameCount: number;
		};
		switch (mode) {
			case "ordinal":
				alignmentResult = alignOrdinal(baselineRead.frames, changedRead.frames, mode);
				break;
			case "raw-relative":
				alignmentResult = alignRawRelative(baselineRead.frames, changedRead.frames, baselinePlan.rawOrigin, changedPlan.rawOrigin);
				break;
			case "timestamp-nearest":
				alignmentResult = alignTimestampNearest(baselineRead.frames, changedRead.frames, maximumTimestampDeltaMs!);
				break;
			case "signature-sequence":
				alignmentResult = alignSignatureSequence(baselineRead.frames, changedRead.frames);
				break;
		}
		const evidence = calculateDifferentialEvidence(alignmentResult.pairs, minimumSupport);
		const alignmentSummary = {
			mode,
			pairedFrameCount: alignmentResult.pairs.length,
			baselineUnpairedFrameCount: alignmentResult.baselineUnpaired.length,
			changedUnpairedFrameCount: alignmentResult.changedUnpaired.length,
			insertedFrameCount: alignmentResult.insertedFrameCount,
			deletedFrameCount: alignmentResult.deletedFrameCount,
			excludedFrameCount: { baseline: baselineRead.excludedFrameCount, changed: changedRead.excludedFrameCount },
			unpairedFrameCount: { baseline: alignmentResult.baselineUnpaired.length, changed: alignmentResult.changedUnpaired.length },
			pairCompatibility: evidence.pairCompatibility,
			...(maximumTimestampDeltaMs === undefined ? {} : { maximumTimestampDeltaMs })
		};
		const afterCursor = cursor
			? evidence.candidateFields.filter(candidate => {
				const score = Number(cursor.key.score);
				const sectionId = String(cursor.key.sectionId ?? "");
				const frameFamily = String(cursor.key.frameFamily ?? "");
				const changedFrameFamily = String(cursor.key.changedFrameFamily ?? "");
				const bytePosition = Number(cursor.key.bytePosition);
				const mask = String(cursor.key.bitMask ?? "");
				if (candidate.score < score) return true;
				if (candidate.score > score) return false;
				if (candidate.sectionId !== sectionId) return candidate.sectionId > sectionId;
				if (candidate.frameFamily !== frameFamily) return candidate.frameFamily > frameFamily;
				if (candidate.changedFrameFamily !== changedFrameFamily) return candidate.changedFrameFamily > changedFrameFamily;
				if (candidate.bytePosition !== bytePosition) return candidate.bytePosition > bytePosition;
				return candidate.bitMask > mask;
			})
			: [...evidence.candidateFields];
		return selectSizeBoundedPage(afterCursor, requestedLimit, (pageRows, page) => {
			const hasMore = afterCursor.length > pageRows.length;
			const last = pageRows.at(-1);
			const nextCursor = hasMore && last
				? encodeAgentCursor({
					contractVersion: 1,
					scope: "capture-difference",
					filters: cursorFilters,
					snapshot: baselineSnapshot,
					key: { score: last.score, sectionId: last.sectionId, frameFamily: last.frameFamily, changedFrameFamily: last.changedFrameFamily, bytePosition: last.bytePosition, bitMask: last.bitMask }
				})
				: undefined;
			const responseData: AgentCaptureDifferenceResult = {
				baseline: { label: baselineLabel, snapshot: baselineSnapshot, totalFrameCount: baselineRead.totalFrameCount, filteredFrameCount: baselineRead.filteredFrameCount, excludedFrameCount: baselineRead.excludedFrameCount, analyzedElementCount: baselineRead.analyzedElementCount },
				changed: { label: changedLabel, snapshot: changedSnapshot, totalFrameCount: changedRead.totalFrameCount, filteredFrameCount: changedRead.filteredFrameCount, excludedFrameCount: changedRead.excludedFrameCount, analyzedElementCount: changedRead.analyzedElementCount },
				alignment: alignmentSummary,
				differenceSummary: evidence.differenceSummary,
				candidateFields: pageRows
			};
			return makeAgentResponse({
				data: responseData,
				appliedFilters: cursorFilters,
				snapshot: baselineSnapshot,
				requestedLimit: page.requestedLimit,
				effectiveLimit: page.effectiveLimit,
				returned: pageRows.length,
				nextCursor,
				truncationReason: page.truncationReason,
				truncated: hasMore || evidence.differenceSummary.truncated || Boolean(page.truncationReason),
				suggestedOperations: pageRows.length ? [
					{ tool: "get_message_context", reason: "Inspect the bounded baseline evidence IDs for the highest-ranked candidate", arguments: { frameId: pageRows[0]!.evidence.baselineFrameIds[0], captureId: baselineSnapshot.captureId, profileId: baselineSnapshot.profileId, profileVersion: baselineSnapshot.profileVersion, sourceDataRevision: baselineSnapshot.sourceDataRevision } },
					{ tool: "get_message_context", reason: "Inspect the bounded changed evidence IDs for the highest-ranked candidate", arguments: { frameId: pageRows[0]!.evidence.changedFrameIds[0], captureId: changedSnapshot.captureId, profileId: changedSnapshot.profileId, profileVersion: changedSnapshot.profileVersion, sourceDataRevision: changedSnapshot.sourceDataRevision } }
				] : []
			});
		});
	}

	readRawBytes(input: AgentRawReadInput): AgentResponse<AgentRawRead> {
		const captureId = requiredText(input.captureId, "captureId");
		const startOffset = optionalNonNegativeInteger(input.rawOffset ?? input.offset, "rawOffset");
		if (startOffset === undefined) throw new AgentQueryError("invalid-input", "rawOffset is required", { label: "rawOffset" });
		const requestedLength = input.length ?? input.byteCount;
		if (requestedLength !== undefined && requestedLength > 4096) throw new AgentQueryError("invalid-input", "length must not exceed 4096 bytes", { maximum: 4096 });
		const length = boundedLimit(requestedLength, 1024, 4096, "length");
		const hiddenPolicy = input.hiddenPolicy ?? "mask";
		const requestedEndOffset = startOffset + length - 1;
		const available = this.database.prepare(
			`SELECT MIN(start_offset) AS start_offset,
			        MAX(start_offset + byte_count - 1) AS end_offset
			 FROM raw_chunks WHERE capture_id = @captureId`
		).get({ captureId }) as { start_offset: number | null; end_offset: number | null };
		if (available.start_offset === null || available.end_offset === null) throw new AgentQueryError("evidence-missing", "The requested capture has no retained raw bytes", { captureId });
		const chunks = this.database.prepare(
			`SELECT start_offset, byte_count, bytes, timestamps_json, directions_json, hidden_json
			 FROM raw_chunks
			 WHERE capture_id = @captureId
			   AND start_offset <= @requestedEndOffset
			   AND start_offset + byte_count > @startOffset
			 ORDER BY start_offset ASC
			 LIMIT @limit`
		).all({ captureId, requestedEndOffset, startOffset, limit: length + 1 }) as RawChunkRow[];
		if (!chunks.length) throw new AgentQueryError("evidence-missing", "The requested raw range is not retained", { captureId, startOffset, requestedEndOffset, available });
		const visibilityRows = this.database.prepare(
			`SELECT raw_offset, hidden FROM raw_byte_visibility
			 WHERE capture_id = @captureId AND raw_offset BETWEEN @startOffset AND @requestedEndOffset`
		).all({ captureId, startOffset, requestedEndOffset }) as Array<{ raw_offset: number; hidden: number }>;
		const visibilityOverrides = new Map(visibilityRows.map(row => [row.raw_offset, Boolean(row.hidden)]));
		const values: Array<{ offset: number; byte: number; timestamp: number | null; direction: string; hidden: boolean }> = [];
		for (const chunk of chunks) {
			const bytes = Buffer.isBuffer(chunk.bytes) ? chunk.bytes : Buffer.from(chunk.bytes);
			const timestamps = jsonArray<number>(chunk.timestamps_json);
			const directions = jsonArray<string>(chunk.directions_json);
			const hidden = jsonArray<boolean>(chunk.hidden_json);
			const first = Math.max(startOffset, chunk.start_offset);
			const last = Math.min(requestedEndOffset, chunk.start_offset + chunk.byte_count - 1);
			for (let offset = first; offset <= last; offset += 1) {
				const index = offset - chunk.start_offset;
				values.push({
					offset,
					byte: bytes[index] ?? 0,
					timestamp: typeof timestamps[index] === "number" && Number.isFinite(timestamps[index]) ? timestamps[index] : null,
					direction: String(directions[index] ?? "unknown").trim().toUpperCase() || "UNKNOWN",
					hidden: visibilityOverrides.get(offset) ?? Boolean(hidden[index])
				});
			}
		}
		values.sort((left, right) => left.offset - right.offset);
		const exposedValues = hiddenPolicy === "omit" ? values.filter(value => !value.hidden) : values;
		const hex = exposedValues.map(value => value.hidden && hiddenPolicy === "mask" ? "??" : Number(value.byte).toString(16).padStart(2, "0").toUpperCase()).join(" ");
		const timestampValues = exposedValues.map(value => value.timestamp);
		const base = timestampValues[0] ?? null;
		const deltas = timestampValues.slice(1).map((timestamp, index) => timestamp !== null && timestampValues[index] !== null ? timestamp - (timestampValues[index] as number) : null);
		const snapshot = this.activeAnalysisSnapshot(captureId);
		const messageQueryArguments = {
			captureId,
			rawOffsetFrom: startOffset,
			rawOffsetTo: requestedEndOffset,
			...(snapshot ? {
				profileId: snapshot.profileId,
				profileVersion: snapshot.profileVersion,
				sourceDataRevision: snapshot.sourceDataRevision
			} : {})
		};
		const response = makeAgentResponse({
			data: {
				requestedBounds: { startOffset, endOffset: requestedEndOffset },
				availableBounds: { startOffset: available.start_offset, endOffset: available.end_offset },
				returnedByteCount: values.length,
				exposedByteCount: exposedValues.length,
				hex,
				timestamps: { base, deltas },
				directions: runLength(exposedValues.map(value => value.direction), (left, right) => left === right),
				visibility: runLength(exposedValues.map(value => value.hidden), (left, right) => left === right).map(run => ({ hidden: run.value, count: run.count })),
				truncated: startOffset < available.start_offset || requestedEndOffset > available.end_offset || values.length < length
			},
			appliedFilters: { captureId, rawOffset: startOffset, length, hiddenPolicy },
			truncated: startOffset < available.start_offset || requestedEndOffset > available.end_offset || values.length < length,
			suggestedOperations: [{ tool: "query_messages", reason: "Find interpreted frames overlapping this range with reverse raw-range lookup", arguments: messageQueryArguments }]
		});
		assertEncodedResponseSize(response);
		return response;
	}

	private resolveComparisonSnapshot(reference: AgentComparisonSnapshot): AgentComparisonSnapshot {
		const captureId = requiredText(reference.captureId, "captureId");
		const profileId = requiredText(reference.profileId, "profileId");
		const profileVersion = optionalNonNegativeInteger(reference.profileVersion, "profileVersion");
		const sourceDataRevision = optionalNonNegativeInteger(reference.sourceDataRevision, "sourceDataRevision");
		if (profileVersion === undefined || sourceDataRevision === undefined) throw new AgentQueryError("invalid-input", "Comparison snapshots require profileVersion and sourceDataRevision");
		const resolved = this.resolveAnalysisProfile(captureId, { profileId, profileVersion, sourceDataRevision });
		return resolved.snapshot;
	}

	private comparisonPageLimit(input: AgentCompareCapturesInput, category: AgentComparisonCategory): number {
		const requested = input.limits?.[category];
		return boundedLimit(requested, 20, 100, `${category} limit`);
	}

	private comparisonCursor(input: AgentCompareCapturesInput, category: AgentComparisonCategory, keyFields: readonly string[], filters: Record<string, unknown>): AgentCursorPayload | undefined {
		const cursor = input.cursors?.[category];
		if (!cursor) return undefined;
		const decoded = decodeAgentCursor(cursor, `comparison:${category}`, keyFields);
		assertCursorFilters(decoded, filters, decoded.snapshot);
		return decoded;
	}

	private comparisonSnapshotArguments(snapshot: AgentComparisonSnapshot): Record<string, unknown> {
		return {
			captureId: snapshot.captureId,
			profileId: snapshot.profileId,
			profileVersion: snapshot.profileVersion,
			sourceDataRevision: snapshot.sourceDataRevision
		};
	}

	private comparisonMetadata(left: AgentComparisonSnapshot, right: AgentComparisonSnapshot): Readonly<{ differences: readonly AgentComparisonDifference[] }> {
		const read = (profileId: string): Record<string, unknown> => {
			const snapshot = this.database.prepare(
				`SELECT name, description, controller_view, lifecycle, byte_count, baud_rate,
				        input_format, folder_id, data_revision, metadata_revision, content_revision,
				        parameters_json
				 FROM framing_profile_metadata_snapshots WHERE profile_id = @profileId`
			).get({ profileId }) as {
				name: string;
				description: string;
				controller_view: string;
				lifecycle: string;
				byte_count: number;
				baud_rate: number | null;
				input_format: string;
				folder_id: string | null;
				data_revision: number;
				metadata_revision: number;
				content_revision: number;
				parameters_json: string;
			} | undefined;
			if (!snapshot) throw new AgentQueryError("evidence-missing", "The requested profile has no pinned metadata snapshot", { profileId });
			const parameters = jsonArray<unknown>(snapshot.parameters_json).flatMap(parameter => {
				if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) return [];
				const record = parameter as Record<string, unknown>;
				const key = optionalString(record.key);
				return key ? [{ key, value: stringValue(record.value) }] : [];
			});
			return {
				name: snapshot.name,
				description: snapshot.description,
				controller_view: snapshot.controller_view,
				lifecycle: snapshot.lifecycle,
				byte_count: snapshot.byte_count,
				baud_rate: snapshot.baud_rate,
				input_format: snapshot.input_format,
				folder_id: snapshot.folder_id,
				data_revision: snapshot.data_revision,
				metadata_revision: snapshot.metadata_revision,
				content_revision: snapshot.content_revision,
				parameters: parameters.slice(0, 32),
				parametersTruncated: parameters.length > 32
			};
		};
		const leftMetadata = read(left.profileId);
		const rightMetadata = read(right.profileId);
		const fields = [...new Set([...Object.keys(leftMetadata), ...Object.keys(rightMetadata)])].sort();
		return {
			differences: fields.flatMap(field => stableJson(leftMetadata[field]) === stableJson(rightMetadata[field]) ? [] : [{ field, left: leftMetadata[field] ?? null, right: rightMetadata[field] ?? null }])
		};
	}

	private comparisonSections(left: AgentComparisonSnapshot, right: AgentComparisonSnapshot): Readonly<{ differences: readonly AgentComparisonDifference[] }> {
		const read = (profileId: string) => this.database.prepare(
			`SELECT position, start_offset, framing_mode, frame_length, marker_bytes, marker_position,
			        time_gap_ms, collapse_runs, collapsed
			 FROM framing_sections WHERE profile_id = @profileId ORDER BY position`
		).all({ profileId }) as Array<Record<string, unknown>>;
		const leftSections = read(left.profileId);
		const rightSections = read(right.profileId);
		const byPosition = (rows: Array<Record<string, unknown>>) => new Map(rows.map(row => [Number(row.position), row]));
		const leftByPosition = byPosition(leftSections);
		const rightByPosition = byPosition(rightSections);
		const positions = [...new Set([...leftByPosition.keys(), ...rightByPosition.keys()])].sort((a, b) => a - b);
		return {
			differences: positions.flatMap(position => {
				const leftSection = leftByPosition.get(position) ?? null;
				const rightSection = rightByPosition.get(position) ?? null;
				return stableJson(leftSection) === stableJson(rightSection) ? [] : [{ field: `section:${position}`, left: leftSection, right: rightSection }];
			})
		};
	}

	private comparisonSignatures(left: AgentComparisonSnapshot, right: AgentComparisonSnapshot, input: AgentCompareCapturesInput): AgentComparisonPage<AgentSignatureDelta> {
		const filters = { left, right, category: "signatures" };
		const cursor = this.comparisonCursor(input, "signatures", ["magnitude", "signature"], filters);
		const limit = this.comparisonPageLimit(input, "signatures");
		const params: Record<string, unknown> = { leftProfileId: left.profileId, rightProfileId: right.profileId, limit: limit + 1 };
		const cursorSql = cursor
			? " WHERE delta <> 0 AND (magnitude < @cursorMagnitude OR (magnitude = @cursorMagnitude AND signature > @cursorSignature))"
			: " WHERE delta <> 0";
		if (cursor) { params.cursorMagnitude = cursor.key.magnitude; params.cursorSignature = cursor.key.signature; }
		const rows = this.database.prepare(
			`WITH delta AS (
				SELECT left_rows.signature, left_rows.count AS left_count, COALESCE(right_rows.count, 0) AS right_count
				FROM frame_signatures left_rows
				LEFT JOIN frame_signatures right_rows ON right_rows.profile_id = @rightProfileId AND right_rows.signature = left_rows.signature
				WHERE left_rows.profile_id = @leftProfileId
				UNION ALL
				SELECT right_rows.signature, 0, right_rows.count
				FROM frame_signatures right_rows
				LEFT JOIN frame_signatures left_rows ON left_rows.profile_id = @leftProfileId AND left_rows.signature = right_rows.signature
				WHERE right_rows.profile_id = @rightProfileId AND left_rows.signature IS NULL
			), ranked AS (
				SELECT signature, left_count, right_count, right_count - left_count AS delta,
				       ABS(right_count - left_count) AS magnitude
				FROM delta
			)
			SELECT signature, left_count, right_count, delta, magnitude
			FROM ranked${cursorSql}
			ORDER BY magnitude DESC, signature ASC
			LIMIT @limit`
		).all(params) as Array<{ signature: string; left_count: number; right_count: number; delta: number; magnitude: number }>;
		const pageRows = rows.slice(0, limit);
		const items = pageRows.map(row => ({
			signature: row.signature,
			leftCount: row.left_count,
			rightCount: row.right_count,
			delta: row.delta
		}));
		const operationTemplates: AgentOperationTemplate[] = [
			{
				tool: "query_messages",
				reason: "Inspect matching frames in the left snapshot",
				fixedArguments: this.comparisonSnapshotArguments(left),
				argumentBindings: { exactSignature: "signature" }
			},
			{
				tool: "query_messages",
				reason: "Inspect matching frames in the right snapshot",
				fixedArguments: this.comparisonSnapshotArguments(right),
				argumentBindings: { exactSignature: "signature" }
			}
		];
		const hasMore = rows.length > pageRows.length;
		const last = pageRows.at(-1);
		const nextCursor = hasMore && last ? encodeAgentCursor({ contractVersion: 1, scope: "comparison:signatures", filters, snapshot: left, key: { magnitude: Math.abs(last.delta), signature: last.signature } }) : undefined;
		return { items, returned: items.length, ...(nextCursor ? { nextCursor } : {}), truncated: hasMore, operationTemplates };
	}

	private comparisonTransitions(left: AgentComparisonSnapshot, right: AgentComparisonSnapshot, input: AgentCompareCapturesInput): AgentComparisonPage<AgentTransitionDelta> {
		const filters = { left, right, category: "transitions" };
		const cursor = this.comparisonCursor(input, "transitions", ["magnitude", "fromSignature", "toSignature"], filters);
		const limit = this.comparisonPageLimit(input, "transitions");
		const params: Record<string, unknown> = { leftProfileId: left.profileId, rightProfileId: right.profileId, limit: limit + 1 };
		const cursorSql = cursor
			? " WHERE (left_count <> right_count OR left_diffs <> right_diffs) AND (magnitude < @cursorMagnitude OR (magnitude = @cursorMagnitude AND (from_signature > @cursorFromSignature OR (from_signature = @cursorFromSignature AND to_signature > @cursorToSignature))))"
			: " WHERE left_count <> right_count OR left_diffs <> right_diffs";
		if (cursor) { params.cursorMagnitude = cursor.key.magnitude; params.cursorFromSignature = cursor.key.fromSignature; params.cursorToSignature = cursor.key.toSignature; }
		const rows = this.database.prepare(
			`WITH delta AS (
				SELECT left_rows.from_signature, left_rows.to_signature, left_rows.count AS left_count, COALESCE(right_rows.count, 0) AS right_count,
				       left_rows.diffs AS left_diffs, COALESCE(right_rows.diffs, 0) AS right_diffs
				FROM frame_transitions left_rows
				LEFT JOIN frame_transitions right_rows ON right_rows.profile_id = @rightProfileId AND right_rows.from_signature = left_rows.from_signature AND right_rows.to_signature = left_rows.to_signature
				WHERE left_rows.profile_id = @leftProfileId
				UNION ALL
				SELECT right_rows.from_signature, right_rows.to_signature, 0, right_rows.count, 0, right_rows.diffs
				FROM frame_transitions right_rows
				LEFT JOIN frame_transitions left_rows ON left_rows.profile_id = @leftProfileId AND left_rows.from_signature = right_rows.from_signature AND left_rows.to_signature = right_rows.to_signature
				WHERE right_rows.profile_id = @rightProfileId AND left_rows.from_signature IS NULL
			), ranked AS (
				SELECT from_signature, to_signature, left_count, right_count, right_count - left_count AS delta,
				       left_diffs, right_diffs, ABS(right_count - left_count) AS magnitude
				FROM delta
			)
			SELECT from_signature, to_signature, left_count, right_count, delta, left_diffs, right_diffs, magnitude
			FROM ranked${cursorSql}
			ORDER BY magnitude DESC, from_signature ASC, to_signature ASC
			LIMIT @limit`
		).all(params) as Array<{ from_signature: string; to_signature: string; left_count: number; right_count: number; delta: number; left_diffs: number; right_diffs: number; magnitude: number }>;
		const pageRows = rows.slice(0, limit);
		const items = pageRows.map(row => ({
			fromSignature: row.from_signature,
			toSignature: row.to_signature,
			leftCount: row.left_count,
			rightCount: row.right_count,
			delta: row.delta,
			leftChangedPositions: row.left_diffs,
			rightChangedPositions: row.right_diffs
		}));
		const operationTemplates: AgentOperationTemplate[] = [
			{
				tool: "query_messages",
				reason: "Inspect frames that participate in the selected transition in the left snapshot",
				fixedArguments: this.comparisonSnapshotArguments(left),
				argumentBindings: { exactSignature: "fromSignature" }
			},
			{
				tool: "query_messages",
				reason: "Inspect frames that participate in the selected transition in the right snapshot",
				fixedArguments: this.comparisonSnapshotArguments(right),
				argumentBindings: { exactSignature: "fromSignature" }
			}
		];
		const hasMore = rows.length > pageRows.length;
		const last = pageRows.at(-1);
		const nextCursor = hasMore && last ? encodeAgentCursor({ contractVersion: 1, scope: "comparison:transitions", filters, snapshot: left, key: { magnitude: Math.abs(last.delta), fromSignature: last.from_signature, toSignature: last.to_signature } }) : undefined;
		return { items, returned: items.length, ...(nextCursor ? { nextCursor } : {}), truncated: hasMore, operationTemplates };
	}

	private comparisonBytePositions(left: AgentComparisonSnapshot, right: AgentComparisonSnapshot, input: AgentCompareCapturesInput): AgentComparisonPage<AgentBytePositionDelta> {
		const filters = { left, right, category: "byte-statistics" };
		const cursor = this.comparisonCursor(input, "byte-statistics", ["position"], filters);
		// A single position can contain every byte value on both sides, all eight
		// bit rows, and a vocabulary-change row for each value. Keep the complete
		// position item bounded so its page, cursor, and response envelope remain
		// within the normal encoded-response budget.
		const limit = Math.min(this.comparisonPageLimit(input, "byte-statistics"), MAX_BYTE_STATISTICS_COMPARISON_POSITIONS);
		const candidateLimit = Math.max(limit + 1, 100);
		const read = (profileId: string, pagePositions: readonly number[]) => {
			if (!pagePositions.length) return { vocabularyRows: [] as Array<{ position: number; value: number; count: number }>, bits: [] as Array<{ position: number; bit: number; percentage: number; variance: string }>, varianceRows: [] as Array<{ position: number; bit: number; percentage: number; variance: string }> };
			const placeholders = pagePositions.map((_position, index) => `@position${index}`);
			const queryParameters = { profileId, ...Object.fromEntries(pagePositions.map((position, index) => [`position${index}`, position])) };
			const vocabularyRows = this.database.prepare(`SELECT position, value, count FROM byte_statistics WHERE profile_id = @profileId AND position IN (${placeholders.join(", ")}) ORDER BY position, value`).all(queryParameters) as Array<{ position: number; value: number; count: number }>;
			const bitRows = this.database.prepare(`SELECT position, bit, percentage, variance FROM bit_statistics WHERE profile_id = @profileId AND position IN (${placeholders.join(", ")}) ORDER BY position, bit`).all(queryParameters) as Array<{ position: number; bit: number; percentage: number; variance: string }>;
			return { vocabularyRows, bits: bitRows, varianceRows: bitRows };
		};
		const buildItem = (position: number, leftRows: ReturnType<typeof read>, rightRows: ReturnType<typeof read>): AgentBytePositionDelta => {
			const leftVocabulary = leftRows.vocabularyRows.filter(row => row.position === position).map(row => ({ value: row.value, count: row.count }));
			const rightVocabulary = rightRows.vocabularyRows.filter(row => row.position === position).map(row => ({ value: row.value, count: row.count }));
			const values = [...new Set([...leftVocabulary, ...rightVocabulary].map(row => row.value))].sort((a, b) => a - b);
			const leftByValue = new Map(leftVocabulary.map(row => [row.value, row.count]));
			const rightByValue = new Map(rightVocabulary.map(row => [row.value, row.count]));
			const leftBits = leftRows.bits.filter(row => row.position === position).map(row => ({ bit: row.bit, percentage: row.percentage }));
			const rightBits = rightRows.bits.filter(row => row.position === position).map(row => ({ bit: row.bit, percentage: row.percentage }));
			return {
				position,
				leftVocabulary,
				rightVocabulary,
				vocabularyChanges: values.map(value => ({ value, leftCount: leftByValue.get(value) ?? 0, rightCount: rightByValue.get(value) ?? 0, delta: (rightByValue.get(value) ?? 0) - (leftByValue.get(value) ?? 0) })).filter(row => row.delta !== 0),
				leftVariance: leftBits.length ? (leftRows.varianceRows.find(row => row.position === position)?.variance ?? null) : null,
				rightVariance: rightBits.length ? (rightRows.varianceRows.find(row => row.position === position)?.variance ?? null) : null,
				leftBitOnePercentages: leftBits,
				rightBitOnePercentages: rightBits
			};
		};
		const hasDifference = (item: AgentBytePositionDelta): boolean =>
			stableJson(item.leftVocabulary) !== stableJson(item.rightVocabulary)
			|| item.leftVariance !== item.rightVariance
			|| stableJson(item.leftBitOnePercentages) !== stableJson(item.rightBitOnePercentages);
		const changedItems: AgentBytePositionDelta[] = [];
		let scanPosition: string | number | null | undefined = cursor?.key.position;
		let exhausted = false;
		while (changedItems.length <= limit && !exhausted) {
			const params: Record<string, unknown> = { leftProfileId: left.profileId, rightProfileId: right.profileId, limit: candidateLimit };
			const cursorSql = scanPosition === undefined ? "" : " WHERE position > @cursorPosition";
			if (scanPosition !== undefined) params.cursorPosition = scanPosition;
			const positions = this.database.prepare(
				`SELECT position FROM (
					SELECT position FROM byte_statistics WHERE profile_id = @leftProfileId
					UNION
					SELECT position FROM byte_statistics WHERE profile_id = @rightProfileId
					UNION
					SELECT position FROM bit_statistics WHERE profile_id = @leftProfileId
					UNION
					SELECT position FROM bit_statistics WHERE profile_id = @rightProfileId
				) positions${cursorSql}
				ORDER BY position ASC LIMIT @limit`
			).all(params) as Array<{ position: number }>;
			if (!positions.length) {
				exhausted = true;
				break;
			}
			const pagePositions = positions.map(row => row.position);
			const leftRows = read(left.profileId, pagePositions);
			const rightRows = read(right.profileId, pagePositions);
			changedItems.push(...pagePositions.map(position => buildItem(position, leftRows, rightRows)).filter(hasDifference));
			scanPosition = pagePositions.at(-1);
			exhausted = positions.length < candidateLimit;
		}
		const items = changedItems.slice(0, limit);
		const hasMore = changedItems.length > items.length;
		const last = items.at(-1);
		const nextCursor = hasMore && last !== undefined ? encodeAgentCursor({ contractVersion: 1, scope: "comparison:byte-statistics", filters, snapshot: left, key: { position: last.position } }) : undefined;
		return { items, returned: items.length, ...(nextCursor ? { nextCursor } : {}), truncated: hasMore, operationTemplates: [] };
	}

	private comparisonSequenceGroups(left: AgentComparisonSnapshot, right: AgentComparisonSnapshot, input: AgentCompareCapturesInput): AgentComparisonPage<AgentSequenceGroupDelta> {
		const filters = { left, right, category: "sequence-groups" };
		const cursor = this.comparisonCursor(input, "sequence-groups", ["magnitude", "key"], filters);
		const limit = this.comparisonPageLimit(input, "sequence-groups");
		const params: Record<string, unknown> = { leftProfileId: left.profileId, rightProfileId: right.profileId, limit: limit + 1 };
		const cursorSql = cursor
			? " WHERE (left_occurrence_count <> right_occurrence_count OR left_length IS NOT right_length) AND (magnitude < @cursorMagnitude OR (magnitude = @cursorMagnitude AND key_text > @cursorKey))"
			: " WHERE left_occurrence_count <> right_occurrence_count OR left_length IS NOT right_length";
		if (cursor) { params.cursorMagnitude = cursor.key.magnitude; params.cursorKey = cursor.key.key; }
		const rows = this.database.prepare(
			`WITH left_groups AS (
				SELECT groups.key_text, MIN(groups.id) AS group_id, MAX(groups.length) AS group_length,
				       COUNT(DISTINCT occurrences.occurrence_index) AS occurrence_count
				FROM sequence_groups groups LEFT JOIN sequence_occurrences occurrences ON occurrences.group_id = groups.id
				WHERE groups.profile_id = @leftProfileId GROUP BY groups.key_text
			), right_groups AS (
				SELECT groups.key_text, MIN(groups.id) AS group_id, MAX(groups.length) AS group_length,
				       COUNT(DISTINCT occurrences.occurrence_index) AS occurrence_count
				FROM sequence_groups groups LEFT JOIN sequence_occurrences occurrences ON occurrences.group_id = groups.id
				WHERE groups.profile_id = @rightProfileId GROUP BY groups.key_text
			), delta AS (
				SELECT left_groups.key_text, left_groups.group_id AS left_group_id, right_groups.group_id AS right_group_id,
				       left_groups.occurrence_count AS left_occurrence_count, COALESCE(right_groups.occurrence_count, 0) AS right_occurrence_count,
				       left_groups.group_length AS left_length, right_groups.group_length AS right_length
				FROM left_groups LEFT JOIN right_groups ON right_groups.key_text = left_groups.key_text
				UNION ALL
				SELECT right_groups.key_text, NULL, right_groups.group_id, 0, right_groups.occurrence_count, NULL, right_groups.group_length
				FROM right_groups LEFT JOIN left_groups ON left_groups.key_text = right_groups.key_text
				WHERE left_groups.key_text IS NULL
			), ranked AS (
				SELECT *, right_occurrence_count - left_occurrence_count AS delta,
				       ABS(right_occurrence_count - left_occurrence_count) AS magnitude
				FROM delta
			)
			SELECT key_text, left_group_id, right_group_id, left_occurrence_count, right_occurrence_count,
			       left_length, right_length, delta, magnitude
			FROM ranked${cursorSql}
			ORDER BY magnitude DESC, key_text ASC LIMIT @limit`
		).all(params) as Array<{ key_text: string; left_group_id: string | null; right_group_id: string | null; left_occurrence_count: number; right_occurrence_count: number; left_length: number | null; right_length: number | null; delta: number; magnitude: number }>;
		const pageRows = rows.slice(0, limit);
		const items = pageRows.map(row => ({
			key: row.key_text,
			leftGroupId: row.left_group_id,
			rightGroupId: row.right_group_id,
			leftOccurrenceCount: row.left_occurrence_count,
			rightOccurrenceCount: row.right_occurrence_count,
			leftLength: row.left_length,
			rightLength: row.right_length,
			delta: row.delta
		}));
		const operationTemplates: AgentOperationTemplate[] = [
			{
				tool: "get_sequence_occurrences",
				reason: "Inspect occurrences for the selected left-snapshot sequence group; this template is inapplicable when the bound leftGroupId is null",
				fixedArguments: this.comparisonSnapshotArguments(left),
				argumentBindings: { groupId: "leftGroupId" }
			},
			{
				tool: "get_sequence_occurrences",
				reason: "Inspect occurrences for the selected right-snapshot sequence group; this template is inapplicable when the bound rightGroupId is null",
				fixedArguments: this.comparisonSnapshotArguments(right),
				argumentBindings: { groupId: "rightGroupId" }
			}
		];
		const hasMore = rows.length > pageRows.length;
		const last = pageRows.at(-1);
		const nextCursor = hasMore && last ? encodeAgentCursor({ contractVersion: 1, scope: "comparison:sequence-groups", filters, snapshot: left, key: { magnitude: Math.abs(last.delta), key: last.key_text } }) : undefined;
		return { items, returned: items.length, ...(nextCursor ? { nextCursor } : {}), truncated: hasMore, operationTemplates };
	}

	compareCaptures(input: AgentCompareCapturesInput): AgentResponse<AgentComparisonResult> {
		const left = this.resolveComparisonSnapshot(input.left);
		const right = this.resolveComparisonSnapshot(input.right);
		const categories = input.categories?.length ? [...new Set(input.categories)] : [...AGENT_COMPARISON_CATEGORIES];
		for (const category of categories) if (!AGENT_COMPARISON_CATEGORIES.includes(category)) throw new AgentQueryError("invalid-input", "Unknown comparison category", { category });
		const categoryData: Partial<Record<AgentComparisonCategory, unknown>> = {};
		let truncated = false;
		for (const category of categories) {
			switch (category) {
				case "metadata":
					if (input.cursors?.metadata) throw new AgentQueryError("invalid-cursor", "Metadata comparison is not pageable", { category });
					categoryData.metadata = this.comparisonMetadata(left, right);
					break;
				case "sections":
					if (input.cursors?.sections) throw new AgentQueryError("invalid-cursor", "Section comparison is not pageable", { category });
					categoryData.sections = this.comparisonSections(left, right);
					break;
				case "signatures": {
					const page = this.comparisonSignatures(left, right, input);
					categoryData.signatures = page;
					truncated ||= page.truncated;
					break;
				}
				case "transitions": {
					const page = this.comparisonTransitions(left, right, input);
					categoryData.transitions = page;
					truncated ||= page.truncated;
					break;
				}
				case "byte-statistics": {
					const page = this.comparisonBytePositions(left, right, input);
					categoryData["byte-statistics"] = page;
					truncated ||= page.truncated;
					break;
				}
				case "sequence-groups": {
					const page = this.comparisonSequenceGroups(left, right, input);
					categoryData["sequence-groups"] = page;
					truncated ||= page.truncated;
					break;
				}
			}
		}
		const response = makeAgentResponse({
			data: { left, right, categories: categoryData } as AgentComparisonResult,
			appliedFilters: { left, right, categories, limits: input.limits ?? {}, cursors: input.cursors ?? {} },
			truncated
		});
		// A complete high-cardinality byte position is intentionally atomic. The
		// one-position page keeps the category bounded, while the hard limit still
		// guards the comparison envelope when other requested categories use the
		// remaining normal-response budget.
		assertEncodedResponseSize(response, categories.includes("byte-statistics"));
		return response;
	}
}

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AgentQueryError, type AgentResponse } from "./agent-contracts.ts";
import { MAX_DIFFERENTIAL_FRAMES, MAX_SIGNATURE_ALIGNMENT_FRAMES } from "./differential-analysis.ts";
import { agentResponseSchema, captureIdSchema, MCP_RESPONSE_LIMIT_BYTES } from "./mcp-server.ts";
import {
	DEFAULT_RAW_READ_BYTES,
	MAX_RAW_READ_BYTES,
	type AgentByteStatisticsInput,
	type AgentByteStatisticsResult,
	type AgentCaptureDifferenceInput,
	type AgentCaptureDifferenceResult,
	type AgentMessageContext,
	type AgentMessageContextInput,
	type AgentMessageQueryInput,
	type AgentMessageQueryResult,
	type AgentRawRead,
	type AgentRawReadInput,
	type AgentProtocolReportInput,
	type AgentProtocolReportResult,
	type AgentSequenceGroupsInput,
	type AgentSequenceGroupsResult,
	type AgentSequenceOccurrencesInput,
	type AgentSequenceOccurrencesResult,
	type AgentTransitionsInput,
	type AgentTransitionsResult
} from "./canonical-query.ts";
import type { McpQueryExecutor } from "./mcp-query-executor.ts";

type RecordClient = (context: unknown, server: McpServer) => void;

const differentialScopeSchema = z.object({
	sectionId: z.string().min(1).optional(),
	frameLength: z.number().int().positive().optional(),
	exactSignature: z.string().min(1).optional(),
	wildcardHexPattern: z.string().min(1).optional(),
	direction: z.string().min(1).optional()
});

const transitionCommonInputShape = {
	captureId: captureIdSchema,
	profileId: z.string().optional(),
	profileVersion: z.number().int().nonnegative().optional(),
	sourceDataRevision: z.number().int().nonnegative().optional(),
	minimumCount: z.number().int().positive().optional(),
	limit: z.number().int().positive().max(100).optional()
};
const transitionSignature = z.string().min(1);
const transitionChangedPositions = z.array(z.number().int().nonnegative()).min(1).max(32);
const transitionInputSchema = z.object({
	...transitionCommonInputShape,
	sourceSignature: transitionSignature.optional(),
	destinationSignature: transitionSignature.optional(),
	sectionId: z.string().min(1).optional(),
	changedPositions: transitionChangedPositions.optional(),
	changedPositionMatch: z.enum(["all", "any"]).optional(),
	cursor: z.string().optional()
});

const byteStatisticsScopeFields = {
	sectionId: z.string().min(1).optional(),
	frameLength: z.number().int().positive().optional(),
	exactSignature: z.string().min(1).optional(),
	wildcardHexPattern: z.string().min(1).optional(),
	direction: z.string().min(1).optional()
};
const byteStatisticsScopeSchema = z.union([
	z.object({ ...byteStatisticsScopeFields, sectionId: z.string().min(1) }),
	z.object({ ...byteStatisticsScopeFields, frameLength: z.number().int().positive() }),
	z.object({ ...byteStatisticsScopeFields, exactSignature: z.string().min(1) }),
	z.object({ ...byteStatisticsScopeFields, wildcardHexPattern: z.string().min(1) }),
	z.object({ ...byteStatisticsScopeFields, direction: z.string().min(1) })
], {
	error: "scope must contain at least one of sectionId, frameLength, exactSignature, wildcardHexPattern, or direction"
});

const differentialSnapshotSchema = z.object({
	captureId: captureIdSchema,
	profileId: z.string().min(1),
	profileVersion: z.number().int().positive(),
	sourceDataRevision: z.number().int().nonnegative()
});

const differentialMessageFiltersSchema = z.object({
	ordinalFrom: z.number().int().nonnegative().optional(),
	ordinalTo: z.number().int().nonnegative().optional(),
	frameOrdinalFrom: z.number().int().nonnegative().optional(),
	frameOrdinalTo: z.number().int().nonnegative().optional(),
	rawOffsetFrom: z.number().int().nonnegative().optional(),
	rawOffsetTo: z.number().int().nonnegative().optional(),
	timestampFrom: z.number().finite().optional(),
	timestampTo: z.number().finite().optional(),
	sectionId: z.string().min(1).optional(),
	direction: z.string().min(1).optional(),
	exactSignature: z.string().min(1).optional(),
	signature: z.string().min(1).optional(),
	wildcardHexPattern: z.string().min(1).optional(),
	hidden: z.enum(["include", "visible-only", "hidden-only"]).optional(),
	notePresence: z.enum(["any", "with-note", "without-note"]).optional(),
	sequenceGroupId: z.string().min(1).optional()
});

const differentialInputSchema = z.object({
	baseline: z.object({
		snapshot: differentialSnapshotSchema,
		label: z.string().min(1),
		filters: differentialMessageFiltersSchema.optional()
	}),
	changed: z.object({
		snapshot: differentialSnapshotSchema,
		label: z.string().min(1),
		filters: differentialMessageFiltersSchema.optional()
	}),
	alignment: z.object({
		mode: z.enum(["ordinal", "raw-relative", "timestamp-nearest", "signature-sequence"]),
		maximumTimestampDeltaMs: z.number().finite().nonnegative().max(60_000).optional()
	}),
	scope: differentialScopeSchema.optional(),
	minimumSupport: z.number().int().positive().max(1_000).optional(),
	cursor: z.string().optional(),
	limit: z.number().int().positive().max(100).optional()
});

const differentialSnapshotOutputSchema = z.object({
	captureId: z.string(),
	profileId: z.string(),
	profileVersion: z.number().int().nonnegative(),
	sourceDataRevision: z.number().int().nonnegative()
});
const differentialValueCountSchema = z.object({ value: z.number().int().nonnegative(), count: z.number().int().nonnegative() });
const differentialMaskCountSchema = z.object({ mask: z.string(), count: z.number().int().nonnegative() });
const differentialEvidenceSchema = z.object({
	baselineFrameIds: z.array(z.string()),
	changedFrameIds: z.array(z.string()),
	evidenceTruncated: z.boolean()
});
const differentialScoreComponentsSchema = z.object({
	supportFactor: z.number().finite(),
	changeConsistency: z.number().finite(),
	directionConsistency: z.number().finite(),
	familySpecificity: z.number().finite(),
	alignmentQuality: z.number().finite()
});
const differentialCandidateSchema = z.object({
	sectionId: z.string(),
	baselineSectionId: z.string(),
	changedSectionId: z.string(),
	sectionFingerprint: z.string(),
	frameFamily: z.string(),
	changedFrameFamily: z.string(),
	bytePosition: z.number().int().nonnegative(),
	bitMask: z.string(),
	baselineValues: z.array(differentialValueCountSchema),
	changedValues: z.array(differentialValueCountSchema),
	xorMasks: z.array(differentialMaskCountSchema),
	setCount: z.number().int().nonnegative(),
	clearCount: z.number().int().nonnegative(),
	support: z.number().int().nonnegative(),
	pairedFrameCount: z.number().int().nonnegative(),
	changeConsistency: z.number().finite(),
	directionConsistency: z.number().finite(),
	score: z.number().finite(),
	scoreComponents: differentialScoreComponentsSchema,
	evidence: differentialEvidenceSchema
});
const differentialPositionSummarySchema = z.object({
	sectionId: z.string(),
	baselineSectionId: z.string(),
	changedSectionId: z.string(),
	sectionFingerprint: z.string(),
	frameFamily: z.string(),
	bytePosition: z.number().int().nonnegative(),
	pairedFrameCount: z.number().int().nonnegative(),
	observedFrameCount: z.number().int().nonnegative(),
	changedPairCount: z.number().int().nonnegative(),
	changeConsistency: z.number().finite()
});
const differentialLengthChangeSchema = z.object({
	sectionId: z.string(),
	baselineSectionId: z.string(),
	changedSectionId: z.string(),
	sectionFingerprint: z.string(),
	frameFamily: z.string(),
	changedFrameFamily: z.string(),
	baselineLength: z.number().int().nonnegative(),
	changedLength: z.number().int().nonnegative(),
	support: z.number().int().nonnegative(),
	pairedFrameCount: z.number().int().nonnegative()
});
const differentialResultSchema = z.object({
	baseline: z.object({
		label: z.string(),
		snapshot: differentialSnapshotOutputSchema,
		totalFrameCount: z.number().int().nonnegative(),
		filteredFrameCount: z.number().int().nonnegative(),
		excludedFrameCount: z.number().int().nonnegative(),
		analyzedElementCount: z.number().int().nonnegative()
	}),
	changed: z.object({
		label: z.string(),
		snapshot: differentialSnapshotOutputSchema,
		totalFrameCount: z.number().int().nonnegative(),
		filteredFrameCount: z.number().int().nonnegative(),
		excludedFrameCount: z.number().int().nonnegative(),
		analyzedElementCount: z.number().int().nonnegative()
	}),
	alignment: z.object({
		mode: z.enum(["ordinal", "raw-relative", "timestamp-nearest", "signature-sequence"]),
		pairedFrameCount: z.number().int().nonnegative(),
		baselineUnpairedFrameCount: z.number().int().nonnegative(),
		changedUnpairedFrameCount: z.number().int().nonnegative(),
		insertedFrameCount: z.number().int().nonnegative(),
		deletedFrameCount: z.number().int().nonnegative(),
		excludedFrameCount: z.object({ baseline: z.number().int().nonnegative(), changed: z.number().int().nonnegative() }),
		unpairedFrameCount: z.object({ baseline: z.number().int().nonnegative(), changed: z.number().int().nonnegative() }),
		pairCompatibility: z.object({
			compatiblePairCount: z.number().int().nonnegative(),
			incompatiblePairCount: z.number().int().nonnegative(),
			sectionMismatchCount: z.number().int().nonnegative(),
			frameFamilyMismatchCount: z.number().int().nonnegative(),
			lengthMismatchCount: z.number().int().nonnegative()
		}),
		maximumTimestampDeltaMs: z.number().finite().nonnegative().optional()
	}),
	differenceSummary: z.object({
		invariantPositions: z.array(differentialPositionSummarySchema),
		conditionallyChangingPositions: z.array(differentialPositionSummarySchema),
		alwaysChangingPositions: z.array(differentialPositionSummarySchema),
		lengthChanges: z.array(differentialLengthChangeSchema),
		truncated: z.boolean()
	}),
	candidateFields: z.array(differentialCandidateSchema)
});
const differentialOutputSchema = agentResponseSchema.extend({ data: differentialResultSchema });

const protocolReportSectionSchema = z.enum([
	"frame-families",
	"invariants",
	"variable-bits",
	"transitions",
	"sequences",
	"differential-candidates"
]);
const protocolReportDifferentialSchema = z.object({
	baseline: z.object({
		snapshot: differentialSnapshotSchema,
		label: z.string().min(1),
		filters: differentialMessageFiltersSchema.optional()
	}),
	changed: z.object({
		snapshot: differentialSnapshotSchema,
		label: z.string().min(1),
		filters: differentialMessageFiltersSchema.optional()
	}),
	alignment: z.object({
		mode: z.enum(["ordinal", "raw-relative", "timestamp-nearest", "signature-sequence"]),
		maximumTimestampDeltaMs: z.number().finite().nonnegative().max(60_000).optional()
	}),
	scope: differentialScopeSchema.optional(),
	minimumSupport: z.number().int().positive().max(1_000).optional()
});
const protocolReportInputSchema = z.object({
	snapshot: differentialSnapshotSchema,
	scope: differentialScopeSchema.optional(),
	include: z.array(protocolReportSectionSchema).min(1).max(6).optional(),
	differentialAnalysis: protocolReportDifferentialSchema.optional(),
	detail: z.enum(["compact", "standard"]).optional(),
	hidden: z.enum(["include", "visible-only", "hidden-only"]).optional(),
	minimumSupport: z.number().int().positive().max(1_000).optional()
});

function errorResult(error: unknown): { isError: true; structuredContent: AgentResponse<unknown>; content: [{ type: "text"; text: string }] } {
	const normalized = error instanceof AgentQueryError
		? error
		: new AgentQueryError("invalid-input", error instanceof Error ? error.message : "Tool request failed");
	const response: AgentResponse<unknown> = {
		data: { error: { code: normalized.code, message: normalized.message, details: normalized.details } },
		meta: {
			contractVersion: 1,
			appliedFilters: {},
			truncated: false,
			suggestedOperations: [{ tool: "get_capture_overview", reason: "Return to a bounded capture overview and retry with a narrower operation" }]
		}
	};
	return { isError: true, structuredContent: response, content: [{ type: "text", text: normalized.message }] };
}

function textResult<T>(response: AgentResponse<T>, text: string) {
	return { structuredContent: response, content: [{ type: "text" as const, text }] };
}

function snapshotArguments(input: { captureId: string; profileId?: string; profileVersion?: number; sourceDataRevision?: number }): Record<string, unknown> {
	return {
		captureId: input.captureId,
		...(input.profileId ? { profileId: input.profileId } : {}),
		...(input.profileVersion === undefined ? {} : { profileVersion: input.profileVersion }),
		...(input.sourceDataRevision === undefined ? {} : { sourceDataRevision: input.sourceDataRevision })
	};
}

function registerAnalysisTool<TInput extends object>(
	server: McpServer,
	name: string,
	description: string,
	inputSchema: z.ZodType<TInput>,
	call: (input: TInput) => Promise<AgentResponse<unknown>>,
	synopsis: (response: AgentResponse<unknown>) => string,
	recordClient: RecordClient,
	outputSchema: z.ZodTypeAny = agentResponseSchema
): void {
	server.registerTool(name, { description, inputSchema, outputSchema }, async (input, context) => {
		recordClient(context, server);
		try {
			const response = await call(input as TInput);
			return textResult(response, synopsis(response));
		} catch (error) {
			return errorResult(error);
		}
	});
}

export function registerAnalysisTools(server: McpServer, queries: McpQueryExecutor, recordClient: RecordClient): void {
	registerAnalysisTool(
		server,
		"query_messages",
		"Query bounded interpreted frames by snapshot, ordinal, inclusive raw byte range, time, section, direction, signature, wildcard, hidden, note, or sequence filters. A raw byte range performs reverse raw-range lookup and returns every frame whose raw span overlaps it; supplying one raw offset matches that offset.",
		z.object({
			captureId: captureIdSchema,
			profileId: z.string().optional(),
			profileVersion: z.number().int().nonnegative().optional(),
			sourceDataRevision: z.number().int().nonnegative().optional(),
			ordinalFrom: z.number().int().nonnegative().optional(),
			ordinalTo: z.number().int().nonnegative().optional(),
			rawOffsetFrom: z.number().int().safe().nonnegative().describe("Inclusive raw-byte overlap lower bound; when supplied alone, matches one raw offset.").optional(),
			rawOffsetTo: z.number().int().safe().nonnegative().describe("Inclusive raw-byte overlap upper bound; when supplied alone, matches one raw offset.").optional(),
			timestampFrom: z.number().finite().optional(),
			timestampTo: z.number().finite().optional(),
			sectionId: z.string().optional(),
			frameLength: z.number().int().positive().optional(),
			direction: z.string().optional(),
			exactSignature: z.string().optional(),
			wildcardHexPattern: z.string().optional(),
			scope: differentialScopeSchema.optional(),
			hidden: z.enum(["include", "visible-only", "hidden-only"]).optional(),
			notePresence: z.enum(["any", "with-note", "without-note"]).optional(),
			sequenceGroupId: z.string().optional(),
			cursor: z.string().optional(),
			limit: z.number().int().positive().max(200).optional()
		}),
		input => queries.queryMessages(input as AgentMessageQueryInput),
		response => `Returned ${response.meta.page?.returned ?? 0} bounded frame${response.meta.page?.returned === 1 ? "" : "s"}. Use a stable frame ID with get_message_context for local neighbors.`,
		recordClient
	);

	registerAnalysisTool(
		server,
		"get_message_context",
		"Resolve one stable frame in its original profile revision and return a bounded neighborhood without switching to the active profile.",
		z.object({
			frameId: z.string().min(1),
			captureId: captureIdSchema.optional(),
			profileId: z.string().optional(),
			profileVersion: z.number().int().nonnegative().optional(),
			sourceDataRevision: z.number().int().nonnegative().optional(),
			rowsBefore: z.number().int().positive().max(100).optional(),
			rowsAfter: z.number().int().positive().max(100).optional(),
			includeNoteSummaries: z.boolean().optional()
		}),
		input => queries.getMessageContext(input as AgentMessageContextInput),
		response => `Returned ${response.meta.page?.returned ?? (response.data as AgentMessageContext).messages.length} frames around the selected stable frame.`,
		recordClient
	);

	registerAnalysisTool(
		server,
		"get_sequence_groups",
		"List bounded repeated-sequence group summaries for one explicit profile snapshot without nesting all occurrences.",
		z.object({
			captureId: captureIdSchema,
			profileId: z.string().optional(),
			profileVersion: z.number().int().nonnegative().optional(),
			sourceDataRevision: z.number().int().nonnegative().optional(),
			cursor: z.string().optional(),
			limit: z.number().int().positive().max(100).optional()
		}),
		input => queries.getSequenceGroups(input as AgentSequenceGroupsInput),
		response => `Returned ${response.meta.page?.returned ?? 0} bounded sequence-group summar${response.meta.page?.returned === 1 ? "y" : "ies"}.`,
		recordClient
	);

	registerAnalysisTool(
		server,
		"get_sequence_occurrences",
		"List bounded occurrences for one sequence group, with optional small frame context.",
		z.object({
			captureId: captureIdSchema.optional(),
			groupId: z.string().min(1),
			profileId: z.string().optional(),
			profileVersion: z.number().int().nonnegative().optional(),
			sourceDataRevision: z.number().int().nonnegative().optional(),
			scope: differentialScopeSchema.optional(),
			hidden: z.enum(["include", "visible-only", "hidden-only"]).optional(),
			cursor: z.string().optional(),
			limit: z.number().int().positive().max(100).optional(),
			includeContext: z.boolean().optional(),
			contextBefore: z.number().int().positive().max(10).optional(),
			contextAfter: z.number().int().positive().max(10).optional()
		}),
		input => queries.getSequenceOccurrences(input as AgentSequenceOccurrencesInput),
		response => `Returned ${response.meta.page?.returned ?? (response.data as AgentSequenceOccurrencesResult).occurrences.length} bounded sequence occurrence${response.meta.page?.returned === 1 ? "" : "s"}.`,
		recordClient
	);

	registerAnalysisTool(
		server,
		"get_byte_statistics",
		"Read profile-wide vocabulary, bit-one percentages, variance, and applicable-frame counts for at most 32 requested byte positions; optionally scope to a non-empty combination of sectionId, frameLength, exactSignature, wildcardHexPattern, or direction to report matched-frame denominators.",
		z.object({
			captureId: captureIdSchema,
			profileId: z.string().optional(),
			profileVersion: z.number().int().nonnegative().optional(),
			sourceDataRevision: z.number().int().nonnegative().optional(),
			positions: z.array(z.number().int().nonnegative()).min(1).max(32),
			scope: byteStatisticsScopeSchema.optional(),
			hidden: z.enum(["include", "visible-only", "hidden-only"]).optional()
		}),
		input => queries.getByteStatistics(input as AgentByteStatisticsInput),
		response => `Returned byte statistics for ${(response.data as AgentByteStatisticsResult).positions.length} requested position${(response.data as AgentByteStatisticsResult).positions.length === 1 ? "" : "s"}.`,
		recordClient
	);

	registerAnalysisTool(
		server,
		"get_transitions",
		"Return bounded signature-transition aggregates, section-scoped results, or indexed changed-position matches. Position-only and section-only requests are supported with all/any matching, minimum-count filtering, and opaque keyset cursors.",
		transitionInputSchema,
		input => queries.getTransitions(input as AgentTransitionsInput),
		response => `Returned ${(response.data as AgentTransitionsResult).transitions.length} bounded transition result${(response.data as AgentTransitionsResult).transitions.length === 1 ? "" : "s"}.`,
		recordClient
	);

	registerAnalysisTool(
		server,
		"analyze_capture_difference",
		`Compare two explicitly pinned, labelled experiments with bounded ordinal, raw-relative, timestamp-nearest, or structural-fingerprint-aware signature-sequence alignment. Each side accepts at most ${MAX_DIFFERENTIAL_FRAMES} filtered frames; signature-sequence alignment accepts at most ${MAX_SIGNATURE_ALIGNMENT_FRAMES} filtered frames per side. Both snapshots also share a total bounded byte/timestamp/raw-position/direction array budget before materialization. Returns ranked candidateFields with byte/bit evidence and score components only; it never names or persists inferred protocol fields. Signature substitutions pair only equal ordinals with equal comparison-local section fingerprints, while exact-signature LCS anchors retain priority; candidate results retain baselineSectionId, changedSectionId, and sectionFingerprint. The fingerprint may be shared by structurally equivalent sections and is not a database identity or lookup key without its snapshot. Use baseline.filters and changed.filters to narrow larger captures before alignment. Raw-relative pairs only equal relative retained-raw starts; shifted boundaries remain explicit unpaired evidence. A shared scope.sectionId must exist in both snapshots; use side-specific filters for profile-local section IDs.`,
		differentialInputSchema,
		input => queries.analyzeCaptureDifference(input as AgentCaptureDifferenceInput),
		response => {
			const result = response as AgentResponse<AgentCaptureDifferenceResult>;
			return `Compared ${result.data.alignment.pairedFrameCount} aligned frame pair${result.data.alignment.pairedFrameCount === 1 ? "" : "s"} with ${result.data.candidateFields.length} bounded candidate field${result.data.candidateFields.length === 1 ? "" : "s"} using ${result.data.alignment.mode} alignment.`;
		},
		recordClient,
		differentialOutputSchema
	);

	registerAnalysisTool(
		server,
		"get_protocol_report",
		"Return a compact, non-pageable evidence report for one explicit profile snapshot. Results separate frame families by section and length, classify stable and variable bytes/bits, summarize common transitions and repeated sequences, and optionally include labelled differential candidate fields. Scope, hidden policy, detail, and differential alignment are bounded and returned in the report; no semantic field names or inferred-field persistence are performed.",
		protocolReportInputSchema,
		input => queries.getProtocolReport(input as AgentProtocolReportInput),
		response => {
			const result = response as AgentResponse<AgentProtocolReportResult>;
			return `Returned a bounded protocol report for ${result.data.evidenceQuality.applicableFrameCount} applicable frame${result.data.evidenceQuality.applicableFrameCount === 1 ? "" : "s"}${result.data.evidenceQuality.truncated ? " with truncation" : ""}.`;
		},
		recordClient
	);

	registerAnalysisTool(
		server,
		"read_raw_bytes",
		`Read an explicit absolute raw-byte range with a ${DEFAULT_RAW_READ_BYTES}-byte default and a hard ${MAX_RAW_READ_BYTES}-byte maximum. The bounded read may use the full ${MCP_RESPONSE_LIMIT_BYTES / 1024} KiB MCP response budget because per-byte timestamp metadata can exceed the normal response target; use the suggested query_messages operation for reverse raw-range lookup of interpreted frames, and never request a complete capture.`,
		z.object({
			captureId: captureIdSchema,
			rawOffset: z.number().int().nonnegative().optional(),
			offset: z.number().int().nonnegative().optional(),
			length: z.number().int().positive().max(MAX_RAW_READ_BYTES).optional(),
			byteCount: z.number().int().positive().max(MAX_RAW_READ_BYTES).optional(),
			hiddenPolicy: z.enum(["mask", "include", "omit"]).optional()
		}),
		input => queries.readRawBytes(input as AgentRawReadInput),
		response => `Returned ${(response.data as AgentRawRead).returnedByteCount} raw byte positions in the explicitly requested range.`,
		recordClient
	);
}

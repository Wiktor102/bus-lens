import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AgentQueryError, type AgentResponse } from "./agent-contracts.ts";
import { agentResponseSchema } from "./mcp-server.ts";
import type {
	AgentByteStatisticsInput,
	AgentByteStatisticsResult,
	AgentMessageContext,
	AgentMessageContextInput,
	AgentMessageQueryInput,
	AgentMessageQueryResult,
	AgentRawRead,
	AgentRawReadInput,
	AgentSequenceGroupsInput,
	AgentSequenceGroupsResult,
	AgentSequenceOccurrencesInput,
	AgentSequenceOccurrencesResult,
	AgentTransitionsInput,
	AgentTransitionsResult,
	CanonicalQueryService
} from "./canonical-query.ts";

type RecordClient = (context: unknown, server: McpServer) => void;

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

async function withTimeout<T>(operation: () => T | Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve().then(operation),
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new AgentQueryError("execution-timeout", "Tool execution exceeded the local execution limit", { timeoutMs: 5_000 })), 5_000);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
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
	call: (input: TInput) => AgentResponse<unknown>,
	synopsis: (response: AgentResponse<unknown>) => string,
	recordClient: RecordClient
): void {
	server.registerTool(name, { description, inputSchema, outputSchema: agentResponseSchema }, async (input, context) => {
		recordClient(context, server);
		try {
			const response = await withTimeout(() => call(input as TInput));
			return textResult(response, synopsis(response));
		} catch (error) {
			return errorResult(error);
		}
	});
}

export function registerAnalysisTools(server: McpServer, queries: CanonicalQueryService, recordClient: RecordClient): void {
	registerAnalysisTool(
		server,
		"query_messages",
		"Query bounded interpreted frames by snapshot, ordinal, time, section, direction, signature, wildcard, hidden, note, or sequence filters.",
		z.object({
			captureId: z.string().min(1),
			profileId: z.string().optional(),
			profileVersion: z.number().int().nonnegative().optional(),
			sourceDataRevision: z.number().int().nonnegative().optional(),
			ordinalFrom: z.number().int().nonnegative().optional(),
			ordinalTo: z.number().int().nonnegative().optional(),
			timestampFrom: z.number().finite().optional(),
			timestampTo: z.number().finite().optional(),
			sectionId: z.string().optional(),
			direction: z.string().optional(),
			exactSignature: z.string().optional(),
			wildcardHexPattern: z.string().optional(),
			hidden: z.enum(["include", "visible-only", "hidden-only"]).optional(),
			notePresence: z.enum(["any", "with-note", "without-note"]).optional(),
			sequenceGroupId: z.string().optional(),
			cursor: z.string().optional(),
			limit: z.number().int().positive().max(200).optional()
		}),
		input => queries.queryMessages(input as AgentMessageQueryInput) as AgentResponse<unknown>,
		response => `Returned ${response.meta.page?.returned ?? 0} bounded frame${response.meta.page?.returned === 1 ? "" : "s"}. Use a stable frame ID with get_message_context for local neighbors.`,
		recordClient
	);

	registerAnalysisTool(
		server,
		"get_message_context",
		"Resolve one stable frame in its original profile revision and return a bounded neighborhood without switching to the active profile.",
		z.object({
			frameId: z.string().min(1),
			captureId: z.string().optional(),
			profileId: z.string().optional(),
			profileVersion: z.number().int().nonnegative().optional(),
			sourceDataRevision: z.number().int().nonnegative().optional(),
			rowsBefore: z.number().int().positive().max(100).optional(),
			rowsAfter: z.number().int().positive().max(100).optional()
		}),
		input => queries.getMessageContext(input as AgentMessageContextInput) as AgentResponse<unknown>,
		response => `Returned ${response.meta.page?.returned ?? (response.data as AgentMessageContext).messages.length} frames around the selected stable frame.`,
		recordClient
	);

	registerAnalysisTool(
		server,
		"get_sequence_groups",
		"List bounded repeated-sequence group summaries for one explicit profile snapshot without nesting all occurrences.",
		z.object({
			captureId: z.string().min(1),
			profileId: z.string().optional(),
			profileVersion: z.number().int().nonnegative().optional(),
			sourceDataRevision: z.number().int().nonnegative().optional(),
			cursor: z.string().optional(),
			limit: z.number().int().positive().max(100).optional()
		}),
		input => queries.getSequenceGroups(input as AgentSequenceGroupsInput) as AgentResponse<unknown>,
		response => `Returned ${response.meta.page?.returned ?? 0} bounded sequence-group summar${response.meta.page?.returned === 1 ? "y" : "ies"}.`,
		recordClient
	);

	registerAnalysisTool(
		server,
		"get_sequence_occurrences",
		"List bounded occurrences for one sequence group, with optional small frame context.",
		z.object({
			captureId: z.string().optional(),
			groupId: z.string().min(1),
			profileId: z.string().optional(),
			profileVersion: z.number().int().nonnegative().optional(),
			sourceDataRevision: z.number().int().nonnegative().optional(),
			cursor: z.string().optional(),
			limit: z.number().int().positive().max(100).optional(),
			includeContext: z.boolean().optional(),
			contextBefore: z.number().int().positive().max(10).optional(),
			contextAfter: z.number().int().positive().max(10).optional()
		}),
		input => queries.getSequenceOccurrences(input as AgentSequenceOccurrencesInput) as AgentResponse<unknown>,
		response => `Returned ${response.meta.page?.returned ?? (response.data as AgentSequenceOccurrencesResult).occurrences.length} bounded sequence occurrence${response.meta.page?.returned === 1 ? "" : "s"}.`,
		recordClient
	);

	registerAnalysisTool(
		server,
		"get_byte_statistics",
		"Read vocabulary, bit-one percentages, variance, and applicable-frame counts for at most 32 requested byte positions.",
		z.object({
			captureId: z.string().min(1),
			profileId: z.string().optional(),
			profileVersion: z.number().int().nonnegative().optional(),
			sourceDataRevision: z.number().int().nonnegative().optional(),
			positions: z.array(z.number().int().nonnegative()).min(1).max(32)
		}),
		input => queries.getByteStatistics(input as AgentByteStatisticsInput) as AgentResponse<unknown>,
		response => `Returned byte statistics for ${(response.data as AgentByteStatisticsResult).positions.length} requested position${(response.data as AgentByteStatisticsResult).positions.length === 1 ? "" : "s"}.`,
		recordClient
	);

	registerAnalysisTool(
		server,
		"get_transitions",
		"Return bounded signature-transition aggregates, optionally refined by section or changed byte positions.",
		z.object({
			captureId: z.string().min(1),
			profileId: z.string().optional(),
			profileVersion: z.number().int().nonnegative().optional(),
			sourceDataRevision: z.number().int().nonnegative().optional(),
			sourceSignature: z.string().optional(),
			destinationSignature: z.string().optional(),
			sectionId: z.string().optional(),
			changedPositions: z.array(z.number().int().nonnegative()).max(32).optional(),
			minimumCount: z.number().int().positive().optional(),
			cursor: z.string().optional(),
			limit: z.number().int().positive().max(100).optional()
		}),
		input => queries.getTransitions(input as AgentTransitionsInput) as AgentResponse<unknown>,
		response => `Returned ${(response.data as AgentTransitionsResult).transitions.length} bounded transition result${(response.data as AgentTransitionsResult).transitions.length === 1 ? "" : "s"}.`,
		recordClient
	);

	registerAnalysisTool(
		server,
		"read_raw_bytes",
		"Read an explicit absolute raw-byte range with a 1,024-byte default and a hard 4,096-byte maximum; never requests a complete capture.",
		z.object({
			captureId: z.string().min(1),
			rawOffset: z.number().int().nonnegative().optional(),
			offset: z.number().int().nonnegative().optional(),
			length: z.number().int().positive().max(4096).optional(),
			byteCount: z.number().int().positive().max(4096).optional(),
			hiddenPolicy: z.enum(["mask", "include", "omit"]).optional()
		}),
		input => queries.readRawBytes(input as AgentRawReadInput) as AgentResponse<unknown>,
		response => `Returned ${(response.data as AgentRawRead).returnedByteCount} raw byte positions in the explicitly requested range.`,
		recordClient
	);
}

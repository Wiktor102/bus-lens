import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AgentQueryError, type AgentResponse } from "./agent-contracts.ts";
import {
	AGENT_COMPARISON_CATEGORIES,
	type AgentCompareCapturesInput,
	type AgentComparisonCategory,
	type AgentComparisonResult
} from "./canonical-query.ts";
import { agentResponseSchema, captureIdSchema } from "./mcp-server.ts";
import type { McpQueryExecutor } from "./mcp-query-executor.ts";

type RecordClient = (context: unknown, server: McpServer) => void;

const snapshotSchema = z.object({
	captureId: captureIdSchema,
	profileId: z.string().min(1),
	profileVersion: z.number().int().positive(),
	sourceDataRevision: z.number().int().nonnegative()
});

function errorResult(error: unknown): { isError: true; structuredContent: AgentResponse<unknown>; content: [{ type: "text"; text: string }] } {
	const normalized = error instanceof AgentQueryError
		? error
		: new AgentQueryError("invalid-input", error instanceof Error ? error.message : "Tool request failed");
	return {
		isError: true,
		structuredContent: {
			data: { error: { code: normalized.code, message: normalized.message, details: normalized.details } },
			meta: { contractVersion: 1, appliedFilters: {}, truncated: false, suggestedOperations: [{ tool: "get_capture_overview", reason: "Read each explicit snapshot before retrying the comparison" }] }
		},
		content: [{ type: "text", text: normalized.message }]
	};
}

export function registerComparisonTools(server: McpServer, queries: McpQueryExecutor, recordClient: RecordClient): void {
	server.registerTool(
		"compare_captures",
		{
			title: "Compare Bus Lens captures",
			description: "Compare two explicit analytical capture snapshots by selected metadata, framing, signature, transition, byte-statistics, or sequence-group categories without returning either message stream.",
			inputSchema: z.object({
				left: snapshotSchema,
				right: snapshotSchema,
				categories: z.array(z.enum(AGENT_COMPARISON_CATEGORIES)).min(1).optional(),
				limits: z.record(z.string(), z.number().int().positive().max(100)).optional(),
				cursors: z.record(z.string(), z.string()).optional()
			}),
			outputSchema: agentResponseSchema
		},
		async (input, context) => {
			recordClient(context, server);
			try {
				const response = await queries.compareCaptures(input as AgentCompareCapturesInput);
				const categoryCount = (input.categories?.length ?? AGENT_COMPARISON_CATEGORIES.length);
				const result = response as AgentResponse<AgentComparisonResult>;
				return {
					structuredContent: result,
					content: [{ type: "text" as const, text: `Compared ${categoryCount} bounded categor${categoryCount === 1 ? "y" : "ies"} for two explicit profile snapshots; inspect category cursors for larger delta sets.` }]
				};
			} catch (error) {
				return errorResult(error);
			}
		}
	);
}

export type ComparisonToolCategory = AgentComparisonCategory;

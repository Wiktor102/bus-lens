import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	AgentQueryError,
	assertEncodedResponseSize,
	makeAgentResponse,
	type AgentResponse,
	type AgentSnapshotReference
} from "./agent-contracts.ts";
import {
	CanonicalCaptureCommandError,
	CanonicalCaptureCommandService,
	type CanonicalNoteTarget,
	type CreateAgentNoteRequest
} from "./canonical-capture-command-service.ts";
import type { AgentNoteQueryInput, AgentNoteQueryResult } from "./canonical-query.ts";
import { getMcpClientAttribution, agentResponseSchema } from "./mcp-server.ts";
import type { McpQueryExecutor } from "./mcp-query-executor.ts";

type RecordClient = (context: unknown, server: McpServer) => void;

const targetSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("capture") }),
	z.object({ kind: z.literal("byte"), rawOffset: z.number().int().nonnegative() }),
	z.object({ kind: z.literal("frame"), frameId: z.string().min(1) }),
	z.object({ kind: z.literal("raw-range"), startRawOffset: z.number().int().nonnegative(), endRawOffset: z.number().int().nonnegative() }),
	z.object({ kind: z.literal("frame-range"), profileId: z.string().min(1), startOrdinal: z.number().int().nonnegative(), endOrdinal: z.number().int().nonnegative() }),
	z.object({ kind: z.literal("sequence-group"), groupId: z.string().min(1), profileId: z.string().optional() })
]);

function errorResult(error: unknown): { isError: true; structuredContent: AgentResponse<unknown>; content: [{ type: "text"; text: string }] } {
	let normalized: AgentQueryError;
	if (error instanceof AgentQueryError) normalized = error;
	else if (error instanceof CanonicalCaptureCommandError && error.code === "ANNOTATION_DISABLED") normalized = new AgentQueryError("annotation-disabled", error.message);
	else if (error instanceof CanonicalCaptureCommandError && error.code === "NOT_FOUND") normalized = new AgentQueryError("evidence-missing", error.message, error.details);
	else if (error instanceof CanonicalCaptureCommandError && error.code === "CONFLICT") normalized = new AgentQueryError("snapshot-mismatch", error.message, error.details);
	else normalized = new AgentQueryError("invalid-input", error instanceof Error ? error.message : "Agent note request failed");
	return {
		isError: true,
		structuredContent: {
			data: { error: { code: normalized.code, message: normalized.message, details: normalized.details } },
			meta: { contractVersion: 1, appliedFilters: {}, truncated: false, suggestedOperations: [{ tool: "get_capture_overview", reason: "Confirm canonical status and stable evidence before annotating" }] }
		},
		content: [{ type: "text", text: normalized.message }]
	};
}

export function registerAgentNoteTools(server: McpServer, queries: McpQueryExecutor, recordClient: RecordClient, commands: CanonicalCaptureCommandService): void {
	server.registerTool(
		"query_notes",
		{
			title: "Query Bus Lens evidence notes",
			description: "Return bounded note text and exact evidence anchors. Filter by capture, note ID, related frame ID, overlapping inclusive raw-byte range, author type, or creation time range; use the opaque cursor for additional notes.",
			inputSchema: z.object({
				captureId: z.string().min(1).optional(),
				noteId: z.string().min(1).optional(),
				frameId: z.string().min(1).optional(),
				rawOffsetFrom: z.number().int().safe().nonnegative().optional(),
				rawOffsetTo: z.number().int().safe().nonnegative().optional(),
				authorType: z.enum(["human", "agent"]).optional(),
				createdFrom: z.string().optional(),
				createdTo: z.string().optional(),
				timeFrom: z.string().optional(),
				timeTo: z.string().optional(),
				textLimit: z.number().int().positive().max(4_000).optional(),
				cursor: z.string().optional(),
				limit: z.number().int().positive().max(100).optional()
			}),
			outputSchema: agentResponseSchema
		},
		async (input, context) => {
			recordClient(context, server);
			try {
				const response = await queries.queryNotes(input as AgentNoteQueryInput);
				const result = response as AgentResponse<AgentNoteQueryResult>;
				return { structuredContent: result, content: [{ type: "text" as const, text: `Returned ${result.data.notes.length} bounded evidence note${result.data.notes.length === 1 ? "" : "s"}; inspect anchors before interpreting the note text.` }] };
			} catch (error) {
				return errorResult(error);
			}
		}
	);

	server.registerTool(
		"add_agent_note",
		{
			title: "Add an evidence-linked agent note",
			description: "Append a bounded note to a canonical stable capture, raw byte, frame, raw range, frame range, or sequence-group target. Agent notes cannot edit or delete existing notes.",
			inputSchema: z.object({
				captureId: z.string().min(1),
				text: z.string().trim().min(1).max(4_000),
				target: targetSchema,
				profileId: z.string().optional(),
				profileVersion: z.number().int().positive().optional(),
				sourceDataRevision: z.number().int().nonnegative().optional(),
				noteId: z.string().min(1).optional()
			}),
			outputSchema: agentResponseSchema
		},
		async (input, context) => {
			recordClient(context, server);
			try {
				const attribution = getMcpClientAttribution(context, server);
				const request: CreateAgentNoteRequest = {
					captureId: input.captureId,
					text: input.text,
					target: input.target as CanonicalNoteTarget,
					...(input.noteId ? { noteId: input.noteId } : {}),
					...(input.profileId ? { profileId: input.profileId } : {}),
					...(input.profileVersion === undefined ? {} : { profileVersion: input.profileVersion }),
					...(input.sourceDataRevision === undefined ? {} : { sourceDataRevision: input.sourceDataRevision }),
					attribution: { authorType: "agent", ...attribution }
				};
				const result = commands.createAgentNote(request);
				const snapshot: AgentSnapshotReference | undefined = input.profileId && input.profileVersion !== undefined && input.sourceDataRevision !== undefined
					? { captureId: input.captureId, profileId: input.profileId, profileVersion: input.profileVersion, sourceDataRevision: input.sourceDataRevision }
					: undefined;
				const response = makeAgentResponse({
					data: { note: result.note, contentRevision: result.contentRevision },
					appliedFilters: { captureId: input.captureId, target: input.target.kind },
					...(snapshot ? { snapshot } : {}),
					truncated: false,
					suggestedOperations: [{ tool: "get_capture_overview", reason: "Refresh the bounded overview to include the new evidence-linked finding", arguments: { captureId: input.captureId } }]
				});
				assertEncodedResponseSize(response);
				return { structuredContent: response, content: [{ type: "text" as const, text: `Appended one evidence-linked agent note attributed to ${attribution.reportedClientName}.` }] };
			} catch (error) {
				return errorResult(error);
			}
		}
	);
}

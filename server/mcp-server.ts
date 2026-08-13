import type { IncomingMessage, ServerResponse } from "node:http";
import {
	hostHeaderValidationResponse,
	localhostAllowedHostnames,
	localhostAllowedOrigins,
	McpServer,
	originValidationResponse,
	createMcpHandler,
	type McpHttpHandler
} from "@modelcontextprotocol/server";
import { toNodeHandler, type NodeMcpRequestHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { AgentQueryError, type AgentResponse } from "./agent-contracts.ts";
import type { AgentCaptureDiscovery, AgentCaptureOverview, CaptureDiscoveryFiltersInput } from "./canonical-query.ts";
import { ALLOW_AGENT_AUTHORED_NOTES_SETTING, CanonicalCaptureCommandService } from "./canonical-capture-command-service.ts";
import type { SqliteDatabase } from "./database.ts";
import { McpQueryExecutor, MCP_TOOL_TIMEOUT_MS } from "./mcp-query-executor.ts";

export { MCP_TOOL_TIMEOUT_MS } from "./mcp-query-executor.ts";

export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25"] as const;
export const MCP_SERVER_NAME = "Bus Lens Agent Access";
export const MCP_REQUEST_LIMIT_BYTES = 256 * 1024;
export const MCP_RESPONSE_LIMIT_BYTES = 96 * 1024;

const SERVER_INSTRUCTIONS = `Bus Lens is a local-first RS-485 capture analysis workbench. Use an overview-first workflow: list_captures, get_capture_overview, then choose a bounded analytical drill-down. Every analytical result is pinned to a capture/profile/source-data snapshot and is pageable. Raw bytes are available only through an explicit bounded read in a later tool surface. MCP exposes read-only analysis and evidence-linked notes when enabled; it never exposes framing mutation, capture control, replay, queue, serial, or ESP32 operations. Analytical reads run in a disposable read-only worker and are cancelled if they exceed ${MCP_TOOL_TIMEOUT_MS / 1000} seconds.`;

export const BUS_LENS_GUIDE = `# Bus Lens agent guide

## Hierarchy

Bus Lens evidence is organized as capture → framing profile → profile revision → section → frame. Raw bytes are the immutable byte stream; interpreted frames are a view produced by a versioned framing profile. A capture may retain active and historical framing revisions. A stable snapshot reference names the capture ID, profile ID, profile version, and source data revision.

Sequence groups describe repeated signature sequences. Occurrences are the individual appearances of one group in a frame stream. Notes target stable evidence such as a capture, raw byte/range, frame/range, or sequence group.

## Storage and limits

Canonical captures have modeled raw chunks, framing profiles, and derived analytical rows. Legacy JSON captures remain discoverable as legacy-not-canonicalized and include UI conversion guidance; analytical evidence is not inferred from a legacy document. Results are structured, size-bounded, and pageable. Use the supplied cursor unchanged with the same filters and snapshot. Raw reads are explicit and bounded; never request a complete capture.

## Execution limit

Analytical reads execute against a separate read-only SQLite connection in a disposable worker. A read that exceeds the local ${MCP_TOOL_TIMEOUT_MS / 1000}-second execution limit is cancelled by terminating that worker; the service's writable database connection is not interrupted or mutated. This safeguard requires a file-backed archive database; in-memory databases are rejected because transferring an unbounded synchronous snapshot would reintroduce event-loop blocking.

## Recommended overview-first workflow

1. Call list_captures with a narrow name, folder, view, lifecycle, or date filter when possible.
2. Call get_capture_overview for one canonical capture. Read its sections, counts, signatures, transitions, byte-position summary, sequence-group summaries, notes, and available bounds.
3. Select one drill-down operation based on that overview: message filters for an unusual signature, sequence-group occurrences for repetition, message context for local neighbors, byte statistics for varying positions, transitions for behavior changes, or a bounded raw read for a specific absolute range.
4. Preserve conclusions with an evidence-linked agent note only when annotation is enabled.

Unavailable operations include changing framing, changing visibility, creating/deleting captures, recording, replay, queue control, serial access, and ESP32/hardware control.
`;

const storageStatusSchema = z.enum(["canonical", "legacy-not-canonicalized", "converting", "canonicalization-failed"]);
const responseMetaSchema = z.object({
	contractVersion: z.literal(1),
	snapshot: z.object({
		captureId: z.string(),
		profileId: z.string(),
		profileVersion: z.number().int(),
		sourceDataRevision: z.number().int()
	}).optional(),
	appliedFilters: z.record(z.string(), z.unknown()),
	page: z.object({
		requestedLimit: z.number().int(),
		returned: z.number().int(),
		effectiveLimit: z.number().int().nonnegative(),
		nextCursor: z.string().optional(),
		truncationReason: z.enum(["page-limit", "response-size"]).optional()
	}).optional(),
	truncated: z.boolean(),
	suggestedOperations: z.array(z.object({ tool: z.string(), reason: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }))
});
export const agentResponseSchema = z.object({ data: z.unknown(), meta: responseMetaSchema });

type RecentClient = Readonly<{
	reportedClientName: string;
	reportedClientVersion?: string;
	protocolVersion: string;
	lastSeenAt: string;
}>;

export type McpClientAttribution = Readonly<{
	reportedClientName: string;
	reportedClientVersion?: string;
	protocolVersion: string;
}>;

export type AgentAccessStatus = Readonly<{
	endpoint: string;
	serverName: string;
	serverVersion: string;
	status: "running" | "stopped";
	supportedProtocolEras: readonly string[];
	readAccess: "available";
	agentNotes: "not-available-in-this-phase" | "disabled" | "enabled";
	recentClients: readonly RecentClient[];
}>;

export type McpToolRegistrar = (server: McpServer, queries: McpQueryExecutor, recordClient: (context: unknown, server: McpServer) => void, commands: CanonicalCaptureCommandService) => void;

export type McpAccessOptions = Readonly<{
	database: SqliteDatabase;
	databasePath?: string;
	endpoint: string;
	serverVersion: string;
	agentNotes?: AgentAccessStatus["agentNotes"];
	toolRegistrar?: McpToolRegistrar;
}>;

export function getMcpClientAttribution(context: unknown, server: McpServer): McpClientAttribution {
	const typed = context as {
		mcpReq?: { envelope?: Record<string, unknown> };
		http?: { req?: Request };
	};
	const envelope = typed.mcpReq?.envelope ?? {};
	const clientInfo = envelope["io.modelcontextprotocol/clientInfo"];
	const info = clientInfo && typeof clientInfo === "object" ? clientInfo as Record<string, unknown> : {};
	const requestVersion = envelope["io.modelcontextprotocol/protocolVersion"];
	const protocolVersion = typeof requestVersion === "string"
		? requestVersion
		: server.server.getNegotiatedProtocolVersion() ?? typed.http?.req?.headers.get("mcp-protocol-version") ?? "unknown-protocol";
	return {
		reportedClientName: typeof info.name === "string" && info.name ? info.name : "unknown-mcp-client",
		...(typeof info.version === "string" && info.version ? { reportedClientVersion: info.version } : {}),
		protocolVersion
	};
}

function synopsisForDiscovery(response: AgentResponse<AgentCaptureDiscovery>): string {
	const captures = response.data.captures;
	const canonical = captures.filter(capture => capture.status === "canonical").length;
	const legacy = captures.length - canonical;
	return `Found ${captures.length} capture${captures.length === 1 ? "" : "s"} (${canonical} canonical, ${legacy} legacy or unavailable). Use get_capture_overview for one bounded structure summary.`;
}

function synopsisForOverview(response: AgentResponse<AgentCaptureOverview>): string {
	const overview = response.data;
	if (overview.capture.status !== "canonical") return `${overview.capture.name} is ${overview.capture.status}; convert it in the Bus Lens UI before requesting analytical evidence.`;
	return `${overview.capture.name} has ${overview.counts.frames ?? 0} framed messages across ${overview.sections.length} section${overview.sections.length === 1 ? "" : "s"}; the response is pinned to profile ${overview.snapshot?.profileVersion ?? "unknown"}.`;
}

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
			suggestedOperations: [{ tool: "list_captures", reason: "Narrow the capture or evidence request and retry" }]
		}
	};
	return { isError: true, structuredContent: response, content: [{ type: "text", text: normalized.message }] };
}

function registerOrientationTools(server: McpServer, queries: McpQueryExecutor, recordClient: (context: unknown, server: McpServer) => void): void {
	server.registerResource(
		"guide",
		"buslens://guide",
		{ title: "Bus Lens agent guide", description: "Bounded, overview-first Bus Lens access guide", mimeType: "text/markdown" },
		async uri => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: BUS_LENS_GUIDE }] })
	);

	server.registerTool(
		"list_captures",
		{
			title: "List Bus Lens captures",
			description: "Discover compact capture summaries without loading message lists or raw bytes.",
			inputSchema: z.object({
				nameSearch: z.string().optional(),
				folderId: z.string().nullable().optional(),
				controllerView: z.string().optional(),
				contextParameters: z.record(z.string(), z.string()).optional(),
				createdFrom: z.string().optional(),
				createdTo: z.string().optional(),
				lifecycle: z.string().optional(),
				storageStatus: z.union([storageStatusSchema, z.array(storageStatusSchema)]).optional(),
				cursor: z.string().optional(),
				limit: z.number().int().positive().max(100).optional()
			}),
			outputSchema: agentResponseSchema
		},
		async (input, context) => {
			recordClient(context, server);
			try {
				const response = await queries.queryCaptureDiscovery(input as CaptureDiscoveryFiltersInput);
				return { structuredContent: response, content: [{ type: "text" as const, text: synopsisForDiscovery(response) }] };
			} catch (error) {
				return errorResult(error);
			}
		}
	);

	server.registerTool(
		"get_capture_overview",
		{
			title: "Get a Bus Lens capture overview",
			description: "Read bounded metadata, framing sections, counts, signatures, transitions, byte summaries, notes, and sequence-group summaries for one explicit analytical snapshot.",
			inputSchema: z.object({
				captureId: z.string().min(1),
				profileId: z.string().optional(),
				profileVersion: z.number().int().positive().optional(),
				sourceDataRevision: z.number().int().nonnegative().optional()
			}),
			outputSchema: agentResponseSchema
		},
		async (input, context) => {
			recordClient(context, server);
			try {
				const response = await queries.queryCaptureOverview(input.captureId, {
					captureId: input.captureId,
					...(input.profileId ? { profileId: input.profileId } : {}),
					...(input.profileVersion === undefined ? {} : { profileVersion: input.profileVersion }),
					...(input.sourceDataRevision === undefined ? {} : { sourceDataRevision: input.sourceDataRevision })
				});
				return { structuredContent: response, content: [{ type: "text" as const, text: synopsisForOverview(response) }] };
			} catch (error) {
				return errorResult(error);
			}
		}
	);
}

function boundedHandler(handler: McpHttpHandler, maxResponseBytes: number): McpHttpHandler {
	return {
		...handler,
		fetch: async (request, options) => {
			const response = await handler.fetch(request, options);
			const body = await response.clone().arrayBuffer();
			if (body.byteLength <= maxResponseBytes) return response;
			return new Response(JSON.stringify({ error: "MCP response exceeds the local response limit" }), {
				status: 413,
				headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
			});
		},
		close: handler.close
	};
}

type BoundedRequestBody = Readonly<{
	oversized: false;
	body: Buffer;
}> | Readonly<{
	oversized: true;
}>;

async function readBoundedRequestBody(request: IncomingMessage, maxBytes: number): Promise<BoundedRequestBody> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > maxBytes) {
			return { oversized: true };
		}
		chunks.push(buffer);
	}
	return { oversized: false, body: Buffer.concat(chunks, size) };
}

function replayableRequest(request: IncomingMessage, body: Buffer): Parameters<NodeMcpRequestHandler>[0] {
	return {
		method: request.method,
		url: request.url,
		headers: request.headers,
		async *[Symbol.asyncIterator]() {
			if (body.byteLength > 0) yield body;
		}
	};
}

export type McpAccess = Readonly<{
	handler: McpHttpHandler;
	nodeHandler: NodeMcpRequestHandler;
	endpoint: string;
	getStatus: () => AgentAccessStatus;
	handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
	close: () => Promise<void>;
}>;

export function createMcpAccess(options: McpAccessOptions): McpAccess {
	const queryExecutor = new McpQueryExecutor(options.databasePath ?? options.database.name);
	const commands = new CanonicalCaptureCommandService(options.database);
	const recentClients: RecentClient[] = [];
	let running = true;
	const agentNotesStatus = (): AgentAccessStatus["agentNotes"] => {
		if (options.agentNotes && options.agentNotes !== "not-available-in-this-phase") return options.agentNotes;
		const value = options.database.prepare("SELECT value_json FROM application_settings WHERE key = @key").get({ key: ALLOW_AGENT_AUTHORED_NOTES_SETTING }) as { value_json: string } | undefined;
		try {
			return value && JSON.parse(value.value_json) === true ? "enabled" : "disabled";
		} catch {
			return "disabled";
		}
	};
	const recordClient = (context: unknown, server: McpServer): void => {
		const client = getMcpClientAttribution(context, server);
		const entry: RecentClient = { ...client, lastSeenAt: new Date().toISOString() };
		const existingIndex = recentClients.findIndex(item => item.reportedClientName === entry.reportedClientName && item.reportedClientVersion === entry.reportedClientVersion);
		if (existingIndex >= 0) recentClients.splice(existingIndex, 1);
		recentClients.unshift(entry);
		if (recentClients.length > 20) recentClients.length = 20;
	};
	const handler = createMcpHandler(() => {
		const server = new McpServer(
			{ name: MCP_SERVER_NAME, version: options.serverVersion },
			{ instructions: SERVER_INSTRUCTIONS }
		);
		registerOrientationTools(server, queryExecutor, recordClient);
		options.toolRegistrar?.(server, queryExecutor, recordClient, commands);
		return server;
	}, {
		legacy: "stateless",
		responseMode: "json",
		keepAliveMs: 0,
		onerror: error => console.error("Bus Lens MCP request failed", error)
	});
	const safeHandler = boundedHandler(handler, MCP_RESPONSE_LIMIT_BYTES);
	const nodeHandler = toNodeHandler(safeHandler, { onerror: error => console.error("Bus Lens MCP adapter failed", error) });
	const hostValidation = hostHeaderValidationResponse;
	const originValidation = originValidationResponse;
	const getStatus = (): AgentAccessStatus => ({
		endpoint: options.endpoint,
		serverName: MCP_SERVER_NAME,
		serverVersion: options.serverVersion,
		status: running ? "running" : "stopped",
		supportedProtocolEras: MCP_PROTOCOL_VERSIONS,
		readAccess: "available",
		agentNotes: agentNotesStatus(),
		recentClients: recentClients
	});
	return {
		handler: safeHandler,
		nodeHandler,
		endpoint: options.endpoint,
		getStatus,
		handle: async (request, response) => {
			const hostRejected = hostValidation(new Request(options.endpoint, { headers: request.headers as Record<string, string> }), localhostAllowedHostnames());
			const originRejected = originValidation(new Request(options.endpoint, { headers: request.headers as Record<string, string> }), localhostAllowedOrigins());
			// The response helpers are fetch-shaped; plain node:http needs the same
			// validation result written explicitly before the SDK adapter runs.
			if (hostRejected || originRejected) {
				response.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				response.end(JSON.stringify({ error: "MCP Host or Origin is not allowed" }));
				request.resume();
				return;
			}
			const contentLengthHeader = request.headers["content-length"];
			const contentLength = typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : NaN;
			if (Number.isSafeInteger(contentLength) && contentLength > MCP_REQUEST_LIMIT_BYTES) {
				response.writeHead(413, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				response.end(JSON.stringify({ error: "MCP request exceeds the local request limit" }));
				request.resume();
				return;
			}
			if (request.method === "GET" || request.method === "HEAD") {
				await nodeHandler(request, response);
				return;
			}
			const boundedBody = await readBoundedRequestBody(request, MCP_REQUEST_LIMIT_BYTES);
			if (boundedBody.oversized) {
				response.writeHead(413, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				response.end(JSON.stringify({ error: "MCP request exceeds the local request limit" }));
				return;
			}
			await nodeHandler(replayableRequest(request, boundedBody.body), response);
		},
		close: async () => {
			running = false;
			await queryExecutor.close();
			await handler.close();
		}
	};
}

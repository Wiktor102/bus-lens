export type McpClient = Readonly<{
	reportedClientName: string;
	reportedClientVersion?: string;
	protocolVersion: string;
	lastSeenAt: string;
}>;

export type AgentAccessStatus = Readonly<{
	endpoint: string;
	serverName: string;
	serverVersion: string;
	status: "running" | "stopped";
	supportedProtocolEras: string[];
	readAccess: string;
	agentNotes: string;
	recentClients: McpClient[];
	activeRequests: number;
	lastRequestAt?: string;
	project: Readonly<{ id: string; name: string }>;
	recentUseWindowMs: number;
}>;

export class McpRecentlyUsedError extends Error {
	readonly status: AgentAccessStatus;

	constructor(status: AgentAccessStatus) {
		super("MCP was used recently");
		this.status = status;
	}
}

async function readResponse(response: Response): Promise<unknown> {
	return response.json().catch(() => ({}));
}

export async function getMcpStatus(): Promise<AgentAccessStatus> {
	const response = await fetch("/api/agent-access", { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error("MCP status unavailable");
	return response.json() as Promise<AgentAccessStatus>;
}

export async function setMcpProject(projectId: string, force = false): Promise<AgentAccessStatus> {
	const response = await fetch("/api/agent-access", {
		method: "PUT",
		headers: { accept: "application/json", "content-type": "application/json" },
		body: JSON.stringify({ projectId, force })
	});
	const payload = await readResponse(response) as { status?: AgentAccessStatus; error?: string } & Partial<AgentAccessStatus>;
	if (response.status === 409 && payload.status) throw new McpRecentlyUsedError(payload.status);
	if (!response.ok) throw new Error(payload.error ?? "Could not change the MCP project");
	return payload as AgentAccessStatus;
}

export async function setMcpAgentNotes(projectId: string, enabled: boolean): Promise<void> {
	const response = await fetch("/api/settings/allow_agent_authored_notes", {
		method: "PUT",
		headers: { "content-type": "application/json", "x-bus-lens-project": projectId },
		body: JSON.stringify(enabled)
	});
	if (!response.ok) throw new Error("Could not update agent note access");
}

export function mcpWasRecentlyUsed(status: AgentAccessStatus, now = Date.now()): boolean {
	if (status.activeRequests > 0) return true;
	return Boolean(status.lastRequestAt && now - Date.parse(status.lastRequestAt) < status.recentUseWindowMs);
}

export function formatMcpActivity(status: AgentAccessStatus): string {
	if (status.activeRequests > 0) return `${status.activeRequests} MCP request${status.activeRequests === 1 ? " is" : "s are"} still running.`;
	if (!status.lastRequestAt) return "No MCP requests have been seen.";
	const seconds = Math.max(0, Math.round((Date.now() - Date.parse(status.lastRequestAt)) / 1000));
	return seconds < 2 ? "An MCP request just finished." : `The last MCP request finished ${seconds} seconds ago.`;
}

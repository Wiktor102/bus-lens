import { useEffect, useState } from "react";
import { createClaudeMcpConfig, createCodexMcpConfig, resolveMcpEndpoint } from "./agent-config";

export const MCP_SETTINGS_PATH = "/settings/mcp";

type AgentAccessStatus = {
	endpoint: string;
	serverName: string;
	serverVersion: string;
	status: "running" | "stopped";
	supportedProtocolEras: string[];
	readAccess: string;
	agentNotes: string;
	recentClients: Array<{
		reportedClientName: string;
		reportedClientVersion?: string;
		protocolVersion: string;
		lastSeenAt: string;
	}>;
};

function AgentAccessPanel() {
	const [status, setStatus] = useState<AgentAccessStatus | null>(null);
	const [copied, setCopied] = useState<string | null>(null);

	useEffect(() => {
		let disposed = false;
		void fetch("/api/agent-access", { headers: { accept: "application/json" } })
			.then(response => response.ok ? response.json() as Promise<AgentAccessStatus> : Promise.reject(new Error("Agent access status unavailable")))
			.then(value => {
				if (!disposed) setStatus(value);
			})
			.catch(() => {
				if (!disposed) setStatus(null);
			});
		return () => { disposed = true; };
	}, []);

	const endpoint = resolveMcpEndpoint(status?.endpoint, window.location.origin);
	const codexConfig = createCodexMcpConfig(endpoint);
	const claudeConfig = createClaudeMcpConfig(endpoint);
	const copyConfig = async (name: string, value: string): Promise<void> => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(name);
			window.setTimeout(() => setCopied(current => current === name ? null : current), 1600);
		} catch {
			setCopied(null);
		}
	};

	return (
		<section id="agentAccessPanel" className="agent-access-panel" aria-labelledby="agentAccessTitle">
			<div className="agent-access-heading">
				<div>
					<span className="eyebrow">Local agent access</span>
					<h2 id="agentAccessTitle">MCP orientation</h2>
				</div>
				<span className={`status-badge ${status?.status === "running" ? "connected" : ""}`.trim()}>
					<i /> {status?.status ?? "checking"}
				</span>
			</div>
			<div className="agent-access-grid">
				<div><span>Endpoint</span><code>{endpoint}</code></div>
				<div><span>Server</span><strong>{status ? `${status.serverName} ${status.serverVersion}` : "Bus Lens Agent Access"}</strong></div>
				<div><span>Protocol eras</span><strong>{status?.supportedProtocolEras.join(", ") ?? "2026-07-28, 2025-11-25"}</strong></div>
				<div><span>Read access</span><strong>{status?.readAccess ?? "available"}</strong></div>
				<div><span>Agent notes</span><strong>{status?.agentNotes ?? "not available in this phase"}</strong></div>
				<div><span>Recent clients</span><strong>{status?.recentClients.length ? status.recentClients.map(client => `${client.reportedClientName}${client.reportedClientVersion ? ` ${client.reportedClientVersion}` : ""}`).join(", ") : "None reported yet"}</strong></div>
			</div>
			<p className="muted">MCP is stateless; “recent clients” are self-reported observations, not authenticated connections.</p>
			<div className="agent-access-configs">
				<div>
					<header><span>Codex</span><button className="btn btn-secondary" type="button" onClick={() => void copyConfig("codex", codexConfig)}>{copied === "codex" ? "Copied" : "Copy config"}</button></header>
					<pre>{codexConfig}</pre>
				</div>
				<div>
					<header><span>Claude</span><button className="btn btn-secondary" type="button" onClick={() => void copyConfig("claude", claudeConfig)}>{copied === "claude" ? "Copied" : "Copy config"}</button></header>
					<pre>{claudeConfig}</pre>
				</div>
			</div>
		</section>
	);
}

export function McpSettingsPage() {
	return (
		<main className="mcp-page">
			<div className="mcp-page-heading">
				<div>
					<span className="eyebrow">Settings</span>
					<h1>MCP agent access</h1>
					<p className="muted">Connect a local coding agent to Bus Lens for read-only capture analysis.</p>
				</div>
				<a className="btn btn-secondary" href="/">Back to workbench</a>
			</div>
			<AgentAccessPanel />
		</main>
	);
}

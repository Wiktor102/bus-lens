import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Radio, ShieldCheck } from "lucide-react";
import { useArchiveCommands, useProjects } from "../data/archive-react";
import type { ProjectSummary } from "../persistence/archive-client";
import { createClaudeMcpConfig, createCodexMcpConfig, resolveMcpEndpoint } from "./agent-config";
import { getMcpStatus, McpRecentlyUsedError, setMcpAgentNotes, setMcpProject, type AgentAccessStatus } from "./mcp-access";
import { McpRetargetDialog } from "./mcp-retarget-dialog";

export const MCP_SETTINGS_PATH = "/settings/mcp";
export type { AgentAccessStatus } from "./mcp-access";
type ConfigName = "codex" | "claude";

function AgentConfigCard({ codexConfig, claudeConfig }: { codexConfig: string; claudeConfig: string }) {
	const [copied, setCopied] = useState<ConfigName | null>(null);
	const [expanded, setExpanded] = useState(false);
	const configs = [
		{ name: "codex" as const, label: "Codex", value: codexConfig },
		{ name: "claude" as const, label: "Claude Code", value: claudeConfig }
	];
	const copyConfig = async (name: ConfigName, value: string): Promise<void> => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(name);
			window.setTimeout(() => setCopied(current => current === name ? null : current), 1600);
		} catch {
			setCopied(null);
		}
	};
	return (
		<section className="mcp-settings-section agent-config-card" aria-labelledby="agentConfigTitle">
			<button className="agent-config-toggle" type="button" aria-expanded={expanded} aria-controls="agentConfigContent" onClick={() => setExpanded(current => !current)}>
				<span className="mcp-section-heading"><span className="mcp-section-icon" aria-hidden="true"><Copy /></span><span><strong id="agentConfigTitle">Connect an agent</strong><small>Copy the endpoint config once. Project changes happen here in Bus Lens.</small></span></span>
				<span className="agent-config-chevron" aria-hidden="true">{expanded ? <ChevronDown /> : <ChevronRight />}</span>
			</button>
			{expanded ? <div id="agentConfigContent" className="agent-config-content">
				{configs.map(config => <div className="agent-config-option" key={config.name}>
					<header><strong>{config.label}</strong><button className="btn btn-secondary" type="button" onClick={() => { void copyConfig(config.name, config.value); }}>{copied === config.name ? <><Check aria-hidden="true" /> Copied</> : <><Copy aria-hidden="true" /> Copy</>}</button></header>
					<pre>{config.value}</pre>
				</div>)}
			</div> : null}
		</section>
	);
}

function relativeTime(value: string): string {
	const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	return `${Math.round(seconds / 60)}m ago`;
}

function ProjectRouting({ projects, status, busy, onSelect }: { projects: readonly ProjectSummary[]; status: AgentAccessStatus; busy: boolean; onSelect: (project: ProjectSummary) => void }) {
	return (
		<section className="mcp-settings-section" aria-labelledby="mcpProjectTitle">
			<div className="mcp-section-heading"><span className="mcp-section-icon" aria-hidden="true"><Radio /></span><span><strong id="mcpProjectTitle">MCP project</strong><small>The endpoint reads one project until you move it.</small></span></div>
			<div className="mcp-project-list">{projects.map(project => {
				const selected = project.id === status.project.id;
				return <div className="mcp-project-row" data-selected={selected || undefined} key={project.id}>
					<span className="mcp-project-indicator" aria-hidden="true" /><span><strong>{project.name}</strong><small>{selected ? "Serving MCP now" : "Available"}</small></span>
					{selected ? <span className="mcp-project-current"><Check aria-hidden="true" /> Current</span> : <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => onSelect(project)}>Use for MCP</button>}
				</div>;
			})}</div>
		</section>
	);
}

function AgentAccessPanel() {
	const commands = useArchiveCommands();
	const projectsQuery = useProjects();
	const [status, setStatus] = useState<AgentAccessStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [savingNotes, setSavingNotes] = useState(false);
	const [confirmation, setConfirmation] = useState<Readonly<{ status: AgentAccessStatus; target: ProjectSummary }> | null>(null);
	useEffect(() => {
		let disposed = false;
		void getMcpStatus().then(value => { if (!disposed) setStatus(value); }).catch(() => { if (!disposed) setError("The local MCP service did not respond."); });
		return () => { disposed = true; };
	}, []);
	const projects = projectsQuery.data ?? [];
	const activeProjectId = commands.activeProjectId() ?? "default";
	const activeProject = projects.find(project => project.id === activeProjectId);
	const endpoint = resolveMcpEndpoint(status?.endpoint, window.location.origin);
	const changeProject = async (project: ProjectSummary, force: boolean): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			const next = await setMcpProject(project.id, force);
			setStatus(next);
			setConfirmation(null);
		} catch (changeError) {
			if (changeError instanceof McpRecentlyUsedError) setConfirmation({ status: changeError.status, target: project });
			else setError(changeError instanceof Error ? changeError.message : "Could not change the MCP project.");
		} finally {
			setBusy(false);
		}
	};
	const updateNotes = async (enabled: boolean): Promise<void> => {
		if (!status) return;
		setSavingNotes(true);
		setError(null);
		try {
			await setMcpAgentNotes(status.project.id, enabled);
			setStatus(current => current ? { ...current, agentNotes: enabled ? "enabled" : "disabled" } : current);
		} catch (notesError) {
			setError(notesError instanceof Error ? notesError.message : "Could not update agent note access.");
		} finally {
			setSavingNotes(false);
		}
	};
	return <>
		<section className={`mcp-state-card ${status ? "running" : "offline"}`.trim()}>
			<div className="mcp-state-signal"><span aria-hidden="true" /><small>{status ? "Running" : "Unavailable"}</small></div>
			<div><span className="eyebrow">Global MCP endpoint</span><h2>{status?.project.name ?? "No project status"}</h2><p>{status ? "All MCP requests are routed to this project." : "Bus Lens could not read the MCP service status."}</p></div>
			{status && activeProject && activeProject.id !== status.project.id ? <button className="btn btn-warning" type="button" disabled={busy} onClick={() => { void changeProject(activeProject, false); }}>Use this project</button> : null}
		</section>
		{error ? <p className="conversion-error mcp-error" role="alert">{error}</p> : null}
		{status ? <ProjectRouting projects={projects} status={status} busy={busy} onSelect={project => { void changeProject(project, false); }} /> : null}
		{status ? <section className="mcp-settings-section" aria-labelledby="mcpAccessTitle">
			<div className="mcp-section-heading"><span className="mcp-section-icon" aria-hidden="true"><ShieldCheck /></span><span><strong id="mcpAccessTitle">Access</strong><small>Analysis is read-only. Agent notes are the only optional write.</small></span></div>
			<label className="agent-notes-toggle"><span><strong>Allow agent-authored notes</strong><small>Agents can append evidence-linked notes in {status.project.name}.</small></span><input type="checkbox" checked={status.agentNotes === "enabled"} disabled={savingNotes} onChange={event => { const enabled = event.currentTarget.checked; void updateNotes(enabled); }} /></label>
		</section> : null}
		{status ? <section className="mcp-settings-section" aria-labelledby="mcpClientsTitle">
			<div className="mcp-section-heading"><span className="mcp-section-icon mcp-client-count" aria-hidden="true">{status.recentClients.length}</span><span><strong id="mcpClientsTitle">Recent clients</strong><small>Self-reported MCP activity for the current target.</small></span></div>
			{status.recentClients.length ? <ul className="mcp-client-list">{status.recentClients.map(client => <li key={`${client.reportedClientName}-${client.reportedClientVersion ?? ""}`}><span><strong>{client.reportedClientName}{client.reportedClientVersion ? ` ${client.reportedClientVersion}` : ""}</strong><small>{client.protocolVersion}</small></span><time dateTime={client.lastSeenAt}>{relativeTime(client.lastSeenAt)}</time></li>)}</ul> : <p className="mcp-empty">No client has used MCP since this project was selected.</p>}
		</section> : null}
		<AgentConfigCard codexConfig={createCodexMcpConfig(endpoint)} claudeConfig={createClaudeMcpConfig(endpoint)} />
		{status ? <details className="mcp-technical"><summary>Technical details</summary><dl><div><dt>Endpoint</dt><dd><code>{endpoint}</code></dd></div><div><dt>Server</dt><dd>{status.serverName} {status.serverVersion}</dd></div><div><dt>Protocol versions</dt><dd>{status.supportedProtocolEras.join(", ")}</dd></div></dl></details> : null}
		<McpRetargetDialog status={confirmation?.status ?? null} targetName={confirmation?.target.name ?? "project"} busy={busy} onCancel={() => setConfirmation(null)} onConfirm={() => { if (confirmation) void changeProject(confirmation.target, true); }} />
	</>;
}

export function McpSettingsPage() {
	return <main className="mcp-page"><div className="mcp-page-heading"><div><span className="eyebrow">Settings / MCP</span><h1>Agent access</h1><p>Choose the project exposed at the local MCP endpoint.</p></div><a className="btn btn-secondary" href="/">Back to workbench</a></div><AgentAccessPanel /></main>;
}

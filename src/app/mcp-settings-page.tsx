import { useState } from "react";
import {
	ArrowLeft,
	Bot,
	Check,
	CheckCircle2,
	Copy,
	FolderGit2,
	Globe,
	Info,
	Radio,
	RefreshCw,
	ShieldCheck,
	Terminal,
	Zap
} from "lucide-react";
import { useArchiveCommands, useProjects } from "../data/archive-react";
import { useMcpProjectMutationPending, useMcpStatus, useSetMcpAgentNotes, useSetMcpProject } from "../data/mcp-react";
import { orderedProjectOptions } from "../features/projects/projects-model";
import type { ProjectSummary } from "../persistence/archive-client";
import {
	createClaudeCliCommand,
	createClaudeMcpConfig,
	createCodexMcpConfig,
	createCursorMcpConfig,
	resolveMcpEndpoint
} from "./agent-config";
import { McpRecentlyUsedError, type AgentAccessStatus } from "./mcp-access";
import { McpRetargetDialog } from "./mcp-retarget-dialog";

export const MCP_SETTINGS_PATH = "/settings/mcp";
export type { AgentAccessStatus } from "./mcp-access";

type ClientTab = "claude-cli" | "claude-json" | "codex" | "cursor" | "raw-url";

function relativeTime(value: string): string {
	const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function CopyButton({
	text,
	label = "Copy",
	copiedLabel = "Copied!",
	className = "btn btn-secondary btn-sm"
}: {
	text: string;
	label?: string;
	copiedLabel?: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1800);
		} catch {
			setCopied(false);
		}
	};

	return (
		<button className={className} type="button" onClick={() => { void handleCopy(); }}>
			{copied ? (
				<>
					<Check className="icon-sm text-acid" aria-hidden="true" />
					<span>{copiedLabel}</span>
				</>
			) : (
				<>
					<Copy className="icon-sm" aria-hidden="true" />
					<span>{label}</span>
				</>
			)}
		</button>
	);
}

function AgentConfigSection({ endpoint }: { endpoint: string }) {
	const [activeTab, setActiveTab] = useState<ClientTab>("claude-cli");

	const tabOptions: Array<{ id: ClientTab; label: string; icon: React.ReactNode }> = [
		{ id: "claude-cli", label: "Claude Code CLI", icon: <Terminal size={14} /> },
		{ id: "claude-json", label: "Claude Desktop / JSON", icon: <Bot size={14} /> },
		{ id: "codex", label: "Codex TOML", icon: <Bot size={14} /> },
		{ id: "cursor", label: "Cursor / Windsurf", icon: <Bot size={14} /> },
		{ id: "raw-url", label: "Direct Endpoint", icon: <Globe size={14} /> }
	];

	const getSnippet = (tab: ClientTab): { code: string; hint: string; fileHint: string } => {
		switch (tab) {
			case "claude-cli":
				return {
					code: createClaudeCliCommand(endpoint),
					hint: "Run directly in your terminal to instantly connect Claude Code to Bus Lens.",
					fileHint: "Terminal command"
				};
			case "claude-json":
				return {
					code: createClaudeMcpConfig(endpoint),
					hint: "Add to your project's .mcp.json or ~/.claude/claude_desktop_config.json file.",
					fileHint: ".mcp.json / claude_desktop_config.json"
				};
			case "codex":
				return {
					code: createCodexMcpConfig(endpoint),
					hint: "Append this configuration block to ~/.codex/config.toml under your MCP servers.",
					fileHint: "~/.codex/config.toml"
				};
			case "cursor":
				return {
					code: createCursorMcpConfig(endpoint),
					hint: "Paste into .cursor/mcp.json or configure in Cursor / Windsurf Settings > MCP.",
					fileHint: ".cursor/mcp.json"
				};
			case "raw-url":
				return {
					code: endpoint,
					hint: "Standard HTTP Model Context Protocol endpoint supporting SSE and streamable JSON-RPC.",
					fileHint: "HTTP Server-Sent Events Endpoint"
				};
		}
	};

	const currentSnippet = getSnippet(activeTab);

	return (
		<section className="mcp-card" aria-labelledby="agentSetupTitle">
			<div className="mcp-card-header">
				<div className="mcp-card-title-group">
					<span className="mcp-card-icon" aria-hidden="true"><Bot /></span>
					<div>
						<h2 id="agentSetupTitle">Connect an AI Assistant</h2>
						<p>Quick configuration snippets for your preferred AI development environment.</p>
					</div>
				</div>
			</div>

			<div className="mcp-tab-bar" role="tablist" aria-label="MCP Client Configuration Formats">
				{tabOptions.map(tab => (
					<button
						key={tab.id}
						role="tab"
						aria-selected={activeTab === tab.id}
						className={`mcp-tab ${activeTab === tab.id ? "active" : ""}`}
						type="button"
						onClick={() => setActiveTab(tab.id)}
					>
						<span className="mcp-tab-icon" aria-hidden="true">{tab.icon}</span>
						<span>{tab.label}</span>
					</button>
				))}
			</div>

			<div className="mcp-snippet-container">
				<div className="mcp-snippet-header">
					<span className="mcp-snippet-file">{currentSnippet.fileHint}</span>
					<CopyButton text={currentSnippet.code} label="Copy snippet" copiedLabel="Copied snippet!" />
				</div>
				<pre className="mcp-snippet-code">
					<code>{currentSnippet.code}</code>
				</pre>
				<p className="mcp-snippet-hint">
					<Info size={13} aria-hidden="true" />
					<span>{currentSnippet.hint}</span>
				</p>
			</div>
		</section>
	);
}

function ProjectRoutingSection({
	projects,
	status,
	busy,
	activeProjectId,
	onSelect
}: {
	projects: readonly ProjectSummary[];
	status: AgentAccessStatus;
	busy: boolean;
	activeProjectId: string | null;
	onSelect: (project: ProjectSummary) => void;
}) {
	const projectsById = new Map(projects.map(project => [project.id, project]));
	const ordered = orderedProjectOptions(projects);

	return (
		<section className="mcp-card" aria-labelledby="mcpProjectTitle">
			<div className="mcp-card-header">
				<div className="mcp-card-title-group">
					<span className="mcp-card-icon" aria-hidden="true"><Radio /></span>
					<div>
						<h2 id="mcpProjectTitle">Project Target Routing</h2>
						<p>All MCP analysis queries target the active project below without restarting connected agents.</p>
					</div>
				</div>
				<span className="mcp-badge count-badge">{projects.length} project{projects.length === 1 ? "" : "s"}</span>
			</div>

			<div className="mcp-project-grid">
				{ordered.map(option => {
					const project = projectsById.get(option.value)!;
					const isServingMcp = project.id === status.project.id;
					const isWorkbenchActive = project.id === activeProjectId;

					return (
						<div
							className={`mcp-project-card ${isServingMcp ? "serving" : ""}`}
							data-selected={isServingMcp || undefined}
							key={project.id}
						>
							<div className="mcp-project-card-main">
								<div className="mcp-project-card-header">
									<div className="mcp-project-status-dot" aria-hidden="true" />
									<strong className="mcp-project-card-name">{option.label}</strong>
									<div className="mcp-project-badges">
										{isServingMcp ? (
											<span className="mcp-badge serving-badge">
												<Check size={11} aria-hidden="true" /> Serving MCP
											</span>
										) : null}
										{isWorkbenchActive ? (
											<span className="mcp-badge workbench-badge" title="Currently selected in Bus Lens workbench">
												Workbench
											</span>
										) : null}
									</div>
								</div>
								<div className="mcp-project-card-meta">
									<span title={project.dbPath}>ID: {project.id}</span>
									{project.lastUsedAt ? <span>Used {relativeTime(project.lastUsedAt)}</span> : null}
								</div>
							</div>
							<div className="mcp-project-card-actions">
								{isServingMcp ? (
									<span className="mcp-current-pill">
										<CheckCircle2 size={14} aria-hidden="true" />
										<span>Active Target</span>
									</span>
								) : (
									<button
										className="btn btn-secondary btn-sm"
										type="button"
										disabled={busy}
										onClick={() => onSelect(project)}
									>
										<span>Route MCP Here</span>
									</button>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</section>
	);
}

function AccessAndSecuritySection({
	status,
	isUpdatingNotes,
	onUpdateNotes
}: {
	status: AgentAccessStatus;
	isUpdatingNotes: boolean;
	onUpdateNotes: (enabled: boolean) => void;
}) {
	const notesEnabled = status.agentNotes === "enabled";

	return (
		<section className="mcp-card" aria-labelledby="mcpAccessTitle">
			<div className="mcp-card-header">
				<div className="mcp-card-title-group">
					<span className="mcp-card-icon" aria-hidden="true"><ShieldCheck /></span>
					<div>
						<h2 id="mcpAccessTitle">Access Controls & Safety</h2>
						<p>Bus Lens guarantees deterministic isolation between AI assistants and raw hardware.</p>
					</div>
				</div>
			</div>

			<div className="mcp-security-points">
				<div className="mcp-security-item">
					<div className="mcp-security-item-icon text-acid" aria-hidden="true"><Check size={15} /></div>
					<div>
						<strong>Read-Only Protocol Analysis</strong>
						<p>Raw bytes, message framing profiles, timing queries, and contextual search are strictly read-only.</p>
					</div>
				</div>
				<div className="mcp-security-item">
					<div className="mcp-security-item-icon text-acid" aria-hidden="true"><Check size={15} /></div>
					<div>
						<strong>Hardware & Replay Isolation</strong>
						<p>MCP agents cannot initiate serial transmission, trigger packet replays, or modify framing profiles.</p>
					</div>
				</div>
			</div>

			<div className="mcp-permission-box">
				<div className="mcp-permission-info">
					<div className="mcp-permission-title-row">
						<strong>Allow Agent-Authored Notes</strong>
						<span className={`mcp-badge ${notesEnabled ? "enabled-badge" : "disabled-badge"}`}>
							{notesEnabled ? "Enabled (Read/Write)" : "Disabled (Read-Only)"}
						</span>
					</div>
					<p>
						When enabled, AI assistants can append evidence-linked protocol hypotheses and notes in <em>{status.project.name}</em>.
					</p>
				</div>
				<label className="mcp-switch-label" htmlFor="mcpAgentNotesToggle">
					<input
						id="mcpAgentNotesToggle"
						type="checkbox"
						role="switch"
						aria-checked={notesEnabled}
						checked={notesEnabled}
						disabled={isUpdatingNotes}
						onChange={event => {
							const enabled = event.currentTarget.checked;
							onUpdateNotes(enabled);
						}}
					/>
					<span className="mcp-switch-slider" aria-hidden="true" />
				</label>
			</div>
		</section>
	);
}

function RecentClientsSection({ clients }: { clients: AgentAccessStatus["recentClients"] }) {
	return (
		<section className="mcp-card" aria-labelledby="mcpClientsTitle">
			<div className="mcp-card-header">
				<div className="mcp-card-title-group">
					<span className="mcp-card-icon" aria-hidden="true"><Zap /></span>
					<div>
						<h2 id="mcpClientsTitle">Connected Clients & Activity</h2>
						<p>Live and recent Model Context Protocol sessions querying this endpoint.</p>
					</div>
				</div>
				<span className="mcp-badge count-badge">
					{clients.length} client{clients.length === 1 ? "" : "s"}
				</span>
			</div>

			{clients.length > 0 ? (
				<div className="mcp-client-table-wrap">
					<table className="mcp-client-table">
						<thead>
							<tr>
								<th scope="col">Client Assistant</th>
								<th scope="col">Protocol</th>
								<th scope="col">Last Activity</th>
							</tr>
						</thead>
						<tbody>
							{clients.map(client => (
								<tr key={`${client.reportedClientName}-${client.reportedClientVersion ?? ""}-${client.lastSeenAt}`}>
									<td>
										<div className="mcp-client-name-cell">
											<span className="mcp-client-dot" aria-hidden="true" />
											<div>
												<strong>{client.reportedClientName}</strong>
												{client.reportedClientVersion ? (
													<span className="mcp-client-version">v{client.reportedClientVersion}</span>
												) : null}
											</div>
										</div>
									</td>
									<td>
										<span className="mcp-tag">{client.protocolVersion}</span>
									</td>
									<td>
										<time dateTime={client.lastSeenAt} title={new Date(client.lastSeenAt).toLocaleString()}>
											{relativeTime(client.lastSeenAt)}
										</time>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<div className="mcp-empty-state">
					<div className="mcp-empty-icon" aria-hidden="true"><Bot size={22} /></div>
					<p><strong>No agent activity recorded for this project yet.</strong></p>
					<span>Once you configure Claude Code, Codex, or Cursor, live tool requests will appear here.</span>
				</div>
			)}
		</section>
	);
}

function TechnicalDetailsSection({
	status,
	endpoint
}: {
	status: AgentAccessStatus;
	endpoint: string;
}) {
	return (
		<section className="mcp-card mcp-card-compact" aria-labelledby="mcpTechTitle">
			<div className="mcp-card-header">
				<div className="mcp-card-title-group">
					<span className="mcp-card-icon" aria-hidden="true"><FolderGit2 /></span>
					<div>
						<h2 id="mcpTechTitle">Endpoint Specifications</h2>
						<p>Service diagnostics and runtime environment details.</p>
					</div>
				</div>
			</div>

			<div className="mcp-specs-grid">
				<div className="mcp-spec-item">
					<span className="mcp-spec-label">Server Identity</span>
					<strong className="mcp-spec-value">{status.serverName} v{status.serverVersion}</strong>
				</div>
				<div className="mcp-spec-item">
					<span className="mcp-spec-label">Transport Type</span>
					<strong className="mcp-spec-value">HTTP Streamable (SSE / JSON-RPC)</strong>
				</div>
				<div className="mcp-spec-item">
					<span className="mcp-spec-label">Protocol Eras</span>
					<strong className="mcp-spec-value">{status.supportedProtocolEras.join(", ")}</strong>
				</div>
				<div className="mcp-spec-item">
					<span className="mcp-spec-label">Sandbox Engine</span>
					<strong className="mcp-spec-value">Worker Thread (30s Query Timeout)</strong>
				</div>
				<div className="mcp-spec-item full-width">
					<span className="mcp-spec-label">Bound Endpoint URL</span>
					<div className="mcp-spec-url-row">
						<code>{endpoint}</code>
						<CopyButton text={endpoint} label="Copy URL" copiedLabel="Copied!" className="btn btn-secondary btn-xs" />
					</div>
				</div>
			</div>
		</section>
	);
}

function AgentAccessPanel() {
	const commands = useArchiveCommands();
	const projectsQuery = useProjects();
	const statusQuery = useMcpStatus();
	const setProjectMutation = useSetMcpProject();
	const setNotesMutation = useSetMcpAgentNotes();
	const busy = useMcpProjectMutationPending();
	const [error, setError] = useState<string | null>(null);
	const [confirmation, setConfirmation] = useState<Readonly<{ status: AgentAccessStatus; target: ProjectSummary }> | null>(null);

	const status = statusQuery.data ?? null;
	const visibleError = error ?? (statusQuery.isError && !status ? "The local MCP service did not respond." : null);
	const projects = projectsQuery.data ?? [];
	const activeProjectId = commands.activeProjectId() ?? "default";
	const activeProject = projects.find(project => project.id === activeProjectId);
	const endpoint = resolveMcpEndpoint(status?.endpoint, window.location.origin);

	const changeProject = async (project: ProjectSummary, force: boolean): Promise<void> => {
		setError(null);
		try {
			await setProjectMutation.mutateAsync({ projectId: project.id, force });
			setConfirmation(null);
		} catch (changeError) {
			if (changeError instanceof McpRecentlyUsedError) {
				setConfirmation({ status: changeError.status, target: project });
			} else {
				setError(changeError instanceof Error ? changeError.message : "Could not change the MCP project.");
			}
		}
	};

	const updateNotes = async (enabled: boolean): Promise<void> => {
		if (!status) return;
		const projectId = status.project.id;
		setError(null);
		try {
			await setNotesMutation.mutateAsync({ projectId, enabled });
		} catch (notesError) {
			setError(notesError instanceof Error ? notesError.message : "Could not update agent note access.");
		}
	};

	const isRunning = Boolean(status && status.status !== "stopped");

	return (
		<div className="mcp-dashboard">
			{/* Operational Cockpit Hero Banner */}
			<section className={`mcp-cockpit ${isRunning ? "running" : "offline"}`} aria-label="MCP Server Status">
				<div className="mcp-cockpit-status">
					<div className="mcp-cockpit-signal">
						<span className="signal-pulse" aria-hidden="true" />
						<div className="signal-text">
							<span className="eyebrow">Service Status</span>
							<strong>{isRunning ? "MCP Online & Ready" : "Service Offline"}</strong>
						</div>
					</div>

					<div className="mcp-cockpit-target">
						<span className="eyebrow">Active Target Project</span>
						<div className="mcp-cockpit-target-row">
							<h2 className="mcp-cockpit-project-name">{status?.project.name ?? "Unavailable"}</h2>
							{status ? <span className="mcp-badge serving-badge">Serving</span> : null}
						</div>
					</div>
				</div>

				<div className="mcp-cockpit-endpoint">
					<div className="mcp-cockpit-endpoint-box">
						<span className="eyebrow">Direct Endpoint URL</span>
						<div className="mcp-cockpit-url-row">
							<code>{endpoint}</code>
							<CopyButton text={endpoint} label="Copy URL" copiedLabel="Copied!" />
						</div>
					</div>

					<div className="mcp-cockpit-stats">
						<div className="mcp-stat-pill">
							<span className="stat-label">Notes:</span>
							<strong className={status?.agentNotes === "enabled" ? "text-acid" : "text-muted"}>
								{status?.agentNotes === "enabled" ? "Read/Write" : "Read-Only"}
							</strong>
						</div>
						<div className="mcp-stat-pill">
							<span className="stat-label">Clients:</span>
							<strong>{status?.recentClients.length ?? 0} active</strong>
						</div>
						<div className="mcp-stat-pill">
							<span className="stat-label">Server:</span>
							<strong>{status?.serverName ?? "bus-lens"}</strong>
						</div>
					</div>
				</div>
			</section>

			{/* Project mismatch warning helper */}
			{status && activeProject && activeProject.id !== status.project.id ? (
				<div className="mcp-mismatch-banner" role="status">
					<div className="mcp-mismatch-text">
						<Info className="icon-md text-amber" aria-hidden="true" />
						<div>
							<strong>Workbench project mismatch</strong>
							<p>
								Bus Lens is viewing <strong>{activeProject.name}</strong>, but MCP queries are targeting <strong>{status.project.name}</strong>.
							</p>
						</div>
					</div>
					<button
						className="btn btn-warning btn-sm"
						type="button"
						disabled={busy}
						onClick={() => { void changeProject(activeProject, false); }}
					>
						<RefreshCw className="icon-sm" aria-hidden="true" />
						<span>Switch MCP to {activeProject.name}</span>
					</button>
				</div>
			) : null}

			{visibleError ? (
				<div className="conversion-error mcp-error-banner" role="alert">
					<strong>MCP Error:</strong> {visibleError}
				</div>
			) : null}

			{/* Two-Column Spacious Grid Layout */}
			<div className="mcp-grid">
				{/* Left Column: Project Routing & Access Safety */}
				<div className="mcp-col">
					{status ? (
						<ProjectRoutingSection
							projects={projects}
							status={status}
							busy={busy}
							activeProjectId={activeProjectId}
							onSelect={project => { void changeProject(project, false); }}
						/>
					) : null}

					{status ? (
						<AccessAndSecuritySection
							status={status}
							isUpdatingNotes={setNotesMutation.isPending}
							onUpdateNotes={enabled => { void updateNotes(enabled); }}
						/>
					) : null}
				</div>

				{/* Right Column: AI Assistant Setup & Live Clients & Diagnostics */}
				<div className="mcp-col">
					<AgentConfigSection endpoint={endpoint} />

					{status ? (
						<RecentClientsSection clients={status.recentClients} />
					) : null}

					{status ? (
						<TechnicalDetailsSection status={status} endpoint={endpoint} />
					) : null}
				</div>
			</div>

			<McpRetargetDialog
				status={confirmation?.status ?? null}
				targetName={confirmation?.target.name ?? "project"}
				busy={busy}
				onCancel={() => setConfirmation(null)}
				onConfirm={() => {
					if (confirmation) void changeProject(confirmation.target, true);
				}}
			/>
		</div>
	);
}

export function McpSettingsPage() {
	return (
		<main className="mcp-page">
			<header className="mcp-page-heading">
				<div>
					<div className="mcp-breadcrumb">
						<span>Settings</span>
						<span className="breadcrumb-sep">/</span>
						<span className="breadcrumb-current">Model Context Protocol</span>
					</div>
					<h1>Agent Access & MCP Endpoint</h1>
					<p>Expose local RS-485 captures and protocol intelligence to AI assistants.</p>
				</div>
				<div className="mcp-page-actions">
					<a className="btn btn-secondary" href="/">
						<ArrowLeft className="icon-sm" aria-hidden="true" />
						<span>Back to workbench</span>
					</a>
				</div>
			</header>
			<AgentAccessPanel />
		</main>
	);
}

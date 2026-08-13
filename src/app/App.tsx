import {
	memo,
	useEffect,
	useLayoutEffect,
	useReducer,
	useRef,
	useState,
	useSyncExternalStore,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type RefObject
} from "react";
import { ArchiveSidebar } from "../features/archive/archive-sidebar";
import { getAnalysisSnapshot, subscribeToAnalysis } from "../features/analysis/analysis-bridge";
import {
	getCaptureHeaderActions,
	getCaptureHeaderSnapshot,
	subscribeToCaptureHeader
} from "../features/capture/capture-header-bridge";
import {
	getCaptureStorageActions,
	getCaptureStorageSnapshot,
	subscribeToCaptureStorage
} from "../features/capture/capture-storage-bridge";
import { normalizeCaptureDescription, normalizeCaptureTitle } from "../features/capture/capture-header";
import {
	getFramingToolbarSnapshot,
	subscribeToFramingToolbar
} from "../features/capture/framing-toolbar-bridge";
import { getSendActions, getSendSnapshot, subscribeToSend } from "../features/send/send-bridge";
import { deriveSendViewModel, formatSendTime, parseTransmitHex } from "../features/send/send";
import { getTransportActions, getTransportSnapshot, subscribeToTransport } from "../features/transport/transport-bridge";
import { getNotesActions, getNotesSnapshot, subscribeToNotes } from "../features/notes/notes-bridge";
import { getToastSnapshot, subscribeToToast } from "../shared/toast-bridge";
import {
	getPersistenceErrorActions,
	getPersistenceErrorSnapshot,
	subscribeToPersistenceError
} from "../shared/persistence-error-bridge";
import {
	AnnotationDialog,
	CanonicalizationDialog,
	ContextDialog,
	ExportDialog,
	PatternRemarkDialog
} from "../features/dialogs/dialogs";
import { getMessageStreamSnapshot, subscribeToMessageStream } from "../features/message-stream/message-stream-bridge";
import { MessageStream } from "../features/message-stream/message-stream-view";
import { publishViewStateSnapshot } from "../shared/view-state-bridge";
import {
	EMPTY_VIEW_STATE_SNAPSHOT,
	reduceViewState,
	type DisplayMode,
	type ViewStateAction,
	type ViewStateSnapshot
} from "../shared/view-state";
import { MCP_SETTINGS_PATH, McpSettingsPage, type AgentAccessStatus } from "./mcp-settings-page";
import { StatusSplitControl } from "./status-split-control";
import "./styles.css";

function TopBar() {
	const snapshot = useSyncExternalStore(
		subscribeToTransport,
		getTransportSnapshot,
		getTransportSnapshot
	);
	const actions = getTransportActions();
	const [mcpStatus, setMcpStatus] = useState<AgentAccessStatus["status"] | "checking" | "unavailable">("checking");

	useEffect(() => {
		let disposed = false;
		void fetch("/api/agent-access", { headers: { accept: "application/json" } })
			.then(response => response.ok ? response.json() as Promise<Pick<AgentAccessStatus, "status">> : Promise.reject(new Error("MCP status unavailable")))
			.then(value => {
				if (!disposed) setMcpStatus(value.status);
			})
			.catch(() => {
				if (!disposed) setMcpStatus("unavailable");
			});
		return () => { disposed = true; };
	}, []);

	return (
		<header className="topbar">
			<div className="brand">
				<span className="brand-mark" aria-hidden="true">
					<i />
					<i />
					<i />
				</span>
				<div>
					<strong>BUS LENS</strong>
					<span>RS-485 protocol workbench</span>
				</div>
			</div>
			<div className="transport">
				<StatusSplitControl
					statusId="mcpStatusBadge"
					status={`MCP ${mcpStatus}`}
					connected={mcpStatus === "running"}
					action={
						<a
							id="mcpSettingsBtn"
							className="status-split-action status-split-icon-action"
							href={MCP_SETTINGS_PATH}
							aria-label="Open MCP settings"
							title="MCP settings"
						>
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
								<circle cx="12" cy="12" r="3" />
							</svg>
						</a>
					}
				/>
				<span className="transport-divider" aria-hidden="true" />
				<StatusSplitControl
					statusId="connectionBadge"
					status={snapshot.connectionLabel}
					connected={snapshot.connected}
						action={
						<button
							id="connectBtn"
							className="status-split-action status-split-icon-action"
							type="button"
							aria-label={snapshot.connectLabel}
							title={snapshot.connectLabel}
							onClick={() => void actions.toggleConnection()}
						>
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0V8ZM12 16v5" />
								{snapshot.connected ? <path d="m5 5 14 14" /> : null}
							</svg>
						</button>
					}
				/>
				<button
					id="recordBtn"
					className={`btn btn-record ${snapshot.recording ? "recording" : ""}`.trim()}
					disabled={snapshot.recordDisabled}
					onClick={actions.toggleRecording}
				>
					<span /> {snapshot.recordLabel}
				</button>
			</div>
		</header>
	);
}

function CaptureHeader() {
	const snapshot = useSyncExternalStore(
		subscribeToCaptureHeader,
		getCaptureHeaderSnapshot,
		getCaptureHeaderSnapshot
	);
	const actions = getCaptureHeaderActions();
	const storage = useSyncExternalStore(
		subscribeToCaptureStorage,
		getCaptureStorageSnapshot,
		getCaptureStorageSnapshot
	);
	const storageActions = getCaptureStorageActions();
	const [titleDraft, setTitleDraft] = useState(snapshot.title);
	const [descriptionDraft, setDescriptionDraft] = useState(snapshot.description);
	const titleRef = useRef<HTMLInputElement>(null);
	const descriptionRef = useRef<HTMLTextAreaElement>(null);
	const actionsRef = useRef<HTMLDivElement>(null);
	const [menuOpen, setMenuOpen] = useState(false);

	useLayoutEffect(() => {
		if (document.activeElement !== titleRef.current) setTitleDraft(snapshot.title);
		if (document.activeElement !== descriptionRef.current) setDescriptionDraft(snapshot.description);
	}, [snapshot.captureId, snapshot.title, snapshot.description]);

	useLayoutEffect(() => {
		const input = descriptionRef.current;
		if (!input) return;
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, 84)}px`;
	}, [descriptionDraft, snapshot.captureId]);

	useEffect(() => {
		if (!menuOpen) return;
		const closeOnOutsideClick = (event: MouseEvent) => {
			if (!actionsRef.current?.contains(event.target as Node)) setMenuOpen(false);
		};
		document.addEventListener("click", closeOnOutsideClick);
		return () => document.removeEventListener("click", closeOnOutsideClick);
	}, [menuOpen]);

	return (
		<div className="capture-header">
				<div className="capture-identity">
					<div className="eyebrow-row">
						<span className="eyebrow">Active capture</span>
						{storage.label ? (
							<span
								id="captureStorageBadge"
								className={`storage-badge storage-${storage.status}`}
								data-storage-status={storage.status}
							>
								{storage.label}
							</span>
						) : null}
						<span id="captureState" className={`capture-state ${snapshot.live ? "live" : ""}`.trim()}>
							{snapshot.stateText}
						</span>
					</div>
					<div className="capture-title-row">
						<input
							id="captureTitle"
							className="title-input"
							ref={titleRef}
							value={titleDraft}
							disabled={!snapshot.hasCapture || storage.locked}
							aria-label="Capture title"
							onChange={event => {
								setTitleDraft(event.currentTarget.value);
								actions.setTitle(event.currentTarget.value);
							}}
							onBlur={event => {
								const title = normalizeCaptureTitle(event.currentTarget.value);
								setTitleDraft(title);
								actions.commitTitle(title);
							}}
						/>
						<textarea
							id="captureDescription"
							className="capture-description"
							ref={descriptionRef}
							value={descriptionDraft}
							disabled={!snapshot.hasCapture || storage.locked}
							rows={1}
							placeholder="Add a description…"
							aria-label="Capture description"
							onChange={event => {
								setDescriptionDraft(event.currentTarget.value);
								actions.setDescription(event.currentTarget.value);
							}}
							onBlur={event => {
								const description = normalizeCaptureDescription(event.currentTarget.value);
								setDescriptionDraft(description);
								actions.commitDescription(description);
							}}
						/>
					</div>
					<div id="captureMeta" className="capture-meta">
						{snapshot.metadata.map((item, index) =>
							item.kind === "message" ? (
								<span key={`message:${item.value}:${index}`} className="meta-chip">
									{item.value}
								</span>
							) : (
								<span key={`${item.label}:${item.value}:${index}`} className="meta-chip">
									<b>{item.label}</b> {item.value}
								</span>
							)
						)}
					</div>
				</div>
				<div id="captureSummary" className="capture-summary" aria-label="Capture summary">
					<span>Messages <strong id="statMessages">{snapshot.summary.messages}</strong></span>
					<span>Unique <strong id="statUnique">{snapshot.summary.unique}</strong></span>
					<span title="The sum of each recording session from its first received byte to its last received byte" aria-label="Capture length: sum of each recording session from its first received byte to its last received byte">Capture length <strong id="statCaptureLength">{snapshot.summary.captureLength}</strong></span>
					<span title="Received raw bytes only; transmitted bytes are excluded" aria-label="Captured: received raw bytes only; transmitted bytes are excluded">Captured <strong id="statCapturedBytes">{snapshot.summary.capturedBytes}</strong></span>
				</div>
				<div ref={actionsRef} className="header-actions">
					<button id="editContextBtn" className="btn btn-secondary" type="button" disabled={!snapshot.hasCapture || storage.locked} onClick={() => actions.openContext()}>
						Edit context
					</button>
					<button
						id="moreBtn"
						className="icon-btn"
						type="button"
						disabled={!snapshot.hasCapture || storage.locked}
						aria-label="Capture menu"
						onClick={() => setMenuOpen(open => !open)}
					>
						•••
					</button>
				<div id="moreMenu" className={`popover capture-menu ${menuOpen ? "" : "hidden"}`.trim()}>
					{storage.canUpgrade ? (
						<button
							id="upgradeCaptureStorageBtn"
							type="button"
							onClick={() => {
								storageActions.upgrade();
								setMenuOpen(false);
							}}
						>
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<path d="M12 19V5M7.5 9.5 12 5l4.5 4.5" />
							</svg>
							<span>Upgrade</span>
						</button>
					) : null}
					<button
						id="duplicateCaptureBtn"
						type="button"
						onClick={() => {
							actions.duplicate();
							setMenuOpen(false);
						}}
						disabled={storage.locked}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<rect x="8" y="8" width="11.5" height="11.5" rx="1" />
							<path d="M16 8V5.5a1.5 1.5 0 0 0-1.5-1.5h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
						</svg>
						<span>Duplicate capture</span>
					</button>
					<button
						id="clearMessagesBtn"
						type="button"
						onClick={() => {
							actions.clearMessages();
							setMenuOpen(false);
						}}
						disabled={storage.locked}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path d="M4.5 7.5h15M9 7.5V5h6v2.5M7 7.5l.75 12h8.5L17 7.5M10 11v5M14 11v5" />
						</svg>
						<span>Clear messages</span>
					</button>
					<button
						id="deleteCaptureBtn"
						className="danger"
						type="button"
						onClick={() => {
							actions.deleteCapture();
							setMenuOpen(false);
						}}
						disabled={storage.locked}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path d="M5 7.5h14M9 7.5V5h6v2.5M7 7.5l.75 12h8.5L17 7.5M10 11v5M14 11v5" />
						</svg>
						<span>Delete capture</span>
					</button>
				</div>
				</div>
		</div>
	);
}

type ViewStateProps = {
	viewState: ViewStateSnapshot;
	dispatchViewState: (action: ViewStateAction) => void;
};

type ToolbarProps = ViewStateProps & {
	messageFilterRef: RefObject<HTMLInputElement | null>;
	messageFilterToggleRef: RefObject<HTMLButtonElement | null>;
};

function Toolbar({ viewState, dispatchViewState, messageFilterRef, messageFilterToggleRef }: ToolbarProps) {
	const snapshot = useSyncExternalStore(
		subscribeToFramingToolbar,
		getFramingToolbarSnapshot,
		getFramingToolbarSnapshot
	);
	const notes = useSyncExternalStore(subscribeToNotes, getNotesSnapshot, getNotesSnapshot);

	return (
		<div className="toolbar">
			<div className="view-tabs" role="tablist">
				<button
					className={`tab ${viewState.activePanel === "stream" ? "active" : ""}`.trim()}
					data-panel="stream"
					onClick={() => dispatchViewState({ type: "set-active-panel", activePanel: "stream" })}
				>
					Message stream
				</button>
				<button
					className={`tab ${viewState.activePanel === "patterns" ? "active" : ""}`.trim()}
					data-panel="patterns"
					onClick={() => dispatchViewState({ type: "set-active-panel", activePanel: "patterns" })}
				>
					Pattern analysis
				</button>
				<button
					className={`tab ${viewState.activePanel === "notes" ? "active" : ""}`.trim()}
					data-panel="notes"
					onClick={() => dispatchViewState({ type: "set-active-panel", activePanel: "notes" })}
				>
					Notes <span id="notesCount">{notes.count}</span>
				</button>
			</div>
			<div className="toolbar-controls">
				<label className="compact-select">
					Display
					<select
						id="displayMode"
						value={viewState.displayMode}
						onChange={event =>
							dispatchViewState({ type: "set-display-mode", displayMode: event.currentTarget.value as DisplayMode })
						}
					>
						<option value="hex">HEX</option>
						<option value="binary">BINARY</option>
					</select>
				</label>
				<label className="switch-label">
					<input
						id="uniqueToggle"
						type="checkbox"
						checked={viewState.showFrameChanges}
						onChange={event =>
							dispatchViewState({ type: "set-frame-changes", showFrameChanges: event.currentTarget.checked })
						}
					/>
					<span className="switch" /> Frame changes
				</label>
				<button
					id="toggleMessageFilterBtn"
					ref={messageFilterToggleRef}
					className={`icon-btn message-filter-toggle ${viewState.activePanel !== "stream" ? "hidden" : ""} ${viewState.filterQuery.trim() ? "active" : ""}`.trim()}
					type="button"
					disabled={snapshot.disabled}
					title={viewState.filterOpen ? "Hide message filter" : "Show message filter"}
					aria-label={viewState.filterOpen ? "Hide message filter" : "Show message filter"}
					aria-expanded={viewState.filterOpen}
					aria-controls="streamFilter"
					onClick={() => {
						dispatchViewState({ type: "set-filter-open", filterOpen: !viewState.filterOpen });
						if (!viewState.filterOpen) requestAnimationFrame(() => messageFilterRef.current?.focus());
					}}
				>
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<path d="M3.75 5.25h16.5l-6.6 7.45v5.3l-3.3 1.75V12.7l-6.6-7.45Z" />
					</svg>
				</button>
			</div>
		</div>
	);
}

function StreamPanel({ viewState, dispatchViewState, messageFilterRef, messageFilterToggleRef }: ToolbarProps) {
	const framing = useSyncExternalStore(
		subscribeToFramingToolbar,
		getFramingToolbarSnapshot,
		getFramingToolbarSnapshot
	);
	const messageStream = useSyncExternalStore(
		subscribeToMessageStream,
		getMessageStreamSnapshot,
		getMessageStreamSnapshot
	);

	return (
		<div
			id="streamPanel"
			className={`tab-panel ${viewState.activePanel === "stream" ? "active" : ""}`.trim()}
		>
			{messageStream.retainedTail ? (
				<div className="retained-tail-notice" role="status">
					Displaying newest 50,000 bytes. Earlier acknowledged bytes remain durably stored
					{messageStream.durableByteCount > 50_000 ? ` (${messageStream.durableByteCount.toLocaleString()} total).` : "."}
				</div>
			) : null}
			<div id="streamFilter" className={`stream-filter ${viewState.filterOpen ? "" : "collapsed"}`.trim()}>
				<label>
					<span>⌕</span>
					<input
						id="messageFilter"
						ref={messageFilterRef}
						placeholder="Filter bytes, e.g. C2 ?? 5D"
						value={viewState.filterQuery}
						onChange={event =>
							dispatchViewState({ type: "set-filter-query", filterQuery: event.currentTarget.value })
						}
						onKeyDown={event => {
							if (event.key !== "Escape") return;
							event.preventDefault();
							dispatchViewState({ type: "set-filter-open", filterOpen: false });
							messageFilterToggleRef.current?.focus();
						}}
					/>
				</label>
				<div className="stream-summary">
					<span
						className="stream-legend"
						title="Repeated message sequences are grouped in the Sequence column, where shared notes are shown."
					>
						<i className="pattern-swatch" /> repeated sequences <span id="patternCount">{messageStream.patternCount}</span>
					</span>
					<span id="visibleCount">{messageStream.visibleCount}</span>
				</div>
			</div>
			<MessageStream frameSizeLabel={framing.frameSizeLabel} />
		</div>
	);
}

type SendPanelProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

function SendPanel({ open, onOpenChange }: SendPanelProps) {
	const snapshot = useSyncExternalStore(subscribeToSend, getSendSnapshot, getSendSnapshot);
	const actions = getSendActions();
	const inputRef = useRef<HTMLInputElement>(null);
	const delayRef = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState(snapshot.draft);
	const [delayDraft, setDelayDraft] = useState(String(snapshot.delayMs));
	const [focusComposer, setFocusComposer] = useState(false);
	const view = deriveSendViewModel({ ...snapshot, draft });

	useLayoutEffect(() => {
		if (document.activeElement !== inputRef.current) setDraft(snapshot.draft);
	}, [snapshot.draft]);

	useLayoutEffect(() => {
		if (document.activeElement !== delayRef.current) setDelayDraft(String(snapshot.delayMs));
	}, [snapshot.delayMs]);

	useEffect(() => {
		if (!open || !focusComposer) return;
		const frame = requestAnimationFrame(() => {
			inputRef.current?.focus();
			setFocusComposer(false);
		});
		return () => cancelAnimationFrame(frame);
	}, [open, focusComposer]);

	const sendDraft = () => {
		const parsed = parseTransmitHex(draft);
		if (!parsed.bytes?.length) return;
		void actions.send([...parsed.bytes]).then(sent => {
			if (sent) setDraft("");
		});
	};

	const addDraftToQueue = () => {
		const parsed = parseTransmitHex(draft);
		if (!parsed.bytes?.length) return;
		if (actions.addToQueue([...parsed.bytes])) setDraft("");
	};

	const commitDelay = () => {
		actions.setDelay(Number(delayDraft) || 0);
	};

	return (
		<aside
			id="sendPanel"
			className={`send-popup ${open ? "" : "collapsed"}`.trim()}
			aria-label="Serial message composer"
		>
			<header className="send-popup-titlebar">
				<button
					id="toggleSendPopupBtn"
					className="send-popup-toggle"
					type="button"
					aria-expanded={open}
					aria-controls="sendPopupContent"
					onClick={() => {
						if (open) onOpenChange(false);
						else {
							onOpenChange(true);
							setFocusComposer(true);
						}
					}}
				>
					<span className="send-popup-title"><i aria-hidden="true" /> Compose serial message</span>
					<span
						id="queueTabCount"
						className={`send-popup-count ${view.queueTabCountHidden ? "hidden" : ""}`.trim()}
						aria-label="Messages in queue"
					>
						{view.queueCount}
					</span>
				</button>
				<button
					id="minimizeSendPopupBtn"
					className="send-popup-minimize"
					type="button"
					aria-label={open ? "Minimize composer" : "Open composer"}
					onClick={() => onOpenChange(false)}
				>
					—
				</button>
			</header>
			<div id="sendPopupContent" className="send-popup-content">
				<div className="send-popup-meta">
					<p id="sendConnectionHint">{view.connectionHint}</p>
					<span id="sendStatusBadge" className={view.statusClassName}>
						<i /> {view.statusText}
					</span>
				</div>
				<div className="send-grid">
					<section className="send-card composer-card" aria-label="Compose serial message">
						<div className="send-card-heading">
							<div>
								<span className="eyebrow">Composer</span>
								<h3>Hex message</h3>
							</div>
							<span className="keyboard-hint">Enter to send · Shift+Enter to queue</span>
						</div>
					<label className="transmit-input">
						<span>HEX</span>
						<input
							id="transmitHex"
							ref={inputRef}
							autoComplete="off"
							autoCapitalize="characters"
							spellCheck={false}
							placeholder="e.g. C2 08 5D"
							aria-describedby="transmitHint"
							value={draft}
							onChange={event => {
								setDraft(event.currentTarget.value);
								actions.setDraft(event.currentTarget.value);
							}}
							onKeyDown={event => {
								if (event.key !== "Enter") return;
								event.preventDefault();
								if (event.shiftKey) addDraftToQueue();
								else sendDraft();
							}}
						/>
					</label>
					<p id="transmitHint" className={view.draftHintClassName}>{view.parsedDraft.message}</p>
					<div className="composer-actions">
						<button
							id="addQueueBtn"
							className="btn btn-secondary"
							type="button"
							disabled={view.queueDisabled}
							onClick={addDraftToQueue}
						>
							Add to queue
						</button>
						<button
							id="sendBytesBtn"
							className="btn btn-send"
							type="button"
							disabled={view.sendDisabled}
							onClick={sendDraft}
						>
							Send now
						</button>
					</div>
					</section>

					<section className="send-card queue-card" aria-label="Timed transmit queue">
					<div className="send-card-heading">
						<div>
							<span className="eyebrow">Sequence</span>
							<h3>Timed queue <span id="queueCount">{view.queueCount}</span></h3>
						</div>
						<label className="queue-delay">
							Gap
							<input
								id="queueDelay"
								ref={delayRef}
								type="number"
								min="0"
								max="600000"
								step="10"
								value={delayDraft}
								onChange={event => setDelayDraft(event.currentTarget.value)}
								onBlur={commitDelay}
								onKeyDown={event => {
									if (event.key === "Enter") commitDelay();
								}}
							/>
							ms
						</label>
					</div>
					<div id="queueList" className="queue-list">
						{view.queueCount ? (
							snapshot.queue.map((item, index) => (
								<div className="queue-item" key={item.id}>
									<span className="queue-index">{String(index + 1).padStart(2, "0")}</span>
									<code>{item.bytes.map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ")}</code>
									<button
										className="icon-btn"
										data-queue-send={item.id}
										title="Send this message now"
										aria-label="Send this message now"
										type="button"
										onClick={() => actions.sendQueueItem(item.id)}
									>
										▶
									</button>
									<button
										className="icon-btn"
										data-queue-remove={item.id}
										title="Remove from queue"
										aria-label="Remove from queue"
										type="button"
										onClick={() => actions.removeQueueItem(item.id)}
									>
										×
									</button>
								</div>
							))
						) : (
							<div className="send-empty">Queue messages here, then run them with a controlled gap.</div>
						)}
					</div>
					<div className="queue-actions">
						<button
							id="clearQueueBtn"
							className="text-btn"
							type="button"
							disabled={view.clearQueueDisabled}
							onClick={actions.clearQueue}
						>
							Clear queue
						</button>
						<span />
						<button
							id="stopQueueBtn"
							className={`btn btn-danger ${view.stopQueueHidden ? "hidden" : ""}`.trim()}
							type="button"
							disabled={view.stopQueueDisabled}
							onClick={actions.stopQueue}
						>
							{view.stopQueueText}
						</button>
						<button
							id="runQueueBtn"
							className={`btn btn-primary ${view.runQueueHidden ? "hidden" : ""}`.trim()}
							type="button"
							disabled={view.runQueueDisabled}
							onClick={() => void actions.runQueue()}
						>
							Run queue
						</button>
					</div>
					</section>

					<section className="send-card history-card" aria-label="Transmit history">
					<div className="send-card-heading">
						<div>
							<span className="eyebrow">Local history</span>
							<h3>Recent sends <span id="historyCount">{view.historyCount}</span></h3>
						</div>
						<button
							id="clearHistoryBtn"
							className="text-btn"
							type="button"
							disabled={view.clearHistoryDisabled}
							onClick={actions.clearHistory}
						>
							Clear
						</button>
					</div>
					<div id="sendHistory" className="send-history">
						{view.historyCount ? (
							snapshot.history.map(item => (
								<div className={`history-item ${item.ok === false ? "failed" : ""}`.trim()} key={item.id}>
									<div>
										<code>{item.bytes.map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ")}</code>
										<small>
											{formatSendTime(item.timestamp)} · {item.captureId ? "captured TX" : "send history"}
											{item.origin === "queue" ? " · queued" : ""}
											{item.ok === false ? ` · failed: ${item.error || "unknown error"}` : ""}
										</small>
									</div>
									<button
										className="text-btn"
										data-history-load={item.id}
										type="button"
										onClick={() => {
											const loaded = actions.loadHistory(item.id);
											if (loaded === null) return;
											setDraft(loaded);
											requestAnimationFrame(() => inputRef.current?.focus());
										}}
									>
										Load
									</button>
									<button
										className="text-btn"
										data-history-replay={item.id}
										type="button"
										disabled={view.replayDisabled}
										onClick={() => actions.replayHistory(item.id)}
									>
										Replay
									</button>
								</div>
							))
						) : (
							<div className="send-empty">Successful and failed sends appear here, including sends made outside a capture.</div>
						)}
					</div>
					</section>
				</div>
			</div>
		</aside>
	);
}

function AnalysisPanel({ active }: { active: boolean }) {
	return <AnalysisPanelShell active={active} />;
}

const AnalysisPanelShell = memo(function AnalysisPanelShell({ active }: { active: boolean }) {
	return (
		<div id="patternsPanel" className={`tab-panel ${active ? "active" : ""}`.trim()}>
			<AnalysisPanelContent />
		</div>
	);
});

function AnalysisPanelContent() {
	const snapshot = useSyncExternalStore(subscribeToAnalysis, getAnalysisSnapshot, getAnalysisSnapshot);
	return (
		<div className="analysis-grid">
				<article className="analysis-card wide">
					<div className="card-heading">
						<div>
							<span className="eyebrow">Bit-level</span>
							<h2>Variance map</h2>
						</div>
						<span className="legend">
							<i /> stable <i /> changing
						</span>
					</div>
					<div id="bitMap" className="bit-map">
						{snapshot.bitVariance.map(row => (
							<div className="bit-row" key={row.label}>
								<label>{row.label}</label>
								{row.cells.map(cell => (
									<div
										className="bit-cell"
										key={cell.bit}
										style={{ "--variance": cell.variance } as CSSProperties}
										title={`${cell.percentage}% ones`}
									>
										<span>
											b{cell.bit}
											<br />
											{cell.percentage}%
										</span>
									</div>
								))}
							</div>
						))}
					</div>
				</article>
				<article className="analysis-card">
					<div className="card-heading">
						<div>
							<span className="eyebrow">Frequency</span>
							<h2>Message signatures</h2>
						</div>
					</div>
					<div id="signatureList" className="signature-list">
						{snapshot.signatures.length ? (
							snapshot.signatures.map(row => (
								<div className="signature-row" key={row.signature}>
									<span>{row.signature}</span>
									<span className="signature-bar">
										<i style={{ width: `${row.width}%` }} />
									</span>
									<small>
										{row.count} · {row.percentage}%
									</small>
								</div>
							))
						) : (
							<span className="muted">
								{snapshot.captureId ? "No messages to analyze." : "No capture selected."}
							</span>
						)}
					</div>
				</article>
				<article className="analysis-card">
					<div className="card-heading">
						<div>
							<span className="eyebrow">Per offset</span>
							<h2>Byte vocabulary</h2>
						</div>
					</div>
					<div id="vocabulary" className="vocabulary">
						{snapshot.vocabulary.map(row => (
							<div className="vocab-row" key={row.label}>
								<label>{row.label}</label>
								<div className="vocab-values">
									{row.values.map(value => (
										<span key={value.value} title={`${value.count} occurrences`}>
											{value.hex}
											<small> ·{value.count}</small>
										</span>
									))}
								</div>
							</div>
						))}
					</div>
				</article>
				<article className="analysis-card wide">
					<div className="card-heading">
						<div>
							<span className="eyebrow">Discovery aid</span>
							<h2>Transitions</h2>
						</div>
						<span className="muted">Consecutive message changes</span>
					</div>
					<div id="transitionList" className="transition-list">
						{snapshot.transitions.length ? (
							snapshot.transitions.map(row => (
								<div className="transition-row" key={`${row.from}|${row.to}`}>
									<span>{row.from}</span>
									<b>→</b>
									<span>{row.to}</span>
									<small>
										{row.count}× · {row.diffs} byte{row.diffs === 1 ? "" : "s"} changed
									</small>
								</div>
							))
						) : (
							<span className="muted">
								{snapshot.captureId ? "No transitions yet." : "No capture selected."}
							</span>
						)}
					</div>
				</article>
			</div>
	);
}

function NotesPanel({ active }: { active: boolean }) {
	return <NotesPanelShell active={active} />;
}

const NotesPanelShell = memo(function NotesPanelShell({ active }: { active: boolean }) {
	return (
		<div id="notesPanel" className={`tab-panel ${active ? "active" : ""}`.trim()}>
			<NotesPanelContent />
		</div>
	);
});

function NotesPanelContent() {
	const snapshot = useSyncExternalStore(subscribeToNotes, getNotesSnapshot, getNotesSnapshot);
	const actions = getNotesActions();
	const [sequenceStart, setSequenceStart] = useState("1");
	const [sequenceEnd, setSequenceEnd] = useState("2");
	const [noteText, setNoteText] = useState("");
	const [originFilter, setOriginFilter] = useState<"all" | "human" | "agent">("all");
	const visibleNotes = snapshot.notes.filter(note => originFilter === "all" || (note.authorType ?? "human") === originFilter);

	return (
		<div className="notes-layout">
				<div>
					<div className="section-title">
						<span className="eyebrow">Notebook</span>
						<h2>Protocol observations</h2>
					</div>
					<label className="notes-origin-filter">
						<span>Origin</span>
						<select
							value={originFilter}
							onChange={event => {
								const value = event.currentTarget.value as "all" | "human" | "agent";
								setOriginFilter(value);
							}}
						>
							<option value="all">All notes</option>
							<option value="human">Human notes</option>
							<option value="agent">Agent notes</option>
						</select>
					</label>
					<div id="notesList" className="notes-list">
						{visibleNotes.length ? (
							visibleNotes.map(note => (
								<article className="note-card" key={note.id}>
									<header>
										<span>
											<span className={`note-origin ${note.authorType === "agent" ? "agent" : "human"}`.trim()}>{note.authorType === "agent" ? `AGENT · ${note.reportedClientName ?? "unknown-mcp-client"}` : "HUMAN"}</span>{" "}
											{note.label}
											{note.targetLabel ? ` · ${note.targetLabel}` : ""}
										</span>
										<span>{new Date(note.createdAt).toLocaleString()}{note.authorType === "agent" && note.protocolVersion ? ` · ${note.protocolVersion}` : ""}</span>
									</header>
									<p>{note.text}</p>
								</article>
							))
						) : (
							<p className="muted">
								{snapshot.captureId ? originFilter === "all" ? "No observations recorded for this capture." : `No ${originFilter} notes recorded for this capture.` : "No capture selected."}
							</p>
						)}
					</div>
				</div>
				<form
					id="captureNoteForm"
					className="note-composer"
					onSubmit={event => {
						event.preventDefault();
						if (
							actions.addSequenceNote({
								start: sequenceStart,
								end: sequenceEnd,
								text: noteText
							})
						)
							setNoteText("");
					}}
				>
					<span className="eyebrow">Sequence observation</span>
					<h2>Record a message sequence</h2>
					<div id="sequenceRange" className="sequence-range">
						<label className="field">
							From row
							<input
								id="sequenceStart"
								type="number"
								min="1"
								value={sequenceStart}
								onChange={event => setSequenceStart(event.currentTarget.value)}
							/>
						</label>
						<label className="field">
							To row
							<input
								id="sequenceEnd"
								type="number"
								min="1"
								value={sequenceEnd}
								onChange={event => setSequenceEnd(event.currentTarget.value)}
							/>
						</label>
					</div>
					<textarea
						id="captureNoteText"
						required
						placeholder="What does this message sequence appear to represent?"
						value={noteText}
						onChange={event => setNoteText(event.currentTarget.value)}
					/>
					<button className="btn btn-primary" type="submit">
						Add sequence note
					</button>
				</form>
			</div>
	);
}

function Toast({ sendPopupOpen }: { sendPopupOpen: boolean }) {
	const snapshot = useSyncExternalStore(subscribeToToast, getToastSnapshot, getToastSnapshot);
	return (
		<div
			id="toast"
			className={`toast ${snapshot.visible ? "show" : ""} ${sendPopupOpen ? "send-popup-open" : ""}`.trim()}
			role="status"
		>
			{snapshot.message}
		</div>
	);
}

function PersistenceErrorBanner() {
	const snapshot = useSyncExternalStore(
		subscribeToPersistenceError,
		getPersistenceErrorSnapshot,
		getPersistenceErrorSnapshot
	);
	if (!snapshot.visible) return null;
	return (
		<div className="persistence-error" role="alert">
			<div>
				<strong>Capture is not fully stored.</strong>
				<span>{snapshot.message}</span>
			</div>
			<div className="persistence-error-actions">
				{snapshot.canRetry ? <button className="btn" type="button" onClick={() => getPersistenceErrorActions().retry()}>Retry</button> : null}
				{snapshot.canExportRecovery ? <button className="btn" type="button" onClick={() => getPersistenceErrorActions().exportRecovery()}>Export recovery JSON</button> : null}
				<button className="btn" type="button" onClick={() => getPersistenceErrorActions().dismiss()}>Dismiss</button>
			</div>
		</div>
	);
}

const SIDEBAR_WIDTH_STORAGE_KEY = "bus-lens.sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 260;
const NARROW_SIDEBAR_WIDTH = 210;
const MIN_SIDEBAR_WIDTH = 210;
const MAX_SIDEBAR_WIDTH = 440;

function clampSidebarWidth(width: number) {
	return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function readSidebarWidth() {
	const defaultWidth = typeof window !== "undefined" && window.innerWidth <= 900 ? NARROW_SIDEBAR_WIDTH : DEFAULT_SIDEBAR_WIDTH;
	try {
		const storedValue = globalThis.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
		const storedWidth = storedValue === null ? NaN : Number(storedValue);
		return Number.isFinite(storedWidth) ? clampSidebarWidth(storedWidth) : defaultWidth;
	} catch {
		return defaultWidth;
	}
}

function SidebarResizeHandle({
	width,
	onWidthChange,
	onResizingChange
}: {
	width: number;
	onWidthChange: (width: number) => void;
	onResizingChange: (resizing: boolean) => void;
}) {
	const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

	const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (resizeRef.current?.pointerId !== event.pointerId) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		resizeRef.current = null;
		onResizingChange(false);
	};

	return (
		<div
			className="sidebar-resizer"
			role="separator"
			aria-label="Resize archive sidebar"
			aria-orientation="vertical"
			aria-valuemin={MIN_SIDEBAR_WIDTH}
			aria-valuemax={MAX_SIDEBAR_WIDTH}
			aria-valuenow={width}
			tabIndex={0}
			onDoubleClick={() => onWidthChange(DEFAULT_SIDEBAR_WIDTH)}
			onKeyDown={event => {
				const step = event.shiftKey ? 50 : 10;
				if (event.key === "ArrowLeft") {
					event.preventDefault();
					onWidthChange(clampSidebarWidth(width - step));
				} else if (event.key === "ArrowRight") {
					event.preventDefault();
					onWidthChange(clampSidebarWidth(width + step));
				} else if (event.key === "Home") {
					event.preventDefault();
					onWidthChange(MIN_SIDEBAR_WIDTH);
				} else if (event.key === "End") {
					event.preventDefault();
					onWidthChange(MAX_SIDEBAR_WIDTH);
				}
			}}
			onPointerDown={event => {
				if (event.button !== 0) return;
				event.preventDefault();
				resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
				event.currentTarget.setPointerCapture(event.pointerId);
				onResizingChange(true);
			}}
			onPointerMove={event => {
				const resize = resizeRef.current;
				if (!resize || resize.pointerId !== event.pointerId) return;
				onWidthChange(clampSidebarWidth(resize.startWidth + event.clientX - resize.startX));
			}}
			onPointerUp={finishResize}
			onPointerCancel={finishResize}
			title="Drag to resize archive sidebar; double-click to reset"
		/>
	);
}

function App() {
	const [sendPopupOpen, setSendPopupOpen] = useState(false);
	const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
	const [sidebarResizing, setSidebarResizing] = useState(false);
	const [viewState, dispatchViewState] = useReducer(reduceViewState, EMPTY_VIEW_STATE_SNAPSHOT);
	const messageFilterRef = useRef<HTMLInputElement>(null);
	const messageFilterToggleRef = useRef<HTMLButtonElement>(null);
	const handleSendPopupChange = (open: boolean) => setSendPopupOpen(open);

	useEffect(() => {
		try {
			globalThis.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
		} catch {
			// Preferences are optional when storage is unavailable.
		}
	}, [sidebarWidth]);

	useEffect(() => {
		let disposed = false;
		let removeBeforeUnload: (() => void) | undefined;

		void import("./controller")
			.then(({ initializeController }) => {
				if (disposed) return;
				const lifecycle = initializeController();
				const handleBeforeUnload = (event: BeforeUnloadEvent) => lifecycle.beforeUnload(event);
				window.addEventListener("beforeunload", handleBeforeUnload);
				removeBeforeUnload = () => window.removeEventListener("beforeunload", handleBeforeUnload);
			})
			.catch(error => console.error("Could not initialize Bus Lens", error));

		return () => {
			disposed = true;
			removeBeforeUnload?.();
		};
	}, []);

	useEffect(() => publishViewStateSnapshot(viewState), [viewState]);

	return (
		<>
			<div className="app-shell">
				<TopBar />
				<PersistenceErrorBanner />
				{window.location.pathname === MCP_SETTINGS_PATH ? <McpSettingsPage /> : (
					<main
						className={`workspace ${sidebarResizing ? "sidebar-resizing" : ""}`.trim()}
						style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
					>
						<ArchiveSidebar />
						<SidebarResizeHandle
							width={sidebarWidth}
							onWidthChange={setSidebarWidth}
							onResizingChange={setSidebarResizing}
						/>
						<section className="main-panel">
							<CaptureHeader />
							<Toolbar
								viewState={viewState}
								dispatchViewState={dispatchViewState}
								messageFilterRef={messageFilterRef}
								messageFilterToggleRef={messageFilterToggleRef}
							/>
							<StreamPanel
								viewState={viewState}
								dispatchViewState={dispatchViewState}
								messageFilterRef={messageFilterRef}
								messageFilterToggleRef={messageFilterToggleRef}
							/>
							<AnalysisPanel active={viewState.activePanel === "patterns"} />
							<NotesPanel active={viewState.activePanel === "notes"} />
						</section>
					</main>
				)}
			</div>
			<SendPanel open={sendPopupOpen} onOpenChange={handleSendPopupChange} />
			<ContextDialog />
			<CanonicalizationDialog />
			<AnnotationDialog />
			<PatternRemarkDialog />
			<ExportDialog />
			<Toast sendPopupOpen={sendPopupOpen} />
		</>
	);
}

export default App;

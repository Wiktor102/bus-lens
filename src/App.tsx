import {
	memo,
	useEffect,
	useLayoutEffect,
	useReducer,
	useRef,
	useState,
	useSyncExternalStore,
	type CSSProperties,
	type RefObject
} from "react";
import { ArchiveSidebar } from "./archive-sidebar";
import { getAnalysisSnapshot, subscribeToAnalysis } from "./analysis-bridge";
import {
	getCaptureHeaderActions,
	getCaptureHeaderSnapshot,
	subscribeToCaptureHeader
} from "./capture-header-bridge";
import { normalizeCaptureDescription, normalizeCaptureTitle } from "./capture-header";
import {
	getFramingToolbarActions,
	getFramingToolbarSnapshot,
	subscribeToFramingToolbar
} from "./framing-toolbar-bridge";
import type { FramingMode, MarkerPosition } from "./framing-toolbar";
import { getSendActions, getSendSnapshot, subscribeToSend } from "./send-bridge";
import { deriveSendViewModel, formatSendTime, parseTransmitHex } from "./send";
import { getNotesActions, getNotesSnapshot, subscribeToNotes } from "./notes-bridge";
import { getToastSnapshot, subscribeToToast } from "./toast-bridge";
import {
	AnnotationDialog,
	ContextDialog,
	ExportDialog,
	PatternRemarkDialog,
	SectionsDialog
} from "./dialogs";
import { publishViewStateSnapshot } from "./view-state-bridge";
import {
	EMPTY_VIEW_STATE_SNAPSHOT,
	reduceViewState,
	type DisplayMode,
	type ViewStateAction,
	type ViewStateSnapshot
} from "./view-state";
import "./styles.css";

function TopBar() {
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
				<span id="connectionBadge" className="status-badge">
					<i /> Disconnected
				</span>
				<button id="connectBtn" className="btn btn-secondary">
					Connect port
				</button>
				<button id="recordBtn" className="btn btn-record" disabled>
					<span /> Start capture
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
							disabled={!snapshot.hasCapture}
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
							disabled={!snapshot.hasCapture}
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
								<span key={`message:${item.value}`} className="meta-chip">
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
					<button id="editContextBtn" className="btn btn-secondary" type="button" disabled={!snapshot.hasCapture} onClick={actions.openContext}>
						Edit context
					</button>
					<button
						id="moreBtn"
						className="icon-btn"
						type="button"
						disabled={!snapshot.hasCapture}
						aria-label="Capture menu"
						onClick={() => setMenuOpen(open => !open)}
					>
						•••
					</button>
				<div id="moreMenu" className={`popover capture-menu ${menuOpen ? "" : "hidden"}`.trim()}>
					<button
						id="duplicateCaptureBtn"
						type="button"
						onClick={() => {
							actions.duplicate();
							setMenuOpen(false);
						}}
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
	const actions = getFramingToolbarActions();
	const markerRef = useRef<HTMLInputElement>(null);
	const [markerDraft, setMarkerDraft] = useState(snapshot.markerDraft);

	useLayoutEffect(() => {
		if (document.activeElement !== markerRef.current) setMarkerDraft(snapshot.markerDraft);
	}, [snapshot.captureId, snapshot.markerDraft]);

	const commitMarker = (value: string) => {
		setMarkerDraft(value);
		if (value !== snapshot.markerDraft) actions.updateSettings({ frameMarker: value });
	};

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
					Frame by
					<select
						id="framingMode"
						value={snapshot.framingMode}
						disabled={snapshot.disabled}
						onChange={event => actions.updateSettings({ previewMode: event.currentTarget.value as FramingMode })}
					>
						<option value="length">LENGTH</option>
						<option value="sections">SECTIONED LENGTH</option>
						<option value="marker">MARKER</option>
						<option value="time">TIME GAP</option>
					</select>
				</label>
				<label id="frameLengthControl" className={`compact-input ${snapshot.visibility.frameLength ? "" : "hidden"}`.trim()}>
					Bytes
					<input
						id="previewFrameSize"
						type="number"
						min="1"
						max="1024"
						value={snapshot.frameSize}
						disabled={snapshot.disabled}
						onInput={event => actions.updateSettings({ frameSize: event.currentTarget.value })}
					/>
				</label>
				<button
					id="editSectionsBtn"
					className={`text-btn framing-sections-btn ${snapshot.visibility.sectionsButton ? "" : "hidden"}`.trim()}
					type="button"
					disabled={snapshot.disabled}
					onClick={actions.openSections}
				>
					Sections
				</button>
				<span
					id="markerControls"
					className={`preview-mode-controls ${snapshot.visibility.markerControls ? "" : "hidden"}`.trim()}
				>
					<label className="compact-input">
						Marker
						<input
							id="frameMarker"
							ref={markerRef}
							placeholder="e.g. AA 55"
							spellCheck={false}
							value={markerDraft}
							disabled={snapshot.disabled}
							onChange={event => setMarkerDraft(event.currentTarget.value)}
							onBlur={event => commitMarker(event.currentTarget.value)}
						/>
					</label>
					<label className="compact-select">
						Position
						<select
							id="markerPosition"
							value={snapshot.markerPosition}
							disabled={snapshot.disabled}
							onChange={event => actions.updateSettings({ markerPosition: event.currentTarget.value as MarkerPosition })}
						>
							<option value="start">STARTS MESSAGE</option>
							<option value="end">ENDS MESSAGE</option>
						</select>
					</label>
				</span>
				<label id="timeControls" className={`compact-input ${snapshot.visibility.timeControls ? "" : "hidden"}`.trim()}>
					Idle gap ≥
					<input
						id="frameTimeGap"
						type="number"
						min="0.01"
						step="0.1"
						value={snapshot.frameTimeGap}
						disabled={snapshot.disabled}
						onInput={event => actions.updateSettings({ frameTimeGap: event.currentTarget.value })}
					/> ms
				</label>
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
				<label id="collapseControl" className={`switch-label ${snapshot.visibility.collapseControl ? "" : "hidden"}`.trim()}>
					<input
						id="collapseToggle"
						type="checkbox"
						checked={viewState.collapseRuns}
						onChange={event =>
							dispatchViewState({ type: "set-collapse-runs", collapseRuns: event.currentTarget.checked })
						}
					/>
					<span className="switch" /> Collapse runs
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

	return (
		<div
			id="streamPanel"
			className={`tab-panel ${viewState.activePanel === "stream" ? "active" : ""}`.trim()}
		>
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
						<i className="pattern-swatch" /> repeated sequences <span id="patternCount">0 groups</span>
					</span>
					<span id="visibleCount">0 rows</span>
				</div>
			</div>
			<div className="table-wrap">
				<table className="message-table">
					<thead>
						<tr>
							<th>#</th>
							<th>TIME</th>
							<th>Δ</th>
							<th className="sequence-heading">SEQUENCE</th>
							<th>
								MESSAGE · <span id="frameSizeLabel">{framing.frameSizeLabel}</span>
							</th>
							<th>REPEATS</th>
							<th>ANNOTATION</th>
						</tr>
					</thead>
					<tbody id="messageBody" />
				</table>
				<div id="emptyState" className="empty-state hidden">
					<div className="empty-glyph">
						01<span>10</span>
					</div>
					<h2>No messages in this capture</h2>
					<p>Connect a serial port and start capture, or import a monitor dump.</p>
				</div>
			</div>
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

	return (
		<div className="notes-layout">
				<div>
					<div className="section-title">
						<span className="eyebrow">Notebook</span>
						<h2>Protocol observations</h2>
					</div>
					<div id="notesList" className="notes-list">
						{snapshot.notes.length ? (
							snapshot.notes.map(note => (
								<article className="note-card" key={note.id}>
									<header>
										<span>
											{note.label}
											{note.targetLabel ? ` · ${note.targetLabel}` : ""}
										</span>
										<span>{new Date(note.createdAt).toLocaleString()}</span>
									</header>
									<p>{note.text}</p>
								</article>
							))
						) : (
							<p className="muted">
								{snapshot.captureId ? "No observations recorded for this capture." : "No capture selected."}
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

function MessageContextMenu() {
	return (
		<div
			id="messageContextMenu"
			className="message-context-menu hidden"
			role="menu"
			aria-label="Message actions"
			aria-hidden="true"
		>
			<button type="button" role="menuitem" data-context-action="note">
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<path d="M4.5 4.5h10.25L19.5 9.25V19.5H4.5Z" />
					<path d="M14.75 4.5v4.75h4.75M8 14.5h4.5M8 17.5h6.5" />
				</svg>
				<span>Add note</span>
			</button>
			<button type="button" role="menuitem" data-context-action="replay">
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<path d="M19 8.5A7.5 7.5 0 1 0 19.15 15" />
					<path d="M19 4.5v4h-4" />
				</svg>
				<span>Replay</span>
			</button>
			<button type="button" role="menuitem" className="context-delete" data-context-action="delete">
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<path d="M5.5 7.5h13M9.5 7.5V5h5v2.5M7 7.5l.75 12h8.5L17 7.5M10 11v5.5M14 11v5.5" />
				</svg>
				<span data-context-delete-label>Delete message</span>
			</button>
			<button type="button" role="menuitem" className="byte-context-action" data-context-action="section">
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<path d="M5 4.5v15M19 4.5v15M5 8.5h5M14 8.5h5M5 15.5h5M14 15.5h5" />
				</svg>
				<span>Begin new section here</span>
			</button>
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

function App() {
	const [sendPopupOpen, setSendPopupOpen] = useState(false);
	const [viewState, dispatchViewState] = useReducer(reduceViewState, EMPTY_VIEW_STATE_SNAPSHOT);
	const messageFilterRef = useRef<HTMLInputElement>(null);
	const messageFilterToggleRef = useRef<HTMLButtonElement>(null);
	const handleSendPopupChange = (open: boolean) => setSendPopupOpen(open);

	useEffect(() => {
		void import("./controller");
	}, []);

	useEffect(() => publishViewStateSnapshot(viewState), [viewState]);

	return (
		<>
			<div className="app-shell">
				<TopBar />
				<main className="workspace">
					<ArchiveSidebar />
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
			</div>
			<SendPanel open={sendPopupOpen} onOpenChange={handleSendPopupChange} />
			<ContextDialog />
			<SectionsDialog />
			<AnnotationDialog />
			<PatternRemarkDialog />
			<ExportDialog />
			<MessageContextMenu />
			<Toast sendPopupOpen={sendPopupOpen} />
		</>
	);
}

export default App;

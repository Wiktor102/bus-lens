import { useEffect } from "react";
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
				<span id="connectionBadge" className="status-badge" aria-live="polite" title="No serial port connected">
					<i />
					<span id="connectionLabel">Disconnected</span>
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

function Sidebar() {
	return (
		<aside className="sidebar">
			<div className="sidebar-heading">
				<div>
					<span className="eyebrow">Archive</span>
					<h1>Capture sets</h1>
				</div>
				<div className="sidebar-create-actions">
					<button id="newFolderBtn" className="icon-btn" title="New folder" aria-label="New folder">
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path d="M3.75 6.75h5.1l1.8 2.1h9.6v8.4a1.5 1.5 0 0 1-1.5 1.5h-15a1.5 1.5 0 0 1-1.5-1.5v-9a1.5 1.5 0 0 1 1.5-1.5Z" />
							<path d="M2.25 10.35h18" />
						</svg>
					</button>
					<button id="newCaptureBtn" className="icon-btn" title="New capture" aria-label="New capture">
						＋
					</button>
				</div>
			</div>
			<label className="search-box">
				<span>⌕</span>
				<input id="captureSearch" type="search" placeholder="Filter captures…" />
			</label>
			<div id="captureList" className="capture-list" />
			<div className="sidebar-actions">
				<button id="importBtn" className="text-btn">
					↥ Import
				</button>
				<button id="exportBtn" className="text-btn">
					↧ Export
				</button>
				<input id="fileInput" type="file" accept=".txt,.json,.csv" hidden />
			</div>
		</aside>
	);
}

function CaptureHeader() {
	return (
		<>
			<div className="capture-header">
				<div className="capture-identity">
					<div className="eyebrow-row">
						<span className="eyebrow">Active capture</span>
						<span id="captureState" className="capture-state">
							SAVED
						</span>
					</div>
					<div className="capture-title-row">
						<input
							id="captureTitle"
							className="title-input"
							defaultValue="Overview · Speed 1"
							aria-label="Capture title"
						/>
						<textarea
							id="captureDescription"
							className="capture-description"
							rows={1}
							placeholder="Add a description…"
							aria-label="Capture description"
						/>
					</div>
					<div id="captureMeta" className="capture-meta" />
				</div>
				<div id="captureSummary" className="capture-summary" aria-label="Capture summary">
					<span>Messages <strong id="statMessages">0</strong></span>
					<span>Unique <strong id="statUnique">0</strong></span>
					<span title="The sum of each recording session from its first received byte to its last received byte" aria-label="Capture length: sum of each recording session from its first received byte to its last received byte">Capture length <strong id="statCaptureLength">0 s</strong></span>
					<span title="Received raw bytes only; transmitted bytes are excluded" aria-label="Captured: received raw bytes only; transmitted bytes are excluded">Captured <strong id="statCapturedBytes">0 B</strong></span>
				</div>
				<div className="header-actions">
					<button id="editContextBtn" className="btn btn-secondary">
						Edit context
					</button>
					<button id="moreBtn" className="icon-btn" aria-label="Capture menu">
						•••
					</button>
					<div id="moreMenu" className="popover hidden">
						<button id="duplicateCaptureBtn">Duplicate capture</button>
						<button id="clearMessagesBtn">Clear messages</button>
						<button id="deleteCaptureBtn" className="danger">
							Delete capture
						</button>
					</div>
				</div>
			</div>
		</>
	);
}

function Toolbar() {
	return (
		<div className="toolbar">
			<div className="view-tabs" role="tablist">
				<button className="tab active" data-panel="stream">
					Message stream
				</button>
				<button className="tab" data-panel="patterns">
					Pattern analysis
				</button>
				<button className="tab" data-panel="notes">
					Notes <span id="notesCount">0</span>
				</button>
			</div>
			<div className="toolbar-controls">
				<label className="compact-select">
					Frame by
					<select id="framingMode" defaultValue="length">
						<option value="length">LENGTH</option>
						<option value="sections">SECTIONED LENGTH</option>
						<option value="marker">MARKER</option>
						<option value="time">TIME GAP</option>
					</select>
				</label>
				<label id="frameLengthControl" className="compact-input">
					Bytes
					<input id="previewFrameSize" type="number" min="1" max="1024" defaultValue="3" />
				</label>
				<button id="editSectionsBtn" className="text-btn framing-sections-btn hidden" type="button">
					Sections
				</button>
				<span id="markerControls" className="preview-mode-controls hidden">
					<label className="compact-input">
						Marker
						<input id="frameMarker" placeholder="e.g. AA 55" spellCheck={false} />
					</label>
					<label className="compact-select">
						Position
						<select id="markerPosition" defaultValue="start">
							<option value="start">STARTS MESSAGE</option>
							<option value="end">ENDS MESSAGE</option>
						</select>
					</label>
				</span>
				<label id="timeControls" className="compact-input hidden">
					Idle gap ≥
					<input id="frameTimeGap" type="number" min="0.01" step="0.1" defaultValue="5" /> ms
				</label>
				<label className="compact-select">
					Display
					<select id="displayMode" defaultValue="hex">
						<option value="hex">HEX</option>
						<option value="binary">BINARY</option>
					</select>
				</label>
				<label className="switch-label">
					<input id="uniqueToggle" type="checkbox" defaultChecked />
					<span className="switch" /> Frame changes
				</label>
				<label id="collapseControl" className="switch-label">
					<input id="collapseToggle" type="checkbox" />
					<span className="switch" /> Collapse runs
				</label>
				<button
					id="toggleMessageFilterBtn"
					className="icon-btn message-filter-toggle"
					type="button"
					title="Show message filter"
					aria-label="Show message filter"
					aria-expanded="false"
					aria-controls="streamFilter"
				>
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<path d="M3.75 5.25h16.5l-6.6 7.45v5.3l-3.3 1.75V12.7l-6.6-7.45Z" />
					</svg>
				</button>
			</div>
		</div>
	);
}

function StreamPanel() {
	return (
		<div id="streamPanel" className="tab-panel active">
			<div id="streamFilter" className="stream-filter collapsed">
				<label>
					<span>⌕</span>
					<input id="messageFilter" placeholder="Filter bytes, e.g. C2 ?? 5D" />
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
								MESSAGE · <span id="frameSizeLabel">3 BYTES</span>
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

function SendPanel() {
	return (
		<aside id="sendPanel" className="send-popup collapsed" aria-label="Serial message composer">
			<header className="send-popup-titlebar">
				<button
					id="toggleSendPopupBtn"
					className="send-popup-toggle"
					type="button"
					aria-expanded="false"
					aria-controls="sendPopupContent"
				>
					<span className="send-popup-title"><i aria-hidden="true" /> Compose serial message</span>
					<span id="queueTabCount" className="send-popup-count" aria-label="Messages in queue">0</span>
				</button>
				<button id="minimizeSendPopupBtn" className="send-popup-minimize" type="button" aria-label="Minimize composer">
					—
				</button>
			</header>
			<div id="sendPopupContent" className="send-popup-content">
				<div className="send-popup-meta">
					<p id="sendConnectionHint">Connect a serial port to send. Drafts and queue stay saved locally.</p>
					<span id="sendStatusBadge" className="send-status">
						<i /> OFFLINE
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
							autoComplete="off"
							autoCapitalize="characters"
							spellCheck={false}
							placeholder="e.g. C2 08 5D"
							aria-describedby="transmitHint"
						/>
					</label>
					<p id="transmitHint" className="transmit-hint">
						Enter whole bytes as hex.
					</p>
					<div className="composer-actions">
						<button id="addQueueBtn" className="btn btn-secondary" type="button" disabled>
							Add to queue
						</button>
						<button id="sendBytesBtn" className="btn btn-send" type="button" disabled>
							Send now
						</button>
					</div>
					</section>

					<section className="send-card queue-card" aria-label="Timed transmit queue">
					<div className="send-card-heading">
						<div>
							<span className="eyebrow">Sequence</span>
							<h3>Timed queue <span id="queueCount">0</span></h3>
						</div>
						<label className="queue-delay">
							Gap
							<input id="queueDelay" type="number" min="0" max="600000" step="10" defaultValue="100" />
							ms
						</label>
					</div>
					<div id="queueList" className="queue-list" />
					<div className="queue-actions">
						<button id="clearQueueBtn" className="text-btn" type="button">
							Clear queue
						</button>
						<span />
						<button id="stopQueueBtn" className="btn btn-danger hidden" type="button">
							Stop
						</button>
						<button id="runQueueBtn" className="btn btn-primary" type="button" disabled>
							Run queue
						</button>
					</div>
					</section>

					<section className="send-card history-card" aria-label="Transmit history">
					<div className="send-card-heading">
						<div>
							<span className="eyebrow">Local history</span>
							<h3>Recent sends <span id="historyCount">0</span></h3>
						</div>
						<button id="clearHistoryBtn" className="text-btn" type="button">
							Clear
						</button>
					</div>
					<div id="sendHistory" className="send-history" />
					</section>
				</div>
			</div>
		</aside>
	);
}

function AnalysisPanel() {
	return (
		<div id="patternsPanel" className="tab-panel">
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
					<div id="bitMap" className="bit-map" />
				</article>
				<article className="analysis-card">
					<div className="card-heading">
						<div>
							<span className="eyebrow">Frequency</span>
							<h2>Message signatures</h2>
						</div>
					</div>
					<div id="signatureList" className="signature-list" />
				</article>
				<article className="analysis-card">
					<div className="card-heading">
						<div>
							<span className="eyebrow">Per offset</span>
							<h2>Byte vocabulary</h2>
						</div>
					</div>
					<div id="vocabulary" className="vocabulary" />
				</article>
				<article className="analysis-card wide">
					<div className="card-heading">
						<div>
							<span className="eyebrow">Discovery aid</span>
							<h2>Transitions</h2>
						</div>
						<span className="muted">Consecutive message changes</span>
					</div>
					<div id="transitionList" className="transition-list" />
				</article>
			</div>
		</div>
	);
}

function NotesPanel() {
	return (
		<div id="notesPanel" className="tab-panel">
			<div className="notes-layout">
				<div>
					<div className="section-title">
						<span className="eyebrow">Notebook</span>
						<h2>Protocol observations</h2>
					</div>
					<div id="notesList" className="notes-list" />
				</div>
				<form id="captureNoteForm" className="note-composer">
					<span className="eyebrow">Sequence observation</span>
					<h2>Record a message sequence</h2>
					<div id="sequenceRange" className="sequence-range">
						<label className="field">
							From row
							<input id="sequenceStart" type="number" min="1" defaultValue="1" />
						</label>
						<label className="field">
							To row
							<input id="sequenceEnd" type="number" min="1" defaultValue="2" />
						</label>
					</div>
					<textarea
						id="captureNoteText"
						required
						placeholder="What does this message sequence appear to represent?"
					/>
					<button className="btn btn-primary" type="submit">
						Add sequence note
					</button>
				</form>
			</div>
		</div>
	);
}

function DialogHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
	return (
		<div className="modal-heading">
			<div>
				<span className="eyebrow">{eyebrow}</span>
				<h2>{title}</h2>
			</div>
			<button className="icon-btn" value="cancel" formMethod="dialog" formNoValidate aria-label="Close">
				×
			</button>
		</div>
	);
}

function ContextDialog() {
	return (
		<dialog id="contextDialog" className="modal">
			<form id="contextForm" method="dialog">
				<DialogHeading eyebrow="Capture definition" title="Controller context" />
				<label className="field">
					Capture name
					<input id="contextName" required />
				</label>
				<label className="field">
					Controller screen / view
					<input id="contextView" placeholder="e.g. Temperature" />
				</label>
				<label className="field">
					Archive folder
					<select id="contextFolder" defaultValue="">
						<option value="">Unfiled</option>
					</select>
				</label>
				<div className="field">
					<div className="field-row">
						<span>Parameters</span>
						<button id="addParameterBtn" type="button" className="text-btn">
							＋ Add parameter
						</button>
					</div>
					<div id="parameterRows" className="parameter-rows" />
				</div>
				<div className="serial-settings">
					<label className="field">
						Baud rate
						<select id="baudRate" defaultValue="115200">
							<option>9600</option>
							<option>19200</option>
							<option>115200</option>
							<option>250000</option>
						</select>
					</label>
					<div className="field serial-format">
						<span>Input format</span>
						<strong>Raw binary bytes</strong>
						<small>Designed for ESP32 Serial.write()</small>
					</div>
				</div>
				<div className="modal-actions">
					<button className="btn btn-secondary" value="cancel" formMethod="dialog" formNoValidate>
						Cancel
					</button>
					<button id="saveContextBtn" className="btn btn-primary" value="default">
						Save context
					</button>
				</div>
			</form>
		</dialog>
	);
}

function SectionsDialog() {
	return (
		<dialog id="sectionsDialog" className="modal sections-modal">
			<form id="sectionsForm" method="dialog">
				<DialogHeading eyebrow="Sectioned framing" title="Frame-length sections" />
				<p className="modal-copy">
					Each section starts at a raw-byte position and applies its own frame length until the next section
					begins.
				</p>
				<div id="sectionRows" className="section-rows" />
				<button id="addSectionBtn" className="text-btn" type="button">
					＋ Add section
				</button>
				<div className="modal-actions">
					<button className="btn btn-secondary" value="cancel" formMethod="dialog" formNoValidate>
						Cancel
					</button>
					<button className="btn btn-primary" value="default">
						Save sections
					</button>
				</div>
			</form>
		</dialog>
	);
}

function AnnotationDialog() {
	return (
		<dialog id="noteDialog" className="modal note-modal">
			<form id="annotationForm" method="dialog">
				<div className="modal-heading">
					<div>
						<span className="eyebrow">Annotation</span>
						<h2 id="annotationTitle">Note on message</h2>
					</div>
					<button className="icon-btn" value="cancel" formMethod="dialog" formNoValidate aria-label="Close">
						×
					</button>
				</div>
				<div id="annotationTarget" className="annotation-target" />
				<label className="field">
					Note
					<textarea id="annotationText" placeholder="Possible checksum, command, status flag…" />
				</label>
				<div id="annotationHint" className="validation-hint" aria-live="polite">
					Enter a note to enable saving.
				</div>
				<div className="modal-actions">
					<button id="deleteAnnotationBtn" className="btn btn-danger" type="button">
						Delete note
					</button>
					<span />
					<button className="btn btn-secondary" value="cancel" formMethod="dialog" formNoValidate>
						Cancel
					</button>
					<button id="saveAnnotationBtn" className="btn btn-primary" value="default" disabled>
						Save note
					</button>
				</div>
			</form>
		</dialog>
	);
}

function PatternRemarkDialog() {
	return (
		<dialog id="patternDialog" className="modal note-modal">
			<form id="patternRemarkForm" method="dialog">
				<div className="modal-heading">
					<div>
						<span className="eyebrow">Recognized sequence</span>
						<h2 id="patternRemarkTitle">Sequence note</h2>
					</div>
					<button className="icon-btn" value="cancel" formMethod="dialog" formNoValidate aria-label="Close">
						×
					</button>
				</div>
				<div id="patternRemarkTarget" className="pattern-remark-target" />
				<label className="field">
					Shared sequence note
					<textarea
						id="patternRemarkText"
						placeholder="What does this repeated exchange appear to represent?"
					/>
				</label>
				<div id="patternRemarkHint" className="validation-hint" aria-live="polite">
					This note appears in the Sequence column for every occurrence.
				</div>
				<div className="modal-actions">
					<button id="deletePatternRemarkBtn" className="btn btn-danger" type="button">
						Delete note
					</button>
					<span />
					<button className="btn btn-secondary" value="cancel" formMethod="dialog" formNoValidate>
						Cancel
					</button>
					<button id="savePatternRemarkBtn" className="btn btn-primary" value="default">
						Save note
					</button>
				</div>
			</form>
		</dialog>
	);
}

function ExportDialog() {
	return (
		<dialog id="exportDialog" className="modal">
			<form method="dialog">
				<DialogHeading eyebrow="Portable evidence" title="Export captures" />
				<div className="export-options">
					<button type="button" data-export="json">
						<strong>JSON archive</strong>
						<span>All captures, parameters, timing and notes. Re-importable.</span>
					</button>
					<button type="button" data-export="csv">
						<strong>CSV table</strong>
						<span>The active capture, ready for a spreadsheet.</span>
					</button>
					<button type="button" data-export="txt">
						<strong>Monitor text</strong>
						<span>Human-readable timestamped hex dump with context.</span>
					</button>
				</div>
			</form>
		</dialog>
	);
}

function FolderDialog() {
	return (
		<dialog id="folderDialog" className="modal folder-modal">
			<form id="folderForm" method="dialog">
				<DialogHeading eyebrow="Archive organization" title="Create folder" />
				<label className="field">
					Folder name
					<input id="folderName" required maxLength={80} placeholder="e.g. Ventilation tests" />
				</label>
				<div id="folderHint" className="validation-hint" aria-live="polite">
					Use a short name that describes this group of captures.
				</div>
				<div className="modal-actions">
					<button className="btn btn-secondary" value="cancel" formMethod="dialog" formNoValidate>
						Cancel
					</button>
					<button id="saveFolderBtn" className="btn btn-primary" value="default">
						Create folder
					</button>
				</div>
			</form>
		</dialog>
	);
}

function App() {
	useEffect(() => {
		void import("./controller");
	}, []);

	return (
		<>
			<div className="app-shell">
				<TopBar />
				<main className="workspace">
					<Sidebar />
					<section className="main-panel">
						<CaptureHeader />
						<Toolbar />
						<StreamPanel />
						<AnalysisPanel />
						<NotesPanel />
					</section>
				</main>
			</div>
			<SendPanel />
			<ContextDialog />
			<SectionsDialog />
			<AnnotationDialog />
			<PatternRemarkDialog />
			<ExportDialog />
			<FolderDialog />
			<div id="toast" className="toast" role="status" />
		</>
	);
}

export default App;

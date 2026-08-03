// The controller remains framework-agnostic so the protocol and Web Serial
// behavior can stay byte-for-byte compatible with the original implementation.
// @ts-nocheck
import {
	Virtualizer,
	elementScroll,
	observeElementOffset,
	observeElementRect
} from "@tanstack/virtual-core";
import { publishArchiveSnapshot, registerArchiveActions } from "./archive-bridge";
import { MAX_SEND_HISTORY, STORAGE_KEY, loadState, normalizeSendState } from "./app-state";
import {
	colorForByte,
	deriveAnalysisSnapshot,
	getCounts,
	recognizeMessagePatterns,
	rowsWithDelta,
	summarizeRunCadence,
	transitionFrames
} from "./analysis";
import { publishAnalysisSnapshot } from "./analysis-bridge";
import { deriveCaptureHeaderSnapshot } from "./capture-header";
import { publishCaptureHeaderSnapshot, registerCaptureHeaderActions } from "./capture-header-bridge";
import {
	publishFramingToolbarSnapshot,
	registerFramingToolbarActions
} from "./framing-toolbar-bridge";
import { publishSendSnapshot, registerSendActions } from "./send-bridge";
import { registerNotesActions, publishNotesSnapshot, type SequenceNoteInput } from "./notes-bridge";
import { deriveNotesSnapshot } from "./notes";
import { publishToastSnapshot } from "./toast-bridge";
import { publishDialogCommand, registerDialogActions } from "./dialog-bridge";
import { getViewStateSnapshot, subscribeToViewState } from "./view-state-bridge";
import {
	publishMessageStreamSnapshot,
	registerMessageStreamActions
} from "./message-stream-bridge";
import { deriveMessageStreamSnapshot } from "./message-stream";
import {
	annotationTargetLabel,
	annotationTextIsValid,
	contextDraftToValues,
	normalizeAnnotationText,
	normalizePatternRemarkText,
	sectionRowFromModel,
	serializeSectionDrafts
} from "./dialog-model";
import {
	applyFramingSettings,
	selectFramingToolbarSnapshot
} from "./framing-toolbar";
import {
	recordReceivedByte
} from "./capture-summary";
import {
	collapseAdjacentRuns,
	countVisibleRowsByPatternOccurrence
} from "./collapse-runs";
import {
	frameWidth,
	hexByte,
	makeMessage,
	markerBytes,
	normalizeCapture,
	normalizeSections,
	parseTime,
	rebuildPreview,
	signature,
	visibleByteEntries,
	visibleMessages,
	visiblePositionForRawByte
} from "./capture-framing";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
// A capture remains useful at this size while still fitting comfortably in browser storage.
const MAX_CAPTURE_BYTES = 50_000;
const LIVE_REFRESH_MS = 120;
const VIRTUAL_ROW_HEIGHT = 41;
const VIRTUAL_SECTION_HEIGHT = 48;
const VIRTUAL_OVERSCAN = 8;
let state = loadState();
let activeId = state.activeId || state.captures[0]?.id;
let port = null;
let reader = null;
let recording = false;
let recordingSessionId = null;
let readAbort = false;
let messageContextTarget = null;
let messageContextOrigin = null;
let toastTimer = null;
let pendingLiveBytes = [];
let liveRefreshTimer = null;
let stateSaveTimer = null;
let virtualMessageView = null;
let messageVirtualizer = null;
let disposeMessageVirtualizer = null;
let virtualRenderPending = false;
let virtualViewVersion = 0;
let renderedVirtualRangeKey = "";
let sendInFlight = false;
let queueRunning = false;
let stopQueueRequested = false;
let queueDelayTimer = null;
let queueDelayResolve = null;

function persistState() {
	state.activeId = activeId;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch (error) {
		console.warn("Could not save Bus Lens state", error);
		showToast("Capture is live, but browser storage is full");
	}
}

function saveState({ immediate = false } = {}) {
	if (immediate) {
		clearTimeout(stateSaveTimer);
		stateSaveTimer = null;
		persistState();
		return;
	}
	if (stateSaveTimer) return;
	stateSaveTimer = setTimeout(() => {
		stateSaveTimer = null;
		persistState();
	}, 1_000);
}

function capture() {
	return state.captures.find(c => c.id === activeId) || state.captures[0];
}

function publishArchiveState() {
	publishArchiveSnapshot({
		captures: state.captures.map(item => ({
			id: String(item.id),
			name: String(item.name ?? ""),
			view: String(item.view || ""),
			folderId: item.folderId || null,
			params: (Array.isArray(item.params) ? item.params : []).map(parameter => ({
				key: String(parameter.key ?? ""),
				value: String(parameter.value ?? "")
			})),
			messageCount: visibleMessages(item).length
		})),
		folders: state.folders.map(folder => ({
			id: String(folder.id),
			name: String(folder.name ?? ""),
			collapsed: Boolean(folder.collapsed)
		})),
		activeId,
		unfiledCollapsed: Boolean(state.unfiledCollapsed)
	});
}

function publishSendState() {
	normalizeSendState(state);
	publishSendSnapshot({
		connected: Boolean(port?.writable),
		recording,
		sendInFlight,
		queueRunning,
		stopQueueRequested,
		draft: state.sendSettings.draft,
		delayMs: state.sendSettings.delayMs,
		queue: state.sendQueue.map(item => ({
			id: String(item.id),
			bytes: item.bytes.map(Number),
			createdAt: Number(item.createdAt)
		})),
		history: state.sendHistory.map(item => ({
			id: String(item.id),
			timestamp: Number(item.timestamp),
			bytes: item.bytes.map(Number),
			origin: String(item.origin || ""),
			ok: item.ok !== false,
			error: String(item.error || ""),
			captureId: item.captureId ? String(item.captureId) : null
		}))
	});
}

function formatTime(ms) {
	return new Date(ms).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		fractionalSecondDigits: 3
	});
}

function formatDelta(ms) {
	if (ms === null) return "—";
	if (ms >= 60000) return `${(ms / 60000).toFixed(1)} min`;
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
	return `${ms.toFixed(1)} ms`;
}

function escapeHtml(value = "") {
	return String(value).replace(
		/[&<>"']/g,
		ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[ch]
	);
}

function showToast(message) {
	clearTimeout(toastTimer);
	publishToastSnapshot({ message, visible: true });
	toastTimer = setTimeout(() => publishToastSnapshot({ message: "", visible: false }), 2600);
}

function closeMessageContextMenu({ restoreFocus = false } = {}) {
	const menu = $("#messageContextMenu");
	if (!menu) return;
	menu.classList.add("hidden");
	menu.setAttribute("aria-hidden", "true");
	const origin = messageContextOrigin;
	messageContextTarget = null;
	messageContextOrigin = null;
	if (restoreFocus && origin?.isConnected && typeof origin.focus === "function") origin.focus();
}

function openMessageContextMenu(event) {
	const targetElement = event.target instanceof Element ? event.target : null;
	const row = targetElement?.closest("tr[data-message-id]");
	if (!row) return;
	const byteButton = targetElement.closest("[data-byte-note]");
	const byteKey = byteButton?.dataset.byteNote;
	const bytePosition = byteKey ? Number(byteKey.split(":")[1]) : null;
	const messageId = row.dataset.messageId;
	const message = capture()?.messages.find(item => item.id === messageId);
	if (!message || (byteButton && !Number.isInteger(bytePosition))) return;

	event.preventDefault();
	messageContextTarget = { messageId, position: byteButton ? bytePosition : null };
	messageContextOrigin = targetElement.closest("button") || row;
	const menu = $("#messageContextMenu");
	const sectionAction = menu.querySelector('[data-context-action="section"]');
	const deleteLabel = menu.querySelector("[data-context-delete-label]");
	const deleteAction = menu.querySelector('[data-context-action="delete"]');
	const targetLabel = byteButton ? "byte" : "message";
	if (deleteLabel) deleteLabel.textContent = `Delete ${targetLabel}`;
	if (deleteAction) deleteAction.setAttribute("aria-label", `Delete ${targetLabel} (keep data hidden)`);
	sectionAction.classList.toggle("hidden", !byteButton);
	menu.classList.remove("hidden");
	menu.setAttribute("aria-hidden", "false");

	const edge = 10;
	const bounds = menu.getBoundingClientRect();
	const left = Math.min(event.clientX, window.innerWidth - bounds.width - edge);
	const top = Math.min(event.clientY, window.innerHeight - bounds.height - edge);
	menu.style.left = `${Math.max(edge, left)}px`;
	menu.style.top = `${Math.max(edge, top)}px`;
}

function handleMessageContextAction(action) {
	const target = messageContextTarget;
	if (!target) return;
	closeMessageContextMenu();
	const c = capture();
	const message = c?.messages.find(item => item.id === target.messageId);
	if (!message) return;
	if (action === "note") {
		const type = target.position === null ? "message" : "byte";
		const key = target.position === null ? target.messageId : `${target.messageId}:${target.position}`;
		publishAnnotationDialog(type, key);
	} else if (action === "replay") {
		void transmitBytes(Uint8Array.from(visibleByteEntries(message).map(({ value }) => value)), "replay");
	} else if (action === "delete") {
		if (target.position === null) {
			message.hidden = true;
			saveState({ immediate: true });
			render();
			showToast("Message hidden; captured data was kept");
		} else if (target.position >= 0 && target.position < message.bytes.length) {
			message.hiddenBytes ||= [];
			message.hiddenBytes[target.position] = true;
			const rawIndex = message._rawPositions?.[target.position] ?? -1;
			if (rawIndex >= 0 && c.byteStream?.[rawIndex]) c.byteStream[rawIndex].hidden = true;
			rebuildPreview(c);
			saveState({ immediate: true });
			render();
			showToast("Byte hidden; captured data was kept");
		}
	} else if (action === "section" && target.position !== null) {
		startSectionAtByte(target.messageId, target.position);
	}
}

function render() {
	publishArchiveState();
	publishCaptureHeaderState();
	syncTransportControls();
	publishFramingToolbarState();
	publishSendState();
	publishAnalysisState();
	publishNotesState();
	if (!capture()) {
		renderEmptyWorkspace();
		return;
	}
	renderMessages();
}

function renderEmptyWorkspace() {
	publishMessageStreamSnapshot(deriveMessageStreamSnapshot(null, getViewStateSnapshot()));
	$("#messageBody").innerHTML = "";
	$(".message-table").classList.add("hidden");
	$("#emptyState").classList.remove("hidden");
	$("#emptyState h2").textContent = "No captures in the archive";
	$("#emptyState p").textContent = "Create a capture or import a monitor dump to begin.";
	$("#visibleCount").textContent = "0 rows";
	$("#patternCount").textContent = "0 groups";
}

function selectArchiveCapture(captureId) {
	activeId = captureId;
	saveState();
	render();
}

function toggleArchiveFolder(folderId) {
	if (folderId) {
		const folder = state.folders.find(item => item.id === folderId);
		if (folder) folder.collapsed = !folder.collapsed;
	} else state.unfiledCollapsed = !state.unfiledCollapsed;
	saveState();
	publishArchiveState();
}

function moveArchiveCapture(captureId, folderId) {
	const item = state.captures.find(capture => capture.id === captureId);
	if (!item) return;
	const folderNameById = new Map(state.folders.map(folder => [folder.id, folder.name]));
	item.folderId = folderId || null;
	saveState();
	publishArchiveState();
	showToast(item.folderId ? `Moved to ${folderNameById.get(item.folderId)}` : "Moved to Unfiled");
}

function saveFolder(name, editingId) {
	const trimmedName = String(name).trim();
	const duplicate = state.folders.some(
		folder => folder.id !== editingId && folder.name.toLowerCase() === trimmedName.toLowerCase()
	);
	if (!trimmedName || duplicate) return false;
	const folder = state.folders.find(item => item.id === editingId);
	if (folder) {
		folder.name = trimmedName;
		showToast("Folder renamed");
	} else {
		state.folders.push({
			id: crypto.randomUUID(),
			name: trimmedName,
			collapsed: false,
			createdAt: new Date().toISOString()
		});
		showToast("Folder created");
	}
	saveState();
	publishArchiveState();
	return true;
}

function deleteFolder(folderId) {
	const folder = state.folders.find(item => item.id === folderId);
	if (!folder) return;
	const captureCount = state.captures.filter(item => item.folderId === folderId).length;
	const detail = captureCount
		? ` Its ${captureCount} capture${captureCount === 1 ? "" : "s"} will be moved to Unfiled.`
		: "";
	if (!confirm(`Delete folder “${folder.name}”?${detail}`)) return;
	state.captures.forEach(item => {
		if (item.folderId === folderId) item.folderId = null;
	});
	state.folders = state.folders.filter(item => item.id !== folderId);
	saveState();
	publishArchiveState();
	showToast(captureCount ? "Folder deleted; captures moved to Unfiled" : "Folder deleted");
}

function publishCaptureHeaderState() {
	publishCaptureHeaderSnapshot(deriveCaptureHeaderSnapshot(capture(), recording));
}

function syncTransportControls() {
	$("#connectBtn").disabled = false;
	$("#recordBtn").disabled = !port || !capture();
}

function publishFramingToolbarState(c = capture()) {
	publishFramingToolbarSnapshot(selectFramingToolbarSnapshot(c));
}

function publishAnalysisState(c = capture()) {
	publishAnalysisSnapshot(deriveAnalysisSnapshot(c));
}

function publishNotesState(c = capture()) {
	publishNotesSnapshot(deriveNotesSnapshot(c));
}

function addSequenceNote({ start: rawStart, end: rawEnd, text: rawText }: SequenceNoteInput): boolean {
	const c = capture();
	const noteText = String(rawText || "").trim();
	if (!c || !noteText) return false;
	const max = Math.max(1, c.messages.length);
	const start = Math.max(1, Math.min(max, Number(rawStart) || 1));
	const end = Math.max(start, Math.min(max, Number(rawEnd) || start));
	c.notes ||= [];
	c.notes.push({
		id: crypto.randomUUID(),
		type: "sequence",
		text: noteText,
		createdAt: Date.now(),
		start,
		end,
		targetLabel: `rows ${start}–${end}`
	});
	saveState();
	publishNotesState(c);
	renderMessages();
	showToast("Sequence observation added");
	return true;
}

function filteredMessages() {
	const c = capture();
	const patternMembership = recognizeMessagePatterns(c).membership;
	const sequenceNoteRows = new Set();
	const maxMessageIndex = (c?.messages?.length || 0) - 1;
	for (const note of c?.notes || []) {
		if (note.type !== "sequence") continue;
		const start = Math.max(0, Math.trunc(Number(note.start)) - 1);
		const end = Math.min(maxMessageIndex, Math.trunc(Number(note.end)) - 1);
		if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
		for (let index = start; index <= end; index++) sequenceNoteRows.add(index);
	}
	let rows = (c?.messages || [])
		.map((message, originalIndex) => {
			const patternMember = patternMembership.get(originalIndex);
			return {
				...message,
				_originalStart: originalIndex,
				_originalEnd: originalIndex,
				_hasSequenceNote: sequenceNoteRows.has(originalIndex),
				_patternOccurrence: patternMember ? `${patternMember.group.id}:${patternMember.occurrenceIndex}` : null,
				_runStart: message.timestamp,
				_runEnd: message.timestamp,
				_runMessages: [message],
				_repeats: 1
			};
		})
		.filter(message => !message.hidden);
	const viewState = getViewStateSnapshot();
	const query = viewState.filterQuery.trim().toUpperCase();
	if (query) {
		const pattern = query
			.split(/\s+/)
			.map(x => (x === "??" || x === "**" ? "[0-9A-F]{2}" : x.replace(/[^0-9A-F?]/g, "").replaceAll("?", "[0-9A-F]")))
			.join("\\s+");
		try {
			const re = new RegExp(pattern);
			rows = rows.filter(m => re.test(signature(m)));
		} catch {}
	}
	const sectionsById = new Map((c?.frameSections || []).map(section => [section.id, section]));
	if (viewState.collapseRuns || c?.previewMode === "sections") {
		rows = collapseAdjacentRuns(
			rows,
			m =>
				c.previewMode === "sections"
					? Boolean(sectionsById.get(m.sectionId)?.collapseRuns)
					: viewState.collapseRuns,
			signature
		);
	}
	return rowsWithDelta(rows.map(summarizeRunCadence));
}

function renderMessages() {
	const c = capture();
	if (!c) return;
	const viewState = getViewStateSnapshot();
	publishMessageStreamSnapshot(deriveMessageStreamSnapshot(c, viewState));
	const matchingRows = filteredMessages();
	const messages = visibleMessages(c);
	const signatureCounts = getCounts(messages);
	const countsByPosition = Array.from({ length: frameWidth(c) }, (_, pos) => {
		const map = new Map();
		messages.forEach(m => {
			const byte = visibleByteEntries(m)[pos]?.value;
			if (byte !== undefined) map.set(byte, (map.get(byte) || 0) + 1);
		});
		return map;
	});
	const patterns = recognizeMessagePatterns(c);
	const highlight = viewState.showFrameChanges;
	const frames = highlight
		? transitionFrames(matchingRows)
		: matchingRows.map(row => visibleByteEntries(row).map(() => ({ incoming: null, outgoing: null })));
	const patternNumbers = new Map(patterns.groups.map((group, index) => [group.id, index + 1]));
	const visiblePatternRowCounts = countVisibleRowsByPatternOccurrence(matchingRows);
	const sectionNumbers = new Map((c.frameSections || []).map((section, index) => [section.id, index + 1]));
	const sectionsById = new Map((c.frameSections || []).map(section => [section.id, section]));
	const entries = [];
	let previousSectionId = null;
	matchingRows.forEach((row, rowIndex) => {
		if (c.previewMode === "sections" && row.sectionId !== previousSectionId) {
			const section = sectionsById.get(row.sectionId);
			if (section) {
				entries.push({
					type: "section",
					key: `section:${section.id}:${row._originalStart}`,
					section,
					sectionNumber: sectionNumbers.get(section.id)
				});
			}
		}
		entries.push({ type: "message", key: `message:${row.id}`, row, rowIndex });
		previousSectionId = row.sectionId;
	});
	const telegramCount = matchingRows.reduce((sum, row) => sum + row._repeats, 0);
	const visibleSummary = matchingRows.length
		? `${matchingRows.length.toLocaleString()} row${matchingRows.length === 1 ? "" : "s"}`
		: "0 rows";
	$("#visibleCount").textContent =
		telegramCount === matchingRows.length
			? visibleSummary
			: `${visibleSummary} · ${telegramCount.toLocaleString()} telegrams`;
	virtualMessageView = {
		c,
		matchingRows,
		signatureCounts,
		countsByPosition,
		patterns,
		patternNumbers,
		visiblePatternRowCounts,
		entries,
		frames,
		mode: viewState.displayMode,
		highlight
	};
	virtualViewVersion++;
	renderedVirtualRangeKey = "";
	$("#patternCount").textContent = `${patterns.groups.length} group${patterns.groups.length === 1 ? "" : "s"}`;
	updateMessageVirtualizer();
	renderVirtualRows();
}

function getVirtualEntryKey(index) {
	return virtualMessageView?.entries[index]?.key ?? index;
}

function estimateVirtualEntrySize(index) {
	return virtualMessageView?.entries[index]?.type === "section" ? VIRTUAL_SECTION_HEIGHT : VIRTUAL_ROW_HEIGHT;
}

function scheduleVirtualRows() {
	if (!virtualMessageView || virtualRenderPending) return;
	virtualRenderPending = true;
	requestAnimationFrame(() => {
		virtualRenderPending = false;
		renderVirtualRows();
	});
}

function virtualizerOptions() {
	return {
		count: virtualMessageView?.entries.length || 0,
		getScrollElement: () => $(".table-wrap"),
		estimateSize: estimateVirtualEntrySize,
		getItemKey: getVirtualEntryKey,
		overscan: VIRTUAL_OVERSCAN,
		scrollToFn: elementScroll,
		observeElementRect,
		observeElementOffset,
		measureElement: element => element.getBoundingClientRect().height,
		onChange: scheduleVirtualRows
	};
}

function updateMessageVirtualizer() {
	if (!messageVirtualizer) {
		messageVirtualizer = new Virtualizer(virtualizerOptions());
		disposeMessageVirtualizer = messageVirtualizer._didMount();
	} else {
		messageVirtualizer.setOptions(virtualizerOptions());
	}
	messageVirtualizer._willUpdate();
}

function renderVirtualRows() {
	const view = virtualMessageView;
	if (!view || !messageVirtualizer) return;
	const {
		c,
		matchingRows,
		signatureCounts,
		countsByPosition,
		patterns,
		patternNumbers,
		visiblePatternRowCounts,
		entries,
		frames,
		mode,
		highlight
	} = view;
	const virtualItems = messageVirtualizer.getVirtualItems();
	const renderKey = `${virtualViewVersion}|${messageVirtualizer.getTotalSize()}|${virtualItems
		.map(item => `${item.index}:${item.start}:${item.size}`)
		.join(",")}`;
	if (renderKey === renderedVirtualRangeKey) return;
	renderedVirtualRangeKey = renderKey;
	const rowsHtml = virtualItems
		.map(virtualItem => {
			const entry = entries[virtualItem.index];
			if (!entry) return "";
			const virtualStyle = `transform:translateY(${virtualItem.start}px)`;
			if (entry.type === "section") {
				const { section, sectionNumber } = entry;
				return `<tr class="section-divider" data-index="${virtualItem.index}" style="${virtualStyle}">
          <td class="section-number">${String(sectionNumber).padStart(2, "0")}</td>
          <td colspan="6"><div class="section-header-content">
            <span>Section · raw byte ${section.start + 1}</span>
            <div class="section-header-controls">
              <label>Message length <input data-section-length="${section.id}" type="number" min="1" max="1024" value="${section.frameSize}" /> bytes</label>
              <label class="switch-label section-collapse">Collapse runs <input data-section-collapse="${section.id}" type="checkbox" ${section.collapseRuns ? "checked" : ""} /><span class="switch"></span></label>
            </div>
          </div></td>
        </tr>`;
			}
			const { row: m, rowIndex } = entry;
			const messageNote = c.annotations[m.id];
			const patternMember = patterns.membership.get(m._originalStart);
			const pattern = patternMember?.group;
			const isPatternStart = patternMember?.offset === 0;
			const patternEndMember = patterns.membership.get(m._originalEnd);
			const isPatternEnd =
				pattern &&
				patternEndMember?.group.id === pattern.id &&
				patternEndMember.occurrenceIndex === patternMember.occurrenceIndex &&
				patternEndMember.offset === pattern.length - 1;
			const visiblePatternRowCount = visiblePatternRowCounts.get(m._patternOccurrence) || pattern?.length;
			const originalRow = m._originalStart + 1;
			const sequenceNote = (c.notes || []).find(
				n => n.type === "sequence" && originalRow >= n.start && originalRow <= n.end
			);
			const isUnique = signatureCounts.get(signature(m)) === 1;
			const rowLabel = m._originalStart === m._originalEnd ? originalRow : `${originalRow}–${m._originalEnd + 1}`;
			const visibleBytes = visibleByteEntries(m);
			const sentByteCount = visibleBytes.filter(({ rawPosition }) => m.directions?.[rawPosition] === "tx").length;
			const hasSentBytes = sentByteCount > 0;
			const directionTag = hasSentBytes ? (sentByteCount === visibleBytes.length ? "TX" : "MIXED") : "";
			const rowClasses = [
				sequenceNote ? "sequence-noted" : "",
				isUnique ? "unique-message" : "",
				hasSentBytes ? "sent-message" : "",
				pattern ? "pattern-member" : "",
				isPatternStart ? "pattern-start" : "",
				isPatternEnd ? "pattern-end" : ""
			]
				.filter(Boolean)
				.join(" ");
			const rowTitles = [
				isUnique ? "Unique telegram · this signature occurs once in the capture" : "",
				sequenceNote ? `Sequence rows ${sequenceNote.start}–${sequenceNote.end}: ${sequenceNote.text}` : "",
				pattern
					? `Repeated sequence · occurrence ${patternMember.occurrenceIndex + 1} of ${pattern.starts.length}${pattern.remark ? ` · ${pattern.remark}` : ""}`
					: ""
			]
				.filter(Boolean)
				.join(" · ");
			const patternStyle = pattern
				? `;--pattern-color:${pattern.color};--sequence-row-count:${visiblePatternRowCount};--sequence-row-height:${virtualItem.size}px`
				: "";
			const sequenceControl = pattern
				? `<td class="sequence-cell" style="--pattern-color:${pattern.color}">
				  <button class="sequence-group ${isPatternStart ? "sequence-group-start" : ""} ${
						isPatternEnd ? "sequence-group-end" : ""
					}" data-pattern-id="${pattern.id}" title="${escapeHtml(
						`Sequence ${String(patternNumbers.get(pattern.id)).padStart(2, "0")} · occurrence ${patternMember.occurrenceIndex + 1} of ${pattern.starts.length} · ${pattern.length} messages${pattern.remark ? ` · shared note: ${pattern.remark}` : " · add a shared note"}`
					)}" aria-label="${pattern.remark ? "Edit shared sequence note" : "Add shared sequence note"}">
            <span class="sequence-rail" aria-hidden="true"><span class="sequence-rail-endcap"></span></span>
            ${
						isPatternStart
							? `<span class="sequence-summary">
                <span class="sequence-label">SEQ ${String(patternNumbers.get(pattern.id)).padStart(2, "0")} <b>${pattern.length} rows</b></span>
                <span class="sequence-occurrence">${patternMember.occurrenceIndex + 1} / ${pattern.starts.length}</span>
                <span class="sequence-note ${pattern.remark ? "" : "empty"}">${escapeHtml(pattern.remark || "+ Add shared note")}</span>
              </span>`
							: `<span class="sequence-continuation" aria-hidden="true"></span>`
					}
          </button>
        </td>`
				: `<td class="sequence-cell"><span class="sequence-empty">—</span></td>`;
			const noteControl = messageNote || sequenceNote
				? `<button class="note-link" data-message-note="${m.id}">${escapeHtml(messageNote?.text || `↳ ${sequenceNote.text}`)}</button>`
				: `<button class="row-action add-note" data-message-note="${m.id}">＋ Add note</button>`;
			const annotationControl = `<div class="row-actions">
          ${noteControl}
          <button class="row-action replay-link" data-message-replay="${m.id}" title="Replay this message on the connected serial port">↻ Replay</button>
        </div>`;
			return `<tr data-index="${virtualItem.index}" data-message-id="${m.id}" class="${rowClasses}" style="${virtualStyle}${patternStyle}" title="${escapeHtml(rowTitles)}">
      <td>${rowLabel}</td>
      <td>${formatTime(m.timestamp)}${directionTag ? `<span class="direction-tag">${directionTag}</span>` : ""}</td>
      <td>${formatDelta(m._delta)}</td>
      ${sequenceControl}
      <td><div class="byte-row">${visibleBytes
			.map(({ value: byte, rawPosition }, pos) => {
				const count = countsByPosition[pos]?.get(byte) || 0;
				const frame = frames[rowIndex][pos] || {};
				const incoming = frame.incoming;
				const outgoing = frame.outgoing;
				const previousRow = matchingRows[rowIndex - 1];
				const previousIsAdjacent =
					previousRow &&
					m._originalStart === previousRow._originalEnd + 1 &&
					m.sectionId === previousRow.sectionId;
				const previousByte = previousIsAdjacent ? visibleByteEntries(previousRow)[pos]?.value : undefined;
				const changedFromPrevious = previousIsAdjacent && previousByte !== byte;
				const changed = highlight && (changedFromPrevious || incoming || outgoing);
				const noted = c.annotations[`${m.id}:${rawPosition}`];
				const sent = m.directions?.[rawPosition] === "tx";
				const binary = byte.toString(2).padStart(8, "0");
				const content = mode === "binary" ? `${binary.slice(0, 4)}<i>·</i>${binary.slice(4)}` : hexByte(byte);
				const classes = [
					"byte",
					mode === "binary" ? "binary" : "",
					changed ? "changed" : "",
					count === 1 ? "rare" : "",
					noted ? "noted" : "",
					sent ? "sent" : "",
					incoming ? "has-incoming" : "",
					incoming?.start ? "in-start" : "",
					incoming?.end ? "in-end" : "",
					outgoing ? "has-outgoing" : "",
					outgoing?.start ? "out-start" : "",
					outgoing?.end ? "out-end" : ""
				]
					.filter(Boolean)
					.join(" ");
				const styles = [
					`--byte-color:${colorForByte(byte)}`,
					incoming && `--in-color:${incoming.color}`,
					incoming && `--in-offset:${-3 - incoming.lane * 3}px`,
					outgoing && `--out-color:${outgoing.color}`,
					outgoing && `--out-offset:${-3 - outgoing.lane * 3}px`
				]
					.filter(Boolean)
					.join(";");
				const transitions = [incoming?.label, outgoing?.label].filter(Boolean);
				const transitionTitle = transitions.length
					? ` · framed transition${transitions.length > 1 ? "s" : ""}: ${transitions.join(" / ")}`
					: "";
				const receivedAt = new Date(m.byteTimestamps?.[rawPosition] ?? m.timestamp).toISOString();
				const directionLabel = sent ? "sent to RS-485" : "received from serial";
				return `<button class="${classes}" style="${styles}" data-byte-note="${m.id}:${rawPosition}" title="Byte ${pos + 1} · ${directionLabel} ${receivedAt} · ${count} occurrence(s)${transitionTitle} · click to annotate · right-click for actions"><span class="byte-value">${content}</span></button>`;
			})
			.join("")}</div></td>
      <td>${m._repeats > 1 ? renderRepeatPill(m) : "—"}</td>
	      <td>${annotationControl}</td>
	    </tr>`;
		})
		.join("");
	const messageBody = $("#messageBody");
	messageBody.style.height = `${messageVirtualizer.getTotalSize()}px`;
	messageBody.innerHTML = rowsHtml;
	messageBody.querySelectorAll("[data-index]").forEach(row => messageVirtualizer.measureElement(row));
	const marker = c.previewMode === "marker" ? markerBytes(c.frameMarker) : [];
	const hasVisibleMessages = visibleMessages(c).length > 0;
	const hasMatchingRows = matchingRows.length > 0;
	$("#emptyState").classList.toggle("hidden", hasMatchingRows);
	$("#emptyState h2").textContent =
		c.previewMode === "marker"
			? marker.length
				? "No marker matches in this capture"
				: "Enter a marker to preview messages"
			: hasVisibleMessages
				? "No messages match this filter"
				: c.messages.length
					? "No visible messages in this capture"
					: "No messages in this capture";
	$("#emptyState p").textContent =
		c.previewMode === "marker"
			? marker.length
				? "The raw byte stream is still preserved; adjust the marker or capture more data."
				: "Type a hex byte sequence such as AA 55 in the Marker field."
			: hasVisibleMessages
				? "Try a different byte pattern."
				: c.messages.length
					? "Hidden messages and bytes remain in the capture and JSON export."
					: "Connect a serial port and start capture, or import a monitor dump.";
	$(".message-table").classList.toggle("hidden", !hasMatchingRows);
}

function renderRepeatPill(message) {
	const min = Math.min(...message._intervals);
	const max = Math.max(...message._intervals);
	const range = message._intervals.length ? `${formatDelta(min)}${min === max ? "" : `–${formatDelta(max)}`}` : "—";
	const cadence =
		message._cadenceStable && message._cadence !== null
			? `<small>≈ ${formatDelta(Math.round(message._cadence))}</small>`
			: `<small>varied</small>`;
	const title = `${message._repeats} consecutive identical telegrams · interval ${range}`;
	return `<span class="repeat-pill ${message._cadenceStable ? "steady" : ""}" title="${title}"><strong>×${message._repeats}</strong>${cadence}</span>`;
}

function setCaptureTitle(value) {
	const c = capture();
	if (!c) return;
	c.name = value;
	saveState();
	publishCaptureHeaderState();
}

function commitCaptureTitle(value) {
	const c = capture();
	if (!c) return;
	c.name = value;
	saveState();
	publishArchiveState();
	publishCaptureHeaderState();
}

function setCaptureDescription(value) {
	const c = capture();
	if (!c) return;
	c.description = value;
	saveState();
	publishCaptureHeaderState();
}

function commitCaptureDescription(value) {
	const c = capture();
	if (!c) return;
	c.description = value;
	saveState();
	publishCaptureHeaderState();
}

function duplicateActiveCapture() {
	const source = capture();
	if (!source) return;
	const copy = structuredClone(source);
	copy.id = crypto.randomUUID();
	copy.name += " · copy";
	copy.createdAt = new Date().toISOString();
	copy.messages.forEach(m => (m.id = crypto.randomUUID()));
	copy.annotations = {};
	state.captures.unshift(copy);
	activeId = copy.id;
	saveState();
	render();
}

function clearActiveCaptureMessages() {
	const c = capture();
	if (!c) return;
	if (confirm("Clear all raw bytes, messages, and message annotations from this capture?")) {
		c.byteStream = [];
		c.messages = [];
		c.annotations = {};
		c.patternRemarks = {};
		saveState();
		render();
	}
}

function deleteActiveCapture() {
	const c = capture();
	if (!c || !confirm(`Delete “${c.name}”?`)) return;
	if (recording) {
		flushLiveBytes();
		recording = false;
		recordingSessionId = null;
	}
	state.captures = state.captures.filter(item => item.id !== activeId);
	activeId = state.captures[0]?.id || null;
	saveState();
	render();
}

function publishContextDialog(isNew = false) {
	const c = isNew
		? { name: "Untitled capture", view: "", params: [], baudRate: 115200, folderId: null, id: null }
		: capture();
	if (!c) return;
	publishDialogCommand({
		type: "context",
		mode: isNew ? "new" : "edit",
		captureId: isNew ? null : String(c.id),
		name: String(c.name ?? "Untitled capture"),
		view: String(c.view ?? ""),
		folderId: c.folderId ? String(c.folderId) : null,
		baudRate: Number(c.baudRate || 115200),
		params: (Array.isArray(c.params) ? c.params : []).map(parameter => ({
			key: String(parameter.key ?? ""),
			value: String(parameter.value ?? "")
		})),
		folders: state.folders.map(folder => ({ id: String(folder.id), name: String(folder.name || "") }))
	});
}

function publishSectionsDialog() {
	const c = capture();
	if (!c) return;
	normalizeSections(c);
	publishDialogCommand({
		type: "sections",
		captureId: String(c.id),
		streamLength: c.byteStream.length,
		frameSize: c.frameSize,
		sections: c.frameSections.map(sectionRowFromModel)
	});
}

function updateFramingSettings(update) {
	const c = capture();
	if (!c) return;
	applyFramingSettings(c, update);
	normalizeSections(c);
	rebuildPreview(c);
	saveState();
	render();
}

function commitSectionsDraft(input) {
	const c = state.captures.find(item => String(item.id) === String(input.captureId));
	if (!c) return false;
	const result = serializeSectionDrafts(input.rows, Math.max(0, c.byteStream.length - 1), c.frameSize);
	if (!result.ok) {
		showToast(result.error);
		return false;
	}
	c.frameSections = result.sections;
	normalizeSections(c);
	rebuildPreview(c);
	saveState();
	render();
	showToast("Section framing updated");
	return true;
}

function startSectionAtByte(messageId, position) {
	const c = capture();
	const message = c?.messages.find(item => item.id === messageId);
	if (!message) return;
	const start = message._rawPositions?.[position];
	if (!Number.isInteger(start)) return;
	c.previewMode = "sections";
	normalizeSections(c);
	if (c.frameSections.some(section => section.start === start)) {
		render();
		showToast(
			start === 0 ? "The first raw byte already begins section 01" : `Raw byte ${start + 1} already begins a section`
		);
		return;
	}
	const preceding = [...c.frameSections].reverse().find(section => section.start < start);
	c.frameSections.push({
		id: crypto.randomUUID(),
		start,
		frameSize: preceding?.frameSize || c.frameSize,
		collapseRuns: preceding?.collapseRuns || false
	});
	normalizeSections(c);
	rebuildPreview(c);
	saveState();
	render();
	showToast(`Section begins at raw byte ${start + 1}`);
}

function setSectionFrameSize(sectionId, value) {
	const c = capture();
	const section = c?.frameSections.find(item => item.id === sectionId);
	if (!section) return;
	section.frameSize = Math.max(1, Math.min(1024, Math.floor(+value || section.frameSize)));
	rebuildPreview(c);
	saveState();
	render();
	showToast(`Section message length set to ${section.frameSize} bytes`);
}

function setSectionCollapse(sectionId, collapseRuns) {
	const c = capture();
	const section = c?.frameSections.find(item => item.id === sectionId);
	if (!section) return;
	section.collapseRuns = collapseRuns;
	saveState();
	renderMessages();
	showToast(collapseRuns ? "Runs collapse in this section" : "Runs expand in this section");
}

function commitContextDraft(input) {
	const values = contextDraftToValues(input.draft);
	if (input.mode === "new") {
		const c = normalizeCapture({
			id: crypto.randomUUID(),
			...values,
			createdAt: new Date().toISOString(),
			messages: [],
			byteStream: [],
			notes: [],
			annotations: {}
		});
		state.captures.unshift(c);
		activeId = c.id;
	} else {
		const c = state.captures.find(item => String(item.id) === String(input.captureId)) || capture();
		if (!c) return false;
		Object.assign(c, values);
	}
	saveState();
	render();
	showToast("Capture context saved");
	return true;
}

function publishAnnotationDialog(type, key) {
	const c = capture();
	if (!c) return;
	const details = annotationTargetLabel(c, type, key);
	if (!details) return;
	const [messageId, positionText] = key.split(":");
	const message = c.messages.find(item => item.id === messageId);
	if (!message) return;
	const position = positionText === undefined ? null : +positionText;
	const existing = c.annotations[details.targetKey];
	const target =
		type === "byte"
			? `${formatTime(message.byteTimestamps?.[position] ?? message.timestamp)}  ·  ${signature(message)}  ·  BYTE ${details.displayPosition + 1} = ${hexByte(message.bytes[position])}`
			: `${formatTime(message.timestamp)}  ·  ${signature(message)}`;
	publishDialogCommand({
		type: "annotation",
		captureId: String(c.id),
		annotationType: type,
		key,
		title: details.title,
		target,
		text: String(existing?.text || ""),
		hasExisting: Boolean(existing)
	});
}

function commitAnnotationDraft(input) {
	if (!annotationTextIsValid(input.text)) return false;
	const c = state.captures.find(item => String(item.id) === String(input.captureId));
	if (!c) return false;
	const details = annotationTargetLabel(c, input.annotationType, input.key);
	if (!details) return false;
	const [messageId] = input.key.split(":");
	const message = c.messages.find(item => item.id === messageId);
	if (!message) return false;
	c.annotations[details.targetKey] = {
		text: normalizeAnnotationText(input.text),
		createdAt: Date.now(),
		type: input.annotationType,
		targetLabel:
			input.annotationType === "byte"
				? `${signature(message)} · byte ${details.displayPosition + 1}`
				: signature(message)
	};
	saveState();
	render();
	showToast("Annotation saved");
	return true;
}

function removeAnnotationDraft(input) {
	const c = state.captures.find(item => String(item.id) === String(input.captureId));
	if (!c) return;
	const details = annotationTargetLabel(c, input.annotationType, input.key);
	if (!details) return;
	delete c.annotations[details.targetKey];
	saveState();
	render();
	showToast("Annotation removed");
}

function publishPatternRemarkDialog(id) {
	const c = capture();
	const patterns = virtualMessageView?.patterns || recognizeMessagePatterns(c);
	const group = patterns.groups.find(item => item.id === id);
	if (!group || !c) return showToast("This sequence is no longer present in the current framing");
	const text = String(c.patternRemarks?.[group.key]?.text || "");
	publishDialogCommand({
		type: "pattern-remark",
		captureId: String(c.id),
		patternKey: group.key,
		title: `${group.length}-message sequence · ${group.starts.length} occurrences`,
		signatures: group.signatures,
		color: group.color,
		text,
		hasExisting: Boolean(text)
	});
}

function commitPatternRemarkDraft(input) {
	const c = state.captures.find(item => String(item.id) === String(input.captureId));
	if (!c) return false;
	const text = normalizePatternRemarkText(input.text);
	c.patternRemarks ||= {};
	if (text) c.patternRemarks[input.patternKey] = { text, updatedAt: Date.now() };
	else delete c.patternRemarks[input.patternKey];
	saveState();
	renderMessages();
	showToast(text ? "Sequence note saved" : "Sequence note removed");
	return true;
}

async function connectSerial() {
	if (!("serial" in navigator)) {
		showToast("Web Serial requires Chrome or Edge on localhost");
		return;
	}
	if (port) {
		await disconnectSerial();
		return;
	}
	try {
		port = await navigator.serial.requestPort();
		const baudRate = capture()?.baudRate || state.sendSettings.baudRate || 115200;
		await port.open({ baudRate });
		state.sendSettings.baudRate = baudRate;
		saveState();
		$("#connectionBadge").innerHTML = "<i></i> Port connected";
		$("#connectionBadge").classList.add("connected");
		$("#connectBtn").textContent = "Disconnect";
		$("#recordBtn").disabled = !capture();
		readAbort = false;
		readSerialLoop();
		publishSendState();
	} catch (error) {
		port = null;
		showToast(error.name === "NotFoundError" ? "No serial port selected" : `Serial error: ${error.message}`);
	}
}

async function disconnectSerial() {
	flushLiveBytes();
	recording = false;
	recordingSessionId = null;
	saveState({ immediate: true });
	readAbort = true;
	stopQueueRequested = true;
	queueDelayResolve?.();
	try {
		await reader?.cancel();
		reader?.releaseLock();
		await port?.close();
	} catch {}
	reader = null;
	port = null;
	$("#connectionBadge").innerHTML = "<i></i> Disconnected";
	$("#connectionBadge").classList.remove("connected");
	$("#connectBtn").textContent = "Connect port";
	$("#recordBtn").disabled = true;
	$("#recordBtn").classList.remove("recording");
	$("#recordBtn").innerHTML = "<span></span> Start capture";
	publishCaptureHeaderState();
	publishSendState();
}

async function readSerialLoop() {
	while (port?.readable && !readAbort) {
		reader = port.readable.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (recording && value) ingestChunk(value);
			}
		} catch (error) {
			if (!readAbort) showToast(`Read error: ${error.message}`);
		} finally {
			try {
				reader.releaseLock();
			} catch {}
			reader = null;
		}
	}
}

function queueLiveBytes(bytes, direction) {
	const timestamp = performance.timeOrigin + performance.now();
	for (const value of bytes) pendingLiveBytes.push({ value, timestamp, direction, sessionId: recordingSessionId || undefined });
	if (!liveRefreshTimer) liveRefreshTimer = setTimeout(flushLiveBytes, LIVE_REFRESH_MS);
}

function trimCapture(c) {
	const excess = c.byteStream.length - MAX_CAPTURE_BYTES;
	if (excess <= 0) return false;
	const firstRollover = !c.rollingBuffer;
	c.rollingBuffer = true;
	c.byteStream.splice(0, excess);
	c.frameSections = (c.frameSections || [])
		.filter(section => section.start >= excess)
		.map(section => ({ ...section, start: section.start - excess }));
	// Message IDs are derived from stream positions, so old message-specific notes
	// cannot safely be attached after the oldest portion rolls off.
	c.annotations = {};
	c.notes = (c.notes || []).filter(note => note.type !== "sequence");
	return firstRollover;
}

function flushLiveBytes() {
	liveRefreshTimer = null;
	if (!pendingLiveBytes.length) return;
	const c = capture();
	if (!c) {
		pendingLiveBytes = [];
		return;
	}
	const sessionsById = new Map((c.captureSessions || []).map(session => [session.id, session]));
	for (const record of pendingLiveBytes) {
		c.byteStream.push(record);
		if (record.direction !== "tx") recordReceivedByte(sessionsById.get(record.sessionId), record.timestamp);
	}
	pendingLiveBytes = [];
	const trimmed = trimCapture(c);
	rebuildPreview(c);
	saveState();
	publishCaptureHeaderState();
	publishFramingToolbarState(c);
	renderMessages();
	if (getViewStateSnapshot().activePanel === "patterns") publishAnalysisState(c);
	if (trimmed) publishNotesState(c);
	if (trimmed) showToast(`Capture limit reached; keeping the newest ${MAX_CAPTURE_BYTES.toLocaleString()} bytes`);
}

function ingestChunk(bytes) {
	queueLiveBytes(bytes, "rx");
}

function recordSend(bytes, { origin, ok, error = "" }) {
	const entry = {
		id: crypto.randomUUID(),
		timestamp: Date.now(),
		bytes: [...bytes],
		origin,
		ok,
		error,
		captureId: ok && recording ? capture()?.id || null : null
	};
	state.sendHistory.unshift(entry);
	state.sendHistory = state.sendHistory.slice(0, MAX_SEND_HISTORY);
	saveState({ immediate: true });
}

async function transmitBytes(bytes, origin = "manual") {
	if (!bytes?.length) return false;
	if (!port?.writable) {
		showToast("Connect a writable serial port first");
		return false;
	}
	if (sendInFlight) {
		showToast("A message is already being sent");
		return false;
	}
	sendInFlight = true;
	publishSendState();
	try {
		const writer = port.writable.getWriter();
		try {
			await writer.write(bytes);
		} finally {
			writer.releaseLock();
		}
		if (recording && capture()) queueLiveBytes(bytes, "tx");
		recordSend(bytes, { origin, ok: true });
		showToast(`${bytes.length} byte${bytes.length === 1 ? "" : "s"} sent to RS-485`);
		return true;
	} catch (error) {
		recordSend(bytes, { origin, ok: false, error: error.message });
		showToast(`Send failed: ${error.message}`);
		return false;
	} finally {
		sendInFlight = false;
		publishSendState();
	}
}

async function sendBytes(bytes) {
	if (!bytes?.length) return false;
	const sent = await transmitBytes(Uint8Array.from(bytes), "manual");
	if (!sent) return false;
	state.sendSettings.draft = "";
	saveState();
	publishSendState();
	return true;
}

function addDraftToQueue(bytes) {
	if (!bytes?.length) return false;
	state.sendQueue.push({
		id: crypto.randomUUID(),
		bytes: [...bytes],
		createdAt: Date.now()
	});
	state.sendSettings.draft = "";
	saveState();
	publishSendState();
	showToast("Message added to transmit queue");
	return true;
}

function setSendDraft(value) {
	state.sendSettings.draft = String(value);
	saveState();
	publishSendState();
}

function setQueueDelay(value) {
	state.sendSettings.delayMs = Math.max(0, Math.min(600_000, Number(value) || 0));
	saveState({ immediate: true });
	publishSendState();
}

function sendQueueItem(id) {
	const item = state.sendQueue.find(entry => entry.id === id);
	if (item) void transmitBytes(Uint8Array.from(item.bytes), "manual");
}

function removeQueueItem(id) {
	state.sendQueue = state.sendQueue.filter(item => item.id !== id);
	saveState();
	publishSendState();
}

function loadHistoryItem(id) {
	const item = state.sendHistory.find(entry => entry.id === id);
	if (!item) return null;
	const draft = item.bytes.map(hexByte).join(" ");
	state.sendSettings.draft = draft;
	saveState();
	publishSendState();
	return draft;
}

function replayHistoryItem(id) {
	const item = state.sendHistory.find(entry => entry.id === id);
	if (item) void transmitBytes(Uint8Array.from(item.bytes), "replay");
}

function stopSendQueue() {
	stopQueueRequested = true;
	queueDelayResolve?.();
	publishSendState();
}

function clearSendQueue() {
	if (!state.sendQueue.length || queueRunning) return;
	if (!confirm("Clear every message from the transmit queue?")) return;
	state.sendQueue = [];
	saveState({ immediate: true });
	publishSendState();
}

function clearSendHistory() {
	if (!state.sendHistory.length) return;
	if (!confirm("Clear the separate local send history? Captured TX bytes will remain in captures.")) return;
	state.sendHistory = [];
	saveState({ immediate: true });
	publishSendState();
}

function waitForQueueDelay(ms) {
	return new Promise(resolve => {
		const finish = () => {
			if (queueDelayTimer) clearTimeout(queueDelayTimer);
			queueDelayTimer = null;
			queueDelayResolve = null;
			resolve();
		};
		queueDelayResolve = finish;
		queueDelayTimer = setTimeout(finish, ms);
	});
}

async function runSendQueue() {
	if (queueRunning || sendInFlight || !port?.writable || !state.sendQueue.length) return;
	queueRunning = true;
	stopQueueRequested = false;
	publishSendState();
	const queued = [...state.sendQueue];
	let completed = 0;
	try {
		for (let index = 0; index < queued.length; index++) {
			if (stopQueueRequested || !port?.writable) break;
			const sent = await transmitBytes(Uint8Array.from(queued[index].bytes), "queue");
			if (!sent) break;
			completed++;
			state.sendQueue = state.sendQueue.filter(item => item.id !== queued[index].id);
			saveState({ immediate: true });
			publishSendState();
			if (index < queued.length - 1 && !stopQueueRequested) await waitForQueueDelay(state.sendSettings.delayMs);
		}
	} finally {
		queueRunning = false;
		stopQueueRequested = false;
		publishSendState();
		if (completed) showToast(`Queue sent ${completed} message${completed === 1 ? "" : "s"}`);
	}
}

function toggleRecording() {
	const c = capture();
	if (!c) return showToast("Create a capture before starting capture");
	if (recording) {
		flushLiveBytes();
		recording = false;
		recordingSessionId = null;
		saveState({ immediate: true });
	} else {
		const session = { id: crypto.randomUUID() };
		c.captureSessions ||= [];
		c.captureSessions.push(session);
		recordingSessionId = session.id;
		recording = true;
		saveState();
	}
	$("#recordBtn").classList.toggle("recording", recording);
	$("#recordBtn").innerHTML = recording ? "<span></span> Stop capture" : "<span></span> Start capture";
	publishCaptureHeaderState();
	publishSendState();
	showToast(recording ? "Capture started" : "Capture saved locally");
}

function parseDump(text) {
	const sections = text
		.split(/\n\s*----+\s*\n/)
		.map(s => s.trim())
		.filter(s => /View\s*:/i.test(s));
	return sections
		.map((section, index) => {
			const lines = section.split(/\r?\n/);
			const view =
				lines
					.find(l => /^View\s*:/i.test(l))
					?.split(":")
					.slice(1)
					.join(":")
					.trim() || "Imported";
			const params = [];
			for (const line of lines) {
				if (/^\d{2}:\d{2}:\d{2}/.test(line) || /^View\s*:/i.test(line) || /^\(/.test(line) || /^\.{3}/.test(line))
					continue;
				const m = line.match(/^([^:]+):\s*(.+)$/);
				if (m) params.push({ key: m[1].trim(), value: m[2].trim() });
			}
			const messages = [];
			lines.forEach(line => {
				const tm = line.match(/^(\d{2}:\d{2}:\d{2}[.:]\d{3})\s*->\s*((?:[0-9A-F]{2}\s*)+)/i);
				if (tm) messages.push(makeMessage(tm[2], parseTime(tm[1]), messages.length));
			});
			return {
				id: crypto.randomUUID(),
				name: `${view} · imported ${index + 1}`,
				view,
				params,
				createdAt: new Date().toISOString(),
				frameSize: 3,
				baudRate: 115200,
				inputFormat: "text",
				messages,
				notes: [],
				annotations: {}
			};
		})
		.filter(c => c.messages.length);
}

async function importFile(file) {
	try {
		const text = await file.text();
		if (file.name.toLowerCase().endsWith(".json")) {
			const imported = JSON.parse(text);
			const captures = Array.isArray(imported) ? imported : imported.captures;
			if (!Array.isArray(captures)) throw new Error("No captures found");
			const importedFolders = Array.isArray(imported?.folders) ? imported.folders : [];
			const folderIdMap = new Map();
			const existingFolderNames = new Map(state.folders.map(folder => [folder.name.toLowerCase(), folder.id]));
			const existingCaptureIds = new Set(state.captures.map(capture => capture.id));
			importedFolders.forEach(sourceFolder => {
				const name = String(sourceFolder?.name || "Imported folder").trim() || "Imported folder";
				let id = existingFolderNames.get(name.toLowerCase());
				if (!id) {
					id = crypto.randomUUID();
					state.folders.push({
						id,
						name,
						collapsed: Boolean(sourceFolder?.collapsed),
						createdAt: sourceFolder?.createdAt || new Date().toISOString()
					});
					existingFolderNames.set(name.toLowerCase(), id);
				}
				if (sourceFolder?.id) folderIdMap.set(sourceFolder.id, id);
			});
			captures.forEach(c => {
				if (!c.id || existingCaptureIds.has(c.id)) c.id = crypto.randomUUID();
				existingCaptureIds.add(c.id);
				c.folderId = folderIdMap.get(c.folderId) || null;
				normalizeCapture(c);
				rebuildPreview(c);
				c.messages.forEach(m => (m.id ||= crypto.randomUUID()));
			});
			state.captures.unshift(...captures);
			if (!Array.isArray(imported) && Array.isArray(imported.sendHistory)) {
				state.sendHistory = [...imported.sendHistory, ...state.sendHistory];
			}
			if (!Array.isArray(imported) && Array.isArray(imported.sendQueue)) {
				state.sendQueue = [...state.sendQueue, ...imported.sendQueue];
			}
			if (!Array.isArray(imported) && imported.sendSettings) {
				state.sendSettings = { ...state.sendSettings, ...imported.sendSettings, draft: state.sendSettings.draft };
			}
			normalizeSendState(state);
			activeId = captures[0]?.id || activeId;
		} else {
			const captures = parseDump(text);
			if (!captures.length) throw new Error("No timestamped hex messages found");
			captures.forEach(c => {
				normalizeCapture(c);
				rebuildPreview(c);
			});
			state.captures.unshift(...captures);
			activeId = captures[0].id;
		}
		saveState();
		render();
		showToast(`Imported ${file.name}`);
	} catch (error) {
		showToast(`Import failed: ${error.message}`);
	}
}

function download(content, filename, type) {
	const url = URL.createObjectURL(new Blob([content], { type }));
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportData(format) {
	const c = capture();
	const safeName = c.name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
	if (format === "json") {
		download(
			JSON.stringify(
				{
					app: "Bus Lens",
					version: 3,
					exportedAt: new Date().toISOString(),
					folders: state.folders,
					captures: state.captures,
					sendHistory: state.sendHistory,
					sendQueue: state.sendQueue,
					sendSettings: { ...state.sendSettings, draft: "" }
				},
				null,
				2
			),
			"bus-lens-archive.json",
			"application/json"
		);
	} else if (format === "csv") {
		const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
		const width = frameWidth(c);
		const byteHeaders = Array.from({ length: width }, (_, i) => [`byte_${i + 1}_hex`, `byte_${i + 1}_timestamp`]).flat();
		const patterns = recognizeMessagePatterns(c);
		const header = [
			"index",
			"timestamp",
			"delta_ms",
			...byteHeaders,
			"message_hex",
			"message_note",
			"sequence_group",
			"sequence_remark"
		];
		const rows = c.messages.map((m, i) => {
			const pattern = patterns.membership.get(i)?.group;
			const visibleBytes = visibleByteEntries(m);
			const byteCells = Array.from({ length: width }, (_, position) =>
				visibleBytes[position] === undefined
					? ["", ""]
					: [
						hexByte(visibleBytes[position].value),
						new Date(m.byteTimestamps?.[visibleBytes[position].rawPosition] ?? m.timestamp).toISOString()
					  ]
			).flat();
			return [
				i + 1,
				new Date(m.timestamp).toISOString(),
				i ? m.timestamp - c.messages[i - 1].timestamp : "",
				...byteCells,
				signature(m),
				c.annotations[m.id]?.text || "",
				pattern?.id || "",
				pattern?.remark || ""
			]
				.map(quote)
				.join(",");
		});
		download([header.join(","), ...rows].join("\n"), `${safeName}.csv`, "text/csv");
	} else {
		const patterns = recognizeMessagePatterns(c);
		const patternLines = patterns.groups
			.filter(group => group.remark)
			.map(
				group =>
					`# Repeated sequence (${group.length} messages, ${group.starts.length} occurrences): ${group.remark}\n#   ${group.signatures.join(" -> ")}`
			);
		const noteLines = (c.notes || []).map(
			n => `# ${n.type === "sequence" ? `Rows ${n.start}-${n.end}` : "Capture"}: ${n.text}`
		);
		const context = [
			`----`,
			`View: ${c.view}`,
			...c.params.map(p => `${p.key}: ${p.value}`),
			...noteLines,
			...patternLines,
			"",
			...c.messages.map(
				m =>
					`${formatTime(m.timestamp)} -> ${signature(m)}${c.annotations[m.id] ? `  <-- ${c.annotations[m.id].text}` : ""}`
			),
			"",
			"----"
		].join("\n");
		download(context, `${safeName}.txt`, "text/plain");
	}
	showToast(`${format.toUpperCase()} export created`);
}

$("#connectBtn").onclick = connectSerial;
$("#recordBtn").onclick = toggleRecording;
let previousViewState = getViewStateSnapshot();
subscribeToViewState(() => {
	const nextViewState = getViewStateSnapshot();
	const renderChanged =
		nextViewState.filterQuery !== previousViewState.filterQuery ||
		nextViewState.displayMode !== previousViewState.displayMode ||
		nextViewState.showFrameChanges !== previousViewState.showFrameChanges ||
		nextViewState.collapseRuns !== previousViewState.collapseRuns;
	if (nextViewState.filterQuery !== previousViewState.filterQuery) $(".table-wrap").scrollTop = 0;
	if (renderChanged && capture()) renderMessages();
	if (nextViewState.activePanel === "patterns" && previousViewState.activePanel !== "patterns") {
		publishAnalysisState();
	}
	previousViewState = nextViewState;
});

$("#messageBody").addEventListener("click", event => {
	const noteButton = event.target.closest("[data-message-note]");
	if (noteButton) return publishAnnotationDialog("message", noteButton.dataset.messageNote);
	const replayButton = event.target.closest("[data-message-replay]");
	if (replayButton) {
		const message = capture().messages.find(item => item.id === replayButton.dataset.messageReplay);
		if (message) void transmitBytes(Uint8Array.from(visibleByteEntries(message).map(({ value }) => value)), "replay");
		return;
	}
	const patternButton = event.target.closest("[data-pattern-id]");
	if (patternButton) return publishPatternRemarkDialog(patternButton.dataset.patternId);
	const byteButton = event.target.closest("[data-byte-note]");
	if (byteButton) publishAnnotationDialog("byte", byteButton.dataset.byteNote);
});
$("#messageBody").addEventListener("contextmenu", openMessageContextMenu);
$("#messageContextMenu").addEventListener("click", event => {
	const actionButton = event.target.closest("[data-context-action]");
	if (actionButton) handleMessageContextAction(actionButton.dataset.contextAction);
});
$("#messageBody").addEventListener("change", event => {
	const lengthInput = event.target.closest("[data-section-length]");
	if (lengthInput) return setSectionFrameSize(lengthInput.dataset.sectionLength, lengthInput.value);
	const collapseInput = event.target.closest("[data-section-collapse]");
	if (collapseInput) setSectionCollapse(collapseInput.dataset.sectionCollapse, collapseInput.checked);
});
document.addEventListener("click", e => {
	if (!e.target.closest("#messageContextMenu")) closeMessageContextMenu();
});
document.addEventListener("contextmenu", event => {
	if (!event.target.closest("#messageBody")) closeMessageContextMenu();
});
document.addEventListener("keydown", event => {
	if (event.key === "Escape") closeMessageContextMenu({ restoreFocus: true });
});
window.addEventListener("resize", () => closeMessageContextMenu());
$(".table-wrap").addEventListener("scroll", () => closeMessageContextMenu(), { passive: true });
window.addEventListener("beforeunload", () => {
	disposeMessageVirtualizer?.();
	flushLiveBytes();
	persistState();
	if (port) disconnectSerial();
});

registerCaptureHeaderActions({
	setTitle: setCaptureTitle,
	commitTitle: commitCaptureTitle,
	setDescription: setCaptureDescription,
	commitDescription: commitCaptureDescription,
	openContext: () => {
		if (capture()) publishContextDialog(false);
	},
	duplicate: duplicateActiveCapture,
	clearMessages: clearActiveCaptureMessages,
	deleteCapture: deleteActiveCapture
});

registerArchiveActions({
	selectCapture: selectArchiveCapture,
	toggleFolder: toggleArchiveFolder,
	moveCapture: moveArchiveCapture,
	openNewCapture: () => publishContextDialog(true),
	openImport: () => $("#fileInput").click(),
	openExport: () => publishDialogCommand({ type: "export" }),
	saveFolder,
	deleteFolder,
	importFile
});

registerFramingToolbarActions({
	updateSettings: updateFramingSettings,
	openSections: publishSectionsDialog
});

registerDialogActions({
	saveContext: commitContextDraft,
	saveSections: commitSectionsDraft,
	saveAnnotation: commitAnnotationDraft,
	deleteAnnotation: removeAnnotationDraft,
	savePatternRemark: commitPatternRemarkDraft,
	exportData,
	notify: showToast
});

registerSendActions({
	setDraft: setSendDraft,
	setDelay: setQueueDelay,
	send: sendBytes,
	addToQueue: addDraftToQueue,
	sendQueueItem,
	removeQueueItem,
	loadHistory: loadHistoryItem,
	replayHistory: replayHistoryItem,
	runQueue: runSendQueue,
	stopQueue: stopSendQueue,
	clearQueue: clearSendQueue,
	clearHistory: clearSendHistory
});

registerNotesActions({ addSequenceNote });

render();

export {};

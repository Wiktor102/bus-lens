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
import { collapseAdjacentRuns, countVisibleRowsByPatternOccurrence } from "./collapse-runs";
import {
	countDistinctMessageSignatures,
	countReceivedRawBytes,
	normalizeCaptureSummaryData,
	normalizeDescription,
	recordReceivedByte,
	sumRecordingSessionDurations
} from "./capture-summary";

const STORAGE_KEY = "bus-lens-state-v1";
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const BYTE_COLORS = [
	"#79D8E7",
	"#CBF45A",
	"#F2B84B",
	"#B99AF7",
	"#FF8178",
	"#69D5A5",
	"#7DA9FF",
	"#E48AC2",
	"#5BD6C8",
	"#F08C62",
	"#A8B7FF",
	"#E76F7B"
];
const TRANSITION_COLORS = ["#36C8E8", "#9E65F4", "#F39C4A", "#E35D91", "#5A8FFF", "#49C88A"];
const PATTERN_COLORS = [
	"#42D9C8",
	"#B6E94A",
	"#FFB44C",
	"#B58AF4",
	"#F7788A",
	"#66A3FF",
	"#E987D0",
	"#72D28D",
	"#F08B5D",
	"#A6B2FF"
];
const MIN_PATTERN_LENGTH = 2;
const MAX_PATTERN_LENGTH = 8;
// A capture remains useful at this size while still fitting comfortably in browser storage.
const MAX_CAPTURE_BYTES = 50_000;
const LIVE_REFRESH_MS = 120;
const VIRTUAL_ROW_HEIGHT = 41;
const VIRTUAL_SECTION_HEIGHT = 48;
const VIRTUAL_OVERSCAN = 8;
const MAX_SEND_HISTORY = 250;

const demoCaptures = [
	{
		id: crypto.randomUUID(),
		name: "Overview · Speed 1",
		view: "Overview",
		params: [
			{ key: "Speed", value: "1" },
			{ key: "Mode", value: "auto / program 1" }
		],
		createdAt: "2026-07-28T12:39:07.009Z",
		frameSize: 3,
		baudRate: 115200,
		inputFormat: "text",
		messages: [
			["12:39:07.009", "C2 08 5D"],
			["12:39:07.088", "C2 08 5D"],
			["12:39:07.182", "C2 00 5D"],
			["12:39:07.222", "C2 08 5D"],
			["12:39:07.341", "C2 08 5D"],
			["12:39:07.387", "C2 00 5D"],
			["12:39:07.481", "C2 08 5D"],
			["12:39:07.528", "C2 08 5D"],
			["12:39:07.605", "C2 00 5D"],
			["12:39:07.648", "C2 08 5D"],
			["12:39:07.747", "C2 08 5D"],
			["12:39:07.790", "C2 08 5D"],
			["12:39:08.167", "C2 00 5D"],
			["12:39:09.844", "C2 08 4D"],
			["12:49:49.917", "3B D6 FC"],
			["12:49:49.960", "C2 88 5D"],
			["12:49:50.039", "C2 80 5D"],
			["12:49:50.133", "C2 88 5D"],
			["12:49:50.177", "C2 88 4D"],
			["12:49:50.244", "C2 80 5D"]
		].map(([time, hex], i) => makeMessage(hex, parseTime(time), i)),
		notes: [
			{
				id: crypto.randomUUID(),
				type: "capture",
				text: "FC appears once immediately after returning to the Overview view; investigate as a possible screen transition marker.",
				createdAt: Date.now()
			}
		],
		annotations: {}
	},
	{
		id: crypto.randomUUID(),
		name: "Speed · 1 → 2",
		view: "Speed",
		params: [
			{ key: "Speed", value: "1 → 2" },
			{ key: "Ventilation type", value: "full" }
		],
		createdAt: "2026-07-28T12:57:39.091Z",
		frameSize: 3,
		baudRate: 115200,
		inputFormat: "text",
		messages: [
			["12:57:39.091", "42 3A 9C"],
			["12:57:39.160", "42 3A DC"],
			["12:57:39.250", "4A 3A DC"],
			["12:57:39.344", "42 3A DC"],
			["12:57:39.390", "4A 3A DC"],
			["12:57:39.470", "42 3A DC"],
			["12:57:39.516", "42 E1 9C"],
			["12:57:39.628", "4A E1 9C"],
			["12:57:39.674", "42 E9 9C"],
			["12:57:39.769", "42 E1 9C"],
			["12:57:39.814", "4A E1 9C"],
			["12:57:39.894", "4A E9 9C"],
			["12:57:39.939", "4A E1 8C"],
			["12:57:40.010", "42 E9 8C"],
			["12:57:40.098", "42 E1 9C"]
		].map(([time, hex], i) => makeMessage(hex, parseTime(time), i)),
		notes: [],
		annotations: {}
	}
];

let state = loadState();
let activeId = state.activeId || state.captures[0]?.id;
let port = null;
let reader = null;
let recording = false;
let recordingSessionId = null;
let readAbort = false;
let annotationTarget = null;
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
let patternRemarkTarget = null;
const patternRecognitionCache = new WeakMap();

function makeMessage(hex, timestamp = Date.now(), index = 0) {
	const bytes = typeof hex === "string" ? (hex.match(/[0-9a-f]{2}/gi) || []).map(v => parseInt(v, 16)) : [...hex];
	return {
		id: crypto.randomUUID(),
		timestamp,
		byteTimestamps: bytes.map(() => timestamp),
		bytes,
		hidden: false,
		hiddenBytes: bytes.map(() => false),
		sourceIndex: index
	};
}

function parseTime(value) {
	const match = value.match(/(\d{2}):(\d{2}):(\d{2})[.:](\d{3})/);
	if (!match) return Date.now();
	const d = new Date();
	d.setHours(+match[1], +match[2], +match[3], +match[4]);
	return d.getTime();
}

function loadState() {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
		if (Array.isArray(saved?.captures)) {
			normalizeArchiveState(saved);
			saved.captures.forEach(normalizeCapture);
			saved.captures.forEach(capture => rebuildPreview(capture));
			normalizeSendState(saved);
			return saved;
		}
	} catch {}
	demoCaptures.forEach(normalizeCapture);
	demoCaptures.forEach(capture => rebuildPreview(capture));
	const initial = { captures: demoCaptures, folders: [], activeId: demoCaptures[0].id };
	normalizeSendState(initial);
	return initial;
}

function normalizeSendState(target = state) {
	target.sendHistory = Array.isArray(target.sendHistory)
		? target.sendHistory
				.filter(item => Array.isArray(item.bytes) && item.bytes.length)
				.slice(0, MAX_SEND_HISTORY)
		: [];
	target.sendQueue = Array.isArray(target.sendQueue)
		? target.sendQueue
				.filter(item => Array.isArray(item.bytes) && item.bytes.length)
				.map(item => ({
					id: item.id || crypto.randomUUID(),
					bytes: item.bytes.map(Number),
					createdAt: item.createdAt || Date.now()
				}))
		: [];
	const savedDelay = Number(target.sendSettings?.delayMs);
	target.sendSettings = {
		delayMs: Number.isFinite(savedDelay) ? Math.max(0, Math.min(600_000, savedDelay)) : 100,
		draft: String(target.sendSettings?.draft || ""),
		baudRate: Math.max(300, +target.sendSettings?.baudRate || 115200)
	};
}

function normalizeArchiveState(archive) {
	archive.folders = Array.isArray(archive.folders) ? archive.folders : [];
	const seen = new Set();
	archive.folders = archive.folders
		.filter(folder => folder && typeof folder === "object")
		.map(folder => ({
			id: String(folder.id || crypto.randomUUID()),
			name: String(folder.name || "Untitled folder").trim() || "Untitled folder",
			collapsed: Boolean(folder.collapsed),
			createdAt: folder.createdAt || new Date().toISOString()
		}))
		.filter(folder => {
			if (seen.has(folder.id)) return false;
			seen.add(folder.id);
			return true;
		});
	archive.captures.forEach(item => {
		item.folderId = seen.has(item.folderId) ? item.folderId : null;
	});
}

function normalizeCapture(c) {
	c.params ||= [];
	c.notes ||= [];
	c.annotations ||= {};
	c.patternRemarks ||= {};
	c.messages ||= [];
	c.messages.forEach(message => {
		message.hidden = Boolean(message.hidden);
		message.hiddenBytes = Array.isArray(message.hiddenBytes)
			? message.bytes.map((_, index) => Boolean(message.hiddenBytes[index]))
			: message.bytes.map(() => false);
	});
	c.notes.forEach(note => (note.id ||= crypto.randomUUID()));
	c.previewMode ||= "length";
	c.frameSize = Math.max(1, +c.frameSize || 3);
	if (c.markerConfigured === undefined) {
		// 0A was the old UI default, not a marker the user necessarily chose.
		c.markerConfigured = Boolean(c.frameMarker && c.frameMarker !== "0A");
	}
	c.frameMarker = c.markerConfigured ? String(c.frameMarker || "") : "";
	c.markerPosition ||= "start";
	c.frameTimeGap = Math.max(0.01, +c.frameTimeGap || 5);
	if (!Array.isArray(c.byteStream)) {
		c.byteStream = c.messages.flatMap(message =>
			message.bytes.map((value, index) => ({
				value,
				timestamp: message.byteTimestamps?.[index] ?? message.timestamp,
				hidden: Boolean(message.hiddenBytes?.[index])
			}))
		);
	}
	c.byteStream.forEach(record => {
		record.direction ||= "rx";
		record.hidden = Boolean(record.hidden);
	});
	// Older exports stored byte visibility on framed messages rather than raw
	// byte records. Copy it across before the preview is rebuilt.
	c.messages.forEach(message => {
		if (!Number.isInteger(message._byteStart) && !Array.isArray(message._rawPositions)) return;
		message.hiddenBytes.forEach((hidden, index) => {
			const rawPosition = message._rawPositions?.[index] ?? message._byteStart + index;
			if (hidden && c.byteStream[rawPosition]) c.byteStream[rawPosition].hidden = true;
		});
	});
	normalizeCaptureSummaryData(c);
	normalizeSections(c);
	c.messages.forEach(message => {
		message.byteTimestamps ||= message.bytes.map(() => message.timestamp);
	});
	return c;
}

function normalizeSections(c) {
	const streamLength = c.byteStream?.length || 0;
	const byStart = new Map();
	(Array.isArray(c.frameSections) ? c.frameSections : []).forEach(section => {
		const start = Math.max(0, Math.min(Math.max(0, streamLength - 1), Math.floor(+section.start || 0)));
		byStart.set(start, {
			id: section.id || crypto.randomUUID(),
			start,
			frameSize: Math.max(1, Math.min(1024, Math.floor(+section.frameSize || c.frameSize || 3))),
			collapseRuns: Boolean(section.collapseRuns)
		});
	});
	if (!byStart.has(0)) byStart.set(0, { id: crypto.randomUUID(), start: 0, frameSize: c.frameSize, collapseRuns: false });
	c.frameSections = [...byStart.values()].sort((a, b) => a.start - b.start);
}

function frameWidth(c = capture()) {
	return Math.max(0, ...visibleMessages(c).map(message => visibleByteEntries(message).length));
}

function markerBytes(value) {
	return (String(value).match(/[0-9a-f]{2}/gi) || []).map(byte => parseInt(byte, 16));
}

function markerAt(stream, index, marker) {
	return marker.length > 0 && marker.every((value, offset) => stream[index + offset]?.value === value);
}

function rebuildPreview(c = capture()) {
	if (!c) return;
	normalizeCapture(c);
	// A hidden byte is omitted before framing, rather than merely omitted while
	// rendering. This makes every framing mode behave exactly as though the byte
	// was never captured, while byteStream remains available for export/history.
	const stream = c.byteStream
		.map((record, rawPosition) => ({ ...record, rawPosition }))
		.filter(record => !record.hidden);
	const ranges = [];
	if (c.previewMode === "marker") {
		const marker = markerBytes(c.frameMarker);
		if (c.markerPosition === "end") {
			let start = 0;
			let foundMarker = false;
			for (let index = 0; index < stream.length; index++) {
				if (markerAt(stream, index, marker)) {
					foundMarker = true;
					const end = index + marker.length;
					ranges.push([start, end]);
					start = end;
					index = end - 1;
				}
			}
			if (foundMarker && start < stream.length) ranges.push([start, stream.length]);
		} else {
			let start = -1;
			for (let index = 0; index < stream.length; index++) {
				if (!markerAt(stream, index, marker)) continue;
				if (start >= 0 && index > start) ranges.push([start, index]);
				start = index;
				index += marker.length - 1;
			}
			if (start >= 0 && start < stream.length) ranges.push([start, stream.length]);
		}
	} else if (c.previewMode === "time") {
		if (stream.length) {
			let start = 0;
			for (let index = 1; index < stream.length; index++) {
				if (stream[index].timestamp - stream[index - 1].timestamp >= c.frameTimeGap) {
					ranges.push([start, index]);
					start = index;
				}
			}
			ranges.push([start, stream.length]);
		}
	} else if (c.previewMode === "sections") {
		normalizeSections(c);
		c.frameSections.forEach((section, sectionIndex) => {
			// Section starts are persisted as raw positions. Translate them to the
			// compact stream so deleting bytes before a section shifts it naturally.
			const start = stream.findIndex(record => record.rawPosition >= section.start);
			const nextRawStart = c.frameSections[sectionIndex + 1]?.start;
			const nextStart = nextRawStart === undefined ? -1 : stream.findIndex(record => record.rawPosition >= nextRawStart);
			const sectionEnd = nextStart < 0 ? stream.length : nextStart;
			if (start < 0) return;
			for (let offset = start; offset < sectionEnd; offset += section.frameSize) {
				ranges.push([offset, Math.min(offset + section.frameSize, sectionEnd), section.id]);
			}
		});
	} else {
		for (let start = 0; start < stream.length; start += c.frameSize) {
			ranges.push([start, Math.min(start + c.frameSize, stream.length)]);
		}
	}
	const oldMessagesByRange = new Map(
		c.messages.map(message => {
			const rawPositions =
				message._rawPositions ||
				(Number.isInteger(message._byteStart) ? message.bytes.map((_, index) => message._byteStart + index) : []);
			return [rawPositions.join(","), { id: message.id, hidden: Boolean(message.hidden) }];
		})
	);
	c.messages = ranges
		.filter(([start, end]) => end > start)
		.map(([start, end, sectionId], index) => {
			const records = stream.slice(start, end);
			const rawPositions = records.map(record => record.rawPosition);
			const previous = oldMessagesByRange.get(rawPositions.join(","));
			return {
				id: previous?.id || crypto.randomUUID(),
				timestamp: records[0].timestamp,
				byteTimestamps: records.map(record => record.timestamp),
				bytes: records.map(record => record.value),
				directions: records.map(record => record.direction || "rx"),
				hidden: Boolean(previous?.hidden),
				hiddenBytes: records.map(() => false),
				sourceIndex: index,
				sectionId,
				_byteStart: start,
				_byteEnd: end,
				_rawPositions: rawPositions
			};
		});
}

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

function hexByte(byte) {
	return byte.toString(16).padStart(2, "0").toUpperCase();
}
function visibleByteEntries(message) {
	return message.bytes
		.map((value, rawPosition) => ({ value, rawPosition }))
		.filter(({ rawPosition }) => !message.hiddenBytes?.[rawPosition]);
}
function visiblePositionForRawByte(message, rawPosition) {
	return visibleByteEntries(message).findIndex(entry => entry.rawPosition === rawPosition);
}
function signature(message) {
	return visibleByteEntries(message).map(({ value }) => hexByte(value)).join(" ");
}
function hashText(value) {
	let hash = 2166136261;
	for (const char of value) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}
function colorForByte(byte) {
	const paletteIndex = (byte * 13 + (byte >> 4) * 7) % BYTE_COLORS.length;
	return BYTE_COLORS[paletteIndex];
}
function colorForTransition(key) {
	return TRANSITION_COLORS[hashText(key) % TRANSITION_COLORS.length];
}
function colorForPattern(key) {
	return PATTERN_COLORS[hashText(key) % PATTERN_COLORS.length];
}
function escapeHtml(value = "") {
	return String(value).replace(
		/[&<>"']/g,
		ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[ch]
	);
}

function showToast(message) {
	clearTimeout(toastTimer);
	$("#toast").textContent = message;
	$("#toast").classList.add("show");
	toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 2600);
}

function visibleMessages(c = capture()) {
	return (c?.messages || []).filter(message => !message.hidden);
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
		openAnnotation(type, key);
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
	renderSendWorkbench();
	if (!capture()) {
		renderEmptyWorkspace();
		return;
	}
	renderHeader();
	renderMessages();
	renderAnalysis();
	renderNotes();
}

function renderEmptyWorkspace() {
	$("#captureTitle").value = "No captures yet";
	$("#captureTitle").disabled = true;
	$("#captureDescription").value = "";
	sizeCaptureDescription();
	$("#captureDescription").disabled = true;
	$("#captureState").textContent = "EMPTY";
	$("#captureState").classList.remove("live");
	$("#captureMeta").innerHTML = `<span class="meta-chip">Use ＋ to create a capture, or import an existing dump.</span>`;
	$("#editContextBtn").disabled = true;
	$("#moreBtn").disabled = true;
	$("#connectBtn").disabled = false;
	$("#recordBtn").disabled = true;
	$("#statMessages").textContent = "0";
	$("#statUnique").textContent = "0";
	$("#statCaptureLength").textContent = "0 s";
	$("#statCapturedBytes").textContent = "0 B";
	$("#frameSizeLabel").textContent = "—";
	$("#messageBody").innerHTML = "";
	$(".message-table").classList.add("hidden");
	$("#emptyState").classList.remove("hidden");
	$("#emptyState h2").textContent = "No captures in the archive";
	$("#emptyState p").textContent = "Create a capture or import a monitor dump to begin.";
	$("#visibleCount").textContent = "0 rows";
	$("#patternCount").textContent = "0 groups";
	$("#signatureList").innerHTML = `<span class="muted">No capture selected.</span>`;
	$("#vocabulary").innerHTML = "";
	$("#bitMap").innerHTML = "";
	$("#transitionList").innerHTML = `<span class="muted">No capture selected.</span>`;
	$("#notesList").innerHTML = `<p class="muted">No capture selected.</p>`;
	$("#notesCount").textContent = "0";
	$("#collapseControl").classList.remove("hidden");
	["framingMode", "previewFrameSize", "frameMarker", "markerPosition", "frameTimeGap", "editSectionsBtn"].forEach(
		id => ($(`#${id}`).disabled = true)
	);
	updateMessageFilterControl();
}

function parseTransmitHex(value) {
	const compact = value.replace(/[\s,:-]/g, "");
	if (!compact) return { bytes: [], message: "Enter whole bytes as hex." };
	if (!/^[0-9a-f]+$/i.test(compact) || compact.length % 2)
		return { bytes: null, message: "Use complete hex bytes, for example C2 08 5D." };
	return {
		bytes: Uint8Array.from(compact.match(/.{2}/g).map(pair => parseInt(pair, 16))),
		message: `${compact.length / 2} byte${compact.length === 2 ? "" : "s"} ready to send.`
	};
}

function updateTransmitValidity() {
	const input = $("#transmitHex");
	const hint = $("#transmitHint");
	const parsed = parseTransmitHex(input.value);
	const valid = Boolean(parsed.bytes?.length);
	const ready = Boolean(valid && port?.writable && !sendInFlight && !queueRunning);
	hint.textContent = parsed.message;
	hint.classList.toggle("ready", ready);
	hint.classList.toggle("invalid", parsed.bytes === null);
	$("#sendBytesBtn").disabled = !ready;
	$("#addQueueBtn").disabled = !valid || queueRunning;
	return parsed;
}

function renderSendWorkbench() {
	normalizeSendState(state);
	const connected = Boolean(port?.writable);
	const draftInput = $("#transmitHex");
	if (document.activeElement !== draftInput && draftInput.value !== state.sendSettings.draft) {
		draftInput.value = state.sendSettings.draft;
	}
	if (document.activeElement !== $("#queueDelay")) $("#queueDelay").value = state.sendSettings.delayMs;
	$("#sendStatusBadge").classList.toggle("connected", connected);
	$("#sendStatusBadge").classList.toggle("running", queueRunning);
	$("#sendStatusBadge").innerHTML = queueRunning
		? "<i></i> QUEUE RUNNING"
		: connected
			? "<i></i> READY"
			: "<i></i> OFFLINE";
	$("#sendConnectionHint").textContent = connected
		? recording
			? "Sent bytes are recorded as TX in the active capture and in local send history."
			: "Capture is inactive. Sends are kept in the separate local history."
		: "Connect a serial port to send. Drafts and queue stay saved locally.";
	$("#queueCount").textContent = state.sendQueue.length;
	$("#queueTabCount").textContent = state.sendQueue.length;
	$("#queueTabCount").classList.toggle("hidden", !state.sendQueue.length);
	$("#historyCount").textContent = state.sendHistory.length;
	$("#queueList").innerHTML = state.sendQueue.length
		? state.sendQueue
				.map(
					(item, index) => `
      <div class="queue-item">
        <span class="queue-index">${String(index + 1).padStart(2, "0")}</span>
        <code>${item.bytes.map(hexByte).join(" ")}</code>
        <button class="icon-btn" data-queue-send="${item.id}" title="Send this message now" aria-label="Send this message now">▶</button>
        <button class="icon-btn" data-queue-remove="${item.id}" title="Remove from queue" aria-label="Remove from queue">×</button>
      </div>`
				)
				.join("")
		: `<div class="send-empty">Queue messages here, then run them with a controlled gap.</div>`;
	$("#sendHistory").innerHTML = state.sendHistory.length
		? state.sendHistory
				.map(
					item => `
      <div class="history-item ${item.ok === false ? "failed" : ""}">
        <div>
          <code>${item.bytes.map(hexByte).join(" ")}</code>
          <small>${formatTime(item.timestamp)} · ${item.captureId ? "captured TX" : "send history"}${item.origin === "queue" ? " · queued" : ""}${item.ok === false ? ` · failed: ${escapeHtml(item.error || "unknown error")}` : ""}</small>
        </div>
        <button class="text-btn" data-history-load="${item.id}">Load</button>
        <button class="text-btn" data-history-replay="${item.id}" ${connected && !sendInFlight && !queueRunning ? "" : "disabled"}>Replay</button>
      </div>`
				)
				.join("")
		: `<div class="send-empty">Successful and failed sends appear here, including sends made outside a capture.</div>`;
	$$("[data-queue-remove]").forEach(
		button =>
			(button.onclick = () => {
				state.sendQueue = state.sendQueue.filter(item => item.id !== button.dataset.queueRemove);
				saveState();
				renderSendWorkbench();
			})
	);
	$$("[data-queue-send]").forEach(
		button =>
			(button.onclick = () => {
				const item = state.sendQueue.find(entry => entry.id === button.dataset.queueSend);
				if (item) void transmitBytes(Uint8Array.from(item.bytes), "manual");
			})
	);
	$$("[data-history-load]").forEach(
		button =>
			(button.onclick = () => {
				const item = state.sendHistory.find(entry => entry.id === button.dataset.historyLoad);
				if (!item) return;
				state.sendSettings.draft = item.bytes.map(hexByte).join(" ");
				saveState();
				renderSendWorkbench();
				$("#transmitHex").focus();
			})
	);
	$$("[data-history-replay]").forEach(
		button =>
			(button.onclick = () => {
				const item = state.sendHistory.find(entry => entry.id === button.dataset.historyReplay);
				if (item) void transmitBytes(Uint8Array.from(item.bytes), "replay");
			})
	);
	$("#runQueueBtn").disabled = !connected || !state.sendQueue.length || queueRunning || sendInFlight;
	$("#runQueueBtn").classList.toggle("hidden", queueRunning);
	$("#stopQueueBtn").classList.toggle("hidden", !queueRunning);
	$("#stopQueueBtn").disabled = false;
	$("#stopQueueBtn").textContent = "Stop";
	$("#clearQueueBtn").disabled = !state.sendQueue.length || queueRunning;
	$("#clearHistoryBtn").disabled = !state.sendHistory.length;
	updateTransmitValidity();
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

function renderHeader() {
	const c = capture();
	if (!c) return;
	["framingMode", "previewFrameSize", "frameMarker", "markerPosition", "frameTimeGap", "editSectionsBtn"].forEach(
		id => ($(`#${id}`).disabled = false)
	);
	syncPreviewControls(c);
	const titleInput = $("#captureTitle");
	const descriptionInput = $("#captureDescription");
	if (document.activeElement !== titleInput) titleInput.value = c.name;
	if (document.activeElement !== descriptionInput) descriptionInput.value = c.description;
	sizeCaptureDescription();
	titleInput.disabled = false;
	descriptionInput.disabled = false;
	$("#editContextBtn").disabled = false;
	$("#moreBtn").disabled = false;
	$("#connectBtn").disabled = false;
	$("#recordBtn").disabled = !port;
	$("#captureMeta").innerHTML = [
		c.view && `<span class="meta-chip"><b>VIEW</b> ${escapeHtml(c.view)}</span>`,
		...c.params.map(
			p => `<span class="meta-chip"><b>${escapeHtml(p.key.toUpperCase())}</b> ${escapeHtml(p.value)}</span>`
		)
	]
		.filter(Boolean)
		.join("");
	const width = frameWidth(c);
	$("#frameSizeLabel").textContent =
		c.previewMode === "length"
			? `${c.frameSize} BYTE${c.frameSize === 1 ? "" : "S"}`
			: c.previewMode === "sections"
				? `${c.frameSections.length} SECTION${c.frameSections.length === 1 ? "" : "S"} · UP TO ${width} BYTES`
				: c.previewMode === "marker" && !c.frameMarker
					? "MARKER PENDING"
					: `VARIABLE · UP TO ${width} BYTE${width === 1 ? "" : "S"}`;
	$("#captureState").textContent = recording ? "● LIVE" : "SAVED";
	$("#captureState").classList.toggle("live", recording);
	const messages = visibleMessages(c);
	$("#statMessages").textContent = messages.length.toLocaleString();
	$("#statUnique").textContent = countDistinctMessageSignatures(messages).toLocaleString();
	$("#statCaptureLength").textContent = formatCaptureDuration(sumRecordingSessionDurations(c.captureSessions));
	$("#statCapturedBytes").textContent = `${countReceivedRawBytes(c.byteStream).toLocaleString()} B`;
	updateMessageFilterControl();
}

function sizeCaptureDescription() {
	const input = $("#captureDescription");
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 84)}px`;
}

function formatCaptureDuration(milliseconds) {
	if (!milliseconds) return "0 s";
	if (milliseconds >= 3_600_000) return `${Math.floor(milliseconds / 3_600_000)} h ${Math.floor((milliseconds % 3_600_000) / 60_000)} min`;
	if (milliseconds >= 60_000) return `${Math.floor(milliseconds / 60_000)} min ${Math.floor((milliseconds % 60_000) / 1_000)} s`;
	if (milliseconds >= 1_000) return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 0 : 1)} s`;
	return `${Math.round(milliseconds)} ms`;
}

function syncPreviewControls(c = capture()) {
	if (!c) return;
	const markerInput = $("#frameMarker");
	const editingMarker = document.activeElement === markerInput;
	$("#framingMode").value = c.previewMode;
	$("#previewFrameSize").value = c.frameSize;
	if (!editingMarker) markerInput.value = c.frameMarker;
	$("#markerPosition").value = c.markerPosition;
	$("#frameTimeGap").value = c.frameTimeGap;
	$("#frameLengthControl").classList.toggle("hidden", c.previewMode !== "length");
	$("#editSectionsBtn").classList.toggle("hidden", c.previewMode !== "sections");
	$("#markerControls").classList.toggle("hidden", c.previewMode !== "marker");
	$("#timeControls").classList.toggle("hidden", c.previewMode !== "time");
	$("#collapseControl").classList.toggle("hidden", c.previewMode === "sections");
}

function getCounts(messages) {
	const counts = new Map();
	messages.forEach(m => counts.set(signature(m), (counts.get(signature(m)) || 0) + 1));
	return counts;
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
	const query = $("#messageFilter").value.trim().toUpperCase();
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
	if ($("#collapseToggle").checked || c?.previewMode === "sections") {
		rows = collapseAdjacentRuns(
			rows,
			m =>
				c.previewMode === "sections"
					? Boolean(sectionsById.get(m.sectionId)?.collapseRuns)
					: $("#collapseToggle").checked,
			signature
		);
	}
	return rowsWithDelta(rows.map(summarizeRunCadence));
}

function rowsWithDelta(rows) {
	return rows.map((m, i) => ({
		...m,
		_delta: i && m._originalStart === rows[i - 1]._originalEnd + 1 ? m._runStart - rows[i - 1]._runEnd : null
	}));
}

function summarizeRunCadence(message) {
	const intervals = message._runMessages
		.slice(1)
		.map((item, index) => item.timestamp - message._runMessages[index].timestamp)
		.filter(interval => Number.isFinite(interval) && interval >= 0);
	if (!intervals.length) return { ...message, _cadence: null, _cadenceStable: false, _intervals: intervals };
	const sorted = [...intervals].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	const tolerance = Math.max(2, median * 0.1);
	const stable = intervals.every(interval => Math.abs(interval - median) <= tolerance);
	const average = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
	return { ...message, _cadence: stable ? average : null, _cadenceStable: stable, _intervals: intervals };
}

function recognizeMessagePatterns(c = capture()) {
	const messageEntries = (c?.messages || [])
		.map((message, originalIndex) => ({ message, originalIndex }))
		.filter(({ message }) => !message.hidden);
	const messages = messageEntries.map(({ message }) => message);
	if (messages.length < MIN_PATTERN_LENGTH * 2) return { groups: [], membership: new Map() };
	const cacheKey = [
		c.byteStream?.length || 0,
		messages.length,
		JSON.stringify((c.messages || []).map(message => Boolean(message.hidden))),
		JSON.stringify((c.messages || []).map(message => message.hiddenBytes || [])),
		c.previewMode,
		c.frameSize,
		c.frameMarker,
		c.markerPosition,
		c.frameTimeGap,
		JSON.stringify((c.frameSections || []).map(({ start, frameSize }) => [start, frameSize])),
		JSON.stringify(c.patternRemarks || {})
	].join("|");
	const cached = patternRecognitionCache.get(c);
	if (cached?.key === cacheKey) return cached.result;
	const signatures = messages.map(signature);
	const candidates = [];
	const maxLength = Math.min(MAX_PATTERN_LENGTH, Math.floor(messages.length / 2));

	for (let length = MIN_PATTERN_LENGTH; length <= maxLength; length++) {
		const startsByKey = new Map();
		for (let start = 0; start + length <= messages.length; start++) {
			const window = messages.slice(start, start + length);
			if (messageEntries.slice(start, start + length).some((entry, offset) => offset && entry.originalIndex !== messageEntries[start].originalIndex + offset)) continue;
			if (window.some((message, offset) => offset && message.sectionId !== window[0].sectionId)) continue;
			const parts = signatures.slice(start, start + length);
			// A run of one identical telegram is already represented by repeat collapsing;
			// sequence recognition is reserved for exchanges with at least two states.
			if (new Set(parts).size < 2) continue;
			// Do not report A-B-A-B as a four-message pattern when A-B is the
			// underlying repeated exchange.
			const hasShorterPeriod = Array.from(
				{ length: Math.floor(length / 2) - 1 },
				(_, index) => index + MIN_PATTERN_LENGTH
			).some(period => length % period === 0 && parts.every((part, index) => part === parts[index % period]));
			if (hasShorterPeriod) continue;
			const key = parts.join(" → ");
			const starts = startsByKey.get(key) || [];
			starts.push(start);
			startsByKey.set(key, starts);
		}
		startsByKey.forEach((starts, key) => {
			const nonOverlapping = [];
			starts.forEach(start => {
				if (!nonOverlapping.length || start >= nonOverlapping.at(-1) + length) nonOverlapping.push(start);
			});
			if (nonOverlapping.length >= 2) {
				candidates.push({
					key,
					length,
					starts: nonOverlapping,
					signatures: key.split(" → "),
					score: length * nonOverlapping.length
				});
			}
		});
	}

	// Prefer the candidates that explain the most rows, then the longer exchange.
	// Each table row receives one edge color, keeping dense captures legible.
	candidates.sort(
		(a, b) => b.score - a.score || b.length - a.length || b.starts.length - a.starts.length || a.key.localeCompare(b.key)
	);
	const claimed = new Set();
	const groups = [];
	const groupStartIndexes = new Map();
	for (const candidate of candidates) {
		const availableStarts = candidate.starts.filter(start => {
			for (let offset = 0; offset < candidate.length; offset++) {
				if (claimed.has(start + offset)) return false;
			}
			return true;
		});
		if (availableStarts.length < 2) continue;
		const group = {
			...candidate,
			id: `pattern-${hashText(candidate.key).toString(36)}`,
			starts: availableStarts.map(start => messageEntries[start].originalIndex),
			color: colorForPattern(candidate.key),
			remark: c.patternRemarks?.[candidate.key]?.text || ""
		};
		groups.push(group);
		groupStartIndexes.set(group.id, availableStarts);
		availableStarts.forEach(start => {
			for (let offset = 0; offset < candidate.length; offset++) claimed.add(start + offset);
		});
	}

	const membership = new Map();
	groups.forEach(group =>
		groupStartIndexes.get(group.id).forEach((start, occurrenceIndex) => {
			for (let offset = 0; offset < group.length; offset++) {
				membership.set(messageEntries[start + offset].originalIndex, { group, occurrenceIndex, offset });
			}
		})
	);
	const result = { groups, membership };
	patternRecognitionCache.set(c, { key: cacheKey, result });
	return result;
}

function transitionFrames(rows) {
	const byteRows = rows.map(visibleByteEntries);
	const frames = byteRows.map(row => row.map(() => ({ incoming: null, outgoing: null })));
	for (let rowIndex = 0; rowIndex < rows.length - 1; rowIndex++) {
		const fromRow = rows[rowIndex];
		const toRow = rows[rowIndex + 1];
		if (toRow._originalStart !== fromRow._originalEnd + 1 || toRow.sectionId !== fromRow.sectionId) continue;
		const fromBytes = byteRows[rowIndex];
		const toBytes = byteRows[rowIndex + 1];
		const comparable = Math.min(fromBytes.length, toBytes.length);
		const unchanged = Array.from({ length: comparable }, (_, position) => position).filter(
			position => fromBytes[position].value === toBytes[position].value
		);
		const changed = Array.from({ length: comparable }, (_, position) => position).filter(
			position => fromBytes[position].value !== toBytes[position].value
		);
		if (!unchanged.length || !changed.length) continue;

		const groups = [];
		changed.forEach(position => {
			const group = groups.at(-1);
			if (group && position === group.at(-1) + 1) group.push(position);
			else groups.push([position]);
		});

		groups.forEach(group => {
			const start = group[0];
			const end = group.at(-1);
			const from = group.map(position => hexByte(fromBytes[position].value)).join(" ");
			const to = group.map(position => hexByte(toBytes[position].value)).join(" ");
			const key = `${from}→${to}`;
			const descriptor = {
				color: colorForTransition(key),
				lane: hashText(key) % 3,
				label: `${from} → ${to}`
			};
			group.forEach(position => {
				frames[rowIndex][position].outgoing = {
					...descriptor,
					start: position === start,
					end: position === end
				};
				frames[rowIndex + 1][position].incoming = {
					...descriptor,
					start: position === start,
					end: position === end
				};
			});
		});
	}
	return frames;
}

function renderMessages() {
	const c = capture();
	if (!c) return;
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
	const highlight = $("#uniqueToggle").checked;
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
		mode: $("#displayMode").value,
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

function renderAnalysis() {
	const c = capture();
	if (!c) return;
	const messages = visibleMessages(c);
	const counts = [...getCounts(messages).entries()].sort((a, b) => b[1] - a[1]);
	const maxCount = counts[0]?.[1] || 1;
	$("#signatureList").innerHTML =
		counts
			.slice(0, 10)
			.map(
				([sig, n]) => `
    <div class="signature-row"><span>${sig}</span><span class="signature-bar"><i style="width:${(n / maxCount) * 100}%"></i></span><small>${n} · ${Math.round((n / messages.length) * 100)}%</small></div>
  `
			)
			.join("") || `<span class="muted">No messages to analyze.</span>`;

	$("#vocabulary").innerHTML = Array.from({ length: frameWidth(c) }, (_, pos) => {
		const values = new Map();
		messages.forEach(m => {
			const byte = visibleByteEntries(m)[pos]?.value;
			if (byte !== undefined) values.set(byte, (values.get(byte) || 0) + 1);
		});
		return `<div class="vocab-row"><label>BYTE ${pos + 1}</label><div class="vocab-values">${[...values.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([v, n]) => `<span title="${n} occurrences">${hexByte(v)}<small> ·${n}</small></span>`)
			.join("")}</div></div>`;
	}).join("");

	$("#bitMap").innerHTML = Array.from({ length: frameWidth(c) }, (_, pos) => {
		const bytes = messages.map(m => visibleByteEntries(m)[pos]?.value).filter(v => v !== undefined);
		return `<div class="bit-row"><label>BYTE ${pos + 1}</label>${Array.from({ length: 8 }, (_, idx) => {
			const bit = 7 - idx;
			const ones = bytes.filter(v => (v >> bit) & 1).length;
			const ratio = bytes.length ? ones / bytes.length : 0;
			const variance = Math.min(ratio, 1 - ratio) * 2;
			return `<div class="bit-cell" style="--variance:${variance.toFixed(2)}" title="${Math.round(ratio * 100)}% ones"><span>b${bit}<br>${Math.round(ratio * 100)}%</span></div>`;
		}).join("")}</div>`;
	}).join("");

	const transitions = new Map();
	messages.slice(1).forEach((m, i) => {
		const from = signature(messages[i]),
			to = signature(m);
		if (from !== to) transitions.set(`${from}|${to}`, (transitions.get(`${from}|${to}`) || 0) + 1);
	});
	$("#transitionList").innerHTML =
		[...transitions.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([key, n]) => {
				const [from, to] = key.split("|");
				const diffs = from.split(" ").filter((v, i) => v !== to.split(" ")[i]).length;
				return `<div class="transition-row"><span>${from}</span><b>→</b><span>${to}</span><small>${n}× · ${diffs} byte${diffs === 1 ? "" : "s"} changed</small></div>`;
			})
			.join("") || `<span class="muted">No transitions yet.</span>`;
}

function allNotes() {
	const c = capture();
	if (!c) return [];
	const captureNotes = (c.notes || []).filter(n => n.type === "sequence").map(n => ({ ...n, label: "SEQUENCE" }));
	const annotations = Object.entries(c.annotations || {}).map(([key, n]) => ({
		...n,
		id: key,
		label: key.includes(":") ? "BYTE" : "MESSAGE"
	}));
	return [...captureNotes, ...annotations].sort((a, b) => b.createdAt - a.createdAt);
}

function renderNotes() {
	const notes = allNotes();
	$("#notesCount").textContent = notes.length;
	$("#notesList").innerHTML =
		notes
			.map(
				n => `
    <article class="note-card"><header><span>${n.label}${n.targetLabel ? ` · ${escapeHtml(n.targetLabel)}` : ""}</span><span>${new Date(n.createdAt).toLocaleString()}</span></header><p>${escapeHtml(n.text)}</p></article>
  `
			)
			.join("") || `<p class="muted">No observations recorded for this capture.</p>`;
}

function openContext(isNew = false) {
	const c = isNew ? { name: "Untitled capture", view: "", params: [], baudRate: 115200, folderId: null } : capture();
	$("#contextDialog").dataset.mode = isNew ? "new" : "edit";
	$("#contextName").value = c.name;
	$("#contextView").value = c.view;
	$("#baudRate").value = c.baudRate;
	$("#contextFolder").innerHTML = [
		`<option value="">Unfiled</option>`,
		...state.folders.map(folder => `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}</option>`)
	].join("");
	$("#contextFolder").value = c.folderId || "";
	$("#parameterRows").innerHTML = "";
	c.params.forEach(p => addParameterRow(p.key, p.value));
	if (!c.params.length) addParameterRow("Speed", "");
	$("#contextDialog").showModal();
}

function openSectionsEditor() {
	const c = capture();
	if (!c) return;
	normalizeSections(c);
	renderSectionRows(c.frameSections);
	$("#sectionsDialog").showModal();
}

function renderSectionRows(sections) {
	$("#sectionRows").innerHTML = "";
	sections.forEach(section => addSectionRow(section));
}

function addSectionRow(section) {
	const c = capture();
	if (!c) return;
	const streamLength = c.byteStream.length;
	if (!section && streamLength < 2) {
		showToast("Capture at least two raw bytes before adding a section");
		return;
	}
	const existingStarts = $$("#sectionRows [data-section-start]").map(input => +input.value - 1);
	const fallbackStart = Math.min(streamLength - 1, Math.max(...existingStarts, 0) + 1);
	const values = section || { id: crypto.randomUUID(), start: fallbackStart, frameSize: c.frameSize };
	const row = document.createElement("div");
	row.className = "section-row";
	row.dataset.sectionId = values.id;
	row.innerHTML = `<strong>Section</strong>
    <label>Starts at raw byte <input data-section-start type="number" min="1" max="${Math.max(1, streamLength)}" value="${values.start + 1}" /></label>
    <label>Frame length <input data-section-size type="number" min="1" max="1024" value="${values.frameSize}" /> bytes</label>
    <button class="icon-btn" type="button" aria-label="Remove section">×</button>`;
	row.querySelector("button").onclick = () => {
		if ($$("#sectionRows .section-row").length === 1) return showToast("A section is required to frame the capture");
		row.remove();
	};
	$("#sectionRows").append(row);
}

function saveSections() {
	const c = capture();
	if (!c) return;
	const maxStart = Math.max(0, c.byteStream.length - 1);
	const draft = $$("#sectionRows .section-row").map(row => ({
		id: row.dataset.sectionId || crypto.randomUUID(),
		start: Math.max(0, Math.min(maxStart, Math.floor(+row.querySelector("[data-section-start]").value - 1 || 0))),
		frameSize: Math.max(1, Math.min(1024, Math.floor(+row.querySelector("[data-section-size]").value || c.frameSize))),
		collapseRuns: Boolean(c.frameSections.find(section => section.id === row.dataset.sectionId)?.collapseRuns)
	}));
	const starts = new Set();
	if (draft.some(section => starts.has(section.start) || !starts.add(section.start))) {
		showToast("Each section must start at a different raw byte");
		return;
	}
	c.frameSections = draft;
	normalizeSections(c);
	rebuildPreview(c);
	saveState();
	render();
	showToast("Section framing updated");
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

function addParameterRow(key = "", value = "") {
	const row = document.createElement("div");
	row.className = "parameter-row";
	row.innerHTML = `<input placeholder="Parameter" value="${escapeHtml(key)}"><input placeholder="Value" value="${escapeHtml(value)}"><button type="button" aria-label="Remove">×</button>`;
	row.querySelector("button").onclick = () => row.remove();
	$("#parameterRows").append(row);
}

function saveContext() {
	const params = $$("#parameterRows .parameter-row")
		.map(row => {
			const [key, value] = [...row.querySelectorAll("input")].map(x => x.value.trim());
			return { key, value };
		})
		.filter(p => p.key);
	const values = {
		name: $("#contextName").value.trim() || "Untitled capture",
		view: $("#contextView").value.trim(),
		folderId: $("#contextFolder").value || null,
		params,
		baudRate: +$("#baudRate").value,
		inputFormat: "raw"
	};
	if ($("#contextDialog").dataset.mode === "new") {
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
	} else Object.assign(capture(), values);
	saveState();
	render();
	showToast("Capture context saved");
}

function openAnnotation(type, key) {
	const c = capture();
	annotationTarget = { type, key };
	const [messageId, posText] = key.split(":");
	const m = c.messages.find(x => x.id === messageId);
	const pos = posText === undefined ? null : +posText;
	const targetKey = type === "byte" ? key : messageId;
	const existing = c.annotations[targetKey];
	const visiblePos = type === "byte" ? visiblePositionForRawByte(m, pos) : null;
	const displayPos = visiblePos >= 0 ? visiblePos : pos;
	$("#annotationTitle").textContent = type === "byte" ? `Note on byte ${displayPos + 1}` : "Note on message";
	const byteTime = m.byteTimestamps?.[pos] ?? m.timestamp;
	$("#annotationTarget").textContent =
		type === "byte"
			? `${formatTime(byteTime)}  ·  ${signature(m)}  ·  BYTE ${displayPos + 1} = ${hexByte(m.bytes[pos])}`
			: `${formatTime(m.timestamp)}  ·  ${signature(m)}`;
	$("#annotationText").value = existing?.text || "";
	$("#deleteAnnotationBtn").style.visibility = existing ? "visible" : "hidden";
	updateAnnotationValidity();
	$("#noteDialog").showModal();
	$("#annotationText").focus();
}

function updateAnnotationValidity() {
	const hasText = $("#annotationText").value.trim().length > 0;
	$("#saveAnnotationBtn").disabled = !hasText;
	$("#annotationHint").textContent = hasText ? "Ready to save." : "Enter a note to enable saving.";
	$("#annotationHint").classList.toggle("ready", hasText);
	return hasText;
}

function saveAnnotation() {
	if (!updateAnnotationValidity()) return false;
	const c = capture();
	const { type, key } = annotationTarget;
	const [messageId, pos] = key.split(":");
	const m = c.messages.find(x => x.id === messageId);
	const targetKey = type === "byte" ? key : messageId;
	const visiblePos = type === "byte" ? visiblePositionForRawByte(m, +pos) : null;
	const displayPos = visiblePos >= 0 ? visiblePos : +pos;
	c.annotations[targetKey] = {
		text: $("#annotationText").value.trim(),
		createdAt: Date.now(),
		type,
		targetLabel: type === "byte" ? `${signature(m)} · byte ${displayPos + 1}` : signature(m)
	};
	saveState();
	render();
	showToast("Annotation saved");
	return true;
}

function openPatternRemark(id) {
	const patterns = virtualMessageView?.patterns || recognizeMessagePatterns();
	const group = patterns.groups.find(item => item.id === id);
	if (!group) return showToast("This sequence is no longer present in the current framing");
	patternRemarkTarget = group.key;
	$("#patternRemarkTitle").textContent = `${group.length}-message sequence · ${group.starts.length} occurrences`;
	$("#patternRemarkTarget").innerHTML = group.signatures
		.map((value, index) => `<span><b>${String(index + 1).padStart(2, "0")}</b>${escapeHtml(value)}</span>`)
		.join("");
	$("#patternRemarkText").value = capture().patternRemarks?.[group.key]?.text || "";
	$("#deletePatternRemarkBtn").style.visibility = $("#patternRemarkText").value ? "visible" : "hidden";
	$("#patternDialog").style.setProperty("--pattern-color", group.color);
	$("#patternDialog").showModal();
	$("#patternRemarkText").focus();
}

function savePatternRemark() {
	const text = $("#patternRemarkText").value.trim();
	const c = capture();
	c.patternRemarks ||= {};
	if (text) c.patternRemarks[patternRemarkTarget] = { text, updatedAt: Date.now() };
	else delete c.patternRemarks[patternRemarkTarget];
	saveState();
	renderMessages();
	$("#patternDialog").close();
	showToast(text ? "Sequence note saved" : "Sequence note removed");
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
		renderSendWorkbench();
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
	renderHeader();
	renderSendWorkbench();
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
	renderHeader();
	renderMessages();
	if ($("#patternsPanel").classList.contains("active")) renderAnalysis();
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
	renderSendWorkbench();
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
		renderSendWorkbench();
	}
}

async function sendBytes() {
	const parsed = updateTransmitValidity();
	if (!parsed.bytes?.length) return;
	const sent = await transmitBytes(parsed.bytes, "manual");
	if (!sent) return;
	state.sendSettings.draft = "";
	$("#transmitHex").value = "";
	saveState();
	renderSendWorkbench();
}

function addDraftToQueue() {
	const parsed = updateTransmitValidity();
	if (!parsed.bytes?.length) return;
	state.sendQueue.push({
		id: crypto.randomUUID(),
		bytes: [...parsed.bytes],
		createdAt: Date.now()
	});
	state.sendSettings.draft = "";
	$("#transmitHex").value = "";
	saveState();
	renderSendWorkbench();
	showToast("Message added to transmit queue");
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
	renderSendWorkbench();
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
			if (index < queued.length - 1 && !stopQueueRequested) await waitForQueueDelay(state.sendSettings.delayMs);
		}
	} finally {
		queueRunning = false;
		stopQueueRequested = false;
		renderSendWorkbench();
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
	renderHeader();
	renderSendWorkbench();
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
	$("#exportDialog").close();
	showToast(`${format.toUpperCase()} export created`);
}

$("#connectBtn").onclick = connectSerial;
$("#recordBtn").onclick = toggleRecording;
$("#sendBytesBtn").onclick = sendBytes;
$("#addQueueBtn").onclick = addDraftToQueue;
$("#runQueueBtn").onclick = () => void runSendQueue();
$("#stopQueueBtn").onclick = () => {
	stopQueueRequested = true;
	queueDelayResolve?.();
	$("#stopQueueBtn").disabled = true;
	$("#stopQueueBtn").textContent = "Stopping…";
};
$("#clearQueueBtn").onclick = () => {
	if (!state.sendQueue.length || queueRunning) return;
	if (confirm("Clear every message from the transmit queue?")) {
		state.sendQueue = [];
		saveState({ immediate: true });
		renderSendWorkbench();
	}
};
$("#clearHistoryBtn").onclick = () => {
	if (!state.sendHistory.length) return;
	if (confirm("Clear the separate local send history? Captured TX bytes will remain in captures.")) {
		state.sendHistory = [];
		saveState({ immediate: true });
		renderSendWorkbench();
	}
};
$("#queueDelay").onchange = event => {
	state.sendSettings.delayMs = Math.max(0, Math.min(600_000, +event.target.value || 0));
	saveState({ immediate: true });
	renderSendWorkbench();
};
$("#transmitHex").oninput = event => {
	state.sendSettings.draft = event.target.value;
	saveState();
	updateTransmitValidity();
};
$("#transmitHex").onkeydown = event => {
	if (event.key === "Enter") {
		event.preventDefault();
		if (event.shiftKey) addDraftToQueue();
		else void sendBytes();
	}
};
$("#editContextBtn").onclick = () => openContext(false);
$("#addParameterBtn").onclick = () => addParameterRow();
$("#contextForm").addEventListener("submit", e => {
	if (e.submitter?.value === "cancel") return;
	e.preventDefault();
	saveContext();
	$("#contextDialog").close();
});
$("#captureTitle").oninput = e => {
	if (!capture()) return;
	capture().name = e.target.value;
	saveState();
};
$("#captureTitle").onblur = e => {
	if (!capture()) return;
	capture().name = normalizeDescription(e.target.value) || "Untitled capture";
	e.target.value = capture().name;
	saveState();
	publishArchiveState();
};
$("#captureDescription").oninput = e => {
	if (!capture()) return;
	capture().description = e.target.value;
	sizeCaptureDescription();
	saveState();
};
$("#captureDescription").onblur = e => {
	if (!capture()) return;
	capture().description = normalizeDescription(e.target.value);
	e.target.value = capture().description;
	sizeCaptureDescription();
	saveState();
};
$("#messageFilter").oninput = () => {
	$(".table-wrap").scrollTop = 0;
	updateMessageFilterControl();
	renderMessages();
};
$("#messageFilter").onkeydown = event => {
	if (event.key !== "Escape") return;
	event.preventDefault();
	setMessageFilterOpen(false);
	$("#toggleMessageFilterBtn").focus();
};
$("#toggleMessageFilterBtn").onclick = () =>
	setMessageFilterOpen($("#streamFilter").classList.contains("collapsed"), { focusFilter: true });
$("#displayMode").onchange = renderMessages;
$("#uniqueToggle").onchange = renderMessages;
$("#collapseToggle").onchange = renderMessages;
function applyPreviewSettings() {
	const c = capture();
	if (!c) return;
	c.previewMode = $("#framingMode").value;
	c.frameSize = Math.max(1, Math.min(1024, +$("#previewFrameSize").value || 3));
	const marker = markerBytes($("#frameMarker").value);
	c.markerConfigured = marker.length > 0;
	c.frameMarker = marker.map(hexByte).join(" ");
	c.markerPosition = $("#markerPosition").value;
	c.frameTimeGap = Math.max(0.01, +$("#frameTimeGap").value || 5);
	normalizeSections(c);
	rebuildPreview(c);
	saveState();
	render();
}
$("#framingMode").onchange = applyPreviewSettings;
$("#previewFrameSize").oninput = applyPreviewSettings;
$("#frameMarker").onchange = applyPreviewSettings;
$("#markerPosition").onchange = applyPreviewSettings;
$("#frameTimeGap").oninput = applyPreviewSettings;
$("#editSectionsBtn").onclick = openSectionsEditor;
$("#addSectionBtn").onclick = addSectionRow;
$("#sectionsForm").addEventListener("submit", event => {
	if (event.submitter?.value === "cancel") return;
	event.preventDefault();
	saveSections();
	$("#sectionsDialog").close();
});
$("#moreBtn").onclick = () => $("#moreMenu").classList.toggle("hidden");
$("#duplicateCaptureBtn").onclick = () => {
	const copy = structuredClone(capture());
	copy.id = crypto.randomUUID();
	copy.name += " · copy";
	copy.createdAt = new Date().toISOString();
	copy.messages.forEach(m => (m.id = crypto.randomUUID()));
	copy.annotations = {};
	state.captures.unshift(copy);
	activeId = copy.id;
	saveState();
	render();
	$("#moreMenu").classList.add("hidden");
};
$("#clearMessagesBtn").onclick = () => {
	if (confirm("Clear all raw bytes, messages, and message annotations from this capture?")) {
		capture().byteStream = [];
		capture().messages = [];
		capture().annotations = {};
		capture().patternRemarks = {};
		saveState();
		render();
	}
	$("#moreMenu").classList.add("hidden");
};
$("#deleteCaptureBtn").onclick = async () => {
	if (confirm(`Delete “${capture().name}”?`)) {
		if (recording) {
			flushLiveBytes();
			recording = false;
			recordingSessionId = null;
		}
		state.captures = state.captures.filter(c => c.id !== activeId);
		activeId = state.captures[0]?.id || null;
		saveState();
		render();
	}
	$("#moreMenu").classList.add("hidden");
};
$$(".tab").forEach(
	tab =>
		(tab.onclick = () => {
			$$(".tab").forEach(x => x.classList.toggle("active", x === tab));
			$$(".tab-panel").forEach(x => x.classList.remove("active"));
			$(`#${tab.dataset.panel}Panel`).classList.add("active");
			$(".toolbar").classList.remove("send-view");
			updateMessageFilterControl();
		})
);
function updateMessageFilterControl() {
	const button = $("#toggleMessageFilterBtn");
	const input = $("#messageFilter");
	const streamActive = $("#streamPanel").classList.contains("active");
	const enabled = Boolean(capture()) && streamActive;
	button.classList.toggle("hidden", !streamActive);
	button.disabled = !enabled;
	button.classList.toggle("active", Boolean(input.value.trim()));
}

function setMessageFilterOpen(open, { focusFilter = false } = {}) {
	const filter = $("#streamFilter");
	const button = $("#toggleMessageFilterBtn");
	filter.classList.toggle("collapsed", !open);
	button.setAttribute("aria-expanded", String(open));
	const label = open ? "Hide message filter" : "Show message filter";
	button.setAttribute("aria-label", label);
	button.title = label;
	updateMessageFilterControl();
	if (open && focusFilter) requestAnimationFrame(() => $("#messageFilter").focus());
}

function setSendPopupOpen(open, { focusComposer = false } = {}) {
	const popup = $("#sendPanel");
	popup.classList.toggle("collapsed", !open);
	$("#toast").classList.toggle("send-popup-open", open);
	$("#toggleSendPopupBtn").setAttribute("aria-expanded", String(open));
	$("#minimizeSendPopupBtn").setAttribute("aria-label", open ? "Minimize composer" : "Open composer");
	if (open) {
		renderSendWorkbench();
		if (focusComposer) requestAnimationFrame(() => $("#transmitHex").focus());
	}
}
$("#toggleSendPopupBtn").onclick = () =>
	setSendPopupOpen($("#sendPanel").classList.contains("collapsed"), { focusComposer: true });
$("#minimizeSendPopupBtn").onclick = () => setSendPopupOpen(false);
$("#captureNoteForm").onsubmit = e => {
	e.preventDefault();
	const c = capture();
	const noteText = $("#captureNoteText").value.trim();
	if (!c || !noteText) return;
	const max = Math.max(1, c.messages.length);
	const start = Math.max(1, Math.min(max, +$("#sequenceStart").value || 1));
	const end = Math.max(start, Math.min(max, +$("#sequenceEnd").value || start));
	c.notes.push({
		id: crypto.randomUUID(),
		type: "sequence",
		text: noteText,
		createdAt: Date.now(),
		start,
		end,
		targetLabel: `rows ${start}–${end}`
	});
	$("#captureNoteText").value = "";
	saveState();
	renderNotes();
	renderMessages();
	showToast("Sequence observation added");
};
$("#annotationText").addEventListener("input", updateAnnotationValidity);
$("#annotationForm").addEventListener("submit", e => {
	if (e.submitter?.value === "cancel") return;
	e.preventDefault();
	if (saveAnnotation()) $("#noteDialog").close();
});
$("#deleteAnnotationBtn").onclick = () => {
	const key = annotationTarget.type === "byte" ? annotationTarget.key : annotationTarget.key.split(":")[0];
	delete capture().annotations[key];
	saveState();
	render();
	$("#noteDialog").close();
	showToast("Annotation removed");
};
$("#patternRemarkForm").addEventListener("submit", e => {
	if (e.submitter?.value === "cancel") return;
	e.preventDefault();
	savePatternRemark();
});
$("#deletePatternRemarkBtn").onclick = () => {
	$("#patternRemarkText").value = "";
	savePatternRemark();
};
$$("[data-export]").forEach(btn => (btn.onclick = () => exportData(btn.dataset.export)));
$("#messageBody").addEventListener("click", event => {
	const noteButton = event.target.closest("[data-message-note]");
	if (noteButton) return openAnnotation("message", noteButton.dataset.messageNote);
	const replayButton = event.target.closest("[data-message-replay]");
	if (replayButton) {
		const message = capture().messages.find(item => item.id === replayButton.dataset.messageReplay);
		if (message) void transmitBytes(Uint8Array.from(visibleByteEntries(message).map(({ value }) => value)), "replay");
		return;
	}
	const patternButton = event.target.closest("[data-pattern-id]");
	if (patternButton) return openPatternRemark(patternButton.dataset.patternId);
	const byteButton = event.target.closest("[data-byte-note]");
	if (byteButton) openAnnotation("byte", byteButton.dataset.byteNote);
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
	if (!e.target.closest(".header-actions")) $("#moreMenu").classList.add("hidden");
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

registerArchiveActions({
	selectCapture: selectArchiveCapture,
	toggleFolder: toggleArchiveFolder,
	moveCapture: moveArchiveCapture,
	openNewCapture: () => openContext(true),
	openImport: () => $("#fileInput").click(),
	openExport: () => $("#exportDialog").showModal(),
	saveFolder,
	deleteFolder,
	importFile
});

render();

export {};

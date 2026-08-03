// The controller remains framework-agnostic so the protocol and Web Serial
// behavior can stay byte-for-byte compatible with the original implementation.
// @ts-nocheck
import { publishArchiveSnapshot, registerArchiveActions } from "./archive-bridge";
import { STORAGE_KEY, loadState, normalizeSendState } from "./app-state";
import {
	deriveAnalysisSnapshot,
	recognizeMessagePatterns
} from "./analysis";
import { publishAnalysisSnapshot } from "./analysis-bridge";
import { deriveCaptureHeaderSnapshot } from "./capture-header";
import { publishCaptureHeaderSnapshot, registerCaptureHeaderActions } from "./capture-header-bridge";
import {
	publishFramingToolbarSnapshot,
	registerFramingToolbarActions
} from "./framing-toolbar-bridge";
import { publishSendSnapshot, registerSendActions } from "./send-bridge";
import { createSendController, type SendController } from "./send-controller";
import { registerTransportActions } from "./transport-bridge";
import { createSerialController, type SerialController } from "./serial-controller";
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
	hexByte,
	frameWidth,
	makeMessage,
	normalizeCapture,
	normalizeSections,
	parseTime,
	rebuildPreview,
	signature,
	visibleByteEntries,
	visibleMessages
} from "./capture-framing";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let state = loadState();
let activeId = state.activeId || state.captures[0]?.id;
let toastTimer = null;
let stateSaveTimer = null;
let transport: SerialController;
let sendController: SendController;

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
	const sendStatus = sendController.getStatus();
	publishSendSnapshot({
		connected: Boolean(transport.getPort()?.writable),
		recording: transport.isRecording(),
		sendInFlight: sendStatus.sendInFlight,
		queueRunning: sendStatus.queueRunning,
		stopQueueRequested: sendStatus.stopQueueRequested,
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

function showToast(message) {
	clearTimeout(toastTimer);
	publishToastSnapshot({ message, visible: true });
	toastTimer = setTimeout(() => publishToastSnapshot({ message: "", visible: false }), 2600);
}

function render() {
	publishArchiveState();
	publishCaptureHeaderState();
	transport.publishState();
	publishFramingToolbarState();
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
	publishCaptureHeaderSnapshot(deriveCaptureHeaderSnapshot(capture(), transport.isRecording()));
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

function renderMessages() {
	const c = capture();
	if (!c) return;
	const viewState = getViewStateSnapshot();
	publishMessageStreamSnapshot(deriveMessageStreamSnapshot(c, viewState));
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
	if (transport.isRecording()) transport.stopRecording();
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
	const patterns = recognizeMessagePatterns(c);
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

transport = createSerialController({
	capture,
	state,
	saveState,
	showToast,
	publishCaptureHeaderState,
	publishFramingToolbarState,
	publishAnalysisState,
	publishNotesState,
	renderMessages,
	isPatternsPanelActive: () => getViewStateSnapshot().activePanel === "patterns",
	stopSendQueue: () => {
		sendController?.stopSendQueue();
	},
	publishSendState
});

sendController = createSendController({
	state,
	capture,
	transport,
	saveState,
	showToast,
	confirm: message => confirm(message),
	publishSendState
});

registerTransportActions({
	connect: transport.connect,
	disconnect: transport.disconnect,
	toggleConnection: transport.toggleConnection,
	toggleRecording: transport.toggleRecording
});

let previousViewState = getViewStateSnapshot();
subscribeToViewState(() => {
	const nextViewState = getViewStateSnapshot();
	const renderChanged =
		nextViewState.filterQuery !== previousViewState.filterQuery ||
		nextViewState.displayMode !== previousViewState.displayMode ||
		nextViewState.showFrameChanges !== previousViewState.showFrameChanges ||
		nextViewState.collapseRuns !== previousViewState.collapseRuns;
	if (renderChanged && capture()) renderMessages();
	if (nextViewState.activePanel === "patterns" && previousViewState.activePanel !== "patterns") {
		publishAnalysisState();
	}
	previousViewState = nextViewState;
});

window.addEventListener("beforeunload", () => {
	transport.flushLiveBytes();
	persistState();
	if (transport.getPort()) void transport.disconnect();
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
	setDraft: sendController.setSendDraft,
	setDelay: sendController.setQueueDelay,
	send: sendController.sendBytes,
	addToQueue: sendController.addDraftToQueue,
	sendQueueItem: sendController.sendQueueItem,
	removeQueueItem: sendController.removeQueueItem,
	loadHistory: sendController.loadHistoryItem,
	replayHistory: sendController.replayHistoryItem,
	runQueue: sendController.runSendQueue,
	stopQueue: sendController.stopSendQueue,
	clearQueue: sendController.clearSendQueue,
	clearHistory: sendController.clearSendHistory
});

registerMessageStreamActions({
	openMessageNote: messageId => publishAnnotationDialog("message", messageId),
	openByteNote: (messageId, position) => publishAnnotationDialog("byte", `${messageId}:${position}`),
	replayMessage: messageId => {
		const message = capture()?.messages.find(item => item.id === messageId);
		if (message) {
			void sendController.transmitBytes(
				Uint8Array.from(visibleByteEntries(message).map(({ value }) => value)),
				"replay"
			);
		}
	},
	openPatternRemark: publishPatternRemarkDialog,
	hideMessage: messageId => {
		const c = capture();
		const message = c?.messages.find(item => item.id === messageId);
		if (!message) return;
		message.hidden = true;
		saveState({ immediate: true });
		render();
		showToast("Message hidden; captured data was kept");
	},
	hideByte: (messageId, position) => {
		const c = capture();
		const message = c?.messages.find(item => item.id === messageId);
		if (!c || !message || position < 0 || position >= message.bytes.length) return;
		message.hiddenBytes ||= [];
		message.hiddenBytes[position] = true;
		const rawIndex = message._rawPositions?.[position] ?? -1;
		if (rawIndex >= 0 && c.byteStream?.[rawIndex]) c.byteStream[rawIndex].hidden = true;
		rebuildPreview(c);
		saveState({ immediate: true });
		render();
		showToast("Byte hidden; captured data was kept");
	},
	beginSection: startSectionAtByte,
	setSectionFrameSize,
	setSectionCollapse
});

registerNotesActions({ addSequenceNote });

render();

export {};

// The controller remains framework-agnostic so the protocol and Web Serial
// behavior can stay byte-for-byte compatible with the original implementation.
// @ts-nocheck
import { publishArchiveSnapshot, registerArchiveActions } from "./archive-bridge";
import { STORAGE_KEY, loadState, normalizeSendState } from "./app-state";
import { deriveAnalysisSnapshot } from "./analysis";
import { publishAnalysisSnapshot } from "./analysis-bridge";
import { deriveCaptureHeaderSnapshot } from "./capture-header";
import { publishCaptureHeaderSnapshot, registerCaptureHeaderActions } from "./capture-header-bridge";
import {
	publishFramingToolbarSnapshot,
	registerFramingToolbarActions
} from "./framing-toolbar-bridge";
import { publishSendSnapshot, registerSendActions } from "./send-bridge";
import { createSendController, type SendController } from "./send-controller";
import { createCaptureController, type CaptureController } from "./capture-controller";
import { registerTransportActions } from "./transport-bridge";
import { createSerialController, type SerialController } from "./serial-controller";
import { registerNotesActions, publishNotesSnapshot } from "./notes-bridge";
import { deriveNotesSnapshot } from "./notes";
import { publishToastSnapshot } from "./toast-bridge";
import { publishDialogCommand, registerDialogActions } from "./dialog-bridge";
import { getViewStateSnapshot, subscribeToViewState } from "./view-state-bridge";
import {
	publishMessageStreamSnapshot,
	registerMessageStreamActions
} from "./message-stream-bridge";
import { deriveMessageStreamSnapshot } from "./message-stream";
import { selectFramingToolbarSnapshot } from "./framing-toolbar";
import { rebuildPreview, visibleByteEntries, visibleMessages } from "./capture-framing";
import { download } from "./browser-download";
import { createDataTransferController, type DataTransferController } from "./data-transfer";
let state = loadState();
let activeId = state.activeId || state.captures[0]?.id;
let toastTimer = null;
let stateSaveTimer = null;
let transport: SerialController;
let sendController: SendController;
let captureController: CaptureController;
let dataTransferController: DataTransferController;

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

function renderMessages() {
	const c = capture();
	if (!c) return;
	const viewState = getViewStateSnapshot();
	publishMessageStreamSnapshot(deriveMessageStreamSnapshot(c, viewState));
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

captureController = createCaptureController({
	state,
	capture,
	getActiveId: () => activeId,
	setActiveId: captureId => {
		activeId = captureId;
	},
	saveState,
	render,
	renderMessages,
	showToast,
	confirm: message => confirm(message),
	transport,
	publishArchiveState,
	publishCaptureHeaderState,
	publishNotesState,
	publishDialogCommand
});

dataTransferController = createDataTransferController({
	state,
	capture,
	getActiveId: () => activeId,
	setActiveId: captureId => {
		activeId = captureId;
	},
	saveState,
	render,
	showToast,
	download
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
	setTitle: captureController.setCaptureTitle,
	commitTitle: captureController.commitCaptureTitle,
	setDescription: captureController.setCaptureDescription,
	commitDescription: captureController.commitCaptureDescription,
	openContext: captureController.publishContextDialog,
	duplicate: captureController.duplicateActiveCapture,
	clearMessages: captureController.clearActiveCaptureMessages,
	deleteCapture: captureController.deleteActiveCapture
});

registerArchiveActions({
	selectCapture: captureController.selectArchiveCapture,
	toggleFolder: captureController.toggleArchiveFolder,
	moveCapture: captureController.moveArchiveCapture,
	openNewCapture: () => captureController.publishContextDialog(true),
	openExport: () => publishDialogCommand({ type: "export" }),
	saveFolder: captureController.saveFolder,
	deleteFolder: captureController.deleteFolder,
	importFile: dataTransferController.importFile
});

registerFramingToolbarActions({
	updateSettings: captureController.updateFramingSettings,
	openSections: captureController.publishSectionsDialog
});

registerDialogActions({
	saveContext: captureController.commitContextDraft,
	saveSections: captureController.commitSectionsDraft,
	saveAnnotation: captureController.commitAnnotationDraft,
	deleteAnnotation: captureController.removeAnnotationDraft,
	savePatternRemark: captureController.commitPatternRemarkDraft,
	exportData: dataTransferController.exportData,
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
	openMessageNote: messageId => captureController.publishAnnotationDialog("message", messageId),
	openByteNote: (messageId, position) => captureController.publishAnnotationDialog("byte", `${messageId}:${position}`),
	replayMessage: messageId => {
		const message = capture()?.messages.find(item => item.id === messageId);
		if (message) {
			void sendController.transmitBytes(
				Uint8Array.from(visibleByteEntries(message).map(({ value }) => value)),
				"replay"
			);
		}
	},
	openPatternRemark: captureController.publishPatternRemarkDialog,
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
	beginSection: captureController.startSectionAtByte,
	setSectionFrameSize: captureController.setSectionFrameSize,
	setSectionCollapse: captureController.setSectionCollapse
});

registerNotesActions({ addSequenceNote: captureController.addSequenceNote });

render();

export {};

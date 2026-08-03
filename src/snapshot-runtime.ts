import { normalizeSendState, type AppState, type SendHistoryEntry, type SendQueueEntry, type SendSettings } from "./app-state.ts";
import { deriveAnalysisSnapshot } from "./analysis.ts";
import { publishAnalysisSnapshot } from "./analysis-bridge.ts";
import { deriveCaptureHeaderSnapshot } from "./capture-header.ts";
import { publishCaptureHeaderSnapshot } from "./capture-header-bridge.ts";
import { publishFramingToolbarSnapshot } from "./framing-toolbar-bridge.ts";
import { publishSendSnapshot } from "./send-bridge.ts";
import { deriveNotesSnapshot } from "./notes.ts";
import { publishNotesSnapshot } from "./notes-bridge.ts";
import { getViewStateSnapshot, subscribeToViewState } from "./view-state-bridge.ts";
import { deriveMessageStreamSnapshot } from "./message-stream.ts";
import { publishMessageStreamSnapshot } from "./message-stream-bridge.ts";
import { selectFramingToolbarSnapshot } from "./framing-toolbar.ts";
import { visibleMessages, type Capture } from "./capture-framing.ts";
import type { SendController } from "./send-controller.ts";
import type { SerialController } from "./serial-controller.ts";
import type { ViewStateSnapshot } from "./view-state.ts";
import { publishArchiveSnapshot } from "./archive-bridge.ts";

type ReadyAppState = AppState & {
	sendHistory: SendHistoryEntry[];
	sendQueue: SendQueueEntry[];
	sendSettings: SendSettings;
};

export type SnapshotRuntimeDependencies = {
	state: AppState;
	capture: () => Capture | undefined;
	getActiveId: () => string | null | undefined;
	getTransport: () => Pick<SerialController, "getPort" | "isRecording" | "publishState">;
	getSendController: () => Pick<SendController, "getStatus"> | undefined;
	getViewStateSnapshot?: () => ViewStateSnapshot;
};

export type SnapshotRuntime = {
	publishArchiveState: () => void;
	publishSendState: () => void;
	publishCaptureHeaderState: () => void;
	publishFramingToolbarState: (capture?: Capture) => void;
	publishAnalysisState: (capture?: Capture) => void;
	publishNotesState: (capture?: Capture) => void;
	renderMessages: () => void;
	render: () => void;
	subscribeToViewStateChanges: () => () => void;
};

export function createSnapshotRuntime(dependencies: SnapshotRuntimeDependencies): SnapshotRuntime {
	const state = dependencies.state as ReadyAppState;
	const getViewState = dependencies.getViewStateSnapshot || getViewStateSnapshot;

	function publishArchiveState(): void {
		publishArchiveSnapshot({
			captures: state.captures.map(item => ({
				id: String(item.id),
				name: String(item.name ?? ""),
				view: String(item.view || ""),
				folderId: item.folderId || null,
				params: (Array.isArray(item.params) ? item.params : []).map(parameter => ({
					key: String((parameter as { key?: unknown }).key ?? ""),
					value: String((parameter as { value?: unknown }).value ?? "")
				})),
				messageCount: visibleMessages(item).length
			})),
			folders: state.folders.map(folder => ({
				id: String(folder.id),
				name: String(folder.name ?? ""),
				collapsed: Boolean(folder.collapsed)
			})),
			activeId: dependencies.getActiveId(),
			unfiledCollapsed: Boolean(state.unfiledCollapsed)
		});
	}

	function publishSendState(): void {
		normalizeSendState(state);
		const sendStatus = dependencies.getSendController()?.getStatus() || {
			sendInFlight: false,
			queueRunning: false,
			stopQueueRequested: false
		};
		const transport = dependencies.getTransport();
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
				bytes: item.bytes!.map(Number),
				createdAt: Number(item.createdAt)
			})),
			history: state.sendHistory.map(item => ({
				id: String(item.id),
				timestamp: Number(item.timestamp),
				bytes: item.bytes!.map(Number),
				origin: String(item.origin || ""),
				ok: item.ok !== false,
				error: String(item.error || ""),
				captureId: item.captureId ? String(item.captureId) : null
			}))
		});
	}

	function publishCaptureHeaderState(): void {
		publishCaptureHeaderSnapshot(deriveCaptureHeaderSnapshot(dependencies.capture(), dependencies.getTransport().isRecording()));
	}

	function publishFramingToolbarState(capture = dependencies.capture()): void {
		publishFramingToolbarSnapshot(selectFramingToolbarSnapshot(capture));
	}

	function publishAnalysisState(capture = dependencies.capture()): void {
		publishAnalysisSnapshot(deriveAnalysisSnapshot(capture));
	}

	function publishNotesState(capture = dependencies.capture()): void {
		publishNotesSnapshot(deriveNotesSnapshot(capture));
	}

	function renderMessages(): void {
		const capture = dependencies.capture();
		if (!capture) return;
		publishMessageStreamSnapshot(deriveMessageStreamSnapshot(capture, getViewState()));
	}

	function render(): void {
		publishArchiveState();
		publishCaptureHeaderState();
		dependencies.getTransport().publishState();
		publishFramingToolbarState();
		publishAnalysisState();
		publishNotesState();
		if (!dependencies.capture()) {
			publishMessageStreamSnapshot(deriveMessageStreamSnapshot(null, getViewState()));
			return;
		}
		renderMessages();
	}

	function subscribeToViewStateChanges(): () => void {
		let previousViewState = getViewState();
		return subscribeToViewState(() => {
			const nextViewState = getViewState();
			const renderChanged =
				nextViewState.filterQuery !== previousViewState.filterQuery ||
				nextViewState.displayMode !== previousViewState.displayMode ||
				nextViewState.showFrameChanges !== previousViewState.showFrameChanges ||
				nextViewState.collapseRuns !== previousViewState.collapseRuns;
			if (renderChanged && dependencies.capture()) renderMessages();
			if (nextViewState.activePanel === "patterns" && previousViewState.activePanel !== "patterns") {
				publishAnalysisState();
			}
			previousViewState = nextViewState;
		});
	}

	return {
		publishArchiveState,
		publishSendState,
		publishCaptureHeaderState,
		publishFramingToolbarState,
		publishAnalysisState,
		publishNotesState,
		renderMessages,
		render,
		subscribeToViewStateChanges
	};
}

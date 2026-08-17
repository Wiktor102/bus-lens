import { createStore } from "@xstate/store";
import type { CanonicalizationJob, CanonicalizationPreflight } from "../persistence/archive-client.ts";
import type {
	AnnotationDeleteInput,
	AnnotationSaveInput,
	ContextSaveInput,
	DialogCommand,
	DialogCommandInput,
	ExportFormat,
	PatternRemarkSaveInput
} from "../features/dialogs/dialog-model.ts";
import { EMPTY_MESSAGE_STREAM_SNAPSHOT, type MessageStreamSnapshot } from "../features/message-stream/message-stream.ts";
import { EMPTY_CAPTURE_HEADER_SNAPSHOT, type CaptureHeaderRuntimeSnapshot } from "../features/capture/capture-header.ts";
import type { SectionFramingUpdate, Capture } from "../features/capture/capture-framing.ts";
import type { SectionMoveAction } from "../features/capture/section-repositioning.ts";
import {
	EMPTY_VIEW_STATE_SNAPSHOT,
	reduceViewState,
	type DisplayMode,
	type SectionViewPreferencePatch,
	type SectionViewPreferenceSeed,
	type ViewPanel,
	type ViewStateAction,
	type ViewStateSnapshot
} from "./view-state.ts";

export type WorkflowState =
	| { status: "idle" }
	| { status: "running"; startedAt: number }
	| { status: "success"; completedAt: number }
	| { status: "failure"; error: string; canRetry: boolean };

export type RecordingWorkflowState =
	| { status: "idle" }
	| { status: "starting"; startedAt: number }
	| { status: "recording"; startedAt: number }
	| { status: "finalizing"; startedAt: number }
	| { status: "finalized"; completedAt: number }
	| { status: "failed"; error: string; canRetry: boolean };

function cloneValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
	if (!value || typeof value !== "object") return value;
	if (seen.has(value as object)) return seen.get(value as object) as T;

	if (value instanceof Date) return new Date(value.getTime()) as T;
	if (value instanceof Map) {
		const copy = new Map<unknown, unknown>();
		seen.set(value, copy);
		value.forEach((item, key) => copy.set(cloneValue(key, seen), cloneValue(item, seen)));
		return copy as T;
	}
	if (value instanceof Set) {
		const copy = new Set<unknown>();
		seen.set(value, copy);
		value.forEach(item => copy.add(cloneValue(item, seen)));
		return copy as T;
	}
	if (Array.isArray(value)) {
		const copy: unknown[] = [];
		seen.set(value, copy);
		value.forEach(item => copy.push(cloneValue(item, seen)));
		return copy as T;
	}

	const copy = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
	seen.set(value as object, copy);
	for (const key of Reflect.ownKeys(value)) {
		if (Object.prototype.propertyIsEnumerable.call(value, key)) {
			copy[key] = cloneValue((value as Record<PropertyKey, unknown>)[key], seen);
		}
	}
	return copy as T;
}

const deeplyFrozenValues = new WeakSet<object>();

function freezeValue<T>(value: T, seen = new WeakSet<object>()): T {
	if (!value || typeof value !== "object" || seen.has(value as object) || deeplyFrozenValues.has(value as object)) return value;
	seen.add(value as object);

	if (value instanceof Map) {
		value.forEach((item, key) => {
			freezeValue(key, seen);
			freezeValue(item, seen);
		});
		if (!Object.isFrozen(value) && !Object.prototype.hasOwnProperty.call(value, "set")) {
			Object.defineProperties(value, {
				set: { value: () => { throw new TypeError("Cannot mutate an application snapshot"); } },
				delete: { value: () => { throw new TypeError("Cannot mutate an application snapshot"); } },
				clear: { value: () => { throw new TypeError("Cannot mutate an application snapshot"); } }
			});
		}
	} else if (value instanceof Set) {
		value.forEach(item => freezeValue(item, seen));
		if (!Object.isFrozen(value) && !Object.prototype.hasOwnProperty.call(value, "add")) {
			Object.defineProperties(value, {
				add: { value: () => { throw new TypeError("Cannot mutate an application snapshot"); } },
				delete: { value: () => { throw new TypeError("Cannot mutate an application snapshot"); } },
				clear: { value: () => { throw new TypeError("Cannot mutate an application snapshot"); } }
			});
		}
	} else {
		for (const key of Reflect.ownKeys(value)) {
			if (Object.prototype.propertyIsEnumerable.call(value, key)) {
				freezeValue((value as Record<PropertyKey, unknown>)[key], seen);
			}
		}
	}

	Object.freeze(value);
	deeplyFrozenValues.add(value as object);
	return value;
}

function cloneAndFreeze<T>(value: T): T {
	return freezeValue(cloneValue(value));
}

/** Message-stream projections already own their complete object graph. */
function freezeShared<T>(value: T): T {
	return freezeValue(value);
}

export const EMPTY_CAPTURE_HEADER_RUNTIME: CaptureHeaderRuntimeSnapshot = cloneAndFreeze({
	captureId: null,
	summary: EMPTY_CAPTURE_HEADER_SNAPSHOT.summary
});

export const IDLE_WORKFLOW: WorkflowState = cloneAndFreeze({ status: "idle" });

export type TransportViewState = {
	connected: boolean;
	recording: boolean;
	recordingCaptureId: string | null;
	connectionLabel: "Disconnected" | "Port connected";
	connectLabel: "Connect port" | "Disconnect";
	recordLabel: "Start capture" | "Stop capture" | "Starting…" | "Saving…" | "Save failed";
	recordDisabled: boolean;
};

export type TransportState = TransportViewState & {
	connection: WorkflowState;
	recordingWorkflow: RecordingWorkflowState;
};

export const EMPTY_TRANSPORT_STATE: TransportState = cloneAndFreeze({
	connected: false,
	recording: false,
	recordingCaptureId: null,
	connectionLabel: "Disconnected",
	connectLabel: "Connect port",
	recordLabel: "Start capture",
	recordDisabled: true,
	connection: IDLE_WORKFLOW,
	recordingWorkflow: { status: "idle" } satisfies RecordingWorkflowState
});

export type SendRuntimeState = {
	sendInFlight: boolean;
	queueRunning: boolean;
	stopQueueRequested: boolean;
	sendWorkflow: WorkflowState;
	queueWorkflow: WorkflowState;
};

export const EMPTY_SEND_RUNTIME_STATE: SendRuntimeState = cloneAndFreeze({
	sendInFlight: false,
	queueRunning: false,
	stopQueueRequested: false,
	sendWorkflow: IDLE_WORKFLOW,
	queueWorkflow: IDLE_WORKFLOW
});

export type CanonicalizationState = {
	open: boolean;
	captureId: string | null;
	captureName: string;
	preflight: CanonicalizationPreflight | null;
	job: CanonicalizationJob | null;
	loading: boolean;
	starting: boolean;
	workflow: WorkflowState;
	error: string | null;
};

export const EMPTY_CANONICALIZATION_STATE: CanonicalizationState = cloneAndFreeze({
	open: false,
	captureId: null,
	captureName: "",
	preflight: null,
	job: null,
	loading: false,
	starting: false,
	workflow: IDLE_WORKFLOW,
	error: null
});

export type PersistenceErrorState = {
	visible: boolean;
	captureId: string | null;
	message: string;
	canRetry: boolean;
	canExportRecovery: boolean;
};

export const EMPTY_PERSISTENCE_ERROR: PersistenceErrorState = cloneAndFreeze({
	visible: false,
	captureId: null,
	message: "",
	canRetry: false,
	canExportRecovery: false
});

export type ToastState = {
	message: string;
	visible: boolean;
};

export const EMPTY_TOAST_STATE: ToastState = cloneAndFreeze({ message: "", visible: false });

export type FramingToolbarState = {
	captureId: string | null;
	disabled: boolean;
	frameSizeLabel: string;
};

export const EMPTY_FRAMING_TOOLBAR_STATE: FramingToolbarState = cloneAndFreeze({
	captureId: null,
	disabled: true,
	frameSizeLabel: "—"
});

export type ApplicationCommand =
	| { type: "transport/connect" }
	| { type: "transport/disconnect" }
	| { type: "transport/toggle-connection" }
	| { type: "recording/toggle" }
	| { type: "capture/set-title"; value: string }
	| { type: "capture/commit-title"; value: string }
	| { type: "capture/set-description"; value: string }
	| { type: "capture/commit-description"; value: string }
	| { type: "capture/open-context" }
	| { type: "capture/duplicate" }
	| { type: "capture/duplicate-archive"; captureId: string }
	| { type: "capture/clear-messages" }
	| { type: "capture/delete-active" }
	| { type: "capture/upgrade-active" }
	| { type: "capture/upgrade"; captureId: string }
	| { type: "capture/delete"; captureId: string }
	| { type: "archive/select"; captureId: string }
	| { type: "archive/toggle-folder"; folderId: string | null }
	| { type: "archive/move-capture"; captureId: string; folderId: string | null }
	| { type: "archive/open-new-capture" }
	| { type: "archive/open-export" }
	| { type: "archive/save-folder"; name: string; editingId: string | null }
	| { type: "archive/delete-folder"; folderId: string }
	| { type: "archive/import-file"; file: File }
	| { type: "storage/upgrade" }
	| { type: "dialog/save-context"; input: ContextSaveInput }
	| { type: "dialog/save-annotation"; input: AnnotationSaveInput }
	| { type: "dialog/delete-annotation"; input: AnnotationDeleteInput }
	| { type: "dialog/save-pattern-remark"; input: PatternRemarkSaveInput }
	| { type: "dialog/export"; format: ExportFormat }
	| { type: "dialog/notify"; message: string }
	| { type: "canonicalization/close" }
	| { type: "canonicalization/download" }
	| { type: "canonicalization/start" }
	| { type: "canonicalization/retry" }
	| { type: "send/set-draft"; value: string }
	| { type: "send/set-delay"; value: number }
	| { type: "send/send"; bytes: number[]; respond?: (sent: boolean) => void }
	| { type: "send/add-to-queue"; bytes: number[] }
	| { type: "send/send-queue-item"; id: string }
	| { type: "send/remove-queue-item"; id: string }
	| { type: "send/replay-history"; id: string }
	| { type: "send/run-queue" }
	| { type: "send/stop-queue" }
	| { type: "send/clear-queue" }
	| { type: "send/clear-history" }
	| { type: "message/open-note"; messageId: string }
	| { type: "message/open-byte-note"; messageId: string; position: number }
	| { type: "message/replay"; messageId: string }
	| { type: "message/open-pattern-remark"; patternId: string }
	| { type: "message/hide"; messageId: string }
	| { type: "message/hide-byte"; messageId: string; position: number }
	| { type: "message/begin-section"; messageId: string; position: number }
	| { type: "message/move-section"; sectionId: string; action: SectionMoveAction }
	| { type: "message/delete-section"; sectionId: string }
	| { type: "message/set-section-framing"; sectionId: string; update: SectionFramingUpdate }
	| { type: "message/set-section-frame-size"; sectionId: string; value: string }
	| { type: "message/set-section-framing-mode"; sectionId: string; value: string }
	| { type: "message/set-section-frame-marker"; sectionId: string; value: string }
	| { type: "message/set-section-marker-position"; sectionId: string; value: string }
	| { type: "message/set-section-frame-time-gap"; sectionId: string; value: string }
	| { type: "message/set-section-collapse"; sectionId: string; collapseRuns: boolean }
	| { type: "message/set-section-collapsed"; sectionId: string; collapsed: boolean }
	| { type: "notes/add-sequence"; start: string | number; end: string | number; text: string }
	| { type: "persistence/retry" }
	| { type: "persistence/export-recovery" }
	| { type: "persistence/dismiss" };

type ApplicationCommandEvent = { type: "command/requested"; command: ApplicationCommand };

export type ApplicationEvent =
	| { type: "view/active-panel-changed"; activePanel: ViewPanel }
	| { type: "view/filter-open-changed"; filterOpen: boolean }
	| { type: "view/filter-query-changed"; filterQuery: string }
	| { type: "view/display-mode-changed"; displayMode: DisplayMode }
	| { type: "view/frame-changes-changed"; showFrameChanges: boolean }
	| { type: "view/collapse-runs-changed"; collapseRuns: boolean }
	| { type: "view/section-preferences-seeded"; captureId: string; sections: readonly SectionViewPreferenceSeed[] }
	| { type: "view/section-preference-changed"; captureId: string; rawStart: number; patch: SectionViewPreferencePatch }
	| { type: "view/section-preference-copied"; captureId: string; fromRawStart: number; toRawStart: number }
	| { type: "view/section-preference-moved"; captureId: string; fromRawStart: number; toRawStart: number }
	| { type: "view/section-preference-deleted"; captureId: string; rawStart: number }
	| { type: "view/section-preferences-reconciled"; captureId: string; rawStarts: readonly number[] }
	| { type: "view/section-preferences-cleared"; captureId: string }
	| { type: "view/replaced"; viewState: ViewStateSnapshot }
	| { type: "capture/selected-changed"; captureId: string | null }
	| { type: "capture-header/runtime-updated"; state: CaptureHeaderRuntimeSnapshot }
	| { type: "dialog/command-changed"; command: DialogCommandInput | null }
	| { type: "canonicalization/changed"; update: Partial<CanonicalizationState> }
	| { type: "transport/connection-started"; startedAt: number }
	| { type: "transport/connection-succeeded"; completedAt: number }
	| { type: "transport/connection-failed"; error: string; canRetry: boolean }
	| { type: "transport/recording-starting"; startedAt: number }
	| { type: "transport/recording-started"; startedAt: number }
	| { type: "transport/recording-finalizing"; startedAt: number }
	| { type: "transport/recording-finalized"; completedAt: number }
	| { type: "transport/recording-failed"; error: string; canRetry: boolean }
	| { type: "transport/view-updated"; view: TransportViewState }
	| { type: "send/started"; startedAt: number }
	| { type: "send/succeeded"; completedAt: number }
	| { type: "send/failed"; error: string; canRetry: boolean }
	| { type: "queue/started"; startedAt: number }
	| { type: "queue/succeeded"; completedAt: number }
	| { type: "queue/failed"; error: string; canRetry: boolean }
	| { type: "send/runtime-updated"; runtime: Pick<SendRuntimeState, "sendInFlight" | "queueRunning" | "stopQueueRequested"> }
	| { type: "framing-toolbar/changed"; state: FramingToolbarState }
	| { type: "message-stream/changed"; state: MessageStreamSnapshot }
	| { type: "toast/changed"; state: ToastState }
	| { type: "persistence-error/changed"; state: PersistenceErrorState }
	| ApplicationCommandEvent;

export type ApplicationSelector<Selected> = (state: ApplicationState) => Selected;

export type ApplicationStore = {
	getSnapshot: () => ApplicationState;
	subscribe: (listener: () => void) => () => void;
	subscribeToCommands: (listener: (command: ApplicationCommand) => void) => () => void;
	send: (event: ApplicationEvent) => void;
	sendCommand: (command: ApplicationCommand) => void;
	select: <Selected>(selector: ApplicationSelector<Selected>) => Selected;
};

export type ApplicationState = Readonly<{
	viewState: ViewStateSnapshot;
	selectedCaptureId: string | null;
	captureHeaderRuntime: CaptureHeaderRuntimeSnapshot;
	dialog: DialogCommand | null;
	canonicalization: CanonicalizationState;
	transport: TransportState;
	send: SendRuntimeState;
	framingToolbar: FramingToolbarState;
	messageStream: MessageStreamSnapshot;
	toast: ToastState;
	persistenceError: PersistenceErrorState;
}>;

function cloneViewStateSnapshot(snapshot: ViewStateSnapshot): ViewStateSnapshot {
	return cloneAndFreeze(snapshot);
}

function createApplicationState(viewState: ViewStateSnapshot, selectedCaptureId: string | null = null): ApplicationState {
	return cloneAndFreeze({
		viewState: cloneViewStateSnapshot(viewState),
		selectedCaptureId,
		captureHeaderRuntime: EMPTY_CAPTURE_HEADER_RUNTIME,
		dialog: null,
		canonicalization: EMPTY_CANONICALIZATION_STATE,
		transport: EMPTY_TRANSPORT_STATE,
		send: EMPTY_SEND_RUNTIME_STATE,
		framingToolbar: EMPTY_FRAMING_TOOLBAR_STATE,
		messageStream: EMPTY_MESSAGE_STREAM_SNAPSHOT,
		toast: EMPTY_TOAST_STATE,
		persistenceError: EMPTY_PERSISTENCE_ERROR
	});
}

function withViewState(state: ApplicationState, action: ViewStateAction): ApplicationState {
	const nextViewState = reduceViewState(state.viewState, action);
	return nextViewState === state.viewState
		? state
		: Object.freeze({ ...state, viewState: cloneViewStateSnapshot(nextViewState) });
}

function workflowFailure(error: string, canRetry: boolean): WorkflowState {
	return { status: "failure", error: String(error), canRetry: Boolean(canRetry) };
}

let nextDialogRequestId = 0;

export function viewStateActionToApplicationEvent(action: ViewStateAction): ApplicationEvent {
	switch (action.type) {
		case "set-active-panel":
			return { type: "view/active-panel-changed", activePanel: action.activePanel };
		case "set-filter-open":
			return { type: "view/filter-open-changed", filterOpen: action.filterOpen };
		case "set-filter-query":
			return { type: "view/filter-query-changed", filterQuery: action.filterQuery };
		case "set-display-mode":
			return { type: "view/display-mode-changed", displayMode: action.displayMode };
		case "set-frame-changes":
			return { type: "view/frame-changes-changed", showFrameChanges: action.showFrameChanges };
		case "set-collapse-runs":
			return { type: "view/collapse-runs-changed", collapseRuns: action.collapseRuns };
		case "seed-section-preferences":
			return { type: "view/section-preferences-seeded", captureId: action.captureId, sections: action.sections };
		case "set-section-preference":
			return {
				type: "view/section-preference-changed",
				captureId: action.captureId,
				rawStart: action.rawStart,
				patch: action.patch
			};
		case "copy-section-preference":
			return {
				type: "view/section-preference-copied",
				captureId: action.captureId,
				fromRawStart: action.fromRawStart,
				toRawStart: action.toRawStart
			};
		case "move-section-preference":
			return {
				type: "view/section-preference-moved",
				captureId: action.captureId,
				fromRawStart: action.fromRawStart,
				toRawStart: action.toRawStart
			};
		case "delete-section-preference":
			return { type: "view/section-preference-deleted", captureId: action.captureId, rawStart: action.rawStart };
		case "reconcile-section-preferences":
			return { type: "view/section-preferences-reconciled", captureId: action.captureId, rawStarts: action.rawStarts };
		case "clear-section-preferences":
			return { type: "view/section-preferences-cleared", captureId: action.captureId };
	}
}

export const selectViewState: ApplicationSelector<ViewStateSnapshot> = state => state.viewState;
export const selectActivePanel: ApplicationSelector<ViewPanel> = state => state.viewState.activePanel;
export const selectDisplayMode: ApplicationSelector<DisplayMode> = state => state.viewState.displayMode;
export const selectSelectedCaptureId: ApplicationSelector<string | null> = state => state.selectedCaptureId;
export const selectCaptureHeaderRuntime: ApplicationSelector<CaptureHeaderRuntimeSnapshot> = state => state.captureHeaderRuntime;
export const selectDialog: ApplicationSelector<DialogCommand | null> = state => state.dialog;
export const selectCanonicalization: ApplicationSelector<CanonicalizationState> = state => state.canonicalization;
export const selectCanonicalizationWorkflow: ApplicationSelector<WorkflowState> = state => state.canonicalization.workflow;
export const selectTransport: ApplicationSelector<TransportState> = state => state.transport;
export const selectConnectionWorkflow: ApplicationSelector<WorkflowState> = state => state.transport.connection;
export const selectRecordingWorkflow: ApplicationSelector<RecordingWorkflowState> = state => state.transport.recordingWorkflow;
export const selectSendRuntime: ApplicationSelector<SendRuntimeState> = state => state.send;
export const selectSendWorkflow: ApplicationSelector<WorkflowState> = state => state.send.sendWorkflow;
export const selectQueueWorkflow: ApplicationSelector<WorkflowState> = state => state.send.queueWorkflow;
export const selectFramingToolbar: ApplicationSelector<FramingToolbarState> = state => state.framingToolbar;
export const selectMessageStream: ApplicationSelector<MessageStreamSnapshot> = state => state.messageStream;
export const selectToast: ApplicationSelector<ToastState> = state => state.toast;
export const selectPersistenceError: ApplicationSelector<PersistenceErrorState> = state => state.persistenceError;

function replaceTransport(state: ApplicationState, update: Partial<TransportState>): ApplicationState {
	return Object.freeze({ ...state, transport: Object.freeze({ ...state.transport, ...update }) });
}

function replaceSend(state: ApplicationState, update: Partial<SendRuntimeState>): ApplicationState {
	return Object.freeze({ ...state, send: Object.freeze({ ...state.send, ...update }) });
}

export function createApplicationStore(
	initialViewState: ViewStateSnapshot = EMPTY_VIEW_STATE_SNAPSHOT
): ApplicationStore {
	const commandListeners = new Set<(command: ApplicationCommand) => void>();
	const store = createStore({
		context: createApplicationState(initialViewState),
		on: {
			"view/active-panel-changed": (state, event: { activePanel: ViewPanel }) =>
				withViewState(state, { type: "set-active-panel", activePanel: event.activePanel }),
			"view/filter-open-changed": (state, event: { filterOpen: boolean }) =>
				withViewState(state, { type: "set-filter-open", filterOpen: event.filterOpen }),
			"view/filter-query-changed": (state, event: { filterQuery: string }) =>
				withViewState(state, { type: "set-filter-query", filterQuery: event.filterQuery }),
			"view/display-mode-changed": (state, event: { displayMode: DisplayMode }) =>
				withViewState(state, { type: "set-display-mode", displayMode: event.displayMode }),
			"view/frame-changes-changed": (state, event: { showFrameChanges: boolean }) =>
				withViewState(state, { type: "set-frame-changes", showFrameChanges: event.showFrameChanges }),
			"view/collapse-runs-changed": (state, event: { collapseRuns: boolean }) =>
				withViewState(state, { type: "set-collapse-runs", collapseRuns: event.collapseRuns }),
			"view/section-preferences-seeded": (state, event: { captureId: string; sections: readonly SectionViewPreferenceSeed[] }) =>
				withViewState(state, { type: "seed-section-preferences", captureId: event.captureId, sections: event.sections }),
			"view/section-preference-changed": (state, event: { captureId: string; rawStart: number; patch: SectionViewPreferencePatch }) =>
				withViewState(state, {
					type: "set-section-preference",
					captureId: event.captureId,
					rawStart: event.rawStart,
					patch: event.patch
				}),
			"view/section-preference-copied": (state, event: { captureId: string; fromRawStart: number; toRawStart: number }) =>
				withViewState(state, {
					type: "copy-section-preference",
					captureId: event.captureId,
					fromRawStart: event.fromRawStart,
					toRawStart: event.toRawStart
				}),
			"view/section-preference-moved": (state, event: { captureId: string; fromRawStart: number; toRawStart: number }) =>
				withViewState(state, {
					type: "move-section-preference",
					captureId: event.captureId,
					fromRawStart: event.fromRawStart,
					toRawStart: event.toRawStart
				}),
			"view/section-preference-deleted": (state, event: { captureId: string; rawStart: number }) =>
				withViewState(state, {
					type: "delete-section-preference",
					captureId: event.captureId,
					rawStart: event.rawStart
				}),
			"view/section-preferences-reconciled": (state, event: { captureId: string; rawStarts: readonly number[] }) =>
				withViewState(state, {
					type: "reconcile-section-preferences",
					captureId: event.captureId,
					rawStarts: event.rawStarts
				}),
			"view/section-preferences-cleared": (state, event: { captureId: string }) =>
				withViewState(state, { type: "clear-section-preferences", captureId: event.captureId }),
			"view/replaced": (state, event: { viewState: ViewStateSnapshot }) =>
				event.viewState === state.viewState
					? state
					: Object.freeze({ ...state, viewState: cloneViewStateSnapshot(event.viewState) }),
			"capture/selected-changed": (state, event: { captureId: string | null }) =>
				Object.freeze({ ...state, selectedCaptureId: event.captureId }),
			"capture-header/runtime-updated": (state, event: { state: CaptureHeaderRuntimeSnapshot }) =>
				Object.freeze({ ...state, captureHeaderRuntime: cloneAndFreeze(event.state) }),
			"dialog/command-changed": (state, event: { command: DialogCommandInput | null }) => {
				if (!event.command) return Object.freeze({ ...state, dialog: null });
				const command = cloneAndFreeze({ ...event.command, requestId: ++nextDialogRequestId }) as DialogCommand;
				return Object.freeze({ ...state, dialog: command });
			},
			"canonicalization/changed": (state, event: { update: Partial<CanonicalizationState> }) =>
				Object.freeze({
					...state,
					canonicalization: cloneAndFreeze({ ...state.canonicalization, ...event.update })
				}),
			"transport/connection-started": (state, event: { startedAt: number }) =>
				replaceTransport(state, { connection: { status: "running", startedAt: event.startedAt } }),
			"transport/connection-succeeded": (state, event: { completedAt: number }) =>
				replaceTransport(state, { connection: { status: "success", completedAt: event.completedAt } }),
			"transport/connection-failed": (state, event: { error: string; canRetry: boolean }) =>
				replaceTransport(state, { connection: workflowFailure(event.error, event.canRetry) }),
			"transport/recording-starting": (state, event: { startedAt: number }) =>
				replaceTransport(state, { recordingWorkflow: { status: "starting", startedAt: event.startedAt } }),
			"transport/recording-started": (state, event: { startedAt: number }) =>
				replaceTransport(state, { recordingWorkflow: { status: "recording", startedAt: event.startedAt } }),
			"transport/recording-finalizing": (state, event: { startedAt: number }) =>
				replaceTransport(state, { recordingWorkflow: { status: "finalizing", startedAt: event.startedAt } }),
			"transport/recording-finalized": (state, event: { completedAt: number }) =>
				replaceTransport(state, { recordingWorkflow: { status: "finalized", completedAt: event.completedAt } }),
			"transport/recording-failed": (state, event: { error: string; canRetry: boolean }) =>
				replaceTransport(state, { recordingWorkflow: { status: "failed", error: String(event.error), canRetry: Boolean(event.canRetry) } }),
			"transport/view-updated": (state, event: { view: TransportViewState }) =>
				replaceTransport(state, { ...event.view }),
			"send/started": (state, event: { startedAt: number }) =>
				replaceSend(state, { sendWorkflow: { status: "running", startedAt: event.startedAt } }),
			"send/succeeded": (state, event: { completedAt: number }) =>
				replaceSend(state, { sendWorkflow: { status: "success", completedAt: event.completedAt } }),
			"send/failed": (state, event: { error: string; canRetry: boolean }) =>
				replaceSend(state, { sendWorkflow: workflowFailure(event.error, event.canRetry) }),
			"queue/started": (state, event: { startedAt: number }) =>
				replaceSend(state, { queueWorkflow: { status: "running", startedAt: event.startedAt } }),
			"queue/succeeded": (state, event: { completedAt: number }) =>
				replaceSend(state, { queueWorkflow: { status: "success", completedAt: event.completedAt } }),
			"queue/failed": (state, event: { error: string; canRetry: boolean }) =>
				replaceSend(state, { queueWorkflow: workflowFailure(event.error, event.canRetry) }),
			"send/runtime-updated": (state, event: { runtime: Pick<SendRuntimeState, "sendInFlight" | "queueRunning" | "stopQueueRequested"> }) =>
				replaceSend(state, { ...event.runtime }),
			"framing-toolbar/changed": (state, event: { state: FramingToolbarState }) =>
				Object.freeze({ ...state, framingToolbar: cloneAndFreeze(event.state) }),
			"message-stream/changed": (state, event: { state: MessageStreamSnapshot }) =>
				Object.freeze({ ...state, messageStream: freezeShared(event.state) }),
			"toast/changed": (state, event: { state: ToastState }) =>
				Object.freeze({ ...state, toast: cloneAndFreeze(event.state) }),
			"persistence-error/changed": (state, event: { state: PersistenceErrorState }) =>
				Object.freeze({ ...state, persistenceError: cloneAndFreeze(event.state) }),
			"command/requested": state => state
		}
	});

	return {
		getSnapshot: () => store.getSnapshot().context,
		subscribe: listener => {
			const subscription = store.subscribe(() => listener());
			return () => subscription.unsubscribe();
		},
		subscribeToCommands: listener => {
			commandListeners.add(listener);
			return () => commandListeners.delete(listener);
		},
		send: event => {
			const eventCopy = { ...event } as ApplicationEvent;
			store.send(eventCopy);
			if (eventCopy.type === "command/requested") {
				const command = eventCopy.command;
				commandListeners.forEach(listener => listener(command));
			}
		},
		sendCommand: command => {
			const commandCopy = { ...command } as ApplicationCommand;
			const event: ApplicationCommandEvent = { type: "command/requested", command: commandCopy };
			store.send(event);
			commandListeners.forEach(listener => listener(commandCopy));
		},
		select: selector => selector(store.getSnapshot().context)
	};
}

/** The application store is the only shared client-state instance. */
export const applicationStore = createApplicationStore();

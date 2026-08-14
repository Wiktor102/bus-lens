import { deriveCaptureHeaderSnapshot } from "../features/capture/capture-header.ts";
import { publishCaptureHeaderSnapshot } from "../features/capture/capture-header-bridge.ts";
import { getViewStateSnapshot, subscribeToViewState } from "../shared/view-state-bridge.ts";
import { deriveMessageStreamSnapshot } from "../features/message-stream/message-stream.ts";
import { selectFramingToolbarSnapshot } from "../features/capture/framing-toolbar.ts";
import type { Capture } from "../features/capture/capture-framing.ts";
import type { SendController } from "../features/send/send-controller.ts";
import type { SerialController } from "../features/transport/serial-controller.ts";
import { applicationStore, type ApplicationStore } from "../shared/application-store.ts";
import type { ViewStateSnapshot } from "../shared/view-state.ts";

export type SnapshotRuntimeDependencies = {
	capture: () => Capture | undefined;
	getTransport: () => Pick<SerialController, "getPort" | "isRecording" | "getRecordingCaptureId" | "publishState">;
	getSendController: () => Pick<SendController, "getStatus"> | undefined;
	getViewStateSnapshot?: () => ViewStateSnapshot;
	applicationStore?: Pick<ApplicationStore, "send">;
};

export type SnapshotRuntime = {
	publishCaptureHeaderState: (capture?: Capture) => void;
	publishSendState: () => void;
	publishFramingToolbarState: (capture?: Capture) => void;
	renderMessages: () => void;
	render: () => void;
	subscribeToViewStateChanges: () => () => void;
};

export function createSnapshotRuntime(dependencies: SnapshotRuntimeDependencies): SnapshotRuntime {
	const getViewState = dependencies.getViewStateSnapshot || getViewStateSnapshot;
	const store = dependencies.applicationStore || applicationStore;

	function publishCaptureHeaderState(capture = dependencies.capture()): void {
		const recordingCaptureId = dependencies.getTransport().getRecordingCaptureId();
		const isRecording = Boolean(capture?.id && recordingCaptureId === String(capture.id));
		publishCaptureHeaderSnapshot(deriveCaptureHeaderSnapshot(capture, isRecording));
	}

	function publishSendState(): void {
		const sendStatus = dependencies.getSendController()?.getStatus() || {
			sendInFlight: false,
			queueRunning: false,
			stopQueueRequested: false
		};
		store.send({ type: "send/runtime-updated", runtime: sendStatus });
	}

	function publishFramingToolbarState(capture = dependencies.capture()): void {
		store.send({
			type: "framing-toolbar/changed",
			state: selectFramingToolbarSnapshot(capture)
		});
	}

	function renderMessages(): void {
		const capture = dependencies.capture();
		if (!capture) return;
		store.send({
			type: "message-stream/changed",
			state: deriveMessageStreamSnapshot(capture, getViewState())
		});
	}

	function render(): void {
		dependencies.getTransport().publishState();
		publishCaptureHeaderState();
		publishFramingToolbarState();
		if (!dependencies.capture()) {
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
			previousViewState = nextViewState;
		});
	}

	return {
		publishCaptureHeaderState,
		publishSendState,
		publishFramingToolbarState,
		renderMessages,
		render,
		subscribeToViewStateChanges
	};
}

import { publishFramingToolbarSnapshot } from "../features/capture/framing-toolbar-bridge.ts";
import { publishSendRuntimeSnapshot } from "../features/send/send-bridge.ts";
import { getViewStateSnapshot, subscribeToViewState } from "../shared/view-state-bridge.ts";
import { deriveMessageStreamSnapshot } from "../features/message-stream/message-stream.ts";
import { publishMessageStreamSnapshot } from "../features/message-stream/message-stream-bridge.ts";
import { selectFramingToolbarSnapshot } from "../features/capture/framing-toolbar.ts";
import type { Capture } from "../features/capture/capture-framing.ts";
import type { SendController } from "../features/send/send-controller.ts";
import type { SerialController } from "../features/transport/serial-controller.ts";
import type { ViewStateSnapshot } from "../shared/view-state.ts";

export type SnapshotRuntimeDependencies = {
	capture: () => Capture | undefined;
	getTransport: () => Pick<SerialController, "getPort" | "isRecording" | "publishState">;
	getSendController: () => Pick<SendController, "getStatus"> | undefined;
	getViewStateSnapshot?: () => ViewStateSnapshot;
};

export type SnapshotRuntime = {
	publishSendState: () => void;
	publishFramingToolbarState: (capture?: Capture) => void;
	renderMessages: () => void;
	render: () => void;
	subscribeToViewStateChanges: () => () => void;
};

export function createSnapshotRuntime(dependencies: SnapshotRuntimeDependencies): SnapshotRuntime {
	const getViewState = dependencies.getViewStateSnapshot || getViewStateSnapshot;

	function publishSendState(): void {
		const sendStatus = dependencies.getSendController()?.getStatus() || {
			sendInFlight: false,
			queueRunning: false,
			stopQueueRequested: false
		};
		const transport = dependencies.getTransport();
		publishSendRuntimeSnapshot({
			connected: Boolean(transport.getPort()?.writable),
			recording: transport.isRecording(),
			sendInFlight: sendStatus.sendInFlight,
			queueRunning: sendStatus.queueRunning,
			stopQueueRequested: sendStatus.stopQueueRequested
		});
	}

	function publishFramingToolbarState(capture = dependencies.capture()): void {
		publishFramingToolbarSnapshot(selectFramingToolbarSnapshot(capture));
	}

	function renderMessages(): void {
		const capture = dependencies.capture();
		if (!capture) return;
		publishMessageStreamSnapshot(deriveMessageStreamSnapshot(capture, getViewState()));
	}

	function render(): void {
		dependencies.getTransport().publishState();
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
		publishSendState,
		publishFramingToolbarState,
		renderMessages,
		render,
		subscribeToViewStateChanges
	};
}

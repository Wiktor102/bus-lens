import assert from "node:assert/strict";
import test from "node:test";
import { getCaptureHeaderSnapshot } from "../src/features/capture/capture-header-bridge.ts";
import type { Capture } from "../src/features/capture/capture-framing.ts";
import { createSnapshotRuntime } from "../src/app/snapshot-runtime.ts";
import { selectFramingToolbar, selectMessageStream, selectSendRuntime, createApplicationStore } from "../src/shared/application-store.ts";
import { EMPTY_VIEW_STATE_SNAPSHOT } from "../src/shared/view-state.ts";

function capture(id: string): Capture {
	return { id, name: id, byteStream: [], frameSections: [], messages: [], notes: [], annotations: {} };
}

test("publishes live header and projections for the selected capture", () => {
	const selectedCapture = capture("selected");
	const store = createApplicationStore();
	const transport = {
		getPort: () => null,
		isRecording: () => true,
		getRecordingCaptureId: () => selectedCapture.id,
		publishState: () => {}
	};
	const snapshots = createSnapshotRuntime({
		capture: () => selectedCapture,
		getTransport: () => transport,
		getSendController: () => undefined,
		getViewStateSnapshot: () => EMPTY_VIEW_STATE_SNAPSHOT,
		applicationStore: store
	});

	snapshots.render();
	assert.equal(getCaptureHeaderSnapshot().captureId, selectedCapture.id);
	assert.equal(getCaptureHeaderSnapshot().live, true);
	assert.equal(selectFramingToolbar(store.getSnapshot()).captureId, selectedCapture.id);
	assert.equal(selectMessageStream(store.getSnapshot()).captureId, selectedCapture.id);
});

test("snapshot runtime publishes framing and message snapshots through the application store", () => {
	const store = createApplicationStore();
	const current: Capture = {
		id: "capture-1",
		byteStream: [{ value: 0xaa, timestamp: 10 }],
		messages: [],
		notes: [],
		frameSections: [{ id: "section-1", start: 0, frameSize: 1 }]
	} as Capture;
	const runtime = createSnapshotRuntime({
		capture: () => current,
		getTransport: () => ({
			getPort: () => null,
			isRecording: () => false,
			getRecordingCaptureId: () => null,
			publishState: () => {}
		}),
		getSendController: () => undefined,
		getViewStateSnapshot: () => EMPTY_VIEW_STATE_SNAPSHOT,
		applicationStore: store
	});

	runtime.publishFramingToolbarState();
	runtime.renderMessages();

	assert.deepEqual(selectFramingToolbar(store.getSnapshot()), {
		captureId: "capture-1",
		disabled: false,
		frameSizeLabel: "1 SECTION · INDEPENDENT FRAMING"
	});
	assert.equal(selectMessageStream(store.getSnapshot()).captureId, "capture-1");
	assert.equal(selectMessageStream(store.getSnapshot()).matchingRows.length, 0);
});

test("snapshot runtime publishes send status through its injected application store", () => {
	const store = createApplicationStore();
	const runtime = createSnapshotRuntime({
		capture: () => undefined,
		getTransport: () => ({
			getPort: () => null,
			isRecording: () => false,
			publishState: () => {}
		}),
		getSendController: () => ({
			getStatus: () => ({ sendInFlight: true, queueRunning: false, stopQueueRequested: false })
		}),
		applicationStore: store
	});

	runtime.publishSendState();

	assert.equal(selectSendRuntime(store.getSnapshot()).sendInFlight, true);
});

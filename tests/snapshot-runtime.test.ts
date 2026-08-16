import assert from "node:assert/strict";
import test from "node:test";
import { getFramingToolbarSnapshot } from "../src/features/capture/framing-toolbar-bridge.ts";
import { getCaptureHeaderSnapshot } from "../src/features/capture/capture-header-bridge.ts";
import type { Capture } from "../src/features/capture/capture-framing.ts";
import { getMessageStreamSnapshot } from "../src/features/message-stream/message-stream-bridge.ts";
import { createSnapshotRuntime } from "../src/app/snapshot-runtime.ts";

function capture(id: string): Capture {
	return { id, name: id, byteStream: [], frameSections: [], messages: [], notes: [], annotations: {} };
}

test("publishes live framing and message snapshots for the selected capture", () => {
	const selectedCapture = capture("selected");
	const transport = {
		getPort: () => null,
		isRecording: () => true,
		getRecordingCaptureId: () => selectedCapture.id,
		publishState: () => {}
	};
	const snapshots = createSnapshotRuntime({
		capture: () => selectedCapture,
		getTransport: () => transport,
		getSendController: () => undefined
	});

	snapshots.render();
	assert.equal(getCaptureHeaderSnapshot().captureId, selectedCapture.id);
	assert.equal(getCaptureHeaderSnapshot().live, true);
	assert.equal(getFramingToolbarSnapshot().captureId, selectedCapture.id);
	assert.equal(getMessageStreamSnapshot().captureId, selectedCapture.id);
});

import assert from "node:assert/strict";
import test from "node:test";
import { getArchiveSnapshot } from "../src/features/archive/archive-bridge.ts";
import { getCaptureHeaderSnapshot } from "../src/features/capture/capture-header-bridge.ts";
import type { Capture } from "../src/features/capture/capture-framing.ts";
import { createSnapshotRuntime } from "../src/app/snapshot-runtime.ts";
import type { AppState } from "../src/shared/app-state.ts";

function capture(id: string): Capture {
	return { id, name: id, byteStream: [], frameSections: [], messages: [], notes: [], annotations: {} };
}

test("marks only the recording target LIVE in the archive and selected header", () => {
	const recordingCapture = capture("recording");
	const selectedCapture = capture("selected");
	let activeId = selectedCapture.id;
	const transport = {
		getPort: () => null,
		isRecording: () => true,
		getRecordingCaptureId: () => recordingCapture.id,
		publishState: () => {}
	};
	const snapshots = createSnapshotRuntime({
		state: { captures: [recordingCapture, selectedCapture], folders: [], unfiledCollapsed: false } as unknown as AppState,
		capture: () => activeId === recordingCapture.id ? recordingCapture : selectedCapture,
		getActiveId: () => activeId,
		getTransport: () => transport,
		getSendController: () => undefined
	});

	snapshots.render();
	assert.deepEqual(getArchiveSnapshot().captures.map(item => [item.id, item.isRecording]), [
		[recordingCapture.id, true],
		[selectedCapture.id, false]
	]);
	assert.equal(getCaptureHeaderSnapshot().captureId, selectedCapture.id);
	assert.equal(getCaptureHeaderSnapshot().live, false);

	activeId = recordingCapture.id;
	snapshots.render();
	assert.equal(getCaptureHeaderSnapshot().captureId, recordingCapture.id);
	assert.equal(getCaptureHeaderSnapshot().live, true);
});

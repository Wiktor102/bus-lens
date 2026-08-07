import assert from "node:assert/strict";
import test from "node:test";
import { createSerialController, MAX_CAPTURE_BYTES } from "../src/features/transport/serial-controller.ts";
import type { Capture } from "../src/features/capture/capture-framing.ts";
import type { AppState } from "../src/shared/app-state.ts";

test("retaining a rolling capture preserves absolute offsets and section starts", () => {
	const capture: Capture = {
		byteStream: Array.from({ length: MAX_CAPTURE_BYTES }, (_, rawOffset) => ({
			rawOffset,
			value: rawOffset & 0xff,
			timestamp: rawOffset,
			direction: "rx"
		})),
		nextRawOffset: MAX_CAPTURE_BYTES,
		frameSections: [{ id: "tail", start: MAX_CAPTURE_BYTES - 1, framingMode: "length", frameSize: 2 }],
		messages: [],
		notes: [],
		annotations: {}
	};
	const controller = createSerialController({
		capture: () => capture,
		state: {} as AppState,
		saveState: () => {},
		showToast: () => {},
		publishCaptureHeaderState: () => {},
		publishFramingToolbarState: () => {},
		publishAnalysisState: () => {},
		publishNotesState: () => {},
		renderMessages: () => {},
		stopSendQueue: () => {}
	});

	controller.queueLiveBytes([0xaa], "rx");
	controller.flushLiveBytes();

	assert.equal(capture.byteStream?.length, MAX_CAPTURE_BYTES);
	assert.equal(capture.byteStream?.[0].rawOffset, 1);
	assert.equal(capture.byteStream?.at(-1)?.rawOffset, MAX_CAPTURE_BYTES);
	assert.equal(capture.nextRawOffset, MAX_CAPTURE_BYTES + 1);
	assert.deepEqual(capture.frameSections?.map(section => section.start), [1, MAX_CAPTURE_BYTES - 1]);
	assert.deepEqual(capture.messages?.at(-1)?.rawOffsets, [MAX_CAPTURE_BYTES - 1, MAX_CAPTURE_BYTES]);
});

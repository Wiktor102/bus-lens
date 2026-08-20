import assert from "node:assert/strict";
import test from "node:test";
import { createLiveStateService } from "../src/app/live-state-service.ts";
import { deriveMessageStreamSnapshot, type MessageStreamSnapshot } from "../src/features/message-stream/message-stream.ts";
import { rebuildPreview, type Capture } from "../src/features/capture/capture-framing.ts";
import { createApplicationStore, selectMessageStream } from "../src/shared/application-store.ts";
import { EMPTY_VIEW_STATE_SNAPSHOT } from "../src/shared/view-state.ts";

function idFactory(prefix: string) {
	let count = 0;
	return () => `${prefix}-${++count}`;
}

function transport() {
	return {
		getPort: () => null,
		isRecording: () => false,
		getRecordingCaptureId: () => null,
		publishState: () => {}
	};
}

function smallCapture(): Capture {
	const current = {
		id: "capture-1",
		frameSize: 2,
		byteStream: [0xaa, 1, 0xaa, 2].map((value, rawOffset) => ({ value, timestamp: rawOffset, rawOffset })),
		messages: [],
		notes: [],
		annotations: {},
		frameSections: [{ id: "section-1", start: 0, frameSize: 2 }]
	} as Capture;
	rebuildPreview(current, idFactory("small-message"));
	return current;
}

function largeCapture(): Capture {
	const byteCount = 20_000;
	const sectionCount = 16;
	const sectionWidth = Math.floor(byteCount / sectionCount);
	const current = {
		id: "large-capture",
		frameSize: 8,
		byteStream: Array.from({ length: byteCount }, (_, rawOffset) => ({
			value: (rawOffset * 29 + 7) % 256,
			timestamp: rawOffset,
			rawOffset
		})),
		messages: [],
		notes: [],
		annotations: {},
		frameSections: Array.from({ length: sectionCount }, (_, index) => ({
			id: `section-${index}`,
			start: index * sectionWidth,
			frameSize: 8
		}))
	} as Capture;
	rebuildPreview(current, idFactory("large-message"));
	return current;
}

function countedDeriver(counter: { value: number }) {
	return (
		capture: Parameters<typeof deriveMessageStreamSnapshot>[0],
		viewState: Parameters<typeof deriveMessageStreamSnapshot>[1],
		options?: Parameters<typeof deriveMessageStreamSnapshot>[2]
	): MessageStreamSnapshot => {
		counter.value += 1;
		return deriveMessageStreamSnapshot(capture, viewState, options);
	};
}

test("effective section view changes derive the stream once and repeated seeding derives zero times", () => {
	const store = createApplicationStore();
	const current = smallCapture();
	const counter = { value: 0 };
	const runtime = createLiveStateService({
		capture: () => current,
		getTransport: transport,
		getSendController: () => undefined,
		applicationStore: store,
		deriveMessageStreamSnapshot: countedDeriver(counter)
	});
	const unsubscribe = runtime.subscribeToViewStateChanges();

	runtime.render();
	assert.equal(counter.value, 1);

	counter.value = 0;
	store.send({
		type: "view/section-preferences-seeded",
		captureId: "capture-1",
		sections: [{ rawStart: 0, collapseRuns: false, collapsed: false }]
	});
	assert.equal(counter.value, 1);

	counter.value = 0;
	store.send({
		type: "view/section-preferences-seeded",
		captureId: "capture-1",
		sections: [{ rawStart: 0, collapseRuns: true, collapsed: true }]
	});
	assert.equal(counter.value, 0);

	store.send({
		type: "view/section-preference-changed",
		captureId: "capture-1",
		rawStart: 0,
		patch: { collapsed: true }
	});
	assert.equal(counter.value, 1);
	assert.equal(selectMessageStream(store.getSnapshot()).entries.some(entry => entry.type === "message"), false);

	unsubscribe();
});

test("a large capture stays at one projection per effective view change", () => {
	const store = createApplicationStore(EMPTY_VIEW_STATE_SNAPSHOT);
	const current = largeCapture();
	const counter = { value: 0 };
	const runtime = createLiveStateService({
		capture: () => current,
		getTransport: transport,
		getSendController: () => undefined,
		applicationStore: store,
		deriveMessageStreamSnapshot: countedDeriver(counter)
	});
	const unsubscribe = runtime.subscribeToViewStateChanges();

	runtime.render();
	assert.equal(counter.value, 1);
	assert.ok(selectMessageStream(store.getSnapshot()).matchingRows.length > 1_000);

	counter.value = 0;
	store.send({
		type: "view/section-preferences-seeded",
		captureId: "large-capture",
		sections: current.frameSections!.map(section => ({
			rawStart: section.start,
			collapseRuns: false,
			collapsed: false
		}))
	});
	assert.equal(counter.value, 1);

	counter.value = 0;
	store.send({
		type: "view/section-preferences-seeded",
		captureId: "large-capture",
		sections: current.frameSections!.map(section => ({
			rawStart: section.start,
			collapseRuns: true,
			collapsed: true
		}))
	});
	assert.equal(counter.value, 0);

	counter.value = 0;
	store.send({
		type: "view/section-preference-changed",
		captureId: "large-capture",
		rawStart: current.frameSections![1].start,
		patch: { collapsed: true }
	});
	assert.equal(counter.value, 1);

	unsubscribe();
});

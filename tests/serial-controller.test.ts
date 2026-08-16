import assert from "node:assert/strict";
import test from "node:test";
import { createSerialController, MAX_CAPTURE_BYTES } from "../src/features/transport/serial-controller.ts";
import { deriveCaptureHeaderSnapshot } from "../src/features/capture/capture-header.ts";
import type { AppendCaptureChunkRequest } from "../src/features/transport/capture-append-queue.ts";
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

test("keeps the recording target when the selected capture changes", async () => {
	const recordingCapture: Capture = { id: "recording", byteStream: [], frameSections: [], messages: [], notes: [], annotations: {} };
	const selectedCapture: Capture = { id: "selected", byteStream: [], frameSections: [], messages: [], notes: [], annotations: {} };
	let selected = recordingCapture;
	let recordingCaptureId: string | null = null;
	const controller = createSerialController({
		capture: () => selected,
		state: { captures: [recordingCapture, selectedCapture] } as AppState,
		saveState: () => {},
		showToast: () => {},
		publishCaptureHeaderState: () => {},
		publishFramingToolbarState: () => {},
		publishAnalysisState: () => {},
		publishNotesState: () => {},
		publishTransportState: view => { recordingCaptureId = view.recordingCaptureId; },
		renderMessages: () => {},
		stopSendQueue: () => {}
	});

	await controller.toggleRecording();
	assert.equal(recordingCaptureId, recordingCapture.id);
	selected = selectedCapture;
	controller.queueLiveBytes([0xaa], "rx");
	controller.flushLiveBytes();

	assert.equal(controller.getRecordingCaptureId(), recordingCapture.id);
	assert.deepEqual(recordingCapture.byteStream?.map(record => record.value), [0xaa]);
	assert.deepEqual(selectedCapture.byteStream, []);

	await controller.stopRecording();
	assert.equal(controller.getRecordingCaptureId(), null);
	assert.equal(recordingCaptureId, null);
});

test("publishes updated live header stats after a byte flush", async () => {
	const capture: Capture = { id: "live-header", byteStream: [], frameSections: [], messages: [], notes: [], annotations: {} };
	const capturedByteCounts: string[] = [];
	const controller = createSerialController({
		capture: () => capture,
		state: { captures: [capture] } as AppState,
		showToast: () => {},
		publishCaptureHeaderState: current => {
			capturedByteCounts.push(deriveCaptureHeaderSnapshot(current, true).summary.capturedBytes);
		},
		publishFramingToolbarState: () => {},
		renderMessages: () => {},
		stopSendQueue: () => {}
	});

	await controller.toggleRecording();
	controller.queueLiveBytes([0xaa], "rx");
	controller.flushLiveBytes();

	assert.equal(capturedByteCounts.at(-1), "1 B");
	await controller.stopRecording();
});

test("retaining a rolling capture preserves the framing active at the rollover boundary", () => {
	const capture: Capture = {
		byteStream: Array.from({ length: MAX_CAPTURE_BYTES }, (_, rawOffset) => ({
			rawOffset,
			value: rawOffset % 2 === 0 ? 0xaa : 0x55,
			timestamp: rawOffset,
			direction: "rx"
		})),
		nextRawOffset: MAX_CAPTURE_BYTES,
		frameSections: [{ id: "marker", start: 0, framingMode: "marker", frameMarker: "AA", markerPosition: "start" }],
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

	assert.equal(capture.frameSections?.[0]?.start, 1);
	assert.equal(capture.frameSections?.[0]?.framingMode, "marker");
	assert.equal(capture.frameSections?.[0]?.frameMarker, "AA");
	assert.deepEqual(capture.messages?.[0]?.rawOffsets, [2, 3]);
	assert.deepEqual(capture.messages?.[1]?.rawOffsets, [4, 5]);
});

test("canonical stop drains acknowledged appends before finalizing exactly once", async () => {
	const capture: Capture = { id: "canonical", byteStream: [], frameSections: [{ id: "section", start: 0, framingMode: "length", frameSize: 2 }], messages: [], notes: [], annotations: {} };
	const events: string[] = [];
	const appendRequests: AppendCaptureChunkRequest[] = [];
	let finalizeCount = 0;
	const controller = createSerialController({
		capture: () => capture,
		state: { captures: [capture] } as AppState,
		saveState: () => { throw new Error("canonical recording must not use saveState"); },
		showToast: message => events.push(`toast:${message}`),
		publishCaptureHeaderState: () => {},
		publishFramingToolbarState: () => {},
		publishAnalysisState: () => {},
		publishNotesState: () => {},
		renderMessages: () => {},
		stopSendQueue: () => {},
		recordingWriter: {
			startSession: async (_captureId, sessionId) => {
				events.push("start");
				return { sessionId, nextChunkSequence: 0, nextRawOffset: 0, dataRevision: 0 };
			},
				appendChunk: async request => {
					appendRequests.push(request);
					events.push(`append:${request.sequence}:${request.expectedStartOffset}`);
				const count = request.segments.reduce((total, segment) => total + segment.bytes.length, 0);
				return { acceptedStartOffset: request.expectedStartOffset, acceptedEndOffset: request.expectedStartOffset + count, nextRawOffset: request.expectedStartOffset + count, nextSequence: request.sequence + 1, dataRevision: 1 };
			},
			finalizeSession: async (_captureId, _sessionId, expectedDataRevision) => {
				finalizeCount++;
				events.push(`finalize:${expectedDataRevision}`);
			},
			refreshCapture: async () => {
				events.push("refresh");
				return { ...capture, lifecycle: "finalized" } as Capture;
			}
		}
	});

	await controller.toggleRecording();
	controller.queueLiveBytes([0x10, 0x11], "rx");
	controller.flushLiveBytes();
	const firstStop = controller.stopRecording({ notify: true });
	const repeatedStop = controller.stopRecording({ notify: true });
	await Promise.all([firstStop, repeatedStop]);

	assert.equal(finalizeCount, 1);
	assert.deepEqual(events.filter(event => /^(start|append|finalize|refresh)/.test(event)), ["start", "refresh", "append:0:0", "finalize:1", "refresh"]);
	assert.equal(appendRequests.length, 1);
	assert.deepEqual(appendRequests[0].segments.map(segment => ({ direction: segment.direction, bytes: segment.bytes })), [
		{ direction: "rx", bytes: [0x10, 0x11] }
	]);
	assert.equal(events.at(-1), "toast:Capture finalized and stored");
	assert.equal(controller.hasUnacknowledgedBytes(), false);
	assert.equal((capture as Capture & { lifecycle?: string }).lifecycle, "finalized");
});

test("append failure keeps recovery bytes and retry resumes from the acknowledged boundary", async () => {
	const capture: Capture = { id: "recoverable", byteStream: [], frameSections: [{ id: "section", start: 0, framingMode: "length", frameSize: 2 }], messages: [], notes: [], annotations: {} };
	const requests: Array<{ requestId: string; sequence: number; expectedStartOffset: number }> = [];
	const persistentErrors: Array<string | null> = [];
	let fail = true;
	let finalized = false;
	const controller = createSerialController({
		capture: () => capture,
		state: { captures: [capture] } as AppState,
		saveState: () => {},
		showToast: () => {},
		publishCaptureHeaderState: () => {},
		publishFramingToolbarState: () => {},
		publishAnalysisState: () => {},
		publishNotesState: () => {},
		renderMessages: () => {},
		stopSendQueue: () => {},
		publishPersistenceError: error => persistentErrors.push(error?.message ?? null),
		recordingWriter: {
			startSession: async (_captureId, sessionId) => ({ sessionId, nextChunkSequence: 3, nextRawOffset: 9, dataRevision: 4 }),
			appendChunk: async request => {
				requests.push({ requestId: request.requestId, sequence: request.sequence, expectedStartOffset: request.expectedStartOffset });
				if (fail) throw new Error("network unavailable");
				return { acceptedStartOffset: 9, acceptedEndOffset: 11, nextRawOffset: 11, nextSequence: 4, dataRevision: 5 };
			},
			finalizeSession: async (_captureId, _sessionId, revision) => {
				assert.equal(revision, 5);
				finalized = true;
			}
		}
	});

	await controller.toggleRecording();
	controller.queueLiveBytes([0xaa, 0xbb], "tx");
	controller.flushLiveBytes();
	await assert.rejects(controller.stopRecording(), /network unavailable/);
	assert.equal(finalized, false);
	assert.equal(controller.hasUnacknowledgedBytes(), true);
	assert.deepEqual(controller.recoveryDocument()?.byteStream?.map(record => record.value), [0xaa, 0xbb]);
	assert.equal(requests[0].sequence, 3);
	assert.equal(requests[0].expectedStartOffset, 9);

	fail = false;
	await controller.retryPersistence();
	assert.equal(finalized, true);
	assert.equal(controller.hasUnacknowledgedBytes(), false);
	assert.equal(requests.length, 2);
	assert.deepEqual(requests[1], requests[0]);
	assert.ok(persistentErrors.includes("network unavailable"));
});

test("transport controller publishes application-owned view and workflow transitions", async () => {
	const capture: Capture = {
		id: "transport-lifecycle",
		baudRate: 115200,
		byteStream: [],
		frameSections: [{ id: "section", start: 0, framingMode: "length", frameSize: 2 }],
		messages: [],
		notes: [],
		annotations: {}
	};
	const views: Array<{ connected: boolean; recording: boolean }> = [];
	const workflows: string[] = [];
	let closed = false;
	const port = {
		readable: null,
		writable: null,
		open: async () => {},
		close: async () => { closed = true; }
	};
	const controller = createSerialController({
		capture: () => capture,
		state: { captures: [capture], folders: [], sendSettings: {}, activeId: capture.id } as AppState,
		showToast: () => {},
		publishFramingToolbarState: () => {},
		publishTransportState: view => views.push({ connected: view.connected, recording: view.recording }),
		publishTransportWorkflow: event => workflows.push(event.type),
		renderMessages: () => {},
		stopSendQueue: () => {},
		serial: { requestPort: async () => port }
	});

	await controller.connect();
	await controller.toggleRecording();
	await controller.stopRecording();
	await controller.disconnect();

	assert.deepEqual(workflows, [
		"transport/connection-started",
		"transport/connection-succeeded",
		"transport/recording-started",
		"transport/recording-succeeded",
		"transport/recording-started",
		"transport/recording-succeeded",
		"transport/connection-started",
		"transport/connection-succeeded"
	]);
	assert.deepEqual(views, [
		{ connected: true, recording: false },
		{ connected: true, recording: true },
		{ connected: true, recording: false },
		{ connected: false, recording: false }
	]);
	assert.equal(closed, true);
});

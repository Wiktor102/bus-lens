import assert from "node:assert/strict";
import test from "node:test";
import { createSerialController, MAX_CAPTURE_BYTES } from "../src/features/transport/serial-controller.ts";
import { createCaptureController } from "../src/features/capture/capture-controller.ts";
import { deriveCaptureHeaderSnapshot } from "../src/features/capture/capture-header.ts";
import type { AppendCaptureChunkRequest } from "../src/features/transport/capture-append-queue.ts";
import type { Capture } from "../src/features/capture/capture-framing.ts";
import type { AppState } from "../src/shared/app-state.ts";
import type { CaptureWriter, FramingSectionRequest } from "../src/persistence/archive-client.ts";

function transportCapture(id: string): Capture {
	return { id, byteStream: [], frameSections: [], messages: [], notes: [], annotations: {} };
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(resolvePromise => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function testSerialPort() {
	return {
		readable: null,
		writable: null,
		open: async () => {},
		close: async () => {}
	};
}

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

test("counts captured TX bytes in live statistics and session bounds", async () => {
	const capture: Capture = { id: "live-tx-header", byteStream: [], frameSections: [], messages: [], notes: [], annotations: {} };
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
	controller.queueLiveBytes([0xbb], "tx");
	controller.flushLiveBytes();

	assert.equal(capturedByteCounts.at(-1), "2 B");
	assert.deepEqual(capture.byteStream?.map(record => record.direction), ["rx", "tx"]);
	assert.ok((capture.captureSessions?.[0]?.firstReceivedAt ?? 0) <= (capture.captureSessions?.[0]?.lastReceivedAt ?? 0));
	await controller.stopRecording();
});

test("opens a directional sniffer capture at 28,800 baud and parses split records", async () => {
	const capture: Capture = {
		id: "sniffer-transport",
		baudRate: 9600,
		inputFormat: "sniffer",
		byteStream: [],
		frameSections: [],
		messages: [],
		notes: [],
		annotations: {}
	};
	let enqueue!: (chunk: Uint8Array) => void;
	let closeStream!: () => void;
	let openedBaudRate: number | undefined;
	const readable = new ReadableStream<Uint8Array>({
		start(streamController) {
			enqueue = chunk => streamController.enqueue(chunk);
			closeStream = () => streamController.close();
		}
	});
	const port = {
		readable,
		writable: null,
		open: async (options: { baudRate: number }) => { openedBaudRate = options.baudRate; },
		close: async () => { closeStream(); }
	};
	const controller = createSerialController({
		capture: () => capture,
		state: { captures: [capture] } as AppState,
		showToast: () => {},
		publishFramingToolbarState: () => {},
		renderMessages: () => {},
		stopSendQueue: () => {},
		serial: { requestPort: async () => port }
	});

	await controller.connect();
	assert.equal(openedBaudRate, 28_800);
	await controller.toggleRecording();
	enqueue(Uint8Array.from([0xa5, 0x00]));
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	enqueue(Uint8Array.from([0x12, 0xa5, 0x01, 0x34]));
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	controller.flushLiveBytes();

	assert.deepEqual(capture.byteStream?.map(record => ({ value: record.value, direction: record.direction })), [
		{ value: 0x12, direction: "rx" },
		{ value: 0x34, direction: "tx" }
	]);
	await controller.stopRecording();
	await controller.disconnect();
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
	const framingStates: Array<{ workflow: string; disabled: boolean }> = [];
	let finalizeCount = 0;
	let controller!: ReturnType<typeof createSerialController>;
	controller = createSerialController({
		capture: () => capture,
		state: { captures: [capture] } as AppState,
		saveState: () => { throw new Error("canonical recording must not use saveState"); },
		showToast: message => events.push(`toast:${message}`),
		publishCaptureHeaderState: () => {},
		publishFramingToolbarState: current => framingStates.push({
			workflow: controller.getRecordingWorkflow(),
			disabled: Boolean(current?.id && controller.isCaptureMutationLocked(String(current.id)))
		}),
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
	const stopStates = framingStates.filter(state => state.workflow === "finalizing" || state.workflow === "finalized");
	assert.ok(stopStates.some(state => state.workflow === "finalizing" && state.disabled));
	assert.deepEqual(stopStates.at(-1), { workflow: "finalized", disabled: false });
});

test("publishes the mutation lock when finalizing without pending live bytes", async () => {
	const capture: Capture = {
		id: "canonical-empty-stop",
		byteStream: [],
		frameSections: [{ id: "section", start: 0, framingMode: "length", frameSize: 2 }],
		messages: [],
		notes: [],
		annotations: {}
	};
	const framingStates: Array<{ workflow: string; disabled: boolean }> = [];
	let controller!: ReturnType<typeof createSerialController>;
	controller = createSerialController({
		capture: () => capture,
		state: { captures: [capture] } as AppState,
		showToast: () => {},
		publishCaptureHeaderState: () => {},
		publishFramingToolbarState: current => framingStates.push({
			workflow: controller.getRecordingWorkflow(),
			disabled: Boolean(current?.id && controller.isCaptureMutationLocked(String(current.id)))
		}),
		publishTransportState: () => {},
		renderMessages: () => {},
		stopSendQueue: () => {},
		recordingWriter: {
			startSession: async (_captureId, sessionId) => ({ sessionId, nextChunkSequence: 0, nextRawOffset: 0, dataRevision: 0 }),
			appendChunk: async request => ({
				acceptedStartOffset: request.expectedStartOffset,
				acceptedEndOffset: request.expectedStartOffset,
				nextRawOffset: request.expectedStartOffset,
				nextSequence: request.sequence + 1,
				dataRevision: 0
			}),
			finalizeSession: async () => {},
			refreshCapture: async () => ({ ...capture, lifecycle: "finalized" } as Capture)
		}
	});

	await controller.toggleRecording();
	framingStates.length = 0;
	await controller.stopRecording();

	assert.deepEqual(framingStates, [
		{ workflow: "finalizing", disabled: true },
		{ workflow: "finalized", disabled: false }
	]);
});

test("a pending start projection refresh does not hold Starting or disable stop", async () => {
	const capture = transportCapture("pending-start-refresh");
	const refreshStarted = deferred<void>();
	const refreshRelease = deferred<Capture>();
	const views: Array<{ label: string; recording: boolean; disabled: boolean }> = [];
	let refreshCount = 0;
	const port = testSerialPort();
	const controller = createSerialController({
		capture: () => capture,
		state: { captures: [capture] } as AppState,
		showToast: () => {},
		publishFramingToolbarState: () => {},
		publishTransportState: view => views.push({ label: view.recordLabel, recording: view.recording, disabled: view.recordDisabled }),
		renderMessages: () => {},
		stopSendQueue: () => {},
		serial: { requestPort: async () => port },
		recordingWriter: {
			startSession: async (_captureId, sessionId) => ({ sessionId, nextChunkSequence: 0, nextRawOffset: 0, dataRevision: 0 }),
			appendChunk: async request => ({
				acceptedStartOffset: request.expectedStartOffset,
				acceptedEndOffset: request.expectedStartOffset,
				nextRawOffset: request.expectedStartOffset,
				nextSequence: request.sequence + 1,
				dataRevision: 0
			}),
			finalizeSession: async () => {},
			refreshCapture: async () => {
				refreshCount++;
				refreshStarted.resolve(undefined);
				return refreshRelease.promise;
			}
		}
	});

	await controller.connect();
	const start = controller.toggleRecording();
	await refreshStarted.promise;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const startCompleted = await Promise.race([
		start.then(() => true),
		new Promise<boolean>(resolve => {
			timer = setTimeout(() => resolve(false), 250);
		})
	]);
	if (timer) clearTimeout(timer);
	const viewAfterStart = views.at(-1);

	const stop = controller.toggleRecording();
	assert.equal(controller.getRecordingWorkflow(), "finalizing");
	refreshRelease.resolve({ ...capture, lifecycle: "finalized" } as Capture);
	await start;
	await stop;
	assert.equal(startCompleted, true);
	assert.deepEqual(viewAfterStart, { label: "Stop capture", recording: true, disabled: false });
	assert.equal(refreshCount, 2);
});

test("a completed start publishes Stop capture", async () => {
	const capture = transportCapture("completed-start");
	const views: Array<{ label: string; recording: boolean; disabled: boolean }> = [];
	const port = testSerialPort();
	const controller = createSerialController({
		capture: () => capture,
		state: { captures: [capture] } as AppState,
		showToast: () => {},
		publishFramingToolbarState: () => {},
		publishTransportState: view => views.push({ label: view.recordLabel, recording: view.recording, disabled: view.recordDisabled }),
		renderMessages: () => {},
		stopSendQueue: () => {},
		serial: { requestPort: async () => port }
	});

	await controller.connect();
	await controller.toggleRecording();

	assert.deepEqual(views.at(-1), { label: "Stop capture", recording: true, disabled: false });
});

test("a completed stop publishes Start capture", async () => {
	const capture = transportCapture("completed-stop");
	const views: Array<{ label: string; recording: boolean; disabled: boolean }> = [];
	const port = testSerialPort();
	const controller = createSerialController({
		capture: () => capture,
		state: { captures: [capture] } as AppState,
		showToast: () => {},
		publishFramingToolbarState: () => {},
		publishTransportState: view => views.push({ label: view.recordLabel, recording: view.recording, disabled: view.recordDisabled }),
		renderMessages: () => {},
		stopSendQueue: () => {},
		serial: { requestPort: async () => port }
	});

	await controller.connect();
	await controller.toggleRecording();
	views.length = 0;
	await controller.stopRecording();

	assert.deepEqual(views.at(-1), { label: "Start capture", recording: false, disabled: false });
});

test("a slow required startSession keeps Starting until the session is established", async () => {
	const capture = transportCapture("slow-start-session");
	const startSessionStarted = deferred<void>();
	const startSessionRelease = deferred<{ sessionId: string; nextChunkSequence: number; nextRawOffset: number; dataRevision: number }>();
	const views: Array<{ label: string; recording: boolean; disabled: boolean }> = [];
	const port = testSerialPort();
	let startedSessionId = "";
	const controller = createSerialController({
		capture: () => capture,
		state: { captures: [capture] } as AppState,
		showToast: () => {},
		publishFramingToolbarState: () => {},
		publishTransportState: view => views.push({ label: view.recordLabel, recording: view.recording, disabled: view.recordDisabled }),
		renderMessages: () => {},
		stopSendQueue: () => {},
		serial: { requestPort: async () => port },
		recordingWriter: {
			startSession: async (_captureId, sessionId) => {
				startedSessionId = sessionId;
				startSessionStarted.resolve(undefined);
				return startSessionRelease.promise;
			},
			appendChunk: async request => ({
				acceptedStartOffset: request.expectedStartOffset,
				acceptedEndOffset: request.expectedStartOffset,
				nextRawOffset: request.expectedStartOffset,
				nextSequence: request.sequence + 1,
				dataRevision: 0
			}),
			finalizeSession: async () => {}
		}
	});

	await controller.connect();
	const start = controller.toggleRecording();
	await startSessionStarted.promise;
	assert.equal(controller.getRecordingWorkflow(), "starting");
	assert.equal(controller.isRecording(), false);
	assert.equal(capture.captureSessions, undefined);
	assert.deepEqual(views.at(-1), { label: "Starting…", recording: false, disabled: true });

	startSessionRelease.resolve({ sessionId: startedSessionId, nextChunkSequence: 0, nextRawOffset: 0, dataRevision: 0 });
	await start;
	assert.deepEqual(views.at(-1), { label: "Stop capture", recording: true, disabled: false });
});

test("finalization waits for an accepted section edit and refreshes that edit", async () => {
	const capture: Capture = {
		id: "barrier",
		storageStatus: "canonical",
		lifecycle: "finalized",
		dataRevision: 0,
		framingDraftRevision: 0,
		activeFramingProfileId: "profile-before",
		byteStream: [
			{ rawOffset: 0, value: 0x10, timestamp: 1, direction: "rx" },
			{ rawOffset: 1, value: 0x11, timestamp: 2, direction: "rx" }
		],
		frameSections: [{ id: "section", start: 0, framingMode: "length", frameSize: 2 }],
		messages: [],
		notes: [],
		annotations: {},
		patternRemarks: {}
	};
	const events: string[] = [];
	const framingRequests: FramingSectionRequest[][] = [];
	let durableSections = capture.frameSections!.map(section => ({ ...section }));
	let releaseDraft!: (value: { captureId: string; revision: number; sections: readonly FramingSectionRequest[]; updatedAt: string }) => void;
	let draftAccepted = false;
	const draftWrite = new Promise<{ captureId: string; revision: number; sections: readonly FramingSectionRequest[]; updatedAt: string }>(resolve => {
		releaseDraft = value => {
			durableSections = value.sections.map(section => ({ ...section }));
			draftAccepted = true;
			resolve(value);
		};
	});
	const writer = {
		startSession: async (_captureId: string, sessionId: string) => {
			events.push("start");
			return { sessionId, nextChunkSequence: 0, nextRawOffset: 2, dataRevision: 0 };
		},
		appendChunk: async (_request: AppendCaptureChunkRequest) => ({
			acceptedStartOffset: 2,
			acceptedEndOffset: 2,
			nextRawOffset: 2,
			nextSequence: 1,
			dataRevision: 0
		}),
		finalizeSession: async () => {
			events.push("finalize");
			assert.equal(draftAccepted, true);
		},
		refreshCapture: async () => {
			events.push("refresh");
			return {
				...capture,
				lifecycle: events.includes("finalize") ? "finalized" : "recording",
				frameSections: durableSections.map(section => ({ ...section }))
			} as Capture;
		},
		updateFramingDraft: (request: { captureId: string; sections: readonly FramingSectionRequest[] }) => {
			framingRequests.push(request.sections.map(section => ({ ...section })));
			return draftWrite;
		}
	} as unknown as CaptureWriter;
	let captureController!: ReturnType<typeof createCaptureController>;
	const transport = createSerialController({
		capture: () => capture,
		getCapture: captureId => captureId === capture.id ? capture : undefined,
		state: { captures: [capture] } as AppState,
		showToast: () => {},
		publishCaptureHeaderState: () => {},
		publishFramingToolbarState: () => {},
		publishTransportState: () => {},
		publishTransportWorkflow: event => events.push(event.type),
		renderMessages: () => {},
		stopSendQueue: () => {},
		recordingWriter: writer,
		isCanonicalCapture: () => true,
		waitForCaptureWrites: captureId => captureController.waitForCaptureWrites(captureId)
	});
	captureController = createCaptureController({
		capture: () => capture,
		getCapture: captureId => captureId === capture.id ? capture : undefined,
		getActiveId: () => capture.id,
		setActiveId: () => {},
		render: () => {},
		renderMessages: () => {},
		showToast: () => {},
		transport,
		publishDialogCommand: () => {},
		captureWriter: writer,
		isCanonicalCapture: () => true,
		reportPersistenceFailure: () => {}
	});

	await transport.toggleRecording();
	captureController.setSectionFrameSize("section", 4);
	assert.equal(framingRequests[0]?.[0]?.frameSize, 4);

	const stop = transport.stopRecording();
	assert.equal(transport.getRecordingCaptureId(), capture.id);
	assert.equal(events.includes("finalize"), false);
	captureController.setSectionFrameSize("section", 8);
	assert.equal(framingRequests.length, 1);

	releaseDraft({ captureId: capture.id, revision: 1, sections: framingRequests[0]!, updatedAt: "now" });
	await stop;

	assert.deepEqual(events.filter(event => ["start", "refresh", "finalize"].includes(event)), ["start", "refresh", "finalize", "refresh"]);
	assert.equal(events.indexOf("finalize") < events.lastIndexOf("refresh"), true);
	assert.equal(capture.frameSections?.[0]?.frameSize, 4);
	assert.equal(capture.lifecycle, "finalized");
});

test("finalization does not deadlock a framing retry already owned by the coordinator", async () => {
	const capture: Capture = {
		id: "retry-finalization",
		storageStatus: "canonical",
		lifecycle: "finalized",
		dataRevision: 0,
		framingDraftRevision: 0,
		activeFramingProfileId: "profile-before",
		byteStream: [],
		frameSections: [{ id: "section", start: 0, framingMode: "length", frameSize: 2 }],
		messages: [],
		notes: [],
		annotations: {},
		patternRemarks: {}
	};
	const events: string[] = [];
	let draftAttempts = 0;
	let refreshCount = 0;
	let beginRetryRefresh!: () => void;
	const retryRefreshStarted = new Promise<void>(resolve => { beginRetryRefresh = resolve; });
	let releaseRetryRefresh!: () => void;
	const retryRefresh = new Promise<void>(resolve => { releaseRetryRefresh = resolve; });
	const refreshCapture = async (): Promise<Capture> => {
		refreshCount++;
		events.push(`refresh:${refreshCount}`);
		if (refreshCount === 2) {
			beginRetryRefresh();
			await retryRefresh;
		}
		return {
			...capture,
			lifecycle: events.includes("finalize") ? "finalized" : "recording",
			frameSections: capture.frameSections?.map(section => ({ ...section }))
		} as Capture;
	};
	const captureWriter = {
		updateFramingDraft: async (request: { captureId: string; sections: readonly FramingSectionRequest[] }) => {
			draftAttempts++;
			events.push(`draft:${draftAttempts}`);
			if (draftAttempts === 1) throw new Error("transient framing failure");
			return { captureId: request.captureId, revision: 1, sections: request.sections, updatedAt: "now" };
		}
	} as unknown as CaptureWriter;
	const runtimeWrites = new Map<string, Promise<unknown>>();
	const trackCaptureWrite = (captureId: string, write: Promise<unknown>): void => {
		const previous = runtimeWrites.get(captureId);
		const tracked = previous ? Promise.all([previous, write]) : write;
		runtimeWrites.set(captureId, tracked);
		void tracked.then(
			() => { if (runtimeWrites.get(captureId) === tracked) runtimeWrites.delete(captureId); },
			() => { if (runtimeWrites.get(captureId) === tracked) runtimeWrites.delete(captureId); }
		);
	};
	const waitForCaptureWrite = async (captureId: string): Promise<void> => {
		await runtimeWrites.get(captureId);
	};
	const recordingWriter = {
		startSession: async (_captureId: string, sessionId: string) => ({ sessionId, nextChunkSequence: 0, nextRawOffset: 0, dataRevision: 0 }),
		appendChunk: async (request: AppendCaptureChunkRequest) => ({
			acceptedStartOffset: request.expectedStartOffset,
			acceptedEndOffset: request.expectedStartOffset,
			nextRawOffset: request.expectedStartOffset,
			nextSequence: request.sequence + 1,
			dataRevision: 0
		}),
		finalizeSession: async () => { events.push("finalize"); },
		refreshCapture
	};
	let captureController!: ReturnType<typeof createCaptureController>;
	const transport = createSerialController({
		capture: () => capture,
		getCapture: captureId => captureId === capture.id ? capture : undefined,
		state: { captures: [capture] } as AppState,
		showToast: () => {},
		publishCaptureHeaderState: () => {},
		publishFramingToolbarState: () => {},
		publishTransportState: () => {},
		publishTransportWorkflow: event => events.push(event.type),
		renderMessages: () => {},
		stopSendQueue: () => {},
		recordingWriter,
		isCanonicalCapture: () => true,
		waitForCaptureWrite,
		waitForCaptureWrites: captureId => captureController.waitForCaptureWrites(captureId),
		trackCaptureWrite
	});
	captureController = createCaptureController({
		capture: () => capture,
		getCapture: captureId => captureId === capture.id ? capture : undefined,
		getActiveId: () => capture.id,
		setActiveId: () => {},
		render: () => {},
		renderMessages: () => {},
		showToast: () => {},
		transport,
		publishDialogCommand: () => {},
		captureWriter,
		isCanonicalCapture: () => true,
		waitForCaptureWrite,
		trackCaptureWrite,
		refreshCapture,
		reportPersistenceFailure: () => {}
	});

	await transport.toggleRecording();
	captureController.setSectionFrameSize("section", 4);
	await retryRefreshStarted;
	await Promise.resolve();
	const stop = transport.stopRecording();
	releaseRetryRefresh();

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			stop,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("capture finalization timed out")), 1_000);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}

	assert.equal(draftAttempts, 2);
	assert.equal(events.includes("finalize"), true);
	assert.equal(capture.lifecycle, "finalized");
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

test("failed finalization keeps a locked recovery target until retry succeeds", async () => {
	const capture: Capture = {
		id: "failed-finalization",
		storageStatus: "canonical",
		lifecycle: "finalized",
		byteStream: [],
		frameSections: [{ id: "section", start: 0, framingMode: "length", frameSize: 2 }],
		messages: [],
		notes: [],
		annotations: {}
	};
	let fail = true;
	let finalizeCount = 0;
	let refreshCount = 0;
	const views: Array<{ label: string; recordingCaptureId: string | null; disabled: boolean }> = [];
	const framingStates: Array<{ workflow: string; disabled: boolean }> = [];
	const persistenceErrors: Array<string | null> = [];
	let controller!: ReturnType<typeof createSerialController>;
	controller = createSerialController({
		capture: () => capture,
		getCapture: captureId => captureId === capture.id ? capture : undefined,
		state: { captures: [capture] } as AppState,
		showToast: () => {},
		publishCaptureHeaderState: () => {},
		publishFramingToolbarState: current => framingStates.push({
			workflow: controller.getRecordingWorkflow(),
			disabled: Boolean(current?.id && controller.isCaptureMutationLocked(String(current.id)))
		}),
		publishTransportState: view => views.push({ label: view.recordLabel, recordingCaptureId: view.recordingCaptureId, disabled: view.recordDisabled }),
		publishPersistenceError: error => persistenceErrors.push(error?.message ?? null),
		renderMessages: () => {},
		stopSendQueue: () => {},
		recordingWriter: {
			startSession: async (_captureId, sessionId) => ({ sessionId, nextChunkSequence: 0, nextRawOffset: 0, dataRevision: 0 }),
			appendChunk: async request => ({
				acceptedStartOffset: request.expectedStartOffset,
				acceptedEndOffset: request.expectedStartOffset,
				nextRawOffset: request.expectedStartOffset,
				nextSequence: request.sequence + 1,
				dataRevision: 0
			}),
			finalizeSession: async () => {
				finalizeCount++;
				if (fail) throw new Error("materialization unavailable");
			},
			refreshCapture: async () => {
				refreshCount++;
				return { ...capture, lifecycle: "finalized" } as Capture;
			}
		}
	});

	await controller.toggleRecording();
	await assert.rejects(controller.stopRecording(), /materialization unavailable/);
	assert.equal(controller.getRecordingCaptureId(), capture.id);
	assert.equal(controller.getRecordingWorkflow(), "failed");
	assert.equal(controller.isCaptureMutationLocked(capture.id!), true);
	assert.equal(controller.recoveryDocument()?.id, capture.id);
	assert.equal(capture.lifecycle, "failed");
	assert.equal(refreshCount, 1);
	assert.ok(views.some(view => view.label === "Saving…" && view.recordingCaptureId === capture.id && view.disabled));
	assert.ok(persistenceErrors.includes("materialization unavailable"));
	assert.ok(framingStates.some(state => state.workflow === "finalizing" && state.disabled));
	assert.ok(framingStates.some(state => state.workflow === "failed" && state.disabled));

	fail = false;
	await controller.retryPersistence();
	assert.equal(finalizeCount, 2);
	assert.equal(refreshCount, 2);
	assert.equal(controller.getRecordingCaptureId(), null);
	assert.equal(controller.isCaptureMutationLocked(capture.id!), false);
	assert.equal(capture.lifecycle, "finalized");
	assert.equal(persistenceErrors.at(-1), null);
	assert.deepEqual(framingStates.at(-1), { workflow: "finalized", disabled: false });
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
		"transport/recording-starting",
		"transport/recording-started",
		"transport/recording-finalizing",
		"transport/recording-finalized",
		"transport/connection-started",
		"transport/connection-succeeded"
	]);
	const distinctViews = views.filter((view, index) => {
		const previous = views[index - 1];
		return !previous || previous.connected !== view.connected || previous.recording !== view.recording;
	});
	assert.deepEqual(distinctViews, [
		{ connected: true, recording: false },
		{ connected: true, recording: true },
		{ connected: true, recording: false },
		{ connected: false, recording: false }
	]);
	assert.equal(closed, true);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
	CaptureAppendQueue,
	type AppendCaptureChunkRequest,
	type AppendCaptureChunkResponse
} from "../src/features/transport/capture-append-queue.ts";

function acknowledgement(request: AppendCaptureChunkRequest, dataRevision: number): AppendCaptureChunkResponse {
	const byteCount = request.segments.reduce((total, segment) => total + segment.bytes.length, 0);
	return {
		acceptedStartOffset: request.expectedStartOffset,
		acceptedEndOffset: request.expectedStartOffset + byteCount,
		nextRawOffset: request.expectedStartOffset + byteCount,
		nextSequence: request.sequence + 1,
		dataRevision
	};
}

test("each capture drains an independent sequential append queue from acknowledged boundaries", async () => {
	const requests: AppendCaptureChunkRequest[] = [];
	const queue = new CaptureAppendQueue({
		appendChunk: async request => {
			requests.push(request);
			await Promise.resolve();
			return acknowledgement(request, request.sequence + 10);
		}
	}, { generateRequestId: (() => { let id = 0; return () => `request-${id++}`; })() });
	queue.start("capture-a", { sessionId: "session-a", nextChunkSequence: 0, nextRawOffset: 0, dataRevision: 0 });
	queue.start("capture-b", { sessionId: "session-b", nextChunkSequence: 4, nextRawOffset: 20, dataRevision: 9 });

	queue.enqueue("capture-a", { timestamp: 1, direction: "rx", bytes: [1, 2] });
	const firstFlush = queue.flush("capture-a");
	queue.enqueue("capture-a", { timestamp: 2, direction: "tx", bytes: [3] });
	const overlappingFlush = queue.flush("capture-a");
	queue.enqueue("capture-b", { timestamp: 3, direction: "rx", bytes: [4, 5] });
	await Promise.all([firstFlush, overlappingFlush, queue.flush("capture-b")]);

	const captureARequests = requests.filter(request => request.captureId === "capture-a");
	assert.equal(captureARequests.length, 2);
	assert.deepEqual(captureARequests.map(request => ({ sequence: request.sequence, offset: request.expectedStartOffset, bytes: request.segments.flatMap(segment => segment.bytes) })), [
		{ sequence: 0, offset: 0, bytes: [1, 2] },
		{ sequence: 1, offset: 2, bytes: [3] }
	]);
	assert.deepEqual(queue.boundary("capture-a"), { sessionId: "session-a", nextChunkSequence: 2, nextRawOffset: 3, dataRevision: 11 });
	assert.deepEqual(queue.boundary("capture-b"), { sessionId: "session-b", nextChunkSequence: 5, nextRawOffset: 22, dataRevision: 14 });
	assert.equal(queue.hasUnacknowledgedBytes(), false);
});

test("failed appends retain their stable request and advance only after retry acknowledgement", async () => {
	const requests: AppendCaptureChunkRequest[] = [];
	let fail = true;
	const persistentErrors: unknown[] = [];
	const queue = new CaptureAppendQueue({
		appendChunk: async request => {
			requests.push(request);
			if (fail) throw new Error("offline");
			return acknowledgement(request, 8);
		}
	}, {
		generateRequestId: () => "stable-request",
		onPersistentError: (_captureId, error) => persistentErrors.push(error)
	});
	queue.start("capture", { sessionId: "session", nextChunkSequence: 7, nextRawOffset: 40, dataRevision: 6 });
	queue.enqueue("capture", { timestamp: 10, direction: "rx", bytes: [0xaa, 0xbb] });

	await assert.rejects(queue.flush("capture"), /offline/);
	assert.deepEqual(queue.boundary("capture"), { sessionId: "session", nextChunkSequence: 7, nextRawOffset: 40, dataRevision: 6 });
	assert.deepEqual(queue.recoverySegments("capture"), [{ timestamp: 10, direction: "rx", bytes: [0xaa, 0xbb] }]);
	assert.equal(queue.hasUnacknowledgedBytes("capture"), true);
	assert.equal(persistentErrors.length, 1);

	fail = false;
	await queue.retry("capture");
	assert.equal(requests.length, 2);
	assert.equal(requests[0].requestId, "stable-request");
	assert.deepEqual(requests[1], requests[0]);
	assert.deepEqual(queue.boundary("capture"), { sessionId: "session", nextChunkSequence: 8, nextRawOffset: 42, dataRevision: 8 });
	assert.equal(queue.hasUnacknowledgedBytes("capture"), false);
});

test("backpressure reports queued bytes without dropping recovery data", async () => {
	let release: (() => void) | undefined;
	const held = new Promise<void>(resolve => { release = resolve; });
	const changes: boolean[] = [];
	const queue = new CaptureAppendQueue({
		appendChunk: async request => {
			await held;
			return acknowledgement(request, 1);
		}
	}, {
		backpressureBytes: 3,
		generateRequestId: () => "held-request",
		onBackpressureChange: (_captureId, active) => changes.push(active)
	});
	queue.start("capture", { sessionId: "session", nextChunkSequence: 0, nextRawOffset: 0, dataRevision: 0 });
	queue.enqueue("capture", { timestamp: 1, direction: "rx", bytes: [1, 2, 3, 4] });
	const draining = queue.flush("capture");
	assert.equal(queue.isBackpressured("capture"), true);
	assert.deepEqual(queue.recoverySegments("capture").flatMap(segment => segment.bytes), [1, 2, 3, 4]);
	release?.();
	await draining;
	assert.equal(queue.isBackpressured("capture"), false);
	assert.deepEqual(changes, [true, false]);
});

test("backpressure remains accurate when a batch contains many coalesced segments", async () => {
	let release: (() => void) | undefined;
	const held = new Promise<void>(resolve => { release = resolve; });
	const changes: boolean[] = [];
	const queue = new CaptureAppendQueue({
		appendChunk: async request => {
			await held;
			return acknowledgement(request, 1);
		}
	}, {
		backpressureBytes: 3,
		generateRequestId: () => "coalesced-request",
		onBackpressureChange: (_captureId, active) => changes.push(active)
	});
	queue.start("capture", { sessionId: "session", nextChunkSequence: 0, nextRawOffset: 0, dataRevision: 0 });
	queue.enqueue("capture", { timestamp: 1, direction: "rx", bytes: [1, 2] });
	queue.enqueue("capture", { timestamp: 1, direction: "rx", bytes: [3, 4] });
	const draining = queue.flush("capture");
	assert.equal(queue.isBackpressured("capture"), true);
	release?.();
	await draining;
	assert.equal(queue.isBackpressured("capture"), false);
	assert.deepEqual(changes, [true, false]);
});

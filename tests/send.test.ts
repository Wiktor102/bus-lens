import assert from "node:assert/strict";
import test from "node:test";
import { deriveSendViewModel, parseTransmitHex, type SendSnapshot } from "../src/features/send/send.ts";

test("parses separated, compact, empty, and incomplete transmit hex", () => {
	assert.deepEqual(Array.from(parseTransmitHex("c2:08-5d").bytes || []), [0xc2, 0x08, 0x5d]);
	assert.equal(parseTransmitHex("C2 08 5D").message, "3 bytes ready to send.");
	assert.deepEqual(Array.from(parseTransmitHex(" ").bytes || []), []);
	assert.equal(parseTransmitHex("C2 8").bytes, null);
	assert.equal(parseTransmitHex("C2 8").message, "Use complete hex bytes, for example C2 08 5D.");
});

test("derives send status, validation, controls, and replay state from one snapshot", () => {
	const snapshot: SendSnapshot = {
		connected: true,
		recording: true,
		sendInFlight: false,
		queueRunning: false,
		stopQueueRequested: false,
		draft: "AA BB",
		delayMs: 250,
		queue: [{ id: "queue-1", bytes: [0xaa], createdAt: 1 }],
		history: [
		{
			id: "history-1",
			timestamp: 1,
			bytes: [0xbb],
			origin: "manual",
			ok: false,
			error: "write failed",
			captureId: null
		}
		]
	};

	assert.deepEqual(deriveSendViewModel(snapshot), {
		connected: true,
		statusText: "READY",
		statusClassName: "send-status connected",
		connectionHint: "Sent bytes are recorded as TX in the active capture and in local send history.",
		parsedDraft: {
			bytes: Uint8Array.from([0xaa, 0xbb]),
			message: "2 bytes ready to send."
		},
		draftHintClassName: "transmit-hint ready",
		sendDisabled: false,
		queueDisabled: false,
		queueCount: 1,
		historyCount: 1,
		queueTabCountHidden: false,
		runQueueHidden: false,
		runQueueDisabled: false,
		stopQueueHidden: true,
		stopQueueDisabled: false,
		stopQueueText: "Stop",
		clearQueueDisabled: false,
		clearHistoryDisabled: false,
		replayDisabled: false
	});

	const running = deriveSendViewModel({
		...snapshot,
		queueRunning: true,
		stopQueueRequested: true
	});
	assert.equal(running.statusText, "QUEUE RUNNING");
	assert.equal(running.statusClassName, "send-status connected running");
	assert.equal(running.sendDisabled, true);
	assert.equal(running.queueDisabled, true);
	assert.equal(running.runQueueHidden, true);
	assert.equal(running.stopQueueText, "Stopping…");
	assert.equal(running.stopQueueDisabled, true);
	assert.equal(running.replayDisabled, true);
});

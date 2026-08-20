import assert from "node:assert/strict";
import test from "node:test";
import { createSendController } from "../src/features/send/send-controller.ts";
import type { AppState } from "../src/shared/app-state.ts";

test("send controller publishes send and queue workflow transitions alongside runtime state", async () => {
	const writes: number[][] = [];
	const workflowEvents: string[] = [];
	const runtimeStates: Array<{ sendInFlight: boolean; queueRunning: boolean }> = [];
	const port = {
		readable: null,
		writable: new WritableStream<Uint8Array>({
			write(chunk) {
				writes.push(Array.from(chunk));
			}
		}),
		open: async () => {},
		close: async () => {}
	};
	const state: AppState = {
		captures: [],
		folders: [],
		sendHistory: [],
		sendQueue: [],
		sendSettings: { delayMs: 0, draft: "", baudRate: 115200 }
	};
	let nextId = 0;
	let now = 0;
	const controller = createSendController({
		state,
		capture: () => undefined,
		transport: {
			getPort: () => port,
			isRecording: () => false,
			queueLiveBytes: () => {}
		},
		showToast: () => {},
		publishDialogCommand: () => {},
		publishSendState: () => {
			const status = controller?.getStatus();
			if (status) runtimeStates.push({ sendInFlight: status.sendInFlight, queueRunning: status.queueRunning });
		},
		publishSendWorkflow: event => workflowEvents.push(event.type),
		generateId: () => `id-${++nextId}`,
		now: () => ++now
	});

	assert.equal(await controller.sendBytes([0xaa, 0xbb]), true);
	state.sendQueue.push({ id: "queued", bytes: [0xcc], createdAt: 1 });
	await controller.runSendQueue();

	assert.deepEqual(writes, [[0xaa, 0xbb], [0xcc]]);
	assert.deepEqual(workflowEvents, [
		"send/started",
		"send/succeeded",
		"queue/started",
		"send/started",
		"send/succeeded",
		"queue/succeeded"
	]);
	assert.equal(runtimeStates.some(status => status.sendInFlight), true);
	assert.equal(runtimeStates.some(status => status.queueRunning), true);
	assert.equal(runtimeStates.at(-1)?.sendInFlight, false);
	assert.equal(runtimeStates.at(-1)?.queueRunning, false);
});

test("send destructive actions request a dialog before executing", () => {
	const dialogs: Array<{ type: string; title?: string; action?: { type: string } }> = [];
	const state: AppState = {
		captures: [],
		folders: [],
		sendHistory: [{ id: "history-1", bytes: [0xaa], createdAt: 1, mode: "manual" }],
		sendQueue: [{ id: "queue-1", bytes: [0xbb], createdAt: 1 }],
		sendSettings: { delayMs: 0, draft: "", baudRate: 115200 }
	};
	const controller = createSendController({
		state,
		capture: () => undefined,
		transport: { getPort: () => null, isRecording: () => false, queueLiveBytes: () => {} },
		showToast: () => {},
		publishDialogCommand: command => dialogs.push(command),
		publishSendState: () => {}
	});

	controller.requestClearSendQueue();
	assert.equal(state.sendQueue.length, 1);
	assert.equal(dialogs.at(-1)?.type, "confirmation");
	assert.equal(dialogs.at(-1)?.title, "Clear transmit queue?");
	assert.deepEqual(dialogs.at(-1)?.action, { type: "send/clear-queue" });

	controller.clearSendQueue();
	assert.equal(state.sendQueue.length, 0);

	controller.requestClearSendHistory();
	assert.equal(state.sendHistory.length, 1);
	assert.equal(dialogs.at(-1)?.type, "confirmation");
	assert.equal(dialogs.at(-1)?.title, "Clear send history?");
	assert.deepEqual(dialogs.at(-1)?.action, { type: "send/clear-history" });

	controller.clearSendHistory();
	assert.equal(state.sendHistory.length, 0);
});

test("stopping a running queue publishes a retryable stopped failure and keeps unsent items", async () => {
	let releaseWrite!: () => void;
	let notifyWriteStarted!: () => void;
	const writeStarted = new Promise<void>(resolve => { notifyWriteStarted = resolve; });
	const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
	const workflowEvents: Array<{ type: string; error?: string; canRetry?: boolean }> = [];
	const port = {
		readable: null,
		writable: new WritableStream<Uint8Array>({
			write() {
				notifyWriteStarted();
				return writeGate;
			}
		}),
		open: async () => {},
		close: async () => {}
	};
	const state: AppState = {
		captures: [],
		folders: [],
		sendHistory: [],
		sendQueue: [
			{ id: "queued-1", bytes: [0xaa], createdAt: 1 },
			{ id: "queued-2", bytes: [0xbb], createdAt: 2 }
		],
		sendSettings: { delayMs: 0, draft: "", baudRate: 115200 }
	};
	const controller = createSendController({
		state,
		capture: () => undefined,
		transport: {
			getPort: () => port,
			isRecording: () => false,
			queueLiveBytes: () => {}
		},
		showToast: () => {},
		publishDialogCommand: () => {},
		publishSendState: () => {},
		publishSendWorkflow: event => workflowEvents.push(event),
		now: () => 1
	});

	const running = controller.runSendQueue();
	await writeStarted;
	controller.stopSendQueue();
	releaseWrite();
	await running;

	assert.deepEqual(workflowEvents.map(event => event.type), [
		"queue/started",
		"send/started",
		"send/succeeded",
		"queue/failed"
	]);
	assert.deepEqual(workflowEvents.at(-1), { type: "queue/failed", error: "Queue stopped", canRetry: true });
	assert.deepEqual(state.sendQueue.map(item => item.id), ["queued-2"]);
});

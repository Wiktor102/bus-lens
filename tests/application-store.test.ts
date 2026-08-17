import assert from "node:assert/strict";
import test from "node:test";
import {
	createApplicationStore,
	selectActivePanel,
	selectCanonicalization,
	selectConnectionWorkflow,
	selectDisplayMode,
	selectDialog,
	selectFramingToolbar,
	selectMessageStream,
	selectPersistenceError,
	selectQueueWorkflow,
	selectRecordingWorkflow,
	selectSendWorkflow,
	selectViewState,
	viewStateActionToApplicationEvent
} from "../src/shared/application-store.ts";
import { createTestApplicationStore } from "../src/test-utils/application-store.ts";
import { EMPTY_VIEW_STATE_SNAPSHOT } from "../src/shared/view-state.ts";
import { EMPTY_MESSAGE_STREAM_SNAPSHOT, type MessageStreamSnapshot } from "../src/features/message-stream/message-stream.ts";
import type { CanonicalizationJob, CanonicalizationPreflight } from "../src/persistence/archive-client.ts";
import type { DialogCommandInput } from "../src/features/dialogs/dialog-model.ts";

test("application store changes ViewState only through typed events", () => {
	const store = createTestApplicationStore();
	let updates = 0;
	const unsubscribe = store.subscribe(() => updates++);

	store.send(viewStateActionToApplicationEvent({ type: "set-active-panel", activePanel: "patterns" }));
	store.send({ type: "view/filter-query-changed", filterQuery: "c2 ?? 5d" });

	assert.equal(selectActivePanel(store.getSnapshot()), "patterns");
	assert.equal(selectDisplayMode(store.getSnapshot()), "hex");
	assert.equal(selectViewState(store.getSnapshot()).filterQuery, "c2 ?? 5d");
	assert.equal(updates, 2);
	assert.equal("trigger" in store, false);
	assert.equal("set" in store, false);

	unsubscribe();
});

test("application store instances and selectors stay isolated for tests", () => {
	const first = createApplicationStore();
	const second = createApplicationStore();

	first.send({ type: "view/display-mode-changed", displayMode: "binary" });

	assert.equal(selectDisplayMode(first.getSnapshot()), "binary");
	assert.equal(selectDisplayMode(second.getSnapshot()), "hex");
});

test("application store isolates and freezes snapshot boundaries", () => {
	const initial = { ...EMPTY_VIEW_STATE_SNAPSHOT };
	const store = createApplicationStore(initial);

	initial.filterQuery = "mutated by caller";
	assert.equal(store.getSnapshot().viewState.filterQuery, "");
	assert.equal(Object.isFrozen(EMPTY_VIEW_STATE_SNAPSHOT), true);
	assert.equal(Object.isFrozen(store.getSnapshot()), true);
	assert.equal(Object.isFrozen(store.getSnapshot().viewState), true);

	const exposedState = store.getSnapshot();
	assert.throws(() => {
		(exposedState.viewState as unknown as { filterQuery: string }).filterQuery = "mutated through snapshot";
	}, TypeError);
	assert.equal(store.getSnapshot().viewState.filterQuery, "");

	const replacement = { ...EMPTY_VIEW_STATE_SNAPSHOT, filterQuery: "replacement" };
	store.send({ type: "view/replaced", viewState: replacement });
	replacement.filterQuery = "mutated after send";

	assert.equal(store.getSnapshot().viewState.filterQuery, "replacement");
	assert.notEqual(store.getSnapshot().viewState, replacement);
});

test("application store owns canonicalization and dialog lifecycle state", () => {
	const store = createTestApplicationStore();
	const preflight = {
		captureId: "capture-1",
		status: "legacy-not-canonicalized",
		storageStatus: null,
		existingStorageStatus: null,
		captureSize: 10,
		byteCount: 10,
		messageCount: 2,
		noteCount: 1,
		recordingActive: false,
		isRecording: false,
		eligible: true,
		estimatedEligibility: "eligible"
	} as CanonicalizationPreflight;
	const job = {
		id: "job-1",
		captureId: "capture-1",
		status: "running",
		progress: 0.5,
		verified: false,
		verification: null,
		report: { source: { mutable: true } },
		error: null,
		createdAt: "2026-08-14T00:00:00.000Z",
		updatedAt: "2026-08-14T00:00:01.000Z",
		completedAt: null
	} as CanonicalizationJob;

	store.send({
		type: "canonicalization/changed",
		update: {
			open: true,
			captureId: "capture-1",
			captureName: "Legacy capture",
			preflight,
			job,
			loading: false,
			starting: true,
			workflow: { status: "running", startedAt: 10 }
		}
	});

	assert.equal(selectCanonicalization(store.getSnapshot()).open, true);
	assert.deepEqual(selectCanonicalization(store.getSnapshot()).workflow, { status: "running", startedAt: 10 });
	assert.equal(selectCanonicalization(store.getSnapshot()).preflight?.eligible, true);
	assert.equal(selectCanonicalization(store.getSnapshot()).job?.id, "job-1");

	(preflight as unknown as { eligible: boolean }).eligible = false;
	((job.report as Record<string, unknown>).source as { mutable: boolean }).mutable = false;
	assert.equal(selectCanonicalization(store.getSnapshot()).preflight?.eligible, true);
	assert.equal(
		(selectCanonicalization(store.getSnapshot()).job?.report?.source as { mutable: boolean } | undefined)?.mutable,
		true
	);
	assert.throws(() => {
		(selectCanonicalization(store.getSnapshot()).job as unknown as { progress: number }).progress = 1;
	}, TypeError);

	const dialog: DialogCommandInput = {
		type: "context",
		mode: "edit",
		captureId: "capture-1",
		name: "Legacy capture",
		view: "Temperature",
		folderId: null,
		baudRate: 115200,
		params: [{ key: "mode", value: "legacy" }],
		folders: [{ id: "folder-1", name: "Archive" }]
	};
	store.send({ type: "dialog/command-changed", command: dialog });
	dialog.params[0].key = "mutated";
	dialog.folders[0].name = "mutated";
	const dialogSnapshot = selectDialog(store.getSnapshot());
	assert.equal(dialogSnapshot?.type, "context");
	if (dialogSnapshot?.type !== "context") return;
	assert.equal(dialogSnapshot.params[0].key, "mode");
	assert.equal(dialogSnapshot.folders[0].name, "Archive");
});

test("application store owns message projections without cloning their graph", () => {
	const store = createTestApplicationStore();
	const messageStream = {
		...EMPTY_MESSAGE_STREAM_SNAPSHOT,
		matchingRows: [],
		entries: [],
		signatureCounts: new Map([["AA", 1]])
	} as MessageStreamSnapshot;
	const framingToolbar = { captureId: "capture-1", disabled: false, frameSizeLabel: "1 SECTION" };
	const persistenceError = {
		visible: true,
		captureId: "capture-1",
		message: "write failed",
		canRetry: true,
		canExportRecovery: true
	};

	store.send({ type: "message-stream/changed", state: messageStream });
	store.send({ type: "framing-toolbar/changed", state: framingToolbar });
	store.send({ type: "persistence-error/changed", state: persistenceError });

	assert.strictEqual(selectMessageStream(store.getSnapshot()), messageStream);
	assert.strictEqual(selectMessageStream(store.getSnapshot()).signatureCounts, messageStream.signatureCounts);
	assert.throws(() => messageStream.signatureCounts.set("BB", 2), TypeError);
	framingToolbar.frameSizeLabel = "mutated";
	persistenceError.message = "mutated";

	assert.equal(selectMessageStream(store.getSnapshot()).signatureCounts.has("BB"), false);
	assert.equal(selectFramingToolbar(store.getSnapshot()).frameSizeLabel, "1 SECTION");
	assert.equal(selectPersistenceError(store.getSnapshot()).message, "write failed");
	assert.equal(Object.isFrozen(selectMessageStream(store.getSnapshot())), true);
	assert.equal(Object.isFrozen(selectMessageStream(store.getSnapshot()).matchingRows), true);
	assert.equal(Object.isFrozen(selectFramingToolbar(store.getSnapshot())), true);
	assert.equal(Object.isFrozen(selectPersistenceError(store.getSnapshot())), true);
	assert.throws(() => selectMessageStream(store.getSnapshot()).signatureCounts.set("CC", 3), TypeError);
});

test("transport and send workflow events transition through typed selectors", () => {
	const store = createTestApplicationStore();

	store.send({ type: "transport/connection-started", startedAt: 10 });
	store.send({ type: "transport/recording-starting", startedAt: 11 });
	store.send({ type: "transport/recording-started", startedAt: 11 });
	store.send({ type: "send/started", startedAt: 12 });
	store.send({ type: "queue/started", startedAt: 13 });

	assert.deepEqual(selectConnectionWorkflow(store.getSnapshot()), { status: "running", startedAt: 10 });
	assert.deepEqual(selectRecordingWorkflow(store.getSnapshot()), { status: "recording", startedAt: 11 });
	assert.deepEqual(selectSendWorkflow(store.getSnapshot()), { status: "running", startedAt: 12 });
	assert.deepEqual(selectQueueWorkflow(store.getSnapshot()), { status: "running", startedAt: 13 });

	store.send({ type: "transport/connection-succeeded", completedAt: 20 });
	store.send({ type: "transport/recording-finalizing", startedAt: 21 });
	assert.deepEqual(selectRecordingWorkflow(store.getSnapshot()), { status: "finalizing", startedAt: 21 });
	store.send({ type: "transport/recording-finalized", completedAt: 22 });
	store.send({ type: "transport/recording-failed", error: "append unavailable", canRetry: true });
	store.send({ type: "send/succeeded", completedAt: 23 });
	store.send({ type: "queue/failed", error: "write failed", canRetry: false });

	assert.deepEqual(selectConnectionWorkflow(store.getSnapshot()), { status: "success", completedAt: 20 });
	assert.deepEqual(selectRecordingWorkflow(store.getSnapshot()), {
		status: "failed",
		error: "append unavailable",
		canRetry: true
	});
	assert.deepEqual(selectSendWorkflow(store.getSnapshot()), { status: "success", completedAt: 23 });
	assert.deepEqual(selectQueueWorkflow(store.getSnapshot()), {
		status: "failure",
		error: "write failed",
		canRetry: false
	});
});

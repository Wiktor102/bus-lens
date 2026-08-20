import assert from "node:assert/strict";
import test from "node:test";
import { createAppRuntime } from "../src/app/app-runtime.ts";
import { createArchiveDataLayer } from "../src/data/archive-data-layer.ts";
import { createCaptureController } from "../src/features/capture/capture-controller.ts";
import type { Capture } from "../src/features/capture/capture-framing.ts";
import type { ArchiveClient, ReframeRequest, ReframeResponse } from "../src/persistence/archive-client.ts";
import { applicationStore } from "../src/shared/application-store.ts";
import type { AppState } from "../src/shared/app-state.ts";
import { createTestQueryClient } from "../src/test-utils/query-client.ts";

function makeCapture(id: string): Capture {
	return {
		id,
		name: id,
		description: "",
		view: "",
		baudRate: 115200,
		inputFormat: "binary",
		storageStatus: "canonical",
		lifecycle: "finalized",
		dataRevision: 1,
		contentRevision: 0,
		activeFramingProfileId: "profile-1",
		byteStream: [
			{ rawOffset: 0, value: 1, timestamp: 1, direction: "rx" },
			{ rawOffset: 1, value: 2, timestamp: 2, direction: "rx" }
		],
		frameSections: [{ id: "section-1", start: 0, framingMode: "length", frameSize: 2, collapseRuns: false, collapsed: false }],
		messages: [{ id: "frame-1", timestamp: 1, bytes: [1, 2], rawOffsets: [0, 1], _rawPositions: [0, 1], hidden: false }],
		params: [],
		notes: [],
		annotations: {},
		patternRemarks: {}
	};
}

test("authoritative refresh gives optimistic framing edits owned state outside Query", async () => {
	const captureId = "capture-ownership-regression";
	let serverCapture = makeCapture(captureId);
	let releaseReframe!: () => void;
	let markReframeStarted!: () => void;
	const reframeGate = new Promise<void>(resolve => { releaseReframe = resolve; });
	const reframeStarted = new Promise<void>(resolve => { markReframeStarted = resolve; });
	const client = {
		health: async () => {},
		load: async (): Promise<AppState> => ({
			captures: [structuredClone(serverCapture)],
			folders: [],
			activeId: captureId,
			unfiledCollapsed: false,
			sendQueue: [],
			sendHistory: [],
			sendSettings: {}
		}),
		loadArchiveIndex: async () => ({
			activeId: captureId,
			unfiledCollapsed: false,
			captures: [{ id: captureId, folderId: null, position: 0 }],
			folders: []
		}),
		loadCapture: async () => structuredClone(serverCapture),
		listCaptureSummaries: async () => [{
			id: captureId,
			status: "canonical" as const,
			name: captureId,
			lifecycle: "finalized",
			byteCount: 2,
			createdAt: "",
			updatedAt: "",
			folderId: null
		}],
		reframe: async (_request: ReframeRequest): Promise<ReframeResponse> => {
			markReframeStarted();
			await reframeGate;
			serverCapture = {
				...serverCapture,
				activeFramingProfileId: "profile-2",
				frameSections: [{ ...serverCapture.frameSections![0], id: "section-2", frameSize: 1 }],
				messages: [
					{ ...serverCapture.messages![0], id: "frame-2", bytes: [1], rawOffsets: [0], _rawPositions: [0] },
					{ id: "frame-3", timestamp: 2, bytes: [2], rawOffsets: [1], _rawPositions: [1], hidden: false }
				]
			};
			return {
				captureId,
				profileId: "profile-2",
				version: 2,
				sourceDataRevision: 1,
				retainedStartOffset: 0,
				verified: true
			};
		}
	} as unknown as ArchiveClient;

	applicationStore.send({ type: "capture/selected-changed", captureId: null });
	const archive = createArchiveDataLayer(createTestQueryClient(), client);
	const runtime = createAppRuntime({ archive });
	await runtime.ready;
	const controller = createCaptureController({
		capture: runtime.capture,
		getCapture: runtime.getCapture,
		getCaptures: archive.reads.captures,
		getFolders: archive.reads.folders,
		getActiveId: runtime.getActiveId,
		setActiveId: runtime.setActiveId,
		setActiveCapture: runtime.setActiveCapture,
		trackCaptureWrite: runtime.trackCaptureWrite,
		archiveCommands: archive.commands,
		render: () => {},
		renderMessages: () => {},
		showToast: () => {},
		transport: { isRecording: () => false, stopRecording: async () => {} },
		publishDialogCommand: () => {},
		captureWriter: runtime.captureWriter,
		isCanonicalCapture: runtime.isCanonicalCapture,
		waitForCaptureWrite: runtime.waitForCaptureWrite,
		refreshCapture: runtime.refreshCapture
	});

	try {
		const refreshed = await controller.refreshCapture(captureId);
		const queryCapture = archive.reads.capture(captureId);
		const activeCapture = runtime.capture();
		assert.ok(queryCapture);
		assert.ok(activeCapture);
		assert.strictEqual(refreshed, activeCapture);
		assert.notEqual(activeCapture, queryCapture);
		assert.notEqual(activeCapture.frameSections, queryCapture.frameSections);
		const querySnapshot = structuredClone(queryCapture);

		controller.setSectionFrameSize("section-1", 1);
		await reframeStarted;

		assert.equal(activeCapture.frameSections?.[0]?.frameSize, 1);
		assert.deepEqual(archive.reads.capture(captureId), querySnapshot);
		assert.deepEqual(
			archive.queryClient.getQueryData(archive.queries.capture(captureId).queryKey),
			querySnapshot
		);

		releaseReframe();
		await controller.waitForCaptureWrites(captureId);
	} finally {
		releaseReframe();
		applicationStore.send({ type: "capture/selected-changed", captureId: null });
	}
});

test("reframe waits for an overlapping pre-command refresh to observe its returned profile", async () => {
	const captureId = "capture-refresh-reframe-race";
	let serverCapture = makeCapture(captureId);
	let loadCaptureCalls = 0;
	let releasePreCommandRefresh!: () => void;
	let markPreCommandRefreshStarted!: () => void;
	let markReframeStarted!: () => void;
	const preCommandRefreshGate = new Promise<void>(resolve => { releasePreCommandRefresh = resolve; });
	const preCommandRefreshStarted = new Promise<void>(resolve => { markPreCommandRefreshStarted = resolve; });
	const reframeStarted = new Promise<void>(resolve => { markReframeStarted = resolve; });
	const client = {
		health: async () => {},
		load: async (): Promise<AppState> => ({
			captures: [structuredClone(serverCapture)],
			folders: [],
			activeId: captureId,
			unfiledCollapsed: false,
			sendQueue: [],
			sendHistory: [],
			sendSettings: {}
		}),
		loadArchiveIndex: async () => ({
			activeId: captureId,
			unfiledCollapsed: false,
			captures: [{ id: captureId, folderId: null, position: 0 }],
			folders: []
		}),
		loadCapture: async () => {
			loadCaptureCalls += 1;
			const snapshot = structuredClone(serverCapture);
			if (loadCaptureCalls === 2) {
				markPreCommandRefreshStarted();
				await preCommandRefreshGate;
			}
			return snapshot;
		},
		listCaptureSummaries: async () => [{
			id: captureId,
			status: "canonical" as const,
			name: captureId,
			lifecycle: "finalized",
			byteCount: 2,
			createdAt: "",
			updatedAt: "",
			folderId: null
		}],
		reframe: async (_request: ReframeRequest): Promise<ReframeResponse> => {
			markReframeStarted();
			serverCapture = {
				...serverCapture,
				activeFramingProfileId: "profile-2",
				frameSections: [{ ...serverCapture.frameSections![0], id: "section-2", frameSize: 1 }],
				messages: [
					{ ...serverCapture.messages![0], id: "frame-2", bytes: [1], rawOffsets: [0], _rawPositions: [0] },
					{ id: "frame-3", timestamp: 2, bytes: [2], rawOffsets: [1], _rawPositions: [1], hidden: false }
				]
			};
			return {
				captureId,
				profileId: "profile-2",
				version: 2,
				sourceDataRevision: 1,
				retainedStartOffset: 0,
				verified: true
			};
		}
	} as unknown as ArchiveClient;

	applicationStore.send({ type: "capture/selected-changed", captureId: null });
	const archive = createArchiveDataLayer(createTestQueryClient(), client);
	const runtime = createAppRuntime({ archive });
	await runtime.ready;
	const controller = createCaptureController({
		capture: runtime.capture,
		getCapture: runtime.getCapture,
		getCaptures: archive.reads.captures,
		getFolders: archive.reads.folders,
		getActiveId: runtime.getActiveId,
		setActiveId: runtime.setActiveId,
		setActiveCapture: runtime.setActiveCapture,
		trackCaptureWrite: runtime.trackCaptureWrite,
		archiveCommands: archive.commands,
		render: () => {},
		renderMessages: () => {},
		showToast: () => {},
		transport: { isRecording: () => false, stopRecording: async () => {} },
		publishDialogCommand: () => {},
		captureWriter: runtime.captureWriter,
		isCanonicalCapture: runtime.isCanonicalCapture,
		waitForCaptureWrite: runtime.waitForCaptureWrite,
		refreshCapture: runtime.refreshCapture
	});

	try {
		const preCommandRefresh = controller.refreshCapture(captureId);
		await preCommandRefreshStarted;

		controller.setSectionFrameSize("section-1", 1);
		await reframeStarted;
		// Let writeFraming attach to the still-running QueryClient fetch before
		// releasing it. That fetch deliberately returns the pre-command snapshot.
		await new Promise<void>(resolve => setImmediate(resolve));
		releasePreCommandRefresh();

		await Promise.all([preCommandRefresh, controller.waitForCaptureWrites(captureId)]);
		assert.equal(loadCaptureCalls, 3);
		assert.equal(runtime.capture()?.activeFramingProfileId, "profile-2");
		assert.deepEqual(runtime.capture()?.messages?.map(message => message.id), ["frame-2", "frame-3"]);
	} finally {
		releasePreCommandRefresh();
		applicationStore.send({ type: "capture/selected-changed", captureId: null });
	}
});

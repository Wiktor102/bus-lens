import assert from "node:assert/strict";
import test from "node:test";
import {
	archiveQueryKeys,
	archiveMutationCachePolicy,
	createArchiveMutationOptions,
	createArchiveQueryOptions,
	invalidateArchiveMutationCache,
	type ArchiveMutationSource,
	type ArchiveQueryCache,
	type ArchiveQuerySource
} from "../src/data/archive-queries.ts";
import { createTestQueryClient } from "../src/test-utils/query-client.ts";
import type { AppState } from "../src/shared/app-state.ts";
import type { CaptureState } from "../src/persistence/archive-client.ts";

const archive: AppState = { captures: [], folders: [] };

test("archive query options expose stable typed keys and delegate reads", async () => {
	let loaded = 0;
	const client: ArchiveQuerySource = {
		load: async () => {
			loaded += 1;
			return archive;
		},
		loadCapture: async captureId => ({ id: captureId, messages: [], byteStream: [] }),
		listCaptureSummaries: async () => [],
		getCanonicalizationPreflight: async captureId => ({
			captureId,
			status: "canonical",
			storageStatus: "canonical",
			existingStorageStatus: "canonical",
			captureSize: 0,
			byteCount: 0,
			messageCount: 0,
			noteCount: 0,
			recordingActive: false,
			isRecording: false,
			eligible: false,
			estimatedEligibility: "already-canonical"
		}),
		getCanonicalizationJob: async () => { throw new Error("not used"); },
		getLegacyBackup: async () => { throw new Error("not used"); },
		listNotes: async () => []
	};
	const options = createArchiveQueryOptions(client);
	const queryClient = createTestQueryClient();

	assert.deepEqual(options.snapshot().queryKey, archiveQueryKeys.snapshot());
	assert.deepEqual(options.capture("capture-1").queryKey, archiveQueryKeys.capture("capture-1"));
	assert.deepEqual(options.notes("capture-1").queryKey, archiveQueryKeys.notes("capture-1"));
	assert.deepEqual(await queryClient.fetchQuery(options.snapshot()), archive);
	assert.equal(loaded, 1);
});

test("capture detail keys cannot collide with capture summaries", () => {
	assert.notDeepEqual(archiveQueryKeys.capture("summaries"), archiveQueryKeys.captureSummaries());
});

test("archive mutation options delegate typed commands and attach their cache policy", async () => {
	let savedFolder = "";
	const client: ArchiveMutationSource = {
		migrate: async () => ({ fingerprint: "test", captures: 0, folders: 0, rawBytes: 0, notes: 0, queueEntries: 0, historyEntries: 0 }),
		saveLegacyCaptureDocument: async () => {},
		saveFolder: async folder => { savedFolder = folder.id; },
		deleteFolder: async () => {},
		deleteQueueItem: async () => {},
		deleteHistoryItem: async () => {},
		saveArchiveIndex: async () => {},
		saveSendState: async () => {},
		saveSettings: async () => {},
		createCapture: async () => { throw new Error("not used"); },
		patchMetadata: async () => { throw new Error("not used"); },
		startCanonicalization: async () => { throw new Error("not used"); },
		delete: async () => {}
	};
	const invalidated: unknown[][] = [];
	const queryClient = {
		invalidateQueries: async ({ queryKey }: { queryKey: readonly unknown[] }) => {
			invalidated.push([...queryKey]);
		}
	} as ArchiveQueryCache;
	const options = createArchiveMutationOptions(client, queryClient);

	const folder = { id: "folder-1", name: "Folder", collapsed: false };
	const saveFolder = options.saveFolder();
	await saveFolder.mutationFn!(folder);
	await saveFolder.onSuccess?.(undefined, folder, undefined, {} as never);

	assert.equal(savedFolder, "folder-1");
	assert.deepEqual(invalidated, archiveMutationCachePolicy.saveFolder(folder, undefined));
});

test("archive mutation cache helper applies the centralized typed policy", async () => {
	const invalidated: unknown[][] = [];
	const queryClient = {
		invalidateQueries: async ({ queryKey }: { queryKey: readonly unknown[] }) => {
			invalidated.push([...queryKey]);
		}
	} as ArchiveQueryCache;
	const command = { captureId: "capture-1", patch: { name: "Renamed" } };

	await invalidateArchiveMutationCache(
		queryClient,
		"patchMetadata",
		command,
		{ captureId: "capture-1" } as CaptureState
	);

	assert.deepEqual(invalidated, archiveMutationCachePolicy.patchMetadata(command, {} as CaptureState));
});

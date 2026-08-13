import assert from "node:assert/strict";
import test from "node:test";
import {
	archiveQueryKeys,
	createArchiveMutationOptions,
	createArchiveQueryOptions,
	type ArchiveMutationSource,
	type ArchiveQuerySource
} from "../src/data/archive-queries.ts";
import { createTestQueryClient } from "../src/test-utils/query-client.ts";
import type { AppState } from "../src/shared/app-state.ts";

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

test("archive mutation options delegate typed commands without exposing QueryClient writes", async () => {
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
	const options = createArchiveMutationOptions(client);
	const queryClient = createTestQueryClient();

	await options.saveFolder().mutationFn!({ id: "folder-1", name: "Folder", collapsed: false });

	assert.equal(savedFolder, "folder-1");
});

import { mutationOptions, queryOptions } from "@tanstack/react-query";
import type { ArchiveClient, CanonicalizationJob, CanonicalizationPreflight, MigrationReport } from "../persistence/archive-client.ts";
import type {
	AppState,
	SendSettings,
	StoredFolder
} from "../shared/app-state.ts";
import type { Capture } from "../features/capture/capture-framing.ts";
import type {
	CanonicalNote,
	CreateCaptureRequest,
	PatchMetadataRequest,
	CaptureState
} from "../persistence/archive-client.ts";

const archiveRoot = ["archive"] as const;

/**
 * Query keys are owned by the data layer. Components should consume these
 * factories through query options rather than constructing cache keys inline.
 */
export const archiveQueryKeys = {
	all: archiveRoot,
	snapshot: () => [...archiveRoot, "snapshot"] as const,
	captures: () => [...archiveRoot, "captures"] as const,
	capture: (captureId: string) => [...archiveQueryKeys.captures(), captureId] as const,
	captureSummaries: () => [...archiveQueryKeys.captures(), "summaries"] as const,
	folders: () => [...archiveRoot, "folders"] as const,
	queue: () => [...archiveRoot, "queue"] as const,
	history: () => [...archiveRoot, "history"] as const,
	settings: () => [...archiveRoot, "settings"] as const,
	canonicalization: (captureId: string) => [...archiveQueryKeys.capture(captureId), "canonicalization"] as const,
	canonicalizationJob: (captureId: string, jobId: string) =>
		[...archiveQueryKeys.canonicalization(captureId), "jobs", jobId] as const,
	legacyBackup: (captureId: string) => [...archiveQueryKeys.capture(captureId), "legacy-backup"] as const,
	notes: (captureId: string) => [...archiveQueryKeys.capture(captureId), "notes"] as const
} as const;

export type ArchiveQueryKey =
	| typeof archiveQueryKeys.all
	| ReturnType<typeof archiveQueryKeys.snapshot>
	| ReturnType<typeof archiveQueryKeys.captures>
	| ReturnType<typeof archiveQueryKeys.capture>
	| ReturnType<typeof archiveQueryKeys.captureSummaries>
	| ReturnType<typeof archiveQueryKeys.folders>
	| ReturnType<typeof archiveQueryKeys.queue>
	| ReturnType<typeof archiveQueryKeys.history>
	| ReturnType<typeof archiveQueryKeys.settings>
	| ReturnType<typeof archiveQueryKeys.canonicalization>
	| ReturnType<typeof archiveQueryKeys.canonicalizationJob>
	| ReturnType<typeof archiveQueryKeys.legacyBackup>
	| ReturnType<typeof archiveQueryKeys.notes>;

export type ArchiveQuerySource = Pick<
	ArchiveClient,
	| "load"
	| "loadCapture"
	| "listCaptureSummaries"
	| "getCanonicalizationPreflight"
	| "getCanonicalizationJob"
	| "getLegacyBackup"
	| "listNotes"
>;

export type ArchiveMutationSource = Pick<
	ArchiveClient,
	| "migrate"
	| "saveLegacyCaptureDocument"
	| "saveFolder"
	| "deleteFolder"
	| "deleteQueueItem"
	| "deleteHistoryItem"
	| "saveArchiveIndex"
	| "saveSendState"
	| "saveSettings"
	| "createCapture"
	| "patchMetadata"
	| "startCanonicalization"
	| "delete"
>;

export type SaveArchiveIndexCommand = Readonly<{
	state: AppState;
	activeId: string | null | undefined;
}>;

export type SaveSendStateCommand = Readonly<{
	state: AppState;
}>;

export type SaveSettingsCommand = Readonly<{
	settings: Partial<SendSettings> | undefined;
}>;

export function createArchiveQueryOptions(client: ArchiveQuerySource) {
	return {
		snapshot: () => queryOptions<AppState, Error, AppState, ReturnType<typeof archiveQueryKeys.snapshot>>({
			queryKey: archiveQueryKeys.snapshot(),
			queryFn: () => client.load()
		}),
		capture: (captureId: string) => queryOptions<Capture, Error, Capture, ReturnType<typeof archiveQueryKeys.capture>>({
			queryKey: archiveQueryKeys.capture(captureId),
			queryFn: () => client.loadCapture(captureId),
			enabled: Boolean(captureId)
		}),
		captureSummaries: () => queryOptions({
			queryKey: archiveQueryKeys.captureSummaries(),
			queryFn: () => client.listCaptureSummaries()
		}),
		canonicalizationPreflight: (captureId: string) => queryOptions<CanonicalizationPreflight>({
			queryKey: archiveQueryKeys.canonicalization(captureId),
			queryFn: () => client.getCanonicalizationPreflight(captureId),
			enabled: Boolean(captureId)
		}),
		canonicalizationJob: (captureId: string, jobId: string) => queryOptions<CanonicalizationJob>({
			queryKey: archiveQueryKeys.canonicalizationJob(captureId, jobId),
			queryFn: () => client.getCanonicalizationJob(captureId, jobId),
			enabled: Boolean(captureId && jobId)
		}),
		legacyBackup: (captureId: string) => queryOptions({
			queryKey: archiveQueryKeys.legacyBackup(captureId),
			queryFn: () => client.getLegacyBackup(captureId),
			enabled: Boolean(captureId)
		}),
		notes: (captureId: string) => queryOptions<readonly CanonicalNote[]>({
			queryKey: archiveQueryKeys.notes(captureId),
			queryFn: () => client.listNotes(captureId),
			enabled: Boolean(captureId)
		})
	};
}

export function createArchiveMutationOptions(client: ArchiveMutationSource) {
	return {
		migrate: () => mutationOptions<MigrationReport, Error, AppState>({
			mutationKey: [...archiveRoot, "migrate"],
			mutationFn: archive => client.migrate(archive)
		}),
		saveLegacyCaptureDocument: () => mutationOptions<void, Error, Capture>({
			mutationKey: [...archiveQueryKeys.captures(), "legacy-document", "save"],
			mutationFn: capture => client.saveLegacyCaptureDocument(capture)
		}),
		saveFolder: () => mutationOptions<void, Error, StoredFolder>({
			mutationKey: [...archiveQueryKeys.folders(), "save"],
			mutationFn: folder => client.saveFolder(folder)
		}),
		deleteFolder: () => mutationOptions<void, Error, string>({
			mutationKey: [...archiveQueryKeys.folders(), "delete"],
			mutationFn: folderId => client.deleteFolder(folderId)
		}),
		deleteQueueItem: () => mutationOptions<void, Error, string>({
			mutationKey: [...archiveQueryKeys.queue(), "delete"],
			mutationFn: queueItemId => client.deleteQueueItem(queueItemId)
		}),
		deleteHistoryItem: () => mutationOptions<void, Error, string>({
			mutationKey: [...archiveQueryKeys.history(), "delete"],
			mutationFn: historyItemId => client.deleteHistoryItem(historyItemId)
		}),
		saveArchiveIndex: () => mutationOptions<void, Error, SaveArchiveIndexCommand>({
			mutationKey: [...archiveRoot, "index", "save"],
			mutationFn: command => client.saveArchiveIndex(command.state, command.activeId)
		}),
		saveSendState: () => mutationOptions<void, Error, SaveSendStateCommand>({
			mutationKey: [...archiveRoot, "send-state", "save"],
			mutationFn: command => client.saveSendState(command.state)
		}),
		saveSettings: () => mutationOptions<void, Error, SaveSettingsCommand>({
			mutationKey: [...archiveQueryKeys.settings(), "save"],
			mutationFn: command => client.saveSettings(command.settings)
		}),
		createCapture: () => mutationOptions<CaptureState, Error, CreateCaptureRequest>({
			mutationKey: [...archiveQueryKeys.captures(), "create"],
			mutationFn: command => client.createCapture(command)
		}),
		patchMetadata: () => mutationOptions<CaptureState, Error, PatchMetadataRequest>({
			mutationKey: [...archiveQueryKeys.captures(), "metadata", "patch"],
			mutationFn: command => client.patchMetadata(command)
		}),
		startCanonicalization: () => mutationOptions<CanonicalizationJob, Error, string>({
			mutationKey: [...archiveQueryKeys.captures(), "canonicalization", "start"],
			mutationFn: captureId => client.startCanonicalization(captureId)
		}),
		deleteCapture: () => mutationOptions<void, Error, string>({
			mutationKey: [...archiveQueryKeys.captures(), "delete"],
			mutationFn: captureId => client.delete(captureId)
		})
	};
}

export type ArchiveQueryOptions = ReturnType<typeof createArchiveQueryOptions>;
export type ArchiveMutationOptions = ReturnType<typeof createArchiveMutationOptions>;

import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
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

type ArchiveMutationData = {
	migrate: { variables: AppState; result: MigrationReport };
	saveLegacyCaptureDocument: { variables: Capture; result: void };
	saveFolder: { variables: StoredFolder; result: void };
	deleteFolder: { variables: string; result: void };
	deleteQueueItem: { variables: string; result: void };
	deleteHistoryItem: { variables: string; result: void };
	saveArchiveIndex: { variables: SaveArchiveIndexCommand; result: void };
	saveSendState: { variables: SaveSendStateCommand; result: void };
	saveSettings: { variables: SaveSettingsCommand; result: void };
	createCapture: { variables: CreateCaptureRequest; result: CaptureState };
	patchMetadata: { variables: PatchMetadataRequest; result: CaptureState };
	startCanonicalization: { variables: string; result: CanonicalizationJob };
	deleteCapture: { variables: string; result: void };
};

export type ArchiveMutationName = keyof ArchiveMutationData;
export type ArchiveMutationVariables<Name extends ArchiveMutationName> = ArchiveMutationData[Name]["variables"];
export type ArchiveMutationResult<Name extends ArchiveMutationName> = ArchiveMutationData[Name]["result"];

/** The only cache capability mutation policy code needs from TanStack Query. */
export type ArchiveQueryCache = Pick<QueryClient, "invalidateQueries">;

export type ArchiveMutationCachePolicy = {
	[Name in ArchiveMutationName]: (
		variables: ArchiveMutationVariables<Name>,
		result: ArchiveMutationResult<Name>
	) => readonly ArchiveQueryKey[];
};

/**
 * Server mutations invalidate the query families they can make stale. The
 * policy lives beside the archive keys and mutation factories so callers do
 * not have to reconstruct cache relationships in components.
 */
export const archiveMutationCachePolicy: ArchiveMutationCachePolicy = {
	migrate: () => [archiveQueryKeys.all],
	saveLegacyCaptureDocument: () => [
		archiveQueryKeys.snapshot(),
		archiveQueryKeys.captures(),
		archiveQueryKeys.captureSummaries()
	],
	saveFolder: () => [
		archiveQueryKeys.snapshot(),
		archiveQueryKeys.folders(),
		archiveQueryKeys.captureSummaries()
	],
	deleteFolder: () => [
		archiveQueryKeys.snapshot(),
		archiveQueryKeys.folders(),
		archiveQueryKeys.captureSummaries()
	],
	deleteQueueItem: () => [archiveQueryKeys.snapshot(), archiveQueryKeys.queue()],
	deleteHistoryItem: () => [archiveQueryKeys.snapshot(), archiveQueryKeys.history()],
	saveArchiveIndex: () => [
		archiveQueryKeys.snapshot(),
		archiveQueryKeys.captures(),
		archiveQueryKeys.folders(),
		archiveQueryKeys.captureSummaries()
	],
	saveSendState: () => [
		archiveQueryKeys.snapshot(),
		archiveQueryKeys.queue(),
		archiveQueryKeys.history()
	],
	saveSettings: () => [archiveQueryKeys.snapshot(), archiveQueryKeys.settings()],
	createCapture: (_command, result) => [
		archiveQueryKeys.snapshot(),
		archiveQueryKeys.captures(),
		archiveQueryKeys.captureSummaries(),
		archiveQueryKeys.capture(result.captureId)
	],
	patchMetadata: command => [
		archiveQueryKeys.snapshot(),
		archiveQueryKeys.capture(command.captureId),
		archiveQueryKeys.captureSummaries()
	],
	startCanonicalization: (captureId, job) => [
		archiveQueryKeys.snapshot(),
		archiveQueryKeys.capture(captureId),
		archiveQueryKeys.captureSummaries(),
		archiveQueryKeys.canonicalization(captureId),
		archiveQueryKeys.canonicalizationJob(captureId, job.id)
	],
	deleteCapture: captureId => [
		archiveQueryKeys.snapshot(),
		archiveQueryKeys.captures(),
		archiveQueryKeys.captureSummaries(),
		archiveQueryKeys.capture(captureId)
	]
};

export async function invalidateArchiveMutationCache<Name extends ArchiveMutationName>(
	queryClient: ArchiveQueryCache,
	name: Name,
	variables: ArchiveMutationVariables<Name>,
	result: ArchiveMutationResult<Name>
): Promise<void> {
	await Promise.all(
		archiveMutationCachePolicy[name](variables, result).map(queryKey =>
			queryClient.invalidateQueries({ queryKey })
		)
	);
}

export function createArchiveMutationSuccessHandler<Name extends ArchiveMutationName>(
	queryClient: ArchiveQueryCache,
	name: Name
): (
	result: ArchiveMutationResult<Name>,
	variables: ArchiveMutationVariables<Name>
) => Promise<void> {
	return (result, variables) => invalidateArchiveMutationCache(queryClient, name, variables, result);
}

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

export function createArchiveMutationOptions(client: ArchiveMutationSource, queryClient?: ArchiveQueryCache) {
	return {
		migrate: () => mutationOptions<MigrationReport, Error, AppState>({
			mutationKey: [...archiveRoot, "migrate"],
			mutationFn: archive => client.migrate(archive),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "migrate") : undefined
		}),
		saveLegacyCaptureDocument: () => mutationOptions<void, Error, Capture>({
			mutationKey: [...archiveQueryKeys.captures(), "legacy-document", "save"],
			mutationFn: capture => client.saveLegacyCaptureDocument(capture),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "saveLegacyCaptureDocument") : undefined
		}),
		saveFolder: () => mutationOptions<void, Error, StoredFolder>({
			mutationKey: [...archiveQueryKeys.folders(), "save"],
			mutationFn: folder => client.saveFolder(folder),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "saveFolder") : undefined
		}),
		deleteFolder: () => mutationOptions<void, Error, string>({
			mutationKey: [...archiveQueryKeys.folders(), "delete"],
			mutationFn: folderId => client.deleteFolder(folderId),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "deleteFolder") : undefined
		}),
		deleteQueueItem: () => mutationOptions<void, Error, string>({
			mutationKey: [...archiveQueryKeys.queue(), "delete"],
			mutationFn: queueItemId => client.deleteQueueItem(queueItemId),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "deleteQueueItem") : undefined
		}),
		deleteHistoryItem: () => mutationOptions<void, Error, string>({
			mutationKey: [...archiveQueryKeys.history(), "delete"],
			mutationFn: historyItemId => client.deleteHistoryItem(historyItemId),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "deleteHistoryItem") : undefined
		}),
		saveArchiveIndex: () => mutationOptions<void, Error, SaveArchiveIndexCommand>({
			mutationKey: [...archiveRoot, "index", "save"],
			mutationFn: command => client.saveArchiveIndex(command.state, command.activeId),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "saveArchiveIndex") : undefined
		}),
		saveSendState: () => mutationOptions<void, Error, SaveSendStateCommand>({
			mutationKey: [...archiveRoot, "send-state", "save"],
			mutationFn: command => client.saveSendState(command.state),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "saveSendState") : undefined
		}),
		saveSettings: () => mutationOptions<void, Error, SaveSettingsCommand>({
			mutationKey: [...archiveQueryKeys.settings(), "save"],
			mutationFn: command => client.saveSettings(command.settings),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "saveSettings") : undefined
		}),
		createCapture: () => mutationOptions<CaptureState, Error, CreateCaptureRequest>({
			mutationKey: [...archiveQueryKeys.captures(), "create"],
			mutationFn: command => client.createCapture(command),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "createCapture") : undefined
		}),
		patchMetadata: () => mutationOptions<CaptureState, Error, PatchMetadataRequest>({
			mutationKey: [...archiveQueryKeys.captures(), "metadata", "patch"],
			mutationFn: command => client.patchMetadata(command),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "patchMetadata") : undefined
		}),
		startCanonicalization: () => mutationOptions<CanonicalizationJob, Error, string>({
			mutationKey: [...archiveQueryKeys.captures(), "canonicalization", "start"],
			mutationFn: captureId => client.startCanonicalization(captureId),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "startCanonicalization") : undefined
		}),
		deleteCapture: () => mutationOptions<void, Error, string>({
			mutationKey: [...archiveQueryKeys.captures(), "delete"],
			mutationFn: captureId => client.delete(captureId),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "deleteCapture") : undefined
		})
	};
}

export type ArchiveQueryOptions = ReturnType<typeof createArchiveQueryOptions>;
export type ArchiveMutationOptions = ReturnType<typeof createArchiveMutationOptions>;

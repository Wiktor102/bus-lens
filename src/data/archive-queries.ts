import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import type {
	ArchiveClient,
	ArchiveIndex,
	CanonicalizationJob,
	CanonicalizationPreflight,
	CaptureState,
	CaptureListItem,
	CanonicalNote,
	CreateCaptureRequest,
	MigrationReport,
	PatchMetadataRequest
} from "../persistence/archive-client.ts";
import type {
	AppState,
	SendHistoryEntry,
	SendQueueEntry,
	SendSettings,
	StoredFolder
} from "../shared/app-state.ts";
import type { Capture } from "../features/capture/capture-framing.ts";

const archiveRoot = ["archive"] as const;

/**
 * Query keys are owned by the data layer. Components should consume these
 * factories through query options rather than constructing cache keys inline.
 */
export const archiveQueryKeys = {
	all: archiveRoot,
	snapshot: () => [...archiveRoot, "snapshot"] as const,
	index: () => [...archiveRoot, "index"] as const,
	captures: () => [...archiveRoot, "captures"] as const,
	capture: (captureId: string) => [...archiveQueryKeys.captures(), "detail", captureId] as const,
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
	| ReturnType<typeof archiveQueryKeys.index>
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
> & Partial<Pick<ArchiveClient, "loadArchiveIndex" | "listCaptures" | "listFolders" | "listQueue" | "listHistory" | "loadSettings">>;

export type ArchiveMutationSource = Pick<
	ArchiveClient,
	| "migrate"
	| "saveLegacyCaptureDocument"
	| "saveFolder"
	| "saveQueueItem"
	| "deleteFolder"
	| "deleteQueueItem"
	| "saveHistoryItem"
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
	index: ArchiveIndex;
}>;

export type SaveSendStateCommand = Readonly<{
	queue: readonly SendQueueEntry[];
	history: readonly SendHistoryEntry[];
}>;

export type SaveSettingsCommand = Readonly<{
	settings: Partial<SendSettings> | undefined;
}>;

export type SaveQueueItemCommand = Readonly<{
	item: SendQueueEntry;
	position: number;
}>;

export type SaveHistoryItemCommand = Readonly<{
	item: SendHistoryEntry;
}>;

type ArchiveMutationData = {
	migrate: { variables: AppState; result: MigrationReport };
	saveLegacyCaptureDocument: { variables: Capture; result: void };
	saveFolder: { variables: StoredFolder; result: void };
	saveQueueItem: { variables: SaveQueueItemCommand; result: void };
	deleteFolder: { variables: string; result: void };
	deleteQueueItem: { variables: string; result: void };
	saveHistoryItem: { variables: SaveHistoryItemCommand; result: void };
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

export function normalizeArchiveSettings(settings: Partial<SendSettings> | undefined): SendSettings {
	const savedDelay = Number(settings?.delayMs);
	return {
		delayMs: Number.isFinite(savedDelay) ? Math.max(0, Math.min(600_000, savedDelay)) : 100,
		draft: String(settings?.draft || ""),
		baudRate: Math.max(300, +settings?.baudRate! || 115200)
	};
}

/**
 * Derive the byte-free sidebar representation from either a full capture
 * document or an already projected list item. Keeping this outside the query
 * factory lets command results update the list without refetching it.
 */
export function captureListItem(capture: Capture | CaptureListItem): CaptureListItem {
	const source = capture as Capture & CaptureListItem & { parameters?: unknown };
	const parameters = Array.isArray(source.params)
		? source.params
		: Array.isArray(source.parameters)
			? source.parameters
			: [];
	return {
		id: String(source.id ?? ""),
		name: String(source.name ?? "Untitled capture"),
		description: String(source.description ?? ""),
		view: String(source.view ?? ""),
		folderId: source.folderId ? String(source.folderId) : null,
		params: parameters.flatMap(parameter => {
			if (!parameter || typeof parameter !== "object") return [];
			const value = parameter as { key?: unknown; value?: unknown };
			const key = String(value.key ?? "").trim();
			return key ? [{ key, value: String(value.value ?? "") }] : [];
		}),
		messageCount: Number.isSafeInteger(source.messageCount)
			? Math.max(0, Number(source.messageCount))
			: Array.isArray(source.messages)
				? source.messages.filter(message => !message.hidden).length
				: 0,
		...(source.storageStatus ? { storageStatus: source.storageStatus } : {}),
		...(source.lifecycle === undefined ? {} : { lifecycle: String(source.lifecycle) }),
		...(source.byteCount === undefined ? {} : { byteCount: Number(source.byteCount) }),
		...(source.createdAt === undefined ? {} : { createdAt: String(source.createdAt) }),
		...(source.updatedAt === undefined ? {} : { updatedAt: String(source.updatedAt) })
	};
}

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
	// Legacy recording writes are a durable compatibility path, not a server
	// state refresh signal.  Appending a byte must never refetch the sidebar or
	// place the growing document in Query.
	saveLegacyCaptureDocument: () => [],
	saveFolder: () => [
		archiveQueryKeys.snapshot(),
		archiveQueryKeys.index(),
		archiveQueryKeys.folders(),
		archiveQueryKeys.captureSummaries()
	],
	deleteFolder: () => [
		archiveQueryKeys.snapshot(),
		archiveQueryKeys.folders(),
		archiveQueryKeys.captureSummaries()
	],
	saveQueueItem: () => [archiveQueryKeys.snapshot(), archiveQueryKeys.queue()],
	deleteQueueItem: () => [archiveQueryKeys.snapshot(), archiveQueryKeys.queue()],
	saveHistoryItem: () => [archiveQueryKeys.snapshot(), archiveQueryKeys.history()],
	deleteHistoryItem: () => [archiveQueryKeys.snapshot(), archiveQueryKeys.history()],
	saveArchiveIndex: () => [
		archiveQueryKeys.snapshot(),
		archiveQueryKeys.index()
	],
	saveSendState: () => [
		archiveQueryKeys.snapshot(),
		archiveQueryKeys.queue(),
		archiveQueryKeys.history()
	],
	// Settings are optimistically normalized in the data layer and persisted by
	// its coalescing write queue. Refetching the whole archive for every draft
	// keystroke would undo that batching and needlessly wake unrelated consumers.
	saveSettings: () => [],
	createCapture: () => [archiveQueryKeys.snapshot(), archiveQueryKeys.captures()],
	patchMetadata: () => [archiveQueryKeys.snapshot(), archiveQueryKeys.captures()],
	startCanonicalization: () => [archiveQueryKeys.snapshot(), archiveQueryKeys.captures()],
	deleteCapture: () => [archiveQueryKeys.snapshot(), archiveQueryKeys.captures()]
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
		index: () => queryOptions<ArchiveIndex, Error, ArchiveIndex, ReturnType<typeof archiveQueryKeys.index>>({
			queryKey: archiveQueryKeys.index(),
			queryFn: () => client.loadArchiveIndex ? client.loadArchiveIndex() : client.load().then(state => ({
				activeId: state.activeId ?? null,
				unfiledCollapsed: Boolean(state.unfiledCollapsed),
				captures: state.captures.map((capture, position) => ({ id: String(capture.id), folderId: capture.folderId ?? null, position })),
				folders: state.folders.map((folder, position) => ({ id: String(folder.id), position }))
			}))
		}),
		captures: () => queryOptions<CaptureListItem[], Error, CaptureListItem[], ReturnType<typeof archiveQueryKeys.captures>>({
			queryKey: archiveQueryKeys.captures(),
			queryFn: () => client.listCaptures
				? client.listCaptures().then(captures => captures.map(captureListItem))
				: client.load().then(state => state.captures.map(captureListItem))
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
		folders: () => queryOptions<StoredFolder[], Error, StoredFolder[], ReturnType<typeof archiveQueryKeys.folders>>({
			queryKey: archiveQueryKeys.folders(),
			queryFn: () => client.listFolders ? client.listFolders() : client.load().then(state => state.folders)
		}),
		queue: () => queryOptions<SendQueueEntry[], Error, SendQueueEntry[], ReturnType<typeof archiveQueryKeys.queue>>({
			queryKey: archiveQueryKeys.queue(),
			queryFn: () => client.listQueue ? client.listQueue() : client.load().then(state => state.sendQueue ?? [])
		}),
		history: () => queryOptions<SendHistoryEntry[], Error, SendHistoryEntry[], ReturnType<typeof archiveQueryKeys.history>>({
			queryKey: archiveQueryKeys.history(),
			queryFn: () => client.listHistory ? client.listHistory() : client.load().then(state => state.sendHistory ?? [])
		}),
		settings: () => queryOptions<SendSettings, Error, SendSettings, ReturnType<typeof archiveQueryKeys.settings>>({
			queryKey: archiveQueryKeys.settings(),
			queryFn: () => client.loadSettings
				? client.loadSettings().then(normalizeArchiveSettings)
				: client.load().then(state => normalizeArchiveSettings(state.sendSettings))
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
		saveQueueItem: () => mutationOptions<void, Error, SaveQueueItemCommand>({
			mutationKey: [...archiveQueryKeys.queue(), "save"],
			mutationFn: command => client.saveQueueItem(command.item, command.position),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "saveQueueItem") : undefined
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
		saveHistoryItem: () => mutationOptions<void, Error, SaveHistoryItemCommand>({
			mutationKey: [...archiveQueryKeys.history(), "save"],
			mutationFn: command => client.saveHistoryItem(command.item),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "saveHistoryItem") : undefined
		}),
		deleteHistoryItem: () => mutationOptions<void, Error, string>({
			mutationKey: [...archiveQueryKeys.history(), "delete"],
			mutationFn: historyItemId => client.deleteHistoryItem(historyItemId),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "deleteHistoryItem") : undefined
		}),
	saveArchiveIndex: () => mutationOptions<void, Error, SaveArchiveIndexCommand>({
			mutationKey: [...archiveRoot, "index", "save"],
			mutationFn: command => client.saveArchiveIndex(command.index),
			onSuccess: queryClient ? createArchiveMutationSuccessHandler(queryClient, "saveArchiveIndex") : undefined
		}),
		saveSendState: () => mutationOptions<void, Error, SaveSendStateCommand>({
			mutationKey: [...archiveRoot, "send-state", "save"],
			mutationFn: command => client.saveSendState({
				captures: [],
				folders: [],
				sendQueue: [...command.queue],
				sendHistory: [...command.history]
			}),
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

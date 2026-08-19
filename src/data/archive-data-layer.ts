import { QueryClient } from "@tanstack/react-query";
import {
	archiveQueryKeys,
	createArchiveMutationSuccessHandler,
	createArchiveQueryOptions,
	captureListItem,
	invalidateArchiveMutationCache,
	normalizeArchiveSettings,
	type ArchiveMutationName
} from "./archive-queries.ts";
import {
	ArchiveClient,
	type ArchiveIndex,
	type CanonicalCaptureSummary,
	type CaptureListItem,
	type CanonicalNote,
	type CaptureMetadataPatch,
	type CaptureState,
	type CreateCaptureRequest,
	type LegacyBackupResponse,
	type CanonicalizationJob,
	type CanonicalizationPreflight,
	type PatchMetadataRequest
} from "../persistence/archive-client.ts";
import type { Capture } from "../features/capture/capture-framing.ts";
import {
	loadState,
	MAX_SEND_HISTORY,
	STORAGE_KEY,
	type AppState,
	type SendHistoryEntry,
	type SendQueueEntry,
	type SendSettings,
	type StateStorage,
	type StoredFolder
} from "../shared/app-state.ts";

export type ArchiveDataLayerStorage = StateStorage & {
	removeItem?: (key: string) => void;
};

export type ArchiveCommandError = Error & {
	command?: string;
};

export type ArchiveCommands = {
	hydrate: () => Promise<ArchiveHydration>;
	getArchiveIndex: () => Promise<ArchiveIndex>;
	persistArchiveIndex: (index: ArchiveIndex) => Promise<void>;
	getCapture: (captureId: string) => Promise<Capture>;
	/** Force-fetches the durable active capture projection. */
	refreshCapture: (captureId: string, expectedActiveProfileId?: string) => Promise<Capture>;
	listCaptures: () => Promise<CaptureListItem[]>;
	saveLegacyCapture: (capture: Capture) => Promise<void>;
	createCapture: (request: CreateCaptureRequest) => Promise<CaptureState>;
	patchMetadata: (request: PatchMetadataRequest) => Promise<CaptureState>;
	deleteCapture: (captureId: string) => Promise<void>;
	clearCaptureData: (captureId: string) => Promise<void>;
	duplicateCapture: (captureId: string, duplicateCaptureId?: string) => Promise<void>;
	saveFolder: (folder: StoredFolder) => Promise<void>;
	deleteFolder: (folderId: string) => Promise<void>;
	saveSettings: (settings: Partial<SendSettings>) => Promise<void>;
	saveQueueItem: (item: SendQueueEntry, position: number) => Promise<void>;
	deleteQueueItem: (queueItemId: string) => Promise<void>;
	saveHistoryItem: (item: SendHistoryEntry) => Promise<void>;
	deleteHistoryItem: (historyItemId: string) => Promise<void>;
	createNote: (request: Parameters<ArchiveClient["createNote"]>[0]) => Promise<{ note: CanonicalNote; contentRevision: number }>;
	updateNote: (request: Parameters<ArchiveClient["updateNote"]>[0]) => Promise<{ note: CanonicalNote; contentRevision: number }>;
	deleteNote: (request: Parameters<ArchiveClient["deleteNote"]>[0]) => Promise<{ contentRevision: number }>;
	setByteVisibility: (request: Parameters<ArchiveClient["setByteVisibility"]>[0]) => Promise<Awaited<ReturnType<ArchiveClient["setByteVisibility"]>>>;
	setFrameVisibility: (request: Parameters<ArchiveClient["setFrameVisibility"]>[0]) => Promise<Awaited<ReturnType<ArchiveClient["setFrameVisibility"]>>>;
	startCanonicalization: (captureId: string) => Promise<CanonicalizationJob>;
	getCanonicalizationPreflight: (captureId: string) => Promise<CanonicalizationPreflight>;
	getCanonicalizationJob: (captureId: string, jobId: string) => Promise<CanonicalizationJob>;
	getLegacyBackup: (captureId: string) => Promise<LegacyBackupResponse>;
	/** Recording is deliberately exposed as an append command, outside Query cache updates. */
	recordingWriter: ArchiveClient;
};

export type ArchiveHydration = {
	index: ArchiveIndex;
	captures: Capture[];
	folders: StoredFolder[];
	queue: SendQueueEntry[];
	history: SendHistoryEntry[];
	settings: SendSettings;
	summaries: CanonicalCaptureSummary[];
};

export type ArchiveDataLayer = {
	client: ArchiveClient;
	queryClient: QueryClient;
	queries: ReturnType<typeof createArchiveQueryOptions>;
	commands: ArchiveCommands;
	/** Synchronous reads for imperative workflow services; cache access stays here. */
	reads: ArchiveReads;
	ready: Promise<void>;
};

export type ArchiveReads = {
	index: () => ArchiveIndex | undefined;
	captures: () => CaptureListItem[] | undefined;
	capture: (captureId: string) => Capture | undefined;
	captureSummaries: () => CanonicalCaptureSummary[] | undefined;
	folders: () => StoredFolder[] | undefined;
	queue: () => SendQueueEntry[] | undefined;
	history: () => SendHistoryEntry[] | undefined;
	settings: () => SendSettings | undefined;
};

function browserStorage(): ArchiveDataLayerStorage | undefined {
	try {
		const storage = globalThis.localStorage;
		return storage && typeof storage.getItem === "function" ? storage : undefined;
	} catch {
		return undefined;
	}
}

function hasStoredState(state: AppState): boolean {
	return Boolean(
		state.captures.length ||
		state.folders.length ||
		state.sendQueue?.length ||
		state.sendHistory?.length ||
		Object.keys(state.sendSettings ?? {}).length
	);
}

function readLegacyArchive(storage: ArchiveDataLayerStorage | undefined): AppState | null {
	if (!storage) return null;
	let raw: string | null = null;
	try {
		raw = storage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as AppState;
		return Array.isArray(parsed?.captures)
			? loadState({ storage: { getItem: key => key === STORAGE_KEY ? raw : null } })
			: null;
	} catch {
		return null;
	}
}

function cloneIndex(index: ArchiveIndex): ArchiveIndex {
	return {
		activeId: index.activeId ?? null,
		unfiledCollapsed: Boolean(index.unfiledCollapsed),
		captures: [...(index.captures ?? [])].map(capture => ({ ...capture, folderId: capture.folderId ?? null })),
		folders: [...(index.folders ?? [])].map(folder => ({ ...folder }))
	};
}

function commandError(name: string, error: unknown): ArchiveCommandError {
	const wrapped = error instanceof Error ? error : new Error(String(error));
	return Object.assign(wrapped, { command: name }) as ArchiveCommandError;
}

export function createArchiveDataLayer(
	queryClient: QueryClient,
	client = new ArchiveClient(),
	storage?: ArchiveDataLayerStorage
): ArchiveDataLayer {
	const queries = createArchiveQueryOptions(client);
	let settingsWriteChain: Promise<void> = Promise.resolve();
	const mutationSuccess = <Name extends ArchiveMutationName>(
		name: Name,
		result: Parameters<ReturnType<typeof createArchiveMutationSuccessHandler<Name>>>[0],
		variables: Parameters<ReturnType<typeof createArchiveMutationSuccessHandler<Name>>>[1]
	) => invalidateArchiveMutationCache(queryClient, name, variables, result);

	async function run<Name extends ArchiveMutationName>(
		name: Name,
		variables: Parameters<ReturnType<typeof createArchiveMutationSuccessHandler<Name>>>[1],
		operation: () => Promise<Parameters<ReturnType<typeof createArchiveMutationSuccessHandler<Name>>>[0]>
	): Promise<Parameters<ReturnType<typeof createArchiveMutationSuccessHandler<Name>>>[0]> {
		try {
			const result = await operation();
			await mutationSuccess(name, result, variables);
			return result;
		} catch (error) {
			throw commandError(name, error);
		}
	}

	async function persistArchiveIndex(index: ArchiveIndex): Promise<void> {
		const next = cloneIndex(index);
		const previous = queryClient.getQueryData<ArchiveIndex>(archiveQueryKeys.index());
		// Selection and ordering are the immediate-interaction slice. The rollback
		// lives here so components never write Query cache data themselves.
		queryClient.setQueryData(archiveQueryKeys.index(), next);
		try {
			await run("saveArchiveIndex", { index: next }, () => client.saveArchiveIndex(next));
		} catch (error) {
			rollbackQuery(archiveQueryKeys.index(), previous);
			throw error;
		}
	}

	function rollbackQuery<T>(queryKey: readonly unknown[], previous: T | undefined): void {
		if (previous === undefined) queryClient.removeQueries({ queryKey, exact: true });
		else queryClient.setQueryData(queryKey, previous);
	}

	type NoteMutationResult = {
		contentRevision: number;
		note?: CanonicalNote;
	};

	function patchNoteList<T extends { id?: string }>(
		notes: readonly T[],
		result: NoteMutationResult,
		deletedNoteId?: string
	): T[] {
		if (deletedNoteId !== undefined) return notes.filter(note => note.id !== deletedNoteId);
		if (!result.note) return [...notes];
		const replacement = result.note as unknown as T;
		const index = notes.findIndex(note => note.id === result.note?.id);
		if (index < 0) return [...notes, replacement];
		return notes.map((note, noteIndex) => noteIndex === index ? replacement : note);
	}

	function patchNoteCaches(captureId: string, result: NoteMutationResult, deletedNoteId?: string): void {
		const notesKey = archiveQueryKeys.notes(captureId);
		queryClient.setQueryData<readonly CanonicalNote[] | undefined>(notesKey, notes => {
			if (!notes) return notes;
			return patchNoteList(notes, result, deletedNoteId);
		});

		queryClient.setQueryData<Capture | undefined>(archiveQueryKeys.capture(captureId), capture => {
			if (!capture) return capture;
			return {
				...capture,
				contentRevision: result.contentRevision,
				...(Array.isArray(capture.notes)
					? { notes: patchNoteList(capture.notes, result, deletedNoteId) }
					: {})
			};
		});

		// The command response is authoritative for the mutation. A notes-only
		// revalidation is useful for concurrent writers, but it must not delay the
		// command or invalidate the byte/frame-bearing capture query.
		void queryClient.invalidateQueries({ queryKey: notesKey, refetchType: "active" }).catch(() => {});
	}

	function applyMetadataToCaptureList(
		captures: CaptureListItem[] | undefined,
		request: PatchMetadataRequest
	): CaptureListItem[] | undefined {
		if (!captures) return undefined;
		const patch = request.patch;
		return captures.map(capture => capture.id !== request.captureId
			? capture
			: {
					...capture,
					...(patch.name === undefined ? {} : { name: patch.name }),
					...(patch.description === undefined ? {} : { description: patch.description }),
					...(patch.controllerView === undefined && patch.view === undefined ? {} : { view: patch.controllerView ?? patch.view ?? "" }),
					...(patch.folderId === undefined ? {} : { folderId: patch.folderId }),
					...(patch.parameters === undefined ? {} : { params: patch.parameters.map(parameter => ({ ...parameter })) })
				}
		);
	}

	function patchKnownCaptureProjections(capture: Capture): void {
		const captureId = String(capture.id ?? "");
		if (!captureId) return;
		const projected = captureListItem(capture);

		queryClient.setQueryData<CaptureListItem[] | undefined>(archiveQueryKeys.captures(), captures => {
			if (!captures) return captures;
			const index = captures.findIndex(item => item.id === captureId);
			if (index < 0) return captures;
			const next = [...captures];
			// Preserve optional sidebar fields when an older/compatibility document
			// did not carry them, while still applying every known command result.
			next[index] = { ...captures[index], ...projected };
			return next;
		});

		queryClient.setQueryData<CanonicalCaptureSummary[] | undefined>(archiveQueryKeys.captureSummaries(), summaries => {
			if (!summaries) return summaries;
			const index = summaries.findIndex(item => item.id === captureId);
			if (index < 0) return summaries;
			const previous = summaries[index];
			const next = [...summaries];
			next[index] = {
				...previous,
				name: projected.name,
				...(capture.storageStatus === undefined ? {} : { status: capture.storageStatus }),
				...(capture.lifecycle === undefined ? {} : { lifecycle: capture.lifecycle }),
				...(capture.byteCount === undefined ? {} : { byteCount: capture.byteCount }),
				...(capture.createdAt === undefined ? {} : { createdAt: capture.createdAt }),
				...(capture.updatedAt === undefined ? {} : { updatedAt: capture.updatedAt }),
				...(capture.folderId === undefined ? {} : { folderId: capture.folderId ?? null })
			};
			return next;
		});
	}

	async function saveFolder(folder: StoredFolder): Promise<void> {
		const previous = queryClient.getQueryData<StoredFolder[]>(archiveQueryKeys.folders());
		if (previous) {
			const next = previous.some(item => item.id === folder.id)
				? previous.map(item => item.id === folder.id ? { ...folder } : item)
				: [...previous, { ...folder }];
			queryClient.setQueryData(archiveQueryKeys.folders(), next);
		}
		try {
			await run("saveFolder", folder, () => client.saveFolder(folder));
		} catch (error) {
			rollbackQuery(archiveQueryKeys.folders(), previous);
			throw error;
		}
	}

	async function deleteFolder(folderId: string): Promise<void> {
		await run("deleteFolder", folderId, () => client.deleteFolder(folderId));
	}

	async function saveQueueItem(item: SendQueueEntry, position: number): Promise<void> {
		const previous = queryClient.getQueryData<SendQueueEntry[]>(archiveQueryKeys.queue());
		if (previous && item.id) {
			const next = previous.some(candidate => candidate.id === item.id)
				? previous.map(candidate => candidate.id === item.id ? { ...item } : candidate)
				: [...previous, { ...item }];
			queryClient.setQueryData(archiveQueryKeys.queue(), next);
		}
		try {
			await run("saveQueueItem", { item, position }, () => client.saveQueueItem(item, position));
		} catch (error) {
			rollbackQuery(archiveQueryKeys.queue(), previous);
			throw error;
		}
	}

	async function deleteQueueItem(queueItemId: string): Promise<void> {
		const previous = queryClient.getQueryData<SendQueueEntry[]>(archiveQueryKeys.queue());
		if (previous) queryClient.setQueryData(archiveQueryKeys.queue(), previous.filter(item => item.id !== queueItemId));
		try {
			await run("deleteQueueItem", queueItemId, () => client.deleteQueueItem(queueItemId));
		} catch (error) {
			rollbackQuery(archiveQueryKeys.queue(), previous);
			throw error;
		}
	}

	async function saveHistoryItem(item: SendHistoryEntry): Promise<void> {
		const previous = queryClient.getQueryData<SendHistoryEntry[]>(archiveQueryKeys.history());
		if (previous && typeof item.id === "string") {
			const next = previous.some(candidate => candidate.id === item.id)
				? previous.map(candidate => candidate.id === item.id ? { ...item } : candidate)
				: [item, ...previous].slice(0, MAX_SEND_HISTORY);
			queryClient.setQueryData(archiveQueryKeys.history(), next);
		}
		try {
			await run("saveHistoryItem", { item }, () => client.saveHistoryItem(item));
		} catch (error) {
			rollbackQuery(archiveQueryKeys.history(), previous);
			throw error;
		}
	}

	async function deleteHistoryItem(historyItemId: string): Promise<void> {
		const previous = queryClient.getQueryData<SendHistoryEntry[]>(archiveQueryKeys.history());
		if (previous) queryClient.setQueryData(archiveQueryKeys.history(), previous.filter(item => item.id !== historyItemId));
		try {
			await run("deleteHistoryItem", historyItemId, () => client.deleteHistoryItem(historyItemId));
		} catch (error) {
			rollbackQuery(archiveQueryKeys.history(), previous);
			throw error;
		}
	}

	async function saveSettings(settings: Partial<SendSettings>): Promise<void> {
		const previous = queryClient.getQueryData<SendSettings>(archiveQueryKeys.settings());
		const optimistic = normalizeArchiveSettings({ ...previous, ...settings });
		queryClient.setQueryData(archiveQueryKeys.settings(), optimistic);
		const write = settingsWriteChain
			.catch(() => {})
			.then(() => run("saveSettings", { settings: optimistic }, () => client.saveSettings(optimistic)));
		settingsWriteChain = write;
		try {
			await write;
		} catch (error) {
			if (queryClient.getQueryData(archiveQueryKeys.settings()) === optimistic) {
				rollbackQuery(archiveQueryKeys.settings(), previous);
			}
			throw error;
		}
	}

	async function patchMetadata(request: PatchMetadataRequest): Promise<CaptureState> {
		const previous = queryClient.getQueryData<Capture>(archiveQueryKeys.capture(request.captureId));
		const previousList = queryClient.getQueryData<CaptureListItem[]>(archiveQueryKeys.captures());
		if (previous) {
			const patch = request.patch;
			queryClient.setQueryData(archiveQueryKeys.capture(request.captureId), {
				...previous,
				...(patch.name === undefined ? {} : { name: patch.name }),
				...(patch.description === undefined ? {} : { description: patch.description }),
				...(patch.controllerView === undefined ? {} : { view: patch.controllerView }),
				...(patch.baudRate === undefined ? {} : { baudRate: patch.baudRate }),
				...(patch.folderId === undefined ? {} : { folderId: patch.folderId }),
				...(patch.parameters === undefined ? {} : { params: patch.parameters.map(parameter => ({ ...parameter })) })
			});
		}
		const optimisticList = applyMetadataToCaptureList(previousList, request);
		if (optimisticList) queryClient.setQueryData(archiveQueryKeys.captures(), optimisticList);
		try {
			return await run("patchMetadata", request, () => client.patchMetadata(request));
		} catch (error) {
			rollbackQuery(archiveQueryKeys.capture(request.captureId), previous);
			rollbackQuery(archiveQueryKeys.captures(), previousList);
			throw error;
		}
	}

	async function refreshCapture(captureId: string, expectedActiveProfileId?: string): Promise<Capture> {
		const maxAttempts = expectedActiveProfileId ? 3 : 1;
		let lastCapture: Capture | undefined;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const capture = await queryClient.fetchQuery({ ...queries.capture(captureId), staleTime: 0 });
			lastCapture = capture;
			patchKnownCaptureProjections(capture);
			if (!expectedActiveProfileId || capture.activeFramingProfileId === expectedActiveProfileId) return capture;
		}
		throw new Error(
			`capture ${captureId} refresh did not observe active framing profile ${expectedActiveProfileId}; ` +
			`last observed ${lastCapture?.activeFramingProfileId ?? "none"}`
		);
	}

	const commands: ArchiveCommands = {
		hydrate: async () => {
			const [index, folders, queue, history, settings, summaries, fullState] = await Promise.all([
				queryClient.ensureQueryData(queries.index()),
				queryClient.ensureQueryData(queries.folders()),
				queryClient.ensureQueryData(queries.queue()),
				queryClient.ensureQueryData(queries.history()),
				queryClient.ensureQueryData(queries.settings()),
				queryClient.ensureQueryData(queries.captureSummaries()),
				// Full capture documents are needed by the live compatibility
				// projection, but they do not belong in the sidebar list query.
				client.load()
			]);
			return { index, captures: fullState.captures, folders, queue, history, settings, summaries };
		},
		getArchiveIndex: () => queryClient.ensureQueryData(queries.index()),
		persistArchiveIndex,
		getCapture: captureId => queryClient.ensureQueryData(queries.capture(captureId)),
		refreshCapture,
		listCaptures: () => queryClient.ensureQueryData(queries.captures()),
		// Keep the compatibility document write outside Query.  In particular,
		// recording calls this for every live flush and must not refetch list data.
		saveLegacyCapture: async capture => {
			try {
				await client.saveLegacyCaptureDocument(capture);
			} catch (error) {
				throw commandError("saveLegacyCaptureDocument", error);
			}
		},
		createCapture: request => run("createCapture", request, () => client.createCapture(request)),
		patchMetadata,
		deleteCapture: captureId => run("deleteCapture", captureId, () => client.delete(captureId)),
		clearCaptureData: async captureId => {
			await client.clearData({ captureId });
			await refreshCapture(captureId);
		},
		duplicateCapture: async (captureId, duplicateCaptureId) => {
			await client.duplicate({ captureId, duplicateCaptureId });
			await invalidateArchiveMutationCache(queryClient, "createCapture", { captureId: duplicateCaptureId || "" } as CreateCaptureRequest, {} as CaptureState);
		},
		saveFolder,
		deleteFolder,
		saveSettings,
		saveQueueItem,
		deleteQueueItem,
		saveHistoryItem,
		deleteHistoryItem,
		createNote: async request => {
			const result = await client.createNote(request);
			patchNoteCaches(request.captureId, result);
			return result;
		},
		updateNote: async request => {
			const result = await client.updateNote(request);
			patchNoteCaches(request.captureId, result);
			return result;
		},
		deleteNote: async request => {
			const result = await client.deleteNote(request);
			patchNoteCaches(request.captureId, result, request.noteId);
			return result;
		},
		// The interaction controller owns the single authoritative refresh after
		// applying and tracking its optimistic visibility change. Refreshing here
		// as well fetched and parsed the complete capture twice per click.
		setByteVisibility: request => client.setByteVisibility(request),
		setFrameVisibility: request => client.setFrameVisibility(request),
		startCanonicalization: captureId => run("startCanonicalization", captureId, () => client.startCanonicalization(captureId)),
		getCanonicalizationPreflight: captureId => queryClient.fetchQuery({ ...queries.canonicalizationPreflight(captureId), staleTime: 0 }),
		getCanonicalizationJob: (captureId, jobId) => queryClient.fetchQuery({ ...queries.canonicalizationJob(captureId, jobId), staleTime: 0 }),
		getLegacyBackup: captureId => queryClient.fetchQuery(queries.legacyBackup(captureId)),
		recordingWriter: client
	};

	const legacyStorage = storage || browserStorage();
	const legacyArchive = readLegacyArchive(legacyStorage);
	const ready = (async () => {
		await client.health();
		const serverState = await client.load();
		if (legacyArchive && !hasStoredState(serverState)) {
			await client.migrate(legacyArchive);
			try { legacyStorage?.removeItem?.(STORAGE_KEY); } catch {}
		}
		await Promise.all([
			queryClient.ensureQueryData(queries.index()),
			queryClient.ensureQueryData(queries.captures()),
			queryClient.ensureQueryData(queries.captureSummaries()),
			queryClient.ensureQueryData(queries.folders()),
			queryClient.ensureQueryData(queries.queue()),
			queryClient.ensureQueryData(queries.history()),
			queryClient.ensureQueryData(queries.settings())
		]);
	})().catch(error => {
		console.error("Bus Lens archive data unavailable", error);
		throw commandError("bootstrap", error);
	});

	const reads: ArchiveReads = {
		index: () => queryClient.getQueryData(archiveQueryKeys.index()),
		captures: () => queryClient.getQueryData(archiveQueryKeys.captures()),
		capture: captureId => queryClient.getQueryData(archiveQueryKeys.capture(String(captureId))),
		captureSummaries: () => queryClient.getQueryData(archiveQueryKeys.captureSummaries()),
		folders: () => queryClient.getQueryData(archiveQueryKeys.folders()),
		queue: () => queryClient.getQueryData(archiveQueryKeys.queue()),
		history: () => queryClient.getQueryData(archiveQueryKeys.history()),
		settings: () => queryClient.getQueryData(archiveQueryKeys.settings())
	};

	return { client, queryClient, queries, commands, reads, ready };
}

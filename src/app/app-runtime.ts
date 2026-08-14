import { loadState, STORAGE_KEY, type AppState, type StateStorage } from "../shared/app-state.ts";
import { publishToastSnapshot } from "../shared/toast-bridge.ts";
import type { Capture } from "../features/capture/capture-framing.ts";
import {
	ArchiveClient,
	type CanonicalCaptureSummary,
	type CanonicalizationJob,
	type CanonicalizationPreflight,
	type LegacyBackupResponse,
	type CaptureMetadataPatch,
	type CaptureState,
	type CaptureWriter,
	type CreateCaptureRequest,
	type FramingSectionRequest,
	type OrderedCaptureParameter
} from "../persistence/archive-client.ts";

export type WritableStateStorage = StateStorage & {
	setItem: (key: string, value: string) => void;
	removeItem: (key: string) => void;
};

export type AppRuntimeDependencies = {
	storage?: WritableStateStorage;
	generateId?: () => string;
	now?: () => number;
	nowIso?: () => string;
	archiveClient?: ArchiveClient;
	captureWriter?: CaptureWriter;
};

export type SaveStateOptions = {
	immediate?: boolean;
};

export type AppRuntime = {
	state: AppState;
	ready: Promise<void>;
	capture: () => Capture | undefined;
	getActiveId: () => string | null | undefined;
	setActiveId: (captureId: string | null | undefined) => void;
	persistState: () => void;
	beginUnload: () => void;
	saveState: (options?: SaveStateOptions) => void;
	showToast: (message: string) => void;
	saveCapture: (captureId: string) => void;
	saveArchiveIndex: () => void;
	saveFolder: (folderId: string) => void;
	saveSendState: () => void;
	saveSettings: () => void;
	captureWriter: CaptureWriter | undefined;
	isCanonicalCapture: (captureId: string) => boolean;
	getCaptureStorageStatus: (captureId: string) => CanonicalCaptureSummary["status"] | undefined;
	isCaptureConversionLocked: (captureId: string) => boolean;
	setCaptureStorageStatus: (captureId: string, status: CanonicalCaptureSummary["status"]) => void;
	ensureCanonicalCapture: (captureId: string) => Promise<boolean>;
	waitForCaptureWrite: (captureId: string) => Promise<void>;
	refreshCapture: (captureId: string) => Promise<Capture>;
	getCanonicalizationPreflight: (captureId: string) => Promise<CanonicalizationPreflight>;
	startCanonicalization: (captureId: string) => Promise<CanonicalizationJob>;
	getCanonicalizationJob: (captureId: string, jobId: string) => Promise<CanonicalizationJob>;
	getLegacyBackup: (captureId: string) => Promise<LegacyBackupResponse>;
};

type PersistedEntityIds = {
	captures: Set<string>;
	folders: Set<string>;
	queue: Set<string>;
	history: Set<string>;
};

function emptyPersistedEntityIds(): PersistedEntityIds {
	return { captures: new Set(), folders: new Set(), queue: new Set(), history: new Set() };
}

function entityIds(items: readonly unknown[] | undefined, fallbackPrefix?: string): Set<string> {
	const ids = new Set<string>();
	items?.forEach((item, index) => {
		const rawId = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
		const id = rawId === undefined || rawId === null || rawId === ""
			? fallbackPrefix ? `${fallbackPrefix}-${index}` : ""
			: String(rawId);
		if (id) ids.add(id);
	});
	return ids;
}

function persistedEntityIds(state: AppState): PersistedEntityIds {
	return {
		captures: entityIds(state.captures),
		folders: entityIds(state.folders),
		queue: entityIds(state.sendQueue, "queue"),
		history: entityIds(state.sendHistory, "history")
	};
}

function hasStoredState(state: AppState): boolean {
	return Boolean(
		state.captures.length ||
		state.folders.length ||
		state.sendQueue?.length ||
		state.sendHistory?.length ||
		state.sendSettings
	);
}

function browserStorage(): WritableStateStorage | undefined {
	try {
		const storage = globalThis.localStorage;
		return storage && typeof storage.setItem === "function" && typeof storage.removeItem === "function" ? storage : undefined;
	} catch {
		return undefined;
	}
}

function framingSectionRequests(capture: Capture): FramingSectionRequest[] {
	const sections = Array.isArray(capture.frameSections) ? capture.frameSections : [];
	const source = sections.length ? sections : [{ start: 0, framingMode: "length", frameSize: capture.frameSize }];
	return source.map(section => {
		const mode = String(section.framingMode ?? section.frameMode ?? "length").toLowerCase();
		const framingMode: FramingSectionRequest["framingMode"] = mode === "marker" ? "marker" : mode === "time" || mode === "time-gap" || mode === "timegap" ? "time" : "length";
		return {
			...(section.id ? { id: String(section.id) } : {}),
			start: Math.max(0, Math.floor(Number(section.start) || 0)),
			framingMode,
			...(section.frameSize === undefined ? {} : { frameSize: Number(section.frameSize) }),
			...(section.frameMarker === undefined ? {} : { frameMarker: String(section.frameMarker) }),
			...(section.markerPosition === "end" ? { markerPosition: "end" as const } : section.markerPosition === "start" ? { markerPosition: "start" as const } : {}),
			...(section.frameTimeGap === undefined ? {} : { frameTimeGap: Number(section.frameTimeGap) }),
			...(section.collapseRuns === undefined ? {} : { collapseRuns: Boolean(section.collapseRuns) }),
			...(section.collapsed === undefined ? {} : { collapsed: Boolean(section.collapsed) })
		};
	});
}

function captureParameters(capture: Capture): OrderedCaptureParameter[] {
	if (!Array.isArray(capture.params)) return [];
	return capture.params.flatMap(parameter => {
		if (!parameter || typeof parameter !== "object") return [];
		const value = parameter as { key?: unknown; value?: unknown };
		const key = String(value.key ?? "").trim();
		return key ? [{ key, value: String(value.value ?? "") }] : [];
	});
}

function captureCreateRequest(capture: Capture): CreateCaptureRequest {
	return {
		captureId: String(capture.id),
		framing: framingSectionRequests(capture),
		name: String(capture.name ?? "Untitled capture"),
		description: String(capture.description ?? ""),
		controllerView: String(capture.view ?? ""),
		...(capture.baudRate === undefined ? {} : { baudRate: Number(capture.baudRate) }),
		inputFormat: "binary",
		folderId: capture.folderId ?? null,
		parameters: captureParameters(capture)
	};
}

function captureMetadataPatch(capture: Capture): CaptureMetadataPatch {
	return {
		name: String(capture.name ?? ""),
		description: String(capture.description ?? ""),
		controllerView: String(capture.view ?? ""),
		...(capture.baudRate === undefined ? {} : { baudRate: Number(capture.baudRate) }),
		inputFormat: "binary",
		folderId: capture.folderId ?? null,
		parameters: captureParameters(capture)
	};
}

function applyCanonicalCaptureState(capture: Capture, result: unknown): void {
	if (!result || typeof result !== "object") return;
	const state = result as Partial<CaptureState>;
	if (typeof state.dataRevision === "number") capture.dataRevision = state.dataRevision;
	if (typeof state.metadataRevision === "number") capture.metadataRevision = state.metadataRevision;
	if (typeof state.contentRevision === "number") capture.contentRevision = state.contentRevision;
	if (typeof state.retainedStartOffset === "number") capture.retainedStartOffset = state.retainedStartOffset;
	if (state.activeProfile && typeof state.activeProfile === "object" && typeof state.activeProfile.id === "string") {
		capture.activeFramingProfileId = state.activeProfile.id;
	}
	if (state.draft && typeof state.draft === "object" && typeof state.draft.revision === "number") {
		capture.framingDraftRevision = state.draft.revision;
	}
	if (typeof state.updatedAt === "string") capture.updatedAt = state.updatedAt;
}

export function createAppRuntime(dependencies: AppRuntimeDependencies = {}): AppRuntime {
	const storage = dependencies.storage || browserStorage();
	let legacyArchive: string | null = null;
	try { legacyArchive = storage?.getItem(STORAGE_KEY) ?? null; } catch {}
	const client = dependencies.archiveClient || (typeof fetch === "function" && !dependencies.storage ? new ArchiveClient() : undefined);
	const writer = dependencies.captureWriter || client;
	let databaseReady = false;
	let toastTimer: ReturnType<typeof setTimeout> | null = null;
	let stateSaveTimer: ReturnType<typeof setTimeout> | null = null;
	let unloading = false;
	let persistedIds = emptyPersistedEntityIds();
	const activeCaptureWrites = new Map<string, Promise<unknown>>();
	const pendingDeletions = emptyPersistedEntityIds();
	const activeDeletions = {
		captures: new Map<string, Promise<void>>(),
		folders: new Map<string, Promise<void>>(),
		queue: new Map<string, Promise<void>>(),
		history: new Map<string, Promise<void>>()
	};
	const showToast = (message: string): void => {
		if (toastTimer) clearTimeout(toastTimer);
		publishToastSnapshot({ message, visible: true });
		toastTimer = setTimeout(() => publishToastSnapshot({ message: "", visible: false }), 2_600);
	};
	const state = loadState({
		storage: { getItem: key => key === STORAGE_KEY ? legacyArchive : null },
		generateId: dependencies.generateId,
		now: dependencies.now,
		nowIso: dependencies.nowIso
	});
	let activeId: string | null | undefined = state.activeId || state.captures[0]?.id;

	function captureById(captureId: string): Capture | undefined {
		return state.captures.find(item => String(item.id) === String(captureId));
	}

	function captureStorageStatus(captureId: string): CanonicalCaptureSummary["status"] | undefined {
		return captureById(captureId)?.storageStatus;
	}

	function reportPersistenceFailure(error: unknown): void {
		if (unloading) return;
		console.error("Bus Lens persistence failed", error);
		showToast("Archive service unavailable — legacy archive is read-only. Export JSON to recover it.");
	}

	function saveCapture(captureId: string): void {
		const capture = state.captures.find(item => item.id === captureId);
		if (unloading || !databaseReady || !capture || !writer) return;
		const id = String(capture.id);
		if (activeCaptureWrites.has(id)) return;
		if (captureStorageStatus(id) === "converting") return;
		const isNew = !persistedIds.captures.has(id);
		let operation: Promise<unknown>;
		if (isNew) {
			capture.storageStatus = "canonical";
			operation = writer.createCapture(captureCreateRequest(capture)).then(result => {
				applyCanonicalCaptureState(capture, result);
				persistedIds.captures.add(id);
				capture.storageStatus = "canonical";
			});
		} else if (captureStorageStatus(id) === "canonical") {
			operation = writer.patchMetadata({ captureId: id, patch: captureMetadataPatch(capture) }).then(result => {
				applyCanonicalCaptureState(capture, result);
			});
		} else if (client) {
			// The generic document endpoint is a legacy-only compatibility path.
			operation = client.saveLegacyCaptureDocument(capture);
		} else {
			return;
		}
		const tracked = operation
			.catch(error => {
				if (isNew) {
					persistedIds.captures.delete(id);
				}
				reportPersistenceFailure(error);
			})
			.finally(() => activeCaptureWrites.delete(id));
		activeCaptureWrites.set(id, tracked);
	}

	function isCanonicalCapture(captureId: string): boolean {
		return captureStorageStatus(captureId) === "canonical";
	}

	function getCaptureStorageStatus(captureId: string): CanonicalCaptureSummary["status"] | undefined {
		return captureStorageStatus(captureId);
	}

	function isCaptureConversionLocked(captureId: string): boolean {
		return getCaptureStorageStatus(captureId) === "converting";
	}

	function setCaptureStorageStatus(captureId: string, status: CanonicalCaptureSummary["status"]): void {
		const id = String(captureId);
		const item = captureById(id);
		if (item) item.storageStatus = status;
	}

	async function waitForCaptureWrite(captureId: string): Promise<void> {
		await activeCaptureWrites.get(captureId);
	}

	async function ensureCanonicalCapture(captureId: string): Promise<boolean> {
		await waitForCaptureWrite(captureId);
		return isCanonicalCapture(captureId);
	}

	async function refreshCapture(captureId: string): Promise<Capture> {
		if (!client) throw new Error("archive client is unavailable");
		const refreshed = await client.loadCapture(captureId);
		const index = state.captures.findIndex(capture => String(capture.id) === captureId);
		const previous = index >= 0 ? state.captures[index] : undefined;
		if (!refreshed.storageStatus && previous?.storageStatus) refreshed.storageStatus = previous.storageStatus;
		if (index >= 0) state.captures[index] = refreshed;
		return refreshed;
	}
	function saveArchiveIndex(): void { if (!unloading && databaseReady && client) void client.saveArchiveIndex(state, activeId).catch(reportPersistenceFailure); }
	function saveFolder(folderId: string): void { const folder = state.folders.find(item => item.id === folderId); if (!unloading && databaseReady && folder && client) void client.saveFolder(folder).catch(reportPersistenceFailure); }
	function saveSendState(): void { if (!unloading && databaseReady && client) void client.saveSendState(state).catch(reportPersistenceFailure); }
	function saveSettings(): void { if (!unloading && databaseReady && client) void client.saveSettings(state.sendSettings).catch(reportPersistenceFailure); }

	function reconcileDeletedIds(
		previous: Set<string>,
		current: Set<string>,
		pending: Set<string>,
		active: Map<string, Promise<void>>,
		remove: (id: string) => Promise<void>
	): void {
		for (const id of pending) if (current.has(id)) pending.delete(id);
		for (const id of previous) if (!current.has(id)) pending.add(id);
		for (const id of pending) {
			if (current.has(id) || active.has(id)) continue;
			const removal = remove(id)
				.then(() => { pending.delete(id); })
				.catch(reportPersistenceFailure)
				.finally(() => active.delete(id));
			active.set(id, removal);
		}
	}

	function reconcileDeletions(current: PersistedEntityIds): void {
		if (!client) return;
		reconcileDeletedIds(persistedIds.captures, current.captures, pendingDeletions.captures, activeDeletions.captures, id => client.deleteCapture(id));
		reconcileDeletedIds(persistedIds.folders, current.folders, pendingDeletions.folders, activeDeletions.folders, id => client.deleteFolder(id));
		reconcileDeletedIds(persistedIds.queue, current.queue, pendingDeletions.queue, activeDeletions.queue, id => client.deleteQueueItem(id));
		reconcileDeletedIds(persistedIds.history, current.history, pendingDeletions.history, activeDeletions.history, id => client.deleteHistoryItem(id));
		persistedIds = current;
	}

	function persistState(): void {
		state.activeId = activeId;
		if (unloading || !databaseReady) return;
		const activeCapture = activeId === null || activeId === undefined
			? undefined
			: state.captures.find(item => String(item.id) === String(activeId));
		// A newly created capture is the one capture write that saveState owns. It
		// is sent through the command boundary before the global reconciliation
		// updates the persisted-id snapshot; existing captures are never replayed.
		if (activeCapture && !persistedIds.captures.has(String(activeCapture.id))) saveCapture(String(activeCapture.id));
		reconcileDeletions(persistedEntityIds(state));
		state.folders.forEach(folder => saveFolder(folder.id));
		saveArchiveIndex(); saveSendState(); saveSettings();
	}

	function saveState({ immediate = false }: SaveStateOptions = {}): void {
		if (unloading) return;
		if (immediate) {
			if (stateSaveTimer) clearTimeout(stateSaveTimer);
			stateSaveTimer = null;
			persistState();
			return;
		}
		if (stateSaveTimer) return;
		stateSaveTimer = setTimeout(() => {
			stateSaveTimer = null;
			persistState();
		}, 1_000);
	}

	function capture(): Capture | undefined {
		return state.captures.find(item => item.id === activeId) || state.captures[0];
	}

	function beginUnload(): void {
		unloading = true;
		if (stateSaveTimer) clearTimeout(stateSaveTimer);
		stateSaveTimer = null;
	}

	async function refreshCaptureStatuses(): Promise<void> {
		if (!client) return;
		try {
			const summaries = await client.listCaptureSummaries();
			const statuses = new Map(summaries.map(summary => [summary.id, summary.status]));
			for (const capture of state.captures) {
				const status = statuses.get(String(capture.id));
				if (status) capture.storageStatus = status;
			}
		} catch {
			// Keep the status embedded in each capture. It is the same authority used
			// by the archive badge and remains valid when this supplemental read fails.
		}
	}

	async function getCanonicalizationPreflight(captureId: string): Promise<CanonicalizationPreflight> {
		if (!client) throw new Error("archive client is unavailable");
		return client.getCanonicalizationPreflight(captureId);
	}

	async function startCanonicalization(captureId: string): Promise<CanonicalizationJob> {
		if (!client) throw new Error("archive client is unavailable");
		await waitForCaptureWrite(captureId);
		const job = await client.startCanonicalization(captureId);
		setCaptureStorageStatus(
			captureId,
			job.status === "completed" ? "canonical" : job.status === "failed" ? "canonicalization-failed" : "converting"
		);
		return job;
	}

	async function getCanonicalizationJob(captureId: string, jobId: string): Promise<CanonicalizationJob> {
		if (!client) throw new Error("archive client is unavailable");
		return client.getCanonicalizationJob(captureId, jobId);
	}

	async function getLegacyBackup(captureId: string): Promise<LegacyBackupResponse> {
		if (!client) throw new Error("archive client is unavailable");
		return client.getLegacyBackup(captureId);
	}

	const ready = client ? (async () => {
		try {
			await client.health();
			const stored = await client.load();
			if (legacyArchive && !hasStoredState(stored)) {
				const report = await client.migrate(state);
				persistedIds = persistedEntityIds(state);
				await refreshCaptureStatuses();
				// SQLite is now canonical. Removing the legacy payload makes this a one-time migration.
				try { storage?.removeItem(STORAGE_KEY); } catch {}
				databaseReady = true;
				showToast(`Migrated ${report.captures} captures, ${report.rawBytes.toLocaleString()} bytes, ${report.notes} notes`);
			} else {
				if (hasStoredState(stored)) { Object.assign(state, stored); activeId = stored.activeId ?? stored.captures[0]?.id ?? null; }
				persistedIds = persistedEntityIds(stored);
				await refreshCaptureStatuses();
				if (legacyArchive) {
					// An existing SQLite archive means the one-time migration has already been superseded.
					try { storage?.removeItem(STORAGE_KEY); } catch {}
				}
				databaseReady = true;
			}
		} catch (error) { reportPersistenceFailure(error); }
	})() : Promise.resolve();

	return {
		state,
		ready,
		capture,
		getActiveId: () => activeId,
		setActiveId: (captureId: string | null | undefined) => {
			activeId = captureId;
		},
		persistState,
		beginUnload,
		saveState,
		saveCapture,
		saveArchiveIndex,
		saveFolder,
		saveSendState,
		saveSettings,
		captureWriter: writer,
		isCanonicalCapture,
		getCaptureStorageStatus,
		isCaptureConversionLocked,
		setCaptureStorageStatus,
		ensureCanonicalCapture,
		waitForCaptureWrite,
		refreshCapture,
		getCanonicalizationPreflight,
		startCanonicalization,
		getCanonicalizationJob,
		getLegacyBackup,
		showToast
	};
}

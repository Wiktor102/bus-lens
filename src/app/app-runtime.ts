import { loadState, STORAGE_KEY, type AppState, type StateStorage } from "../shared/app-state.ts";
import { publishToastSnapshot } from "../shared/toast-bridge.ts";
import type { Capture } from "../features/capture/capture-framing.ts";
import { ArchiveClient } from "../persistence/archive-client.ts";

export type WritableStateStorage = StateStorage & {
	setItem: (key: string, value: string) => void;
	removeItem: (key: string) => void;
};

export type AppRuntimeDependencies = {
	storage?: WritableStateStorage;
	generateId?: () => string;
	now?: () => number;
	nowIso?: () => string;
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

export function createAppRuntime(dependencies: AppRuntimeDependencies = {}): AppRuntime {
	const storage = dependencies.storage || browserStorage();
	let legacyArchive: string | null = null;
	try { legacyArchive = storage?.getItem(STORAGE_KEY) ?? null; } catch {}
	const client = typeof fetch === "function" && !dependencies.storage ? new ArchiveClient() : undefined;
	let databaseReady = false;
	let toastTimer: ReturnType<typeof setTimeout> | null = null;
	let stateSaveTimer: ReturnType<typeof setTimeout> | null = null;
	let unloading = false;
	let persistedIds = emptyPersistedEntityIds();
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

	function reportPersistenceFailure(error: unknown): void {
		if (unloading) return;
		console.error("Bus Lens persistence failed", error);
		showToast("Archive service unavailable — legacy archive is read-only. Export JSON to recover it.");
	}

	function saveCapture(captureId: string): void {
		const capture = state.captures.find(item => item.id === captureId);
		if (unloading || !databaseReady || !capture || !client) return;
		void client.saveCapture(capture).catch(reportPersistenceFailure);
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
		reconcileDeletions(persistedEntityIds(state));
		state.captures.forEach(capture => saveCapture(String(capture.id)));
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

	const ready = client ? (async () => {
		try {
			await client.health();
			const stored = await client.load();
			if (legacyArchive && !hasStoredState(stored)) {
				const report = await client.migrate(state);
				persistedIds = persistedEntityIds(state);
				// SQLite is now canonical. Removing the legacy payload makes this a one-time migration.
				try { storage?.removeItem(STORAGE_KEY); } catch {}
				databaseReady = true;
				showToast(`Migrated ${report.captures} captures, ${report.rawBytes.toLocaleString()} bytes, ${report.notes} notes`);
			} else {
				if (hasStoredState(stored)) { Object.assign(state, stored); activeId = stored.activeId ?? stored.captures[0]?.id ?? null; }
				persistedIds = persistedEntityIds(stored);
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
		showToast
	};
}

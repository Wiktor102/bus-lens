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

	function persistState(): void {
		state.activeId = activeId;
		if (unloading || !databaseReady) return;
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

	if (client) void (async () => {
		try {
			await client.health();
			const stored = await client.load();
			if (legacyArchive && !stored.captures.length) {
				const report = await client.migrate(state);
				// SQLite is now canonical. Removing the legacy payload makes this a one-time migration.
				try { storage?.removeItem(STORAGE_KEY); } catch {}
				databaseReady = true;
				showToast(`Migrated ${report.captures} captures, ${report.rawBytes.toLocaleString()} bytes, ${report.notes} notes`);
			} else {
				if (stored.captures.length) { Object.assign(state, stored); activeId = stored.activeId || stored.captures[0]?.id; }
				if (legacyArchive) {
					// An existing SQLite archive means the one-time migration has already been superseded.
					try { storage?.removeItem(STORAGE_KEY); } catch {}
				}
				databaseReady = true;
			}
		} catch (error) { reportPersistenceFailure(error); }
	})();

	return {
		state,
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

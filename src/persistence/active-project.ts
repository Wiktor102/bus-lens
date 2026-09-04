export const ACTIVE_PROJECT_STORAGE_KEY = "bus-lens-active-project";

export type ActiveProjectStorage = {
	getItem(key: string): string | null;
	setItem?(key: string, value: string): void;
	removeItem?(key: string): void;
};

export type TabProjectSelection = Readonly<{
	projectId: string | null;
	storage: ActiveProjectStorage;
}>;

function defaultStorage(): ActiveProjectStorage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

/**
 * The active project is client-only state: the server stays stateless and
 * every request names its project through a header instead.
 */
export function readActiveProjectId(storage: ActiveProjectStorage | undefined = defaultStorage()): string | null {
	if (!storage) return null;
	try {
		const value = storage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
		const trimmed = value?.trim();
		return trimmed ? trimmed : null;
	} catch {
		return null;
	}
}

export function writeActiveProjectId(projectId: string, storage: ActiveProjectStorage | undefined = defaultStorage()): void {
	if (!storage) return;
	try {
		storage.setItem?.(ACTIVE_PROJECT_STORAGE_KEY, projectId);
	} catch {
		// Persistence of the preference is optional; the Default project remains
		// the fallback when the id cannot be stored.
	}
}

export function clearActiveProjectId(storage: ActiveProjectStorage | undefined = defaultStorage()): void {
	if (!storage) return;
	try {
		storage.removeItem?.(ACTIVE_PROJECT_STORAGE_KEY);
	} catch {
		// Nothing to recover; reading already treats a failed read as absent.
	}
}

export function createTabProjectSelection(
	tabStorage: ActiveProjectStorage,
	preferenceStorage: ActiveProjectStorage
): TabProjectSelection {
	const projectId = readActiveProjectId(tabStorage) ?? readActiveProjectId(preferenceStorage);
	if (projectId) writeActiveProjectId(projectId, tabStorage);
	return {
		projectId,
		storage: {
			getItem: key => tabStorage.getItem(key),
			setItem: (key, value) => {
				tabStorage.setItem?.(key, value);
				preferenceStorage.setItem?.(key, value);
			},
			removeItem: key => {
				tabStorage.removeItem?.(key);
				preferenceStorage.removeItem?.(key);
			}
		}
	};
}

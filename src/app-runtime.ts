import { loadState, STORAGE_KEY, type AppState, type StateStorage } from "./app-state.ts";
import { publishToastSnapshot } from "./toast-bridge.ts";
import type { Capture } from "./capture-framing.ts";

export type WritableStateStorage = StateStorage & {
	setItem: (key: string, value: string) => void;
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
	saveState: (options?: SaveStateOptions) => void;
	showToast: (message: string) => void;
};

function browserStorage(): WritableStateStorage | undefined {
	try {
		const storage = globalThis.localStorage;
		return storage && typeof storage.setItem === "function" ? storage : undefined;
	} catch {
		return undefined;
	}
}

export function createAppRuntime(dependencies: AppRuntimeDependencies = {}): AppRuntime {
	const storage = dependencies.storage || browserStorage();
	let toastTimer: ReturnType<typeof setTimeout> | null = null;
	let stateSaveTimer: ReturnType<typeof setTimeout> | null = null;
	const showToast = (message: string): void => {
		if (toastTimer) clearTimeout(toastTimer);
		publishToastSnapshot({ message, visible: true });
		toastTimer = setTimeout(() => publishToastSnapshot({ message: "", visible: false }), 2_600);
	};
	const state = loadState({
		storage,
		generateId: dependencies.generateId,
		now: dependencies.now,
		nowIso: dependencies.nowIso
	});
	let activeId: string | null | undefined = state.activeId || state.captures[0]?.id;

	function persistState(): void {
		state.activeId = activeId;
		try {
			if (!storage) throw new Error("Browser storage is unavailable");
			storage.setItem(STORAGE_KEY, JSON.stringify(state));
		} catch (error) {
			console.warn("Could not save Bus Lens state", error);
			showToast("Capture is live, but browser storage is full");
		}
	}

	function saveState({ immediate = false }: SaveStateOptions = {}): void {
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

	return {
		state,
		capture,
		getActiveId: () => activeId,
		setActiveId: (captureId: string | null | undefined) => {
			activeId = captureId;
		},
		persistState,
		saveState,
		showToast
	};
}

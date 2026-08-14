import { loadState, normalizeSendState, STORAGE_KEY, type AppState, type StateStorage } from "../shared/app-state.ts";
import { publishToastSnapshot } from "../shared/toast-bridge.ts";
import type { Capture } from "../features/capture/capture-framing.ts";
import type {
	CanonicalCaptureSummary,
	CanonicalizationJob,
	CanonicalizationPreflight,
	CaptureWriter
} from "../persistence/archive-client.ts";
import type { ArchiveDataLayer } from "../data/archive-data-layer.ts";

export type WritableStateStorage = StateStorage & {
	setItem?: (key: string, value: string) => void;
	removeItem?: (key: string) => void;
};

export type AppRuntimeDependencies = {
	archive?: ArchiveDataLayer;
	storage?: WritableStateStorage;
	generateId?: () => string;
	now?: () => number;
	nowIso?: () => string;
	captureWriter?: CaptureWriter;
};

/**
 * The runtime owns only live recording/session coordination and a temporary
 * compatibility document for the append pipeline. Server state is hydrated and
 * mutated by ArchiveDataLayer commands; there is intentionally no saveState API.
 */
export type AppRuntime = {
	state: AppState;
	ready: Promise<void>;
	capture: () => Capture | undefined;
	getActiveId: () => string | null | undefined;
	setActiveId: (captureId: string | null | undefined) => void;
	beginUnload: () => void;
	showToast: (message: string) => void;
	captureWriter: CaptureWriter | undefined;
	isCanonicalCapture: (captureId: string) => boolean;
	getCaptureStorageStatus: (captureId: string) => CanonicalCaptureSummary["status"] | undefined;
	isCaptureConversionLocked: (captureId: string) => boolean;
	setCaptureStorageStatus: (captureId: string, status: CanonicalCaptureSummary["status"]) => void;
	trackCaptureWrite: (captureId: string, write: Promise<unknown>) => void;
	ensureCanonicalCapture: (captureId: string) => Promise<boolean>;
	waitForCaptureWrite: (captureId: string) => Promise<void>;
	refreshCapture: (captureId: string) => Promise<Capture>;
	getCanonicalizationPreflight: (captureId: string) => Promise<CanonicalizationPreflight>;
	startCanonicalization: (captureId: string) => Promise<CanonicalizationJob>;
	getCanonicalizationJob: (captureId: string, jobId: string) => Promise<CanonicalizationJob>;
	getLegacyBackup: (captureId: string) => Promise<import("../persistence/archive-client.ts").LegacyBackupResponse>;
};

function browserStorage(): WritableStateStorage | undefined {
	try {
		const storage = globalThis.localStorage;
		return storage && typeof storage.getItem === "function" ? storage : undefined;
	} catch {
		return undefined;
	}
}

function fallbackState(dependencies: AppRuntimeDependencies): AppState {
	const storage = dependencies.storage || browserStorage();
	let legacyArchive: string | null = null;
	try { legacyArchive = storage?.getItem(STORAGE_KEY) ?? null; } catch {}
	return loadState({
		storage: { getItem: key => key === STORAGE_KEY ? legacyArchive : null },
		generateId: dependencies.generateId,
		now: dependencies.now,
		nowIso: dependencies.nowIso
	});
}

export function createAppRuntime(dependencies: AppRuntimeDependencies = {}): AppRuntime {
	const archive = dependencies.archive;
	const state = fallbackState(dependencies);
	let activeId: string | null | undefined = state.activeId || state.captures[0]?.id;
	let unloading = false;
	let captureStatuses = new Map<string, CanonicalCaptureSummary["status"]>();
	const activeCaptureWrites = new Map<string, Promise<unknown>>();
	const writer = dependencies.captureWriter || archive?.commands.recordingWriter;

	const showToast = (message: string): void => {
		publishToastSnapshot({ message, visible: true });
		setTimeout(() => publishToastSnapshot({ message: "", visible: false }), 2_600);
	};

	function applyHydration(hydrated: Awaited<ReturnType<NonNullable<ArchiveDataLayer["commands"]>["hydrate"]>>): void {
		state.captures = hydrated.captures;
		state.folders = hydrated.folders;
		state.sendQueue = hydrated.queue;
		state.sendHistory = hydrated.history;
		state.sendSettings = hydrated.settings;
		state.unfiledCollapsed = hydrated.index.unfiledCollapsed;
		activeId = hydrated.index.activeId ?? hydrated.captures[0]?.id ?? null;
		state.activeId = activeId;
		captureStatuses = new Map(hydrated.summaries.map(summary => [summary.id, summary.status]));
		for (const capture of state.captures) {
			const status = captureStatuses.get(String(capture.id));
			if (status) capture.storageStatus = status;
		}
		normalizeSendState(state);
	}

	const ready = archive
		? archive.ready.then(() => archive.commands.hydrate().then(applyHydration))
		: Promise.resolve();

	function capture(): Capture | undefined {
		return state.captures.find(item => String(item.id) === String(activeId)) || state.captures[0];
	}

	function getCaptureStorageStatus(captureId: string): CanonicalCaptureSummary["status"] | undefined {
		return captureStatuses.get(String(captureId)) || state.captures.find(item => String(item.id) === String(captureId))?.storageStatus as CanonicalCaptureSummary["status"] | undefined;
	}

	function setCaptureStorageStatus(captureId: string, status: CanonicalCaptureSummary["status"]): void {
		captureStatuses.set(String(captureId), status);
		const item = state.captures.find(candidate => String(candidate.id) === String(captureId));
		if (item) item.storageStatus = status;
	}

	function trackCaptureWrite(captureId: string, write: Promise<unknown>): void {
		const id = String(captureId);
		const previous = activeCaptureWrites.get(id);
		const tracked = previous ? Promise.all([previous, write]) : write;
		activeCaptureWrites.set(id, tracked);
		tracked.then(
			() => { if (activeCaptureWrites.get(id) === tracked) activeCaptureWrites.delete(id); },
			() => { if (activeCaptureWrites.get(id) === tracked) activeCaptureWrites.delete(id); }
		);
	}

	async function waitForCaptureWrite(captureId: string): Promise<void> {
		await activeCaptureWrites.get(String(captureId));
	}

	return {
		state,
		ready,
		capture,
		getActiveId: () => activeId,
		setActiveId: captureId => {
			activeId = captureId;
			state.activeId = captureId;
		},
		beginUnload: () => { unloading = true; },
		showToast,
		captureWriter: writer,
		isCanonicalCapture: captureId => getCaptureStorageStatus(captureId) === "canonical",
		getCaptureStorageStatus,
		isCaptureConversionLocked: captureId => getCaptureStorageStatus(captureId) === "converting",
		setCaptureStorageStatus,
		trackCaptureWrite,
		ensureCanonicalCapture: async captureId => {
			await ready;
			await waitForCaptureWrite(captureId);
			return getCaptureStorageStatus(captureId) === "canonical";
		},
		waitForCaptureWrite,
		refreshCapture: async captureId => {
			if (!archive) throw new Error("archive data layer is unavailable");
			const refreshed = await archive.commands.refreshCapture(captureId);
			const index = state.captures.findIndex(item => String(item.id) === String(captureId));
			if (index >= 0) state.captures[index] = refreshed;
			const status = getCaptureStorageStatus(captureId);
			if (status) refreshed.storageStatus = status;
			return refreshed;
		},
		getCanonicalizationPreflight: captureId => {
			if (!archive) return Promise.reject(new Error("archive data layer is unavailable"));
			return archive.commands.getCanonicalizationPreflight(captureId);
		},
		startCanonicalization: async captureId => {
			if (unloading || !archive) throw new Error("archive data layer is unavailable");
			await waitForCaptureWrite(captureId);
			return archive.commands.startCanonicalization(captureId);
		},
		getCanonicalizationJob: (captureId, jobId) => {
			if (!archive) return Promise.reject(new Error("archive data layer is unavailable"));
			return archive.commands.getCanonicalizationJob(captureId, jobId);
		},
		getLegacyBackup: captureId => {
			if (!archive) return Promise.reject(new Error("archive data layer is unavailable"));
			return archive.commands.getLegacyBackup(captureId);
		}
	};
}

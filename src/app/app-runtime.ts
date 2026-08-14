import { applicationStore, selectSelectedCaptureId } from "../shared/application-store.ts";
import type { Capture } from "../features/capture/capture-framing.ts";
import type {
	CanonicalCaptureSummary,
	CanonicalizationJob,
	CanonicalizationPreflight,
	CaptureWriter,
	LegacyBackupResponse
} from "../persistence/archive-client.ts";
import type { ArchiveDataLayer } from "../data/archive-data-layer.ts";

export type AppRuntimeDependencies = {
	archive?: ArchiveDataLayer;
};

/**
 * Runtime coordination is deliberately small: the archive data layer owns
 * durable entities and the recording pipeline owns its live capture. There is
 * no mutable archive-wide AppState projection here.
 */
export type AppRuntime = {
	ready: Promise<void>;
	capture: () => Capture | undefined;
	getCapture: (captureId: string) => Capture | undefined;
	loadCapture: (captureId: string) => Promise<Capture | undefined>;
	getActiveId: () => string | null | undefined;
	setActiveId: (captureId: string | null | undefined) => void;
	setActiveCapture: (capture: Capture | undefined) => void;
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
	getLegacyBackup: (captureId: string) => Promise<LegacyBackupResponse>;
};

export function createAppRuntime(dependencies: AppRuntimeDependencies = {}): AppRuntime {
	const archive = dependencies.archive;
	let activeId: string | null | undefined = applicationStore.select(selectSelectedCaptureId);
	let activeCapture: Capture | undefined;
	let unloading = false;
	const captureStatuses = new Map<string, CanonicalCaptureSummary["status"]>();
	const activeCaptureWrites = new Map<string, Promise<unknown>>();
	const writer = archive?.commands.recordingWriter;

	function cachedCapture(captureId: string | null | undefined): Capture | undefined {
		if (!captureId) return undefined;
		if (activeCapture && String(activeCapture.id) === String(captureId)) return activeCapture;
		return archive?.reads.capture(String(captureId));
	}

	function setActiveCapture(capture: Capture | undefined): void {
		activeCapture = capture;
		if (capture?.id !== undefined) {
			activeId = String(capture.id);
			applicationStore.send({ type: "capture/selected-changed", captureId: activeId });
		}
	}

	async function loadCapture(captureId: string): Promise<Capture | undefined> {
		const id = String(captureId);
		const capture = archive ? await archive.commands.getCapture(id) : cachedCapture(id);
		if (capture && String(activeId) === id) activeCapture = capture;
		return capture;
	}

	const ready = (async () => {
		if (!archive) return;
		await archive.ready;
		const index = archive.reads.index();
		const selectedId = activeId ?? index?.activeId ?? index?.captures[0]?.id ?? null;
		activeId = selectedId;
		applicationStore.send({ type: "capture/selected-changed", captureId: selectedId });
		if (selectedId) {
			const summaries = archive.reads.captureSummaries() ?? [];
			for (const summary of summaries) captureStatuses.set(summary.id, summary.status);
			activeCapture = await archive.commands.getCapture(selectedId);
		}
	})();

	function capture(): Capture | undefined {
		return activeCapture || cachedCapture(activeId);
	}

	function getCapture(captureId: string): Capture | undefined {
		return cachedCapture(captureId);
	}

	function getCaptureStorageStatus(captureId: string): CanonicalCaptureSummary["status"] | undefined {
		return captureStatuses.get(String(captureId)) || getCapture(captureId)?.storageStatus as CanonicalCaptureSummary["status"] | undefined;
	}

	function setCaptureStorageStatus(captureId: string, status: CanonicalCaptureSummary["status"]): void {
		captureStatuses.set(String(captureId), status);
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
		ready,
		capture,
		getCapture,
		loadCapture,
		getActiveId: () => activeId,
		setActiveId: captureId => {
			activeId = captureId;
			applicationStore.send({ type: "capture/selected-changed", captureId: captureId ? String(captureId) : null });
			const cached = cachedCapture(captureId ? String(captureId) : null);
			if (cached) activeCapture = cached;
			else if (captureId) void loadCapture(String(captureId));
			else activeCapture = undefined;
		},
		setActiveCapture,
		beginUnload: () => { unloading = true; },
		showToast: (message: string) => {
			applicationStore.send({ type: "toast/changed", state: { message, visible: true } });
			setTimeout(() => applicationStore.send({ type: "toast/changed", state: { message: "", visible: false } }), 2_600);
		},
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
			const status = getCaptureStorageStatus(captureId);
			if (status) captureStatuses.set(String(captureId), status);
			if (String(activeId) === String(captureId)) activeCapture = refreshed;
			return refreshed;
		},
		getCanonicalizationPreflight: captureId => archive
			? archive.commands.getCanonicalizationPreflight(captureId)
			: Promise.reject(new Error("archive data layer is unavailable")),
		startCanonicalization: async captureId => {
			if (unloading || !archive) throw new Error("archive data layer is unavailable");
			await waitForCaptureWrite(captureId);
			return archive.commands.startCanonicalization(captureId);
		},
		getCanonicalizationJob: (captureId, jobId) => archive
			? archive.commands.getCanonicalizationJob(captureId, jobId)
			: Promise.reject(new Error("archive data layer is unavailable")),
		getLegacyBackup: captureId => archive
			? archive.commands.getLegacyBackup(captureId)
			: Promise.reject(new Error("archive data layer is unavailable"))
	};
}

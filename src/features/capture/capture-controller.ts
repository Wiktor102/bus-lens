import { recognizeMessagePatterns } from "../analysis/analysis.ts";
import type { StoredFolder } from "../../shared/app-state.ts";
import type { SequenceNoteInput } from "../notes/notes-bridge.ts";
import type { SerialController } from "../transport/serial-controller.ts";
import {
	annotationTargetLabel,
	annotationTextIsValid,
	contextDraftToValues,
	normalizeAnnotationText,
	normalizePatternRemarkText,
	type AnnotationDeleteInput,
	type AnnotationSaveInput,
	type ContextSaveInput,
	type PatternRemarkSaveInput
} from "../dialogs/dialog-model.ts";
import { CAPTURE_INPUT_FORMATS, isSnifferInputFormat } from "./capture-format.ts";
import type { RawByteRecord } from "./capture-summary.ts";
import type { MessageStreamDeriveOptions } from "../message-stream/message-stream.ts";
import {
	applySectionFramingSettings,
	bumpCaptureProjectionGeneration,
	hexByte,
	normalizeCapture,
	normalizeSections,
	rebuildPreview,
	signature,
	captureProjectionToken,
	type CaptureMessage,
	type Capture,
	type NormalizedCaptureSection,
	type SectionFramingUpdate
} from "./capture-framing.ts";
import { moveSection as moveSectionStart, type SectionMoveAction } from "./section-repositioning.ts";
import { createFramingCoordinator, type FramingCoordinator } from "./framing-coordinator.ts";
import { publishDialogCommand } from "../dialogs/dialog-bridge.ts";
import type {
	CaptureWriter,
	CanonicalNoteTarget,
	CaptureMetadataPatch,
	CreateCaptureRequest,
	FramingSectionRequest
} from "../../persistence/archive-client.ts";
import type { ArchiveCommands } from "../../data/archive-data-layer.ts";
import type { ArchiveIndex } from "../../persistence/archive-client.ts";
import type {
	SectionViewPreference,
	SectionViewPreferencePatch,
	SectionViewPreferenceSeed
} from "../../shared/view-state.ts";

export type CaptureControllerDependencies = {
	/** Test-only compatibility input; application wiring uses archive reads instead. */
	state?: ControllerCompatibilityState;
	capture: () => Capture | undefined;
	getCapture?: (captureId: string) => Capture | undefined;
	getCaptures?: () => readonly CaptureIndexEntry[] | undefined;
	getFolders?: () => readonly StoredFolder[] | undefined;
	getArchiveIndex?: () => ArchiveIndex | undefined;
	getActiveId: () => string | null | undefined;
	setActiveId: (captureId: string | null | undefined) => void | Promise<Capture | undefined>;
	setActiveCapture?: (capture: Capture | undefined) => void;
	setSelectedCaptureId?: (captureId: string | null) => void;
	trackCaptureWrite?: (captureId: string, write: Promise<unknown>) => void;
	archiveCommands?: ArchiveCommands;
	render: (options?: CaptureRenderOptions) => void;
	renderMessages: (options?: MessageStreamDeriveOptions) => void;
	showToast: (message: string) => void;
	transport: Pick<SerialController, "isRecording" | "stopRecording"> & {
		isCaptureMutationLocked?: (captureId: string) => boolean;
		isCaptureFinalizing?: (captureId: string) => boolean;
	};
	publishDialogCommand: typeof publishDialogCommand;
	captureWriter?: CaptureWriter;
	isCanonicalCapture?: (captureId: string) => boolean;
	waitForCaptureWrite?: (captureId: string) => Promise<void>;
	isCaptureConversionLocked?: (captureId: string) => boolean;
	setCaptureStorageStatus?: (captureId: string, status: "legacy-not-canonicalized" | "converting" | "canonical" | "canonicalization-failed") => void;
	openCanonicalization?: (captureId: string) => void;
	refreshCapture?: (captureId: string, expectedActiveProfileId?: string) => Promise<Capture>;
	seedSectionViewState?: (captureId: string, sections: readonly SectionViewPreferenceSeed[]) => boolean | void;
	getSectionViewPreference?: (captureId: string, rawStart: number) => SectionViewPreference | undefined;
	setSectionViewState?: (captureId: string, rawStart: number, patch: SectionViewPreferencePatch) => void;
	copySectionViewState?: (captureId: string, fromRawStart: number, toRawStart: number) => boolean | void;
	reconcileSectionViewState?: (captureId: string, rawStarts: readonly number[]) => boolean | void;
	clearSectionViewState?: (captureId: string) => void;
	reportPersistenceFailure?: (captureId: string, error: unknown) => void;
};

type AnnotationValue = { text?: unknown; noteId?: string; [key: string]: unknown };
type PatternRemarkValue = { text?: unknown; noteId?: string; [key: string]: unknown };
type ActiveCaptureSection = NormalizedCaptureSection;
type ActiveCapture = Omit<
	Capture,
	"byteStream" | "frameSections" | "messages" | "params" | "annotations" | "patternRemarks" | "frameSize"
> & {
	byteStream: RawByteRecord[];
	frameSections: ActiveCaptureSection[];
	messages: CaptureMessage[];
	params: Array<{ key?: unknown; value?: unknown }>;
	annotations: Record<string, AnnotationValue>;
	patternRemarks: Record<string, PatternRemarkValue>;
	frameSize: number;
};

type CaptureIndexEntry = Pick<Capture, "id" | "name" | "folderId" | "storageStatus">;
type ControllerCompatibilityState = {
	captures: ActiveCapture[];
	folders: StoredFolder[];
	unfiledCollapsed?: boolean;
};

type CaptureRenderOptions = {
	skipMessageStream?: boolean;
};

type CaptureWriteQueue = {
	metadataPending: CaptureMetadataPatch | null;
	metadataRetries: number;
	running: Promise<void> | null;
};

type PatternRemarkWriteQueue = {
	pendingText: string | undefined;
	noteId?: string;
	retries: number;
	running: Promise<void> | null;
};

function formatTime(ms: number): string {
	return new Date(ms).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		fractionalSecondDigits: 3
	});
}

export function createCaptureController(dependencies: CaptureControllerDependencies) {
	const compatibilityState = dependencies.state;
	const captureWriteQueues = new Map<string, CaptureWriteQueue>();
	const patternRemarkWriteQueues = new Map<string, Map<string, PatternRemarkWriteQueue>>();
	const captureCommandWrites = new Map<string, Set<Promise<unknown>>>();
	const seededSectionStarts = new Map<string, Set<number>>();
	let framingCoordinator: FramingCoordinator;

	function captures(): readonly CaptureIndexEntry[] {
		return dependencies.getCaptures?.() || compatibilityState?.captures || [];
	}

	function folders(): readonly StoredFolder[] {
		return dependencies.getFolders?.() || compatibilityState?.folders || [];
	}

	function capture(): ActiveCapture | undefined {
		return dependencies.capture() as ActiveCapture | undefined;
	}

	function isCanonical(item: Capture | undefined): item is Capture & { id: string } {
		return Boolean(
			item?.id &&
			(dependencies.archiveCommands || dependencies.captureWriter) &&
			(dependencies.isCanonicalCapture?.(String(item.id)) || item.storageStatus === "canonical")
		);
	}

	function isConversionLocked(item: Capture | undefined): boolean {
		return Boolean(item?.id && dependencies.isCaptureConversionLocked?.(String(item.id)));
	}

	function rejectLockedMutation(item: Capture | undefined): boolean {
		if (item?.id && framingCoordinator.isBlocked(String(item.id))) {
			dependencies.showToast("Capture framing could not be confirmed; refresh before editing");
			return true;
		}
		if (item?.id && dependencies.transport.isCaptureMutationLocked?.(String(item.id))) {
			dependencies.showToast("Capture is still being saved; editing is temporarily disabled");
			return true;
		}
		if (!isConversionLocked(item)) return false;
		dependencies.showToast("Capture conversion is in progress; editing is temporarily disabled");
		return true;
	}

	function rejectFrameTargetMutation(item: Capture | undefined): boolean {
		if (rejectLockedMutation(item)) return true;
		if (item?.id && framingCoordinator.isPending(String(item.id))) {
			dependencies.showToast("Capture framing is still being saved; frame actions are temporarily disabled");
			return true;
		}
		return false;
	}

	function reportFailure(captureId: string, error: unknown): void {
		dependencies.reportPersistenceFailure?.(captureId, error);
	}

	function activateCaptureId(captureId: string | null | undefined): void {
		const loading = dependencies.setActiveId(captureId);
		if (!loading) return;
		const expectedId = captureId ? String(captureId) : null;
		void loading.then(() => {
			if ((dependencies.getActiveId() ?? null) === expectedId) dependencies.render();
		}).catch(error => reportFailure(expectedId ?? "archive", error));
	}

	function archiveIndex(overrides: Partial<ArchiveIndex> = {}): ArchiveIndex {
		const current = dependencies.getArchiveIndex?.();
		return {
			activeId: overrides.activeId ?? dependencies.getActiveId() ?? current?.activeId ?? null,
			unfiledCollapsed: overrides.unfiledCollapsed ?? current?.unfiledCollapsed ?? Boolean(compatibilityState?.unfiledCollapsed),
			captures: overrides.captures ?? current?.captures ?? captures().map((item, position) => ({ id: String(item.id), folderId: item.folderId ?? null, position })),
			folders: overrides.folders ?? current?.folders ?? folders().map((item, position) => ({ id: String(item.id), position }))
		};
	}

	function persistArchiveIndex(index = archiveIndex()): void {
		if (dependencies.archiveCommands) {
			void dependencies.archiveCommands.persistArchiveIndex(index).catch(error => reportFailure(String(dependencies.getActiveId() || "archive"), error));
		}
	}

	function persistLegacyCapture(item: ActiveCapture | undefined = capture()): void {
		if (!item) return;
		if (dependencies.archiveCommands) {
			void dependencies.archiveCommands.saveLegacyCapture(item).catch(error => reportFailure(String(item.id), error));
		}
	}

	function reconcileFailure(captureId: string, error: unknown, fallback?: () => void): void {
		reportFailure(captureId, error);
		if (dependencies.refreshCapture) {
			void refreshAuthoritativeCapture(captureId).then(() => dependencies.render()).catch(() => fallback?.());
		} else fallback?.();
	}

	function captureById(captureId: string): ActiveCapture | undefined {
		return (dependencies.getCapture?.(captureId) || captures().find(item => String(item.id) === captureId)) as ActiveCapture | undefined;
	}

	function seedSectionViewPreferences(item: Capture | undefined): boolean {
		if (!item?.id || !dependencies.seedSectionViewState) return false;
		const captureId = String(item.id);
		const sections = (item.frameSections || []).map(section => ({
			rawStart: Number(section.start ?? 0),
			collapseRuns: Boolean(section.collapseRuns),
			collapsed: Boolean(section.collapsed)
		}));
		const currentStarts = new Set(sections.map(section => section.rawStart));
		const seededStarts = seededSectionStarts.get(captureId);
		const pending = sections.filter(section => !seededStarts?.has(section.rawStart));
		seededSectionStarts.set(captureId, currentStarts);
		if (!pending.length) return false;
		return dependencies.seedSectionViewState(captureId, pending) === true;
	}

	function reconcileSectionViewPreferences(item: Capture | undefined): boolean {
		if (!item?.id || !dependencies.reconcileSectionViewState) return false;
		return dependencies.reconcileSectionViewState(
			String(item.id),
			(item.frameSections || []).map(section => Number(section.start ?? 0))
		) === true;
	}

	function installAuthoritativeCapture(captureId: string, refreshed: Capture, projectionChanged: boolean): boolean {
		const current = capture();
		// The runtime has already transferred this refresh into its single owned
		// mutable projection. Never clone the full graph again in the controller.
		const mutableCurrent = current && String(current.id) === captureId ? current : undefined;
		if (mutableCurrent && mutableCurrent !== refreshed) Object.assign(mutableCurrent, refreshed);
		const activeProjection = mutableCurrent || refreshed;
		if (projectionChanged) bumpCaptureProjectionGeneration(activeProjection);
		if (compatibilityState) {
			const index = compatibilityState.captures.findIndex(item => String(item.id) === captureId);
			if (index >= 0 && compatibilityState.captures[index] !== activeProjection) {
				compatibilityState.captures[index] = activeProjection as ActiveCapture;
			}
		}
		if (
			String(dependencies.getActiveId() ?? "") === captureId &&
			(projectionChanged || activeProjection !== current)
		) dependencies.setActiveCapture?.(activeProjection);
		return seedSectionViewPreferences(activeProjection);
	}

	function applyPendingFraming(captureId: string, sections: readonly FramingSectionRequest[]): void {
		const item = captureById(captureId);
		if (!item) return;
		applyFramingSnapshot(item, sections);
		rebuildPreview(item);
		dependencies.renderMessages();
	}

	type AuthoritativeRefreshResult = {
		capture: Capture;
		projectionChanged: boolean;
		viewStateChanged: boolean;
		pendingIntentApplied: boolean;
	};

	async function refreshAuthoritativeCaptureState(
		captureId: string,
		preserveIntent = true,
		expectedActiveProfileId?: string,
		reconcileViewState = !preserveIntent
	): Promise<AuthoritativeRefreshResult> {
		if (!dependencies.refreshCapture) throw new Error("capture refresh is unavailable");
		const previousProjectionToken = captureProjectionToken(capture());
		const refreshed = await dependencies.refreshCapture(captureId, expectedActiveProfileId);
		if (expectedActiveProfileId && refreshed.activeFramingProfileId !== expectedActiveProfileId) {
			throw new Error(
				`capture ${captureId} refresh returned active framing profile ${refreshed.activeFramingProfileId ?? "none"}; ` +
				`expected ${expectedActiveProfileId}`
			);
		}
		const projectionChanged = previousProjectionToken !== captureProjectionToken(refreshed);
		let viewStateChanged = installAuthoritativeCapture(captureId, refreshed, projectionChanged);
		// A move is staged as a copy and a delete keeps its old locator until the
		// framing command is acknowledged. Reconcile only after an authoritative
		// refresh that is not carrying a newer queued intent; otherwise the retry
		// projection would discard the staged locator before it can be acknowledged.
		if (reconcileViewState && !framingCoordinator.pendingIntent(captureId)) {
			viewStateChanged = reconcileSectionViewPreferences(refreshed) || viewStateChanged;
		}
		framingCoordinator.acknowledgeAuthoritativeRefresh(captureId);
		let pendingIntentApplied = false;
		if (preserveIntent) {
			const intent = framingCoordinator.pendingIntent(captureId) || framingCoordinator.activeIntent(captureId);
			if (intent) {
				applyPendingFraming(captureId, intent);
				pendingIntentApplied = true;
			}
		}
		return {
			capture: refreshed,
			projectionChanged,
			viewStateChanged,
			pendingIntentApplied
		};
	}

	async function refreshAuthoritativeCapture(
		captureId: string,
		preserveIntent = true,
		expectedActiveProfileId?: string,
		reconcileViewState = !preserveIntent
	): Promise<Capture> {
		return (await refreshAuthoritativeCaptureState(captureId, preserveIntent, expectedActiveProfileId, reconcileViewState)).capture;
	}

	function renderAuthoritativeRefresh(result: AuthoritativeRefreshResult): void {
		if (result.projectionChanged && !result.viewStateChanged && !result.pendingIntentApplied) dependencies.render();
	}

	function metadataPatchValue(item: ActiveCapture): CaptureMetadataPatch {
		const inputFormat = isSnifferInputFormat(item.inputFormat)
			? CAPTURE_INPUT_FORMATS.SNIFFER
			: CAPTURE_INPUT_FORMATS.BINARY;
		return {
			name: String(item.name ?? ""),
			description: String(item.description ?? ""),
			controllerView: String(item.view ?? ""),
			baudRate: Number(item.baudRate ?? 115200),
			inputFormat,
			folderId: item.folderId ?? null,
			parameters: item.params.flatMap(parameter => {
				const key = String(parameter.key ?? "").trim();
				return key ? [{ key, value: String(parameter.value ?? "") }] : [];
			})
		};
	}

	function applyMetadataSnapshot(item: ActiveCapture, patch: CaptureMetadataPatch): void {
		if (patch.name !== undefined) item.name = patch.name;
		if (patch.description !== undefined) item.description = patch.description;
		if (patch.controllerView !== undefined) item.view = patch.controllerView;
		else if (patch.view !== undefined) item.view = patch.view;
		if (patch.baudRate !== undefined) item.baudRate = patch.baudRate;
		if (patch.inputFormat !== undefined) item.inputFormat = patch.inputFormat;
		if ("folderId" in patch) item.folderId = patch.folderId ?? null;
		if (patch.parameters) item.params = patch.parameters.map(parameter => ({ key: parameter.key, value: parameter.value }));
	}

	function applyFramingSnapshot(item: ActiveCapture, sections: readonly FramingSectionRequest[]): void {
		item.frameSections = sections.map(section => ({ ...section })) as ActiveCaptureSection[];
		normalizeSections(item);
	}

	function reapplyPendingSnapshots(captureId: string, queue: CaptureWriteQueue): void {
		const item = captureById(captureId);
		if (!item) return;
		if (queue.metadataPending) applyMetadataSnapshot(item, queue.metadataPending);
	}

	function captureWriteBarrier(captureId: string): Promise<void> | undefined {
		// Finalization waits for this coordinator below. A retry that has already
		// entered the coordinator must therefore not wait back on finalization's
		// runtime-barrier promise.
		if (dependencies.transport.isCaptureFinalizing?.(captureId)) return undefined;
		return dependencies.waitForCaptureWrite?.(captureId);
	}

	async function writeMetadata(captureId: string, patch: CaptureMetadataPatch): Promise<void> {
		const barrier = captureWriteBarrier(captureId);
		if (barrier) await barrier;
		const item = captureById(captureId);
		if (!item || !isCanonical(item)) return;
		const operation = dependencies.archiveCommands
			? dependencies.archiveCommands.patchMetadata({
				captureId: item.id,
				expectedMetadataRevision: item.metadataRevision,
				patch
			})
			: dependencies.captureWriter!.patchMetadata({
			captureId: item.id,
			expectedMetadataRevision: item.metadataRevision,
			patch
			});
		dependencies.trackCaptureWrite?.(captureId, operation);
		const result = await operation;
		const current = captureById(captureId);
		if (current) {
			current.metadataRevision = result.metadataRevision;
			current.updatedAt = result.updatedAt;
		}
	}

	async function writeFraming(captureId: string, sections: readonly FramingSectionRequest[]): Promise<void> {
		const barrier = captureWriteBarrier(captureId);
		if (barrier) await barrier;
		const item = captureById(captureId);
		if (!item || !isCanonical(item)) throw new Error(`capture ${captureId} is no longer available for framing`);
		if (dependencies.transport.isRecording() || dependencies.transport.isCaptureFinalizing?.(captureId)) {
			const operation = dependencies.archiveCommands
				? dependencies.archiveCommands.recordingWriter.updateFramingDraft({
					captureId: item.id,
					sections,
					expectedRevision: item.framingDraftRevision
				})
				: dependencies.captureWriter!.updateFramingDraft({
				captureId: item.id,
				sections,
				expectedRevision: item.framingDraftRevision
				});
			dependencies.trackCaptureWrite?.(captureId, operation);
			const draft = await operation;
			const current = captureById(captureId);
			if (current) {
				current.framingDraftRevision = draft.revision;
			}
		} else {
			const operation = dependencies.archiveCommands
				? dependencies.archiveCommands.recordingWriter.reframe({
					captureId: item.id,
					sections,
					expectedActiveProfileId: item.activeFramingProfileId,
					expectedDataRevision: Number(item.dataRevision ?? 0)
				})
				: dependencies.captureWriter!.reframe({
				captureId: item.id,
				sections,
				expectedActiveProfileId: item.activeFramingProfileId,
				expectedDataRevision: Number(item.dataRevision ?? 0)
				});
			dependencies.trackCaptureWrite?.(captureId, operation);
			const reframe = await operation;
			// Reframe is a durable raw-writer command.  Reload through the named
			// data-layer path so the full capture query cannot remain stale. A
			// pre-command fetch may be deduplicated by QueryClient and return the
			// previous profile, so the data layer refetches until this exact response
			// identity is observed before the coordinator can unlock frame commands.
			const refresh = await refreshAuthoritativeCaptureState(captureId, false, reframe.profileId, true);
			renderAuthoritativeRefresh(refresh);
		}
	}

	framingCoordinator = createFramingCoordinator({
		write: writeFraming,
		reload: async (captureId, preserveIntent) => {
			const refresh = await refreshAuthoritativeCaptureState(captureId, preserveIntent);
			renderAuthoritativeRefresh(refresh);
		},
		applyPending: applyPendingFraming,
		onTerminalFailure: (captureId, error) => {
			reportFailure(captureId, error);
		},
		onStateChange: captureId => {
			if (String(dependencies.getActiveId() ?? "") === captureId) dependencies.render({ skipMessageStream: true });
		}
	});

	async function recoverCaptureWrite(
		captureId: string,
		queue: CaptureWriteQueue,
		_kind: "metadata",
		desired: CaptureMetadataPatch,
		error: unknown
	): Promise<void> {
		const retries = queue.metadataRetries;
		const latest = queue.metadataPending ?? desired;
		if (retries >= 1 || !dependencies.refreshCapture) {
			queue.metadataPending = null;
			queue.metadataRetries = 0;
			reapplyPendingSnapshots(captureId, queue);
			reportFailure(captureId, error);
			dependencies.render();
			return;
		}
		queue.metadataRetries += 1;
		queue.metadataPending = latest;
		try {
			await refreshAuthoritativeCapture(captureId);
			reapplyPendingSnapshots(captureId, queue);
			dependencies.render();
		} catch (refreshError) {
			queue.metadataPending = null;
			queue.metadataRetries = 0;
			reapplyPendingSnapshots(captureId, queue);
			reportFailure(captureId, refreshError);
			dependencies.render();
		}
	}

	function patternRemarkQueuesForCapture(captureId: string): Map<string, PatternRemarkWriteQueue> {
		const queues = patternRemarkWriteQueues.get(captureId) || new Map<string, PatternRemarkWriteQueue>();
		patternRemarkWriteQueues.set(captureId, queues);
		return queues;
	}

	function patternRemarkQueue(captureId: string, patternKey: string, noteId?: string): PatternRemarkWriteQueue {
		const queues = patternRemarkQueuesForCapture(captureId);
		const existing = queues.get(patternKey);
		if (existing) {
			if (!existing.noteId && noteId) existing.noteId = noteId;
			return existing;
		}
		const queue: PatternRemarkWriteQueue = { pendingText: undefined, noteId, retries: 0, running: null };
		queues.set(patternKey, queue);
		return queue;
	}

	async function writePatternRemark(
		captureId: string,
		patternKey: string,
		queue: PatternRemarkWriteQueue,
		text: string
	): Promise<void> {
		const barrier = captureWriteBarrier(captureId);
		if (barrier) await barrier;
		const item = captureById(captureId);
		if (!item || !isCanonical(item)) return;
		const target: CanonicalNoteTarget = { kind: "pattern", sequenceKey: patternKey };
		if (text) {
			const operation = queue.noteId
				? (dependencies.archiveCommands
					? dependencies.archiveCommands.updateNote({ captureId: item.id, noteId: queue.noteId, text, target })
					: dependencies.captureWriter!.updateNote({ captureId: item.id, noteId: queue.noteId, text, target }))
				: (dependencies.archiveCommands
					? dependencies.archiveCommands.createNote({ captureId: item.id, text, target })
					: dependencies.captureWriter!.createNote({ captureId: item.id, text, target }));
			dependencies.trackCaptureWrite?.(captureId, operation);
			const result = await operation;
			queue.noteId = result.note.id;
			const current = captureById(captureId);
			if (current) {
				const optimistic = current.patternRemarks[patternKey];
				if (optimistic && typeof optimistic === "object") optimistic.noteId = result.note.id;
				current.contentRevision = result.contentRevision;
			}
		} else if (queue.noteId) {
			const operation = dependencies.archiveCommands
				? dependencies.archiveCommands.deleteNote({ captureId: item.id, noteId: queue.noteId })
				: dependencies.captureWriter!.deleteNote({ captureId: item.id, noteId: queue.noteId });
			dependencies.trackCaptureWrite?.(captureId, operation);
			await operation;
			queue.noteId = undefined;
		}
	}

	async function recoverPatternRemarkWrite(
		captureId: string,
		patternKey: string,
		queue: PatternRemarkWriteQueue,
		desiredText: string,
		error: unknown
	): Promise<void> {
		const latestText = queue.pendingText ?? desiredText;
		if (queue.retries >= 1 || !dependencies.refreshCapture) {
			queue.pendingText = undefined;
			queue.retries = 0;
			reportFailure(captureId, error);
			dependencies.renderMessages();
			return;
		}
		queue.pendingText = latestText;
		queue.retries += 1;
		try {
			await refreshAuthoritativeCapture(captureId);
			const current = captureById(captureId);
			const loaded = current?.patternRemarks?.[patternKey];
			const loadedValue = loaded && typeof loaded === "object" ? loaded as PatternRemarkValue : undefined;
			queue.noteId = loadedValue?.noteId ? String(loadedValue.noteId) : undefined;
			if (current) {
				if (latestText) {
					current.patternRemarks[patternKey] = {
						text: latestText,
						updatedAt: Date.now(),
						...(queue.noteId ? { noteId: queue.noteId } : {})
					};
				} else delete current.patternRemarks[patternKey];
				bumpCaptureProjectionGeneration(current);
			}
			dependencies.renderMessages();
		} catch (refreshError) {
			queue.pendingText = undefined;
			queue.retries = 0;
			reportFailure(captureId, refreshError);
			dependencies.renderMessages();
		}
	}

	function drainPatternRemarkWrites(captureId: string, patternKey: string, queue: PatternRemarkWriteQueue): Promise<void> {
		if (queue.running) return queue.running;
		queue.running = (async () => {
			while (queue.pendingText !== undefined) {
				const text = queue.pendingText;
				queue.pendingText = undefined;
				try {
					await writePatternRemark(captureId, patternKey, queue, text);
					queue.retries = 0;
				} catch (error) {
					await recoverPatternRemarkWrite(captureId, patternKey, queue, text, error);
				}
			}
		})().finally(() => {
			queue.running = null;
			const queues = patternRemarkWriteQueues.get(captureId);
			if (queues?.get(patternKey) === queue && queue.pendingText === undefined) {
				queues.delete(patternKey);
				if (!queues.size) patternRemarkWriteQueues.delete(captureId);
			}
		});
		return queue.running;
	}

	function queuePatternRemarkWrite(captureId: string, patternKey: string, text: string, noteId?: string): void {
		const queue = patternRemarkQueue(captureId, patternKey, noteId);
		queue.pendingText = text;
		void drainPatternRemarkWrites(captureId, patternKey, queue);
	}

	function drainCaptureWrites(captureId: string, queue: CaptureWriteQueue): Promise<void> {
		if (queue.running) return queue.running;
		queue.running = (async () => {
			while (queue.metadataPending) {
				if (queue.metadataPending) {
					const patch = queue.metadataPending;
					queue.metadataPending = null;
					try {
						await writeMetadata(captureId, patch);
						if (!queue.metadataPending) {
							const current = captureById(captureId);
							if (current) applyMetadataSnapshot(current, patch);
						}
						queue.metadataRetries = 0;
					} catch (error) {
						await recoverCaptureWrite(captureId, queue, "metadata", patch, error);
					}
				}
			}
		})().finally(() => {
			queue.running = null;
			if (!queue.metadataPending) captureWriteQueues.delete(captureId);
		});
		return queue.running;
	}

	function queueCaptureWrite(
		captureId: string,
		kind: "metadata" | "framing",
		value: CaptureMetadataPatch | FramingSectionRequest[]
	): void {
		if (kind === "framing") {
			framingCoordinator.enqueue(captureId, value as FramingSectionRequest[]);
			return;
		}
		const queue = captureWriteQueues.get(captureId) || {
			metadataPending: null,
			metadataRetries: 0,
			running: null
		};
		captureWriteQueues.set(captureId, queue);
		queue.metadataPending = value as CaptureMetadataPatch;
		void drainCaptureWrites(captureId, queue);
	}

	async function waitForCaptureWrites(captureId: string): Promise<void> {
		while (true) {
			const captureQueue = captureWriteQueues.get(captureId);
			const patternQueues = patternRemarkWriteQueues.get(captureId);
			const running = [
				...(captureCommandWrites.get(captureId) || []),
				...(captureQueue?.running ? [captureQueue.running] : []),
				...(framingCoordinator.isPending(captureId) && !framingCoordinator.isBlocked(captureId)
					? [framingCoordinator.waitFor(captureId)]
					: []),
				...(patternQueues ? [...patternQueues.values()].flatMap(queue => queue.running ? [queue.running] : []) : [])
			];
			if (!running.length) return;
			await Promise.all(running);
		}
	}

	function trackCaptureCommand(captureId: string, write: Promise<unknown>): void {
		const writes = captureCommandWrites.get(captureId) || new Set<Promise<unknown>>();
		writes.add(write);
		captureCommandWrites.set(captureId, writes);
		const remove = () => {
			writes.delete(write);
			if (!writes.size) captureCommandWrites.delete(captureId);
		};
		void write.then(remove, remove);
		dependencies.trackCaptureWrite?.(captureId, write);
	}

	function metadataPatch(item: ActiveCapture): void {
		if (rejectLockedMutation(item)) return;
		if (!isCanonical(item)) {
			persistLegacyCapture(item);
			return;
		}
		queueCaptureWrite(item.id, "metadata", metadataPatchValue(item));
	}

	function framingRequest(item: ActiveCapture): FramingSectionRequest[] {
		normalizeSections(item);
		return item.frameSections.map(section => ({
			start: section.start,
			framingMode: section.framingMode,
			frameSize: section.frameSize,
			frameMarker: section.frameMarker,
			markerPosition: section.markerPosition,
			frameTimeGap: section.frameTimeGap
		}));
	}

	function persistFraming(item: ActiveCapture, _immediate = false): boolean {
		if (rejectLockedMutation(item)) return false;
		if (!isCanonical(item)) {
			persistLegacyCapture(item);
			return false;
		}
		queueCaptureWrite(item.id, "framing", framingRequest(item));
		return true;
	}

	function selectArchiveCapture(captureId: string) {
		activateCaptureId(captureId);
		dependencies.setSelectedCaptureId?.(captureId);
		persistArchiveIndex(archiveIndex({ activeId: captureId }));
		dependencies.render();
	}

	function toggleArchiveFolder(folderId: string | null) {
		if (folderId) {
			const folder = folders().find(item => item.id === folderId);
			if (!folder) return;
			const nextFolder = { ...folder, collapsed: !folder.collapsed };
			if (dependencies.archiveCommands) {
				void dependencies.archiveCommands.saveFolder(nextFolder).catch(error => {
					reportFailure(folderId, error);
					dependencies.render();
				});
			} else if (compatibilityState) {
				compatibilityState.folders = compatibilityState.folders.map(item => item.id === folderId ? nextFolder : item);
				persistArchiveIndex();
			}
		} else {
			const current = archiveIndex();
			if (compatibilityState) compatibilityState.unfiledCollapsed = !compatibilityState.unfiledCollapsed;
			persistArchiveIndex({ ...current, unfiledCollapsed: !current.unfiledCollapsed });
		}
	}

	function setAllArchiveFoldersCollapsed(collapsed: boolean) {
		const nextFolders = folders().map(folder => ({ ...folder, collapsed }));
		const current = archiveIndex();
		if (compatibilityState) {
			compatibilityState.folders = compatibilityState.folders.map(folder => ({ ...folder, collapsed }));
			compatibilityState.unfiledCollapsed = collapsed;
		}
		if (dependencies.archiveCommands) {
			void Promise.all([
				...nextFolders.map(folder => dependencies.archiveCommands!.saveFolder(folder)),
				dependencies.archiveCommands.persistArchiveIndex({ ...current, unfiledCollapsed: collapsed })
			]).catch(error => reportFailure("archive", error));
			return;
		}
		persistArchiveIndex({ ...current, unfiledCollapsed: collapsed });
	}

	function moveArchiveCapture(captureId: string, folderId: string | null) {
		const item = captures().find(capture => String(capture.id) === String(captureId));
		if (!item) return;
		const folderNameById = new Map(folders().map(folder => [folder.id, folder.name]));
		const nextFolderId = folderId || null;
		if (compatibilityState) {
			const fullItem = captureById(captureId);
			if (!fullItem || rejectLockedMutation(fullItem)) return;
			fullItem.folderId = nextFolderId;
			metadataPatch(fullItem);
			compatibilityState.captures = compatibilityState.captures.map(candidate => candidate === fullItem ? fullItem : candidate);
		} else if (dependencies.archiveCommands) {
			void dependencies.archiveCommands.patchMetadata({ captureId: String(captureId), patch: { folderId: nextFolderId } }).catch(error => reportFailure(String(captureId), error));
		}
		const current = archiveIndex();
		persistArchiveIndex({
			...current,
			captures: current.captures.map(candidate => candidate.id === String(captureId) ? { ...candidate, folderId: nextFolderId } : candidate)
		});
		dependencies.showToast(nextFolderId ? `Moved to ${folderNameById.get(nextFolderId)}` : "Moved to Unfiled");
	}

	function upgradeCapture(captureId: string): void {
		const item = captures().find(captureItem => String(captureItem.id) === String(captureId));
		if (item?.id) dependencies.openCanonicalization?.(String(item.id));
	}

	function saveFolder(name: string, editingId: string | null, onCreated?: (folderId: string) => void) {
		const trimmedName = String(name).trim();
		const duplicate = folders().some(
			folder => folder.id !== editingId && folder.name.toLowerCase() === trimmedName.toLowerCase()
		);
		if (!trimmedName || duplicate) return false;
		const folder = folders().find(item => item.id === editingId);
		const creating = !folder;
		let savedFolder: StoredFolder;
		if (folder) {
			savedFolder = { ...folder, name: trimmedName };
			dependencies.showToast("Folder renamed");
		} else {
			savedFolder = {
				id: crypto.randomUUID(),
				name: trimmedName,
				collapsed: false,
				createdAt: new Date().toISOString()
			};
			dependencies.showToast("Folder created");
		}
		if (savedFolder && dependencies.archiveCommands) {
			void dependencies.archiveCommands.saveFolder({ ...savedFolder }).then(() => {
				if (creating) onCreated?.(savedFolder.id);
			}).catch(error => {
				reportFailure(savedFolder.id, error);
				dependencies.render();
			});
		} else if (savedFolder && compatibilityState) {
			compatibilityState.folders = folder
				? compatibilityState.folders.map(item => item.id === editingId ? savedFolder : item)
				: [...compatibilityState.folders, savedFolder];
			persistArchiveIndex();
			if (creating) onCreated?.(savedFolder.id);
		}
		return true;
	}

	function requestDeleteFolder(folderId: string) {
		const folder = folders().find(item => item.id === folderId);
		if (!folder) return;
		const affectedCaptures = captures().filter(item => item.folderId === folderId);
		const captureCount = affectedCaptures.length;
		const detail = captureCount
			? `${captureCount} capture${captureCount === 1 ? "" : "s"} will be moved to Unfiled.`
			: "";
		dependencies.publishDialogCommand({
			type: "confirmation",
			title: "Delete folder?",
			message: `“${folder.name}” will be removed from the archive.`,
			detail: detail || "Captures already in other folders will not be affected.",
			confirmLabel: "Delete folder",
			action: { type: "archive/delete-folder", folderId }
		});
	}

	function deleteFolder(folderId: string) {
		const folder = folders().find(item => item.id === folderId);
		if (!folder) return;
		const affectedCaptures = captures().filter(item => item.folderId === folderId);
		const captureCount = affectedCaptures.length;
		if (compatibilityState) {
			compatibilityState.captures.forEach(item => {
				if (item.folderId === folderId) {
					item.folderId = null;
					if (isCanonical(item)) metadataPatch(item);
				}
			});
			compatibilityState.folders = compatibilityState.folders.filter(item => item.id !== folderId);
		}
		if (dependencies.archiveCommands) {
			void Promise.all([
				...affectedCaptures.map(item => dependencies.archiveCommands!.patchMetadata({ captureId: String(item.id), patch: { folderId: null } })),
				dependencies.archiveCommands.deleteFolder(folderId)
			]).catch(error => reportFailure(folderId, error));
		}
		const current = archiveIndex();
		persistArchiveIndex({
			...current,
			captures: current.captures.map(item => item.folderId === folderId ? { ...item, folderId: null } : item),
			folders: current.folders.filter(item => item.id !== folderId)
		});
		dependencies.showToast(captureCount ? "Folder deleted; captures moved to Unfiled" : "Folder deleted");
	}

	function addSequenceNote({ start: rawStart, end: rawEnd, text: rawText }: SequenceNoteInput): boolean {
		const c = capture();
		const noteText = String(rawText || "").trim();
		if (!c || !noteText) return false;
		if (rejectFrameTargetMutation(c)) return false;
		const max = Math.max(1, c.messages.length);
		const start = Math.max(1, Math.min(max, Number(rawStart) || 1));
		const end = Math.max(start, Math.min(max, Number(rawEnd) || start));
		const notes = c.notes ||= [];
		notes.push({
			id: crypto.randomUUID(),
			type: "sequence",
			text: noteText,
			createdAt: Date.now(),
			start,
			end,
			targetLabel: `rows ${start}–${end}`
		});
		const optimistic = notes.at(-1)!;
		if (isCanonical(c) && c.activeFramingProfileId) {
			const operation = dependencies.archiveCommands
				? dependencies.archiveCommands.createNote({
					captureId: c.id,
					text: noteText,
					target: {
						kind: "range",
						profileId: c.activeFramingProfileId,
						startOrdinal: start - 1,
						endOrdinal: end - 1
					}
				})
				: dependencies.captureWriter!.createNote({
				captureId: c.id,
				text: noteText,
				target: {
					kind: "range",
					profileId: c.activeFramingProfileId,
					startOrdinal: start - 1,
					endOrdinal: end - 1
				}
				});
			dependencies.trackCaptureWrite?.(c.id, operation);
			void operation.then(result => {
				optimistic.id = result.note.id;
				c.contentRevision = result.contentRevision;
			}).catch(error => reconcileFailure(c.id, error, () => {
				c.notes = notes.filter(note => note !== optimistic);
				dependencies.render();
			}));
		} else persistLegacyCapture(c);
		dependencies.renderMessages();
		dependencies.showToast("Sequence observation added");
		return true;
	}

	function setCaptureTitle(value: string) {
		const c = capture();
		if (!c || isConversionLocked(c)) return;
		c.name = value;
	}

	function commitCaptureTitle(value: string) {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		c.name = value;
		metadataPatch(c);
		dependencies.render();
	}

	function setCaptureDescription(value: string) {
		const c = capture();
		if (!c || isConversionLocked(c)) return;
		c.description = value;
	}

	function commitCaptureDescription(value: string) {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		c.description = value;
		metadataPatch(c);
		dependencies.render();
	}

	function duplicateCapture(source: ActiveCapture | undefined) {
		if (!source || rejectLockedMutation(source)) return;
		const copy = structuredClone(source);
		copy.id = crypto.randomUUID();
		copy.name += " · copy";
		copy.createdAt = new Date().toISOString();
		copy.messages.forEach(message => (message.id = crypto.randomUUID()));
		copy.annotations = {};
		if (compatibilityState) compatibilityState.captures.unshift(copy);
		dependencies.setActiveCapture?.(copy);
		activateCaptureId(copy.id);
		dependencies.setSelectedCaptureId?.(String(copy.id));
		if (isCanonical(source)) {
			const duplicateWrite = (dependencies.archiveCommands
				? dependencies.archiveCommands.duplicateCapture(source.id, String(copy.id))
				: dependencies.captureWriter!.duplicate({ captureId: source.id, duplicateCaptureId: String(copy.id) }))
				.then(() => dependencies.refreshCapture?.(String(copy.id)))
				.then(refreshed => {
					if (refreshed) {
						if (compatibilityState) {
							Object.assign(copy, refreshed);
							bumpCaptureProjectionGeneration(copy);
						}
						dependencies.setActiveCapture?.(refreshed);
					}
					dependencies.render();
				})
				.catch(error => {
					if (compatibilityState) compatibilityState.captures = compatibilityState.captures.filter(item => item !== copy);
					activateCaptureId(source.id);
					dependencies.setActiveCapture?.(source);
					dependencies.setSelectedCaptureId?.(String(source.id));
					reportFailure(source.id, error);
					dependencies.render();
				});
			trackCaptureCommand(String(source.id), duplicateWrite);
			trackCaptureCommand(String(copy.id), duplicateWrite);
		} else persistLegacyCapture(copy);
		persistArchiveIndex();
		dependencies.render();
	}

	function duplicateArchiveCapture(captureId: string) {
		duplicateCapture(captureById(captureId));
	}

	function duplicateActiveCapture() {
		duplicateCapture(capture());
	}

	function requestDeleteArchiveCapture(captureId: string): void {
		const item = captureById(String(captureId)) || captures().find(captureItem => String(captureItem.id) === String(captureId)) as ActiveCapture | undefined;
		if (!item || rejectLockedMutation(item)) return;
		dependencies.publishDialogCommand({
			type: "confirmation",
			title: "Delete capture?",
			message: `“${item.name}” will be permanently removed.`,
			detail: "Captured bytes, framing, notes, annotations, and metadata will be deleted.",
			confirmLabel: "Delete capture",
			action: { type: "capture/delete", captureId: String(captureId) }
		});
	}

	async function deleteArchiveCapture(captureId: string): Promise<void> {
		let item = captureById(String(captureId)) || captures().find(captureItem => String(captureItem.id) === String(captureId)) as ActiveCapture | undefined;
		if (!item || rejectLockedMutation(item)) return;
		const deletingActiveCapture = dependencies.getActiveId() === captureId;
		if (deletingActiveCapture) {
			try {
				// stopRecording is idempotent when idle, and also waits for an already
				// pending shutdown whose synchronous recording flag is already false.
				await dependencies.transport.stopRecording();
			} catch {
				// The transport owns the recovery state and must keep the capture
				// available for retry/export when shutdown cannot be completed.
				dependencies.render();
				return;
			}
		}
		await dependencies.waitForCaptureWrite?.(String(captureId));
		await waitForCaptureWrites(String(captureId));
		item = captureById(String(captureId)) || item;
		if (!item) return;
		if (deletingActiveCapture) {
			const next = captures().find(captureItem => String(captureItem.id) !== String(captureId));
			activateCaptureId(next?.id ? String(next.id) : null);
			dependencies.setSelectedCaptureId?.(next?.id ? String(next.id) : null);
		}
		const itemId = String(item.id);
		try {
			if (dependencies.archiveCommands) await dependencies.archiveCommands.deleteCapture(itemId);
			else if (isCanonical(item)) await dependencies.captureWriter!.delete(itemId);
		} catch (error) {
			if (compatibilityState) compatibilityState.captures.unshift(item);
			if (deletingActiveCapture) {
				activateCaptureId(itemId);
				dependencies.setActiveCapture?.(item);
				dependencies.setSelectedCaptureId?.(itemId);
			}
			reportFailure(itemId, error);
			dependencies.render();
			return;
		}
		if (compatibilityState) compatibilityState.captures = compatibilityState.captures.filter(candidate => candidate !== item);
		seededSectionStarts.delete(itemId);
		dependencies.clearSectionViewState?.(itemId);
		const current = archiveIndex();
		persistArchiveIndex({
			...current,
			activeId: deletingActiveCapture ? dependencies.getActiveId() ?? null : current.activeId,
			captures: current.captures.filter(candidate => candidate.id !== itemId)
		});
		dependencies.render();
	}

	function requestClearActiveCaptureMessages(): void {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		dependencies.publishDialogCommand({
			type: "confirmation",
			eyebrow: "Capture data",
			title: "Clear capture data?",
			message: "This capture will be emptied of its captured data.",
			detail: "Raw bytes, messages, annotations, and recognized sequence notes will be removed.",
			confirmLabel: "Clear capture",
			action: { type: "capture/clear-messages" }
		});
	}

	function clearActiveCaptureMessages() {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		c.byteStream = [];
		c.messages = [];
		c.annotations = {};
		c.patternRemarks = {};
		bumpCaptureProjectionGeneration(c);
		if (isCanonical(c)) {
			const operation = dependencies.archiveCommands
				? dependencies.archiveCommands.clearCaptureData(c.id)
				: dependencies.captureWriter!.clearData({ captureId: c.id });
			dependencies.trackCaptureWrite?.(c.id, operation);
			void operation.then(result => {
				if (!result) return;
				c.dataRevision = result.dataRevision;
				c.contentRevision = result.contentRevision;
			}).catch(error => reconcileFailure(c.id, error));
		} else persistLegacyCapture(c);
		dependencies.render();
	}

	async function deleteActiveCapture(): Promise<void> {
		const activeId = dependencies.getActiveId();
		if (activeId) await deleteArchiveCapture(activeId);
	}

	function requestDeleteActiveCapture(): void {
		const activeId = dependencies.getActiveId();
		if (activeId) requestDeleteArchiveCapture(activeId);
	}

	function publishContextDialog(isNew = false) {
		const creatingNewCapture = isNew === true;
		const c = creatingNewCapture
			? { name: "Untitled capture", view: "", params: [], baudRate: 115200, inputFormat: CAPTURE_INPUT_FORMATS.BINARY, folderId: null, id: null }
			: capture();
		if (!c) return;
		if (!creatingNewCapture && rejectLockedMutation(c as ActiveCapture)) return;
		dependencies.publishDialogCommand({
			type: "context",
			mode: creatingNewCapture ? "new" : "edit",
			captureId: creatingNewCapture ? null : String(c.id),
			name: String(c.name ?? "Untitled capture"),
			view: String(c.view ?? ""),
			folderId: c.folderId ? String(c.folderId) : null,
			baudRate: Number(c.baudRate || 115200),
			inputFormat: isSnifferInputFormat(c.inputFormat) ? CAPTURE_INPUT_FORMATS.SNIFFER : CAPTURE_INPUT_FORMATS.BINARY,
			params: (Array.isArray(c.params) ? c.params : []).map(parameter => {
				const item = parameter as { key?: unknown; value?: unknown };
				return {
					key: String(item.key ?? ""),
					value: String(item.value ?? "")
				};
			}),
			folders: folders().map(folder => ({ id: String(folder.id), name: String(folder.name || "") }))
		});
	}

	function startSectionAtByte(messageId: string, position: number) {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		const message = c.messages.find(item => item.id === messageId);
		if (!message) return;
		const start = message._rawPositions?.[position];
		if (typeof start !== "number" || !Number.isInteger(start)) return;
		c.previewMode = "sections";
		normalizeSections(c);
		if (c.frameSections.some(section => section.start === start)) {
			dependencies.render();
			dependencies.showToast(
				start === 0 ? "The first raw byte already begins section 01" : `Raw byte ${start + 1} already begins a section`
			);
			return;
		}
		const preceding = [...c.frameSections].reverse().find(section => section.start < start);
		const inherited = preceding || c.frameSections[0];
		const inheritedViewPreference = c.id !== undefined && inherited
			? dependencies.getSectionViewPreference?.(String(c.id), inherited.start)
			: undefined;
		c.frameSections.push({
			id: crypto.randomUUID(),
			start,
			framingMode: "length",
			frameSize: inherited?.frameSize || 3,
			frameMarker: inherited?.frameMarker || "",
			markerPosition: inherited?.markerPosition || "start",
			frameTimeGap: inherited?.frameTimeGap || 5,
			collapseRuns: inheritedViewPreference?.collapseRuns ?? Boolean(inherited?.collapseRuns),
			collapsed: false
		});
		normalizeSections(c);
		rebuildPreview(c);
		if (!seedSectionViewPreferences(c)) dependencies.renderMessages();
		if (!persistFraming(c)) dependencies.render({ skipMessageStream: true });
	}

	function updateSectionFraming(sectionId: string, update: SectionFramingUpdate, toast: (section: ActiveCaptureSection) => string) {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		normalizeSections(c);
		const section = c.frameSections.find(item => item.id === sectionId);
		if (!section) return;
		applySectionFramingSettings(section, update);
		rebuildPreview(c);
		dependencies.renderMessages();
		if (!persistFraming(c)) dependencies.render({ skipMessageStream: true });
		dependencies.showToast(toast(section));
	}

	function setSectionFraming(sectionId: string, update: SectionFramingUpdate) {
		updateSectionFraming(sectionId, update, () => "Section framing updated");
	}

	function setSectionFrameSize(sectionId: string, value: number | string) {
		updateSectionFraming(sectionId, { frameSize: value }, section => `Section message length set to ${section.frameSize} bytes`);
	}

	function setSectionFramingMode(sectionId: string, framingMode: string) {
		updateSectionFraming(sectionId, { framingMode }, section => `Section framing set to ${section.framingMode.toUpperCase()}`);
	}

	function setSectionFrameMarker(sectionId: string, frameMarker: string) {
		updateSectionFraming(sectionId, { frameMarker }, section =>
			section.frameMarker ? `Section marker set to ${section.frameMarker}` : "Section marker pending"
		);
	}

	function setSectionMarkerPosition(sectionId: string, markerPosition: string) {
		updateSectionFraming(sectionId, { markerPosition }, section =>
			`Section marker ${section.markerPosition === "end" ? "ends" : "starts"} messages`
		);
	}

	function setSectionFrameTimeGap(sectionId: string, frameTimeGap: string | number) {
		updateSectionFraming(sectionId, { frameTimeGap }, section => `Section idle gap set to ${section.frameTimeGap} ms`);
	}

	function moveSection(sectionId: string, action: SectionMoveAction) {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		normalizeSections(c);
		const section = c.frameSections.find(item => item.id === sectionId);
		const previousStart = section?.start;
		if (!moveSectionStart(c, sectionId, action)) return;
		rebuildPreview(c);
		let viewStateChanged = false;
		if (c.id && previousStart !== undefined && section?.start !== undefined) {
			// Keep the acknowledged locator until the server accepts the new
			// framing profile. The authoritative refresh will remove whichever
			// locator is no longer present, including a failed optimistic move.
			viewStateChanged = dependencies.copySectionViewState?.(String(c.id), previousStart, section.start) === true;
		}
		viewStateChanged = seedSectionViewPreferences(c) || viewStateChanged;
		if (!viewStateChanged) dependencies.renderMessages();
		if (!persistFraming(c, true)) dependencies.render({ skipMessageStream: true });
		const label =
			action === "byte-before"
				? "one byte before"
				: action === "byte-after"
					? "one byte after"
					: action === "message-before"
						? "one message before"
						: "one message after";
		dependencies.showToast(`Section moved ${label}`);
	}

	function deleteSection(sectionId: string) {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		normalizeSections(c);
		const index = c.frameSections.findIndex(section => section.id === sectionId);
		if (index <= 0) return;
		c.frameSections.splice(index, 1);
		rebuildPreview(c);
		if (!seedSectionViewPreferences(c)) dependencies.renderMessages();
		if (!persistFraming(c, true)) dependencies.render({ skipMessageStream: true });
	}

	function setSectionCollapse(sectionId: string, collapseRuns: boolean) {
		const c = capture();
		if (!c) return;
		normalizeSections(c);
		const section = c.frameSections.find(item => item.id === sectionId);
		if (!section) return;
		if (c.id !== undefined && dependencies.setSectionViewState) {
			dependencies.setSectionViewState(String(c.id), section.start, { collapseRuns });
		} else {
			dependencies.renderMessages();
		}
		dependencies.showToast(collapseRuns ? "Runs collapse in this section" : "Runs expand in this section");
	}

	function setSectionCollapsed(sectionId: string, collapsed: boolean) {
		const c = capture();
		if (!c) return;
		normalizeSections(c);
		const section = c.frameSections.find(item => item.id === sectionId);
		if (!section) return;
		if (c.id !== undefined && dependencies.setSectionViewState) {
			dependencies.setSectionViewState(String(c.id), section.start, { collapsed: Boolean(collapsed) });
		} else {
			dependencies.renderMessages();
		}
	}

	function commitContextDraft(input: ContextSaveInput) {
		const values = contextDraftToValues(input.draft);
		if (input.mode === "new") {
			const previousId = dependencies.getActiveId();
			const c = normalizeCapture({
				id: crypto.randomUUID(),
				...values,
				createdAt: new Date().toISOString(),
				messages: [],
				byteStream: [],
				notes: [],
				annotations: {}
			}) as ActiveCapture;
			c.storageStatus = "canonical";
			dependencies.setCaptureStorageStatus?.(String(c.id), "canonical");
			if (compatibilityState) compatibilityState.captures.unshift(c);
			dependencies.setActiveCapture?.(c);
			activateCaptureId(c.id);
			dependencies.setSelectedCaptureId?.(String(c.id));
			const request: CreateCaptureRequest = {
				captureId: String(c.id),
				framing: framingRequest(c),
				name: String(c.name ?? "Untitled capture"),
				description: String(c.description ?? ""),
				controllerView: String(c.view ?? ""),
				baudRate: Number(c.baudRate ?? 115200),
				inputFormat: isSnifferInputFormat(c.inputFormat) ? CAPTURE_INPUT_FORMATS.SNIFFER : CAPTURE_INPUT_FORMATS.BINARY,
				folderId: c.folderId ?? null,
				parameters: c.params.flatMap(parameter => {
					const key = String(parameter.key ?? "").trim();
					return key ? [{ key, value: String(parameter.value ?? "") }] : [];
					})
				};
				if (dependencies.archiveCommands) {
					const createWrite = dependencies.archiveCommands.createCapture(request);
					dependencies.trackCaptureWrite?.(String(c.id), createWrite);
					void createWrite
						.then(() => dependencies.refreshCapture?.(String(c.id)))
					.then(refreshed => {
						if (refreshed) {
							if (compatibilityState) {
								Object.assign(c, refreshed);
								bumpCaptureProjectionGeneration(c);
							}
							dependencies.setActiveCapture?.(refreshed);
						}
						persistArchiveIndex();
						dependencies.render();
					})
					.catch(error => {
						if (compatibilityState) compatibilityState.captures = compatibilityState.captures.filter(item => item !== c);
						activateCaptureId(previousId ?? null);
						dependencies.setSelectedCaptureId?.(previousId ? String(previousId) : null);
						reportFailure(String(c.id), error);
						dependencies.render();
					});
				} else if (dependencies.captureWriter) {
					const createWrite = dependencies.captureWriter.createCapture(request);
						dependencies.trackCaptureWrite?.(String(c.id), createWrite);
						void createWrite.catch(error => {
						if (compatibilityState) compatibilityState.captures = compatibilityState.captures.filter(item => item !== c);
						activateCaptureId(previousId ?? null);
						reportFailure(String(c.id), error);
					});
					}
		} else {
			const c = (input.captureId ? captureById(String(input.captureId)) : undefined) || capture();
			if (!c || rejectLockedMutation(c)) return false;
			Object.assign(c, values);
			metadataPatch(c);
		}
		if (input.mode === "new" && !dependencies.archiveCommands && !dependencies.captureWriter) persistLegacyCapture();
		dependencies.render();
		dependencies.showToast("Capture context saved");
		return true;
	}

	function publishAnnotationDialog(type: "message" | "byte", key: string) {
		const c = capture();
		if (!c || rejectFrameTargetMutation(c)) return;
		const details = annotationTargetLabel(c, type, key);
		if (!details) return;
		const [messageId, positionText] = key.split(":");
		const message = c.messages.find(item => item.id === messageId);
		if (!message) return;
		const position = positionText === undefined ? null : +positionText;
		const existing = c.annotations[details.targetKey];
		const direction = message.directions?.[position as number] === "tx" ? "TX" : "RX";
		const target =
			type === "byte"
				? `${formatTime(message.byteTimestamps?.[position as number] ?? message.timestamp)}  ·  ${signature(message)}  ·  BYTE ${(details.displayPosition as number) + 1} = ${hexByte(message.bytes[position as number])}  ·  DIRECTION ${direction}`
				: `${formatTime(message.timestamp)}  ·  ${signature(message)}`;
		dependencies.publishDialogCommand({
			type: "annotation",
			captureId: String(c.id),
			annotationType: type,
			key,
			title: details.title,
			target,
			text: String(existing?.text || ""),
			hasExisting: Boolean(existing)
		});
	}

	function commitAnnotationDraft(input: AnnotationSaveInput) {
		if (!annotationTextIsValid(input.text)) return false;
		const c = captureById(String(input.captureId));
		if (!c || rejectFrameTargetMutation(c)) return false;
		const details = annotationTargetLabel(c, input.annotationType, input.key);
		if (!details) return false;
		const [messageId] = input.key.split(":");
		const message = c.messages.find(item => item.id === messageId);
		if (!message) return false;
		const previous = c.annotations[details.targetKey];
		const optimistic: AnnotationValue = {
			text: normalizeAnnotationText(input.text),
			createdAt: Date.now(),
			noteId: previous?.noteId,
			type: input.annotationType,
			targetLabel:
				input.annotationType === "byte"
					? `${signature(message)} · byte ${(details.displayPosition as number) + 1}`
					: signature(message)
		};
		c.annotations[details.targetKey] = optimistic;
		if (isCanonical(c)) {
			const positionText = input.key.split(":")[1];
			const position = positionText === undefined ? null : Number(positionText);
			const rawOffsets = message.rawOffsets ?? message._rawPositions ?? [];
			const rawOffset = rawOffsets[position ?? -1];
			if (input.annotationType === "byte" && rawOffset === undefined) {
				if (previous) c.annotations[details.targetKey] = previous;
				else delete c.annotations[details.targetKey];
				return false;
			}
			const target: CanonicalNoteTarget = input.annotationType === "byte"
				? { kind: "byte", rawOffset: rawOffset! }
				: { kind: "frame", profileId: c.activeFramingProfileId, frameId: message.id, rawOffsets };
			const operation = previous?.noteId
				? (dependencies.archiveCommands
					? dependencies.archiveCommands.updateNote({ captureId: c.id, noteId: previous.noteId, text: String(optimistic.text), target })
					: dependencies.captureWriter!.updateNote({ captureId: c.id, noteId: previous.noteId, text: String(optimistic.text), target }))
				: (dependencies.archiveCommands
					? dependencies.archiveCommands.createNote({ captureId: c.id, text: String(optimistic.text), target })
					: dependencies.captureWriter!.createNote({ captureId: c.id, text: String(optimistic.text), target }));
			dependencies.trackCaptureWrite?.(c.id, operation);
			void operation.then(result => {
				optimistic.noteId = result.note.id;
				c.contentRevision = result.contentRevision;
			}).catch(error => reconcileFailure(c.id, error, () => {
				if (previous) c.annotations[details.targetKey] = previous;
				else delete c.annotations[details.targetKey];
				dependencies.render();
			}));
		} else persistLegacyCapture(c);
		dependencies.render();
		dependencies.showToast("Annotation saved");
		return true;
	}

	function removeAnnotationDraft(input: AnnotationDeleteInput) {
		const c = captureById(String(input.captureId));
		if (!c || rejectFrameTargetMutation(c)) return;
		const details = annotationTargetLabel(c, input.annotationType, input.key);
		if (!details) return;
		const previous = c.annotations[details.targetKey];
		delete c.annotations[details.targetKey];
		if (isCanonical(c) && previous?.noteId) {
			const operation = dependencies.archiveCommands
				? dependencies.archiveCommands.deleteNote({ captureId: c.id, noteId: previous.noteId })
				: dependencies.captureWriter!.deleteNote({ captureId: c.id, noteId: previous.noteId });
			dependencies.trackCaptureWrite?.(c.id, operation);
			void operation
				.catch(error => reconcileFailure(c.id, error, () => {
					c.annotations[details.targetKey] = previous;
					dependencies.render();
				}));
		} else persistLegacyCapture(c);
		dependencies.render();
		dependencies.showToast("Annotation removed");
	}

	function publishPatternRemarkDialog(id: string) {
		const c = capture();
		if (rejectFrameTargetMutation(c)) return;
		const patterns = recognizeMessagePatterns(c);
		const group = patterns.groups.find(item => item.id === id);
		if (!group || !c) return dependencies.showToast("This sequence is no longer present in the current framing");
		const text = String(c.patternRemarks?.[group.key]?.text || "");
		dependencies.publishDialogCommand({
			type: "pattern-remark",
			captureId: String(c.id),
			patternKey: group.key,
			title: `${group.length}-message sequence · ${group.starts.length} occurrences`,
			signatures: group.signatures,
			color: group.color,
			text,
			hasExisting: Boolean(text)
		});
	}

	function commitPatternRemarkDraft(input: PatternRemarkSaveInput) {
		const c = captureById(String(input.captureId));
		if (!c || rejectFrameTargetMutation(c)) return false;
		const text = normalizePatternRemarkText(input.text);
		c.patternRemarks ||= {};
		const previous = c.patternRemarks[input.patternKey];
		const previousValue = previous && typeof previous === "object" ? previous as PatternRemarkValue : undefined;
		const previousNoteId = previousValue?.noteId ? String(previousValue.noteId) : undefined;
		if (text) c.patternRemarks[input.patternKey] = {
			text,
			updatedAt: Date.now(),
			...(previousNoteId ? { noteId: previousNoteId } : {})
		};
		else delete c.patternRemarks[input.patternKey];
		bumpCaptureProjectionGeneration(c);
		if (isCanonical(c)) {
			queuePatternRemarkWrite(c.id, input.patternKey, text, previousNoteId);
		} else persistLegacyCapture(c);
		dependencies.renderMessages();
		dependencies.showToast(text ? "Sequence note saved" : "Sequence note removed");
		return true;
	}

	return {
		upgradeActiveCapture: () => {
			const c = capture();
			if (c?.id) dependencies.openCanonicalization?.(String(c.id));
		},
		upgradeCapture,
		selectArchiveCapture,
		toggleArchiveFolder,
		setAllArchiveFoldersCollapsed,
		moveArchiveCapture,
		deleteArchiveCapture,
		requestDeleteArchiveCapture,
		saveFolder,
		requestDeleteFolder,
		deleteFolder,
		addSequenceNote,
		setCaptureTitle,
		commitCaptureTitle,
		setCaptureDescription,
		commitCaptureDescription,
		duplicateArchiveCapture,
		duplicateActiveCapture,
		clearActiveCaptureMessages,
		requestClearActiveCaptureMessages,
		deleteActiveCapture,
		requestDeleteActiveCapture,
		publishContextDialog,
		seedSectionViewPreferences: () => seedSectionViewPreferences(capture()),
		startSectionAtByte,
		moveSection,
		deleteSection,
		setSectionFraming,
		setSectionFrameSize,
		setSectionFramingMode,
		setSectionFrameMarker,
		setSectionMarkerPosition,
		setSectionFrameTimeGap,
		setSectionCollapse,
		setSectionCollapsed,
		isFramingPending: (captureId: string) => framingCoordinator.isPending(captureId),
		refreshCapture: refreshAuthoritativeCapture,
		waitForCaptureWrites,
		commitContextDraft,
		publishAnnotationDialog,
		commitAnnotationDraft,
		removeAnnotationDraft,
		publishPatternRemarkDialog,
		commitPatternRemarkDraft
	};
}

export type CaptureController = ReturnType<typeof createCaptureController>;

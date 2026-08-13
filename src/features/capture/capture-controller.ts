import { recognizeMessagePatterns } from "../analysis/analysis.ts";
import type { AppState } from "../../shared/app-state.ts";
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
import type { RawByteRecord } from "./capture-summary.ts";
import {
	applySectionFramingSettings,
	hexByte,
	normalizeCapture,
	normalizeSections,
	rebuildPreview,
	signature,
	type CaptureMessage,
	type Capture,
	type NormalizedCaptureSection,
	type SectionFramingUpdate
} from "./capture-framing.ts";
import { moveSection as moveSectionStart, type SectionMoveAction } from "./section-repositioning.ts";
import { publishDialogCommand } from "../dialogs/dialog-bridge.ts";
import type {
	CaptureWriter,
	CanonicalNoteTarget,
	CaptureMetadataPatch,
	FramingSectionRequest
} from "../../persistence/archive-client.ts";

export type CaptureControllerDependencies = {
	state: AppState;
	capture: () => Capture | undefined;
	getActiveId: () => string | null | undefined;
	setActiveId: (captureId: string | null | undefined) => void;
	saveState: (options?: { immediate?: boolean }) => void;
	render: () => void;
	renderMessages: () => void;
	showToast: (message: string) => void;
	confirm: (message: string) => boolean;
	transport: Pick<SerialController, "isRecording" | "stopRecording">;
	publishArchiveState: () => void;
	publishCaptureHeaderState: () => void;
	publishNotesState: (capture?: Capture) => void;
	publishDialogCommand: typeof publishDialogCommand;
	captureWriter?: CaptureWriter;
	isCanonicalCapture?: (captureId: string) => boolean;
	waitForCaptureWrite?: (captureId: string) => Promise<void>;
	isCaptureConversionLocked?: (captureId: string) => boolean;
	setCaptureStorageStatus?: (captureId: string, status: "legacy-not-canonicalized" | "converting" | "canonical" | "canonicalization-failed") => void;
	openCanonicalization?: (captureId: string) => void;
	refreshCapture?: (captureId: string) => Promise<Capture>;
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

type ActiveAppState = Pick<AppState, "folders" | "unfiledCollapsed"> & { captures: ActiveCapture[] };

type CaptureWriteQueue = {
	metadataPending: CaptureMetadataPatch | null;
	framingPending: FramingSectionRequest[] | null;
	metadataRetries: number;
	framingRetries: number;
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
	const state = dependencies.state as ActiveAppState;
	const captureWriteQueues = new Map<string, CaptureWriteQueue>();
	const patternRemarkWriteQueues = new Map<string, Map<string, PatternRemarkWriteQueue>>();

	function capture(): ActiveCapture | undefined {
		return dependencies.capture() as ActiveCapture | undefined;
	}

	function isCanonical(item: Capture | undefined): item is Capture & { id: string } {
		return Boolean(item?.id && dependencies.captureWriter && dependencies.isCanonicalCapture?.(String(item.id)));
	}

	function isConversionLocked(item: Capture | undefined): boolean {
		return Boolean(item?.id && dependencies.isCaptureConversionLocked?.(String(item.id)));
	}

	function rejectLockedMutation(item: Capture | undefined): boolean {
		if (!isConversionLocked(item)) return false;
		dependencies.showToast("Capture conversion is in progress; editing is temporarily disabled");
		return true;
	}

	function reportFailure(captureId: string, error: unknown): void {
		dependencies.reportPersistenceFailure?.(captureId, error);
	}

	function reconcileFailure(captureId: string, error: unknown, fallback?: () => void): void {
		reportFailure(captureId, error);
		if (dependencies.refreshCapture) {
			void dependencies.refreshCapture(captureId).then(() => dependencies.render()).catch(() => fallback?.());
		} else fallback?.();
	}

	function captureById(captureId: string): ActiveCapture | undefined {
		return state.captures.find(item => String(item.id) === captureId);
	}

	function metadataPatchValue(item: ActiveCapture): CaptureMetadataPatch {
		return {
			name: String(item.name ?? ""),
			description: String(item.description ?? ""),
			controllerView: String(item.view ?? ""),
			baudRate: Number(item.baudRate ?? 115200),
			inputFormat: "binary",
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
		if (queue.framingPending) applyFramingSnapshot(item, queue.framingPending);
	}

	async function writeMetadata(captureId: string, patch: CaptureMetadataPatch): Promise<void> {
		if (dependencies.waitForCaptureWrite) await dependencies.waitForCaptureWrite(captureId);
		const item = captureById(captureId);
		if (!item || !isCanonical(item)) return;
		const result = await dependencies.captureWriter!.patchMetadata({
			captureId: item.id,
			expectedMetadataRevision: item.metadataRevision,
			patch
		});
		const current = captureById(captureId);
		if (current) {
			current.metadataRevision = result.metadataRevision;
			current.updatedAt = result.updatedAt;
		}
	}

	async function writeFraming(captureId: string, sections: readonly FramingSectionRequest[]): Promise<void> {
		if (dependencies.waitForCaptureWrite) await dependencies.waitForCaptureWrite(captureId);
		const item = captureById(captureId);
		if (!item || !isCanonical(item)) return;
		if (dependencies.transport.isRecording()) {
			const draft = await dependencies.captureWriter!.updateFramingDraft({
				captureId: item.id,
				sections,
				expectedRevision: item.framingDraftRevision
			});
			const current = captureById(captureId);
			if (current) {
				current.framingDraftRevision = draft.revision;
			}
		} else {
			const profile = await dependencies.captureWriter!.reframe({
				captureId: item.id,
				sections,
				expectedActiveProfileId: item.activeFramingProfileId,
				expectedDataRevision: Number(item.dataRevision ?? 0)
			});
			const current = captureById(captureId);
			if (current) {
				current.activeFramingProfileId = profile.profileId;
			}
		}
	}

	async function recoverCaptureWrite(
		captureId: string,
		queue: CaptureWriteQueue,
		kind: "metadata" | "framing",
		desired: CaptureMetadataPatch | FramingSectionRequest[],
		error: unknown
	): Promise<void> {
		const retries = kind === "metadata" ? queue.metadataRetries : queue.framingRetries;
		const latest = kind === "metadata"
			? (queue.metadataPending ?? desired) as CaptureMetadataPatch
			: (queue.framingPending ?? desired) as FramingSectionRequest[];
		if (retries >= 1 || !dependencies.refreshCapture) {
			if (kind === "metadata") {
				queue.metadataPending = null;
				queue.metadataRetries = 0;
			} else {
				queue.framingPending = null;
				queue.framingRetries = 0;
			}
			reapplyPendingSnapshots(captureId, queue);
			reportFailure(captureId, error);
			dependencies.render();
			return;
		}
		if (kind === "metadata") {
			queue.metadataRetries += 1;
			queue.metadataPending = latest as CaptureMetadataPatch;
		} else {
			queue.framingRetries += 1;
			queue.framingPending = latest as FramingSectionRequest[];
		}
		try {
			await dependencies.refreshCapture(captureId);
			reapplyPendingSnapshots(captureId, queue);
			dependencies.render();
		} catch (refreshError) {
			if (kind === "metadata") {
				queue.metadataPending = null;
				queue.metadataRetries = 0;
			} else {
				queue.framingPending = null;
				queue.framingRetries = 0;
			}
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
		if (dependencies.waitForCaptureWrite) await dependencies.waitForCaptureWrite(captureId);
		const item = captureById(captureId);
		if (!item || !isCanonical(item)) return;
		const target: CanonicalNoteTarget = { kind: "pattern", sequenceKey: patternKey };
		if (text) {
			const result = queue.noteId
				? await dependencies.captureWriter!.updateNote({ captureId: item.id, noteId: queue.noteId, text, target })
				: await dependencies.captureWriter!.createNote({ captureId: item.id, text, target });
			queue.noteId = result.note.id;
			const current = captureById(captureId);
			if (current) {
				const optimistic = current.patternRemarks[patternKey];
				if (optimistic && typeof optimistic === "object") optimistic.noteId = result.note.id;
				current.contentRevision = result.contentRevision;
			}
		} else if (queue.noteId) {
			await dependencies.captureWriter!.deleteNote({ captureId: item.id, noteId: queue.noteId });
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
			await dependencies.refreshCapture(captureId);
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
			while (queue.metadataPending || queue.framingPending) {
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
				if (queue.framingPending) {
					const sections = queue.framingPending;
					queue.framingPending = null;
					try {
						await writeFraming(captureId, sections);
						if (!queue.framingPending) {
							const current = captureById(captureId);
							if (current) applyFramingSnapshot(current, sections);
						}
						queue.framingRetries = 0;
					} catch (error) {
						await recoverCaptureWrite(captureId, queue, "framing", sections, error);
					}
				}
			}
		})().finally(() => {
			queue.running = null;
			if (!queue.metadataPending && !queue.framingPending) captureWriteQueues.delete(captureId);
		});
		return queue.running;
	}

	function queueCaptureWrite(
		captureId: string,
		kind: "metadata" | "framing",
		value: CaptureMetadataPatch | FramingSectionRequest[]
	): void {
		const queue = captureWriteQueues.get(captureId) || {
			metadataPending: null,
			framingPending: null,
			metadataRetries: 0,
			framingRetries: 0,
			running: null
		};
		captureWriteQueues.set(captureId, queue);
		if (kind === "metadata") queue.metadataPending = value as CaptureMetadataPatch;
		else queue.framingPending = value as FramingSectionRequest[];
		void drainCaptureWrites(captureId, queue);
	}

	async function waitForCaptureWrites(captureId: string): Promise<void> {
		while (true) {
			const captureQueue = captureWriteQueues.get(captureId);
			const patternQueues = patternRemarkWriteQueues.get(captureId);
			const running = [
				...(captureQueue?.running ? [captureQueue.running] : []),
				...(patternQueues ? [...patternQueues.values()].flatMap(queue => queue.running ? [queue.running] : []) : [])
			];
			if (!running.length) return;
			await Promise.all(running);
		}
	}

	function metadataPatch(item: ActiveCapture): void {
		if (rejectLockedMutation(item)) return;
		if (!isCanonical(item)) {
			dependencies.saveState();
			return;
		}
		queueCaptureWrite(item.id, "metadata", metadataPatchValue(item));
	}

	function framingRequest(item: ActiveCapture): FramingSectionRequest[] {
		normalizeSections(item);
		return item.frameSections.map(section => ({
			id: section.id,
			start: section.start,
			framingMode: section.framingMode,
			frameSize: section.frameSize,
			frameMarker: section.frameMarker,
			markerPosition: section.markerPosition,
			frameTimeGap: section.frameTimeGap,
			collapseRuns: section.collapseRuns,
			collapsed: section.collapsed
		}));
	}

	function persistFraming(item: ActiveCapture, immediate = false): void {
		if (rejectLockedMutation(item)) return;
		if (!isCanonical(item)) {
			dependencies.saveState(immediate ? { immediate: true } : undefined);
			return;
		}
		queueCaptureWrite(item.id, "framing", framingRequest(item));
	}

	function selectArchiveCapture(captureId: string) {
		dependencies.setActiveId(captureId);
		dependencies.saveState();
		dependencies.render();
	}

	function toggleArchiveFolder(folderId: string | null) {
		if (folderId) {
			const folder = state.folders.find(item => item.id === folderId);
			if (folder) folder.collapsed = !folder.collapsed;
		} else state.unfiledCollapsed = !state.unfiledCollapsed;
		dependencies.saveState();
		dependencies.publishArchiveState();
	}

	function moveArchiveCapture(captureId: string, folderId: string | null) {
		const item = state.captures.find(capture => capture.id === captureId);
		if (!item) return;
		if (rejectLockedMutation(item)) return;
		const folderNameById = new Map(state.folders.map(folder => [folder.id, folder.name]));
		item.folderId = folderId || null;
		metadataPatch(item);
		dependencies.publishArchiveState();
		dependencies.showToast(item.folderId ? `Moved to ${folderNameById.get(item.folderId)}` : "Moved to Unfiled");
	}

	function upgradeCapture(captureId: string): void {
		const item = state.captures.find(captureItem => String(captureItem.id) === String(captureId));
		if (item?.id) dependencies.openCanonicalization?.(String(item.id));
	}

	function saveFolder(name: string, editingId: string | null) {
		const trimmedName = String(name).trim();
		const duplicate = state.folders.some(
			folder => folder.id !== editingId && folder.name.toLowerCase() === trimmedName.toLowerCase()
		);
		if (!trimmedName || duplicate) return false;
		const folder = state.folders.find(item => item.id === editingId);
		if (folder) {
			folder.name = trimmedName;
			dependencies.showToast("Folder renamed");
		} else {
			state.folders.push({
				id: crypto.randomUUID(),
				name: trimmedName,
				collapsed: false,
				createdAt: new Date().toISOString()
			});
			dependencies.showToast("Folder created");
		}
		dependencies.saveState();
		dependencies.publishArchiveState();
		return true;
	}

	function deleteFolder(folderId: string) {
		const folder = state.folders.find(item => item.id === folderId);
		if (!folder) return;
		const captureCount = state.captures.filter(item => item.folderId === folderId).length;
		const detail = captureCount
			? ` Its ${captureCount} capture${captureCount === 1 ? "" : "s"} will be moved to Unfiled.`
			: "";
		if (!dependencies.confirm(`Delete folder “${folder.name}”?${detail}`)) return;
		state.captures.forEach(item => {
			if (item.folderId === folderId) {
				item.folderId = null;
				if (isCanonical(item)) metadataPatch(item);
			}
		});
		state.folders = state.folders.filter(item => item.id !== folderId);
		dependencies.saveState();
		dependencies.publishArchiveState();
		dependencies.showToast(captureCount ? "Folder deleted; captures moved to Unfiled" : "Folder deleted");
	}

	function addSequenceNote({ start: rawStart, end: rawEnd, text: rawText }: SequenceNoteInput): boolean {
		const c = capture();
		const noteText = String(rawText || "").trim();
		if (!c || !noteText) return false;
		if (rejectLockedMutation(c)) return false;
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
			void dependencies.captureWriter!.createNote({
				captureId: c.id,
				text: noteText,
				target: {
					kind: "range",
					profileId: c.activeFramingProfileId,
					startOrdinal: start - 1,
					endOrdinal: end - 1
				}
			}).then(result => {
				optimistic.id = result.note.id;
				c.contentRevision = result.contentRevision;
			}).catch(error => reconcileFailure(c.id, error, () => {
				c.notes = notes.filter(note => note !== optimistic);
				dependencies.publishNotesState(c);
			}));
		} else dependencies.saveState();
		dependencies.publishNotesState(c);
		dependencies.renderMessages();
		dependencies.showToast("Sequence observation added");
		return true;
	}

	function setCaptureTitle(value: string) {
		const c = capture();
		if (!c || isConversionLocked(c)) return;
		c.name = value;
		dependencies.publishCaptureHeaderState();
	}

	function commitCaptureTitle(value: string) {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		c.name = value;
		metadataPatch(c);
		dependencies.publishArchiveState();
		dependencies.publishCaptureHeaderState();
	}

	function setCaptureDescription(value: string) {
		const c = capture();
		if (!c || isConversionLocked(c)) return;
		c.description = value;
		dependencies.publishCaptureHeaderState();
	}

	function commitCaptureDescription(value: string) {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		c.description = value;
		metadataPatch(c);
		dependencies.publishCaptureHeaderState();
	}

	function duplicateActiveCapture() {
		const source = capture();
		if (!source || rejectLockedMutation(source)) return;
		const copy = structuredClone(source);
		copy.id = crypto.randomUUID();
		copy.name += " · copy";
		copy.createdAt = new Date().toISOString();
		copy.messages.forEach(message => (message.id = crypto.randomUUID()));
		copy.annotations = {};
		state.captures.unshift(copy);
		dependencies.setActiveId(copy.id);
		if (isCanonical(source)) {
			void dependencies.captureWriter!.duplicate({ captureId: source.id, duplicateCaptureId: String(copy.id) })
				.then(() => dependencies.refreshCapture?.(String(copy.id)))
				.then(refreshed => {
					if (refreshed) Object.assign(copy, refreshed);
					dependencies.render();
				})
				.catch(error => {
					state.captures = state.captures.filter(item => item !== copy);
					dependencies.setActiveId(source.id);
					reportFailure(source.id, error);
					dependencies.render();
				});
		} else dependencies.saveState();
		dependencies.render();
	}

	async function deleteArchiveCapture(captureId: string): Promise<void> {
		let item = state.captures.find(captureItem => captureItem.id === captureId);
		if (!item || rejectLockedMutation(item) || !dependencies.confirm(`Delete “${item.name}”?`)) return;
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
		await waitForCaptureWrites(captureId);
		item = state.captures.find(captureItem => captureItem.id === captureId);
		if (!item) return;
		state.captures = state.captures.filter(captureItem => captureItem.id !== captureId);
		if (deletingActiveCapture) dependencies.setActiveId(state.captures[0]?.id || null);
		if (isCanonical(item)) {
			try {
				await dependencies.captureWriter!.delete(item.id);
			} catch (error) {
				state.captures.unshift(item);
				if (deletingActiveCapture) dependencies.setActiveId(item.id);
				reportFailure(item.id, error);
				dependencies.render();
				return;
			}
		} else dependencies.saveState();
		dependencies.render();
	}

	function clearActiveCaptureMessages() {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		if (dependencies.confirm("Clear all raw bytes, messages, and message annotations from this capture?")) {
			c.byteStream = [];
			c.messages = [];
			c.annotations = {};
			c.patternRemarks = {};
			if (isCanonical(c)) {
				void dependencies.captureWriter!.clearData({ captureId: c.id }).then(result => {
					c.dataRevision = result.dataRevision;
					c.contentRevision = result.contentRevision;
				}).catch(error => reconcileFailure(c.id, error));
			} else dependencies.saveState();
			dependencies.render();
		}
	}

	async function deleteActiveCapture(): Promise<void> {
		const activeId = dependencies.getActiveId();
		if (activeId) await deleteArchiveCapture(activeId);
	}

	function publishContextDialog(isNew = false) {
		const creatingNewCapture = isNew === true;
		const c = creatingNewCapture
			? { name: "Untitled capture", view: "", params: [], baudRate: 115200, folderId: null, id: null }
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
			params: (Array.isArray(c.params) ? c.params : []).map(parameter => {
				const item = parameter as { key?: unknown; value?: unknown };
				return {
					key: String(item.key ?? ""),
					value: String(item.value ?? "")
				};
			}),
			folders: state.folders.map(folder => ({ id: String(folder.id), name: String(folder.name || "") }))
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
		c.frameSections.push({
			id: crypto.randomUUID(),
			start,
			framingMode: "length",
			frameSize: inherited?.frameSize || 3,
			frameMarker: inherited?.frameMarker || "",
			markerPosition: inherited?.markerPosition || "start",
			frameTimeGap: inherited?.frameTimeGap || 5,
			collapseRuns: Boolean(inherited?.collapseRuns),
			collapsed: false
		});
		normalizeSections(c);
		rebuildPreview(c);
		persistFraming(c);
		dependencies.render();
	}

	function updateSectionFraming(sectionId: string, update: SectionFramingUpdate, toast: (section: ActiveCaptureSection) => string) {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		normalizeSections(c);
		const section = c.frameSections.find(item => item.id === sectionId);
		if (!section) return;
		applySectionFramingSettings(section, update);
		rebuildPreview(c);
		persistFraming(c);
		dependencies.render();
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
		if (!moveSectionStart(c, sectionId, action)) return;
		rebuildPreview(c);
		persistFraming(c, true);
		dependencies.render();
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
		persistFraming(c, true);
		dependencies.render();
	}

	function setSectionCollapse(sectionId: string, collapseRuns: boolean) {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		const section = c.frameSections.find(item => item.id === sectionId);
		if (!section) return;
		section.collapseRuns = collapseRuns;
		persistFraming(c);
		dependencies.renderMessages();
		dependencies.showToast(collapseRuns ? "Runs collapse in this section" : "Runs expand in this section");
	}

	function setSectionCollapsed(sectionId: string, collapsed: boolean) {
		const c = capture();
		if (!c || rejectLockedMutation(c)) return;
		const section = c.frameSections.find(item => item.id === sectionId);
		if (!section) return;
		section.collapsed = Boolean(collapsed);
		persistFraming(c);
		dependencies.renderMessages();
	}

	function commitContextDraft(input: ContextSaveInput) {
		const values = contextDraftToValues(input.draft);
		if (input.mode === "new") {
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
			state.captures.unshift(c);
			dependencies.setActiveId(c.id);
			// The runtime owns create bookkeeping and the archive-index write.
			dependencies.saveState({ immediate: true });
		} else {
			const c = state.captures.find(item => String(item.id) === String(input.captureId)) || capture();
			if (!c || rejectLockedMutation(c)) return false;
			Object.assign(c, values);
			metadataPatch(c);
		}
		if (input.mode === "new" && !dependencies.captureWriter) dependencies.saveState();
		dependencies.render();
		dependencies.showToast("Capture context saved");
		return true;
	}

	function publishAnnotationDialog(type: "message" | "byte", key: string) {
		const c = capture();
		if (!c) return;
		const details = annotationTargetLabel(c, type, key);
		if (!details) return;
		const [messageId, positionText] = key.split(":");
		const message = c.messages.find(item => item.id === messageId);
		if (!message) return;
		const position = positionText === undefined ? null : +positionText;
		const existing = c.annotations[details.targetKey];
		const target =
			type === "byte"
				? `${formatTime(message.byteTimestamps?.[position as number] ?? message.timestamp)}  ·  ${signature(message)}  ·  BYTE ${(details.displayPosition as number) + 1} = ${hexByte(message.bytes[position as number])}`
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
		const c = state.captures.find(item => String(item.id) === String(input.captureId));
		if (!c || rejectLockedMutation(c)) return false;
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
				? dependencies.captureWriter!.updateNote({ captureId: c.id, noteId: previous.noteId, text: String(optimistic.text), target })
				: dependencies.captureWriter!.createNote({ captureId: c.id, text: String(optimistic.text), target });
			void operation.then(result => {
				optimistic.noteId = result.note.id;
				c.contentRevision = result.contentRevision;
			}).catch(error => reconcileFailure(c.id, error, () => {
				if (previous) c.annotations[details.targetKey] = previous;
				else delete c.annotations[details.targetKey];
				dependencies.render();
			}));
		} else dependencies.saveState();
		dependencies.render();
		dependencies.showToast("Annotation saved");
		return true;
	}

	function removeAnnotationDraft(input: AnnotationDeleteInput) {
		const c = state.captures.find(item => String(item.id) === String(input.captureId));
		if (!c || rejectLockedMutation(c)) return;
		const details = annotationTargetLabel(c, input.annotationType, input.key);
		if (!details) return;
		const previous = c.annotations[details.targetKey];
		delete c.annotations[details.targetKey];
		if (isCanonical(c) && previous?.noteId) {
			void dependencies.captureWriter!.deleteNote({ captureId: c.id, noteId: previous.noteId })
				.catch(error => reconcileFailure(c.id, error, () => {
					c.annotations[details.targetKey] = previous;
					dependencies.render();
				}));
		} else dependencies.saveState();
		dependencies.render();
		dependencies.showToast("Annotation removed");
	}

	function publishPatternRemarkDialog(id: string) {
		const c = capture();
		if (rejectLockedMutation(c)) return;
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
		const c = state.captures.find(item => String(item.id) === String(input.captureId));
		if (!c || rejectLockedMutation(c)) return false;
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
		if (isCanonical(c)) {
			queuePatternRemarkWrite(c.id, input.patternKey, text, previousNoteId);
		} else dependencies.saveState();
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
		moveArchiveCapture,
		deleteArchiveCapture,
		saveFolder,
		deleteFolder,
		addSequenceNote,
		setCaptureTitle,
		commitCaptureTitle,
		setCaptureDescription,
		commitCaptureDescription,
		duplicateActiveCapture,
		clearActiveCaptureMessages,
		deleteActiveCapture,
		publishContextDialog,
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
		commitContextDraft,
		publishAnnotationDialog,
		commitAnnotationDraft,
		removeAnnotationDraft,
		publishPatternRemarkDialog,
		commitPatternRemarkDraft
	};
}

export type CaptureController = ReturnType<typeof createCaptureController>;

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
};

type AnnotationValue = { text?: unknown; [key: string]: unknown };
type PatternRemarkValue = { text?: unknown; [key: string]: unknown };
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

	function capture(): ActiveCapture | undefined {
		return dependencies.capture() as ActiveCapture | undefined;
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
		const folderNameById = new Map(state.folders.map(folder => [folder.id, folder.name]));
		item.folderId = folderId || null;
		dependencies.saveState();
		dependencies.publishArchiveState();
		dependencies.showToast(item.folderId ? `Moved to ${folderNameById.get(item.folderId)}` : "Moved to Unfiled");
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
			if (item.folderId === folderId) item.folderId = null;
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
		const max = Math.max(1, c.messages.length);
		const start = Math.max(1, Math.min(max, Number(rawStart) || 1));
		const end = Math.max(start, Math.min(max, Number(rawEnd) || start));
		c.notes ||= [];
		c.notes.push({
			id: crypto.randomUUID(),
			type: "sequence",
			text: noteText,
			createdAt: Date.now(),
			start,
			end,
			targetLabel: `rows ${start}–${end}`
		});
		dependencies.saveState();
		dependencies.publishNotesState(c);
		dependencies.renderMessages();
		dependencies.showToast("Sequence observation added");
		return true;
	}

	function setCaptureTitle(value: string) {
		const c = capture();
		if (!c) return;
		c.name = value;
		dependencies.saveState();
		dependencies.publishCaptureHeaderState();
	}

	function commitCaptureTitle(value: string) {
		const c = capture();
		if (!c) return;
		c.name = value;
		dependencies.saveState();
		dependencies.publishArchiveState();
		dependencies.publishCaptureHeaderState();
	}

	function setCaptureDescription(value: string) {
		const c = capture();
		if (!c) return;
		c.description = value;
		dependencies.saveState();
		dependencies.publishCaptureHeaderState();
	}

	function commitCaptureDescription(value: string) {
		const c = capture();
		if (!c) return;
		c.description = value;
		dependencies.saveState();
		dependencies.publishCaptureHeaderState();
	}

	function duplicateActiveCapture() {
		const source = capture();
		if (!source) return;
		const copy = structuredClone(source);
		copy.id = crypto.randomUUID();
		copy.name += " · copy";
		copy.createdAt = new Date().toISOString();
		copy.messages.forEach(message => (message.id = crypto.randomUUID()));
		copy.annotations = {};
		state.captures.unshift(copy);
		dependencies.setActiveId(copy.id);
		dependencies.saveState();
		dependencies.render();
	}

	function clearActiveCaptureMessages() {
		const c = capture();
		if (!c) return;
		if (dependencies.confirm("Clear all raw bytes, messages, and message annotations from this capture?")) {
			c.byteStream = [];
			c.messages = [];
			c.annotations = {};
			c.patternRemarks = {};
			dependencies.saveState();
			dependencies.render();
		}
	}

	function deleteActiveCapture() {
		const c = capture();
		if (!c || !dependencies.confirm(`Delete “${c.name}”?`)) return;
		if (dependencies.transport.isRecording()) dependencies.transport.stopRecording();
		state.captures = state.captures.filter(item => item.id !== dependencies.getActiveId());
		dependencies.setActiveId(state.captures[0]?.id || null);
		dependencies.saveState();
		dependencies.render();
	}

	function publishContextDialog(isNew = false) {
		const c = isNew
			? { name: "Untitled capture", view: "", params: [], baudRate: 115200, folderId: null, id: null }
			: capture();
		if (!c) return;
		dependencies.publishDialogCommand({
			type: "context",
			mode: isNew ? "new" : "edit",
			captureId: isNew ? null : String(c.id),
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
		if (!c) return;
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
		dependencies.saveState();
		dependencies.render();
		dependencies.showToast(`Section begins at raw byte ${start + 1}`);
	}

	function updateSectionFraming(sectionId: string, update: SectionFramingUpdate, toast: (section: ActiveCaptureSection) => string) {
		const c = capture();
		if (!c) return;
		normalizeSections(c);
		const section = c.frameSections.find(item => item.id === sectionId);
		if (!section) return;
		applySectionFramingSettings(section, update);
		rebuildPreview(c);
		dependencies.saveState();
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
		if (!c) return;
		normalizeSections(c);
		if (!moveSectionStart(c, sectionId, action)) return;
		rebuildPreview(c);
		dependencies.saveState({ immediate: true });
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
		if (!c) return;
		normalizeSections(c);
		const index = c.frameSections.findIndex(section => section.id === sectionId);
		if (index <= 0) return;
		c.frameSections.splice(index, 1);
		rebuildPreview(c);
		dependencies.saveState({ immediate: true });
		dependencies.render();
		dependencies.showToast("Section deleted; its bytes were merged into the preceding section");
	}

	function setSectionCollapse(sectionId: string, collapseRuns: boolean) {
		const c = capture();
		const section = c?.frameSections.find(item => item.id === sectionId);
		if (!section) return;
		section.collapseRuns = collapseRuns;
		dependencies.saveState();
		dependencies.renderMessages();
		dependencies.showToast(collapseRuns ? "Runs collapse in this section" : "Runs expand in this section");
	}

	function setSectionCollapsed(sectionId: string, collapsed: boolean) {
		const c = capture();
		const section = c?.frameSections.find(item => item.id === sectionId);
		if (!section) return;
		section.collapsed = Boolean(collapsed);
		dependencies.saveState();
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
			state.captures.unshift(c);
			dependencies.setActiveId(c.id);
		} else {
			const c = state.captures.find(item => String(item.id) === String(input.captureId)) || capture();
			if (!c) return false;
			Object.assign(c, values);
		}
		dependencies.saveState();
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
		if (!c) return false;
		const details = annotationTargetLabel(c, input.annotationType, input.key);
		if (!details) return false;
		const [messageId] = input.key.split(":");
		const message = c.messages.find(item => item.id === messageId);
		if (!message) return false;
		c.annotations[details.targetKey] = {
			text: normalizeAnnotationText(input.text),
			createdAt: Date.now(),
			type: input.annotationType,
			targetLabel:
				input.annotationType === "byte"
					? `${signature(message)} · byte ${(details.displayPosition as number) + 1}`
					: signature(message)
		};
		dependencies.saveState();
		dependencies.render();
		dependencies.showToast("Annotation saved");
		return true;
	}

	function removeAnnotationDraft(input: AnnotationDeleteInput) {
		const c = state.captures.find(item => String(item.id) === String(input.captureId));
		if (!c) return;
		const details = annotationTargetLabel(c, input.annotationType, input.key);
		if (!details) return;
		delete c.annotations[details.targetKey];
		dependencies.saveState();
		dependencies.render();
		dependencies.showToast("Annotation removed");
	}

	function publishPatternRemarkDialog(id: string) {
		const c = capture();
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
		if (!c) return false;
		const text = normalizePatternRemarkText(input.text);
		c.patternRemarks ||= {};
		if (text) c.patternRemarks[input.patternKey] = { text, updatedAt: Date.now() };
		else delete c.patternRemarks[input.patternKey];
		dependencies.saveState();
		dependencies.renderMessages();
		dependencies.showToast(text ? "Sequence note saved" : "Sequence note removed");
		return true;
	}

	return {
		selectArchiveCapture,
		toggleArchiveFolder,
		moveArchiveCapture,
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

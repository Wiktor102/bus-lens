import {
	signature,
	visiblePositionForRawByte,
	type Capture,
	type CaptureSection
} from "./capture-framing.ts";

export type DialogFolderOption = {
	id: string;
	name: string;
};

export type ContextParameter = {
	key: string;
	value: string;
};

export type ContextParameterDraft = ContextParameter & {
	id: string;
};

export type ContextDialogCommand = {
	type: "context";
	requestId: number;
	mode: "new" | "edit";
	captureId: string | null;
	name: string;
	view: string;
	folderId: string | null;
	baudRate: number;
	params: ContextParameter[];
	folders: DialogFolderOption[];
};

export type ContextDialogDraft = {
	name: string;
	view: string;
	folderId: string;
	baudRate: string;
	parameters: ContextParameterDraft[];
};

export type ContextSaveInput = {
	mode: "new" | "edit";
	captureId: string | null;
	draft: ContextDialogDraft;
};

export type ContextValues = {
	name: string;
	view: string;
	folderId: string | null;
	params: ContextParameter[];
	baudRate: number;
	inputFormat: "raw";
};

export type SectionDialogRow = {
	id: string;
	start: number;
	frameSize: number;
	collapseRuns: boolean;
};

export type SectionDialogDraft = {
	id: string;
	start: string;
	frameSize: string;
	collapseRuns: boolean;
};

export type SectionsDialogCommand = {
	type: "sections";
	requestId: number;
	captureId: string;
	streamLength: number;
	frameSize: number;
	sections: SectionDialogRow[];
};

export type SectionsSaveInput = {
	captureId: string;
	rows: SectionDialogDraft[];
};

export type SerializedSections = {
	id: string;
	start: number;
	frameSize: number;
	collapseRuns: boolean;
};

export type SectionDraftResult =
	| { ok: true; sections: SerializedSections[] }
	| { ok: false; error: "Each section must start at a different raw byte" };

export type AnnotationType = "message" | "byte";

export type AnnotationDialogCommand = {
	type: "annotation";
	requestId: number;
	captureId: string;
	annotationType: AnnotationType;
	key: string;
	title: string;
	target: string;
	text: string;
	hasExisting: boolean;
};

export type AnnotationSaveInput = {
	captureId: string;
	annotationType: AnnotationType;
	key: string;
	text: string;
};

export type AnnotationDeleteInput = {
	captureId: string;
	annotationType: AnnotationType;
	key: string;
};

export type PatternRemarkDialogCommand = {
	type: "pattern-remark";
	requestId: number;
	captureId: string;
	patternKey: string;
	title: string;
	signatures: string[];
	color: string;
	text: string;
	hasExisting: boolean;
};

export type PatternRemarkSaveInput = {
	captureId: string;
	patternKey: string;
	text: string;
};

export type ExportFormat = "json" | "csv" | "txt";

export type ExportDialogCommand = {
	type: "export";
	requestId: number;
};

export type DialogCommand =
	| ContextDialogCommand
	| SectionsDialogCommand
	| AnnotationDialogCommand
	| PatternRemarkDialogCommand
	| ExportDialogCommand;

export type DialogCommandInput =
	| Omit<ContextDialogCommand, "requestId">
	| Omit<SectionsDialogCommand, "requestId">
	| Omit<AnnotationDialogCommand, "requestId">
	| Omit<PatternRemarkDialogCommand, "requestId">
	| Omit<ExportDialogCommand, "requestId">;

export type DialogSnapshot = {
	command: DialogCommand | null;
};

const defaultDraftId = () => crypto.randomUUID();

export function createContextDraft(command: ContextDialogCommand): ContextDialogDraft {
	const parameters = command.params.length
		? command.params.map((parameter, index) => ({
				id: `parameter-${index}`,
				key: parameter.key,
				value: parameter.value
			}))
		: [{ id: "parameter-0", key: "Speed", value: "" }];
	return {
		name: command.name,
		view: command.view,
		folderId: command.folderId || "",
		baudRate: String(command.baudRate),
		parameters
	};
}

export function appendContextParameter(
	parameters: ContextParameterDraft[],
	generateId = defaultDraftId
): ContextParameterDraft[] {
	return [...parameters, { id: generateId(), key: "", value: "" }];
}

export function updateContextParameter(
	parameters: ContextParameterDraft[],
	id: string,
	update: Partial<ContextParameter>
): ContextParameterDraft[] {
	return parameters.map(parameter => (parameter.id === id ? { ...parameter, ...update } : parameter));
}

export function removeContextParameter(
	parameters: ContextParameterDraft[],
	id: string
): ContextParameterDraft[] {
	return parameters.filter(parameter => parameter.id !== id);
}

export function contextDraftToValues(draft: ContextDialogDraft): ContextValues {
	return {
		name: draft.name.trim() || "Untitled capture",
		view: draft.view.trim(),
		folderId: draft.folderId || null,
		params: draft.parameters
			.map(parameter => ({ key: parameter.key.trim(), value: parameter.value.trim() }))
			.filter(parameter => parameter.key),
		baudRate: Number(draft.baudRate),
		inputFormat: "raw"
	};
}

export function createSectionsDraft(rows: SectionDialogRow[]): SectionDialogDraft[] {
	return rows.map(row => ({
		id: row.id,
		start: String(row.start + 1),
		frameSize: String(row.frameSize),
		collapseRuns: row.collapseRuns
	}));
}

export function appendSectionDraft(
	rows: SectionDialogDraft[],
	streamLength: number,
	frameSize: number,
	generateId = defaultDraftId
): SectionDialogDraft[] | null {
	if (streamLength < 2) return null;
	const existingStarts = rows.map(row => Number(row.start) - 1);
	const fallbackStart = Math.min(streamLength - 1, Math.max(...existingStarts, 0) + 1);
	return [
		...rows,
		{
			id: generateId(),
			start: String(fallbackStart + 1),
			frameSize: String(frameSize),
			collapseRuns: false
		}
	];
}

export function updateSectionDraft(
	rows: SectionDialogDraft[],
	id: string,
	update: Partial<Pick<SectionDialogDraft, "start" | "frameSize" | "collapseRuns">>
): SectionDialogDraft[] {
	return rows.map(row => (row.id === id ? { ...row, ...update } : row));
}

export function removeSectionDraft(
	rows: SectionDialogDraft[],
	id: string
): SectionDialogDraft[] | null {
	if (rows.length === 1) return null;
	return rows.filter(row => row.id !== id);
}

export function serializeSectionDrafts(
	rows: SectionDialogDraft[],
	maxStart: number,
	fallbackFrameSize: number
): SectionDraftResult {
	const sections = rows.map(row => ({
		id: row.id || crypto.randomUUID(),
		start: Math.max(0, Math.min(maxStart, Math.floor(Number(row.start) - 1 || 0))),
		frameSize: Math.max(1, Math.min(1024, Math.floor(Number(row.frameSize) || fallbackFrameSize))),
		collapseRuns: Boolean(row.collapseRuns)
	}));
	const starts = new Set<number>();
	for (const section of sections) {
		if (starts.has(section.start)) return { ok: false, error: "Each section must start at a different raw byte" };
		starts.add(section.start);
	}
	return { ok: true, sections };
}

export function annotationTextIsValid(text: string): boolean {
	return text.trim().length > 0;
}

export function normalizeAnnotationText(text: string): string {
	return text.trim();
}

export function normalizePatternRemarkText(text: string): string {
	return text.trim();
}

export function annotationTargetLabel(
	capture: Capture,
	annotationType: AnnotationType,
	key: string
): { title: string; target: string; targetKey: string; displayPosition: number | null } | null {
	const [messageId, positionText] = key.split(":");
	const message = capture.messages?.find(item => item.id === messageId);
	if (!message) return null;
	const position = positionText === undefined ? null : Number(positionText);
	if (annotationType === "byte" && !Number.isInteger(position)) return null;
	const targetKey = annotationType === "byte" ? key : messageId;
	const visiblePosition =
		annotationType === "byte" ? visiblePositionForRawByte(message, position as number) : null;
	const displayPosition =
		annotationType === "byte"
			? ((visiblePosition as number) >= 0 ? (visiblePosition as number) : (position as number))
			: null;
	return {
		title: annotationType === "byte" ? `Note on byte ${(displayPosition as number) + 1}` : "Note on message",
		target: annotationType === "byte"
			? `${signature(message)} · BYTE ${(displayPosition as number) + 1}`
			: signature(message),
		targetKey,
		displayPosition
	};
}

export function sectionRowFromModel(section: CaptureSection): SectionDialogRow {
	return {
		id: String(section.id || ""),
		start: Number(section.start || 0),
		frameSize: Number(section.frameSize || 1),
		collapseRuns: Boolean(section.collapseRuns)
	};
}

import {
	signature,
	visiblePositionForRawByte,
	type Capture
} from "../capture/capture-framing.ts";

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
	| AnnotationDialogCommand
	| PatternRemarkDialogCommand
	| ExportDialogCommand;

export type DialogCommandInput =
	| Omit<ContextDialogCommand, "requestId">
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

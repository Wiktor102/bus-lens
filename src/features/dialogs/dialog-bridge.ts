import { createExternalStore } from "../../shared/external-store.ts";
import type {
	AnnotationDeleteInput,
	AnnotationSaveInput,
	ContextSaveInput,
	DialogCommand,
	DialogCommandInput,
	DialogSnapshot,
	ExportFormat,
	PatternRemarkSaveInput
} from "./dialog-model.ts";

export type DialogActions = {
	saveContext: (input: ContextSaveInput) => boolean;
	saveAnnotation: (input: AnnotationSaveInput) => boolean;
	deleteAnnotation: (input: AnnotationDeleteInput) => void;
	savePatternRemark: (input: PatternRemarkSaveInput) => boolean;
	exportData: (format: ExportFormat) => void;
	notify: (message: string) => void;
};

const EMPTY_DIALOG_SNAPSHOT: DialogSnapshot = { command: null };

const noopActions: DialogActions = {
	saveContext: () => false,
	saveAnnotation: () => false,
	deleteAnnotation: () => {},
	savePatternRemark: () => false,
	exportData: () => {},
	notify: () => {}
};

const dialogStore = createExternalStore<DialogSnapshot, DialogActions>(EMPTY_DIALOG_SNAPSHOT, noopActions);
let requestId = 0;

export const getDialogSnapshot = dialogStore.getSnapshot;
export const subscribeToDialogs = dialogStore.subscribe;
export const registerDialogActions = dialogStore.registerActions;
export const getDialogActions = dialogStore.getActions;

export function publishDialogCommand(command: DialogCommandInput): void {
	dialogStore.publish({ command: { ...command, requestId: ++requestId } as DialogCommand });
}

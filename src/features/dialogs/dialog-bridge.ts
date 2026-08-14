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
import { applicationStore, selectDialog } from "../../shared/application-store.ts";

export type DialogActions = {
	saveContext: (input: ContextSaveInput) => boolean;
	saveAnnotation: (input: AnnotationSaveInput) => boolean;
	deleteAnnotation: (input: AnnotationDeleteInput) => void;
	savePatternRemark: (input: PatternRemarkSaveInput) => boolean;
	exportData: (format: ExportFormat) => void;
	notify: (message: string) => void;
};

const noopActions: DialogActions = {
	saveContext: () => false,
	saveAnnotation: () => false,
	deleteAnnotation: () => {},
	savePatternRemark: () => false,
	exportData: () => {},
	notify: () => {}
};

let actions = noopActions;
let lastCommand: DialogCommand | null | undefined;
let lastSnapshot: DialogSnapshot | undefined;

/** Compatibility action registry; dialog state is owned by applicationStore. */
export function getDialogSnapshot(): DialogSnapshot {
	const command = applicationStore.select(selectDialog);
	if (command !== lastCommand) {
		lastCommand = command;
		lastSnapshot = { command };
	}
	return lastSnapshot || { command };
}

export const subscribeToDialogs = applicationStore.subscribe;
export const registerDialogActions = (next: DialogActions): void => {
	actions = next;
};
export const getDialogActions = (): DialogActions => actions;

export function publishDialogCommand(command: DialogCommandInput): void {
	applicationStore.send({ type: "dialog/command-changed", command });
}

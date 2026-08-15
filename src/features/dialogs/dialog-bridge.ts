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

let lastCommand: DialogCommand | null | undefined;
let lastSnapshot: DialogSnapshot | undefined;

/** Typed command actions; dialog state is owned by applicationStore. */
export function getDialogSnapshot(): DialogSnapshot {
	const command = applicationStore.select(selectDialog);
	if (command !== lastCommand) {
		lastCommand = command;
		lastSnapshot = { command };
	}
	return lastSnapshot || { command };
}

export const subscribeToDialogs = applicationStore.subscribe;
const actions: DialogActions = {
	saveContext: input => {
		applicationStore.sendCommand({ type: "dialog/save-context", input });
		return true;
	},
	saveAnnotation: input => {
		applicationStore.sendCommand({ type: "dialog/save-annotation", input });
		return true;
	},
	deleteAnnotation: input => applicationStore.sendCommand({ type: "dialog/delete-annotation", input }),
	savePatternRemark: input => {
		applicationStore.sendCommand({ type: "dialog/save-pattern-remark", input });
		return true;
	},
	exportData: format => applicationStore.sendCommand({ type: "dialog/export", format }),
	notify: message => applicationStore.sendCommand({ type: "dialog/notify", message })
};

export const getDialogActions = (): DialogActions => actions;

export function publishDialogCommand(command: DialogCommandInput): void {
	applicationStore.send({ type: "dialog/command-changed", command });
}

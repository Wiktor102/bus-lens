import { applicationStore } from "../../shared/application-store.ts";

export type SequenceNoteInput = {
	start: string | number;
	end: string | number;
	text: string;
};

export type NotesActions = {
	addSequenceNote: (input: SequenceNoteInput) => boolean;
};

/** Typed command action; notes are derived from the selected capture query. */
const actions: NotesActions = {
	addSequenceNote: input => {
		const text = String(input.text ?? "").trim();
		if (!text) return false;
		applicationStore.sendCommand({ type: "notes/add-sequence", ...input, text });
		return true;
	}
};

export const getNotesActions = (): NotesActions => actions;

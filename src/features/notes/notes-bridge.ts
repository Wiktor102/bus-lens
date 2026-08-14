export type SequenceNoteInput = {
	start: string | number;
	end: string | number;
	text: string;
};

export type NotesActions = {
	addSequenceNote: (input: SequenceNoteInput) => boolean;
};

const noopActions: NotesActions = {
	addSequenceNote: () => false
};

let actions = noopActions;

/** Compatibility action registry; notes are derived from the selected capture query. */
export const registerNotesActions = (next: NotesActions): void => {
	actions = next;
};
export const getNotesActions = (): NotesActions => actions;

import { createExternalStore } from "../../shared/external-store.ts";
import { EMPTY_NOTES_SNAPSHOT, type NotesSnapshot } from "./notes.ts";

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

const notesStore = createExternalStore<NotesSnapshot, NotesActions>(EMPTY_NOTES_SNAPSHOT, noopActions);

export const getNotesSnapshot = notesStore.getSnapshot;
export const subscribeToNotes = notesStore.subscribe;
export const publishNotesSnapshot = notesStore.publish;
export const registerNotesActions = notesStore.registerActions;
export const getNotesActions = notesStore.getActions;

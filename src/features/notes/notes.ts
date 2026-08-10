import type { Capture } from "../capture/capture-framing.ts";

export type NoteCard = {
	id: string;
	label: "SEQUENCE" | "BYTE" | "MESSAGE";
	text: string;
	createdAt: number;
	targetLabel?: string;
	authorType?: "human" | "agent";
	reportedClientName?: string;
	reportedClientVersion?: string;
	protocolVersion?: string;
};

export type NotesSnapshot = {
	captureId: string | null;
	count: number;
	notes: NoteCard[];
};

export const EMPTY_NOTES_SNAPSHOT: NotesSnapshot = {
	captureId: null,
	count: 0,
	notes: []
};

function noteText(value: unknown): string {
	return String(value ?? "");
}

function noteCreatedAt(value: unknown): number {
	return Number(value || 0);
}

export function deriveNotesSnapshot(capture?: Capture | null): NotesSnapshot {
	if (!capture) return EMPTY_NOTES_SNAPSHOT;
	const sequenceNotes: NoteCard[] = (capture.notes || [])
		.filter(note => note.type === "sequence")
		.map(note => ({
			id: String(note.id || ""),
			label: "SEQUENCE",
			text: noteText(note.text),
			createdAt: noteCreatedAt(note.createdAt),
			targetLabel: note.targetLabel ? String(note.targetLabel) : undefined,
		...(note.authorType === "agent" ? { authorType: "agent" as const } : {}),
			...(note.reportedClientName ? { reportedClientName: String(note.reportedClientName) } : {}),
			...(note.reportedClientVersion ? { reportedClientVersion: String(note.reportedClientVersion) } : {}),
			...(note.protocolVersion ? { protocolVersion: String(note.protocolVersion) } : {})
		}));
	const annotations: NoteCard[] = Object.entries(capture.annotations || {}).map(([key, value]) => {
		const annotation = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
		return {
			id: key,
			label: key.includes(":") ? "BYTE" : "MESSAGE",
			text: noteText(annotation.text),
			createdAt: noteCreatedAt(annotation.createdAt),
			targetLabel: annotation.targetLabel ? String(annotation.targetLabel) : undefined,
			...(annotation.authorType === "agent" ? { authorType: "agent" as const } : {}),
			...(annotation.reportedClientName ? { reportedClientName: String(annotation.reportedClientName) } : {}),
			...(annotation.reportedClientVersion ? { reportedClientVersion: String(annotation.reportedClientVersion) } : {}),
			...(annotation.protocolVersion ? { protocolVersion: String(annotation.protocolVersion) } : {})
		};
	});
	const notes = [...sequenceNotes, ...annotations].sort((a, b) => b.createdAt - a.createdAt);
	return {
		captureId: capture.id ? String(capture.id) : null,
		count: notes.length,
		notes
	};
}

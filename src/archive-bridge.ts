import type { ArchiveCapture, ArchiveFolder } from "./archive-list";

export type ArchiveSnapshot = {
	captures: ArchiveCapture[];
	folders: ArchiveFolder[];
	activeId: string | null | undefined;
	unfiledCollapsed: boolean;
};

export type ArchiveActions = {
	selectCapture: (captureId: string) => void;
	toggleFolder: (folderId: string | null) => void;
	moveCapture: (captureId: string, folderId: string | null) => void;
	openNewCapture: () => void;
	openImport: () => void;
	openExport: () => void;
	saveFolder: (name: string, editingId: string | null) => boolean;
	deleteFolder: (folderId: string) => void;
	importFile: (file: File) => void | Promise<void>;
};

const emptyArchiveSnapshot: ArchiveSnapshot = {
	captures: [],
	folders: [],
	activeId: null,
	unfiledCollapsed: false
};

const noopActions: ArchiveActions = {
	selectCapture: () => {},
	toggleFolder: () => {},
	moveCapture: () => {},
	openNewCapture: () => {},
	openImport: () => {},
	openExport: () => {},
	saveFolder: () => false,
	deleteFolder: () => {},
	importFile: () => {}
};

let archiveSnapshot = emptyArchiveSnapshot;
let archiveActions = noopActions;
const listeners = new Set<() => void>();

export function getArchiveSnapshot() {
	return archiveSnapshot;
}

export function subscribeToArchive(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function publishArchiveSnapshot(snapshot: ArchiveSnapshot) {
	archiveSnapshot = snapshot;
	listeners.forEach(listener => listener());
}

export function registerArchiveActions(actions: ArchiveActions) {
	archiveActions = actions;
}

export function getArchiveActions() {
	return archiveActions;
}

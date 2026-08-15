import type { ArchiveCapture, ArchiveFolder } from "./archive-list";
import { createExternalStore } from "../../shared/external-store.ts";

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
	upgradeCapture: (captureId: string) => void;
	duplicateCapture: (captureId: string) => void;
	deleteCapture: (captureId: string) => void;
	openNewCapture: () => void;
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
	upgradeCapture: () => {},
	duplicateCapture: () => {},
	deleteCapture: () => {},
	openNewCapture: () => {},
	openExport: () => {},
	saveFolder: () => false,
	deleteFolder: () => {},
	importFile: () => {}
};

const archiveStore = createExternalStore<ArchiveSnapshot, ArchiveActions>(emptyArchiveSnapshot, noopActions);

export const getArchiveSnapshot = archiveStore.getSnapshot;
export const subscribeToArchive = archiveStore.subscribe;
export const publishArchiveSnapshot = archiveStore.publish;
export const registerArchiveActions = archiveStore.registerActions;
export const getArchiveActions = archiveStore.getActions;

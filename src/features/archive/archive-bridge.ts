import { applicationStore } from "../../shared/application-store.ts";

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

/** Typed command actions; archive data is Query-owned. */
const actions: ArchiveActions = {
	selectCapture: captureId => applicationStore.sendCommand({ type: "archive/select", captureId }),
	toggleFolder: folderId => applicationStore.sendCommand({ type: "archive/toggle-folder", folderId }),
	moveCapture: (captureId, folderId) => applicationStore.sendCommand({ type: "archive/move-capture", captureId, folderId }),
	upgradeCapture: captureId => applicationStore.sendCommand({ type: "capture/upgrade", captureId }),
	duplicateCapture: captureId => applicationStore.sendCommand({ type: "capture/duplicate-archive", captureId }),
	deleteCapture: captureId => applicationStore.sendCommand({ type: "capture/delete", captureId }),
	openNewCapture: () => applicationStore.sendCommand({ type: "archive/open-new-capture" }),
	openExport: () => applicationStore.sendCommand({ type: "archive/open-export" }),
	saveFolder: (name, editingId) => {
		applicationStore.sendCommand({ type: "archive/save-folder", name, editingId });
		return Boolean(name.trim());
	},
	deleteFolder: folderId => applicationStore.sendCommand({ type: "archive/delete-folder", folderId }),
	importFile: file => { applicationStore.sendCommand({ type: "archive/import-file", file }); }
};

export const getArchiveActions = (): ArchiveActions => actions;

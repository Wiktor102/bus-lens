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

let actions = noopActions;

/** Compatibility action registry; archive data is Query-owned. */
export const registerArchiveActions = (next: ArchiveActions): void => {
	actions = next;
};
export const getArchiveActions = (): ArchiveActions => actions;

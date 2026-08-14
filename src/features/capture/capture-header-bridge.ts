export type CaptureHeaderActions = {
	setTitle: (value: string) => void;
	commitTitle: (value: string) => void;
	setDescription: (value: string) => void;
	commitDescription: (value: string) => void;
	openContext: () => void;
	duplicate: () => void;
	clearMessages: () => void;
	deleteCapture: () => void;
	upgradeStorage: () => void;
};

const noopActions: CaptureHeaderActions = {
	setTitle: () => {},
	commitTitle: () => {},
	setDescription: () => {},
	commitDescription: () => {},
	openContext: () => {},
	duplicate: () => {},
	clearMessages: () => {},
	deleteCapture: () => {},
	upgradeStorage: () => {}
};

let actions = noopActions;

/** Compatibility action registry; header data is derived from query state. */
export const registerCaptureHeaderActions = (next: CaptureHeaderActions): void => {
	actions = next;
};
export const getCaptureHeaderActions = (): CaptureHeaderActions => actions;

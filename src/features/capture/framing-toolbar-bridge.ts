import { createExternalStore } from "../../shared/external-store.ts";
import {
	EMPTY_FRAMING_TOOLBAR_SNAPSHOT,
	type FramingSettingsUpdate,
	type FramingToolbarSnapshot
} from "./framing-toolbar.ts";

export type FramingToolbarActions = {
	updateSettings: (update: FramingSettingsUpdate) => void;
	openSections: () => void;
};

const noopActions: FramingToolbarActions = {
	updateSettings: () => {},
	openSections: () => {}
};

const framingToolbarStore = createExternalStore<FramingToolbarSnapshot, FramingToolbarActions>(
	EMPTY_FRAMING_TOOLBAR_SNAPSHOT,
	noopActions
);

export const getFramingToolbarSnapshot = framingToolbarStore.getSnapshot;
export const subscribeToFramingToolbar = framingToolbarStore.subscribe;
export const publishFramingToolbarSnapshot = framingToolbarStore.publish;
export const registerFramingToolbarActions = framingToolbarStore.registerActions;
export const getFramingToolbarActions = framingToolbarStore.getActions;

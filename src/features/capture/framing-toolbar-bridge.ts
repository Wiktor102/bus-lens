import { createExternalStore } from "../../shared/external-store.ts";
import {
	EMPTY_FRAMING_TOOLBAR_SNAPSHOT,
	type FramingToolbarSnapshot
} from "./framing-toolbar.ts";

const framingToolbarStore = createExternalStore<FramingToolbarSnapshot, undefined>(EMPTY_FRAMING_TOOLBAR_SNAPSHOT, undefined);

export const getFramingToolbarSnapshot = framingToolbarStore.getSnapshot;
export const subscribeToFramingToolbar = framingToolbarStore.subscribe;
export const publishFramingToolbarSnapshot = framingToolbarStore.publish;

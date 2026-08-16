import { createStore } from "@xstate/store";
import {
	EMPTY_VIEW_STATE_SNAPSHOT,
	reduceViewState,
	type DisplayMode,
	type ViewPanel,
	type ViewStateAction,
	type ViewStateSnapshot
} from "./view-state.ts";

export type ApplicationState = Readonly<{
	viewState: ViewStateSnapshot;
}>;

export type ApplicationEvent =
	| { type: "view/active-panel-changed"; activePanel: ViewPanel }
	| { type: "view/filter-open-changed"; filterOpen: boolean }
	| { type: "view/filter-query-changed"; filterQuery: string }
	| { type: "view/display-mode-changed"; displayMode: DisplayMode }
	| { type: "view/frame-changes-changed"; showFrameChanges: boolean }
	| { type: "view/collapse-runs-changed"; collapseRuns: boolean }
	| { type: "view/replaced"; viewState: ViewStateSnapshot };

export type ApplicationSelector<Selected> = (state: ApplicationState) => Selected;

export type ApplicationStore = {
	getSnapshot: () => ApplicationState;
	subscribe: (listener: () => void) => () => void;
	send: (event: ApplicationEvent) => void;
	select: <Selected>(selector: ApplicationSelector<Selected>) => Selected;
};

function cloneViewStateSnapshot(snapshot: ViewStateSnapshot): ViewStateSnapshot {
	return Object.freeze({ ...snapshot });
}

function createApplicationState(viewState: ViewStateSnapshot): ApplicationState {
	return Object.freeze({ viewState: cloneViewStateSnapshot(viewState) });
}

function withViewState(state: ApplicationState, action: ViewStateAction): ApplicationState {
	return createApplicationState(reduceViewState(state.viewState, action));
}

export function viewStateActionToApplicationEvent(action: ViewStateAction): ApplicationEvent {
	switch (action.type) {
		case "set-active-panel":
			return { type: "view/active-panel-changed", activePanel: action.activePanel };
		case "set-filter-open":
			return { type: "view/filter-open-changed", filterOpen: action.filterOpen };
		case "set-filter-query":
			return { type: "view/filter-query-changed", filterQuery: action.filterQuery };
		case "set-display-mode":
			return { type: "view/display-mode-changed", displayMode: action.displayMode };
		case "set-frame-changes":
			return { type: "view/frame-changes-changed", showFrameChanges: action.showFrameChanges };
		case "set-collapse-runs":
			return { type: "view/collapse-runs-changed", collapseRuns: action.collapseRuns };
	}
}

export const selectViewState: ApplicationSelector<ViewStateSnapshot> = state => state.viewState;
export const selectActivePanel: ApplicationSelector<ViewPanel> = state => state.viewState.activePanel;
export const selectDisplayMode: ApplicationSelector<DisplayMode> = state => state.viewState.displayMode;

export function createApplicationStore(
	initialViewState: ViewStateSnapshot = EMPTY_VIEW_STATE_SNAPSHOT
): ApplicationStore {
	const store = createStore({
		context: createApplicationState(initialViewState),
		on: {
			"view/active-panel-changed": (state, event: { activePanel: ViewPanel }) =>
				withViewState(state, { type: "set-active-panel", activePanel: event.activePanel }),
			"view/filter-open-changed": (state, event: { filterOpen: boolean }) =>
				withViewState(state, { type: "set-filter-open", filterOpen: event.filterOpen }),
			"view/filter-query-changed": (state, event: { filterQuery: string }) =>
				withViewState(state, { type: "set-filter-query", filterQuery: event.filterQuery }),
			"view/display-mode-changed": (state, event: { displayMode: DisplayMode }) =>
				withViewState(state, { type: "set-display-mode", displayMode: event.displayMode }),
			"view/frame-changes-changed": (state, event: { showFrameChanges: boolean }) =>
				withViewState(state, { type: "set-frame-changes", showFrameChanges: event.showFrameChanges }),
			"view/collapse-runs-changed": (state, event: { collapseRuns: boolean }) =>
				withViewState(state, { type: "set-collapse-runs", collapseRuns: event.collapseRuns }),
			"view/replaced": (_state, event: { viewState: ViewStateSnapshot }) =>
				createApplicationState(event.viewState)
		}
	});

	return {
		getSnapshot: () => store.getSnapshot().context,
		subscribe: listener => {
			const subscription = store.subscribe(() => listener());
			return () => subscription.unsubscribe();
		},
		send: event => store.send(event),
		select: selector => selector(store.getSnapshot().context)
	};
}

/** The application store is the only shared client-state instance. */
export const applicationStore = createApplicationStore();

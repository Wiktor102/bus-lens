export type ViewPanel = "stream" | "patterns" | "notes";
export type DisplayMode = "hex" | "binary";

export type ViewStateSnapshot = {
	activePanel: ViewPanel;
	filterOpen: boolean;
	filterQuery: string;
	displayMode: DisplayMode;
	showFrameChanges: boolean;
	collapseRuns: boolean;
};

export type ViewStateAction =
	| { type: "set-active-panel"; activePanel: ViewPanel }
	| { type: "set-filter-open"; filterOpen: boolean }
	| { type: "set-filter-query"; filterQuery: string }
	| { type: "set-display-mode"; displayMode: DisplayMode }
	| { type: "set-frame-changes"; showFrameChanges: boolean }
	| { type: "set-collapse-runs"; collapseRuns: boolean };

export const EMPTY_VIEW_STATE_SNAPSHOT: ViewStateSnapshot = {
	activePanel: "stream",
	filterOpen: false,
	filterQuery: "",
	displayMode: "hex",
	showFrameChanges: true,
	collapseRuns: false
};

export function reduceViewState(
	state: ViewStateSnapshot,
	action: ViewStateAction
): ViewStateSnapshot {
	switch (action.type) {
		case "set-active-panel":
			return { ...state, activePanel: action.activePanel };
		case "set-filter-open":
			return { ...state, filterOpen: action.filterOpen };
		case "set-filter-query":
			return { ...state, filterQuery: action.filterQuery };
		case "set-display-mode":
			return { ...state, displayMode: action.displayMode };
		case "set-frame-changes":
			return { ...state, showFrameChanges: action.showFrameChanges };
		case "set-collapse-runs":
			return { ...state, collapseRuns: action.collapseRuns };
	}
}

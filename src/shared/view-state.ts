export type ViewPanel = "stream" | "patterns" | "notes";
export type DisplayMode = "hex" | "binary";

export type SectionViewPreference = Readonly<{
	collapseRuns: boolean;
	collapsed: boolean;
}>;

export type SectionViewPreferenceSeed = Readonly<{
	rawStart: number;
	collapseRuns?: boolean;
	collapsed?: boolean;
}>;

export type SectionViewPreferencePatch = Partial<SectionViewPreference>;

export type SectionViewPreferences = Readonly<
	Record<string, Readonly<Record<string, SectionViewPreference>>>
>;

export type ViewStateSnapshot = Readonly<{
	activePanel: ViewPanel;
	filterOpen: boolean;
	filterQuery: string;
	displayMode: DisplayMode;
	showFrameChanges: boolean;
	collapseRuns: boolean;
	sectionPreferences: SectionViewPreferences;
}>;

export type ViewStateAction =
	| { type: "set-active-panel"; activePanel: ViewPanel }
	| { type: "set-filter-open"; filterOpen: boolean }
	| { type: "set-filter-query"; filterQuery: string }
	| { type: "set-display-mode"; displayMode: DisplayMode }
	| { type: "set-frame-changes"; showFrameChanges: boolean }
	| { type: "set-collapse-runs"; collapseRuns: boolean }
	| { type: "seed-section-preferences"; captureId: string; sections: readonly SectionViewPreferenceSeed[] }
	| { type: "set-section-preference"; captureId: string; rawStart: number; patch: SectionViewPreferencePatch }
	| { type: "copy-section-preference"; captureId: string; fromRawStart: number; toRawStart: number }
	| { type: "move-section-preference"; captureId: string; fromRawStart: number; toRawStart: number }
	| { type: "delete-section-preference"; captureId: string; rawStart: number }
	| { type: "reconcile-section-preferences"; captureId: string; rawStarts: readonly number[] }
	| { type: "clear-section-preferences"; captureId: string };

export const EMPTY_VIEW_STATE_SNAPSHOT: ViewStateSnapshot = Object.freeze({
	activePanel: "stream",
	filterOpen: false,
	filterQuery: "",
	displayMode: "hex",
	showFrameChanges: true,
	collapseRuns: false,
	sectionPreferences: Object.freeze({})
});

const DEFAULT_SECTION_VIEW_PREFERENCE: SectionViewPreference = Object.freeze({
	collapseRuns: false,
	collapsed: false
});

function rawStartKey(rawStart: number): string | null {
	return Number.isSafeInteger(rawStart) && rawStart >= 0 ? String(rawStart) : null;
}

function captureSectionPreferences(
	state: ViewStateSnapshot,
	captureId: string
): Readonly<Record<string, SectionViewPreference>> {
	return state.sectionPreferences[String(captureId)] || {};
}

function withCaptureSectionPreferences(
	state: ViewStateSnapshot,
	captureId: string,
	preferences: Readonly<Record<string, SectionViewPreference>>
): ViewStateSnapshot {
	return {
		...state,
		sectionPreferences: {
			...state.sectionPreferences,
			[String(captureId)]: preferences
		}
	};
}

function sameSectionPreference(left: SectionViewPreference, right: SectionViewPreference): boolean {
	return left.collapseRuns === right.collapseRuns && left.collapsed === right.collapsed;
}

function setSectionPreference(
	state: ViewStateSnapshot,
	captureId: string,
	rawStart: number,
	patch: SectionViewPreferencePatch,
	seedOnly = false
): ViewStateSnapshot {
	const key = rawStartKey(rawStart);
	if (!key) return state;
	const currentPreferences = captureSectionPreferences(state, captureId);
	if (seedOnly && currentPreferences[key]) return state;
	const current = currentPreferences[key] || DEFAULT_SECTION_VIEW_PREFERENCE;
	const next = {
		collapseRuns: patch.collapseRuns === undefined ? current.collapseRuns : Boolean(patch.collapseRuns),
		collapsed: patch.collapsed === undefined ? current.collapsed : Boolean(patch.collapsed)
	};
	if (currentPreferences[key] && sameSectionPreference(currentPreferences[key], next)) return state;
	return withCaptureSectionPreferences(state, captureId, {
		...currentPreferences,
		[key]: Object.freeze(next)
	});
}

export function getSectionViewPreference(
	viewState: ViewStateSnapshot,
	captureId: string | null | undefined,
	rawStart: number
): SectionViewPreference | undefined {
	if (!captureId) return undefined;
	const key = rawStartKey(rawStart);
	return key ? viewState.sectionPreferences[String(captureId)]?.[key] : undefined;
}

export function reduceViewState(
	state: ViewStateSnapshot,
	action: ViewStateAction
): ViewStateSnapshot {
	switch (action.type) {
		case "set-active-panel":
			return state.activePanel === action.activePanel ? state : { ...state, activePanel: action.activePanel };
		case "set-filter-open":
			return state.filterOpen === action.filterOpen ? state : { ...state, filterOpen: action.filterOpen };
		case "set-filter-query":
			return state.filterQuery === action.filterQuery ? state : { ...state, filterQuery: action.filterQuery };
		case "set-display-mode":
			return state.displayMode === action.displayMode ? state : { ...state, displayMode: action.displayMode };
		case "set-frame-changes":
			return state.showFrameChanges === action.showFrameChanges ? state : { ...state, showFrameChanges: action.showFrameChanges };
		case "set-collapse-runs":
			return state.collapseRuns === action.collapseRuns ? state : { ...state, collapseRuns: action.collapseRuns };
		case "seed-section-preferences":
			return action.sections.reduce(
				(current, section) => setSectionPreference(current, action.captureId, section.rawStart, section, true),
				state
			);
		case "set-section-preference":
			return setSectionPreference(state, action.captureId, action.rawStart, action.patch);
		case "copy-section-preference": {
			const fromKey = rawStartKey(action.fromRawStart);
			const toKey = rawStartKey(action.toRawStart);
			if (!fromKey || !toKey || fromKey === toKey) return state;
			const currentPreferences = captureSectionPreferences(state, action.captureId);
			const preference = currentPreferences[fromKey];
			if (!preference) return state;
			if (currentPreferences[toKey] && sameSectionPreference(currentPreferences[toKey], preference)) return state;
			return withCaptureSectionPreferences(state, action.captureId, {
				...currentPreferences,
				[toKey]: preference
			});
		}
		case "move-section-preference": {
			const fromKey = rawStartKey(action.fromRawStart);
			const toKey = rawStartKey(action.toRawStart);
			if (!fromKey || !toKey || fromKey === toKey) return state;
			const currentPreferences = captureSectionPreferences(state, action.captureId);
			const preference = currentPreferences[fromKey];
			if (!preference) return state;
			const nextPreferences = { ...currentPreferences };
			delete nextPreferences[fromKey];
			nextPreferences[toKey] = preference;
			return withCaptureSectionPreferences(state, action.captureId, nextPreferences);
		}
		case "delete-section-preference": {
			const key = rawStartKey(action.rawStart);
			if (!key) return state;
			const currentPreferences = captureSectionPreferences(state, action.captureId);
			if (!currentPreferences[key]) return state;
			const nextPreferences = { ...currentPreferences };
			delete nextPreferences[key];
			return withCaptureSectionPreferences(state, action.captureId, nextPreferences);
		}
		case "reconcile-section-preferences": {
			const currentPreferences = captureSectionPreferences(state, action.captureId);
			const validKeys = new Set(action.rawStarts.map(rawStartKey).filter((key): key is string => key !== null));
			const currentEntries = Object.entries(currentPreferences);
			if (currentEntries.every(([key]) => validKeys.has(key))) return state;
			const nextPreferences = Object.fromEntries(currentEntries.filter(([key]) => validKeys.has(key))) as Readonly<Record<string, SectionViewPreference>>;
			return withCaptureSectionPreferences(state, action.captureId, nextPreferences);
		}
		case "clear-section-preferences": {
			if (!state.sectionPreferences[String(action.captureId)]) return state;
			const nextCapturePreferences = { ...state.sectionPreferences };
			delete nextCapturePreferences[String(action.captureId)];
			return { ...state, sectionPreferences: nextCapturePreferences };
		}
	}
}

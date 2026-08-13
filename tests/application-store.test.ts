import assert from "node:assert/strict";
import test from "node:test";
import {
	createApplicationStore,
	selectActivePanel,
	selectDisplayMode,
	selectViewState,
	viewStateActionToApplicationEvent
} from "../src/shared/application-store.ts";
import { createTestApplicationStore } from "../src/test-utils/application-store.ts";
import { EMPTY_VIEW_STATE_SNAPSHOT } from "../src/shared/view-state.ts";

test("application store changes ViewState only through typed events", () => {
	const store = createTestApplicationStore();
	let updates = 0;
	const unsubscribe = store.subscribe(() => updates++);

	store.send(viewStateActionToApplicationEvent({ type: "set-active-panel", activePanel: "patterns" }));
	store.send({ type: "view/filter-query-changed", filterQuery: "c2 ?? 5d" });

	assert.equal(selectActivePanel(store.getSnapshot()), "patterns");
	assert.equal(selectDisplayMode(store.getSnapshot()), "hex");
	assert.equal(selectViewState(store.getSnapshot()).filterQuery, "c2 ?? 5d");
	assert.equal(updates, 2);
	assert.equal("trigger" in store, false);
	assert.equal("set" in store, false);

	unsubscribe();
});

test("application store instances and selectors stay isolated for tests", () => {
	const first = createApplicationStore();
	const second = createApplicationStore();

	first.send({ type: "view/display-mode-changed", displayMode: "binary" });

	assert.equal(selectDisplayMode(first.getSnapshot()), "binary");
	assert.equal(selectDisplayMode(second.getSnapshot()), "hex");
});

test("application store isolates and freezes snapshot boundaries", () => {
	const initial = { ...EMPTY_VIEW_STATE_SNAPSHOT };
	const store = createApplicationStore(initial);

	initial.filterQuery = "mutated by caller";
	assert.equal(store.getSnapshot().viewState.filterQuery, "");
	assert.equal(Object.isFrozen(EMPTY_VIEW_STATE_SNAPSHOT), true);
	assert.equal(Object.isFrozen(store.getSnapshot()), true);
	assert.equal(Object.isFrozen(store.getSnapshot().viewState), true);

	const exposedState = store.getSnapshot();
	assert.throws(() => {
		(exposedState.viewState as unknown as { filterQuery: string }).filterQuery = "mutated through snapshot";
	}, TypeError);
	assert.equal(store.getSnapshot().viewState.filterQuery, "");

	const replacement = { ...EMPTY_VIEW_STATE_SNAPSHOT, filterQuery: "replacement" };
	store.send({ type: "view/replaced", viewState: replacement });
	replacement.filterQuery = "mutated after send";

	assert.equal(store.getSnapshot().viewState.filterQuery, "replacement");
	assert.notEqual(store.getSnapshot().viewState, replacement);
});

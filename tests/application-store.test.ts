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

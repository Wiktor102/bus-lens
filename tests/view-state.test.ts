import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_VIEW_STATE_SNAPSHOT, reduceViewState } from "../src/view-state.ts";

test("reduces React-owned view controls without changing unrelated state", () => {
	const next = reduceViewState(
		reduceViewState(EMPTY_VIEW_STATE_SNAPSHOT, { type: "set-active-panel", activePanel: "patterns" }),
		{ type: "set-filter-query", filterQuery: "c2 ?? 5d" }
	);

	assert.deepEqual(next, {
		...EMPTY_VIEW_STATE_SNAPSHOT,
		activePanel: "patterns",
		filterQuery: "c2 ?? 5d"
	});
});

test("keeps stream control defaults compatible with the existing DOM controls", () => {
	assert.equal(EMPTY_VIEW_STATE_SNAPSHOT.activePanel, "stream");
	assert.equal(EMPTY_VIEW_STATE_SNAPSHOT.displayMode, "hex");
	assert.equal(EMPTY_VIEW_STATE_SNAPSHOT.showFrameChanges, true);
	assert.equal(EMPTY_VIEW_STATE_SNAPSHOT.collapseRuns, false);
	assert.equal(EMPTY_VIEW_STATE_SNAPSHOT.filterOpen, false);
});

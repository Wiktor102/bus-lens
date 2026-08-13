import assert from "node:assert/strict";
import test from "node:test";
import {
	getViewStateSnapshot,
	publishViewStateSnapshot,
	subscribeToViewState
} from "../src/shared/view-state-bridge.ts";
import { EMPTY_VIEW_STATE_SNAPSHOT } from "../src/shared/view-state.ts";

test("legacy ViewState bridge publishes snapshots and notifies subscribers", () => {
	const previous = getViewStateSnapshot();
	const next = {
		...EMPTY_VIEW_STATE_SNAPSHOT,
		activePanel: "patterns" as const,
		filterQuery: "c2 ?? 5d"
	};
	let updates = 0;
	const unsubscribe = subscribeToViewState(() => updates++);

	try {
		publishViewStateSnapshot(next);

		assert.deepEqual(getViewStateSnapshot(), next);
		assert.equal(updates, 1);
	} finally {
		unsubscribe();
		publishViewStateSnapshot(previous);
	}

	publishViewStateSnapshot({ ...next, filterQuery: "ignored after unsubscribe" });
	assert.equal(updates, 1);
	publishViewStateSnapshot(previous);
});

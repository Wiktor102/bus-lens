import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_VIEW_STATE_SNAPSHOT, getSectionViewPreference, reduceViewState } from "../src/shared/view-state.ts";

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

test("keeps section presentation preferences keyed by capture and raw start", () => {
	const seeded = reduceViewState(EMPTY_VIEW_STATE_SNAPSHOT, {
		type: "seed-section-preferences",
		captureId: "capture-1",
		sections: [
			{ rawStart: 0, collapsed: true },
			{ rawStart: 8, collapseRuns: true }
		]
	});
	assert.deepEqual(getSectionViewPreference(seeded, "capture-1", 0), { collapseRuns: false, collapsed: true });
	assert.deepEqual(getSectionViewPreference(seeded, "capture-1", 8), { collapseRuns: true, collapsed: false });

	const updated = reduceViewState(seeded, {
		type: "set-section-preference",
		captureId: "capture-1",
		rawStart: 0,
		patch: { collapsed: false }
	});
	const moved = reduceViewState(updated, {
		type: "move-section-preference",
		captureId: "capture-1",
		fromRawStart: 8,
		toRawStart: 7
	});
	assert.equal(getSectionViewPreference(moved, "capture-1", 8), undefined);
	assert.deepEqual(getSectionViewPreference(moved, "capture-1", 7), { collapseRuns: true, collapsed: false });

	const deleted = reduceViewState(moved, {
		type: "delete-section-preference",
		captureId: "capture-1",
		rawStart: 7
	});
	assert.equal(getSectionViewPreference(deleted, "capture-1", 7), undefined);
});

test("does not overwrite a live preference when an authoritative refresh seeds legacy flags", () => {
	const toggled = reduceViewState(EMPTY_VIEW_STATE_SNAPSHOT, {
		type: "set-section-preference",
		captureId: "capture-1",
		rawStart: 0,
		patch: { collapsed: true }
	});
	const refreshed = reduceViewState(toggled, {
		type: "seed-section-preferences",
		captureId: "capture-1",
		sections: [{ rawStart: 0, collapsed: false }]
	});
	assert.deepEqual(getSectionViewPreference(refreshed, "capture-1", 0), { collapseRuns: false, collapsed: true });
});

test("preserves view-state identity when an action has no effective change", () => {
	const seeded = reduceViewState(EMPTY_VIEW_STATE_SNAPSHOT, {
		type: "seed-section-preferences",
		captureId: "capture-1",
		sections: [{ rawStart: 0, collapseRuns: true, collapsed: false }]
	});

	assert.strictEqual(
		reduceViewState(seeded, {
			type: "seed-section-preferences",
			captureId: "capture-1",
			sections: [{ rawStart: 0, collapseRuns: false, collapsed: true }]
		}),
		seeded
	);
	assert.strictEqual(
		reduceViewState(seeded, {
			type: "set-section-preference",
			captureId: "capture-1",
			rawStart: 0,
			patch: { collapseRuns: true }
		}),
		seeded
	);
	assert.strictEqual(
		reduceViewState(seeded, {
			type: "reconcile-section-preferences",
			captureId: "capture-1",
			rawStarts: [0]
		}),
		seeded
	);
});

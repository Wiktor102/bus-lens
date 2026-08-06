import assert from "node:assert/strict";
import test from "node:test";
import { createExternalStore } from "../src/shared/external-store.ts";

test("external store publishes snapshots and replaces typed commands", () => {
	const firstActions = { run: () => "first" as const };
	const secondActions = { run: () => "second" as const };
	const store = createExternalStore({ count: 0 }, firstActions);
	let updates = 0;
	const unsubscribe = store.subscribe(() => updates++);

	store.publish({ count: 1 });
	store.registerActions(secondActions);

	assert.deepEqual(store.getSnapshot(), { count: 1 });
	assert.equal(store.getActions().run(), "second");
	assert.equal(updates, 1);
	unsubscribe();
	store.publish({ count: 2 });
	assert.equal(updates, 1);
});

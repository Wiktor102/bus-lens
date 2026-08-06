import assert from "node:assert/strict";
import test from "node:test";
import { createBeforeUnloadHandler } from "../src/app/unload-lifecycle.ts";

test("flushes bytes and disconnects without starting async persistence during unload", () => {
	const events: string[] = [];
	const handleBeforeUnload = createBeforeUnloadHandler({
		beginUnload: () => events.push("begin-unload"),
		flushLiveBytes: () => events.push("flush"),
		getPort: () => ({ port: true }),
		disconnect: options => {
			events.push(`disconnect:${options?.persist === false ? "skip-persist" : "persist"}`);
			return Promise.resolve();
		}
	});

	handleBeforeUnload();

	assert.deepEqual(events, ["begin-unload", "flush", "disconnect:skip-persist"]);
});

test("does not disconnect when no serial port is open", () => {
	let disconnected = false;
	const handleBeforeUnload = createBeforeUnloadHandler({
		beginUnload: () => {},
		flushLiveBytes: () => {},
		getPort: () => null,
		disconnect: () => {
			disconnected = true;
		}
	});

	handleBeforeUnload();

	assert.equal(disconnected, false);
});

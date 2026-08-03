import assert from "node:assert/strict";
import test from "node:test";
import { createBeforeUnloadHandler } from "../src/unload-lifecycle.ts";

test("flushes bytes, persists state, and disconnects an open port in unload order", () => {
	const events: string[] = [];
	const handleBeforeUnload = createBeforeUnloadHandler({
		flushLiveBytes: () => events.push("flush"),
		persistState: () => events.push("persist"),
		getPort: () => ({ port: true }),
		disconnect: () => {
			events.push("disconnect");
			return Promise.resolve();
		}
	});

	handleBeforeUnload();

	assert.deepEqual(events, ["flush", "persist", "disconnect"]);
});

test("does not disconnect when no serial port is open", () => {
	let disconnected = false;
	const handleBeforeUnload = createBeforeUnloadHandler({
		flushLiveBytes: () => {},
		persistState: () => {},
		getPort: () => null,
		disconnect: () => {
			disconnected = true;
		}
	});

	handleBeforeUnload();

	assert.equal(disconnected, false);
});

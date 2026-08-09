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

test("warns before unload when captured bytes are not acknowledged", () => {
	let prevented = false;
	const event = {
		preventDefault: () => { prevented = true; },
		returnValue: "unchanged"
	};
	const handleBeforeUnload = createBeforeUnloadHandler({
		beginUnload: () => {},
		flushLiveBytes: () => {},
		hasUnacknowledgedBytes: () => true,
		getPort: () => null,
		disconnect: () => {}
	});

	handleBeforeUnload(event);

	assert.equal(prevented, true);
	assert.equal(event.returnValue, "");
});

test("does not imply unload persistence when every append is acknowledged", () => {
	let prevented = false;
	const handleBeforeUnload = createBeforeUnloadHandler({
		beginUnload: () => {},
		flushLiveBytes: () => {},
		hasUnacknowledgedBytes: () => false,
		getPort: () => null,
		disconnect: () => {}
	});

	handleBeforeUnload({ preventDefault: () => { prevented = true; } });

	assert.equal(prevented, false);
});

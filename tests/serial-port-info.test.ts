import assert from "node:assert/strict";
import test from "node:test";
import { describeSerialPort } from "../src/serial-port-info.ts";

test("prefers an exposed OS port label and normalizes COM paths", () => {
	assert.deepEqual(describeSerialPort({ path: "\\\\.\\com7" }), { label: "COM7", source: "os" });
});

test("falls back to USB identity for browser Web Serial ports", () => {
	assert.deepEqual(
		describeSerialPort({ getInfo: () => ({ usbVendorId: 0x2341, usbProductId: 0x0043 }) }),
		{ label: "USB 0x2341:0x0043", source: "usb" }
	);
});

test("uses a generic connected label when no port identity is available", () => {
	assert.deepEqual(describeSerialPort({ getInfo: () => ({}) }), { label: "Port connected", source: "generic" });
});

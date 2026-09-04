import assert from "node:assert/strict";
import test from "node:test";
import { SnifferParser } from "../src/features/transport/sniffer-parser.ts";

function parse(chunks: number[][]) {
	const bytes: Array<{ value: number; direction: string }> = [];
	const parser = new SnifferParser(byte => bytes.push(byte));
	for (const chunk of chunks) parser.push(Uint8Array.from(chunk));
	return { bytes, parser };
}

test("parses RX and TX records and drops noise before the next marker", () => {
	const { bytes } = parse([[0x01, 0xa5, 0x00, 0x10, 0xa5, 0x01, 0xef, 0x02]]);

	assert.deepEqual(bytes, [
		{ value: 0x10, direction: "rx" },
		{ value: 0xef, direction: "tx" }
	]);
});

test("retains only incomplete marker records between reads", () => {
	const { bytes, parser } = parse([[0xa5], [0x00], [0x42, 0xa5, 0x01], [0x99]]);

	assert.deepEqual(bytes, [
		{ value: 0x42, direction: "rx" },
		{ value: 0x99, direction: "tx" }
	]);
	assert.equal(parser.pendingByteCount, 0);
});

test("invalid directions resume scanning at the next marker", () => {
	const { bytes } = parse([[0xa5, 0x02, 0x10, 0xa5, 0x01, 0x20]]);

	assert.deepEqual(bytes, [{ value: 0x20, direction: "tx" }]);
});

test("reports split firmware diagnostics without turning them into captured bytes", () => {
	const bytes: Array<{ value: number; direction: string }> = [];
	const diagnostics: Array<{ status: number; detail: number }> = [];
	const parser = new SnifferParser(byte => bytes.push(byte), diagnostic => diagnostics.push(diagnostic));

	parser.push(Uint8Array.from([0xa6, 0x02]));
	parser.push(Uint8Array.from([0x01, 0xa5, 0x00, 0x42]));

	assert.deepEqual(diagnostics, [{ status: 0x02, detail: 0x01 }]);
	assert.deepEqual(bytes, [{ value: 0x42, direction: "rx" }]);
	assert.equal(parser.pendingByteCount, 0);
});

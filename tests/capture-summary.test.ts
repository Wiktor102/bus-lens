import assert from "node:assert/strict";
import test from "node:test";
import {
	countDistinctMessageSignatures,
	countReceivedRawBytes,
	normalizeCaptureSummaryData,
	signatureForMessage,
	sumRecordingSessionDurations
} from "../src/features/capture/capture-summary.ts";

test("sums discrete recording sessions instead of their timestamp span", () => {
	assert.equal(
		sumRecordingSessionDurations([
			{ id: "first", firstReceivedAt: 1_000, lastReceivedAt: 1_250 },
			{ id: "second", firstReceivedAt: 10_000, lastReceivedAt: 10_400 }
		]),
		650
	);
});

test("empty, TX-only, and open sessions contribute no duration", () => {
	assert.equal(sumRecordingSessionDurations([{ id: "empty" }, { id: "tx-only", firstReceivedAt: 200 }]), 0);
	assert.deepEqual(
		normalizeCaptureSummaryData(
			{ byteStream: [{ value: 1, timestamp: 100, direction: "tx" }], notes: [] },
			() => "legacy"
		).captureSessions,
		[]
	);
});

test("counts distinct framed-message signatures", () => {
	assert.equal(
		countDistinctMessageSignatures([
			{ bytes: [0xc2, 0x08, 0x5d] },
			{ bytes: [0xc2, 0x08, 0x5d] },
			{ bytes: [0xc2, 0x00, 0x5d] }
		]),
		2
	);
});

test("ignores hidden bytes when counting message signatures", () => {
	assert.equal(signatureForMessage({ bytes: [0xc2, 0x08, 0x5d], hiddenBytes: [false, true, false] }), "C2 5D");
	assert.equal(
		countDistinctMessageSignatures([
			{ bytes: [0xc2, 0x08, 0x5d], hiddenBytes: [false, true, false] },
			{ bytes: [0xc2, 0x00, 0x5d], hiddenBytes: [false, true, false] }
		]),
		1
	);
});

test("counts only received raw bytes", () => {
	assert.equal(
		countReceivedRawBytes([
			{ value: 1, timestamp: 1, direction: "rx" },
			{ value: 2, timestamp: 2, direction: "tx" },
			{ value: 3, timestamp: 3 }
		]),
		2
	);
});

test("preserves stored session duration after raw rolling-buffer trimming", () => {
	const capture = normalizeCaptureSummaryData({
		captureSessions: [{ id: "saved", firstReceivedAt: 100, lastReceivedAt: 700 }],
		byteStream: [{ value: 9, timestamp: 700, direction: "rx" }],
		notes: []
	});
	assert.equal(sumRecordingSessionDurations(capture.captureSessions), 600);
});

test("normalizes a legacy received stream into one session", () => {
	const capture = normalizeCaptureSummaryData(
		{
			byteStream: [
				{ value: 1, timestamp: 100, direction: "tx" },
				{ value: 2, timestamp: 150, direction: "rx" },
				{ value: 3, timestamp: 450, direction: "rx" }
			],
			notes: []
		},
		() => "legacy-session"
	);
	assert.deepEqual(capture.captureSessions, [
		{ id: "legacy-session", firstReceivedAt: 150, lastReceivedAt: 450 }
	]);
});

test("migrates capture notes to a chronological description without touching sequence notes", () => {
	const capture = normalizeCaptureSummaryData(
		{
			description: "Already noted",
			byteStream: [],
			notes: [
				{ id: "later", type: "capture", text: "Second observation", createdAt: 20 },
				{ id: "sequence", type: "sequence", text: "Keep this sequence", createdAt: 10 },
				{ id: "earlier", type: "capture", text: "First observation", createdAt: 5 }
			]
		},
		() => "unused"
	);
	assert.equal(capture.description, "Already noted\nFirst observation\nSecond observation");
	assert.deepEqual(capture.notes, [{ id: "sequence", type: "sequence", text: "Keep this sequence", createdAt: 10 }]);
});

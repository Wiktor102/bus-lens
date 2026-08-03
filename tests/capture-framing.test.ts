import assert from "node:assert/strict";
import test from "node:test";
import {
	frameWidth,
	hexByte,
	makeMessage,
	markerAt,
	markerBytes,
	normalizeCapture,
	normalizeSections,
	parseTime,
	rebuildPreview,
	signature,
	visibleByteEntries,
	visibleMessages,
	visiblePositionForRawByte
} from "../src/features/capture/capture-framing.ts";

function capture(values: number[], timestamps = values.map((_, index) => index)) {
	return {
		previewMode: "length",
		frameSize: 3,
		byteStream: values.map((value, index) => ({ value, timestamp: timestamps[index] })),
		messages: [],
		notes: []
	};
}

test("creates messages and parses monitor timestamps", () => {
	const message = makeMessage("0a ff 01", 1234, 7);
	assert.deepEqual(message.bytes, [0x0a, 0xff, 0x01]);
	assert.deepEqual(message.byteTimestamps, [1234, 1234, 1234]);
	assert.equal(message.sourceIndex, 7);
	assert.equal(message.hidden, false);
	assert.deepEqual(message.hiddenBytes, [false, false, false]);
	assert.match(message.id!, /^[0-9a-f-]{36}$/);

	const timestamp = parseTime("12:34:56.789");
	const date = new Date(timestamp);
	assert.equal(date.getHours(), 12);
	assert.equal(date.getMinutes(), 34);
	assert.equal(date.getSeconds(), 56);
	assert.equal(date.getMilliseconds(), 789);
});

test("frames a raw stream by message length and calculates visible width", () => {
	const current = capture([1, 2, 3, 4, 5]);
	current.frameSize = 2;
	rebuildPreview(current);

	assert.deepEqual(current.messages.map(message => message.bytes), [[1, 2], [3, 4], [5]]);
	assert.equal(frameWidth(current), 2);
});

test("frames markers at the start or end without changing marker behavior", () => {
	const values = [0x10, 0xaa, 0x55, 0x01, 0xaa, 0x55, 0x02];
	assert.deepEqual(markerBytes("AA 55"), [0xaa, 0x55]);
	assert.equal(markerAt(values.map(value => ({ value, timestamp: 0, rawPosition: 0 })), 1, [0xaa, 0x55]), true);

	const start = capture(values);
	start.previewMode = "marker";
	start.markerConfigured = true;
	start.frameMarker = "AA 55";
	start.markerPosition = "start";
	rebuildPreview(start);
	assert.deepEqual(start.messages.map(message => message.bytes), [[0xaa, 0x55, 0x01], [0xaa, 0x55, 0x02]]);

	const end = capture(values);
	end.previewMode = "marker";
	end.markerConfigured = true;
	end.frameMarker = "AA 55";
	end.markerPosition = "end";
	rebuildPreview(end);
	assert.deepEqual(end.messages.map(message => message.bytes), [[0x10, 0xaa, 0x55], [0x01, 0xaa, 0x55], [0x02]]);
});

test("splits frames at time gaps greater than or equal to the configured threshold", () => {
	const current = capture([1, 2, 3, 4], [0, 4, 9, 10]);
	current.previewMode = "time";
	current.frameTimeGap = 5;
	rebuildPreview(current);

	assert.deepEqual(current.messages.map(message => message.bytes), [[1, 2], [3, 4]]);
});

test("normalizes raw section starts and frames each section independently", () => {
	const current = capture([1, 2, 3, 4, 5, 6, 7]);
	current.previewMode = "sections";
	current.frameSections = [
		{ id: "header", start: 0, frameSize: 2 },
		{ id: "payload", start: 4, frameSize: 3 }
	];
	normalizeSections(current);
	rebuildPreview(current);

	assert.deepEqual(
		current.frameSections?.map(section => ({ id: section.id, start: section.start, frameSize: section.frameSize })),
		[
			{ id: "header", start: 0, frameSize: 2 },
			{ id: "payload", start: 4, frameSize: 3 }
		]
	);
	assert.deepEqual(current.messages.map(message => message.bytes), [[1, 2], [3, 4], [5, 6, 7]]);
	assert.deepEqual(current.messages.map(message => message.sectionId), ["header", "header", "payload"]);
});

test("omits hidden raw bytes before framing and keeps visible-byte positions explicit", () => {
	const current = capture([1, 2, 3, 4, 5]);
	current.frameSize = 2;
	current.byteStream![1].hidden = true;
	rebuildPreview(current);

	assert.deepEqual(current.messages.map(message => message.bytes), [[1, 3], [4, 5]]);
	assert.deepEqual(current.messages.map(message => message._rawPositions), [[0, 2], [3, 4]]);
	assert.equal(frameWidth(current), 2);

	const message = { bytes: [0xaa, 0xbb, 0xcc], hiddenBytes: [false, true, false] };
	assert.deepEqual(visibleByteEntries(message), [
		{ value: 0xaa, rawPosition: 0 },
		{ value: 0xcc, rawPosition: 2 }
	]);
	assert.equal(visiblePositionForRawByte(message, 1), -1);
	assert.equal(signature(message), "AA CC");

	current.messages[0].hidden = true;
	assert.deepEqual(visibleMessages(current).map(item => item.bytes), [[4, 5]]);
});

test("reuses message IDs when a raw range is rebuilt unchanged", () => {
	const current = capture([9, 8, 7, 6]);
	current.frameSize = 2;
	rebuildPreview(current);
	const firstIds = current.messages.map(message => message.id);

	rebuildPreview(current);

	assert.deepEqual(current.messages.map(message => message.id), firstIds);
});

test("normalizes legacy message-only captures without losing timestamps or hidden bytes", () => {
	const current = {
		frameSize: 2,
		messages: [
			{
				id: "legacy-message",
				timestamp: 100,
				byteTimestamps: [100, 125],
				bytes: [0x10, 0x20],
				hiddenBytes: [false, true],
				_byteStart: 0
			}
		],
		notes: [
			{ id: "capture-note", type: "capture", text: " Legacy observation ", createdAt: 1 },
			{ id: "sequence-note", type: "sequence", text: "Keep me", createdAt: 2 }
		]
	};

	normalizeCapture(current);

	assert.deepEqual(current.byteStream, [
		{ value: 0x10, timestamp: 100, hidden: false, direction: "rx" },
		{ value: 0x20, timestamp: 125, hidden: true, direction: "rx" }
	]);
	assert.equal(current.description, "Legacy observation");
	assert.deepEqual(current.notes, [{ id: "sequence-note", type: "sequence", text: "Keep me", createdAt: 2 }]);
});

test("preserves legacy signature formatting for string-valued imported bytes", () => {
	assert.equal(signature({ bytes: ["10" as unknown as number] }), "10");
});

test("formats bytes with the persisted uppercase representation", () => {
	assert.equal(hexByte(0), "00");
	assert.equal(hexByte(0xab), "AB");
});

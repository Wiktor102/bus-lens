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

	assert.equal(current.previewMode, "sections");
	assert.deepEqual(current.frameSections?.map(section => ({ start: section.start, frameSize: section.frameSize })), [
		{ start: 0, frameSize: 2 }
	]);
	assert.deepEqual(current.messages.map(message => message.bytes), [[1, 2], [3, 4], [5]]);
	assert.equal(frameWidth(current), 2);
});

test("keeps marker and time-framed legacy boundaries when migrating to sections", () => {
	const values = [0x10, 0xaa, 0x55, 0x01, 0xaa, 0x55, 0x02];
	assert.deepEqual(markerBytes("AA 55"), [0xaa, 0x55]);
	assert.equal(markerAt(values.map(value => ({ value, timestamp: 0, rawPosition: 0 })), 1, [0xaa, 0x55]), true);

	const markerCapture = {
		...capture([0xaa, 0x55, 0x01, 0xaa, 0x55, 0x02]),
		previewMode: "marker",
		markerConfigured: true,
		frameMarker: "AA 55",
		messages: [
			{ bytes: [0xaa, 0x55, 0x01], timestamp: 0, _rawPositions: [0, 1, 2] },
			{ bytes: [0xaa, 0x55, 0x02], timestamp: 3, _rawPositions: [3, 4, 5] }
		]
	};
	rebuildPreview(markerCapture);
	assert.equal(markerCapture.previewMode, "sections");
	assert.deepEqual(markerCapture.messages.map(message => message.bytes), [
		[0xaa, 0x55, 0x01],
		[0xaa, 0x55, 0x02]
	]);
	assert.deepEqual(
		markerCapture.frameSections?.map(section => ({
			start: section.start,
			framingMode: section.framingMode,
			frameMarker: section.frameMarker
		})),
		[{ start: 0, framingMode: "marker", frameMarker: "AA 55" }]
	);

	const timeCapture = {
		...capture([1, 2, 3, 4], [0, 4, 9, 10]),
		previewMode: "time",
		messages: [
			{ bytes: [1, 2], timestamp: 0, _rawPositions: [0, 1] },
			{ bytes: [3, 4], timestamp: 9, _rawPositions: [2, 3] }
		]
	};
	rebuildPreview(timeCapture);
	assert.equal(timeCapture.previewMode, "sections");
	assert.deepEqual(timeCapture.messages.map(message => message.bytes), [[1, 2], [3, 4]]);
	assert.deepEqual(timeCapture.frameSections?.map(section => ({ framingMode: section.framingMode, frameTimeGap: section.frameTimeGap })), [
		{ framingMode: "time", frameTimeGap: 5 }
	]);
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

test("frames marker START and END sections with their own marker settings", () => {
	const starts = capture([0x00, 0xaa, 0x01, 0xaa, 0x02]);
	starts.frameSections = [
		{
			id: "starts",
			start: 0,
			framingMode: "marker",
			frameMarker: "AA",
			markerPosition: "start"
		}
	];
	rebuildPreview(starts);
	assert.deepEqual(starts.messages.map(message => message.bytes), [[0xaa, 0x01], [0xaa, 0x02]]);

	const ends = capture([0x10, 0xbb, 0x20, 0xbb, 0x30]);
	ends.frameSections = [
		{
			id: "ends",
			start: 0,
			framingMode: "marker",
			frameMarker: "BB",
			markerPosition: "end"
		}
	];
	rebuildPreview(ends);
	assert.deepEqual(ends.messages.map(message => message.bytes), [[0x10, 0xbb], [0x20, 0xbb], [0x30]]);
});

test("frames time-gap sections from their own first byte", () => {
	const current = capture([1, 2, 3, 4, 5, 6], [0, 2, 10, 11, 20, 21]);
	current.frameSections = [
		{ id: "first", start: 0, framingMode: "time", frameTimeGap: 5 },
		{ id: "second", start: 4, framingMode: "time", frameTimeGap: 5 }
	];
	rebuildPreview(current);

	assert.deepEqual(current.messages.map(message => message.bytes), [[1, 2], [3, 4], [5, 6]]);
	assert.deepEqual(current.messages.map(message => message.sectionId), ["first", "first", "second"]);
});

test("does not let one section's framing affect its neighbor", () => {
	const current = capture([0xaa, 1, 0xaa, 2, 0xaa, 3, 4, 5]);
	current.frameSections = [
		{ id: "marker", start: 0, framingMode: "marker", frameMarker: "AA", markerPosition: "start" },
		{ id: "length", start: 4, framingMode: "length", frameSize: 2 }
	];
	rebuildPreview(current);

	assert.deepEqual(current.messages.map(message => message.bytes), [[0xaa, 1], [0xaa, 2], [0xaa, 3], [4, 5]]);
	assert.deepEqual(current.messages.map(message => message.sectionId), ["marker", "marker", "length", "length"]);
});

test("keeps bytes visible when a marker-start section contains no marker", () => {
	const current = capture([0xaa, 1, 2, 3]);
	current.frameSections = [
		{ id: "first", start: 0, framingMode: "marker", frameMarker: "AA", markerPosition: "start" },
		{ id: "new", start: 2, framingMode: "marker", frameMarker: "AA", markerPosition: "start" }
	];
	rebuildPreview(current);

	assert.deepEqual(current.messages.map(message => message.bytes), [[0xaa, 1], [2, 3]]);
	assert.deepEqual(current.messages.map(message => message.sectionId), ["first", "new"]);
});

test("keeps an empty marker section pending without discarding raw bytes", () => {
	const current = capture([1, 2, 3]);
	current.frameSections = [{ id: "pending", start: 0, framingMode: "marker", frameMarker: "AA" }];
	current.frameSections[0].frameMarker = "";
	rebuildPreview(current);

	assert.deepEqual(current.messages, []);
	assert.deepEqual(current.byteStream?.map(record => record.value), [1, 2, 3]);
});

test("migrates global framing into one section and defaults old PR sections to LENGTH", () => {
	const legacy = {
		...capture([0xaa, 1, 0xaa, 2]),
		previewMode: "marker",
		markerConfigured: true,
		frameMarker: "AA",
		markerPosition: "end"
	};
	normalizeCapture(legacy);
	assert.deepEqual(legacy.frameSections?.map(section => ({
		framingMode: section.framingMode,
		frameMarker: section.frameMarker,
		markerPosition: section.markerPosition
	})), [{ framingMode: "marker", frameMarker: "AA", markerPosition: "end" }]);

	const earlierPr = {
		...capture([0xaa, 1, 0xaa, 2]),
		previewMode: "marker",
		markerConfigured: true,
		frameMarker: "AA",
		frameSections: [{ id: "saved", start: 0, frameSize: 2 }]
	};
	normalizeCapture(earlierPr);
	assert.deepEqual(earlierPr.frameSections?.[0], {
		id: "saved",
		start: 0,
		framingMode: "length",
		frameSize: 2,
		frameMarker: "",
		markerPosition: "start",
		frameTimeGap: 5,
		collapseRuns: false,
		collapsed: false
	});
	rebuildPreview(earlierPr);
	assert.deepEqual(earlierPr.messages.map(message => message.bytes), [[0xaa, 1], [0xaa, 2]]);
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
	assert.equal(current.previewMode, "sections");
	assert.deepEqual(current.frameSections?.map(section => ({ start: section.start, frameSize: section.frameSize })), [
		{ start: 0, frameSize: 2 }
	]);
	assert.deepEqual(current.notes, [{ id: "sequence-note", type: "sequence", text: "Keep me", createdAt: 2 }]);
});

test("preserves legacy signature formatting for string-valued imported bytes", () => {
	assert.equal(signature({ bytes: ["10" as unknown as number] }), "10");
});

test("formats bytes with the persisted uppercase representation", () => {
	assert.equal(hexByte(0), "00");
	assert.equal(hexByte(0xab), "AB");
});

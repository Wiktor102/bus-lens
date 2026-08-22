import assert from "node:assert/strict";
import test from "node:test";
import {
	appendLivePreview,
	captureProjectionToken,
	frameWidth,
	hexByte,
	makeMessage,
	markerAlternatives,
	markerAt,
	markerBytes,
	normalizeCapture,
	normalizeSections,
	parseTime,
	rebuildPreview,
	signature,
	type Capture,
	visibleByteEntries,
	visibleMessages,
	visiblePositionForRawByte
} from "../src/features/capture/capture-framing.ts";
import { markerBytesJson, storedMarkerText } from "../src/domain/framing.ts";

function capture(values: number[], timestamps = values.map((_, index) => index)) {
	return {
		previewMode: "length",
		frameSize: 3,
		byteStream: values.map((value, index) => ({ value, timestamp: timestamps[index] })),
		messages: [],
		notes: []
	};
}

test("capture projection tokens use authoritative revisions instead of capture serialization", () => {
	const current = {
		activeFramingProfileId: "profile-1",
		dataRevision: 4,
		contentRevision: 7,
		retainedStartOffset: 12,
		messages: [{ bytes: Array.from({ length: 50_000 }, () => 0) }]
	} as Capture;
	const initial = captureProjectionToken(current);

	current.updatedAt = "metadata-only";
	current.metadataRevision = 3;
	assert.equal(captureProjectionToken(current), initial);

	current.activeFramingProfileId = "profile-2";
	assert.notEqual(captureProjectionToken(current), initial);
	current.activeFramingProfileId = "profile-1";
	current.contentRevision = 8;
	assert.notEqual(captureProjectionToken(current), initial);
});

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

test("extends length and time previews without reframing the retained prefix", () => {
	for (const [framingMode, frameTimeGap] of [["length", undefined], ["time", 5]] as const) {
		const current = {
			id: `live-${framingMode}`,
			byteStream: [1, 2].map((value, rawOffset) => ({ value, timestamp: rawOffset, rawOffset })),
			messages: [],
			notes: [],
			frameSections: [{ id: "section", start: 0, framingMode, frameSize: 3, frameTimeGap }]
		} as Capture;
		rebuildPreview(current, (() => { let id = 0; return () => `message-${++id}`; })());
		const firstMessageId = current.messages[0]?.id;
		const previousLength = current.byteStream!.length;
		current.byteStream!.push(
			{ value: 3, timestamp: 2, rawOffset: 2 },
			{ value: 4, timestamp: framingMode === "time" ? 10 : 3, rawOffset: 3 }
		);

		assert.equal(appendLivePreview(current, previousLength, () => "new-message"), true);
		assert.equal(current.messages[0]?.id, firstMessageId);
		assert.deepEqual(current.messages.map(message => message.bytes), framingMode === "length" ? [[1, 2, 3], [4]] : [[1, 2, 3], [4]]);
		assert.deepEqual(current.messages.flatMap(message => message.rawOffsets || []), [0, 1, 2, 3]);
	}
});

test("extends marker-end previews while retaining marker boundaries", () => {
	const current = {
		id: "live-marker",
		byteStream: [1, 0xaa].map((value, rawOffset) => ({ value, timestamp: rawOffset, rawOffset })),
		messages: [],
		notes: [],
		frameSections: [{ id: "section", start: 0, framingMode: "marker", frameMarker: "AA", markerPosition: "end" }]
	} as Capture;
	rebuildPreview(current, () => "first-message");
	const previousLength = current.byteStream!.length;
	current.byteStream!.push({ value: 2, timestamp: 2, rawOffset: 2 }, { value: 0xaa, timestamp: 3, rawOffset: 3 });

	assert.equal(appendLivePreview(current, previousLength, () => "second-message"), true);
	assert.deepEqual(current.messages.map(message => message.bytes), [[1, 0xaa], [2, 0xaa]]);
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

test("parses marker expressions and persists alternatives with backward-compatible JSON", () => {
	assert.deepEqual(markerAlternatives("FF|00"), [[0xff], [0x00]]);
	assert.deepEqual(markerAlternatives("AA 55|0D 0A|7E"), [[0xaa, 0x55], [0x0d, 0x0a], [0x7e]]);
	assert.deepEqual(markerAlternatives("FF||00|"), [[0xff], [0x00]]);
	assert.deepEqual(markerBytesJson("AA 55"), "[170,85]");
	assert.deepEqual(markerBytesJson("FF|00"), "[[255],[0]]");
	assert.equal(storedMarkerText("[[255],[0]]"), "FF|00");
	assert.equal(storedMarkerText("[170,85]"), "AA 55");
	assert.equal(storedMarkerText("[]"), "");
	assert.equal(storedMarkerText("not json"), "");
});

test("frames on any alternative when the marker expression uses |", () => {
	const starts = capture([0x01, 0xff, 0x02, 0x00, 0x03]);
	starts.frameSections = [
		{ id: "starts", start: 0, framingMode: "marker", frameMarker: "FF|00", markerPosition: "start" }
	];
	rebuildPreview(starts);
	assert.deepEqual(starts.messages.map(message => message.bytes), [[0xff, 0x02], [0x00, 0x03]]);

	const ends = capture([0x10, 0x00, 0x20, 0xff, 0x30]);
	ends.frameSections = [
		{ id: "ends", start: 0, framingMode: "marker", frameMarker: "FF|00", markerPosition: "end" }
	];
	rebuildPreview(ends);
	assert.deepEqual(ends.messages.map(message => message.bytes), [[0x10, 0x00], [0x20, 0xff], [0x30]]);

	const mixedLengths = capture([0xaa, 0x55, 0x01, 0x0d, 0x0a, 0x02]);
	mixedLengths.frameSections = [
		{ id: "mixed", start: 0, framingMode: "marker", frameMarker: "AA 55|0D 0A", markerPosition: "end" }
	];
	rebuildPreview(mixedLengths);
	assert.deepEqual(mixedLengths.messages.map(message => message.bytes), [[0xaa, 0x55], [0x01, 0x0d, 0x0a], [0x02]]);
});

test("extends marker-end previews framed by alternative markers", () => {
	const current = {
		id: "live-marker-alternatives",
		byteStream: [0x01, 0xff].map((value, rawOffset) => ({ value, timestamp: rawOffset, rawOffset })),
		messages: [],
		notes: [],
		frameSections: [{ id: "section", start: 0, framingMode: "marker", frameMarker: "FF|00", markerPosition: "end" }]
	} as Capture;
	rebuildPreview(current, (() => { let id = 0; return () => `message-${++id}`; })());
	const firstMessageId = current.messages[0]?.id;
	const previousLength = current.byteStream!.length;
	current.byteStream!.push(
		{ value: 0x02, timestamp: 2, rawOffset: 2 },
		{ value: 0x00, timestamp: 3, rawOffset: 3 }
	);

	assert.equal(appendLivePreview(current, previousLength, () => "new-message"), true);
	assert.equal(current.messages[0]?.id, firstMessageId);
	assert.deepEqual(current.messages.map(message => message.bytes), [[0x01, 0xff], [0x02, 0x00]]);
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

test("migrates legacy hidden bytes without searching the raw stream per framed byte", () => {
	const current = capture(Array.from({ length: 1_000 }, (_, index) => index % 256));
	current.frameSize = 2;
	rebuildPreview(current);
	current.messages[250].hiddenBytes![1] = true;

	let rawStreamSearches = 0;
	const byteStream = current.byteStream!;
	const find = byteStream.find;
	Object.defineProperty(byteStream, "find", {
		configurable: true,
		value(...args: Parameters<typeof find>) {
			rawStreamSearches += 1;
			return find.apply(this, args);
		}
	});

	normalizeCapture(current);

	assert.equal(rawStreamSearches, 0);
	assert.equal(byteStream[501].hidden, true);
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
		{ rawOffset: 0, value: 0x10, timestamp: 100, hidden: false, direction: "rx" },
		{ rawOffset: 1, value: 0x20, timestamp: 125, hidden: true, direction: "rx" }
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

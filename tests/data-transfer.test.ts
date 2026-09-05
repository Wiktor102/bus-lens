import assert from "node:assert/strict";
import test from "node:test";
import {
	createDataTransferController,
	parseCsv,
	parseDump,
	type DataTransferFile
} from "../src/features/data-transfer/data-transfer.ts";
import type { ArchiveCommands } from "../src/data/archive-data-layer.ts";
import type { AppState, SendQueueEntry } from "../src/shared/app-state.ts";
import { rebuildPreview, type Capture } from "../src/features/capture/capture-framing.ts";

const fixedNow = Date.UTC(2024, 0, 2, 12, 0, 0);

function nextIdFactory() {
	let index = 0;
	return () => `generated-${++index}`;
}

function capture(id: string, name: string): Capture {
	return {
		id,
		name,
		view: "Existing",
		params: [],
		messages: [],
		byteStream: [],
		notes: [],
		annotations: {},
		frameSize: 3
	};
}

function stateWithExistingCapture(): AppState {
	return {
		captures: [capture("existing", "Existing capture")],
		folders: [],
		activeId: "existing",
		sendHistory: [],
		sendQueue: [],
		sendSettings: { draft: "AA", delayMs: 100, baudRate: 115200 }
	};
}

test("parses multi-capture text dumps with injected IDs and clock", () => {
	const captures = parseDump(
		[
			"View: Temperature: live",
			"Speed: 9600",
			"Mode: auto",
			"01:02:03.004 -> AA 01",
			"01:02:04:005 -> BB 02",
			"----",
			"View: Status",
			"01:02:05.006 -> C2 08 5D"
		].join("\n"),
		{
			generateId: nextIdFactory(),
			now: () => fixedNow,
			nowIso: () => "2024-01-02T12:00:00.000Z"
		}
	);

	assert.equal(captures.length, 2);
	assert.deepEqual(captures.map(item => item.id), ["generated-3", "generated-5"]);
	assert.deepEqual(captures[0].params, [
		{ key: "Speed", value: "9600" },
		{ key: "Mode", value: "auto" }
	]);
	assert.equal(captures[0].view, "Temperature: live");
	assert.deepEqual(captures[0].messages?.map(message => message.bytes), [[0xaa, 0x01], [0xbb, 0x02]]);
	assert.deepEqual(captures[1].messages?.map(message => message.bytes), [[0xc2, 0x08, 0x5d]]);
	const expectedTimestamp = new Date(fixedNow);
	expectedTimestamp.setHours(1, 2, 3, 4);
	assert.equal(captures[0].messages?.[0].timestamp, expectedTimestamp.getTime());
});

test("imports a text dump through injected file, persistence, rendering, and toast seams", async () => {
	const state = stateWithExistingCapture();
	let activeId = state.activeId;
	let renders = 0;
	const messages: string[] = [];
	const controller = createDataTransferController({
		state,
		capture: () => state.captures.find(item => item.id === activeId) || state.captures[0],
		getActiveId: () => activeId,
		setActiveId: captureId => {
			activeId = captureId;
		},
		render: () => renders++,
		showToast: message => messages.push(message),
		download: () => {},
		generateId: nextIdFactory(),
		now: () => fixedNow,
		nowIso: () => "2024-01-02T12:00:00.000Z"
	});

	const file: DataTransferFile = {
		name: "monitor.txt",
		text: async () => "View: Imported\n01:02:03.004 -> C2 08 5D"
	};
	await controller.importFile(file);

	assert.equal(renders, 1);
	assert.deepEqual(messages, ["Imported monitor.txt"]);
	assert.equal(activeId, "generated-2");
	assert.equal(state.captures[0].name, "Imported · imported 1");
	assert.deepEqual(state.captures[0].messages?.map(message => message.bytes), [[0xc2, 0x08, 0x5d]]);
});

test("persists imported queue entries ahead of existing queue entries", async () => {
	const state = stateWithExistingCapture();
	state.sendQueue = [{ id: "queued-existing", bytes: [9], createdAt: 1 }];
	const savedQueue: Array<{ id?: string; position: number }> = [];
	const archiveCommands = {
		saveLegacyCapture: async () => {},
		saveFolder: async () => {},
		saveHistoryItem: async () => {},
		saveSettings: async () => {},
		persistArchiveIndex: async () => {},
		saveQueueItem: async (item: SendQueueEntry, position: number) => {
			savedQueue.push({ id: item.id, position });
		}
	} as unknown as ArchiveCommands;
	const controller = createDataTransferController({
		state,
		capture: () => state.captures[0],
		getActiveId: () => state.activeId,
		setActiveId: () => {},
		render: () => {},
		showToast: () => {},
		download: () => {},
		archiveCommands,
		generateId: nextIdFactory(),
		nowIso: () => "2024-01-02T12:00:00.000Z"
	});

	const file: DataTransferFile = {
		name: "archive.json",
		text: async () => JSON.stringify({
			app: "Bus Lens",
			captures: [{ id: "imported-capture", name: "Imported capture", view: "Imported", frameSize: 3, messages: [] }],
			sendQueue: [
				{ id: "imported-first", bytes: [170], createdAt: 5 },
				{ id: "imported-second", bytes: [187] }
			]
		})
	};
	await controller.importFile(file);

	assert.deepEqual(savedQueue, [
		{ id: "imported-first", position: 0 },
		{ id: "imported-second", position: 1 },
		{ id: "queued-existing", position: 2 }
	]);
	assert.deepEqual(state.sendQueue.map(item => item.id), ["imported-first", "imported-second", "queued-existing"]);
});

test("exports JSON through dependency injection without a browser download", () => {
	const state = stateWithExistingCapture();
	const downloads: Array<{ content: string; filename: string; type: string }> = [];
	const controller = createDataTransferController({
		state,
		capture: () => state.captures[0],
		getActiveId: () => state.activeId,
		setActiveId: () => {},
		render: () => {},
		showToast: () => {},
		download: (content, filename, type) => downloads.push({ content, filename, type }),
		nowIso: () => "2024-01-02T12:00:00.000Z"
	});

	controller.exportData("json");

	assert.equal(downloads.length, 1);
	assert.equal(downloads[0].filename, "bus-lens-archive.json");
	assert.equal(downloads[0].type, "application/json");
	const exported = JSON.parse(downloads[0].content) as {
		exportedAt: string;
		sendSettings: { draft: string };
		captures: Capture[];
	};
	assert.equal(exported.exportedAt, "2024-01-02T12:00:00.000Z");
	assert.equal(exported.sendSettings.draft, "");
	assert.equal(exported.captures[0].id, "existing");
});

test("round trips the exported CSV projection, including quoted notes and byte timestamps", async () => {
	const source: Capture = {
		id: "source",
		name: "Quoted source",
		view: "Temperature",
		params: [],
		messages: [
			{
				id: "message-1",
				timestamp: fixedNow + 1_000,
				byteTimestamps: [fixedNow + 1_000, fixedNow + 1_005, fixedNow + 1_010],
				bytes: [0xaa, 0x01, 0xbb],
				hidden: false,
				hiddenBytes: [false, true, false]
			},
			{
				id: "message-2",
				timestamp: fixedNow + 2_000,
				byteTimestamps: [fixedNow + 2_000, fixedNow + 2_005, fixedNow + 2_010, fixedNow + 2_015],
				bytes: [0xc0, 0xc1, 0xc2, 0xc3],
				hidden: true,
				hiddenBytes: [false, false, false, false]
			}
		],
		byteStream: [
			{ value: 0xaa, timestamp: fixedNow + 1_000 },
			{ value: 0x01, timestamp: fixedNow + 1_005, hidden: true },
			{ value: 0xbb, timestamp: fixedNow + 1_010 },
			{ value: 0xc0, timestamp: fixedNow + 2_000 },
			{ value: 0xc1, timestamp: fixedNow + 2_005 },
			{ value: 0xc2, timestamp: fixedNow + 2_010 },
			{ value: 0xc3, timestamp: fixedNow + 2_015 }
		],
		annotations: { "message-1": { text: 'note, with "quotes"\nand a new line' } },
		notes: [],
		frameSize: 3
	};
	const exportState = {
		captures: [source],
		folders: [],
		activeId: source.id,
		sendHistory: [],
		sendQueue: [],
		sendSettings: { draft: "", delayMs: 100, baudRate: 115200 }
	};
	const downloads: Array<{ content: string; filename: string; type: string }> = [];
	const exporter = createDataTransferController({
		state: exportState,
		capture: () => source,
		getActiveId: () => source.id,
		setActiveId: () => {},
		render: () => {},
		showToast: () => {},
		download: (content, filename, type) => downloads.push({ content, filename, type })
	});
	await exporter.exportData("csv");

	assert.equal(downloads.length, 1);
	assert.equal(downloads[0].type, "text/csv");
	const state = {
		captures: [] as Capture[],
		folders: [],
		activeId: null,
		sendHistory: [],
		sendQueue: [],
		sendSettings: { draft: "", delayMs: 100, baudRate: 115200 }
	};
	let activeId: string | null = null;
	const importer = createDataTransferController({
		state,
		capture: () => state.captures[0],
		getActiveId: () => activeId,
		setActiveId: captureId => {
			activeId = captureId || null;
		},
		render: () => {},
		showToast: () => {},
		download: () => {},
		generateId: nextIdFactory(),
		now: () => fixedNow,
		nowIso: () => "2024-01-02T12:00:00.000Z"
	});
	const file: DataTransferFile = {
		name: "quoted-source.csv",
		text: async () => downloads[0].content
	};
	await importer.importFile(file);

	assert.equal(state.captures.length, 1);
	assert.deepEqual(state.captures[0].messages?.map(message => message.bytes), [[0xaa, 0xbb], [0xc0, 0xc1, 0xc2, 0xc3]]);
	assert.deepEqual(state.captures[0].messages?.[0].byteTimestamps, [fixedNow + 1_000, fixedNow + 1_010]);
	assert.deepEqual(state.captures[0].byteStream?.map(record => [record.value, record.timestamp]), [
		[0xaa, fixedNow + 1_000],
		[0xbb, fixedNow + 1_010],
		[0xc0, fixedNow + 2_000],
		[0xc1, fixedNow + 2_005],
		[0xc2, fixedNow + 2_010],
		[0xc3, fixedNow + 2_015]
	]);
	const importedMessageId = state.captures[0].messages?.[0].id as string;
	assert.equal((state.captures[0].annotations?.[importedMessageId] as { text?: string }).text, 'note, with "quotes"\nand a new line');
	const reloaded = structuredClone(state.captures[0]);
	rebuildPreview(reloaded, nextIdFactory());
	assert.deepEqual(reloaded.messages?.map(message => message.bytes), [[0xaa, 0xbb], [0xc0, 0xc1, 0xc2, 0xc3]]);
	assert.equal(reloaded.messages?.[0].id, importedMessageId);
	assert.equal((reloaded.annotations?.[importedMessageId] as { text?: string }).text, 'note, with "quotes"\nand a new line');
});

test("rejects malformed CSV with a row-specific error", () => {
	assert.throws(
		() => parseCsv("index,timestamp,message_hex\n1,not-a-date,AA"),
		/CSV row 2 has an invalid timestamp: not-a-date/
	);
	assert.throws(
		() => parseCsv("index,timestamp,message_hex\n1,2024-01-02T12:00:00.000Z,AA\n2,\"unterminated,BB"),
		/Malformed CSV: unterminated quoted field/
	);
});

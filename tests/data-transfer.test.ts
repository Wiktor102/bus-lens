import assert from "node:assert/strict";
import test from "node:test";
import {
	createDataTransferController,
	parseDump,
	type DataTransferFile
} from "../src/features/data-transfer/data-transfer.ts";
import type { AppState } from "../src/shared/app-state.ts";
import type { Capture } from "../src/features/capture/capture-framing.ts";

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
	let saves = 0;
	let renders = 0;
	const messages: string[] = [];
	const controller = createDataTransferController({
		state,
		capture: () => state.captures.find(item => item.id === activeId) || state.captures[0],
		getActiveId: () => activeId,
		setActiveId: captureId => {
			activeId = captureId;
		},
		saveState: () => saves++,
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

	assert.equal(saves, 1);
	assert.equal(renders, 1);
	assert.deepEqual(messages, ["Imported monitor.txt"]);
	assert.equal(activeId, "generated-2");
	assert.equal(state.captures[0].name, "Imported · imported 1");
	assert.deepEqual(state.captures[0].messages?.map(message => message.bytes), [[0xc2, 0x08, 0x5d]]);
});

test("exports JSON through dependency injection without a browser download", () => {
	const state = stateWithExistingCapture();
	const downloads: Array<{ content: string; filename: string; type: string }> = [];
	const controller = createDataTransferController({
		state,
		capture: () => state.captures[0],
		getActiveId: () => state.activeId,
		setActiveId: () => {},
		saveState: () => {},
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

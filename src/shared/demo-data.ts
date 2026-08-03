import { makeMessage, parseTime, type Capture } from "../features/capture/capture-framing.ts";

export type DemoDataDependencies = {
	generateId?: () => string;
	now?: () => number;
};

const defaultGenerateId = () => crypto.randomUUID();

export function createDemoCaptures({
	generateId = defaultGenerateId,
	now = Date.now
}: DemoDataDependencies = {}): Capture[] {
	return [
		{
			id: generateId(),
			name: "Overview · Speed 1",
			view: "Overview",
			params: [
				{ key: "Speed", value: "1" },
				{ key: "Mode", value: "auto / program 1" }
			],
			createdAt: "2026-07-28T12:39:07.009Z",
			frameSize: 3,
			baudRate: 115200,
			inputFormat: "text",
			messages: [
				["12:39:07.009", "C2 08 5D"],
				["12:39:07.088", "C2 08 5D"],
				["12:39:07.182", "C2 00 5D"],
				["12:39:07.222", "C2 08 5D"],
				["12:39:07.341", "C2 08 5D"],
				["12:39:07.387", "C2 00 5D"],
				["12:39:07.481", "C2 08 5D"],
				["12:39:07.528", "C2 08 5D"],
				["12:39:07.605", "C2 00 5D"],
				["12:39:07.648", "C2 08 5D"],
				["12:39:07.747", "C2 08 5D"],
				["12:39:07.790", "C2 08 5D"],
				["12:39:08.167", "C2 00 5D"],
				["12:39:09.844", "C2 08 4D"],
				["12:49:49.917", "3B D6 FC"],
				["12:49:49.960", "C2 88 5D"],
				["12:49:50.039", "C2 80 5D"],
				["12:49:50.133", "C2 88 5D"],
				["12:49:50.177", "C2 88 4D"],
				["12:49:50.244", "C2 80 5D"]
			].map(([time, hex], i) => makeMessage(hex, parseTime(time, now), i, generateId)),
			notes: [
				{
					id: generateId(),
					type: "capture",
					text: "FC appears once immediately after returning to the Overview view; investigate as a possible screen transition marker.",
					createdAt: now()
				}
			],
			annotations: {}
		},
		{
			id: generateId(),
			name: "Speed · 1 → 2",
			view: "Speed",
			params: [
				{ key: "Speed", value: "1 → 2" },
				{ key: "Ventilation type", value: "full" }
			],
			createdAt: "2026-07-28T12:57:39.091Z",
			frameSize: 3,
			baudRate: 115200,
			inputFormat: "text",
			messages: [
				["12:57:39.091", "42 3A 9C"],
				["12:57:39.160", "42 3A DC"],
				["12:57:39.250", "4A 3A DC"],
				["12:57:39.344", "42 3A DC"],
				["12:57:39.390", "4A 3A DC"],
				["12:57:39.470", "42 3A DC"],
				["12:57:39.516", "42 E1 9C"],
				["12:57:39.628", "4A E1 9C"],
				["12:57:39.674", "42 E9 9C"],
				["12:57:39.769", "42 E1 9C"],
				["12:57:39.814", "4A E1 9C"],
				["12:57:39.894", "4A E9 9C"],
				["12:57:39.939", "4A E1 8C"],
				["12:57:40.010", "42 E9 8C"],
				["12:57:40.098", "42 E1 9C"]
			].map(([time, hex], i) => makeMessage(hex, parseTime(time, now), i, generateId)),
			notes: [],
			annotations: {}
		}
	];
}

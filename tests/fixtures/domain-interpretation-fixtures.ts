export type FixtureByte = {
	value: number;
	timestamp: number;
	direction?: "rx" | "tx";
	hidden?: boolean;
};

export type FixtureSection = {
	id: string;
	start: number;
	framingMode: "length" | "marker" | "time";
	frameSize?: number;
	frameMarker?: string;
	markerPosition?: "start" | "end";
	frameTimeGap?: number;
};

export type ExpectedFrame = {
	bytes: number[];
	rawOffsets: number[];
	sectionId: string;
	directions: string[];
	timestamps: number[];
};

export type FramingFixture = {
	name: string;
	bytes: FixtureByte[];
	sections: FixtureSection[];
	expectedFrames: ExpectedFrame[];
};

const repeatedFrames = [
	[0xaa, 0x01],
	[0xaa, 0x03],
	[0xaa, 0x01]
];

export const framingFixtures: readonly FramingFixture[] = [
	{
		name: "length frames retain partial-independent raw provenance",
		bytes: [
			{ value: 0xaa, timestamp: 0, direction: "rx" },
			{ value: 0x01, timestamp: 1, direction: "tx" },
			{ value: 0xaa, timestamp: 10, direction: "rx" },
			{ value: 0x03, timestamp: 11, direction: "tx" },
			{ value: 0xaa, timestamp: 20, direction: "rx" },
			{ value: 0x01, timestamp: 21, direction: "tx" }
		],
		sections: [{ id: "length", start: 0, framingMode: "length", frameSize: 2 }],
		expectedFrames: repeatedFrames.map((bytes, index) => ({
			bytes,
			rawOffsets: [index * 2, index * 2 + 1],
			sectionId: "length",
			directions: ["rx", "tx"],
			timestamps: [index * 10, index * 10 + 1]
		}))
	},
	{
		name: "marker start excludes preamble and retains marker provenance",
		bytes: [
			{ value: 0x99, timestamp: 0 },
			{ value: 0xaa, timestamp: 10 },
			{ value: 0x01, timestamp: 11 },
			{ value: 0xaa, timestamp: 20 },
			{ value: 0x03, timestamp: 21 },
			{ value: 0xaa, timestamp: 30 },
			{ value: 0x01, timestamp: 31 }
		],
		sections: [{ id: "start", start: 0, framingMode: "marker", frameMarker: "AA", markerPosition: "start" }],
		expectedFrames: repeatedFrames.map((bytes, index) => ({
			bytes,
			rawOffsets: [index * 2 + 1, index * 2 + 2],
			sectionId: "start",
			directions: ["rx", "rx"],
			timestamps: [index * 10 + 10, index * 10 + 11]
		}))
	},
	{
		name: "marker end includes markers and retains trailing boundaries",
		bytes: [
			{ value: 0x01, timestamp: 0 },
			{ value: 0xaa, timestamp: 1 },
			{ value: 0x03, timestamp: 10 },
			{ value: 0xaa, timestamp: 11 },
			{ value: 0x01, timestamp: 20 },
			{ value: 0xaa, timestamp: 21 }
		],
		sections: [{ id: "end", start: 0, framingMode: "marker", frameMarker: "AA", markerPosition: "end" }],
		expectedFrames: [
			{ bytes: [0x01, 0xaa], rawOffsets: [0, 1], sectionId: "end", directions: ["rx", "rx"], timestamps: [0, 1] },
			{ bytes: [0x03, 0xaa], rawOffsets: [2, 3], sectionId: "end", directions: ["rx", "rx"], timestamps: [10, 11] },
			{ bytes: [0x01, 0xaa], rawOffsets: [4, 5], sectionId: "end", directions: ["rx", "rx"], timestamps: [20, 21] }
		]
	},
	{
		name: "time framing splits at the configured inclusive gap",
		bytes: [
			{ value: 0xaa, timestamp: 0 },
			{ value: 0x01, timestamp: 1 },
			{ value: 0xaa, timestamp: 5 },
			{ value: 0x03, timestamp: 6 },
			{ value: 0xaa, timestamp: 10 },
			{ value: 0x01, timestamp: 11 }
		],
		sections: [{ id: "time", start: 0, framingMode: "time", frameTimeGap: 4 }],
		expectedFrames: repeatedFrames.map((bytes, index) => ({
			bytes,
			rawOffsets: [index * 2, index * 2 + 1],
			sectionId: "time",
			directions: ["rx", "rx"],
			timestamps: [[0, 1], [5, 6], [10, 11]][index]
		}))
	},
	{
		name: "sections isolate length and marker rules",
		bytes: [
			{ value: 0x10, timestamp: 0 },
			{ value: 0x11, timestamp: 1 },
			{ value: 0x99, timestamp: 2 },
			{ value: 0xaa, timestamp: 10 },
			{ value: 0x01, timestamp: 11 },
			{ value: 0xaa, timestamp: 20 },
			{ value: 0x03, timestamp: 21 }
		],
		sections: [
			{ id: "header", start: 0, framingMode: "length", frameSize: 2 },
			{ id: "body", start: 3, framingMode: "marker", frameMarker: "AA", markerPosition: "start" }
		],
		expectedFrames: [
			{ bytes: [0x10, 0x11], rawOffsets: [0, 1], sectionId: "header", directions: ["rx", "rx"], timestamps: [0, 1] },
			{ bytes: [0x99], rawOffsets: [2], sectionId: "header", directions: ["rx"], timestamps: [2] },
			{ bytes: [0xaa, 0x01], rawOffsets: [3, 4], sectionId: "body", directions: ["rx", "rx"], timestamps: [10, 11] },
			{ bytes: [0xaa, 0x03], rawOffsets: [5, 6], sectionId: "body", directions: ["rx", "rx"], timestamps: [20, 21] }
		]
	},
	{
		name: "hidden raw bytes preserve absolute frame offsets",
		bytes: [
			{ value: 0xaa, timestamp: 0 },
			{ value: 0xff, timestamp: 1, hidden: true },
			{ value: 0x01, timestamp: 2 },
			{ value: 0xaa, timestamp: 10 },
			{ value: 0x03, timestamp: 11 },
			{ value: 0xaa, timestamp: 20 },
			{ value: 0x01, timestamp: 21 }
		],
		sections: [{ id: "hidden", start: 0, framingMode: "length", frameSize: 2 }],
		expectedFrames: [
			{ bytes: [0xaa, 0x01], rawOffsets: [0, 2], sectionId: "hidden", directions: ["rx", "rx"], timestamps: [0, 2] },
			{ bytes: [0xaa, 0x03], rawOffsets: [3, 4], sectionId: "hidden", directions: ["rx", "rx"], timestamps: [10, 11] },
			{ bytes: [0xaa, 0x01], rawOffsets: [5, 6], sectionId: "hidden", directions: ["rx", "rx"], timestamps: [20, 21] }
		]
	},
	{
		name: "unmatched marker start keeps its section readable",
		bytes: [
			{ value: 0x10, timestamp: 0 },
			{ value: 0x11, timestamp: 1 }
		],
		sections: [{ id: "unmatched", start: 0, framingMode: "marker", frameMarker: "AA", markerPosition: "start" }],
		expectedFrames: [
			{ bytes: [0x10, 0x11], rawOffsets: [0, 1], sectionId: "unmatched", directions: ["rx", "rx"], timestamps: [0, 1] }
		]
	},
	{
		name: "empty marker remains a pending section",
		bytes: [{ value: 0x10, timestamp: 0 }],
		sections: [{ id: "pending", start: 0, framingMode: "marker", frameMarker: "", markerPosition: "start" }],
		expectedFrames: []
	}
];

export const analysisFixture = {
	name: "analysis derives signatures vocabulary bits and transitions from framed messages",
	bytes: [
		{ value: 0xaa, timestamp: 0 },
		{ value: 0x01, timestamp: 1 },
		{ value: 0xaa, timestamp: 5 },
		{ value: 0x03, timestamp: 6 },
		{ value: 0xaa, timestamp: 10 },
		{ value: 0x01, timestamp: 11 }
	] satisfies FixtureByte[],
	sections: [{ id: "analysis", start: 0, framingMode: "time", frameTimeGap: 4 }] satisfies FixtureSection[],
	expected: {
		signatures: [
			{ signature: "AA 01", count: 2, width: 100, percentage: 67 },
			{ signature: "AA 03", count: 1, width: 50, percentage: 33 }
		],
		vocabulary: [
			{ label: "BYTE 1", values: [{ value: 0xaa, hex: "AA", count: 3 }] },
			{
				label: "BYTE 2",
				values: [
					{ value: 0x01, hex: "01", count: 2 },
					{ value: 0x03, hex: "03", count: 1 }
				]
			}
		],
		bitVariance: [
			{
				label: "BYTE 1",
				cells: [
					{ bit: 7, variance: "0.00", percentage: 100 },
					{ bit: 6, variance: "0.00", percentage: 0 },
					{ bit: 5, variance: "0.00", percentage: 100 },
					{ bit: 4, variance: "0.00", percentage: 0 },
					{ bit: 3, variance: "0.00", percentage: 100 },
					{ bit: 2, variance: "0.00", percentage: 0 },
					{ bit: 1, variance: "0.00", percentage: 100 },
					{ bit: 0, variance: "0.00", percentage: 0 }
				]
			},
			{
				label: "BYTE 2",
				cells: [
					{ bit: 7, variance: "0.00", percentage: 0 },
					{ bit: 6, variance: "0.00", percentage: 0 },
					{ bit: 5, variance: "0.00", percentage: 0 },
					{ bit: 4, variance: "0.00", percentage: 0 },
					{ bit: 3, variance: "0.00", percentage: 0 },
					{ bit: 2, variance: "0.00", percentage: 0 },
					{ bit: 1, variance: "0.67", percentage: 33 },
					{ bit: 0, variance: "0.00", percentage: 100 }
				]
			}
		],
		transitions: [
			{ from: "AA 01", to: "AA 03", count: 1, diffs: 1 },
			{ from: "AA 03", to: "AA 01", count: 1, diffs: 1 }
		]
	}
} as const;

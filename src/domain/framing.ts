export type SectionFramingMode = "length" | "marker" | "time";
export type MarkerPosition = "start" | "end";

export type SectionFramingSettings = {
	framingMode: SectionFramingMode;
	frameSize: number;
	frameMarker: string;
	markerPosition: MarkerPosition;
	frameTimeGap: number;
};

export type FramingByte = Readonly<{
	value: number;
	timestamp: number;
}>;

export type SectionRangeInput = Readonly<{
	stream: readonly FramingByte[];
	start: number;
	end: number;
	settings: Readonly<SectionFramingSettings>;
}>;

export function markerBytes(value: unknown): number[] {
	return (value === undefined || value === null ? "" : String(value)).match(/[0-9a-f]{2}/gi)?.map(byte => parseInt(byte, 16)) || [];
}

/**
 * Splits a marker expression on "|" into alternative byte sequences.
 * "FF|00" frames on either 00 or FF; a plain "AA 55" is a single alternative.
 */
export function markerAlternatives(value: unknown): number[][] {
	return String(value === undefined || value === null ? "" : value)
		.split("|")
		.map(part => markerBytes(part))
		.filter(alternative => alternative.length > 0);
}

export function markerAt(stream: readonly FramingByte[], index: number, marker: readonly number[]): boolean {
	return marker.length > 0 && marker.every((value, offset) => stream[index + offset]?.value === value);
}

/**
 * Applies already-normalized per-section framing settings without accessing DOM,
 * persistence, or capture-specific state. Ranges use the caller's stream indexes.
 */
export function interpretSectionRanges({ stream, start: requestedStart, end: requestedEnd, settings }: SectionRangeInput): Array<[number, number]> {
	const start = Math.max(0, requestedStart);
	const end = Math.max(start, Math.min(stream.length, requestedEnd));
	if (start >= end) return [];

	if (settings.framingMode === "length") {
		const ranges: Array<[number, number]> = [];
		for (let offset = start; offset < end; offset += settings.frameSize) {
			ranges.push([offset, Math.min(offset + settings.frameSize, end)]);
		}
		return ranges;
	}

	if (settings.framingMode === "time") {
		const ranges: Array<[number, number]> = [];
		let frameStart = start;
		for (let index = start + 1; index < end; index++) {
			if (stream[index].timestamp - stream[index - 1].timestamp < settings.frameTimeGap) continue;
			ranges.push([frameStart, index]);
			frameStart = index;
		}
		ranges.push([frameStart, end]);
		return ranges;
	}

	const markers = markerAlternatives(settings.frameMarker);
	if (!markers.length) return [];
	const markerLengthAt = (index: number): number => {
		for (const marker of markers) {
			if (index + marker.length <= end && markerAt(stream, index, marker)) return marker.length;
		}
		return 0;
	};
	const ranges: Array<[number, number]> = [];
	if (settings.markerPosition === "end") {
		let frameStart = start;
		let foundMarker = false;
		for (let index = start; index < end; index++) {
			const markerLength = markerLengthAt(index);
			if (!markerLength) continue;
			foundMarker = true;
			const markerEnd = index + markerLength;
			ranges.push([frameStart, markerEnd]);
			frameStart = markerEnd;
			index = markerEnd - 1;
		}
		if (foundMarker && frameStart < end) ranges.push([frameStart, end]);
		return ranges;
	}

	let frameStart = -1;
	for (let index = start; index < end; index++) {
		const markerLength = markerLengthAt(index);
		if (!markerLength) continue;
		if (frameStart >= 0 && index > frameStart) ranges.push([frameStart, index]);
		frameStart = index;
		index += markerLength - 1;
	}
	if (frameStart < 0) return [[start, end]];
	if (frameStart < end) ranges.push([frameStart, end]);
	return ranges;
}

/**
 * Serializes a marker expression for persistence. A single alternative stays a
 * flat byte array for backward compatibility; several become an array of arrays.
 */
export function markerBytesJson(value: unknown): string {
	const alternatives = markerAlternatives(value);
	return JSON.stringify(alternatives.length === 1 ? alternatives[0] : alternatives);
}

/**
 * Renders stored marker JSON (flat array or array of arrays) as normalized hex
 * text, joining alternatives with "|".
 */
export function storedMarkerText(value: unknown): string {
	if (!value) return "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(value));
	} catch {
		return "";
	}
	if (!Array.isArray(parsed)) return "";
	const alternatives = parsed.every(entry => typeof entry === "number") ? [parsed] : parsed;
	return (Array.isArray(alternatives) ? alternatives : [])
		.map(alternative => (Array.isArray(alternative) ? alternative.map(Number).filter(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) : []))
		.filter(alternative => alternative.length > 0)
		.map(alternative => alternative.map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(" "))
		.join("|");
}

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

	const marker = markerBytes(settings.frameMarker);
	if (!marker.length) return [];
	const markerMatchesAt = (index: number) => index + marker.length <= end && markerAt(stream, index, marker);
	const ranges: Array<[number, number]> = [];
	if (settings.markerPosition === "end") {
		let frameStart = start;
		let foundMarker = false;
		for (let index = start; index < end; index++) {
			if (!markerMatchesAt(index)) continue;
			foundMarker = true;
			const markerEnd = index + marker.length;
			ranges.push([frameStart, markerEnd]);
			frameStart = markerEnd;
			index = markerEnd - 1;
		}
		if (foundMarker && frameStart < end) ranges.push([frameStart, end]);
		return ranges;
	}

	let frameStart = -1;
	for (let index = start; index < end; index++) {
		if (!markerMatchesAt(index)) continue;
		if (frameStart >= 0 && index > frameStart) ranges.push([frameStart, index]);
		frameStart = index;
		index += marker.length - 1;
	}
	if (frameStart < 0) return [[start, end]];
	if (frameStart < end) ranges.push([frameStart, end]);
	return ranges;
}

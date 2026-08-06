import {
	DEFAULT_FRAME_SIZE,
	frameSectionRanges,
	normalizeSectionFramingSettings,
	type Capture,
	type CaptureSection,
	type NormalizedCaptureSection,
	type PreviewByteRecord
} from "./capture-framing.ts";

export type SectionMoveAction = "byte-before" | "byte-after" | "message-before" | "message-after";

export type SectionMoveAvailability = Record<SectionMoveAction, boolean>;

type SectionState = NormalizedCaptureSection;

type FramedMessageStarts = Map<string, number[]>;

function effectiveSections(capture: Capture): SectionState[] {
	const streamLength = capture.byteStream?.length || 0;
	const sourceSections: CaptureSection[] = capture.frameSections?.length
		? capture.frameSections
		: [{ id: "section-0", start: 0, frameSize: capture.frameSize || DEFAULT_FRAME_SIZE, collapseRuns: false }];
	const maxStart = Math.max(0, streamLength - 1);

	return sourceSections
		.map((section, index) => ({
			id: String(section.id ?? `section-${index}`),
			start: Math.max(0, Math.min(maxStart, Math.trunc(Number(section.start) || 0))),
			...normalizeSectionFramingSettings(section, capture.frameSections?.length ? DEFAULT_FRAME_SIZE : capture.frameSize || DEFAULT_FRAME_SIZE),
			collapseRuns: Boolean(section.collapseRuns),
			collapsed: Boolean(section.collapsed)
		}))
		.sort((left, right) => left.start - right.start);
}

function firstVisibleIndexAtOrAfter(rawPositions: number[], rawStart: number): number {
	return rawPositions.findIndex(position => position >= rawStart);
}

function framedMessageStarts(capture: Capture, sections: SectionState[]): FramedMessageStarts {
	const stream: PreviewByteRecord[] = (capture.byteStream || [])
		.map((record, rawPosition) => ({ ...record, rawPosition }))
		.filter(record => !record.hidden);
	const rawPositions = stream.map(record => record.rawPosition);
	const starts: FramedMessageStarts = new Map();

	sections.forEach((section, sectionIndex) => {
		const compactStart = firstVisibleIndexAtOrAfter(rawPositions, section.start);
		const nextSectionStart = sections[sectionIndex + 1]?.start;
		const nextCompactStart =
			nextSectionStart === undefined ? stream.length : firstVisibleIndexAtOrAfter(rawPositions, nextSectionStart);
		const compactEnd = nextCompactStart < 0 ? stream.length : nextCompactStart;
		const sectionStarts: number[] = [];
		if (compactStart >= 0 && compactStart < compactEnd) {
			frameSectionRanges(stream, compactStart, compactEnd, section).forEach(([start]) => {
				sectionStarts.push(stream[start].rawPosition);
			});
		}
		starts.set(section.id, sectionStarts);
	});

	return starts;
}

function unavailable(): SectionMoveAvailability {
	return {
		"byte-before": false,
		"byte-after": false,
		"message-before": false,
		"message-after": false
	};
}

export function getSectionMoveTarget(
	capture: Capture,
	sectionId: string,
	action: SectionMoveAction
): number | null {
	const streamLength = capture.byteStream?.length || 0;
	if (!streamLength) return null;

	const sections = effectiveSections(capture);
	const index = sections.findIndex(section => section.id === String(sectionId));
	if (index < 0) return null;

	const section = sections[index];
	const previous = sections[index - 1];
	const next = sections[index + 1];
	const lowerBoundary = previous?.start ?? -1;
	const upperBoundary = next?.start ?? streamLength;

	switch (action) {
		case "byte-before": {
			const target = section.start - 1;
			return target > lowerBoundary ? target : null;
		}
		case "byte-after": {
			const target = section.start + 1;
			return target < upperBoundary && target < streamLength ? target : null;
		}
		case "message-before": {
			if (!previous) return null;
			const target = framedMessageStarts(capture, sections).get(previous.id)?.at(-1);
			return target !== undefined && target > previous.start && target < section.start ? target : null;
		}
		case "message-after": {
			const target = framedMessageStarts(capture, sections).get(section.id)?.[1];
			return target !== undefined && target > section.start && target < upperBoundary ? target : null;
		}
	}
}

export function getSectionMoveAvailability(capture: Capture, sectionId: string): SectionMoveAvailability {
	const actions = unavailable();
	(Object.keys(actions) as SectionMoveAction[]).forEach(action => {
		actions[action] = getSectionMoveTarget(capture, sectionId, action) !== null;
	});
	return actions;
}

export function moveSection(capture: Capture, sectionId: string, action: SectionMoveAction): boolean {
	const target = getSectionMoveTarget(capture, sectionId, action);
	if (target === null) return false;
	const section = (capture.frameSections || []).find(item => String(item.id) === String(sectionId));
	if (!section) return false;
	section.start = target;
	return true;
}

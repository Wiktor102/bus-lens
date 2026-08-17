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

export type SectionMoveTargets = Readonly<Record<SectionMoveAction, number | null>>;

export type SectionMoveMetadataEntry = Readonly<{
	targets: SectionMoveTargets;
	availability: SectionMoveAvailability;
}>;

export type SectionMoveMetadata = ReadonlyMap<string, SectionMoveMetadataEntry>;

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

/**
 * Derive every section's move target from one normalized view of the capture.
 * Message boundaries are expensive to frame, so callers rendering a capture
 * should share this metadata across all section headers.
 */
export function precomputeSectionMoveMetadata(capture: Capture): SectionMoveMetadata {
	const streamLength = capture.byteStream?.length || 0;
	const sections = effectiveSections(capture);
	const messageStarts = streamLength ? framedMessageStarts(capture, sections) : new Map<string, number[]>();
	const metadata = new Map<string, SectionMoveMetadataEntry>();

	sections.forEach((section, index) => {
		const previous = sections[index - 1];
		const next = sections[index + 1];
		const lowerBoundary = previous?.start ?? -1;
		const upperBoundary = next?.start ?? streamLength;
		const byteBefore = section.start - 1;
		const byteAfter = section.start + 1;
		const previousMessage = previous ? messageStarts.get(previous.id)?.at(-1) : undefined;
		const nextMessage = messageStarts.get(section.id)?.[1];
		const targets: SectionMoveTargets = {
			"byte-before": byteBefore > lowerBoundary ? byteBefore : null,
			"byte-after": byteAfter < upperBoundary && byteAfter < streamLength ? byteAfter : null,
			"message-before":
				previousMessage !== undefined && previousMessage > (previous?.start ?? -1) && previousMessage < section.start
					? previousMessage
					: null,
			"message-after":
				nextMessage !== undefined && nextMessage > section.start && nextMessage < upperBoundary ? nextMessage : null
		};
		metadata.set(section.id, {
			targets,
			availability: {
				"byte-before": targets["byte-before"] !== null,
				"byte-after": targets["byte-after"] !== null,
				"message-before": targets["message-before"] !== null,
				"message-after": targets["message-after"] !== null
			}
		});
	});

	return metadata;
}

export function getSectionMoveTargetFromMetadata(
	metadata: SectionMoveMetadata,
	sectionId: string,
	action: SectionMoveAction
): number | null {
	return metadata.get(String(sectionId))?.targets[action] ?? null;
}

export function getSectionMoveAvailabilityFromMetadata(
	metadata: SectionMoveMetadata,
	sectionId: string
): SectionMoveAvailability {
	return metadata.get(String(sectionId))?.availability ?? unavailable();
}

export function getSectionMoveTarget(
	capture: Capture,
	sectionId: string,
	action: SectionMoveAction
): number | null {
	return getSectionMoveTargetFromMetadata(precomputeSectionMoveMetadata(capture), sectionId, action);
}

export function getSectionMoveAvailability(capture: Capture, sectionId: string): SectionMoveAvailability {
	return getSectionMoveAvailabilityFromMetadata(precomputeSectionMoveMetadata(capture), sectionId);
}

export function moveSection(capture: Capture, sectionId: string, action: SectionMoveAction): boolean {
	const metadata = precomputeSectionMoveMetadata(capture);
	const target = getSectionMoveTargetFromMetadata(metadata, sectionId, action);
	if (target === null) return false;
	const section = (capture.frameSections || []).find(item => String(item.id) === String(sectionId));
	if (!section) return false;
	section.start = target;
	return true;
}

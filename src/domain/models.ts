export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

/** A zero-based position in the original captured byte stream; it never changes after retention trimming. */
export type RawOffset = Brand<number, "RawOffset">;
export type CaptureId = Brand<string, "CaptureId">;
export type FrameId = Brand<string, "FrameId">;
export type SectionId = Brand<string, "SectionId">;
export type NoteId = Brand<string, "NoteId">;

export type ByteDirection = "rx" | "tx";

export type RawCaptureByte = {
	offset: RawOffset;
	value: number;
	timestamp: number;
	direction: ByteDirection;
	sessionId?: string;
	hidden: boolean;
};

export type CaptureLifecycle = "recording" | "stopped" | "finalized" | "failed";

export type CaptureSession = {
	id: string;
	firstReceivedAt?: number;
	lastReceivedAt?: number;
};

export type LengthFramingRule = {
	mode: "length";
	frameLength: number;
};

export type MarkerFramingRule = {
	mode: "marker";
	marker: readonly number[];
	position: "start" | "end";
};

export type TimeFramingRule = {
	mode: "time";
	gapMs: number;
};

export type FramingRule = LengthFramingRule | MarkerFramingRule | TimeFramingRule;

export type FrameSectionModel = {
	id: SectionId;
	startOffset: RawOffset;
	rule: FramingRule;
	collapseRuns: boolean;
	collapsed: boolean;
};

export type FramingProfile = {
	algorithmVersion: number;
	sections: readonly FrameSectionModel[];
};

export type FrameModel = {
	id: FrameId;
	ordinal: number;
	sectionId: SectionId;
	rawOffsets: readonly RawOffset[];
	bytes: readonly number[];
	timestamps: readonly number[];
	directions: readonly ByteDirection[];
	hidden: boolean;
};

export type CaptureNoteTarget = {
	kind: "capture";
};

export type ByteNoteTarget = {
	kind: "byte";
	rawOffset: RawOffset;
};

export type FrameNoteTarget = {
	kind: "frame";
	profileVersion?: number;
	rawOffsets: readonly RawOffset[];
};

export type SequenceNoteTarget = {
	kind: "sequence";
	startOffset: RawOffset;
	endOffset: RawOffset;
};

export type PatternNoteTarget = {
	kind: "pattern";
	sequenceKey: string;
};

export type NoteTarget = CaptureNoteTarget | ByteNoteTarget | FrameNoteTarget | SequenceNoteTarget | PatternNoteTarget;

export type CaptureNoteModel = {
	id: NoteId;
	text: string;
	createdAt: number;
	updatedAt?: number;
	target: NoteTarget;
};

export type CaptureModel = {
	id: CaptureId;
	name: string;
	createdAt: string;
	lifecycle: CaptureLifecycle;
	byteCount: number;
	sessions: readonly CaptureSession[];
	rawBytes: readonly RawCaptureByte[];
	framing: FramingProfile;
	frames: readonly FrameModel[];
	notes: readonly CaptureNoteModel[];
};

export type SignatureStatistic = {
	signature: string;
	count: number;
};

export type VocabularyStatistic = {
	position: number;
	value: number;
	count: number;
};

export type BitStatistic = {
	position: number;
	bit: number;
	percentage: number;
	variance: string;
};

export type TransitionStatistic = {
	from: string;
	to: string;
	count: number;
	diffs: number;
};

export type RunCadence = {
	intervals: readonly number[];
	cadence: number | null;
	stable: boolean;
};

export type SequenceOccurrence = {
	start: number;
	length: number;
};

export type SequenceGroup = {
	key: string;
	signatures: readonly string[];
	score: number;
	occurrences: readonly SequenceOccurrence[];
};

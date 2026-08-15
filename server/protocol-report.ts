import type {
	AgentCaptureDifferenceInput,
	AgentCaptureDifferenceResult,
	AgentDifferentialAlignmentMode,
	AgentDifferentialCandidate,
	AgentDifferentialMessageFilters,
	AgentDifferentialScope,
	AgentDifferentialSnapshotSummary
} from "./differential-analysis.ts";
import type {
	AgentSuggestedOperation,
	AgentSnapshotReference
} from "./agent-contracts.ts";

export const AGENT_PROTOCOL_REPORT_SECTIONS = [
	"frame-families",
	"invariants",
	"variable-bits",
	"transitions",
	"sequences",
	"differential-candidates"
] as const;

export type AgentProtocolReportSection = typeof AGENT_PROTOCOL_REPORT_SECTIONS[number];
export type AgentProtocolReportDetail = "compact" | "standard";
export type AgentHiddenPolicy = "include" | "visible-only" | "hidden-only";
export type AgentEvidenceClassification = "observed" | "stable" | "variable" | "candidate" | "insufficient-evidence";

export type AgentProtocolReportScope = AgentDifferentialScope;

export type AgentProtocolReportDifferentialInput = Readonly<{
	baseline: Readonly<{
		snapshot: AgentSnapshotReference;
		label: string;
		filters?: AgentDifferentialMessageFilters;
	}>;
	changed: Readonly<{
		snapshot: AgentSnapshotReference;
		label: string;
		filters?: AgentDifferentialMessageFilters;
	}>;
	alignment: Readonly<{
		mode: AgentDifferentialAlignmentMode;
		maximumTimestampDeltaMs?: number;
	}>;
	scope?: AgentProtocolReportScope;
	minimumSupport?: number;
}>;

export type AgentProtocolReportInput = Readonly<{
	snapshot: AgentSnapshotReference;
	scope?: AgentProtocolReportScope;
	include?: readonly AgentProtocolReportSection[];
	differentialAnalysis?: AgentProtocolReportDifferentialInput;
	detail?: AgentProtocolReportDetail;
	/** The default is include, matching the existing analytical primitives. */
	hidden?: AgentHiddenPolicy;
	minimumSupport?: number;
}>;

export type AgentProtocolFrameFamily = Readonly<{
	sectionId: string;
	frameLength: number;
	signature: string;
	signatureLength?: number;
	signatureDigest?: string;
	signatureTruncated?: boolean;
	count: number;
	percentage: number;
	classification: AgentEvidenceClassification;
}>;

export type AgentProtocolInvariantByte = Readonly<{
	sectionId: string;
	frameLength: number;
	position: number;
	value: number;
	count: number;
	applicableFrameCount: number;
	classification: "stable" | "insufficient-evidence";
}>;

export type AgentProtocolInvariantBit = Readonly<{
	sectionId: string;
	frameLength: number;
	position: number;
	bit: number;
	onePercentage: number;
	applicableFrameCount: number;
	classification: "stable" | "insufficient-evidence";
}>;

export type AgentProtocolVariableByte = Readonly<{
	sectionId: string;
	frameLength: number;
	position: number;
	values: readonly Readonly<{ value: number; count: number }>[];
	applicableFrameCount: number;
	classification: "variable" | "insufficient-evidence";
}>;

export type AgentProtocolVariableBit = Readonly<{
	sectionId: string;
	frameLength: number;
	position: number;
	bit: number;
	onePercentage: number;
	applicableFrameCount: number;
	classification: "variable" | "insufficient-evidence";
}>;

export type AgentProtocolInvariantSummary = Readonly<{
	bytes: readonly AgentProtocolInvariantByte[];
	bits: readonly AgentProtocolInvariantBit[];
}>;

export type AgentProtocolVariableBitSummary = Readonly<{
	bytes: readonly AgentProtocolVariableByte[];
	bits: readonly AgentProtocolVariableBit[];
}>;

export type AgentProtocolTransition = Readonly<{
	sectionId: string;
	fromSignature: string;
	fromSignatureLength?: number;
	fromSignatureDigest?: string;
	fromSignatureTruncated?: boolean;
	toSignature: string;
	toSignatureLength?: number;
	toSignatureDigest?: string;
	toSignatureTruncated?: boolean;
	count: number;
	transitionCount: number;
	changedPositionCounts: readonly Readonly<{ position: number; changedCount: number }>[];
	changedPercentages: readonly Readonly<{ position: number; percentage: number }>[];
	changedPositions: readonly number[];
	changedPositionCount: number;
	changedPositionSetTruncated?: boolean;
	classification: "observed" | "insufficient-evidence";
}>;

export type AgentProtocolSequence = Readonly<{
	id: string;
	key: string;
	keyLength?: number;
	keyDigest?: string;
	signatures: readonly string[];
	signatureCount?: number;
	signaturesTruncated?: boolean;
	length: number;
	occurrenceCount: number;
	sections: readonly string[];
	classification: "observed" | "insufficient-evidence";
}>;

export type AgentProtocolCandidate = AgentDifferentialCandidate & Readonly<{ classification: "candidate" }>;

export type AgentProtocolEvidenceQuality = Readonly<{
	totalFrameCount: number;
	scopeMatchedFrameCount: number;
	applicableFrameCount: number;
	excludedFrameCount: number;
	hiddenExcludedFrameCount: number;
	sampledFrameCount: number;
	minimumSupport: number;
	sampleSufficiency: "sufficient" | "insufficient-evidence" | "truncated";
	hiddenPolicy: AgentHiddenPolicy;
	truncated: boolean;
	classifications: Readonly<Record<AgentEvidenceClassification, string>>;
}>;

export type AgentProtocolDifferentialSummary = Readonly<{
	baseline: AgentDifferentialSnapshotSummary;
	changed: AgentDifferentialSnapshotSummary;
	pairedFrameCount: number;
	baselineUnpairedFrameCount: number;
	changedUnpairedFrameCount: number;
	insertedFrameCount: number;
	deletedFrameCount: number;
	minimumSupport: number;
	truncated: boolean;
}>;

export type AgentProtocolReportResult = Readonly<{
	snapshot: AgentSnapshotReference;
	scope: AgentProtocolReportScope;
	detail: AgentProtocolReportDetail;
	hiddenPolicy: AgentHiddenPolicy;
	include: readonly AgentProtocolReportSection[];
	frameFamilies?: readonly AgentProtocolFrameFamily[];
	invariants?: AgentProtocolInvariantSummary;
	variableBits?: AgentProtocolVariableBitSummary;
	transitions?: readonly AgentProtocolTransition[];
	sequences?: readonly AgentProtocolSequence[];
	differentialCandidates?: readonly AgentProtocolCandidate[];
	differential?: AgentProtocolDifferentialSummary;
	evidenceQuality: AgentProtocolEvidenceQuality;
	followUpOperations: readonly AgentSuggestedOperation[];
}>;

/** The report reuses PR B's input shape, but never accepts its cursor or page limit. */
export type AgentProtocolReportDifferentialExecution = Readonly<{
	input: AgentCaptureDifferenceInput;
	result: AgentCaptureDifferenceResult;
}>;

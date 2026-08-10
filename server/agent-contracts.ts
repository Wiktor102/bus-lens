import { Buffer } from "node:buffer";

export const AGENT_CONTRACT_VERSION = 1 as const;
export const AGENT_NORMAL_RESPONSE_BYTES = 32 * 1024;
export const AGENT_HARD_RESPONSE_BYTES = 96 * 1024;

export type AgentSnapshotReference = Readonly<{
	captureId: string;
	profileId: string;
	profileVersion: number;
	sourceDataRevision: number;
}>;

export type AgentSuggestedOperation = Readonly<{
	tool: string;
	reason: string;
	arguments?: Record<string, unknown>;
}>;

export type AgentResponseMeta = Readonly<{
	contractVersion: typeof AGENT_CONTRACT_VERSION;
	snapshot?: AgentSnapshotReference;
	appliedFilters: Record<string, unknown>;
	page?: Readonly<{
		returned: number;
		nextCursor?: string;
	}>;
	truncated: boolean;
	suggestedOperations: AgentSuggestedOperation[];
}>;

export type AgentResponse<T> = Readonly<{
	data: T;
	meta: AgentResponseMeta;
}>;

export type AgentQueryErrorCode =
	| "not-found"
	| "legacy-not-canonicalized"
	| "invalid-input"
	| "invalid-cursor"
	| "snapshot-mismatch"
	| "evidence-missing"
	| "response-too-large"
	| "wildcard-too-broad"
	| "annotation-disabled";

export class AgentQueryError extends Error {
	readonly code: AgentQueryErrorCode;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(code: AgentQueryErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
		super(message);
		this.name = "AgentQueryError";
		this.code = code;
		this.details = details;
	}
}

export type AgentCursorPayload = Readonly<{
	contractVersion: typeof AGENT_CONTRACT_VERSION;
	scope: string;
	filters: unknown;
	snapshot?: AgentSnapshotReference;
	key: Readonly<Record<string, string | number | null>>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export function stableJson(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

export function encodeAgentCursor(payload: AgentCursorPayload): string {
	const json = JSON.stringify({
		contractVersion: payload.contractVersion,
		scope: payload.scope,
		filters: stableValue(payload.filters),
		snapshot: payload.snapshot,
		key: payload.key
	});
	return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeAgentCursor(cursor: string, expectedScope: string): AgentCursorPayload {
	if (typeof cursor !== "string" || cursor.length < 8 || cursor.length > 4096) {
		throw new AgentQueryError("invalid-cursor", "The pagination cursor is invalid or expired", { reason: "malformed" });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw new AgentQueryError("invalid-cursor", "The pagination cursor is invalid or expired", { reason: "malformed" });
	}
	if (!isRecord(parsed) || parsed.contractVersion !== AGENT_CONTRACT_VERSION || parsed.scope !== expectedScope || !isRecord(parsed.key)
		|| typeof parsed.key.updatedAt !== "string" || typeof parsed.key.id !== "string") {
		throw new AgentQueryError("invalid-cursor", "The pagination cursor is invalid or expired", { reason: "scope-mismatch" });
	}
	return parsed as unknown as AgentCursorPayload;
}

export function assertCursorFilters(cursor: AgentCursorPayload, filters: unknown, snapshot?: AgentSnapshotReference): void {
	if (stableJson(cursor.filters) !== stableJson(filters)) {
		throw new AgentQueryError("invalid-cursor", "The pagination cursor does not match the requested filters", { reason: "filter-mismatch" });
	}
	if (stableJson(cursor.snapshot) !== stableJson(snapshot)) {
		throw new AgentQueryError("invalid-cursor", "The pagination cursor is bound to a different snapshot", { reason: "snapshot-mismatch" });
	}
}

export function boundedLimit(value: unknown, defaultLimit: number, maximum: number, label = "limit"): number {
	if (value === undefined) return defaultLimit;
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw new AgentQueryError("invalid-input", `${label} must be a positive integer`, { label });
	}
	return Math.min(Number(value), maximum);
}

export function makeAgentResponse<T>(args: {
	data: T;
	appliedFilters: Record<string, unknown>;
	snapshot?: AgentSnapshotReference;
	returned?: number;
	nextCursor?: string;
	truncated?: boolean;
	suggestedOperations?: AgentSuggestedOperation[];
}): AgentResponse<T> {
	return {
		data: args.data,
		meta: {
			contractVersion: AGENT_CONTRACT_VERSION,
			...(args.snapshot ? { snapshot: args.snapshot } : {}),
			appliedFilters: args.appliedFilters,
			...(args.returned === undefined ? {} : {
				page: {
					returned: args.returned,
					...(args.nextCursor ? { nextCursor: args.nextCursor } : {})
				}
			}),
			truncated: Boolean(args.truncated),
			suggestedOperations: args.suggestedOperations ?? []
		}
	};
}

export function assertEncodedResponseSize(value: unknown, allowNormalOverflow = false): void {
	const encodedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
	if (encodedBytes > AGENT_HARD_RESPONSE_BYTES || (!allowNormalOverflow && encodedBytes > AGENT_NORMAL_RESPONSE_BYTES)) {
		throw new AgentQueryError(
			"response-too-large",
			"The requested evidence does not fit the bounded response; narrow the request",
			{ encodedBytes, normalLimit: AGENT_NORMAL_RESPONSE_BYTES, hardLimit: AGENT_HARD_RESPONSE_BYTES }
		);
	}
}

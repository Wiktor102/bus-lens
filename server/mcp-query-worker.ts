import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";
import {
	AgentQueryError,
	type AgentQueryErrorCode,
	type AgentResponse,
	type AgentSnapshotReference
} from "./agent-contracts.ts";
import {
	CanonicalQueryService,
	type AgentCompareCapturesInput,
	type AgentComparisonResult,
	type AgentByteStatisticsInput,
	type AgentByteStatisticsResult,
	type AgentCaptureDifferenceInput,
	type AgentCaptureDifferenceResult,
	type AgentCaptureDiscovery,
	type AgentCaptureOverview,
	type AgentMessageContext,
	type AgentMessageContextInput,
	type AgentMessageQueryInput,
	type AgentMessageQueryResult,
	type AgentRawRead,
	type AgentRawReadInput,
	type AgentSequenceGroupsInput,
	type AgentSequenceGroupsResult,
	type AgentSequenceOccurrencesInput,
	type AgentSequenceOccurrencesResult,
	type AgentTransitionsInput,
	type AgentTransitionsResult,
	type CaptureDiscoveryFiltersInput
} from "./canonical-query.ts";
import type { AgentProtocolReportInput, AgentProtocolReportResult } from "./protocol-report.ts";

export type McpQueryRequest =
	| { operation: "capture-discovery"; input: CaptureDiscoveryFiltersInput }
	| { operation: "capture-overview"; captureId: string; snapshot?: Partial<AgentSnapshotReference> }
	| { operation: "comparison"; input: AgentCompareCapturesInput }
	| { operation: "capture-difference"; input: AgentCaptureDifferenceInput }
	| { operation: "protocol-report"; input: AgentProtocolReportInput }
	| { operation: "messages"; input: AgentMessageQueryInput }
	| { operation: "message-context"; input: AgentMessageContextInput }
	| { operation: "sequence-groups"; input: AgentSequenceGroupsInput }
	| { operation: "sequence-occurrences"; input: AgentSequenceOccurrencesInput }
	| { operation: "byte-statistics"; input: AgentByteStatisticsInput }
	| { operation: "transitions"; input: AgentTransitionsInput }
	| { operation: "raw-bytes"; input: AgentRawReadInput };

export type McpQueryWorkerResponse<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: AgentQueryErrorCode; message: string; details: Readonly<Record<string, unknown>> } };

type McpQueryWorkerData = Readonly<{
	databasePath: string;
	request: McpQueryRequest;
}>;

function serializeError(error: unknown): McpQueryWorkerResponse<never> {
	if (error instanceof AgentQueryError) {
		return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
	}
	return {
		ok: false,
		error: {
			code: "invalid-input",
			message: error instanceof Error ? error.message : "MCP query worker failed",
			details: {}
		}
	};
}

if (!parentPort) throw new Error("MCP query worker requires a parent port");

const { databasePath, request } = workerData as McpQueryWorkerData;
let database: Database.Database | undefined;
try {
	// The worker opens a separate read-only connection. It deliberately does not
	// run migrations or share the service's writable connection across threads.
	database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 0 });
	const queries = new CanonicalQueryService(database);
	const value = database.transaction(():
		| AgentResponse<AgentCaptureDiscovery>
			| AgentResponse<AgentCaptureOverview>
			| AgentResponse<AgentComparisonResult>
			| AgentResponse<AgentCaptureDifferenceResult>
			| AgentResponse<AgentProtocolReportResult>
			| AgentResponse<AgentMessageQueryResult>
		| AgentResponse<AgentMessageContext>
		| AgentResponse<AgentSequenceGroupsResult>
		| AgentResponse<AgentSequenceOccurrencesResult>
		| AgentResponse<AgentByteStatisticsResult>
		| AgentResponse<AgentTransitionsResult>
		| AgentResponse<AgentRawRead> => {
		switch (request.operation) {
			case "capture-discovery":
				return queries.queryCaptureDiscovery(request.input);
			case "capture-overview":
				return queries.queryCaptureOverview(request.captureId, request.snapshot);
			case "comparison":
				return queries.compareCaptures(request.input);
			case "capture-difference":
				return queries.analyzeCaptureDifference(request.input);
			case "protocol-report":
				return queries.getProtocolReport(request.input);
			case "messages":
				return queries.queryMessages(request.input);
			case "message-context":
				return queries.getMessageContext(request.input);
			case "sequence-groups":
				return queries.getSequenceGroups(request.input);
			case "sequence-occurrences":
				return queries.getSequenceOccurrences(request.input);
			case "byte-statistics":
				return queries.getByteStatistics(request.input);
			case "transitions":
				return queries.getTransitions(request.input);
			case "raw-bytes":
				return queries.readRawBytes(request.input);
		}
	})();
	parentPort.postMessage({ ok: true, value } satisfies McpQueryWorkerResponse<typeof value>);
} catch (error) {
	parentPort.postMessage(serializeError(error));
} finally {
	database?.close();
}

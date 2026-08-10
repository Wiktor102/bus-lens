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
	type AgentCaptureDiscovery,
	type AgentCaptureOverview,
	type CaptureDiscoveryFiltersInput
} from "./canonical-query.ts";

export type McpQueryRequest =
	| { operation: "capture-discovery"; input: CaptureDiscoveryFiltersInput }
	| { operation: "capture-overview"; captureId: string; snapshot?: Partial<AgentSnapshotReference> };

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
	const value = database.transaction((): AgentResponse<AgentCaptureDiscovery> | AgentResponse<AgentCaptureOverview> => {
		if (request.operation === "capture-discovery") return queries.queryCaptureDiscovery(request.input);
		return queries.queryCaptureOverview(request.captureId, request.snapshot);
	})();
	parentPort.postMessage({ ok: true, value } satisfies McpQueryWorkerResponse<typeof value>);
} catch (error) {
	parentPort.postMessage(serializeError(error));
} finally {
	database?.close();
}

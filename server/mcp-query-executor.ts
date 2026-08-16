import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { AgentQueryError, requiredCaptureId, type AgentResponse } from "./agent-contracts.ts";
import type {
	AgentCompareCapturesInput,
	AgentComparisonResult,
	AgentByteStatisticsInput,
	AgentByteStatisticsResult,
	AgentCaptureDifferenceInput,
	AgentCaptureDifferenceResult,
	AgentCaptureDiscovery,
	AgentCaptureOverview,
	AgentFramingProfiles,
	AgentFramingProfilesInput,
	AgentMessageContext,
	AgentMessageContextInput,
	AgentMessageQueryInput,
	AgentMessageQueryResult,
	AgentNoteQueryInput,
	AgentNoteQueryResult,
	AgentRawRead,
	AgentRawReadInput,
	AgentSequenceGroupsInput,
	AgentSequenceGroupsResult,
	AgentSequenceOccurrencesInput,
	AgentSequenceOccurrencesResult,
	AgentTransitionsInput,
	AgentTransitionsResult,
	CaptureDiscoveryFiltersInput
} from "./canonical-query.ts";
import type { AgentSnapshotReference } from "./agent-contracts.ts";
import type { AgentProtocolReportInput, AgentProtocolReportResult } from "./protocol-report.ts";
import type { McpQueryRequest, McpQueryWorkerResponse } from "./mcp-query-worker.ts";

export const MCP_TOOL_TIMEOUT_MS = 5_000;
// Worker startup opens a SQLite connection and is expensive enough that one
// logical processor should remain available for service and MCP request work.
export const MCP_MAX_CONCURRENT_WORKERS = Math.max(1, availableParallelism() - 1);

const QUERY_WORKER_URL = new URL("./mcp-query-worker.ts", import.meta.url);

export type InterruptibleWorkerRunner = <T>(
	workerUrl: URL,
	workerData: unknown,
	timeoutMs: number,
	activeWorkers?: Set<Worker>
) => Promise<T>;

function terminateWorker(worker: Worker): void {
	try {
		void worker.terminate().catch(() => undefined);
	} catch {
		// The worker may already have exited between the event and termination.
	}
}

/**
 * Run work whose implementation may be synchronous in a disposable worker.
 * Terminating the worker is the cancellation boundary; a timer around a
 * synchronous call in this process cannot run until that call returns.
 */
export function runInterruptibleWorker<T>(
	workerUrl: URL,
	workerData: unknown,
	timeoutMs: number,
	activeWorkers?: Set<Worker>
): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		return Promise.reject(new RangeError("Worker timeout must be a non-negative finite number"));
	}

	let worker: Worker | undefined;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
	let rejectPromise: (reason?: unknown) => void = () => undefined;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	const cleanup = (): void => {
		if (timer !== undefined) clearTimeout(timer);
		if (!worker) return;
		activeWorkers?.delete(worker);
		worker.off("message", onMessage);
		worker.off("error", onError);
		worker.off("exit", onExit);
	};
	const finish = (callback: () => void): void => {
		if (settled) return;
		settled = true;
		cleanup();
		callback();
	};
	const onMessage = (message: T): void => {
		finish(() => resolvePromise(message));
		if (worker) terminateWorker(worker);
	};
	const onError = (error: Error): void => {
		finish(() => rejectPromise(error));
		if (worker) terminateWorker(worker);
	};
	const onExit = (code: number): void => {
		if (code === 0) {
			finish(() => rejectPromise(new Error("MCP query worker exited without returning a result")));
			return;
		}
		finish(() => rejectPromise(new Error(`MCP query worker exited with code ${code}`)));
	};

	// Arm the deadline before starting the worker. Worker construction and
	// startup are part of the request's local execution budget.
	timer = setTimeout(() => {
		finish(() => rejectPromise(executionTimeoutError(timeoutMs)));
		if (worker) terminateWorker(worker);
	}, timeoutMs);
	try {
		worker = new Worker(workerUrl, { workerData });
		activeWorkers?.add(worker);
		worker.once("message", onMessage);
		worker.once("error", onError);
		worker.once("exit", onExit);
	} catch (error) {
		finish(() => rejectPromise(error));
		if (worker) terminateWorker(worker);
	}
	return promise;
}

function isMemoryDatabasePath(databasePath: string): boolean {
	const path = databasePath.trim();
	return !path || path === ":memory:" || path.startsWith("file::memory:") || /(?:^|[?&])mode=memory(?:&|$)/.test(path);
}

function validateOptionalCaptureId<T extends { captureId?: string }>(input: T): T {
	return input.captureId === undefined ? input : { ...input, captureId: requiredCaptureId(input.captureId) };
}

function validateSnapshot<T extends { captureId: string }>(snapshot: T): T {
	return { ...snapshot, captureId: requiredCaptureId(snapshot.captureId) };
}

function validateMcpQueryRequest(request: McpQueryRequest): McpQueryRequest {
	switch (request.operation) {
		case "capture-discovery":
			return request;
		case "capture-overview":
			return {
				...request,
				captureId: requiredCaptureId(request.captureId),
				snapshot: request.snapshot?.captureId === undefined
					? request.snapshot
					: { ...request.snapshot, captureId: requiredCaptureId(request.snapshot.captureId, "snapshot.captureId") }
			};
		case "comparison":
			return {
				...request,
				input: {
					...request.input,
					left: validateSnapshot(request.input.left),
					right: validateSnapshot(request.input.right)
				}
			};
		case "capture-difference":
			return {
				...request,
				input: {
					...request.input,
					baseline: { ...request.input.baseline, snapshot: validateSnapshot(request.input.baseline.snapshot) },
					changed: { ...request.input.changed, snapshot: validateSnapshot(request.input.changed.snapshot) }
				}
			};
		case "protocol-report":
			return {
				...request,
				input: {
					...request.input,
					snapshot: validateSnapshot(request.input.snapshot),
					...(request.input.differentialAnalysis ? {
						differentialAnalysis: {
							...request.input.differentialAnalysis,
							baseline: { ...request.input.differentialAnalysis.baseline, snapshot: validateSnapshot(request.input.differentialAnalysis.baseline.snapshot) },
							changed: { ...request.input.differentialAnalysis.changed, snapshot: validateSnapshot(request.input.differentialAnalysis.changed.snapshot) }
						}
					} : {})
				}
			};
		case "messages":
			return { ...request, input: { ...request.input, captureId: requiredCaptureId(request.input.captureId) } };
		case "message-context":
			return { ...request, input: validateOptionalCaptureId(request.input) };
		case "sequence-groups":
			return { ...request, input: { ...request.input, captureId: requiredCaptureId(request.input.captureId) } };
		case "sequence-occurrences":
			return { ...request, input: validateOptionalCaptureId(request.input) };
		case "byte-statistics":
			return { ...request, input: { ...request.input, captureId: requiredCaptureId(request.input.captureId) } };
		case "transitions":
			return { ...request, input: { ...request.input, captureId: requiredCaptureId(request.input.captureId) } };
		case "raw-bytes":
			return { ...request, input: { ...request.input, captureId: requiredCaptureId(request.input.captureId) } };
	}
}

type QueuedQuery = {
	request: McpQueryRequest;
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
	queueTimer?: ReturnType<typeof setTimeout>;
	started: boolean;
	settled: boolean;
};

function executionTimeoutError(timeoutMs: number): AgentQueryError {
	return new AgentQueryError(
		"execution-timeout",
		"Tool execution exceeded the local execution limit",
		{ timeoutMs }
	);
}

/**
 * Executes canonical agent reads against a separate read-only SQLite
 * connection. The connection is created and closed inside the worker, so a
 * timed-out synchronous better-sqlite3 call can be cancelled by terminating
 * the worker without touching the service's writer connection. Requests wait
 * in a FIFO queue while the bounded worker pool is at capacity.
 */
export class McpQueryExecutor {
	private readonly activeWorkers = new Set<Worker>();
	private readonly pendingQueries: QueuedQuery[] = [];
	private readonly databasePath: string;
	private readonly timeoutMs: number;
	private readonly maxConcurrentWorkers: number;
	private readonly workerRunner: InterruptibleWorkerRunner;
	private runningWorkers = 0;
	private closed = false;

	constructor(
		databasePath: string,
		timeoutMs = MCP_TOOL_TIMEOUT_MS,
		maxConcurrentWorkers = MCP_MAX_CONCURRENT_WORKERS,
		workerRunner: InterruptibleWorkerRunner = runInterruptibleWorker
	) {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new RangeError("Worker timeout must be a non-negative finite number");
		}
		if (!Number.isSafeInteger(maxConcurrentWorkers) || maxConcurrentWorkers < 1) {
			throw new RangeError("MCP worker concurrency must be a positive integer");
		}
		this.databasePath = databasePath;
		this.timeoutMs = timeoutMs;
		this.maxConcurrentWorkers = maxConcurrentWorkers;
		this.workerRunner = workerRunner;
		if (isMemoryDatabasePath(databasePath)) {
			throw new Error("MCP analytical queries require a file-backed SQLite database for interruptible worker execution");
		}
	}

	queryCaptureDiscovery(input: CaptureDiscoveryFiltersInput = {}): Promise<AgentResponse<AgentCaptureDiscovery>> {
		return this.run({ operation: "capture-discovery", input });
	}

	queryCaptureOverview(captureId: string, snapshot?: Partial<AgentSnapshotReference>): Promise<AgentResponse<AgentCaptureOverview>> {
		return this.run({ operation: "capture-overview", captureId, snapshot });
	}

	listFramingProfiles(input: AgentFramingProfilesInput): Promise<AgentResponse<AgentFramingProfiles>> {
		return this.run<AgentResponse<AgentFramingProfiles>>({ operation: "framing-profiles", input });
	}

	compareCaptures(input: AgentCompareCapturesInput): Promise<AgentResponse<AgentComparisonResult>> {
		return this.run<AgentResponse<AgentComparisonResult>>({ operation: "comparison", input });
	}

	queryMessages(input: AgentMessageQueryInput): Promise<AgentResponse<AgentMessageQueryResult>> {
		return this.run<AgentResponse<AgentMessageQueryResult>>({ operation: "messages", input });
	}

	getMessageContext(input: AgentMessageContextInput): Promise<AgentResponse<AgentMessageContext>> {
		return this.run<AgentResponse<AgentMessageContext>>({ operation: "message-context", input });
	}

	queryNotes(input: AgentNoteQueryInput = {}): Promise<AgentResponse<AgentNoteQueryResult>> {
		return this.run<AgentResponse<AgentNoteQueryResult>>({ operation: "notes", input });
	}

	getSequenceGroups(input: AgentSequenceGroupsInput): Promise<AgentResponse<AgentSequenceGroupsResult>> {
		return this.run<AgentResponse<AgentSequenceGroupsResult>>({ operation: "sequence-groups", input });
	}

	getSequenceOccurrences(input: AgentSequenceOccurrencesInput): Promise<AgentResponse<AgentSequenceOccurrencesResult>> {
		return this.run<AgentResponse<AgentSequenceOccurrencesResult>>({ operation: "sequence-occurrences", input });
	}

	getByteStatistics(input: AgentByteStatisticsInput): Promise<AgentResponse<AgentByteStatisticsResult>> {
		return this.run<AgentResponse<AgentByteStatisticsResult>>({ operation: "byte-statistics", input });
	}

	getTransitions(input: AgentTransitionsInput): Promise<AgentResponse<AgentTransitionsResult>> {
		return this.run<AgentResponse<AgentTransitionsResult>>({ operation: "transitions", input });
	}

	analyzeCaptureDifference(input: AgentCaptureDifferenceInput): Promise<AgentResponse<AgentCaptureDifferenceResult>> {
		return this.run<AgentResponse<AgentCaptureDifferenceResult>>({ operation: "capture-difference", input });
	}

	getProtocolReport(input: AgentProtocolReportInput): Promise<AgentResponse<AgentProtocolReportResult>> {
		return this.run<AgentResponse<AgentProtocolReportResult>>({ operation: "protocol-report", input });
	}

	readRawBytes(input: AgentRawReadInput): Promise<AgentResponse<AgentRawRead>> {
		return this.run<AgentResponse<AgentRawRead>>({ operation: "raw-bytes", input });
	}

	async close(): Promise<void> {
		this.closed = true;
		const queued = this.pendingQueries.splice(0);
		for (const job of queued) {
			this.settle(job, () => job.reject(new AgentQueryError("invalid-input", "MCP query access is closed")));
		}
		const workers = [...this.activeWorkers];
		await Promise.all(workers.map(async worker => {
			try {
				await worker.terminate();
			} catch {
				// The worker may already have exited while the service was closing.
			}
		}));
	}

	private run<T>(request: McpQueryRequest): Promise<T> {
		if (this.closed) {
			return Promise.reject(new AgentQueryError("invalid-input", "MCP query access is closed"));
		}
		let validatedRequest: McpQueryRequest;
		try {
			validatedRequest = validateMcpQueryRequest(request);
		} catch (error) {
			return Promise.reject(error);
		}
		return new Promise<T>((resolve, reject) => {
			const job: QueuedQuery = {
				request: validatedRequest,
				resolve: value => resolve(value as T),
				reject,
				started: false,
				settled: false
			};
			job.queueTimer = setTimeout(() => {
				if (job.started || job.settled) return;
				const index = this.pendingQueries.indexOf(job);
				if (index >= 0) this.pendingQueries.splice(index, 1);
				this.settle(job, () => job.reject(executionTimeoutError(this.timeoutMs)));
			}, this.timeoutMs);
			this.pendingQueries.push(job);
			this.drain();
		});
	}

	private settle(job: QueuedQuery, callback: () => void): void {
		if (job.settled) return;
		job.settled = true;
		if (job.queueTimer !== undefined) clearTimeout(job.queueTimer);
		callback();
	}

	private drain(): void {
		while (!this.closed && this.runningWorkers < this.maxConcurrentWorkers && this.pendingQueries.length) {
			const job = this.pendingQueries.shift();
			if (!job || job.settled) continue;
			job.started = true;
			if (job.queueTimer !== undefined) clearTimeout(job.queueTimer);
			this.runningWorkers += 1;
			void this.execute(job);
		}
	}

	private async execute(job: QueuedQuery): Promise<void> {
		try {
			const response = await this.workerRunner<McpQueryWorkerResponse<unknown>>(
				QUERY_WORKER_URL,
				{ databasePath: this.databasePath, request: job.request },
				this.timeoutMs,
				this.activeWorkers
			);
			if (response.ok) {
				this.settle(job, () => job.resolve(response.value));
			} else {
				this.settle(job, () => job.reject(new AgentQueryError(response.error.code, response.error.message, response.error.details)));
			}
		} catch (error) {
			this.settle(job, () => job.reject(error));
		} finally {
			this.runningWorkers -= 1;
			this.drain();
		}
	}
}

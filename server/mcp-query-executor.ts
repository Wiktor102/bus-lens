import { Worker } from "node:worker_threads";
import { AgentQueryError, type AgentResponse } from "./agent-contracts.ts";
import type {
	AgentCaptureDiscovery,
	AgentCaptureOverview,
	CaptureDiscoveryFiltersInput
} from "./canonical-query.ts";
import type { AgentSnapshotReference } from "./agent-contracts.ts";
import type { McpQueryRequest, McpQueryWorkerResponse } from "./mcp-query-worker.ts";

export const MCP_TOOL_TIMEOUT_MS = 5_000;

const QUERY_WORKER_URL = new URL("./mcp-query-worker.ts", import.meta.url);

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

	let worker: Worker;
	try {
		worker = new Worker(workerUrl, { workerData });
	} catch (error) {
		return Promise.reject(error);
	}
	activeWorkers?.add(worker);

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
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
			finish(() => resolve(message));
			terminateWorker(worker);
		};
		const onError = (error: Error): void => {
			finish(() => reject(error));
			terminateWorker(worker);
		};
		const onExit = (code: number): void => {
			if (code === 0) {
				finish(() => reject(new Error("MCP query worker exited without returning a result")));
				return;
			}
			finish(() => reject(new Error(`MCP query worker exited with code ${code}`)));
		};

		worker.once("message", onMessage);
		worker.once("error", onError);
		worker.once("exit", onExit);
		timer = setTimeout(() => {
			finish(() => reject(new AgentQueryError(
				"execution-timeout",
				"Tool execution exceeded the local execution limit",
				{ timeoutMs }
			)));
			terminateWorker(worker);
		}, timeoutMs);
	});
}

function isMemoryDatabasePath(databasePath: string): boolean {
	const path = databasePath.trim();
	return !path || path === ":memory:" || path.startsWith("file::memory:") || /(?:^|[?&])mode=memory(?:&|$)/.test(path);
}

/**
 * Executes canonical agent reads against a separate read-only SQLite
 * connection. The connection is created and closed inside the worker, so a
 * timed-out synchronous better-sqlite3 call can be cancelled by terminating
 * the worker without touching the service's writer connection.
 */
export class McpQueryExecutor {
	private readonly activeWorkers = new Set<Worker>();
	private readonly databasePath: string;
	private readonly timeoutMs: number;
	private closed = false;

	constructor(databasePath: string, timeoutMs = MCP_TOOL_TIMEOUT_MS) {
		this.databasePath = databasePath;
		this.timeoutMs = timeoutMs;
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

	async close(): Promise<void> {
		this.closed = true;
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
		return runInterruptibleWorker<McpQueryWorkerResponse<T>>(
			QUERY_WORKER_URL,
			{ databasePath: this.databasePath, request },
			this.timeoutMs,
			this.activeWorkers
		).then(response => {
			if (response.ok) return response.value;
			throw new AgentQueryError(response.error.code, response.error.message, response.error.details);
		});
	}
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentQueryError } from "../server/agent-contracts.ts";
import { ArchiveRepository } from "../server/archive-repository.ts";
import { openDatabase } from "../server/database.ts";
import { McpQueryExecutor, runInterruptibleWorker, type InterruptibleWorkerRunner } from "../server/mcp-query-executor.ts";

test("a synchronous worker task is cancelled without blocking the parent event loop", async () => {
	let loopTurnRan = false;
	const task = runInterruptibleWorker<{ completed: boolean }>(
		new URL("./mcp-blocking-worker.ts", import.meta.url),
		{ delayMs: 1_000 },
		20
	);
	const loopTurn = new Promise<void>(resolve => {
		setImmediate(() => {
			loopTurnRan = true;
			resolve();
		});
	});

	await assert.rejects(task, error => {
		assert.ok(error instanceof AgentQueryError);
		assert.equal(error.code, "execution-timeout");
		assert.equal(error.details.timeoutMs, 20);
		return true;
	});
	await loopTurn;
	assert.equal(loopTurnRan, true);
});

test("canonical MCP queries use a worker-owned read-only connection and preserve query errors", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-mcp-query-test-"));
	const databasePath = join(directory, "archive.sqlite");
	const database = openDatabase(databasePath);
	const repository = new ArchiveRepository(database);
	const executor = new McpQueryExecutor(databasePath, 2_000);
	try {
		repository.putCapture("legacy", { id: "legacy", name: "Worker-visible capture", messages: [] });
		const response = await executor.queryCaptureDiscovery({});
		assert.equal(response.data.captures[0]?.id, "legacy");
		assert.equal(response.data.captures[0]?.name, "Worker-visible capture");

		await assert.rejects(executor.queryCaptureOverview("missing"), error => {
			assert.ok(error instanceof AgentQueryError);
			assert.equal(error.code, "not-found");
			return true;
		});

		await assert.rejects(executor.queryMessages({ captureId: "legacy" }), error => {
			assert.ok(error instanceof AgentQueryError);
			assert.equal(error.code, "legacy-not-canonicalized");
			return true;
		});
	} finally {
		await executor.close();
		database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("MCP query dispatch is bounded and malformed capture IDs never create workers", async () => {
	let activeWorkers = 0;
	let maximumActiveWorkers = 0;
	let workerStarts = 0;
	const runner: InterruptibleWorkerRunner = async <T>(): Promise<T> => {
		workerStarts += 1;
		activeWorkers += 1;
		maximumActiveWorkers = Math.max(maximumActiveWorkers, activeWorkers);
		await new Promise<void>(resolve => setTimeout(resolve, 10));
		activeWorkers -= 1;
		return { ok: true, value: undefined as never } as T;
	};
	const executor = new McpQueryExecutor("archive.sqlite", 1_000, 2, runner);
	try {
		await assert.rejects(executor.queryMessages({ captureId: "9c6f34ec-af81-42bd-a0a3-b1?" }), error => {
			assert.ok(error instanceof AgentQueryError);
			assert.equal(error.code, "invalid-input");
			return true;
		});
		assert.equal(workerStarts, 0);

		await Promise.all(Array.from({ length: 8 }, () => executor.queryCaptureDiscovery({})));
		assert.equal(maximumActiveWorkers, 2);
	} finally {
		await executor.close();
	}
});

test("interruptible MCP queries require a file-backed database path", () => {
	assert.throws(
		() => new McpQueryExecutor(":memory:"),
		/MCP analytical queries require a file-backed SQLite database/
	);
});

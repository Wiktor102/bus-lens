import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentQueryError } from "../server/agent-contracts.ts";
import { ArchiveRepository } from "../server/archive-repository.ts";
import { openDatabase } from "../server/database.ts";
import { McpQueryExecutor, runInterruptibleWorker } from "../server/mcp-query-executor.ts";

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
	} finally {
		await executor.close();
		database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("interruptible MCP queries require a file-backed database path", () => {
	assert.throws(
		() => new McpQueryExecutor(":memory:"),
		/MCP analytical queries require a file-backed SQLite database/
	);
});

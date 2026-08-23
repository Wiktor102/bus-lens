import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type { AgentAccessStatus } from "../src/app/mcp-access.ts";
import {
	createMcpMutationOptions,
	createMcpQueryOptions,
	mcpQueryKeys,
	type McpQuerySource
} from "../src/data/mcp-queries.ts";

function status(projectId: string, agentNotes: AgentAccessStatus["agentNotes"] = "disabled"): AgentAccessStatus {
	return {
		endpoint: "http://127.0.0.1/mcp",
		serverName: "bus-lens",
		serverVersion: "1.0.0",
		status: "running",
		supportedProtocolEras: ["2026-07-28"],
		readAccess: "available",
		agentNotes,
		recentClients: [],
		activeRequests: 0,
		project: { id: projectId, name: `Project ${projectId}` },
		recentUseWindowMs: 30_000
	};
}

function queryClient(): QueryClient {
	return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

test("MCP status uses one always-refreshed query cache entry", async () => {
	let resolveStatus!: (value: AgentAccessStatus) => void;
	const response = new Promise<AgentAccessStatus>(resolve => { resolveStatus = resolve; });
	let reads = 0;
	const options = createMcpQueryOptions({
		getStatus: () => {
			reads += 1;
			return response;
		}
	}).status();
	assert.deepEqual(options.queryKey, mcpQueryKeys.status());
	assert.equal(options.staleTime, 0);
	assert.equal(options.refetchOnWindowFocus, "always");

	const cache = queryClient();
	const first = cache.fetchQuery(options);
	const second = cache.fetchQuery(options);
	resolveStatus(status("a"));
	assert.equal(await first, await second);
	assert.equal(reads, 1);
});

test("MCP project mutations replace the shared status", async () => {
	const cache = queryClient();
	const source: McpQuerySource = {
		getStatus: async () => status("a"),
		setProject: async projectId => status(projectId),
		setAgentNotes: async () => {}
	};
	cache.setQueryData(mcpQueryKeys.status(), status("a"));
	const mutation = cache.getMutationCache().build(cache, createMcpMutationOptions(source, cache).project());
	await mutation.execute({ projectId: "b" });
	assert.equal(cache.getQueryData<AgentAccessStatus>(mcpQueryKeys.status())?.project.id, "b");
});

test("a completed notes mutation invalidates the current project instead of restoring its old target", async () => {
	let markStarted!: () => void;
	let finishNotes!: () => void;
	const started = new Promise<void>(resolve => { markStarted = resolve; });
	const mayFinish = new Promise<void>(resolve => { finishNotes = resolve; });
	const source: McpQuerySource = {
		getStatus: async () => status("b"),
		setProject: async projectId => status(projectId),
		setAgentNotes: async () => {
			markStarted();
			await mayFinish;
		}
	};
	const cache = queryClient();
	cache.setQueryData(mcpQueryKeys.status(), status("a"));
	const mutation = cache.getMutationCache().build(cache, createMcpMutationOptions(source, cache).notes());
	const pending = mutation.execute({ projectId: "a", enabled: true });
	await started;
	cache.setQueryData(mcpQueryKeys.status(), status("b"));
	finishNotes();
	await pending;

	assert.equal(cache.getQueryData<AgentAccessStatus>(mcpQueryKeys.status())?.project.id, "b");
	assert.equal(cache.getQueryState(mcpQueryKeys.status())?.isInvalidated, true);
});

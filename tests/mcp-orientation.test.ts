import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { createArchiveHttpService } from "../server/http-service.ts";
import { assertLoopbackHost } from "../server/config.ts";
import { MCP_REQUEST_LIMIT_BYTES, type McpToolRegistrar } from "../server/mcp-server.ts";

type JsonSchema = {
	properties?: Record<string, JsonSchema>;
	required?: string[];
};

async function withService(
	run: (baseUrl: string, service: ReturnType<typeof createArchiveHttpService>) => Promise<void>,
	mcpToolRegistrar?: McpToolRegistrar
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-mcp-test-"));
	const service = createArchiveHttpService({ databasePath: join(directory, "archive.sqlite"), mcpEndpoint: "http://127.0.0.1:4174/mcp", mcpToolRegistrar });
	try {
		await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
		const address = service.server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind to a port");
		await run(`http://127.0.0.1:${address.port}`, service);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function modernMeta() {
	return {
		[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
		[CLIENT_INFO_META_KEY]: { name: "orientation-test", version: "1.0" },
		[CLIENT_CAPABILITIES_META_KEY]: {}
	};
}

async function modernCall(baseUrl: string, method: string, params: Record<string, unknown>, id = 1): Promise<Response> {
	const body = { jsonrpc: "2.0", id, method, params: { ...params, _meta: modernMeta() } };
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": "2026-07-28",
		"Mcp-Method": method
	};
	if (method === "tools/call") headers["Mcp-Name"] = String(params.name ?? "");
	return fetch(`${baseUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function chunkedMcpPost(port: number, body: string): Promise<{ status: number | undefined; body: string }> {
	return await new Promise((resolve, reject) => {
		const request = httpRequest({
			host: "127.0.0.1",
			port,
			path: "/mcp",
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"transfer-encoding": "chunked"
			}
		}, response => {
			let responseBody = "";
			response.setEncoding("utf8");
			response.on("data", chunk => { responseBody += chunk; });
			response.on("end", () => resolve({ status: response.statusCode, body: responseBody }));
		});
		request.on("error", reject);
		for (let offset = 0; offset < body.length; offset += 4096) request.write(body.slice(offset, offset + 4096));
		request.end();
	});
}

test("the MCP endpoint serves modern tools with bounded structured output and guide instructions", async () => {
	await withService(async (baseUrl, service) => {
		service.repository.putCapture("legacy", { id: "legacy", name: "Legacy capture", messages: [{ id: "message", bytes: [1, 2, 3] }] });
		const response = await modernCall(baseUrl, "tools/call", { name: "list_captures", arguments: {} });
		assert.equal(response.status, 200);
		const payload = await response.json() as { result: { structuredContent: { data: { captures: Array<{ id: string; status: string }> }; meta: { contractVersion: number } }; content: Array<{ text: string }> } };
		assert.equal(payload.result.structuredContent.meta.contractVersion, 1);
		assert.equal(payload.result.structuredContent.data.captures[0]?.status, "legacy-not-canonicalized");
		assert.match(payload.result.content[0]?.text ?? "", /Found 1 capture/);

		const resourceBody = { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "buslens://guide", _meta: modernMeta() } };
		const resourceResponse = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "resources/read", "Mcp-Name": "buslens://guide" },
			body: JSON.stringify(resourceBody)
		});
		assert.equal(resourceResponse.status, 200);
		assert.match(await resourceResponse.text(), /overview-first workflow/);
	});
});

test("MCP output schemas require complete pageable metadata while allowing non-pageable responses", async () => {
	await withService(async baseUrl => {
		const response = await modernCall(baseUrl, "tools/list", {});
		assert.equal(response.status, 200);
		const payload = await response.json() as { result: { tools: Array<{ name: string; outputSchema?: JsonSchema }> } };
		const outputSchema = payload.result.tools.find(tool => tool.name === "list_captures")?.outputSchema;
		assert.ok(outputSchema);

		const metaSchema = outputSchema.properties?.meta;
		const pageSchema = metaSchema?.properties?.page;
		assert.ok(metaSchema);
		assert.ok(pageSchema);
		assert.deepEqual([...new Set(pageSchema.required)].sort(), ["effectiveLimit", "requestedLimit", "returned"]);
		assert.equal(metaSchema.required?.includes("page"), false);
	});
});

test("the same endpoint accepts the legacy initialization handshake", async () => {
	await withService(async baseUrl => {
		const response = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy-test", version: "1.0" } } })
		});
		assert.equal(response.status, 200);
		assert.match(await response.text(), /2025-11-25/);
	});
});

test("MCP rejects invalid protocol headers, origins, oversized requests, and non-loopback startup hosts", async () => {
	await withService(async baseUrl => {
		const missingHeader = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta() } })
		});
		assert.equal(missingHeader.status, 400);

		const badOrigin = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "http://not-local.test", accept: "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bad-origin" } } })
		});
		assert.equal(badOrigin.status, 403);

		const oversized = "x".repeat(256 * 1024 + 1);
		const oversizedResponse = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", "content-length": String(oversized.length) },
			body: oversized
		});
		assert.equal(oversizedResponse.status, 413);
	});
	assert.throws(() => assertLoopbackHost("0.0.0.0"), /loopback/);
});

test("MCP rejects an oversized chunked request before the adapter buffers it", async () => {
	await withService(async (_baseUrl, service) => {
		const address = service.server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind to a port");
		const body = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "chunked-oversized-test" },
				padding: "x".repeat(MCP_REQUEST_LIMIT_BYTES)
			}
		});
		assert.ok(Buffer.byteLength(body) > MCP_REQUEST_LIMIT_BYTES);
		const response = await chunkedMcpPost(address.port, body);
		assert.equal(response.status, 413);
		assert.match(response.body, /MCP request exceeds the local request limit/);
	});
});

test("agent access status reports stateless recent clients rather than connections", async () => {
	await withService(async (baseUrl, service) => {
		await modernCall(baseUrl, "tools/call", { name: "list_captures", arguments: {} });
		const response = await fetch(`${baseUrl}/api/agent-access`);
		assert.equal(response.status, 200);
		const status = await response.json() as { status: string; supportedProtocolEras: string[]; recentClients: Array<{ reportedClientName: string }> };
		assert.equal(status.status, "running");
		assert.deepEqual(status.supportedProtocolEras, ["2026-07-28", "2025-11-25"]);
		assert.equal(status.recentClients[0]?.reportedClientName, "orientation-test");
	assert.equal(service.mcpAccess.getStatus().agentNotes, "disabled");
	});
});

test("agent access records recent use when an MCP request finishes", async () => {
	let markStarted!: () => void;
	let finishRequest!: () => void;
	const started = new Promise<void>(resolve => { markStarted = resolve; });
	const mayFinish = new Promise<void>(resolve => { finishRequest = resolve; });
	const registerWaitTool: McpToolRegistrar = server => {
		server.registerTool("wait_for_test", { inputSchema: z.object({}) }, async () => {
			markStarted();
			await mayFinish;
			return { content: [{ type: "text" as const, text: "finished" }] };
		});
	};

	await withService(async (baseUrl, service) => {
		const responsePromise = modernCall(baseUrl, "tools/call", { name: "wait_for_test", arguments: {} });
		await started;
		assert.equal(service.mcpAccess.getStatus().activeRequests, 1);
		assert.equal(service.mcpAccess.getStatus().lastRequestAt, undefined);

		await delay(10);
		const completionBoundary = Date.now();
		finishRequest();
		const response = await responsePromise;
		assert.equal(response.status, 200);
		const status = service.mcpAccess.getStatus();
		assert.equal(status.activeRequests, 0);
		assert.ok(status.lastRequestAt);
		assert.ok(Date.parse(status.lastRequestAt) >= completionBoundary);
	}, registerWaitTool);
});

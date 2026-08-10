import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY
} from "@modelcontextprotocol/server";
import { createArchiveHttpService } from "../server/http-service.ts";

test("the MCP analysis tools use the same bounded query contracts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-mcp-analysis-test-"));
	const service = createArchiveHttpService({ databasePath: join(directory, "archive.sqlite"), mcpEndpoint: "http://127.0.0.1:4174/mcp" });
	try {
		service.commandService.createCapture({ captureId: "mcp-analysis-capture", framing: [{ start: 0, framingMode: "length", frameSize: 2 }], inputFormat: "binary" });
		service.commandService.startSession({ captureId: "mcp-analysis-capture", sessionId: "mcp-analysis-session" });
		const append = service.commandService.appendChunk({ captureId: "mcp-analysis-capture", sessionId: "mcp-analysis-session", requestId: "mcp-analysis-request", sequence: 0, expectedStartOffset: 0, bytes: [1, 2, 3, 4] });
		service.commandService.finalizeSession({ captureId: "mcp-analysis-capture", sessionId: "mcp-analysis-session", expectedDataRevision: append.dataRevision });
		await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
		const address = service.server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind to a port");
		const meta = {
			[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
			[CLIENT_INFO_META_KEY]: { name: "analysis-test", version: "1.0" },
			[CLIENT_CAPABILITIES_META_KEY]: {}
		};
		const method = "tools/call";
		const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": method,
				"Mcp-Name": "query_messages"
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { name: "query_messages", arguments: { captureId: "mcp-analysis-capture", limit: 1 }, _meta: meta } })
		});
		assert.equal(response.status, 200);
		const body = await response.json() as { result: { structuredContent: { data: { messages: Array<{ frameId: string }> }; meta: { snapshot: { captureId: string }; page: { returned: number } } } } };
		assert.equal(body.result.structuredContent.meta.snapshot.captureId, "mcp-analysis-capture");
		assert.equal(body.result.structuredContent.meta.page.returned, 1);
		assert.ok(body.result.structuredContent.data.messages[0]?.frameId);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

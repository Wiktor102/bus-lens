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

function modernMeta() {
	return {
		[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
		[CLIENT_INFO_META_KEY]: { name: "analysis-test", version: "1.0" },
		[CLIENT_CAPABILITIES_META_KEY]: {}
	};
}

async function modernCall(baseUrl: string, method: string, params: Record<string, unknown>, id = 1): Promise<Response> {
	return fetch(`${baseUrl}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2026-07-28",
			"Mcp-Method": method,
			...(method === "tools/call" ? { "Mcp-Name": String(params.name ?? "") } : {})
		},
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: modernMeta() } })
	});
}

type ToolCallBody = {
	result?: {
		content?: Array<{ text?: string }>;
		isError?: boolean;
		structuredContent?: { data?: { transitions?: unknown[] } };
	};
};

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

test("get_transitions publishes and enforces aggregate/refined query constraints", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-mcp-transition-schema-test-"));
	const service = createArchiveHttpService({ databasePath: join(directory, "archive.sqlite"), mcpEndpoint: "http://127.0.0.1:4174/mcp" });
	try {
		service.commandService.createCapture({ captureId: "mcp-transition-capture", framing: [{ start: 0, framingMode: "length", frameSize: 2 }], inputFormat: "binary" });
		service.commandService.startSession({ captureId: "mcp-transition-capture", sessionId: "mcp-transition-session" });
		const append = service.commandService.appendChunk({ captureId: "mcp-transition-capture", sessionId: "mcp-transition-session", requestId: "mcp-transition-request", sequence: 0, expectedStartOffset: 0, bytes: [1, 2, 3, 4] });
		service.commandService.finalizeSession({ captureId: "mcp-transition-capture", sessionId: "mcp-transition-session", expectedDataRevision: append.dataRevision });
		const frames = service.database.prepare("SELECT signature, section_id FROM materialized_frames WHERE capture_id = @captureId ORDER BY ordinal").all({ captureId: "mcp-transition-capture" }) as Array<{ signature: string; section_id: string }>;
		const sourceSignature = frames[0]?.signature;
		const destinationSignature = frames[1]?.signature;
		const sectionId = frames[0]?.section_id;
		if (!sourceSignature || !destinationSignature || !sectionId) throw new Error("transition fixture did not materialize two frames");

		await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
		const address = service.server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind to a port");
		const baseUrl = `http://127.0.0.1:${address.port}`;

		const listResponse = await modernCall(baseUrl, "tools/list", {});
		assert.equal(listResponse.status, 200);
		const listBody = await listResponse.json() as { result: { tools: Array<{ name: string; description?: string; inputSchema: { type?: string; properties?: Record<string, { enum?: unknown[]; maximum?: number }> }; outputSchema?: { type?: string; properties?: Record<string, { type?: string; properties?: Record<string, { type?: string }> }> } }> } };
		const transitionsTool = listBody.result.tools.find(tool => tool.name === "get_transitions");
		assert.ok(transitionsTool);
		assert.equal(transitionsTool.inputSchema.type, "object");
		assert.match(transitionsTool.description ?? "", /position-only and section-only/i);
		assert.deepEqual(transitionsTool.inputSchema.properties?.changedPositionMatch?.enum, ["all", "any"]);
		const differenceTool = listBody.result.tools.find(tool => tool.name === "analyze_capture_difference");
		assert.ok(differenceTool);
		assert.match(differenceTool.description ?? "", /at most 1000 filtered frames.*at most 250 filtered frames per side/i);
		assert.equal(differenceTool.outputSchema?.properties?.data?.type, "object");
		assert.equal(differenceTool.outputSchema?.properties?.data?.properties?.candidateFields?.type, "array");
		const rawTool = listBody.result.tools.find(tool => tool.name === "read_raw_bytes");
		assert.ok(rawTool);
		assert.match(rawTool.description ?? "", /4096-byte maximum.*full 96 KiB MCP response budget/i);
		assert.equal(rawTool.inputSchema.properties?.length?.maximum, 4096);

		const callTool = async (argumentsValue: Record<string, unknown>, id: number): Promise<ToolCallBody> => {
			const response = await modernCall(baseUrl, "tools/call", { name: "get_transitions", arguments: argumentsValue }, id);
			assert.equal(response.status, 200);
			return await response.json() as ToolCallBody;
		};
		const assertValidationFailure = async (argumentsValue: Record<string, unknown>, pattern: RegExp, id: number): Promise<void> => {
			const body = await callTool(argumentsValue, id);
			assert.equal(body.result?.isError, true);
			assert.match(body.result?.content?.map(item => item.text ?? "").join(" ") ?? "", pattern);
		};

		for (const [argumentsValue, id] of [
			[{ captureId: "mcp-transition-capture", changedPositions: [0] }, 2],
			[{ captureId: "mcp-transition-capture", sectionId }, 3],
			[{ captureId: "mcp-transition-capture", sectionId, sourceSignature }, 4],
			[{ captureId: "mcp-transition-capture", sectionId, destinationSignature }, 5],
			[{ captureId: "mcp-transition-capture", sectionId, sourceSignature, destinationSignature }, 6]
		] as const) {
			const body = await callTool(argumentsValue, id);
			assert.notEqual(body.result?.isError, true);
			assert.ok(body.result?.structuredContent?.data?.transitions);
		}
		await assertValidationFailure({ captureId: "mcp-transition-capture", sectionId, changedPositions: [0], changedPositionMatch: "invalid" }, /invalid/i, 7);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("get_protocol_report publishes an explicit-snapshot, non-pageable report contract", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-mcp-protocol-report-schema-test-"));
	const service = createArchiveHttpService({ databasePath: join(directory, "archive.sqlite"), mcpEndpoint: "http://127.0.0.1:4174/mcp" });
	try {
		service.commandService.createCapture({ captureId: "mcp-protocol-report-capture", framing: [{ start: 0, framingMode: "length", frameSize: 2 }], inputFormat: "binary" });
		service.commandService.startSession({ captureId: "mcp-protocol-report-capture", sessionId: "mcp-protocol-report-session" });
		const append = service.commandService.appendChunk({ captureId: "mcp-protocol-report-capture", sessionId: "mcp-protocol-report-session", requestId: "mcp-protocol-report-request", sequence: 0, expectedStartOffset: 0, bytes: [0, 1, 1, 1, 0, 1, 1, 2] });
		const finalized = service.commandService.finalizeSession({ captureId: "mcp-protocol-report-capture", sessionId: "mcp-protocol-report-session", expectedDataRevision: append.dataRevision });
		await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
		const address = service.server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind to a port");
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const listResponse = await modernCall(baseUrl, "tools/list", {});
		const listBody = await listResponse.json() as { result: { tools: Array<{ name: string; description?: string; inputSchema: { required?: string[]; properties?: Record<string, unknown> } }> } };
		const reportTool = listBody.result.tools.find(tool => tool.name === "get_protocol_report");
		assert.ok(reportTool);
		assert.match(reportTool.description ?? "", /non-pageable|explicit-snapshot/i);
		assert.ok(reportTool.inputSchema.required?.includes("snapshot"));
		assert.ok(reportTool.inputSchema.properties?.include);

		const response = await modernCall(baseUrl, "tools/call", {
			name: "get_protocol_report",
			arguments: {
				snapshot: {
					captureId: "mcp-protocol-report-capture",
					profileId: finalized.profileId,
					profileVersion: finalized.profileVersion,
					sourceDataRevision: finalized.dataRevision
				},
				include: ["frame-families", "invariants"],
				detail: "compact"
			}
		}, 11);
		assert.equal(response.status, 200);
		const body = await response.json() as { result: { structuredContent: { data: { snapshot: { profileId: string }; evidenceQuality: { applicableFrameCount: number } }; meta: { page?: unknown } } } };
		assert.equal(body.result.structuredContent.data.snapshot.profileId, finalized.profileId);
		assert.equal(body.result.structuredContent.data.evidenceQuality.applicableFrameCount, 4);
		assert.equal(body.result.structuredContent.meta.page, undefined);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

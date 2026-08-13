import assert from "node:assert/strict";
import test from "node:test";
import {
	createClaudeMcpConfig,
	createCodexMcpConfig,
	resolveMcpEndpoint
} from "../src/app/agent-config.ts";

test("generates an importable Codex config.toml entry", () => {
	assert.equal(
		createCodexMcpConfig("http://127.0.0.1:4174/mcp"),
		"[mcp_servers.bus-lens]\nurl = \"http://127.0.0.1:4174/mcp\"\n"
	);
});

test("generates an importable Claude Code .mcp.json document", () => {
	assert.equal(
		createClaudeMcpConfig("http://127.0.0.1:4174/mcp"),
		`{
  "mcpServers": {
    "bus-lens": {
      "type": "http",
      "url": "http://127.0.0.1:4174/mcp"
    }
  }
}`
	);
});

test("escapes endpoints safely in both client formats", () => {
	const endpoint = "https://example.test/mcp?query=\"quoted\"\\path\nnext";

	assert.equal(
		createCodexMcpConfig(endpoint),
		String.raw`[mcp_servers.bus-lens]
url = "https://example.test/mcp?query=\"quoted\"\\path\nnext"
`
	);
	assert.deepEqual(JSON.parse(createClaudeMcpConfig(endpoint)), {
		mcpServers: { "bus-lens": { type: "http", url: endpoint } }
	});
});

test("uses the browser origin only when the status endpoint is absent", () => {
	assert.equal(resolveMcpEndpoint(undefined, "http://localhost:4173/workbench"), "http://localhost:4173/mcp");
	assert.equal(resolveMcpEndpoint("", "http://localhost:4173"), "http://localhost:4173/mcp");
	assert.equal(resolveMcpEndpoint("  http://127.0.0.1:4174/mcp?token=a  ", "http://localhost:4173"), "http://127.0.0.1:4174/mcp?token=a");
});

export const MCP_CONFIG_SERVER_NAME = "bus-lens";

export function resolveMcpEndpoint(configuredEndpoint: string | null | undefined, origin: string): string {
	const endpoint = configuredEndpoint?.trim();
	return endpoint || new URL("/mcp", origin).toString();
}

function tomlBasicString(value: string): string {
	// JSON string escaping uses the same escapes supported by TOML basic strings.
	return JSON.stringify(value);
}

export function createCodexMcpConfig(endpoint: string): string {
	return `[mcp_servers.${MCP_CONFIG_SERVER_NAME}]\nurl = ${tomlBasicString(endpoint)}\n`;
}

export function createClaudeMcpConfig(endpoint: string): string {
	return JSON.stringify({
		mcpServers: {
			[MCP_CONFIG_SERVER_NAME]: { type: "http", url: endpoint }
		}
	}, null, 2);
}

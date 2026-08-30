import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createArchiveHttpService } from "./http-service.ts";
import { assertLoopbackHost, LOOPBACK_HOST, resolveAppPort, resolveDatabaseConfig, resolveDevPort, resolveMaxBodyBytes, resolveMcpBindHost, resolveServicePort } from "./config.ts";

const databaseConfig = resolveDatabaseConfig();
const staticDirectory = join(process.cwd(), "dist");
const production = !process.argv.includes("--dev") && existsSync(join(staticDirectory, "index.html"));
const serverOnly = process.argv.includes("--server-only");
const port = production ? resolveAppPort() : resolveServicePort();
const mcpBindHost = resolveMcpBindHost();
assertLoopbackHost(mcpBindHost);
const endpointHost = mcpBindHost.includes(":") ? `[${mcpBindHost}]` : mcpBindHost;
const service = createArchiveHttpService({ databasePath: databaseConfig.databasePath, registryPath: databaseConfig.registryPath, staticDirectory: production ? staticDirectory : undefined, maxBodyBytes: resolveMaxBodyBytes(), mcpEndpoint: `http://${endpointHost}:${port}/mcp` });

service.server.listen(port, mcpBindHost, () => {
	console.info(`Bus Lens archive database: ${databaseConfig.databasePath}`);
	console.info(`Bus Lens project registry: ${databaseConfig.registryPath}`);
	console.info(`Bus Lens service listening at http://${endpointHost}:${port}`);
});

let vite: ReturnType<typeof spawn> | undefined;
if (!production && !serverOnly) {
	const viteCli = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
	vite = spawn(process.execPath, [viteCli, "--configLoader", "runner", "--host", LOOPBACK_HOST, "--port", String(resolveDevPort())], { stdio: "inherit" });
	vite.on("exit", code => { if (code && !service.server.listening) process.exitCode = code; });
}

function shutdown(): void {
	vite?.kill();
	service.close().finally(() => process.exit());
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createArchiveHttpService } from "./http-service.ts";
import { LOOPBACK_HOST, resolveAppPort, resolveDatabaseConfig, resolveDevPort, resolveMaxBodyBytes, resolveServicePort } from "./config.ts";

const databaseConfig = resolveDatabaseConfig();
const staticDirectory = join(process.cwd(), "dist");
const production = existsSync(join(staticDirectory, "index.html"));
const port = production ? resolveAppPort() : resolveServicePort();
const service = createArchiveHttpService({ databasePath: databaseConfig.databasePath, staticDirectory: production ? staticDirectory : undefined, maxBodyBytes: resolveMaxBodyBytes() });

service.server.listen(port, LOOPBACK_HOST, () => {
	console.info(`Bus Lens archive database: ${databaseConfig.databasePath}`);
	console.info(`Bus Lens service listening at http://${LOOPBACK_HOST}:${port}`);
});

let vite: ReturnType<typeof spawn> | undefined;
if (!production) {
	vite = spawn("pnpm", ["exec", "vite", "--configLoader", "runner", "--host", LOOPBACK_HOST, "--port", String(resolveDevPort())], { stdio: "inherit", shell: process.platform === "win32" });
	vite.on("exit", code => { if (code && !service.server.listening) process.exitCode = code; });
}

function shutdown(): void {
	vite?.kill();
	service.close().finally(() => process.exit());
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

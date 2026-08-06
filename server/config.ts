import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_APP_PORT = 4173;
export const DEFAULT_SERVICE_PORT = 4174;
export const DEFAULT_MAX_BODY_BYTES = 128 * 1024 * 1024;

export type Environment = Record<string, string | undefined>;

export type DatabasePathOptions = {
	environment?: Environment;
	platform?: NodeJS.Platform;
	homeDirectory?: string;
};

export type DatabaseConfig = {
	databasePath: string;
	dataDirectory: string;
};

function validPort(value: string | undefined, fallback: number): number {
	const port = Number(value);
	return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : fallback;
}

export function resolveAppDataDirectory(options: DatabasePathOptions = {}): string {
	const environment = options.environment ?? process.env;
	const platform = options.platform ?? process.platform;
	const homeDirectory = options.homeDirectory ?? environment.HOME ?? homedir();

	if (environment.BUS_LENS_DATA_DIR) return resolve(environment.BUS_LENS_DATA_DIR);

	if (platform === "win32") {
		return join(environment.APPDATA ?? join(homeDirectory, "AppData", "Roaming"), "Bus Lens");
	}
	if (platform === "darwin") {
		return join(homeDirectory, "Library", "Application Support", "Bus Lens");
	}
	return join(environment.XDG_DATA_HOME ?? join(homeDirectory, ".local", "share"), "bus-lens");
}

export function resolveDatabaseConfig(options: DatabasePathOptions = {}): DatabaseConfig {
	const environment = options.environment ?? process.env;
	const dataDirectory = resolveAppDataDirectory(options);
	const configuredPath = environment.BUS_LENS_DB_PATH ?? environment.BUS_LENS_DATABASE_PATH;
	const databasePath = configuredPath ? resolve(configuredPath) : join(dataDirectory, "bus-lens.sqlite");
	return {
		databasePath,
		dataDirectory: dirname(databasePath)
	};
}

export function resolveAppPort(environment: Environment = process.env): number {
	return validPort(environment.BUS_LENS_PORT, DEFAULT_APP_PORT);
}

export function resolveServicePort(environment: Environment = process.env): number {
	return validPort(environment.BUS_LENS_SERVICE_PORT, DEFAULT_SERVICE_PORT);
}

export function resolveDevPort(environment: Environment = process.env): number {
	return validPort(environment.BUS_LENS_DEV_PORT, DEFAULT_APP_PORT);
}

export function resolveMaxBodyBytes(environment: Environment = process.env): number {
	const configured = Number(environment.BUS_LENS_MAX_BODY_BYTES);
	return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_BODY_BYTES;
}

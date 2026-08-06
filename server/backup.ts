import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SqliteDatabase } from "./database.ts";
import { openDatabase } from "./database.ts";

export type DatabaseBackupResult = {
	destinationPath: string;
	totalPages: number;
};

/**
 * Creates a consistent SQLite backup, including data that is currently in the
 * source database's WAL. The SQLite backup API is preferable to copying the
 * main file and its sidecars independently.
 */
export async function backupDatabase(
	database: SqliteDatabase,
	destinationPath: string
): Promise<DatabaseBackupResult> {
	const resolvedDestination = resolve(destinationPath);
	await mkdir(dirname(resolvedDestination), { recursive: true });
	const metadata = await database.backup(resolvedDestination);
	return { destinationPath: resolvedDestination, totalPages: metadata.totalPages };
}

/**
 * Restores a database by asking SQLite to produce a clean copy of the backup.
 * The destination is intentionally explicit; callers should never point this
 * at the live database without first stopping the service.
 */
export async function restoreDatabase(backupPath: string, destinationPath: string): Promise<void> {
	const source = openDatabase(resolve(backupPath));
	try {
		await mkdir(dirname(resolve(destinationPath)), { recursive: true });
		await source.backup(resolve(destinationPath));
	} finally {
		source.close();
	}
}

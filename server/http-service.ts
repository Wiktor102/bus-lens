import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { backupDatabase, restoreDatabase } from "./backup.ts";
import {
	ArchiveRepository,
	RepositoryConflictError,
	RepositoryValidationError,
	type LegacyArchive,
	type ArchiveIndex,
	type JsonDocument
} from "./archive-repository.ts";
import { openDatabase, type SqliteDatabase } from "./database.ts";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MIME_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": JSON_CONTENT_TYPE,
	".svg": "image/svg+xml",
	".woff2": "font/woff2"
};

type Entity = "captures" | "folders" | "queue" | "history";
type ServiceOptions = {
	databasePath: string;
	staticDirectory?: string;
	maxBodyBytes?: number;
};

export type ArchiveHttpService = {
	server: Server;
	repository: ArchiveRepository;
	database: SqliteDatabase;
	close: () => Promise<void>;
};

function send(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": JSON_CONTENT_TYPE, "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

async function jsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.from(chunk);
		size += buffer.length;
		if (size > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes`);
		chunks.push(buffer);
	}
	if (!chunks.length) return undefined;
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function documentFrom(value: unknown): JsonDocument {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new RepositoryValidationError("Document must be an object");
	return value as JsonDocument;
}

function expectedVersion(request: IncomingMessage): number | undefined {
	const value = request.headers["if-match"];
	if (!value || Array.isArray(value)) return undefined;
	const parsed = Number(value.replaceAll('"', ""));
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function entityRecord(repository: ArchiveRepository, entity: Entity, id: string) {
	if (entity === "captures") return repository.getCapture(id);
	if (entity === "folders") return repository.getFolder(id);
	if (entity === "queue") return repository.getQueueItem(id);
	return repository.getHistoryItem(id);
}

function entityList(repository: ArchiveRepository, entity: Entity) {
	if (entity === "captures") return repository.listCaptures();
	if (entity === "folders") return repository.listFolders();
	if (entity === "queue") return repository.listQueue();
	return repository.listHistory();
}

function entityPut(repository: ArchiveRepository, entity: Entity, id: string, document: JsonDocument, version?: number) {
	if (entity === "captures") return repository.putCapture(id, document, version);
	if (entity === "folders") return repository.putFolder(id, document, version);
	if (entity === "queue") return repository.putQueueItem(id, document, version);
	return repository.putHistoryItem(id, document, version);
}

function entityDelete(repository: ArchiveRepository, entity: Entity, id: string): boolean {
	if (entity === "captures") return repository.deleteCapture(id);
	if (entity === "folders") return repository.deleteFolder(id);
	if (entity === "queue") return repository.deleteQueueItem(id);
	return repository.deleteHistoryItem(id);
}

async function serveStatic(response: ServerResponse, staticDirectory: string, path: string): Promise<boolean> {
	const requested = path === "/" ? "index.html" : path.slice(1);
	const candidate = resolve(staticDirectory, requested);
	if (!candidate.startsWith(`${resolve(staticDirectory)}/`) && candidate !== resolve(staticDirectory)) return false;
	const fallback = join(staticDirectory, "index.html");
	const file = existsSync(candidate) && (await stat(candidate)).isFile() ? candidate : fallback;
	if (!existsSync(file)) return false;
	response.writeHead(200, { "content-type": MIME_TYPES[extname(file)] ?? "application/octet-stream" });
	createReadStream(file).pipe(response);
	return true;
}

export function createArchiveHttpService(options: ServiceOptions): ArchiveHttpService {
	const database = openDatabase(options.databasePath);
	const repository = new ArchiveRepository(database);
	const staticDirectory = options.staticDirectory ? resolve(options.staticDirectory) : undefined;
	const maxBodyBytes = options.maxBodyBytes ?? 128 * 1024 * 1024;
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
			if (segments[0] !== "api") {
				if (staticDirectory && await serveStatic(response, staticDirectory, url.pathname)) return;
				return send(response, 404, { error: "Not found" });
			}
			if (request.method === "GET" && url.pathname === "/api/health") return send(response, 200, { ok: true });
			if (request.method === "GET" && url.pathname === "/api/archive") {
				return send(response, 200, { captures: repository.listCaptures(), folders: repository.listFolders(), index: repository.getArchiveIndex(), queue: repository.listQueue(), history: repository.listHistory(), settings: repository.getSettings() });
			}
			if (segments[1] === "archive-index") {
				if (request.method === "GET") return send(response, 200, repository.getArchiveIndex());
				if (request.method === "PUT") {
					repository.replaceArchiveIndex((await jsonBody(request, maxBodyBytes)) as ArchiveIndex);
					return send(response, 200, repository.getArchiveIndex());
				}
			}
			if (segments[1] === "migrations" && segments[2] === "local-storage") {
				if (request.method === "POST") {
					const body = documentFrom(await jsonBody(request, maxBodyBytes));
					const archive = documentFrom(body.archive) as unknown as LegacyArchive;
					if (!Array.isArray(archive.captures) || !Array.isArray(archive.folders)) throw new RepositoryValidationError("Legacy archive is invalid");
					return send(response, 201, repository.migrateLegacyArchive(String(body.fingerprint ?? ""), archive, body.report));
				}
			}
			// Canonicalization is an explicit admin/background operation. Startup and
			// ordinary legacy-capture saves deliberately do not invoke these routes.
			if (segments[1] === "migrations" && segments[2] === "canonical") {
				if (request.method === "POST") {
					const results = repository.convertAllCaptures();
					return send(response, 200, { results, verified: results.every(r => r.verified) });
				}
				if (request.method === "GET") {
					const captures = repository.listCaptures();
					const converted = captures.filter(c => repository.isCaptureConverted(String(c.id))).length;
					return send(response, 200, { total: captures.length, converted, unconverted: captures.length - converted, backups: repository.listCaptureBackups() });
				}
			}
			if (segments[1] === "captures" && segments[2] && segments[3] === "convert" && request.method === "POST") {
				const captureId = segments[2];
				const result = repository.convertCaptureToCanonical(captureId);
				return send(response, result.verified ? 200 : 422, result);
			}
			if (segments[1] === "captures" && segments[2] && segments[3] === "reframe" && request.method === "POST") {
				const captureId = segments[2];
				const body = documentFrom(await jsonBody(request, maxBodyBytes)) as { sections: Array<Record<string, unknown>> };
				if (!Array.isArray(body.sections)) throw new RepositoryValidationError("sections array is required");
				// Atomic reframing: materialize new revision completely before activating
				const revision = repository.createFramingRevision(captureId, body.sections as Array<{ id?: string; start: number; framingMode: string; frameSize?: number; frameMarker?: string; markerPosition?: string; frameTimeGap?: number; collapseRuns?: boolean; collapsed?: boolean }>);
				return send(response, 200, revision);
			}
			if (segments[1] === "captures" && segments[2] && segments[3] === "profiles" && request.method === "GET") {
				const captureId = segments[2];
				return send(response, 200, repository.listFramingProfiles(captureId));
			}
			if (segments[1] === "captures" && segments[2] && segments[3] === "analysis" && request.method === "GET") {
				const captureId = segments[2];
				const active = repository.getActiveFramingProfile(captureId);
				if (!active) return send(response, 404, { error: "no active framing profile" });
				return send(response, 200, {
					profile: active,
					signatures: repository.getFrameSignatures(active.id),
					transitions: repository.getFrameTransitions(active.id),
					byteStatistics: repository.getByteStatistics(active.id),
					bitStatistics: repository.getBitStatistics(active.id),
					sequenceGroups: repository.getSequenceGroups(active.id).map(g => ({
						...g,
						occurrences: repository.getSequenceOccurrences(g.id)
					}))
				});
			}
			if (segments[1] === "captures" && segments[2] && segments[3] === "notes" && request.method === "GET") {
				return send(response, 200, repository.getStableNotes(segments[2]));
			}
			if (segments[1] === "captures" && segments[2] && segments[3] === "backup" && request.method === "GET") {
				const backup = repository.getCaptureBackup(segments[2]);
				return backup ? send(response, 200, backup) : send(response, 404, { error: "no backup" });
			}
			if (segments[1] === "captures" && segments[2] && segments[3] === "finalization" && request.method === "GET") {
				return send(response, 200, repository.getFinalizationJobs(segments[2]));
			}
			if (segments[1] === "settings") {
				const key = segments[2];
				if (!key && request.method === "GET") return send(response, 200, repository.getSettings());
				if (key && request.method === "GET") {
					const value = repository.getSetting(key);
					return value === undefined ? send(response, 404, { error: "Not found" }) : send(response, 200, { key, value });
				}
				if (key && request.method === "PUT") {
					repository.setSetting(key, (await jsonBody(request, maxBodyBytes)));
					return send(response, 200, { key, value: repository.getSetting(key) });
				}
				if (key && request.method === "DELETE") return send(response, repository.deleteSetting(key) ? 204 : 404, {});
			}
			if (segments[1] === "backup" && request.method === "POST") {
				const { destinationPath } = documentFrom(await jsonBody(request, maxBodyBytes));
				return send(response, 201, await backupDatabase(database, String(destinationPath)));
			}
			if (segments[1] === "restore" && request.method === "POST") {
				const { backupPath, destinationPath } = documentFrom(await jsonBody(request, maxBodyBytes));
				await restoreDatabase(String(backupPath), String(destinationPath));
				return send(response, 204, {});
			}
			const entity = segments[1] as Entity;
			if (!["captures", "folders", "queue", "history"].includes(entity)) return send(response, 404, { error: "Not found" });
			const id = segments[2];
			if (!id && request.method === "GET") return send(response, 200, entityList(repository, entity));
			if (id && request.method === "GET") {
				const record = entityRecord(repository, entity, id);
				return record ? send(response, 200, record) : send(response, 404, { error: "Not found" });
			}
			if (id && (request.method === "PUT" || request.method === "POST")) return send(response, 200, entityPut(repository, entity, id, documentFrom(await jsonBody(request, maxBodyBytes)), expectedVersion(request)));
			if (id && request.method === "DELETE") return send(response, entityDelete(repository, entity, id) ? 204 : 404, {});
			return send(response, 405, { error: "Method not allowed" });
		} catch (error) {
			// A browser may cancel an in-flight request while its page is closing.
			// There is no response to send and this is not a service failure.
			if (request.aborted || response.destroyed) return;
			if (error instanceof RepositoryConflictError) return send(response, 409, { error: error.message, code: error.code });
			if (error instanceof RepositoryValidationError || error instanceof SyntaxError) return send(response, 400, { error: error.message });
			console.error("Archive service request failed", error);
			return send(response, 500, { error: "Internal server error" });
		}
	});
	return { server, repository, database, close: () => new Promise(resolveClose => server.close(() => { database.close(); resolveClose(); })) };
}

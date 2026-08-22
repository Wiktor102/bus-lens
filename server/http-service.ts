import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { backupDatabase, restoreDatabase } from "./backup.ts";
import {
	RepositoryConflictError,
	RepositoryValidationError,
	type ArchiveRepository,
	type LegacyArchive,
	type ArchiveIndex,
	type JsonDocument
} from "./archive-repository.ts";
import { openDatabase, type SqliteDatabase } from "./database.ts";
import { DatabaseManager, ProjectNotFoundError, type ProjectDatabaseContext } from "./database-manager.ts";
import { ensureDefaultProject, ProjectRegistry } from "./project-registry.ts";
import {
	CanonicalCaptureCommandError,
	type CanonicalCaptureCommandService,
	type CaptureMetadataPatch,
	type CreateCaptureRequest,
	type FramingSectionRequest
} from "./canonical-capture-command-service.ts";
import { createMcpAccess, type AgentAccessStatus, type McpAccess, type McpToolRegistrar } from "./mcp-server.ts";
import { registerAnalysisTools } from "./mcp-analysis.ts";
import { registerComparisonTools } from "./mcp-comparison.ts";
import { registerAgentNoteTools } from "./mcp-notes.ts";

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
	mcpEndpoint?: string;
	mcpAgentNotes?: AgentAccessStatus["agentNotes"];
	mcpToolRegistrar?: McpToolRegistrar;
};

export type ArchiveHttpService = {
	server: Server;
	/** Default-project services, retained for embedders that bypass routing. */
	repository: ArchiveRepository;
	commandService: CanonicalCaptureCommandService;
	database: SqliteDatabase;
	registry: ProjectRegistry;
	manager: DatabaseManager;
	mcpAccess: McpAccess;
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
	if (entity === "captures") return repository.listCaptureProjections();
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

const PROJECT_HEADER = "x-bus-lens-project";

function requestedProjectId(request: IncomingMessage): string | undefined {
	const value = request.headers[PROJECT_HEADER];
	if (!value || Array.isArray(value)) return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

/**
 * A restore overwrites the destination file through the SQLite backup API.
 * Doing that to the live root database would drop the projects registry out
 * from under the running service, and doing it to any registered project file
 * strands the cached open handles in replaced or unlinked inodes. The
 * endpoint therefore refuses destinations that collide with live storage.
 */
function isLiveDatabasePath(candidate: string, livePaths: readonly string[]): boolean {
	const resolved = resolve(candidate);
	return livePaths.some(path => resolve(path) === resolved);
}

export function createArchiveHttpService(options: ServiceOptions): ArchiveHttpService {
	const rootDatabase = openDatabase(options.databasePath);
	const rootDatabasePath = resolve(options.databasePath);
	const registry = new ProjectRegistry(rootDatabase);
	ensureDefaultProject(registry, rootDatabasePath);
	const manager = new DatabaseManager({ rootDatabase, rootDatabasePath: options.databasePath, registry });
	// Embedders that read service.repository directly keep observing the Default
	// project; routed requests below resolve their own context per request.
	const defaultContext = manager.forProject();
	const staticDirectory = options.staticDirectory ? resolve(options.staticDirectory) : undefined;
	const maxBodyBytes = options.maxBodyBytes ?? 128 * 1024 * 1024;
	const phase4ToolRegistrar: McpToolRegistrar = (server, queries, recordClient, commands) => {
		registerAnalysisTools(server, queries, recordClient);
		registerComparisonTools(server, queries, recordClient);
		registerAgentNoteTools(server, queries, recordClient, commands);
	};
	const mcpAccess = createMcpAccess({
		database: defaultContext.database,
		databasePath: defaultContext.databasePath,
		endpoint: options.mcpEndpoint ?? "http://127.0.0.1/mcp",
		serverVersion: "1.0.0",
		agentNotes: options.mcpAgentNotes,
		toolRegistrar: options.mcpToolRegistrar ?? phase4ToolRegistrar
	});
	const server = createServer(async (request, response) => {
		// Released in finally so every await below keeps its project handle
		// pinned against eviction and explicit closes.
		let releaseProject: (() => void) | undefined;
		try {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
			if (url.pathname === "/mcp") return await mcpAccess.handle(request, response);
			if (segments[0] !== "api") {
				if (staticDirectory && await serveStatic(response, staticDirectory, url.pathname)) return;
				return send(response, 404, { error: "Not found" });
			}
			if (request.method === "GET" && url.pathname === "/api/health") return send(response, 200, { ok: true });
			if (request.method === "GET" && url.pathname === "/api/agent-access") return send(response, 200, mcpAccess.getStatus());
			let projectContext: ProjectDatabaseContext;
			try {
				projectContext = manager.forProject(requestedProjectId(request));
			} catch (error) {
				if (error instanceof ProjectNotFoundError) return send(response, 404, { error: error.message });
				throw error;
			}
			manager.acquire(projectContext.projectId);
			releaseProject = () => manager.release(projectContext.projectId);
			// last_used_at feeds MRU agent targeting; reads are ambient noise
			// (browsing one tab must not steal agent focus from another), while
			// writes express real intent.
			if (request.method !== "GET") registry.touch(projectContext.projectId);
			const { repository } = projectContext;
			const canonicalQueries = projectContext.queryService;
			const commandService = projectContext.commandService;
			if (request.method === "GET" && url.pathname === "/api/archive") {
				return send(response, 200, { captures: repository.listCaptures(), folders: repository.listFolders(), index: repository.getArchiveIndex(), queue: repository.listQueue(), history: repository.listHistory(), settings: repository.getSettings() });
			}
			if (segments[1] === "canonical" && segments[2] === "captures") {
				if (request.method === "GET" && !segments[3]) return send(response, 200, canonicalQueries.listCaptureSummaries());
				const captureId = segments[3];
				if (request.method === "GET" && captureId && segments[4] === "overview") {
					const overview = canonicalQueries.getCaptureOverview(captureId);
					return overview ? send(response, 200, overview) : send(response, 404, { error: "Not found" });
				}
				if (request.method === "GET" && captureId && segments[4] === "frames") {
					const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
					const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
					if ((url.searchParams.has("offset") && !Number.isSafeInteger(offset)) || (limit !== undefined && !Number.isSafeInteger(limit))) {
						throw new RepositoryValidationError("offset and limit must be integers");
					}
					const window = canonicalQueries.getFrameWindow(captureId, offset, limit);
					return window ? send(response, 200, window) : send(response, 404, { error: "Not found" });
				}
			}
			if (segments[1] === "captures" && !segments[2] && request.method === "POST") {
				const body = documentFrom(await jsonBody(request, maxBodyBytes));
				const captureId = String(body.id ?? body.captureId ?? "");
				const existed = commandService.getStorageStatus(captureId).status === "canonical";
				const state = commandService.createCapture(body as CreateCaptureRequest);
				return send(response, existed ? 200 : 201, state);
			}
			if (segments[1] === "captures" && segments[2]) {
				const captureId = segments[2];
				if (segments[3] === "canonicalization") {
					if (!segments[4] && request.method === "GET") {
						const preflight = repository.getCanonicalizationPreflight(captureId);
						return preflight.estimatedEligibility === "missing" ? send(response, 404, { error: preflight.error || "Not found" }) : send(response, 200, preflight);
					}
					if (!segments[4] && request.method === "POST") {
						const preflight = repository.getCanonicalizationPreflight(captureId);
						if (preflight.estimatedEligibility === "missing") return send(response, 404, { error: preflight.error || "Not found" });
						return send(response, 200, repository.startCanonicalization(captureId));
					}
					if (segments[4] === "jobs" && segments[5] && request.method === "GET") {
						const job = repository.getCanonicalizationJob(captureId, segments[5]);
						return job ? send(response, 200, job) : send(response, 404, { error: "Not found" });
					}
				}
				if (segments[3] === "legacy-backup" && request.method === "GET") {
					const backup = repository.getLegacyBackupDocument(captureId);
					return backup ? send(response, 200, backup) : send(response, 404, { error: "No legacy backup available" });
				}
				if (segments[3] === "metadata" && request.method === "PATCH") {
					const body = documentFrom(await jsonBody(request, maxBodyBytes));
					const patch = documentFrom(body.patch ?? body) as CaptureMetadataPatch;
					return send(response, 200, commandService.patchMetadata({
						captureId,
						patch,
						expectedMetadataRevision: body.expectedMetadataRevision === undefined
							? undefined
							: Number(body.expectedMetadataRevision)
					}));
				}
				if (segments[3] === "sessions" && !segments[4] && request.method === "POST") {
					const body = documentFrom(await jsonBody(request, maxBodyBytes) ?? {});
					const result = commandService.startSession({
						captureId,
						sessionId: body.sessionId === undefined ? undefined : String(body.sessionId),
						startedAt: body.startedAt === undefined ? undefined : String(body.startedAt)
					});
					return send(response, 200, {
						sessionId: result.session.id,
						nextChunkSequence: result.session.nextChunkSequence,
						nextRawOffset: result.session.nextRawOffset,
						dataRevision: result.dataRevision
					});
				}
				if (segments[3] === "raw-chunks" && request.method === "POST") {
					const body = documentFrom(await jsonBody(request, maxBodyBytes));
					return send(response, 200, commandService.appendChunk({
						...body,
						captureId,
						sessionId: String(body.sessionId ?? ""),
						requestId: String(body.requestId ?? ""),
						sequence: Number(body.sequence),
						expectedStartOffset: Number(body.expectedStartOffset)
					}));
				}
				if (segments[3] === "sessions" && segments[4] && segments[5] === "finalize" && request.method === "POST") {
					const body = documentFrom(await jsonBody(request, maxBodyBytes) ?? {});
					return send(response, 200, commandService.finalizeSession({
						captureId,
						sessionId: segments[4],
						expectedDataRevision: body.expectedDataRevision === undefined ? undefined : Number(body.expectedDataRevision)
					}));
				}
				if (segments[3] === "framing-draft" && request.method === "PATCH") {
					const body = documentFrom(await jsonBody(request, maxBodyBytes));
					return send(response, 200, commandService.updateFramingDraft({
						captureId,
						sections: body.sections as FramingSectionRequest[],
						expectedRevision: body.expectedRevision === undefined ? undefined : Number(body.expectedRevision)
					}));
				}
				if (segments[3] === "framing-sections" && segments[4] && segments[5] === "view" && request.method === "PATCH") {
					const body = documentFrom(await jsonBody(request, maxBodyBytes));
					return send(response, 200, commandService.updateFramingSectionView({
						captureId,
						sectionId: segments[4],
						profileId: String(body.profileId ?? ""),
						collapseRuns: body.collapseRuns === undefined ? undefined : Boolean(body.collapseRuns),
						collapsed: body.collapsed === undefined ? undefined : Boolean(body.collapsed)
					}));
				}
				if (segments[3] === "framing-revisions" && request.method === "POST") {
					const body = documentFrom(await jsonBody(request, maxBodyBytes));
					return send(response, 200, commandService.reframe({
						captureId,
						sections: body.sections as FramingSectionRequest[],
						expectedActiveProfileId: body.expectedActiveProfileId === undefined
							? undefined
							: body.expectedActiveProfileId === null ? null : String(body.expectedActiveProfileId),
						expectedDataRevision: Number(body.expectedDataRevision),
						algorithmVersion: body.algorithmVersion === undefined ? undefined : Number(body.algorithmVersion)
					}));
				}
				if (segments[3] === "notes") {
					const noteId = segments[4];
					if (!noteId && request.method === "GET") return send(response, 200, commandService.getCaptureState(captureId).notes);
					if (!noteId && request.method === "POST") {
						const body = documentFrom(await jsonBody(request, maxBodyBytes));
						return send(response, 201, commandService.createNote({
							captureId,
							noteId: body.noteId === undefined ? undefined : String(body.noteId),
							text: String(body.text ?? ""),
							target: documentFrom(body.target) as never,
							createdAt: body.createdAt as string | number | undefined
						}));
					}
					if (noteId && request.method === "PATCH") {
						const body = documentFrom(await jsonBody(request, maxBodyBytes));
						return send(response, 200, commandService.updateNote({
							captureId,
							noteId,
							text: body.text === undefined ? undefined : String(body.text),
							target: body.target === undefined ? undefined : documentFrom(body.target) as never
						}));
					}
					if (noteId && request.method === "DELETE") {
						return send(response, 200, commandService.deleteNote({ captureId, noteId }));
					}
				}
				if (segments[3] === "bytes" && segments[4] && segments[5] === "visibility") {
					const rawOffset = Number(segments[4]);
					if (request.method === "PUT") {
						const body = documentFrom(await jsonBody(request, maxBodyBytes));
						return send(response, 200, commandService.setByteVisibility({ captureId, rawOffset, hidden: Boolean(body.hidden) }));
					}
					if (request.method === "DELETE") {
						commandService.deleteByteVisibility(captureId, rawOffset);
						return send(response, 204, {});
					}
				}
				if (segments[3] === "frames" && segments[4] && segments[5] === "visibility") {
					const frameId = segments[4];
					if (request.method === "PUT") {
						const body = documentFrom(await jsonBody(request, maxBodyBytes));
						return send(response, 200, commandService.setFrameVisibility({ captureId, frameId, hidden: Boolean(body.hidden) }));
					}
					if (request.method === "DELETE") {
						commandService.deleteFrameVisibility({ captureId, frameId });
						return send(response, 204, {});
					}
				}
				if (segments[3] === "data" && request.method === "DELETE") {
					return send(response, 200, commandService.clearCaptureData({ captureId }));
				}
				if (segments[3] === "duplicate" && request.method === "POST") {
					const body = documentFrom(await jsonBody(request, maxBodyBytes));
					const duplicateCaptureId = body.duplicateCaptureId ?? body.id;
					return send(response, 201, commandService.duplicateCapture({
						captureId,
						duplicateCaptureId: duplicateCaptureId === undefined ? undefined : String(duplicateCaptureId)
					}));
				}
				if (!segments[3] && request.method === "DELETE" && commandService.getStorageStatus(captureId).status === "canonical") {
					commandService.deleteCapture(captureId);
					return send(response, 204, {});
				}
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
					const ids = repository.listCaptures().map(capture => String(capture.id));
					const results: unknown[] = [];
					for (const id of ids) {
						const preflight = repository.getCanonicalizationPreflight(id);
						if (preflight.status === "canonical") {
							results.push({ captureId: id, status: "skipped", reason: "already-canonical", verified: true });
							continue;
						}
						if (preflight.recordingActive) {
							results.push({ captureId: id, status: "skipped", reason: "recording-active", verified: true });
							continue;
						}
						try {
							const job = repository.startCanonicalization(id);
							results.push(job);
							if (job.status === "failed") break;
						} catch (error) {
							results.push({ captureId: id, status: "failed", verified: false, error: error instanceof Error ? error.message : String(error) });
							break;
						}
					}
					return send(response, 200, { results, verified: results.every(result => (result as { verified?: boolean }).verified === true) });
				}
				if (request.method === "GET") {
					const captures = repository.listCaptures();
					const converted = captures.filter(c => repository.isCaptureConverted(String(c.id))).length;
					return send(response, 200, { total: captures.length, converted, unconverted: captures.length - converted, backups: repository.listCaptureBackups() });
				}
			}
			if (segments[1] === "captures" && segments[2] && segments[3] === "convert" && request.method === "POST") {
				const captureId = segments[2];
				return send(response, 200, repository.startCanonicalization(captureId));
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
				return send(response, 200, repository.listFramingProfiles(captureId).map(profile => ({
					id: profile.id,
					version: profile.version,
					algorithmVersion: profile.algorithm_version,
					isActive: Boolean(profile.is_active)
				})));
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
				return send(response, 201, await backupDatabase(projectContext.database, String(destinationPath)));
			}
			if (segments[1] === "restore" && request.method === "POST") {
				const { backupPath, destinationPath } = documentFrom(await jsonBody(request, maxBodyBytes));
				const destination = String(destinationPath ?? "");
				if (isLiveDatabasePath(destination, [rootDatabasePath, ...registry.list().map(record => record.dbPath)])) {
					return send(response, 409, { error: "Restore destination would overwrite a live project database; stop the service or choose another path" });
				}
				await restoreDatabase(String(backupPath), destination);
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
			if (error instanceof CanonicalCaptureCommandError) {
				const status = error.code === "NOT_FOUND"
					? 404
					: error.code === "CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT"
						? 409
						: error.code === "VALIDATION_ERROR"
							? 400
							: 500;
				return send(response, status, { error: error.message, code: error.code, details: error.details });
			}
			if (error instanceof RepositoryConflictError) return send(response, 409, { error: error.message, code: error.code });
			if (error instanceof RepositoryValidationError || error instanceof SyntaxError) return send(response, 400, { error: error.message });
			console.error("Archive service request failed", error);
			return send(response, 500, { error: "Internal server error" });
		} finally {
			releaseProject?.();
		}
	});
	return {
		server,
		repository: defaultContext.repository,
		commandService: defaultContext.commandService,
		database: rootDatabase,
		registry,
		manager,
		mcpAccess,
		close: async () => {
			await mcpAccess.close();
			await new Promise<void>(resolveClose => server.close(() => resolveClose()));
			manager.closeAll();
			rootDatabase.close();
		}
	};
}

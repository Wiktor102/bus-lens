import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.ts";
import {
	convertCaptureDocumentToCanonical as convertDocumentCanonical,
	createFramingRevision as createCanonicalRevision,
	getActiveProfile as getCanonicalActiveProfile,
	getPreviousProfiles as listCanonicalPreviousProfiles,
	isCaptureConverted as isCanonicalCaptureConverted
} from "./canonical.ts";

export type JsonDocument = Record<string, unknown>;

export type DocumentRecord = {
	id: string;
	version: number;
	document: JsonDocument;
	createdAt: string;
	updatedAt: string;
};

export type ArchiveCaptureOrder = {
	id: string;
	folderId: string | null;
	position: number;
};

export type ArchiveFolderOrder = {
	id: string;
	position: number;
};

export type ArchiveIndex = {
	activeId: string | null;
	unfiledCollapsed: boolean;
	captures: ArchiveCaptureOrder[];
	folders: ArchiveFolderOrder[];
};

export type ImportStatus = "in_progress" | "completed" | "failed";

export type ImportRecord = {
	fingerprint: string;
	sourceKey: string;
	status: ImportStatus;
	report: unknown;
	createdAt: string;
	completedAt: string | null;
};

export type ArchiveRepositoryDependencies = {
	nowIso?: () => string;
	generateId?: () => string;
};

export type LegacyArchive = {
	captures: JsonDocument[];
	folders: JsonDocument[];
	activeId?: string | null;
	unfiledCollapsed?: boolean;
	sendHistory?: JsonDocument[];
	sendQueue?: JsonDocument[];
	sendSettings?: JsonDocument;
};

type StoredDocumentRow = {
	id: string;
	document_version: number;
	document_json: string;
	created_at: string;
	updated_at: string;
};

type StoredImportRow = {
	fingerprint: string;
	source_key: string;
	status: ImportStatus;
	report_json: string;
	created_at: string;
	completed_at: string | null;
};

type DocumentTable = "capture_documents" | "folders" | "send_queue" | "send_history";

export class RepositoryConflictError extends Error {
	readonly code = "VERSION_CONFLICT";

	constructor(message = "The document was changed by another writer") {
		super(message);
		this.name = "RepositoryConflictError";
	}
}

export class RepositoryValidationError extends Error {
	readonly code = "VALIDATION_ERROR";

	constructor(message: string) {
		super(message);
		this.name = "RepositoryValidationError";
	}
}

export function isJsonDocument(value: unknown): value is JsonDocument {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseDocument(value: string): JsonDocument {
	const parsed: unknown = JSON.parse(value);
	if (!isJsonDocument(parsed)) throw new Error("Stored document is not a JSON object");
	return parsed;
}

function serializeDocument(document: JsonDocument): string {
	if (!isJsonDocument(document)) throw new RepositoryValidationError("Document must be a JSON object");
	const serialized = JSON.stringify(document);
	if (!serialized) throw new RepositoryValidationError("Document could not be serialized as JSON");
	return serialized;
}

function documentRecord(row: StoredDocumentRow): DocumentRecord {
	return {
		id: row.id,
		version: row.document_version,
		document: parseDocument(row.document_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function normalizedPosition(value: unknown, fallback = 0): number {
	const position = Number(value);
	return Number.isSafeInteger(position) && position >= 0 ? position : fallback;
}

function optionalString(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	return String(value);
}

function documentFolderId(document: JsonDocument): string | null {
	return optionalString(document.folderId);
}

function timestampAsIso(value: unknown, fallback: string): string {
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
	}
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
	return fallback;
}

export class ArchiveRepository {
	private readonly database: SqliteDatabase;
	private readonly nowIso: () => string;
	private readonly generateId: () => string;

	constructor(database: SqliteDatabase, dependencies: ArchiveRepositoryDependencies = {}) {
		this.database = database;
		this.nowIso = dependencies.nowIso ?? (() => new Date().toISOString());
		this.generateId = dependencies.generateId ?? randomUUID;
	}

	private getDocument(table: DocumentTable, id: string): DocumentRecord | undefined {
		const row = this.database
			.prepare(`SELECT id, document_version, document_json, created_at, updated_at FROM ${table} WHERE id = @id`)
			.get({ id }) as StoredDocumentRow | undefined;
		return row ? documentRecord(row) : undefined;
	}

	private listDocuments(table: DocumentTable, orderBy: string): DocumentRecord[] {
		const rows = this.database
			.prepare(
				`SELECT id, document_version, document_json, created_at, updated_at FROM ${table} ORDER BY ${orderBy}`
			)
			.all() as StoredDocumentRow[];
		return rows.map(documentRecord);
	}

	private putDocument(
		table: DocumentTable,
		id: string,
		document: JsonDocument,
		expectedVersion?: number
	): DocumentRecord {
		const normalizedId = String(id).trim();
		if (!normalizedId) throw new RepositoryValidationError("Document id is required");
		const json = serializeDocument(document);
		const existing = this.database
			.prepare(`SELECT id, document_version, document_json, created_at, updated_at FROM ${table} WHERE id = @id`)
			.get({ id: normalizedId }) as StoredDocumentRow | undefined;
		if (expectedVersion !== undefined && existing && existing.document_version !== expectedVersion) {
			throw new RepositoryConflictError();
		}
		const updatedAt = this.nowIso();
		if (existing) {
			const version = existing.document_version + 1;
			this.database
				.prepare(
					`UPDATE ${table}
					 SET document_version = @version, document_json = @documentJson, updated_at = @updatedAt
					 WHERE id = @id`
				)
				.run({
					id: normalizedId,
					version,
					documentJson: json,
					updatedAt
				});
			return {
				id: normalizedId,
				version,
				document,
				createdAt: existing.created_at,
				updatedAt
			};
		}

		this.database
			.prepare(
				`INSERT INTO ${table}
				 (id, document_version, document_json, created_at, updated_at)
				 VALUES (@id, 1, @documentJson, @createdAt, @updatedAt)`
			)
			.run({ id: normalizedId, documentJson: json, createdAt: updatedAt, updatedAt });
		return { id: normalizedId, version: 1, document, createdAt: updatedAt, updatedAt };
	}

	private nextPosition(entityType: "capture" | "folder", folderId: string | null = null): number {
		const row = this.database
			.prepare(
				`SELECT COALESCE(MAX(position), -1) AS position
				 FROM archive_order
				 WHERE entity_type = @entityType AND (folder_id IS @folderId OR (@folderId IS NULL AND folder_id IS NULL))`
			)
			.get({ entityType, folderId }) as { position: number };
		return normalizedPosition(row.position, -1) + 1;
	}

	private putArchiveOrder(
		entityType: "capture" | "folder",
		entityId: string,
		folderId: string | null,
		position: number
	): void {
		this.database
			.prepare(
				`INSERT INTO archive_order (entity_type, entity_id, folder_id, position)
				 VALUES (@entityType, @entityId, @folderId, @position)
				 ON CONFLICT (entity_type, entity_id) DO UPDATE SET
				 folder_id = excluded.folder_id,
				 position = excluded.position`
			)
			.run({ entityType, entityId, folderId, position });
	}

	getCapture(id: string): DocumentRecord | undefined {
		// Mixed state: prefer canonical synthesis if converted, fallback to JSON document
		const canonical = this.getCanonicalCapture(id);
		if (canonical) return canonical;
		return this.getDocument("capture_documents", id);
	}

	listCaptures(): DocumentRecord[] {
		// Mixed state: merge canonical captures (synthesized) and unconverted JSON documents.
		// Converted captures must remain readable alongside unconverted ones during rollout.
		const canonicalRows = this.database
			.prepare("SELECT id, updated_at, created_at FROM captures ORDER BY updated_at DESC, id ASC")
			.all() as Array<{ id: string; updated_at: string; created_at: string }>;
		const hasCanonical = canonicalRows.length > 0;
		const jsonRows = this.listDocuments("capture_documents", "updated_at DESC, id ASC");
		if (!hasCanonical) return jsonRows;
		const canonicalIds = new Set(canonicalRows.map(r => r.id));
		const synthesized: DocumentRecord[] = canonicalRows
			.map(row => this.getCanonicalCapture(row.id))
			.filter((r): r is DocumentRecord => Boolean(r));
		const unconverted = jsonRows.filter(r => !canonicalIds.has(r.id));
		// Preserve archive_order ordering as primary sort if available, else fall back to synthesized+unconverted by updated_at
		const order = this.database
			.prepare("SELECT entity_id, position FROM archive_order WHERE entity_type='capture' ORDER BY position, entity_id")
			.all() as Array<{ entity_id: string; position: number }>;
		if (order.length) {
			const pos = new Map(order.map(o => [o.entity_id, o.position]));
			const all = [...synthesized, ...unconverted];
			all.sort((a, b) => {
				const pa = pos.get(a.id) ?? Number.MAX_SAFE_INTEGER;
				const pb = pos.get(b.id) ?? Number.MAX_SAFE_INTEGER;
				return pa - pb || b.updatedAt.localeCompare(a.updatedAt);
			});
			return all;
		}
		return [...synthesized, ...unconverted];
	}

	/** Returns synthesized DocumentRecord from canonical tables if converted, otherwise undefined */
	getCanonicalCapture(id: string): DocumentRecord | undefined {
		const cap = this.database.prepare("SELECT id, name, lifecycle, byte_count, created_at, updated_at, folder_id FROM captures WHERE id = @id").get({ id }) as
			| { id: string; name: string; lifecycle: string; byte_count: number; created_at: string; updated_at: string; folder_id: string | null }
			| undefined;
		if (!cap) return undefined;
		// Reassemble byteStream from raw_chunks
		const chunks = this.database
			.prepare("SELECT bytes, timestamps_json, directions_json, hidden_json, start_offset, session_id FROM raw_chunks WHERE capture_id = @captureId ORDER BY chunk_index")
			.all({ captureId: id }) as Array<{
			bytes: Buffer;
			timestamps_json: string;
			directions_json: string;
			hidden_json: string;
			start_offset: number;
			session_id: string | null;
		}>;
		const byteStream: JsonDocument[] = [];
		for (const ch of chunks) {
			const timestamps: number[] = JSON.parse(ch.timestamps_json) as number[];
			const directions: string[] = JSON.parse(ch.directions_json) as string[];
			const hidden: boolean[] = JSON.parse(ch.hidden_json) as boolean[];
			const bytes = ch.bytes instanceof Buffer ? [...ch.bytes] : Array.from(new Uint8Array(ch.bytes as unknown as Uint8Array));
			for (let i = 0; i < bytes.length; i++) {
				byteStream.push({
					rawOffset: ch.start_offset + i,
					value: bytes[i],
					timestamp: timestamps[i] ?? 0,
					direction: directions[i] || "rx",
					hidden: Boolean(hidden[i]),
					...(ch.session_id ? { sessionId: ch.session_id } : {})
				});
			}
		}
		// Active framing profile
		const activeProfile = this.database
			.prepare("SELECT id, version, algorithm_version FROM framing_profiles WHERE capture_id = @captureId AND is_active = 1 LIMIT 1")
			.get({ captureId: id }) as { id: string; version: number; algorithm_version: number } | undefined;
		let frameSections: JsonDocument[] = [];
		let messages: JsonDocument[] = [];
		if (activeProfile) {
			const sections = this.database
				.prepare(
					"SELECT id, start_offset, framing_mode, frame_length, marker_bytes, marker_position, time_gap_ms, collapse_runs, collapsed FROM framing_sections WHERE profile_id = @profileId ORDER BY position"
				)
				.all({ profileId: activeProfile.id }) as Array<{
				id: string;
				start_offset: number;
				framing_mode: string;
				frame_length: number | null;
				marker_bytes: string | null;
				marker_position: string | null;
				time_gap_ms: number | null;
				collapse_runs: number;
				collapsed: number;
			}>;
			frameSections = sections.map(s => {
				let marker = "";
				if (s.marker_bytes) {
					try {
						const arr: number[] = JSON.parse(s.marker_bytes) as number[];
						marker = arr.map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
					} catch {}
				}
				return {
					id: s.id,
					start: s.start_offset,
					framingMode: s.framing_mode,
					frameSize: s.frame_length ?? 3,
					frameMarker: marker,
					markerPosition: s.marker_position ?? "start",
					frameTimeGap: s.time_gap_ms ?? 5,
					collapseRuns: Boolean(s.collapse_runs),
					collapsed: Boolean(s.collapsed)
				};
			});
			const frames = this.database
				.prepare(
					"SELECT id, ordinal, section_id, raw_offsets_json, bytes_json, timestamps_json, directions_json, hidden, signature FROM materialized_frames WHERE profile_id = @profileId ORDER BY ordinal"
				)
				.all({ profileId: activeProfile.id }) as Array<{
				id: string;
				ordinal: number;
				section_id: string;
				raw_offsets_json: string;
				bytes_json: string;
				timestamps_json: string;
				directions_json: string;
				hidden: number;
				signature: string;
			}>;
			messages = frames.map(f => {
				const rawOffsets: number[] = JSON.parse(f.raw_offsets_json) as number[];
				const bytes: number[] = JSON.parse(f.bytes_json) as number[];
				const timestamps: number[] = JSON.parse(f.timestamps_json) as number[];
				return {
					id: f.id,
					timestamp: timestamps[0] ?? 0,
					byteTimestamps: timestamps,
					bytes,
					directions: JSON.parse(f.directions_json) as string[],
					hidden: Boolean(f.hidden),
					hiddenBytes: bytes.map(() => false),
					sourceIndex: f.ordinal,
					sectionId: f.section_id,
					_byteStart: 0,
					_byteEnd: bytes.length,
					rawOffsets,
					_rawPositions: rawOffsets
				};
			});
		}
		// Notes: stable_notes
		const notesRows = this.database.prepare("SELECT id, text, created_at, target_kind, start_row, end_row, raw_offset, raw_offsets_json, start_offset, end_offset, sequence_key FROM stable_notes WHERE capture_id = @captureId").all({ captureId: id }) as Array<{
			id: string;
			text: string;
			created_at: string;
			target_kind: string;
			start_row: number | null;
			end_row: number | null;
			raw_offset: number | null;
			raw_offsets_json: string | null;
			start_offset: number | null;
			end_offset: number | null;
			sequence_key: string | null;
		}>;
		const captureNotes: JsonDocument[] = [];
		const annotations: Record<string, JsonDocument> = {};
		for (const row of notesRows) {
			if (row.target_kind === "legacy-sequence") {
				captureNotes.push({ id: row.id, type: "sequence", text: row.text, createdAt: new Date(row.created_at).getTime(), start: row.start_row, end: row.end_row, targetLabel: `rows ${row.start_row}–${row.end_row}` });
			} else if (row.target_kind === "capture") {
				captureNotes.push({ id: row.id, type: "capture", text: row.text, createdAt: new Date(row.created_at).getTime() });
			} else if (row.target_kind === "byte") {
				annotations[row.id] = { text: row.text, createdAt: new Date(row.created_at).getTime(), type: "byte", targetLabel: `raw ${row.raw_offset}` };
			} else if (row.target_kind === "frame") {
				annotations[row.id] = { text: row.text, createdAt: new Date(row.created_at).getTime(), type: "message", targetLabel: row.raw_offsets_json || "" };
			} else if (row.target_kind === "pattern") {
				// patternRemarks not reconstructed here; stored separately but we omit for brevity
			}
		}
		// Retrieve patternRemarks from stable_notes where target_kind='pattern' to reconstitute
		const patternRemarks: Record<string, JsonDocument> = {};
		for (const row of notesRows) {
			if (row.target_kind === "pattern" && row.sequence_key) patternRemarks[row.sequence_key] = { text: row.text, updatedAt: new Date(row.created_at).getTime() };
		}

		const document: JsonDocument = {
			id: cap.id,
			name: cap.name,
			createdAt: cap.created_at,
			lifecycle: cap.lifecycle,
			byteCount: cap.byte_count,
			folderId: cap.folder_id,
			byteStream,
			frameSections,
			messages,
			notes: captureNotes,
			annotations,
			patternRemarks,
			nextRawOffset: byteStream.length ? Math.max(...byteStream.map(b => (b.rawOffset as number) + 1)) : 0,
			captureSessions: []
		};
		// Try to preserve version from capture_documents if exists? But canonical is now authoritative.
		const existingDoc = this.database.prepare("SELECT document_version FROM capture_documents WHERE id = @id").get({ id }) as { document_version: number } | undefined;
		return {
			id: cap.id,
			version: existingDoc?.document_version ?? 1,
			document,
			createdAt: cap.created_at,
			updatedAt: cap.updated_at
		};
	}

	putCapture(id: string, document: JsonDocument, expectedVersion?: number): DocumentRecord {
		const transaction = this.database.transaction(() => {
			const record = this.putDocument("capture_documents", id, document, expectedVersion);
			const existingOrder = this.database
				.prepare("SELECT position FROM archive_order WHERE entity_type = 'capture' AND entity_id = @id")
				.get({ id }) as { position: number } | undefined;
			this.putArchiveOrder(
				"capture",
				record.id,
				documentFolderId(document),
				existingOrder ? normalizedPosition(existingOrder.position) : this.nextPosition("capture", documentFolderId(document))
			);
			return record;
		});
		return transaction();
	}

	deleteCapture(id: string): boolean {
		const transaction = this.database.transaction(() => {
			this.database.prepare("DELETE FROM raw_chunks WHERE capture_id = @id").run({ id });
			this.database.prepare("DELETE FROM stable_notes WHERE capture_id = @id").run({ id });
			this.database.prepare("DELETE FROM finalization_jobs WHERE capture_id = @id").run({ id });
			this.database.prepare("DELETE FROM capture_backups WHERE capture_id = @id").run({ id });
			// Cascading deletes from captures will clear profiles/frames; do explicit for safety
			this.database.prepare("DELETE FROM framing_profiles WHERE capture_id = @id").run({ id });
			this.database.prepare("DELETE FROM captures WHERE id = @id").run({ id });
			this.database.prepare("DELETE FROM archive_order WHERE entity_type = 'capture' AND entity_id = @id").run({ id });
			const docDeleted = this.database.prepare("DELETE FROM capture_documents WHERE id = @id").run({ id }).changes > 0;
			return docDeleted || true;
		});
		return transaction();
	}

	getFolder(id: string): DocumentRecord | undefined {
		return this.getDocument("folders", id);
	}

	listFolders(): DocumentRecord[] {
		return this.listDocuments("folders", "updated_at DESC, id ASC");
	}

	putFolder(id: string, document: JsonDocument, expectedVersion?: number): DocumentRecord {
		const transaction = this.database.transaction(() => {
			const record = this.putDocument("folders", id, document, expectedVersion);
			const existingOrder = this.database
				.prepare("SELECT position FROM archive_order WHERE entity_type = 'folder' AND entity_id = @id")
				.get({ id }) as { position: number } | undefined;
			this.putArchiveOrder(
				"folder",
				record.id,
				null,
				existingOrder ? normalizedPosition(existingOrder.position) : this.nextPosition("folder")
			);
			return record;
		});
		return transaction();
	}

	deleteFolder(id: string): boolean {
		const transaction = this.database.transaction(() => {
			this.database.prepare("DELETE FROM archive_order WHERE entity_type = 'folder' AND entity_id = @id").run({ id });
			return this.database.prepare("DELETE FROM folders WHERE id = @id").run({ id }).changes > 0;
		});
		return transaction();
	}

	getQueueItem(id: string): DocumentRecord | undefined {
		return this.getDocument("send_queue", id);
	}

	listQueue(): DocumentRecord[] {
		return this.listDocuments("send_queue", "position ASC, created_at ASC, id ASC");
	}

	putQueueItem(id: string, document: JsonDocument, expectedVersion?: number, position?: number): DocumentRecord {
		const transaction = this.database.transaction(() => {
			const record = this.putDocument("send_queue", id, document, expectedVersion);
			const existing = this.database
				.prepare("SELECT position FROM send_queue WHERE id = @id")
				.get({ id: record.id }) as { position: number } | undefined;
			const nextPosition =
				position === undefined
					? existing?.position ??
						(normalizedPosition(
							(
								this.database.prepare("SELECT COALESCE(MAX(position), -1) AS position FROM send_queue").get() as {
									position: number;
								}
						).position,
						-1
						) + 1)
					: normalizedPosition(position);
			this.database
				.prepare("UPDATE send_queue SET position = @position WHERE id = @id")
				.run({ id: record.id, position: nextPosition });
			return record;
		});
		return transaction();
	}

	deleteQueueItem(id: string): boolean {
		return this.database.prepare("DELETE FROM send_queue WHERE id = @id").run({ id }).changes > 0;
	}

	clearQueue(): number {
		return this.database.prepare("DELETE FROM send_queue").run().changes;
	}

	getHistoryItem(id: string): DocumentRecord | undefined {
		return this.getDocument("send_history", id);
	}

	listHistory(): DocumentRecord[] {
		return this.listDocuments("send_history", "occurred_at DESC, created_at DESC, id ASC");
	}

	putHistoryItem(id: string | undefined, document: JsonDocument, expectedVersion?: number): DocumentRecord {
		const normalizedId = id?.trim() || this.generateId();
		const transaction = this.database.transaction(() => {
			const existing = this.getHistoryItem(normalizedId);
			const createdAt = this.nowIso();
			const occurredAt = timestampAsIso(document.timestamp, createdAt);
			const record = existing
				? this.putDocument("send_history", normalizedId, document, expectedVersion)
				: (() => {
					if (expectedVersion !== undefined) throw new RepositoryConflictError();
					this.database.prepare(`INSERT INTO send_history (id, document_version, document_json, occurred_at, created_at, updated_at)
						VALUES (@id, 1, @documentJson, @occurredAt, @createdAt, @createdAt)`).run({ id: normalizedId, documentJson: serializeDocument(document), occurredAt, createdAt });
					return { id: normalizedId, version: 1, document, createdAt, updatedAt: createdAt };
				})();
			if (existing) this.database.prepare("UPDATE send_history SET occurred_at = @occurredAt WHERE id = @id").run({ id: record.id, occurredAt });
			return record;
		});
		return transaction();
	}

	deleteHistoryItem(id: string): boolean {
		return this.database.prepare("DELETE FROM send_history WHERE id = @id").run({ id }).changes > 0;
	}

	clearHistory(): number {
		return this.database.prepare("DELETE FROM send_history").run().changes;
	}

	getArchiveIndex(): ArchiveIndex {
		const state = this.database.prepare("SELECT active_capture_id, unfiled_collapsed FROM archive_state WHERE singleton = 1").get() as
			| { active_capture_id: string | null; unfiled_collapsed: number }
			| undefined;
		const rows = this.database
			.prepare(
				"SELECT entity_type, entity_id, folder_id, position FROM archive_order ORDER BY entity_type, position, entity_id"
			)
			.all() as Array<{
			entity_type: "capture" | "folder";
			entity_id: string;
			folder_id: string | null;
			position: number;
		}>;
		return {
			activeId: state?.active_capture_id ?? null,
			unfiledCollapsed: Boolean(state?.unfiled_collapsed),
			captures: rows
				.filter(row => row.entity_type === "capture")
				.map(row => ({ id: row.entity_id, folderId: row.folder_id, position: normalizedPosition(row.position) })),
			folders: rows
				.filter(row => row.entity_type === "folder")
				.map(row => ({ id: row.entity_id, position: normalizedPosition(row.position) }))
		};
	}

	setArchiveState(activeId: string | null, unfiledCollapsed: boolean): void {
		this.database
			.prepare(
				`INSERT INTO archive_state (singleton, active_capture_id, unfiled_collapsed, updated_at)
				 VALUES (1, @activeId, @unfiledCollapsed, @updatedAt)
				 ON CONFLICT (singleton) DO UPDATE SET
				 active_capture_id = excluded.active_capture_id,
				 unfiled_collapsed = excluded.unfiled_collapsed,
				 updated_at = excluded.updated_at`
			)
			.run({ activeId, unfiledCollapsed: unfiledCollapsed ? 1 : 0, updatedAt: this.nowIso() });
	}

	setCaptureOrder(id: string, folderId: string | null, position: number): void {
		this.putArchiveOrder("capture", id, folderId, normalizedPosition(position));
	}

	setFolderOrder(id: string, position: number): void {
		this.putArchiveOrder("folder", id, null, normalizedPosition(position));
	}

	replaceArchiveIndex(index: ArchiveIndex): void {
		const transaction = this.database.transaction(() => {
			this.database.prepare("DELETE FROM archive_order").run();
			for (const capture of index.captures) {
				this.putArchiveOrder(
					"capture",
					capture.id,
					capture.folderId,
					normalizedPosition(capture.position)
				);
			}
			for (const folder of index.folders) {
				this.putArchiveOrder("folder", folder.id, null, normalizedPosition(folder.position));
			}
			this.database
				.prepare(
					`INSERT INTO archive_state (singleton, active_capture_id, unfiled_collapsed, updated_at)
					 VALUES (1, @activeId, @unfiledCollapsed, @updatedAt)
					 ON CONFLICT (singleton) DO UPDATE SET
					 active_capture_id = excluded.active_capture_id,
					 unfiled_collapsed = excluded.unfiled_collapsed,
					 updated_at = excluded.updated_at`
				)
				.run({
					activeId: index.activeId,
					unfiledCollapsed: index.unfiledCollapsed ? 1 : 0,
					updatedAt: this.nowIso()
				});
		});
		transaction();
	}

	getSettings(): Record<string, unknown> {
		const rows = this.database.prepare("SELECT key, value_json FROM application_settings ORDER BY key").all() as Array<{
			key: string;
			value_json: string;
		}>;
		return Object.fromEntries(rows.map(row => [row.key, JSON.parse(row.value_json) as unknown]));
	}

	getSetting(key: string): unknown {
		const row = this.database.prepare("SELECT value_json FROM application_settings WHERE key = @key").get({ key }) as
			| { value_json: string }
			| undefined;
		return row ? (JSON.parse(row.value_json) as unknown) : undefined;
	}

	setSetting(key: string, value: unknown): void {
		const valueJson = JSON.stringify(value);
		if (!valueJson) throw new RepositoryValidationError("Setting value could not be serialized as JSON");
		this.database
			.prepare(
				`INSERT INTO application_settings (key, value_json, updated_at)
				 VALUES (@key, @valueJson, @updatedAt)
				 ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
			)
			.run({ key, valueJson, updatedAt: this.nowIso() });
	}

	deleteSetting(key: string): boolean {
		return this.database.prepare("DELETE FROM application_settings WHERE key = @key").run({ key }).changes > 0;
	}

	getImport(fingerprint: string): ImportRecord | undefined {
		const row = this.database
			.prepare(
				"SELECT fingerprint, source_key, status, report_json, created_at, completed_at FROM import_migrations WHERE fingerprint = @fingerprint"
			)
			.get({ fingerprint }) as StoredImportRow | undefined;
		return row ? this.importRecord(row) : undefined;
	}

	listImports(): ImportRecord[] {
		const rows = this.database
			.prepare(
				"SELECT fingerprint, source_key, status, report_json, created_at, completed_at FROM import_migrations ORDER BY created_at DESC, fingerprint ASC"
			)
			.all() as StoredImportRow[];
		return rows.map(row => this.importRecord(row));
	}

	putImport(record: {
		fingerprint: string;
		sourceKey?: string;
		status: ImportStatus;
		report: unknown;
		completedAt?: string | null;
	}): ImportRecord {
		const reportJson = JSON.stringify(record.report);
		if (!reportJson) throw new RepositoryValidationError("Import report could not be serialized as JSON");
		const createdAt = this.nowIso();
		this.database
			.prepare(
				`INSERT INTO import_migrations
				 (fingerprint, source_key, status, report_json, created_at, completed_at)
				 VALUES (@fingerprint, @sourceKey, @status, @reportJson, @createdAt, @completedAt)
				 ON CONFLICT (fingerprint) DO UPDATE SET
				 source_key = excluded.source_key,
				 status = excluded.status,
				 report_json = excluded.report_json,
				 completed_at = excluded.completed_at`
			)
			.run({
				fingerprint: record.fingerprint,
				sourceKey: record.sourceKey ?? "unknown",
				status: record.status,
				reportJson,
				createdAt,
				completedAt: record.completedAt ?? (record.status === "completed" ? createdAt : null)
			});
		return this.getImport(record.fingerprint)!;
	}

	deleteImport(fingerprint: string): boolean {
		return this.database.prepare("DELETE FROM import_migrations WHERE fingerprint = @fingerprint").run({ fingerprint }).changes > 0;
	}

	/** Imports one legacy localStorage archive atomically. A completed fingerprint is immutable. */
	migrateLegacyArchive(fingerprint: string, archive: LegacyArchive, report: unknown): { imported: boolean; record: ImportRecord } {
		if (!fingerprint.trim()) throw new RepositoryValidationError("Migration fingerprint is required");
		const existing = this.getImport(fingerprint);
		if (existing?.status === "completed") return { imported: false, record: existing };
		const migrate = this.database.transaction(() => {
			const anyCapture = this.database.prepare("SELECT id FROM capture_documents LIMIT 1").get();
			if (anyCapture) throw new RepositoryConflictError("An archive already exists; refusing to overwrite it during migration");
			for (const folder of archive.folders) this.putFolder(String(folder.id), folder);
			for (const capture of archive.captures) this.putCapture(String(capture.id), capture);
			for (const [position, item] of (archive.sendQueue ?? []).entries()) this.putQueueItem(String(item.id), item, undefined, position);
			for (const item of archive.sendHistory ?? []) this.putHistoryItem(typeof item.id === "string" ? item.id : undefined, item);
			if (archive.sendSettings) this.setSetting("send", archive.sendSettings);
			this.replaceArchiveIndex({
				activeId: archive.activeId ?? null,
				unfiledCollapsed: Boolean(archive.unfiledCollapsed),
				captures: archive.captures.map((capture, position) => ({ id: String(capture.id), folderId: documentFolderId(capture), position })),
				folders: archive.folders.map((folder, position) => ({ id: String(folder.id), position }))
			});
			return this.putImport({ fingerprint, sourceKey: "bus-lens-state-v1", status: "completed", report });
		});
		return { imported: true, record: migrate() };
	}

	private importRecord(row: StoredImportRow): ImportRecord {
		return {
			fingerprint: row.fingerprint,
			sourceKey: row.source_key,
			status: row.status,
			report: JSON.parse(row.report_json) as unknown,
			createdAt: row.created_at,
			completedAt: row.completed_at
		};
	}

	// -----------------------------------------------------------------------
	// Canonical raw chunks / framing / analysis — PR 4
	// -----------------------------------------------------------------------

	/** Convert a single JSON capture document into canonical chunks+frames+analysis. Retains backup until verification succeeds. */
	convertCaptureToCanonical(id: string): ReturnType<typeof convertDocumentCanonical> {
		return convertDocumentCanonical(this.database, id, { nowIso: () => this.nowIso(), generateId: () => this.generateId() });
	}

	/** Migrate all unconverted capture documents. Supports mixed state: converted remain readable. */
	convertAllCaptures(): Array<ReturnType<typeof convertDocumentCanonical>> {
		const ids = (this.database.prepare("SELECT id FROM capture_documents").all() as Array<{ id: string }>).map(r => r.id);
		const results: Array<ReturnType<typeof convertDocumentCanonical>> = [];
		for (const id of ids) {
			if (isCanonicalCaptureConverted(this.database, id)) continue;
			results.push(this.convertCaptureToCanonical(id));
		}
		return results;
	}

	isCaptureConverted(id: string): boolean {
		return isCanonicalCaptureConverted(this.database, id);
	}

	getCaptureBackup(id: string): { document_json: string; verified: number; verification_report_json: string | null } | undefined {
		return this.database.prepare("SELECT document_json, verified, verification_report_json FROM capture_backups WHERE capture_id = @id").get({ id }) as
			| { document_json: string; verified: number; verification_report_json: string | null }
			| undefined;
	}

	listCaptureBackups(): Array<{ capture_id: string; verified: number }> {
		return this.database.prepare("SELECT capture_id, verified FROM capture_backups").all() as Array<{ capture_id: string; verified: number }>;
	}

	getActiveFramingProfile(captureId: string): { id: string; version: number } | undefined {
		return getCanonicalActiveProfile(this.database, captureId);
	}

	listFramingProfiles(captureId: string): Array<{ id: string; version: number; is_active: number; algorithm_version: number }> {
		return this.database
			.prepare("SELECT id, version, is_active, algorithm_version FROM framing_profiles WHERE capture_id = @captureId ORDER BY version")
			.all({ captureId }) as Array<{ id: string; version: number; is_active: number; algorithm_version: number }>;
	}

	getPreviousFramingProfiles(captureId: string): Array<{ id: string; version: number; is_active: number }> {
		return listCanonicalPreviousProfiles(this.database, captureId);
	}

	createFramingRevision(
		captureId: string,
		sections: Array<{ id?: string; start: number; framingMode: string; frameSize?: number; frameMarker?: string; markerPosition?: string; frameTimeGap?: number; collapseRuns?: boolean; collapsed?: boolean }>
	): ReturnType<typeof createCanonicalRevision> {
		// Normalize to expected input shape
		const normalized = sections.map(s => ({
			id: s.id,
			start: Number(s.start) || 0,
			framingMode: (["length", "marker", "time"].includes(String(s.framingMode)) ? s.framingMode : "length") as "length" | "marker" | "time",
			frameSize: s.frameSize,
			frameMarker: s.frameMarker,
			markerPosition: s.markerPosition as "start" | "end" | undefined,
			frameTimeGap: s.frameTimeGap,
			collapseRuns: Boolean(s.collapseRuns),
			collapsed: Boolean(s.collapsed)
		}));
		return createCanonicalRevision(this.database, captureId, normalized, {
			nowIso: () => this.nowIso(),
			generateId: () => this.generateId()
		});
	}

	getFinalizationJobs(captureId: string): Array<{ id: string; status: string; verified: number; error: string | null }> {
		return this.database
			.prepare("SELECT id, status, verified, error FROM finalization_jobs WHERE capture_id = @captureId ORDER BY updated_at DESC")
			.all({ captureId }) as Array<{ id: string; status: string; verified: number; error: string | null }>;
	}

	getFrameSignatures(profileId: string): Array<{ signature: string; count: number }> {
		return this.database.prepare("SELECT signature, count FROM frame_signatures WHERE profile_id = @profileId ORDER BY count DESC").all({ profileId }) as Array<{
			signature: string;
			count: number;
		}>;
	}

	getFrameTransitions(profileId: string): Array<{ from_signature: string; to_signature: string; count: number; diffs: number }> {
		return this.database
			.prepare("SELECT from_signature, to_signature, count, diffs FROM frame_transitions WHERE profile_id = @profileId ORDER BY count DESC")
			.all({ profileId }) as Array<{ from_signature: string; to_signature: string; count: number; diffs: number }>;
	}

	getByteStatistics(profileId: string): Array<{ position: number; value: number; count: number }> {
		return this.database.prepare("SELECT position, value, count FROM byte_statistics WHERE profile_id = @profileId ORDER BY position, count DESC").all({ profileId }) as Array<{
			position: number;
			value: number;
			count: number;
		}>;
	}

	getBitStatistics(profileId: string): Array<{ position: number; bit: number; percentage: number; variance: string }> {
		return this.database.prepare("SELECT position, bit, percentage, variance FROM bit_statistics WHERE profile_id = @profileId ORDER BY position, bit DESC").all({ profileId }) as Array<{
			position: number;
			bit: number;
			percentage: number;
			variance: string;
		}>;
	}

	getSequenceGroups(profileId: string): Array<{ id: string; key_text: string; signatures_json: string; score: number; length: number }> {
		return this.database.prepare("SELECT id, key_text, signatures_json, score, length FROM sequence_groups WHERE profile_id = @profileId ORDER BY score DESC").all({ profileId }) as Array<{
			id: string;
			key_text: string;
			signatures_json: string;
			score: number;
			length: number;
		}>;
	}

	getSequenceOccurrences(groupId: string): Array<{ occurrence_index: number; offset: number; start_frame_ordinal: number; start_raw_offset: number; end_raw_offset: number; length: number }> {
		return this.database
			.prepare("SELECT occurrence_index, offset, start_frame_ordinal, start_raw_offset, end_raw_offset, length FROM sequence_occurrences WHERE group_id = @groupId ORDER BY occurrence_index, offset")
			.all({ groupId }) as Array<{ occurrence_index: number; offset: number; start_frame_ordinal: number; start_raw_offset: number; end_raw_offset: number; length: number }>;
	}

	getStableNotes(captureId: string): Array<{
		id: string;
		text: string;
		created_at: string;
		target_kind: string;
		raw_offset: number | null;
		raw_offsets_json: string | null;
		profile_id: string | null;
		start_offset: number | null;
		end_offset: number | null;
		sequence_key: string | null;
		start_row: number | null;
		end_row: number | null;
	}> {
		return this.database
			.prepare(
				`SELECT id, text, created_at, target_kind, raw_offset, raw_offsets_json, profile_id, start_offset, end_offset, sequence_key, start_row, end_row
				 FROM stable_notes WHERE capture_id = @captureId ORDER BY created_at DESC`
			)
			.all({ captureId }) as Array<{
			id: string;
			text: string;
			created_at: string;
			target_kind: string;
			raw_offset: number | null;
			raw_offsets_json: string | null;
			profile_id: string | null;
			start_offset: number | null;
			end_offset: number | null;
			sequence_key: string | null;
			start_row: number | null;
			end_row: number | null;
		}>;
	}

	close(): void {
		this.database.close();
	}
}

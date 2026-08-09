import type { SqliteDatabase } from "./database.ts";

export const DEFAULT_FRAME_WINDOW_LIMIT = 50;
export const MAX_FRAME_WINDOW_LIMIT = 200;

export type CanonicalCaptureStatus = "canonical" | "legacy-not-canonicalized";

export type CanonicalCaptureSummary = {
	id: string;
	status: CanonicalCaptureStatus;
	name: string;
	lifecycle: string | null;
	byteCount: number | null;
	createdAt: string;
	updatedAt: string;
	folderId: string | null;
};

export type CanonicalCaptureOverview = CanonicalCaptureSummary & {
	rawByteCount: number | null;
	frameCount: number | null;
	activeProfile: { id: string; version: number; algorithmVersion: number } | null;
};

export type CanonicalFrame = {
	id: string;
	ordinal: number;
	sectionId: string;
	rawOffsets: number[];
	bytes: number[];
	timestamps: number[];
	directions: string[];
	hidden: boolean;
	signature: string;
};

export type CanonicalFrameWindow = {
	capture: CanonicalCaptureSummary;
	status: CanonicalCaptureStatus;
	offset: number;
	limit: number;
	totalFrames: number | null;
	hasMore: boolean;
	frames: CanonicalFrame[];
};

type CanonicalSummaryRow = {
	id: string;
	name: string;
	lifecycle: string;
	byte_count: number;
	created_at: string;
	updated_at: string;
	folder_id: string | null;
};

type LegacySummaryRow = {
	id: string;
	name: unknown;
	lifecycle: unknown;
	byte_count: unknown;
	folder_id: unknown;
	created_at: string;
	updated_at: string;
};

type FrameRow = {
	id: string;
	ordinal: number;
	section_id: string;
	raw_offsets_json: string;
	bytes_json: string;
	timestamps_json: string;
	directions_json: string;
	hidden: number;
	signature: string;
};

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function jsonArray<T>(value: string): T[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed as T[] : [];
	} catch {
		return [];
	}
}

function canonicalSummary(row: CanonicalSummaryRow): CanonicalCaptureSummary {
	return {
		id: row.id,
		status: "canonical",
		name: row.name,
		lifecycle: row.lifecycle,
		byteCount: row.byte_count,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		folderId: row.folder_id
	};
}

function legacySummary(row: LegacySummaryRow): CanonicalCaptureSummary {
	return {
		id: row.id,
		status: "legacy-not-canonicalized",
		name: optionalString(row.name) ?? "Untitled capture",
		lifecycle: optionalString(row.lifecycle),
		byteCount: nonNegativeInteger(row.byte_count),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		folderId: optionalString(row.folder_id)
	};
}

/**
 * Bounded reads for future MCP/API consumers. Legacy JSON remains available to
 * the current UI, but this path reads only canonical rows or JSON metadata, so
 * it never materializes a full capture or keeps another full JSON copy alive.
 */
export class CanonicalQueryService {
	private readonly database: SqliteDatabase;

	constructor(database: SqliteDatabase) {
		this.database = database;
	}

	private getCanonicalSummary(captureId: string): CanonicalCaptureSummary | undefined {
		const row = this.database.prepare(
			`SELECT id, name, lifecycle, byte_count, created_at, updated_at, folder_id
			 FROM captures WHERE id = @captureId`
		).get({ captureId }) as CanonicalSummaryRow | undefined;
		return row ? canonicalSummary(row) : undefined;
	}

	private getLegacySummary(captureId: string): CanonicalCaptureSummary | undefined {
		const row = this.database.prepare(
			`SELECT id,
					json_extract(document_json, '$.name') AS name,
					json_extract(document_json, '$.lifecycle') AS lifecycle,
					json_extract(document_json, '$.byteCount') AS byte_count,
					json_extract(document_json, '$.folderId') AS folder_id,
					created_at, updated_at
			 FROM capture_documents
			 WHERE id = @captureId
			   AND NOT EXISTS (SELECT 1 FROM captures WHERE captures.id = capture_documents.id)`
		).get({ captureId }) as LegacySummaryRow | undefined;
		return row ? legacySummary(row) : undefined;
	}

	getCaptureSummary(captureId: string): CanonicalCaptureSummary | undefined {
		return this.getCanonicalSummary(captureId) ?? this.getLegacySummary(captureId);
	}

	listCaptureSummaries(): CanonicalCaptureSummary[] {
		const canonical = this.database.prepare(
			`SELECT id, name, lifecycle, byte_count, created_at, updated_at, folder_id
			 FROM captures ORDER BY updated_at DESC, id ASC`
		).all() as CanonicalSummaryRow[];
		const legacy = this.database.prepare(
			`SELECT id,
					json_extract(document_json, '$.name') AS name,
					json_extract(document_json, '$.lifecycle') AS lifecycle,
					json_extract(document_json, '$.byteCount') AS byte_count,
					json_extract(document_json, '$.folderId') AS folder_id,
					created_at, updated_at
			 FROM capture_documents
			 WHERE NOT EXISTS (SELECT 1 FROM captures WHERE captures.id = capture_documents.id)
			 ORDER BY updated_at DESC, id ASC`
		).all() as LegacySummaryRow[];
		return [...canonical.map(canonicalSummary), ...legacy.map(legacySummary)].sort(
			(left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
		);
	}

	getCaptureOverview(captureId: string): CanonicalCaptureOverview | undefined {
		const summary = this.getCaptureSummary(captureId);
		if (!summary) return undefined;
		if (summary.status === "legacy-not-canonicalized") {
			return { ...summary, rawByteCount: null, frameCount: null, activeProfile: null };
		}

		const profile = this.database.prepare(
			`SELECT id, version, algorithm_version AS algorithmVersion
			 FROM framing_profiles
			 WHERE capture_id = @captureId AND is_active = 1
			 LIMIT 1`
		).get({ captureId }) as { id: string; version: number; algorithmVersion: number } | undefined;
		const frameCount = profile
			? (this.database.prepare("SELECT COUNT(*) AS count FROM materialized_frames WHERE profile_id = @profileId").get({ profileId: profile.id }) as { count: number }).count
			: 0;
		return {
			...summary,
			rawByteCount: summary.byteCount,
			frameCount,
			activeProfile: profile ?? null
		};
	}

	getFrameWindow(captureId: string, offset = 0, limit = DEFAULT_FRAME_WINDOW_LIMIT): CanonicalFrameWindow | undefined {
		if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("frame window offset must be a non-negative integer");
		if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("frame window limit must be a positive integer");
		const boundedLimit = Math.min(limit, MAX_FRAME_WINDOW_LIMIT);
		const summary = this.getCaptureSummary(captureId);
		if (!summary) return undefined;
		if (summary.status === "legacy-not-canonicalized") {
			return { capture: summary, status: summary.status, offset, limit: boundedLimit, totalFrames: null, hasMore: false, frames: [] };
		}

		const profile = this.database.prepare(
			"SELECT id FROM framing_profiles WHERE capture_id = @captureId AND is_active = 1 LIMIT 1"
		).get({ captureId }) as { id: string } | undefined;
		if (!profile) return { capture: summary, status: summary.status, offset, limit: boundedLimit, totalFrames: 0, hasMore: false, frames: [] };
		const totalFrames = (this.database.prepare("SELECT COUNT(*) AS count FROM materialized_frames WHERE profile_id = @profileId").get({ profileId: profile.id }) as { count: number }).count;
		// `offset` is the first ordinal, not a SQL row offset. The ordinal index
		// lets distant windows seek directly without scanning earlier frames.
		const rows = this.database.prepare(
			`SELECT id, ordinal, section_id, raw_offsets_json, bytes_json, timestamps_json,
					directions_json, hidden, signature
			 FROM materialized_frames
			 WHERE profile_id = @profileId
			   AND ordinal >= @offset
			 ORDER BY ordinal
			 LIMIT @limit`
		).all({ profileId: profile.id, limit: boundedLimit, offset }) as FrameRow[];
		return {
			capture: summary,
			status: summary.status,
			offset,
			limit: boundedLimit,
			totalFrames,
			hasMore: offset + rows.length < totalFrames,
			frames: rows.map(row => ({
				id: row.id,
				ordinal: row.ordinal,
				sectionId: row.section_id,
				rawOffsets: jsonArray<number>(row.raw_offsets_json),
				bytes: jsonArray<number>(row.bytes_json),
				timestamps: jsonArray<number>(row.timestamps_json),
				directions: jsonArray<string>(row.directions_json),
				hidden: Boolean(row.hidden),
				signature: row.signature
			}))
		};
	}
}

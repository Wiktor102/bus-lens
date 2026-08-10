import type { SqliteDatabase } from "./database.ts";
import {
	AGENT_NORMAL_RESPONSE_BYTES,
	AgentQueryError,
	assertCursorFilters,
	assertEncodedResponseSize,
	boundedLimit,
	decodeAgentCursor,
	encodeAgentCursor,
	makeAgentResponse,
	type AgentCursorPayload,
	type AgentResponse,
	type AgentSnapshotReference
} from "./agent-contracts.ts";

export const DEFAULT_FRAME_WINDOW_LIMIT = 50;
export const MAX_FRAME_WINDOW_LIMIT = 200;
export const DEFAULT_CAPTURE_DISCOVERY_LIMIT = 20;
export const MAX_CAPTURE_DISCOVERY_LIMIT = 100;
export const MAX_CONTEXT_PARAMETER_FILTERS = 64;

export type CanonicalCaptureStatus = "canonical" | "legacy-not-canonicalized" | "converting" | "canonicalization-failed";

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

export type CaptureDiscoveryFiltersInput = Readonly<{
	nameSearch?: string;
	name?: string;
	folderId?: string | null;
	controllerView?: string;
	view?: string;
	contextParameters?: Readonly<Record<string, string>> | readonly Readonly<{ key: string; value: string }>[];
	parameters?: Readonly<Record<string, string>> | readonly Readonly<{ key: string; value: string }>[];
	createdFrom?: string;
	createdTo?: string;
	lifecycle?: string;
	storageStatus?: CanonicalCaptureStatus | readonly CanonicalCaptureStatus[];
	storage?: CanonicalCaptureStatus | readonly CanonicalCaptureStatus[];
	cursor?: string;
	limit?: number;
}>;

export type NormalizedCaptureDiscoveryFilters = Readonly<{
	nameSearch: string;
	folderId: string | null | undefined;
	controllerView: string | undefined;
	contextParameters: readonly Readonly<{ key: string; value: string }>[];
	createdFrom: string | undefined;
	createdTo: string | undefined;
	lifecycle: string | undefined;
	storageStatus: readonly CanonicalCaptureStatus[];
}>;

export type AgentCaptureSummary = Readonly<{
	id: string;
	status: CanonicalCaptureStatus;
	name: string;
	description: string;
	controllerView: string;
	parameters: readonly Readonly<{ key: string; value: string }>[];
	parametersTruncated?: boolean;
	folderId: string | null;
	lifecycle: string | null;
	byteCount: number | null;
	frameCount: number | null;
	createdAt: string;
	updatedAt: string;
	dataRevision: number | null;
	metadataRevision: number | null;
	contentRevision: number | null;
	retainedStartOffset: number | null;
	activeProfile: Readonly<{
		id: string;
		version: number;
		algorithmVersion: number;
		sourceDataRevision: number;
		retainedStartOffset: number;
		verified: boolean;
		isActive: boolean;
	}> | null;
	conversionGuidance?: string;
}>;

export type AgentCaptureDiscovery = Readonly<{
	captures: readonly AgentCaptureSummary[];
}>;

export type AgentFramingSection = Readonly<{
	id: string;
	position: number;
	startOffset: number;
	framingMode: string;
	frameLength: number | null;
	marker: string | null;
	markerPosition: string | null;
	timeGapMs: number | null;
	collapseRuns: boolean;
	collapsed: boolean;
}>;

export type AgentNoteSummary = Readonly<{
	id: string;
	targetKind: string;
	textPreview: string;
	createdAt: string;
	profileId: string | null;
	rawOffset: number | null;
	startOffset: number | null;
	endOffset: number | null;
	sequenceGroupId: string | null;
}>;

export type AgentSequenceSummary = Readonly<{
	id: string;
	signatures: readonly string[];
	length: number;
	occurrenceCount: number;
	sections: readonly string[];
	cadenceMs: number | null;
	remark: string | null;
	firstOccurrence: Readonly<{ occurrenceNumber: number; startOrdinal: number; timestamp: number | null }> | null;
	lastOccurrence: Readonly<{ occurrenceNumber: number; startOrdinal: number; timestamp: number | null }> | null;
}>;

export type AgentCaptureOverview = Readonly<{
	capture: AgentCaptureSummary;
	snapshot: AgentSnapshotReference | null;
	sections: readonly AgentFramingSection[];
	counts: Readonly<{
		rawBytes: number | null;
		framedBytes: number | null;
		frames: number | null;
		visibleFrames: number | null;
	}>;
	notes: readonly AgentNoteSummary[];
	topSignatures: readonly Readonly<{ signature: string; count: number }>[];
	topTransitions: readonly Readonly<{ fromSignature: string; toSignature: string; count: number; changedPositions: number }>[];
	bytePositions: readonly Readonly<{ position: number; applicableFrameCount: number; vocabularySize: number; variance: string | null }>[];
	sequenceGroups: readonly AgentSequenceSummary[];
	availableBounds: Readonly<{
		raw: Readonly<{ startOffset: number | null; endOffset: number | null }>;
		frames: Readonly<{ startOrdinal: number | null; endOrdinal: number | null }>;
	}>;
	conversionGuidance?: string;
}>;

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
	status: "legacy-not-canonicalized" | "converting" | "canonicalization-failed";
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

type DiscoveryRow = {
	id: string;
	name: unknown;
	description: unknown;
	controller_view: unknown;
	lifecycle: unknown;
	byte_count: unknown;
	created_at: string;
	updated_at: string;
	folder_id: unknown;
	status: CanonicalCaptureStatus;
	data_revision: unknown;
	metadata_revision: unknown;
	content_revision: unknown;
	retained_start_offset: unknown;
	profile_id: string | null;
	profile_version: number | null;
	algorithm_version: number | null;
	profile_source_data_revision: number | null;
	profile_retained_start_offset: number | null;
	profile_verified: number | null;
	profile_is_active: number | null;
	frame_count: number | null;
	raw_start_offset: number | null;
	raw_end_offset: number | null;
	frame_start_ordinal: number | null;
	frame_end_ordinal: number | null;
};

type ProfileRow = {
	id: string;
	capture_id: string;
	version: number;
	algorithm_version: number;
	is_active: number;
	source_data_revision: number | null;
	retained_start_offset: number | null;
	verified: number;
};

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function stringValue(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
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
		status: row.status,
		name: optionalString(row.name) ?? "Untitled capture",
		lifecycle: optionalString(row.lifecycle),
		byteCount: nonNegativeInteger(row.byte_count),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		folderId: optionalString(row.folder_id)
	};
}

function normalizeParameterFilters(
	value: CaptureDiscoveryFiltersInput["contextParameters"]
): readonly Readonly<{ key: string; value: string }>[] {
	if (!value) return [];
	const entries = Array.isArray(value)
		? value.map(item => ({ key: String(item.key ?? "").trim(), value: String(item.value ?? "") }))
		: Object.entries(value).map(([key, item]) => ({ key: key.trim(), value: String(item) }));
	const uniqueEntries = [...new Map(entries.filter(item => item.key.length > 0).map(item => [JSON.stringify([item.key, item.value]), item] as const)).values()];
	if (uniqueEntries.length > MAX_CONTEXT_PARAMETER_FILTERS) {
		throw new AgentQueryError(
			"invalid-input",
			`contextParameters must contain no more than ${MAX_CONTEXT_PARAMETER_FILTERS} unique entries`,
			{ label: "contextParameters", maximum: MAX_CONTEXT_PARAMETER_FILTERS, received: uniqueEntries.length }
		);
	}
	return uniqueEntries.sort((left, right) => left.key.localeCompare(right.key) || left.value.localeCompare(right.value));
}

function normalizeStatusFilters(value: CaptureDiscoveryFiltersInput["storageStatus"]): readonly CanonicalCaptureStatus[] {
	if (!value) return [];
	const values = Array.isArray(value) ? value : [value];
	return [...new Set(values.map(String))] as CanonicalCaptureStatus[];
}

export function normalizeCaptureDiscoveryFilters(input: CaptureDiscoveryFiltersInput = {}): NormalizedCaptureDiscoveryFilters {
	const nameSearch = String(input.nameSearch ?? input.name ?? "").trim().toLocaleLowerCase();
	const controllerViewValue = input.controllerView ?? input.view;
	const controllerView = controllerViewValue === undefined ? undefined : String(controllerViewValue).trim();
	const createdFrom = input.createdFrom === undefined ? undefined : String(input.createdFrom).trim();
	const createdTo = input.createdTo === undefined ? undefined : String(input.createdTo).trim();
	const lifecycle = input.lifecycle === undefined ? undefined : String(input.lifecycle).trim();
	if (createdFrom && createdTo && createdFrom > createdTo) {
		throw new AgentQueryError("invalid-input", "createdFrom must be before createdTo", { createdFrom, createdTo });
	}
	return {
		nameSearch,
		folderId: input.folderId === undefined ? undefined : input.folderId === null ? null : String(input.folderId),
		controllerView: controllerView || undefined,
		contextParameters: normalizeParameterFilters(input.contextParameters ?? input.parameters),
		createdFrom: createdFrom || undefined,
		createdTo: createdTo || undefined,
		lifecycle: lifecycle || undefined,
		storageStatus: normalizeStatusFilters(input.storageStatus ?? input.storage)
	};
}

function paramsObject(filters: NormalizedCaptureDiscoveryFilters): Record<string, unknown> {
	return {
		nameSearch: filters.nameSearch,
		folderId: filters.folderId,
		controllerView: filters.controllerView,
		contextParameters: filters.contextParameters,
		createdFrom: filters.createdFrom,
		createdTo: filters.createdTo,
		lifecycle: filters.lifecycle,
		storageStatus: filters.storageStatus
	};
}

function capturePredicate(alias: string, filters: NormalizedCaptureDiscoveryFilters, canonical: boolean): { sql: string; params: Record<string, unknown> } {
	const clauses: string[] = [];
	const params: Record<string, unknown> = {};
	const nameExpression = canonical
		? `${alias}.name`
		: `COALESCE(CAST(json_extract(${alias}.document_json, '$.name') AS TEXT), '')`;
	const folderExpression = canonical ? `${alias}.folder_id` : `json_extract(${alias}.document_json, '$.folderId')`;
	const viewExpression = canonical ? `${alias}.controller_view` : `json_extract(${alias}.document_json, '$.view')`;
	if (filters.nameSearch) {
		clauses.push(`LOWER(COALESCE(${nameExpression}, '')) LIKE @nameSearch`);
		params.nameSearch = `%${filters.nameSearch}%`;
	}
	if (filters.folderId !== undefined) {
		clauses.push(filters.folderId === null ? `${folderExpression} IS NULL` : `${folderExpression} = @folderId`);
		if (filters.folderId !== null) params.folderId = filters.folderId;
	}
	if (filters.controllerView) {
		clauses.push(`${viewExpression} = @controllerView`);
		params.controllerView = filters.controllerView;
	}
	if (filters.createdFrom) {
		clauses.push(`${alias}.created_at >= @createdFrom`);
		params.createdFrom = filters.createdFrom;
	}
	if (filters.createdTo) {
		clauses.push(`${alias}.created_at <= @createdTo`);
		params.createdTo = filters.createdTo;
	}
	if (filters.lifecycle) {
		const lifecycleExpression = canonical ? `${alias}.lifecycle` : `json_extract(${alias}.document_json, '$.lifecycle')`;
		clauses.push(`${lifecycleExpression} = @lifecycle`);
		params.lifecycle = filters.lifecycle;
	}
	filters.contextParameters.forEach((parameter, index) => {
		const key = `parameterKey${index}`;
		const value = `parameterValue${index}`;
		if (canonical) {
			clauses.push(`EXISTS (SELECT 1 FROM capture_parameters cp${index}
				WHERE cp${index}.capture_id = ${alias}.id
				  AND cp${index}.key_text = @${key}
				  AND cp${index}.value_text = @${value})`);
		} else {
			clauses.push(`EXISTS (SELECT 1 FROM json_each(${alias}.document_json, '$.params') parameter${index}
				WHERE json_extract(parameter${index}.value, '$.key') = @${key}
				  AND CAST(json_extract(parameter${index}.value, '$.value') AS TEXT) = @${value})`);
		}
		params[key] = parameter.key;
		params[value] = parameter.value;
	});
	return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

function markerText(value: string | null): string | null {
	if (!value) return null;
	const bytes = jsonArray<number>(value);
	return bytes.length ? bytes.map(byte => Number(byte).toString(16).padStart(2, "0").toUpperCase()).join(" ") : null;
}

function previewText(text: string, max = 240): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class CanonicalQueryService {
	private readonly database: SqliteDatabase;

	constructor(database: SqliteDatabase) {
		this.database = database;
	}

	private getCanonicalSummary(captureId: string): CanonicalCaptureSummary | undefined {
		const row = this.database.prepare(
			`SELECT captures.id, captures.name, captures.lifecycle, captures.byte_count,
			        captures.created_at, captures.updated_at, captures.folder_id
			 FROM capture_storage
			 JOIN captures ON captures.id = capture_storage.capture_id
			 WHERE capture_storage.capture_id = @captureId AND capture_storage.status = 'canonical'`
		).get({ captureId }) as CanonicalSummaryRow | undefined;
		return row ? canonicalSummary(row) : undefined;
	}

	private getLegacySummary(captureId: string): CanonicalCaptureSummary | undefined {
		const row = this.database.prepare(
			`SELECT documents.id,
					json_extract(document_json, '$.name') AS name,
					json_extract(document_json, '$.lifecycle') AS lifecycle,
					json_extract(document_json, '$.byteCount') AS byte_count,
					json_extract(document_json, '$.folderId') AS folder_id,
					documents.created_at, documents.updated_at, capture_storage.status
			 FROM capture_storage
			 JOIN capture_documents AS documents ON documents.id = capture_storage.capture_id
			 WHERE capture_storage.capture_id = @captureId
			   AND capture_storage.status IN ('legacy-not-canonicalized','converting','canonicalization-failed')`
		).get({ captureId }) as LegacySummaryRow | undefined;
		return row ? legacySummary(row) : undefined;
	}

	getCaptureSummary(captureId: string): CanonicalCaptureSummary | undefined {
		return this.getCanonicalSummary(captureId) ?? this.getLegacySummary(captureId);
	}

	listCaptureSummaries(): CanonicalCaptureSummary[] {
		const canonical = this.database.prepare(
			`SELECT captures.id, captures.name, captures.lifecycle, captures.byte_count,
			        captures.created_at, captures.updated_at, captures.folder_id
			 FROM capture_storage
			 JOIN captures ON captures.id = capture_storage.capture_id
			 WHERE capture_storage.status = 'canonical'
			 ORDER BY captures.updated_at DESC, captures.id ASC`
		).all() as CanonicalSummaryRow[];
		const legacy = this.database.prepare(
			`SELECT documents.id,
					json_extract(document_json, '$.name') AS name,
					json_extract(document_json, '$.lifecycle') AS lifecycle,
					json_extract(document_json, '$.byteCount') AS byte_count,
					json_extract(document_json, '$.folderId') AS folder_id,
					documents.created_at, documents.updated_at, capture_storage.status
			 FROM capture_storage
			 JOIN capture_documents AS documents ON documents.id = capture_storage.capture_id
			 WHERE capture_storage.status IN ('legacy-not-canonicalized','converting','canonicalization-failed')
			 ORDER BY documents.updated_at DESC, documents.id ASC`
		).all() as LegacySummaryRow[];
		return [...canonical.map(canonicalSummary), ...legacy.map(legacySummary)].sort(
			(left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
		);
	}

	private readParameters(captureId: string, canonical: boolean): { parameters: Array<{ key: string; value: string }>; truncated: boolean } {
		if (canonical) {
			const rows = this.database.prepare(
				`SELECT key_text, value_text FROM capture_parameters
				 WHERE capture_id = @captureId ORDER BY position LIMIT 33`
			).all({ captureId }) as Array<{ key_text: string; value_text: string }>;
			return {
				parameters: rows.slice(0, 32).map(row => ({ key: row.key_text, value: row.value_text })),
				truncated: rows.length > 32
			};
		}
		const rows = this.database.prepare(
			`SELECT json_extract(parameter.value, '$.key') AS key_text,
			        CAST(json_extract(parameter.value, '$.value') AS TEXT) AS value_text
			 FROM capture_documents AS documents, json_each(documents.document_json, '$.params') AS parameter
			 WHERE documents.id = @captureId
			 ORDER BY CAST(parameter.key AS INTEGER) LIMIT 33`
		).all({ captureId }) as Array<{ key_text: unknown; value_text: unknown }>;
		return {
			parameters: rows.slice(0, 32).flatMap(row => {
				const key = optionalString(row.key_text);
				return key ? [{ key, value: stringValue(row.value_text) }] : [];
			}),
			truncated: rows.length > 32
		};
	}

	private readDiscoveryRows(filters: NormalizedCaptureDiscoveryFilters, limit: number, cursor?: string, captureId?: string): DiscoveryRow[] {
		const canonicalPredicate = capturePredicate("captures", filters, true);
		const legacyPredicate = capturePredicate("documents", filters, false);
		const cursorPayload = cursor ? decodeAgentCursor(cursor, "capture-discovery") : undefined;
		if (cursorPayload) assertCursorFilters(cursorPayload, paramsObject(filters));
		const cursorParams = cursorPayload?.key ?? {};
		const keyset = cursorPayload ? " AND (updated_at < @cursorUpdatedAt OR (updated_at = @cursorUpdatedAt AND id > @cursorId))" : "";
		const requestedCapture = captureId ? " AND id = @requestedCaptureId" : "";
		const statusFilter = filters.storageStatus.length
			? " AND status IN (" + filters.storageStatus.map((_status, index) => `@storageStatus${index}`).join(", ") + ")"
			: "";
		const params = {
			...canonicalPredicate.params,
			...legacyPredicate.params,
			cursorUpdatedAt: cursorParams.updatedAt,
			cursorId: cursorParams.id,
			requestedCaptureId: captureId,
			...Object.fromEntries(filters.storageStatus.map((status, index) => [`storageStatus${index}`, status])),
			limit: limit + 1
		};
		const rows = this.database.prepare(
			`SELECT id, name, description, controller_view, lifecycle, byte_count, created_at, updated_at, folder_id,
			        status, data_revision, metadata_revision, content_revision, retained_start_offset,
			        profile_id, profile_version, algorithm_version, profile_source_data_revision,
			        profile_retained_start_offset, profile_verified, profile_is_active, frame_count,
			        raw_start_offset, raw_end_offset, frame_start_ordinal, frame_end_ordinal
			 FROM (
				 SELECT captures.id,
				        captures.name,
				        captures.description,
				        captures.controller_view,
				        captures.lifecycle,
				        captures.byte_count,
				        captures.created_at,
				        captures.updated_at,
				        captures.folder_id,
				        capture_storage.status,
				        captures.data_revision,
				        captures.metadata_revision,
				        captures.content_revision,
				        captures.retained_start_offset,
				        profiles.id AS profile_id,
				        profiles.version AS profile_version,
				        profiles.algorithm_version,
				        profiles.source_data_revision AS profile_source_data_revision,
				        profiles.retained_start_offset AS profile_retained_start_offset,
				        profiles.verified AS profile_verified,
				        profiles.is_active AS profile_is_active,
				        (SELECT COUNT(*) FROM materialized_frames frame_count_rows WHERE frame_count_rows.profile_id = profiles.id) AS frame_count,
				        (SELECT MIN(start_offset) FROM raw_chunks WHERE raw_chunks.capture_id = captures.id) AS raw_start_offset,
				        (SELECT MAX(start_offset + byte_count - 1) FROM raw_chunks WHERE raw_chunks.capture_id = captures.id) AS raw_end_offset,
				        (SELECT MIN(ordinal) FROM materialized_frames frame_start_rows WHERE frame_start_rows.profile_id = profiles.id) AS frame_start_ordinal,
				        (SELECT MAX(ordinal) FROM materialized_frames frame_end_rows WHERE frame_end_rows.profile_id = profiles.id) AS frame_end_ordinal
				 FROM captures
				 JOIN capture_storage ON capture_storage.capture_id = captures.id AND capture_storage.status = 'canonical'
				 LEFT JOIN framing_profiles profiles ON profiles.id = captures.active_framing_profile_id
				 WHERE 1 = 1${canonicalPredicate.sql}
				 UNION ALL
				 SELECT documents.id,
				        json_extract(documents.document_json, '$.name'),
				        json_extract(documents.document_json, '$.description'),
				        json_extract(documents.document_json, '$.view'),
				        json_extract(documents.document_json, '$.lifecycle'),
				        json_extract(documents.document_json, '$.byteCount'),
				        documents.created_at,
				        documents.updated_at,
				        json_extract(documents.document_json, '$.folderId'),
				        capture_storage.status,
				        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
				        NULL, NULL, NULL, NULL
				 FROM capture_documents documents
				 JOIN capture_storage ON capture_storage.capture_id = documents.id AND capture_storage.status <> 'canonical'
				 WHERE 1 = 1${legacyPredicate.sql}
			 )
			 WHERE 1 = 1${requestedCapture}${statusFilter}${keyset}
			 ORDER BY updated_at DESC, id ASC
			 LIMIT @limit`
		).all(params) as DiscoveryRow[];
		return rows;
	}

	private mapAgentCaptureSummary(row: DiscoveryRow): AgentCaptureSummary {
		const canonical = row.status === "canonical";
		const parameters = this.readParameters(row.id, canonical);
		return {
			id: row.id,
			status: row.status,
			name: optionalString(row.name) ?? "Untitled capture",
			description: optionalString(row.description) ?? "",
			controllerView: optionalString(row.controller_view) ?? "",
			parameters: parameters.parameters,
			...(parameters.truncated ? { parametersTruncated: true } : {}),
			folderId: optionalString(row.folder_id),
			lifecycle: optionalString(row.lifecycle),
			byteCount: nonNegativeInteger(row.byte_count),
			frameCount: nonNegativeInteger(row.frame_count),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			dataRevision: nonNegativeInteger(row.data_revision),
			metadataRevision: nonNegativeInteger(row.metadata_revision),
			contentRevision: nonNegativeInteger(row.content_revision),
			retainedStartOffset: nonNegativeInteger(row.retained_start_offset),
			activeProfile: row.profile_id && row.profile_version !== null
				? {
					id: row.profile_id,
					version: row.profile_version,
					algorithmVersion: row.algorithm_version ?? 1,
					sourceDataRevision: row.profile_source_data_revision ?? 0,
					retainedStartOffset: row.profile_retained_start_offset ?? 0,
					verified: Boolean(row.profile_verified),
					isActive: Boolean(row.profile_is_active)
				}
				: null,
			...(canonical ? {} : { conversionGuidance: "Convert this legacy capture in the Bus Lens UI before requesting analytical evidence." })
		};
	}

	queryCaptureDiscovery(input: CaptureDiscoveryFiltersInput = {}): AgentResponse<AgentCaptureDiscovery> {
		const filters = normalizeCaptureDiscoveryFilters(input);
		const limit = boundedLimit(input.limit, DEFAULT_CAPTURE_DISCOVERY_LIMIT, MAX_CAPTURE_DISCOVERY_LIMIT);
		const rows = this.readDiscoveryRows(filters, limit, input.cursor);
		let pageRows = rows.slice(0, limit);
		let hasMore = rows.length > pageRows.length;
		const mappedRows = () => pageRows.map(row => this.mapAgentCaptureSummary(row));
		// A caller may request the maximum page size, but the encoded response
		// target still wins. Rows are complete records; only the number of rows is
		// reduced and the keyset cursor makes the reduction explicit to the caller.
		while (pageRows.length > 1) {
			const estimated = JSON.stringify({ captures: mappedRows() }).length;
			if (estimated <= AGENT_NORMAL_RESPONSE_BYTES) break;
			pageRows = pageRows.slice(0, Math.max(1, Math.floor(pageRows.length / 2)));
			hasMore = true;
		}
		const last = pageRows.at(-1);
		const nextCursor = hasMore && last
			? encodeAgentCursor({
				contractVersion: 1,
				scope: "capture-discovery",
				filters: paramsObject(filters),
				key: { updatedAt: last.updated_at, id: last.id }
			})
			: undefined;
		const response = makeAgentResponse({
			data: { captures: mappedRows() },
			appliedFilters: paramsObject(filters),
			returned: pageRows.length,
			nextCursor,
			truncated: hasMore,
			suggestedOperations: hasMore ? [{ tool: "list_captures", reason: "More captures match these filters", arguments: { cursor: nextCursor } }] : []
		});
		assertEncodedResponseSize(response);
		return response;
	}

	private resolveProfile(captureId: string, requested?: Partial<AgentSnapshotReference>): { profile: ProfileRow; snapshot: AgentSnapshotReference } {
		const capture = this.database.prepare(
			"SELECT id, data_revision, active_framing_profile_id FROM captures WHERE id = @captureId"
		).get({ captureId }) as { id: string; data_revision: number; active_framing_profile_id: string | null } | undefined;
		if (!capture) throw new AgentQueryError("not-found", "Capture was not found", { captureId });
		const profileId = requested?.profileId ?? capture.active_framing_profile_id;
		if (!profileId) throw new AgentQueryError("evidence-missing", "Capture has no framing profile", { captureId });
		const profile = this.database.prepare(
			`SELECT id, capture_id, version, algorithm_version, is_active, source_data_revision,
			        retained_start_offset, verified
			 FROM framing_profiles WHERE id = @profileId AND capture_id = @captureId`
		).get({ profileId, captureId }) as ProfileRow | undefined;
		if (!profile) throw new AgentQueryError("snapshot-mismatch", "The requested framing profile is not available for this capture", { captureId, profileId });
		if (requested?.profileVersion !== undefined && profile.version !== requested.profileVersion) {
			throw new AgentQueryError("snapshot-mismatch", "The requested framing profile version is not available", { captureId, profileId, profileVersion: requested.profileVersion });
		}
		const sourceDataRevision = profile.source_data_revision ?? capture.data_revision;
		if (requested?.sourceDataRevision !== undefined && sourceDataRevision !== requested.sourceDataRevision) {
			throw new AgentQueryError("snapshot-mismatch", "The requested source data revision is not available", { captureId, profileId, sourceDataRevision: requested.sourceDataRevision });
		}
		return {
			profile,
			snapshot: { captureId, profileId: profile.id, profileVersion: profile.version, sourceDataRevision }
		};
	}

	private readAgentOverview(captureId: string, requested?: Partial<AgentSnapshotReference>): AgentCaptureOverview {
		const summary = this.getCaptureSummary(captureId);
		if (!summary) throw new AgentQueryError("not-found", "Capture was not found", { captureId });
		const agentSummaryRow = this.readDiscoveryRows(normalizeCaptureDiscoveryFilters({}), 1, undefined, captureId)[0];
		if (!agentSummaryRow) throw new AgentQueryError("not-found", "Capture was not found", { captureId });
		const capture = this.mapAgentCaptureSummary(agentSummaryRow);
		if (summary.status !== "canonical") {
			return {
				capture,
				snapshot: null,
				sections: [],
				counts: { rawBytes: null, framedBytes: null, frames: null, visibleFrames: null },
				notes: [],
				topSignatures: [],
				topTransitions: [],
				bytePositions: [],
				sequenceGroups: [],
				availableBounds: { raw: { startOffset: null, endOffset: null }, frames: { startOrdinal: null, endOrdinal: null } },
				conversionGuidance: "Convert this legacy capture in the Bus Lens UI before requesting analytical evidence."
			};
		}
		const { profile, snapshot } = this.resolveProfile(captureId, requested);
		const sections = this.database.prepare(
			`SELECT id, position, start_offset, framing_mode, frame_length, marker_bytes, marker_position,
			        time_gap_ms, collapse_runs, collapsed
			 FROM framing_sections WHERE profile_id = @profileId ORDER BY position`
		).all({ profileId: profile.id }) as Array<{
			id: string; position: number; start_offset: number; framing_mode: string; frame_length: number | null;
			marker_bytes: string | null; marker_position: string | null; time_gap_ms: number | null; collapse_runs: number; collapsed: number;
		}>;
		const frameCount = (this.database.prepare("SELECT COUNT(*) AS count FROM materialized_frames WHERE profile_id = @profileId").get({ profileId: profile.id }) as { count: number }).count;
		const visibleFrames = (this.database.prepare("SELECT COUNT(*) AS count FROM materialized_frames WHERE profile_id = @profileId AND hidden = 0").get({ profileId: profile.id }) as { count: number }).count;
		const rawBounds = this.database.prepare(
			"SELECT MIN(start_offset) AS start_offset, MAX(start_offset + byte_count - 1) AS end_offset FROM raw_chunks WHERE capture_id = @captureId"
		).get({ captureId }) as { start_offset: number | null; end_offset: number | null };
		const frameBounds = this.database.prepare(
			"SELECT MIN(ordinal) AS start_ordinal, MAX(ordinal) AS end_ordinal FROM materialized_frames WHERE profile_id = @profileId"
		).get({ profileId: profile.id }) as { start_ordinal: number | null; end_ordinal: number | null };
		const noteRows = this.database.prepare(
			`SELECT id, target_kind, text, created_at, profile_id, raw_offset, start_offset, end_offset, sequence_group_id
			 FROM stable_notes WHERE capture_id = @captureId ORDER BY created_at DESC LIMIT 17`
		).all({ captureId }) as Array<{ id: string; target_kind: string; text: string; created_at: string; profile_id: string | null; raw_offset: number | null; start_offset: number | null; end_offset: number | null; sequence_group_id: string | null }>;
		const signatureRows = this.database.prepare(
			"SELECT signature, count FROM frame_signatures WHERE profile_id = @profileId ORDER BY count DESC, signature ASC LIMIT 13"
		).all({ profileId: profile.id }) as Array<{ signature: string; count: number }>;
		const transitionRows = this.database.prepare(
			`SELECT from_signature, to_signature, count, diffs
			 FROM frame_transitions WHERE profile_id = @profileId
			 ORDER BY count DESC, from_signature ASC, to_signature ASC LIMIT 13`
		).all({ profileId: profile.id }) as Array<{ from_signature: string; to_signature: string; count: number; diffs: number }>;
		const byteRows = this.database.prepare(
			`SELECT position, SUM(count) AS applicable_frame_count, COUNT(*) AS vocabulary_size
			 FROM byte_statistics WHERE profile_id = @profileId
			 GROUP BY position ORDER BY position LIMIT 33`
		).all({ profileId: profile.id }) as Array<{ position: number; applicable_frame_count: number; vocabulary_size: number }>;
		const varianceRows = this.database.prepare(
			"SELECT position, variance FROM bit_statistics WHERE profile_id = @profileId GROUP BY position ORDER BY position LIMIT 33"
		).all({ profileId: profile.id }) as Array<{ position: number; variance: string }>;
		const varianceByPosition = new Map(varianceRows.map(row => [row.position, row.variance]));
		const groupRows = this.database.prepare(
			`SELECT groups.id, groups.signatures_json, groups.length,
			        COUNT(DISTINCT occurrences.occurrence_index) AS occurrence_count,
			        MIN(occurrences.start_frame_ordinal) AS first_ordinal,
			        MAX(occurrences.start_frame_ordinal) AS last_ordinal,
			        MIN(occurrences.start_raw_offset) AS first_raw_offset,
			        MAX(occurrences.end_raw_offset) AS last_raw_offset
			 FROM sequence_groups groups
			 LEFT JOIN sequence_occurrences occurrences ON occurrences.group_id = groups.id
			 WHERE groups.profile_id = @profileId
			 GROUP BY groups.id ORDER BY occurrence_count DESC, groups.id ASC LIMIT 13`
		).all({ profileId: profile.id }) as Array<{ id: string; signatures_json: string; length: number; occurrence_count: number; first_ordinal: number | null; last_ordinal: number | null; first_raw_offset: number | null; last_raw_offset: number | null }>;
		const sequenceGroups: AgentSequenceSummary[] = groupRows.slice(0, 12).map(row => {
			const occurrenceTimes = this.database.prepare(
				`SELECT occurrence_index, start_frame_ordinal, MIN(timestamps_json) AS timestamps_json
				 FROM sequence_occurrences
				 LEFT JOIN materialized_frames ON materialized_frames.profile_id = @profileId AND materialized_frames.ordinal = sequence_occurrences.start_frame_ordinal
				 WHERE group_id = @groupId GROUP BY occurrence_index, start_frame_ordinal
				 ORDER BY occurrence_index LIMIT 1`
			).get({ profileId: profile.id, groupId: row.id }) as { occurrence_index: number; start_frame_ordinal: number; timestamps_json: string | null } | undefined;
			const lastOccurrence = this.database.prepare(
				`SELECT occurrence_index, start_frame_ordinal
				 FROM sequence_occurrences WHERE group_id = @groupId ORDER BY occurrence_index DESC LIMIT 1`
			).get({ groupId: row.id }) as { occurrence_index: number; start_frame_ordinal: number } | undefined;
			const note = this.database.prepare(
				"SELECT text FROM stable_notes WHERE sequence_group_id = @groupId OR (target_kind = 'pattern' AND sequence_key = @sequenceKey) ORDER BY created_at DESC LIMIT 1"
			).get({ groupId: row.id, sequenceKey: row.id }) as { text: string } | undefined;
			return {
				id: row.id,
				signatures: jsonArray<string>(row.signatures_json),
				length: row.length,
				occurrenceCount: row.occurrence_count,
				sections: [],
				cadenceMs: null,
				remark: note ? previewText(note.text) : null,
				firstOccurrence: occurrenceTimes ? { occurrenceNumber: occurrenceTimes.occurrence_index, startOrdinal: occurrenceTimes.start_frame_ordinal, timestamp: occurrenceTimes.timestamps_json ? (jsonArray<number>(occurrenceTimes.timestamps_json)[0] ?? null) : null } : null,
				lastOccurrence: lastOccurrence ? { occurrenceNumber: lastOccurrence.occurrence_index, startOrdinal: lastOccurrence.start_frame_ordinal, timestamp: null } : null
			};
		});
		return {
			capture,
			snapshot,
			sections: sections.map(section => ({
				id: section.id,
				position: section.position,
				startOffset: section.start_offset,
				framingMode: section.framing_mode,
				frameLength: section.frame_length,
				marker: markerText(section.marker_bytes),
				markerPosition: section.marker_position,
				timeGapMs: section.time_gap_ms,
				collapseRuns: Boolean(section.collapse_runs),
				collapsed: Boolean(section.collapsed)
			})),
			counts: { rawBytes: capture.byteCount, framedBytes: capture.byteCount, frames: frameCount, visibleFrames },
			notes: noteRows.slice(0, 16).map(row => ({ id: row.id, targetKind: row.target_kind, textPreview: previewText(row.text), createdAt: row.created_at, profileId: row.profile_id, rawOffset: row.raw_offset, startOffset: row.start_offset, endOffset: row.end_offset, sequenceGroupId: row.sequence_group_id })),
			topSignatures: signatureRows.slice(0, 12),
			topTransitions: transitionRows.slice(0, 12).map(row => ({ fromSignature: row.from_signature, toSignature: row.to_signature, count: row.count, changedPositions: row.diffs })),
			bytePositions: byteRows.slice(0, 32).map(row => ({ position: row.position, applicableFrameCount: row.applicable_frame_count, vocabularySize: row.vocabulary_size, variance: varianceByPosition.get(row.position) ?? null })),
			sequenceGroups,
			availableBounds: { raw: { startOffset: rawBounds.start_offset, endOffset: rawBounds.end_offset }, frames: { startOrdinal: frameBounds.start_ordinal, endOrdinal: frameBounds.end_ordinal } }
		};
	}

	queryCaptureOverview(captureId: string, snapshot?: Partial<AgentSnapshotReference>): AgentResponse<AgentCaptureOverview> {
		const data = this.readAgentOverview(captureId, snapshot);
		const response = makeAgentResponse({
			data,
			appliedFilters: { captureId, ...(snapshot ?? {}) },
			snapshot: data.snapshot ?? undefined,
			truncated: false,
			suggestedOperations: data.snapshot ? [{ tool: "query_messages", reason: "Inspect selected evidence after reviewing the bounded overview", arguments: { captureId, profileId: data.snapshot.profileId, profileVersion: data.snapshot.profileVersion, sourceDataRevision: data.snapshot.sourceDataRevision } }] : []
		});
		assertEncodedResponseSize(response);
		return response;
	}

	getCaptureOverview(captureId: string): CanonicalCaptureOverview | undefined {
		const summary = this.getCaptureSummary(captureId);
		if (!summary) return undefined;
		if (summary.status !== "canonical") {
			return { ...summary, rawByteCount: null, frameCount: null, activeProfile: null };
		}

		const profile = this.database.prepare(
			`SELECT framing_profiles.id, framing_profiles.version, framing_profiles.algorithm_version AS algorithmVersion
			 FROM captures
			 JOIN framing_profiles ON framing_profiles.id = captures.active_framing_profile_id
			 WHERE captures.id = @captureId LIMIT 1`
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
		const boundedFrameLimit = Math.min(limit, MAX_FRAME_WINDOW_LIMIT);
		const summary = this.getCaptureSummary(captureId);
		if (!summary) return undefined;
		if (summary.status !== "canonical") {
			return { capture: summary, status: summary.status, offset, limit: boundedFrameLimit, totalFrames: null, hasMore: false, frames: [] };
		}

		const profile = this.database.prepare(
			`SELECT framing_profiles.id FROM captures
			 JOIN framing_profiles ON framing_profiles.id = captures.active_framing_profile_id
			 WHERE captures.id = @captureId LIMIT 1`
		).get({ captureId }) as { id: string } | undefined;
		if (!profile) return { capture: summary, status: summary.status, offset, limit: boundedFrameLimit, totalFrames: 0, hasMore: false, frames: [] };
		const totalFrames = (this.database.prepare("SELECT COUNT(*) AS count FROM materialized_frames WHERE profile_id = @profileId").get({ profileId: profile.id }) as { count: number }).count;
		const rows = this.database.prepare(
			`SELECT id, ordinal, section_id, raw_offsets_json, bytes_json, timestamps_json,
			        directions_json, hidden, signature
			 FROM materialized_frames
			 WHERE profile_id = @profileId
			   AND ordinal >= @offset
			 ORDER BY ordinal
			 LIMIT @limit`
		).all({ profileId: profile.id, limit: boundedFrameLimit, offset }) as FrameRow[];
		return {
			capture: summary,
			status: summary.status,
			offset,
			limit: boundedFrameLimit,
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

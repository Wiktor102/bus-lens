import { MAX_SEND_HISTORY, type SendHistoryEntry, type SendQueueEntry, type SendSettings, type StoredFolder } from "../../shared/app-state.ts";
import {
	hexByte,
	makeMessage,
	normalizeCapture,
	parseTime,
	rebuildPreview,
	signature,
	visibleByteEntries,
	type Capture,
	type CaptureMessage,
	type CaptureSection
} from "../capture/capture-framing.ts";
import { recognizeMessagePatterns } from "../analysis/analysis.ts";
import type { ExportFormat } from "../dialogs/dialog-model.ts";
import type { ArchiveCommands } from "../../data/archive-data-layer.ts";
import type { ArchiveIndex } from "../../persistence/archive-client.ts";

export type DataTransferFile = {
	name: string;
	text: () => Promise<string>;
};

export type Download = (content: string, filename: string, type: string) => void;

export type DataTransferTimeDependencies = {
	generateId?: () => string;
	now?: () => number;
	nowIso?: () => string;
};

export type DataTransferState = {
	captures: Capture[];
	folders: StoredFolder[];
	sendHistory: SendHistoryEntry[];
	sendQueue: SendQueueEntry[];
	sendSettings: SendSettings;
};

export type DataTransferDependencies = DataTransferTimeDependencies & {
	/** Test-only compatibility input; production reads come from TanStack Query. */
	state?: DataTransferState;
	capture: () => Capture | undefined;
	getCaptures?: () => readonly CaptureIndexEntry[] | undefined;
	getFolders?: () => readonly StoredFolder[] | undefined;
	getQueue?: () => readonly SendQueueEntry[] | undefined;
	getHistory?: () => readonly SendHistoryEntry[] | undefined;
	getSettings?: () => SendSettings | undefined;
	getArchiveIndex?: () => ArchiveIndex | undefined;
	getActiveId: () => string | null | undefined;
	setActiveId: (captureId: string | null | undefined) => void;
	setActiveCapture?: (capture: Capture | undefined) => void;
	setSelectedCaptureId?: (captureId: string | null) => void;
	archiveCommands?: ArchiveCommands;
	render: () => void;
	showToast: (message: string) => void;
	download: Download;
};

type CaptureIndexEntry = Pick<Capture, "id" | "name" | "folderId" | "storageStatus">;

export type DataTransferController = {
	importFile: (file: DataTransferFile) => Promise<void>;
	exportData: (format: ExportFormat) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveTimeDependencies(dependencies: DataTransferTimeDependencies = {}) {
	const now = dependencies.now || Date.now;
	return {
		generateId: dependencies.generateId || (() => crypto.randomUUID()),
		now,
		nowIso: dependencies.nowIso || (() => new Date(now()).toISOString())
	};
}

function parseCsvRows(text: string): string[][] {
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let justClosedQuote = false;

	const appendRow = () => {
		if (row.some(value => value.length > 0) || field.length > 0) rows.push([...row, field]);
		row = [];
		field = "";
		justClosedQuote = false;
	};

	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (inQuotes) {
			if (character === '"') {
				if (source[index + 1] === '"') {
					field += '"';
					index += 1;
				} else {
					inQuotes = false;
					justClosedQuote = true;
				}
			} else {
				field += character;
			}
			continue;
		}
		if (character === '"') {
			if (field.length > 0 || justClosedQuote) throw new Error("Malformed CSV: unexpected quote");
			inQuotes = true;
			continue;
		}
		if (justClosedQuote) {
			if (character === ",") {
				row.push(field);
				field = "";
				justClosedQuote = false;
				continue;
			}
			if (character !== "\r" && character !== "\n") throw new Error("Malformed CSV: expected a comma or line break after a quoted field");
		}
		if (character === ",") {
			row.push(field);
			field = "";
			continue;
		}
		if (character === "\r" || character === "\n") {
			appendRow();
			if (character === "\r" && source[index + 1] === "\n") index += 1;
			continue;
		}
		field += character;
	}
	if (inQuotes) throw new Error("Malformed CSV: unterminated quoted field");
	if (row.length || field.length || justClosedQuote) appendRow();
	return rows;
}

function parseCsvTimestamp(value: string, rowNumber: number, column: string): number {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`CSV row ${rowNumber} has no ${column}`);
	const numeric = Number(trimmed);
	if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed) && Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(trimmed);
	if (Number.isFinite(parsed)) return parsed;
	throw new Error(`CSV row ${rowNumber} has an invalid ${column}: ${trimmed}`);
}

function parseCsvHex(value: string, rowNumber: number, column: string): number[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	const parts = trimmed.split(/\s+/);
	const invalid = parts.find(part => !/^[0-9a-f]{2}$/i.test(part));
	if (invalid) throw new Error(`CSV row ${rowNumber} has an invalid ${column} byte: ${invalid}`);
	return parts.map(part => Number.parseInt(part, 16));
}

function sameBytes(left: readonly number[], right: readonly number[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function parseCsv(text: string, dependencies: DataTransferTimeDependencies = {}): Capture[] {
	const { generateId, nowIso } = resolveTimeDependencies(dependencies);
	const rows = parseCsvRows(text);
	if (!rows.length) throw new Error("CSV contains no rows");
	const headers = rows[0].map(value => value.trim().toLowerCase());
	const headerIndex = new Map<string, number>();
	headers.forEach((header, index) => {
		if (!header) throw new Error("CSV has an empty column name");
		if (headerIndex.has(header)) throw new Error(`CSV has a duplicate column: ${header}`);
		headerIndex.set(header, index);
	});
	const missing = ["timestamp", "message_hex"].filter(column => !headerIndex.has(column));
	if (missing.length) throw new Error(`CSV is missing Bus Lens columns: ${missing.join(", ")}`);

	const byteHexColumns = new Map<number, number>();
	const byteTimestampColumns = new Map<number, number>();
	headers.forEach((header, index) => {
		const match = header.match(/^byte_(\d+)_(hex|timestamp)$/);
		if (!match) return;
		const position = Number(match[1]);
		if (!Number.isSafeInteger(position) || position < 1) throw new Error(`CSV has an invalid byte column: ${header}`);
		const target = match[2] === "hex" ? byteHexColumns : byteTimestampColumns;
		if (target.has(position)) throw new Error(`CSV has a duplicate byte column: ${header}`);
		target.set(position, index);
	});
	const bytePositions = [...new Set([...byteHexColumns.keys(), ...byteTimestampColumns.keys()])].sort((a, b) => a - b);
	if (bytePositions.length && bytePositions.some((position, index) => position !== index + 1)) {
		throw new Error("CSV byte columns must be numbered consecutively from byte_1");
	}
	const orphanTimestamp = bytePositions.find(position => !byteHexColumns.has(position));
	if (orphanTimestamp !== undefined) throw new Error(`CSV is missing byte_${orphanTimestamp}_hex`);

	const messages: CaptureMessage[] = [];
	const byteStream: NonNullable<Capture["byteStream"]> = [];
	const annotations: Record<string, { text: string; type: "message" }> = {};
	const sequenceRemarks = new Map<string, string>();
	rows.slice(1).forEach((row, rowIndex) => {
		const rowNumber = rowIndex + 2;
		if (row.length !== headers.length) {
			throw new Error(`CSV row ${rowNumber} has ${row.length} columns; expected ${headers.length}`);
		}
		const value = (column: string) => row[headerIndex.get(column)!] || "";
		const timestamp = parseCsvTimestamp(value("timestamp"), rowNumber, "timestamp");
		const messageHex = parseCsvHex(value("message_hex"), rowNumber, "message_hex");
		let bytes = messageHex;
		let byteTimestamps = bytes.map(() => timestamp);
		if (bytePositions.length) {
			const hasByteValues = bytePositions.some(position => row[byteHexColumns.get(position)!].trim());
			if (hasByteValues) {
				const parsedBytes: number[] = [];
				const parsedTimestamps: number[] = [];
				let blankSeen = false;
				bytePositions.forEach(position => {
					const hex = row[byteHexColumns.get(position)!].trim();
					const timestampValue = byteTimestampColumns.has(position) ? row[byteTimestampColumns.get(position)!].trim() : "";
					if (!hex) {
						if (timestampValue) throw new Error(`CSV row ${rowNumber} has a timestamp without byte_${position}_hex`);
						blankSeen = true;
						return;
					}
					if (blankSeen) throw new Error(`CSV row ${rowNumber} has a byte after an empty byte column`);
					const parsed = parseCsvHex(hex, rowNumber, `byte_${position}_hex`);
					if (parsed.length !== 1) throw new Error(`CSV row ${rowNumber} byte_${position}_hex must contain one byte`);
					parsedBytes.push(parsed[0]);
					parsedTimestamps.push(timestampValue ? parseCsvTimestamp(timestampValue, rowNumber, `byte_${position}_timestamp`) : timestamp);
				});
				if (!sameBytes(parsedBytes, messageHex)) {
					throw new Error(`CSV row ${rowNumber} byte columns do not match message_hex`);
				}
				bytes = parsedBytes;
				byteTimestamps = parsedTimestamps;
			}
		}
		if (!bytes.length) throw new Error(`CSV row ${rowNumber} has no message bytes`);
		const rawOffsets = bytes.map((_, index) => byteStream.length + index);
		byteStream.push(...bytes.map((byte, index) => ({ value: byte, timestamp: byteTimestamps[index], rawOffset: rawOffsets[index] })));
		const message: CaptureMessage = {
			id: generateId(),
			timestamp,
			byteTimestamps,
			bytes,
			hidden: false,
			hiddenBytes: bytes.map(() => false),
			sourceIndex: messages.length,
			rawOffsets,
			_rawPositions: rawOffsets
		};
		messages.push(message);
		const note = value("message_note");
		if (note) annotations[message.id!] = { text: note, type: "message" };
		const sequenceGroup = value("sequence_group");
		const sequenceRemark = value("sequence_remark");
		if (sequenceGroup && sequenceRemark) sequenceRemarks.set(sequenceGroup, sequenceRemark);
	});
	if (!messages.length) throw new Error("CSV contains no timestamped messages");

	const capture: Capture = {
		id: generateId(),
		name: "CSV · imported 1",
		view: "Imported CSV",
		params: [],
		createdAt: nowIso(),
		frameSize: messages[0]?.bytes.length || 3,
		baudRate: 115200,
		inputFormat: "csv",
		byteStream,
		messages,
		frameSections: (() => {
			const sections: CaptureSection[] = [];
			messages.forEach(message => {
				const frameSize = message.bytes.length;
				const start = message.rawOffsets?.[0] ?? message._rawPositions?.[0] ?? 0;
				if (sections.at(-1)?.frameSize !== frameSize) {
					sections.push({
						start,
						framingMode: "length",
						frameSize,
						frameMarker: "",
						markerPosition: "start",
						frameTimeGap: 5,
						collapseRuns: false,
						collapsed: false
					});
				}
			});
			return sections;
		})(),
		notes: [],
		annotations,
		patternRemarks: {}
	};
	if (sequenceRemarks.size) {
		const groups = recognizeMessagePatterns(capture).groups;
		sequenceRemarks.forEach((remark, groupId) => {
			const matchingGroup = groups.find(group => group.id === groupId);
			capture.patternRemarks![matchingGroup?.key || groupId] = { text: remark, type: "sequence" };
		});
	}
	return [capture];
}

export function parseDump(text: string, dependencies: DataTransferTimeDependencies = {}): Capture[] {
	const { generateId, now, nowIso } = resolveTimeDependencies(dependencies);
	const sections = text
		.split(/\n\s*----+\s*\n/)
		.map(section => section.trim())
		.filter(section => /View\s*:/i.test(section));
	return sections
		.map((section, index) => {
			const lines = section.split(/\r?\n/);
			const view =
				lines
					.find(line => /^View\s*:/i.test(line))
					?.split(":")
					.slice(1)
					.join(":")
					.trim() || "Imported";
			const params: Array<{ key: string; value: string }> = [];
			for (const line of lines) {
				if (
					/^\d{2}:\d{2}:\d{2}/.test(line) ||
					/^View\s*:/i.test(line) ||
					/^\(/.test(line) ||
					/^\.{3}/.test(line)
				)
					continue;
				const match = line.match(/^([^:]+):\s*(.+)$/);
				if (match) params.push({ key: match[1].trim(), value: match[2].trim() });
			}
			const messages: CaptureMessage[] = [];
			lines.forEach(line => {
				const timestampMatch = line.match(/^([\d]{2}:\d{2}:\d{2}[.:]\d{3})\s*->\s*((?:[0-9A-F]{2}\s*)+)/i);
				if (timestampMatch) messages.push(makeMessage(timestampMatch[2], parseTime(timestampMatch[1], now), messages.length, generateId));
			});
			return {
				id: generateId(),
				name: `${view} · imported ${index + 1}`,
				view,
				params,
				createdAt: nowIso(),
				frameSize: 3,
				baudRate: 115200,
				inputFormat: "text",
				messages,
				notes: [],
				annotations: {}
			};
		})
		.filter(capture => capture.messages.length);
}

function formatTime(milliseconds: number): string {
	return new Date(milliseconds).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		fractionalSecondDigits: 3
	});
}

export function createDataTransferController(dependencies: DataTransferDependencies): DataTransferController {
	const compatibilityState = dependencies.state;
	const { generateId, now, nowIso } = resolveTimeDependencies(dependencies);

	function captures(): readonly CaptureIndexEntry[] {
		return dependencies.getCaptures?.() || compatibilityState?.captures || [];
	}

	function folders(): readonly StoredFolder[] {
		return dependencies.getFolders?.() || compatibilityState?.folders || [];
	}

	function queue(): readonly SendQueueEntry[] {
		return dependencies.getQueue?.() || compatibilityState?.sendQueue || [];
	}

	function history(): readonly SendHistoryEntry[] {
		return dependencies.getHistory?.() || compatibilityState?.sendHistory || [];
	}

	function settings(): SendSettings {
		return { delayMs: 100, draft: "", baudRate: 115200, ...(dependencies.getSettings?.() || compatibilityState?.sendSettings || {}) };
	}

	async function importFile(file: DataTransferFile): Promise<void> {
		try {
			const text = await file.text();
			let importedCaptures: Capture[] = [];
			let importedFolders: StoredFolder[] = [];
			let importedQueue: SendQueueEntry[] = [];
			let importedHistory: SendHistoryEntry[] = [];
			let importedSettings = settings();
			const existingFolders = [...folders()];
			const existingCaptures = [...captures()];
			const existingQueue = [...queue()];
			if (file.name.toLowerCase().endsWith(".json")) {
				const imported: unknown = JSON.parse(text);
				const importedArchive = isRecord(imported) ? imported : undefined;
				const captures = (Array.isArray(imported) ? imported : importedArchive?.captures) as Capture[] | undefined;
				if (!Array.isArray(captures)) throw new Error("No captures found");
				importedCaptures = captures;
				const sourceFolders = Array.isArray(importedArchive?.folders) ? importedArchive.folders : [];
				const folderIdMap = new Map<unknown, string>();
				const existingFolderNames = new Map(existingFolders.map(folder => [folder.name.toLowerCase(), folder.id]));
				const existingCaptureIds = new Set(existingCaptures.map(capture => capture.id));
				sourceFolders.forEach(sourceFolder => {
					const folder = isRecord(sourceFolder) ? sourceFolder : {};
					const name = String(folder.name || "Imported folder").trim() || "Imported folder";
					let id = existingFolderNames.get(name.toLowerCase());
					if (!id) {
						id = generateId();
						const nextFolder = {
							id,
							name,
							collapsed: Boolean(folder.collapsed),
							createdAt: (folder.createdAt as string | undefined) || nowIso()
						};
						importedFolders.push(nextFolder);
						existingFolderNames.set(name.toLowerCase(), id);
					}
					if (folder.id) folderIdMap.set(folder.id, id);
				});
				captures.forEach(capture => {
					if (!capture.id || existingCaptureIds.has(capture.id)) capture.id = generateId();
					existingCaptureIds.add(capture.id);
					capture.folderId = folderIdMap.get(capture.folderId) || null;
					normalizeCapture(capture, generateId);
					rebuildPreview(capture, generateId);
					capture.messages!.forEach(message => (message.id ||= generateId()));
				});
				if (compatibilityState) compatibilityState.folders.push(...importedFolders);
				if (compatibilityState) compatibilityState.captures.unshift(...captures);
				if (importedArchive && Array.isArray(importedArchive.sendHistory)) {
					importedHistory = (importedArchive.sendHistory as SendHistoryEntry[])
						.filter(item => Array.isArray(item.bytes) && item.bytes.length)
						.map(item => ({ ...item, id: String(item.id || generateId()), bytes: item.bytes!.map(Number) }))
						.slice(0, MAX_SEND_HISTORY);
				}
				if (importedArchive && Array.isArray(importedArchive.sendQueue)) {
					importedQueue = (importedArchive.sendQueue as SendQueueEntry[])
						.filter(item => Array.isArray(item.bytes) && item.bytes.length)
						.map(item => ({ ...item, id: String(item.id || generateId()), bytes: item.bytes!.map(Number), createdAt: item.createdAt || now() }));
				}
				if (importedArchive && isRecord(importedArchive.sendSettings)) {
					importedSettings = { ...importedSettings, ...(importedArchive.sendSettings as Partial<SendSettings>), draft: importedSettings.draft };
				}
				if (compatibilityState) {
					compatibilityState.sendHistory = [...importedHistory, ...compatibilityState.sendHistory].slice(0, MAX_SEND_HISTORY);
					compatibilityState.sendQueue = [...importedQueue, ...compatibilityState.sendQueue];
					compatibilityState.sendSettings = importedSettings;
				}
			} else {
				const isCsv = file.name.toLowerCase().endsWith(".csv");
				const captures = isCsv ? parseCsv(text, { generateId, now, nowIso }) : parseDump(text, { generateId, now, nowIso });
				if (!captures.length) throw new Error("No timestamped hex messages found");
				importedCaptures = captures;
				captures.forEach(capture => {
					normalizeCapture(capture, generateId);
					if (!isCsv) rebuildPreview(capture, generateId);
				});
				if (compatibilityState) compatibilityState.captures.unshift(...captures);
			}
			const activeCapture = importedCaptures[0];
			if (activeCapture) {
				dependencies.setActiveCapture?.(activeCapture);
				dependencies.setActiveId(activeCapture.id);
				dependencies.setSelectedCaptureId?.(String(activeCapture.id));
			}
			if (dependencies.archiveCommands) {
				await Promise.all([
					...importedCaptures.map(capture => dependencies.archiveCommands!.saveLegacyCapture(capture)),
					...importedFolders.map(folder => dependencies.archiveCommands!.saveFolder(folder)),
					...[...importedQueue, ...existingQueue].flatMap((item, position) => item.id ? [dependencies.archiveCommands!.saveQueueItem(item, position)] : []),
					...importedHistory.map(item => dependencies.archiveCommands!.saveHistoryItem(item)),
					...(importedQueue.length || importedHistory.length || file.name.toLowerCase().endsWith(".json") ? [dependencies.archiveCommands.saveSettings(importedSettings)] : []),
					dependencies.archiveCommands.persistArchiveIndex({
						activeId: dependencies.getActiveId() ?? null,
						unfiledCollapsed: Boolean(dependencies.getArchiveIndex?.()?.unfiledCollapsed),
						captures: [...importedCaptures, ...existingCaptures].map((capture, position) => ({ id: String(capture.id), folderId: capture.folderId ?? null, position })),
						folders: [...existingFolders, ...importedFolders].map((folder, position) => ({ id: String(folder.id), position }))
					})
				]);
			}
			dependencies.render();
			dependencies.showToast(`Imported ${file.name}`);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			dependencies.showToast(`Import failed: ${message}`);
		}
	}

	async function exportData(format: ExportFormat): Promise<void> {
		const capture = dependencies.capture()!;
		if (!capture) return;
		const safeName = capture.name!.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
		if (format === "json") {
			const exportedCaptures = compatibilityState?.captures || (dependencies.archiveCommands
				? (await Promise.all(captures().map(item => dependencies.archiveCommands!.getCapture(String(item.id))))).filter(Boolean) as Capture[]
				: [capture]);
			dependencies.download(
				JSON.stringify(
					{
						app: "Bus Lens",
						version: 3,
						exportedAt: nowIso(),
						folders: folders(),
						captures: exportedCaptures,
						sendHistory: history(),
						sendQueue: queue(),
						sendSettings: { ...settings(), draft: "" }
					},
					null,
					2
				),
				"bus-lens-archive.json",
				"application/json"
			);
		} else if (format === "csv") {
			const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
			const width = Math.max(0, ...(capture.messages || []).map(message => visibleByteEntries(message).length));
			const byteHeaders = Array.from({ length: width }, (_, index) => [`byte_${index + 1}_hex`, `byte_${index + 1}_timestamp`]).flat();
			const patterns = recognizeMessagePatterns(capture);
			const header = [
				"index",
				"timestamp",
				"delta_ms",
				...byteHeaders,
				"message_hex",
				"message_note",
				"sequence_group",
				"sequence_remark"
			];
			const rows = capture.messages!.map((message, index) => {
				const pattern = patterns.membership.get(index)?.group;
				const visibleBytes = visibleByteEntries(message);
				const byteCells = Array.from({ length: width }, (_, position) =>
					visibleBytes[position] === undefined
						? ["", ""]
						: [
							hexByte(visibleBytes[position].value),
							new Date(message.byteTimestamps?.[visibleBytes[position].rawPosition] ?? message.timestamp).toISOString()
						]
				).flat();
				return [
					index + 1,
					new Date(message.timestamp).toISOString(),
					index ? message.timestamp - capture.messages![index - 1].timestamp : "",
					...byteCells,
					signature(message),
					(capture.annotations as Record<string, { text?: unknown }>)[message.id as string]?.text || "",
					pattern?.id || "",
					pattern?.remark || ""
				]
					.map(quote)
					.join(",");
			});
			dependencies.download([header.join(","), ...rows].join("\n"), `${safeName}.csv`, "text/csv");
		} else {
			const patterns = recognizeMessagePatterns(capture);
			const patternLines = patterns.groups
				.filter(group => group.remark)
				.map(
					group =>
						`# Repeated sequence (${group.length} messages, ${group.starts.length} occurrences): ${group.remark}\n#   ${group.signatures.join(" -> ")}`
				);
			const noteLines = (capture.notes || []).map(
				note => `# ${note.type === "sequence" ? `Rows ${note.start}-${note.end}` : "Capture"}: ${note.text}`
			);
			const context = [
				`----`,
				`View: ${capture.view}`,
				...capture.params!.map(parameter => {
					const contextParameter = parameter as { key?: unknown; value?: unknown };
					return `${contextParameter.key}: ${contextParameter.value}`;
				}),
				...noteLines,
				...patternLines,
				"",
				...capture.messages!.map(
					message =>
						`${formatTime(message.timestamp)} -> ${signature(message)}${(capture.annotations as Record<string, { text?: unknown }>)[message.id as string] ? `  <-- ${(capture.annotations as Record<string, { text?: unknown }>)[message.id as string].text}` : ""}`
				),
				"",
				"----"
			].join("\n");
			dependencies.download(context, `${safeName}.txt`, "text/plain");
		}
		dependencies.showToast(`${format.toUpperCase()} export created`);
	}

	return { importFile, exportData };
}

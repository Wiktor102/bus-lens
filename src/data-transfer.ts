import { normalizeSendState, type AppState, type SendHistoryEntry, type SendQueueEntry, type SendSettings, type StoredFolder } from "./app-state.ts";
import {
	frameWidth,
	hexByte,
	makeMessage,
	normalizeCapture,
	parseTime,
	rebuildPreview,
	signature,
	visibleByteEntries,
	type Capture,
	type CaptureMessage
} from "./capture-framing.ts";
import { recognizeMessagePatterns } from "./analysis.ts";
import type { ExportFormat } from "./dialog-model.ts";

export type DataTransferFile = {
	name: string;
	text: () => Promise<string>;
};

export type Download = (content: string, filename: string, type: string) => void;

export type DataTransferState = AppState & {
	captures: Capture[];
	folders: StoredFolder[];
	sendHistory: SendHistoryEntry[];
	sendQueue: SendQueueEntry[];
	sendSettings: SendSettings;
};

export type DataTransferDependencies = {
	state: AppState;
	capture: () => Capture | undefined;
	getActiveId: () => string | null | undefined;
	setActiveId: (captureId: string | null | undefined) => void;
	saveState: () => void;
	render: () => void;
	showToast: (message: string) => void;
	download: Download;
};

export type DataTransferController = {
	importFile: (file: DataTransferFile) => Promise<void>;
	exportData: (format: ExportFormat) => void;
};

export function parseDump(text: string): Capture[] {
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
				if (timestampMatch) messages.push(makeMessage(timestampMatch[2], parseTime(timestampMatch[1]), messages.length));
			});
			return {
				id: crypto.randomUUID(),
				name: `${view} · imported ${index + 1}`,
				view,
				params,
				createdAt: new Date().toISOString(),
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
	const state = dependencies.state as DataTransferState;

	async function importFile(file: DataTransferFile): Promise<void> {
		try {
			const text = await file.text();
			if (file.name.toLowerCase().endsWith(".json")) {
				const imported: any = JSON.parse(text);
				const captures = (Array.isArray(imported) ? imported : imported.captures) as Capture[];
				if (!Array.isArray(captures)) throw new Error("No captures found");
				const importedFolders = Array.isArray(imported?.folders) ? imported.folders : [];
				const folderIdMap = new Map<string, string>();
				const existingFolderNames = new Map(state.folders.map(folder => [folder.name.toLowerCase(), folder.id]));
				const existingCaptureIds = new Set(state.captures.map(capture => capture.id));
				importedFolders.forEach((sourceFolder: any) => {
					const name = String(sourceFolder?.name || "Imported folder").trim() || "Imported folder";
					let id = existingFolderNames.get(name.toLowerCase());
					if (!id) {
						id = crypto.randomUUID();
						state.folders.push({
							id,
							name,
							collapsed: Boolean(sourceFolder?.collapsed),
							createdAt: sourceFolder?.createdAt || new Date().toISOString()
						});
						existingFolderNames.set(name.toLowerCase(), id);
					}
					if (sourceFolder?.id) folderIdMap.set(sourceFolder.id, id);
				});
				captures.forEach(capture => {
					if (!capture.id || existingCaptureIds.has(capture.id)) capture.id = crypto.randomUUID();
					existingCaptureIds.add(capture.id);
					capture.folderId = folderIdMap.get(capture.folderId as string) || null;
					normalizeCapture(capture);
					rebuildPreview(capture);
					capture.messages!.forEach(message => (message.id ||= crypto.randomUUID()));
				});
				state.captures.unshift(...captures);
				if (!Array.isArray(imported) && Array.isArray(imported.sendHistory)) {
					state.sendHistory = [...imported.sendHistory, ...state.sendHistory];
				}
				if (!Array.isArray(imported) && Array.isArray(imported.sendQueue)) {
					state.sendQueue = [...imported.sendQueue, ...state.sendQueue];
				}
				if (!Array.isArray(imported) && imported.sendSettings) {
					state.sendSettings = { ...state.sendSettings, ...imported.sendSettings, draft: state.sendSettings.draft };
				}
				normalizeSendState(state);
				dependencies.setActiveId(captures[0]?.id || dependencies.getActiveId());
			} else {
				const captures = parseDump(text);
				if (!captures.length) throw new Error("No timestamped hex messages found");
				captures.forEach(capture => {
					normalizeCapture(capture);
					rebuildPreview(capture);
				});
				state.captures.unshift(...captures);
				dependencies.setActiveId(captures[0].id);
			}
			dependencies.saveState();
			dependencies.render();
			dependencies.showToast(`Imported ${file.name}`);
		} catch (error: any) {
			dependencies.showToast(`Import failed: ${error.message}`);
		}
	}

	function exportData(format: ExportFormat): void {
		const capture = dependencies.capture()!;
		const safeName = capture.name!.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
		if (format === "json") {
			dependencies.download(
				JSON.stringify(
					{
						app: "Bus Lens",
						version: 3,
						exportedAt: new Date().toISOString(),
						folders: state.folders,
						captures: state.captures,
						sendHistory: state.sendHistory,
						sendQueue: state.sendQueue,
						sendSettings: { ...state.sendSettings, draft: "" }
					},
					null,
					2
				),
				"bus-lens-archive.json",
				"application/json"
			);
		} else if (format === "csv") {
			const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
			const width = frameWidth(capture);
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
				...capture.params!.map(parameter => `${(parameter as any).key}: ${(parameter as any).value}`),
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

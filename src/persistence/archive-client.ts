import type { AppState, SendSettings, StoredFolder } from "../shared/app-state.ts";
import type { Capture } from "../features/capture/capture-framing.ts";

export type MigrationReport = {
	fingerprint: string;
	captures: number;
	folders: number;
	rawBytes: number;
	notes: number;
	queueEntries: number;
	historyEntries: number;
};

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as object).sort().map(key => [key, canonicalize((value as Record<string, unknown>)[key])]));
	return value;
}

export async function archiveFingerprint(archive: AppState): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(archive)));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function archiveReport(archive: AppState, fingerprint: string): MigrationReport {
	return {
		fingerprint,
		captures: archive.captures.length,
		folders: archive.folders.length,
		rawBytes: archive.captures.reduce((total, capture) => total + (capture.byteStream?.length ?? 0), 0),
		notes: archive.captures.reduce((total, capture) => total + (capture.notes?.length ?? 0) + Object.keys(capture.annotations ?? {}).length, 0),
		queueEntries: archive.sendQueue?.length ?? 0,
		historyEntries: archive.sendHistory?.length ?? 0
	};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`/api${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
	if (!response.ok) throw new Error(`Archive service ${response.status}: ${await response.text()}`);
	return response.status === 204 ? (undefined as T) : (await response.json() as T);
}

export class ArchiveClient {
	async health(): Promise<void> { await request("/health"); }
	async load(): Promise<AppState> {
		const archive = await request<{ captures: Array<{ document: Capture }>; folders: Array<{ document: StoredFolder }>; index: { activeId: string | null; unfiledCollapsed: boolean }; queue: Array<{ document: unknown }>; history: Array<{ document: unknown }>; settings: Record<string, unknown> }>("/archive");
		return { captures: archive.captures.map(item => item.document), folders: archive.folders.map(item => item.document), activeId: archive.index.activeId, unfiledCollapsed: archive.index.unfiledCollapsed, sendQueue: archive.queue.map(item => item.document) as AppState["sendQueue"], sendHistory: archive.history.map(item => item.document) as AppState["sendHistory"], sendSettings: archive.settings.send as AppState["sendSettings"] };
	}
	async migrate(archive: AppState): Promise<MigrationReport> {
		const fingerprint = await archiveFingerprint(archive);
		const report = archiveReport(archive, fingerprint);
		await request("/migrations/local-storage", { method: "POST", body: JSON.stringify({ fingerprint, archive, report }) });
		return report;
	}
	async saveCapture(capture: Capture): Promise<void> { await request(`/captures/${encodeURIComponent(String(capture.id))}`, { method: "PUT", body: JSON.stringify(capture) }); }
	async saveFolder(folder: StoredFolder): Promise<void> { await request(`/folders/${encodeURIComponent(folder.id)}`, { method: "PUT", body: JSON.stringify(folder) }); }
	async saveArchiveIndex(state: AppState, activeId: string | null | undefined): Promise<void> {
		await request("/archive-index", { method: "PUT", body: JSON.stringify({ activeId: activeId ?? null, unfiledCollapsed: Boolean(state.unfiledCollapsed), captures: state.captures.map((capture, position) => ({ id: capture.id, folderId: capture.folderId ?? null, position })), folders: state.folders.map((folder, position) => ({ id: folder.id, position })) }) });
	}
	async saveSendState(state: AppState): Promise<void> {
		await Promise.all((state.sendQueue ?? []).map(item => request(`/queue/${encodeURIComponent(String(item.id))}`, { method: "PUT", body: JSON.stringify(item) })));
		await Promise.all((state.sendHistory ?? []).map((item, index) => request(`/history/${encodeURIComponent(String(item.id ?? `history-${index}`))}`, { method: "PUT", body: JSON.stringify(item) })));
	}
	async saveSettings(settings: Partial<SendSettings> | undefined): Promise<void> { await request("/settings/send", { method: "PUT", body: JSON.stringify(settings ?? {}) }); }
}

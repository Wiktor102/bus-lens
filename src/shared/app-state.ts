import { normalizeCapture, rebuildPreview, type Capture } from "../features/capture/capture-framing.ts";
import { createDemoCaptures } from "./demo-data.ts";

export const STORAGE_KEY = "bus-lens-state-v1";
export const MAX_SEND_HISTORY = 250;

export type StoredFolder = {
	id: string;
	name: string;
	collapsed: boolean;
	createdAt?: string;
};

export type SendHistoryEntry = {
	bytes?: unknown[];
	[key: string]: unknown;
};

export type SendQueueEntry = {
	id?: string;
	bytes?: unknown[];
	createdAt?: number;
	[key: string]: unknown;
};

export type SendSettings = {
	delayMs: number;
	draft: string;
	baudRate: number;
};

export type AppState = {
	captures: Capture[];
	folders: StoredFolder[];
	activeId?: string | null;
	unfiledCollapsed?: boolean;
	sendHistory?: SendHistoryEntry[];
	sendQueue?: SendQueueEntry[];
	sendSettings?: Partial<SendSettings>;
	[key: string]: unknown;
};

export type StateStorage = {
	getItem: (key: string) => string | null;
};

export type StateDependencies = {
	storage?: StateStorage;
	generateId?: () => string;
	now?: () => number;
	nowIso?: () => string;
};

type ResolvedStateDependencies = {
	storage?: StateStorage;
	generateId: () => string;
	now: () => number;
	nowIso: () => string;
};

const defaultGenerateId = () => crypto.randomUUID();

function defaultStorage(): StateStorage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

function resolveDependencies(dependencies: StateDependencies = {}): ResolvedStateDependencies {
	const now = dependencies.now || Date.now;
	return {
		storage: dependencies.storage || defaultStorage(),
		generateId: dependencies.generateId || defaultGenerateId,
		now,
		nowIso: dependencies.nowIso || (() => new Date(now()).toISOString())
	};
}

export function normalizeSendState(target: AppState, dependencies: StateDependencies = {}): void {
	const { generateId, now } = resolveDependencies(dependencies);
	target.sendQueue = Array.isArray(target.sendQueue)
		? target.sendQueue
				.filter(item => Array.isArray(item.bytes) && item.bytes.length)
				.map(item => ({
					id: item.id || generateId(),
					bytes: item.bytes!.map(Number),
					createdAt: item.createdAt || now()
				}))
		: [];
	target.sendHistory = Array.isArray(target.sendHistory)
		? target.sendHistory
				.filter(item => Array.isArray(item.bytes) && item.bytes.length)
				.slice(0, MAX_SEND_HISTORY)
				.map(item => ({ ...item, id: item.id || generateId() }))
		: [];
	const savedDelay = Number(target.sendSettings?.delayMs);
	target.sendSettings = {
		delayMs: Number.isFinite(savedDelay) ? Math.max(0, Math.min(600_000, savedDelay)) : 100,
		draft: String(target.sendSettings?.draft || ""),
		baudRate: Math.max(300, +target.sendSettings?.baudRate! || 115200)
	};
}

export function normalizeArchiveState(
	archive: AppState,
	dependencies: StateDependencies = {}
): void {
	const { generateId, nowIso } = resolveDependencies(dependencies);
	archive.folders = Array.isArray(archive.folders) ? archive.folders : [];
	const seen = new Set<string>();
	archive.folders = archive.folders
		.filter(folder => folder && typeof folder === "object")
		.map(folder => ({
			id: String(folder.id || generateId()),
			name: String(folder.name || "Untitled folder").trim() || "Untitled folder",
			collapsed: Boolean(folder.collapsed),
			createdAt: folder.createdAt || nowIso()
		}))
		.filter(folder => {
			if (seen.has(folder.id)) return false;
			seen.add(folder.id);
			return true;
		});
	archive.captures.forEach(item => {
		item.folderId = seen.has(item.folderId as string) ? item.folderId : null;
	});
}

export function loadState(dependencies: StateDependencies = {}): AppState {
	const runtime = resolveDependencies(dependencies);
	try {
		const saved = JSON.parse(runtime.storage?.getItem(STORAGE_KEY) ?? "null") as AppState | null;
		if (Array.isArray(saved?.captures)) {
			normalizeArchiveState(saved, runtime);
			saved.captures.forEach(capture => normalizeCapture(capture, runtime.generateId));
			saved.captures.forEach(capture => rebuildPreview(capture, runtime.generateId));
			normalizeSendState(saved, runtime);
			return saved;
		}
	} catch {}
	const demoCaptures = createDemoCaptures(runtime);
	demoCaptures.forEach(capture => normalizeCapture(capture, runtime.generateId));
	demoCaptures.forEach(capture => rebuildPreview(capture, runtime.generateId));
	const initial: AppState = { captures: demoCaptures, folders: [], activeId: demoCaptures[0].id };
	normalizeSendState(initial, runtime);
	return initial;
}

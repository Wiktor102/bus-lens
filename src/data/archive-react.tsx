import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	type PropsWithChildren
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useApplicationSelector, useApplicationSend } from "../app/application-store-provider.tsx";
import type { ApplicationEvent } from "../shared/application-store.ts";
import { selectSelectedCaptureId } from "../shared/application-store.ts";
import { buildArchiveGroups, type ArchiveCapture, type ArchiveFolder } from "../features/archive/archive-list.ts";
import type { ArchiveIndex, CaptureListItem } from "../persistence/archive-client.ts";
import { archiveQueryKeys } from "./archive-queries.ts";
import type { ArchiveCommands, ArchiveDataLayer } from "./archive-data-layer.ts";

const ArchiveDataContext = createContext<ArchiveDataLayer | null>(null);

export function ArchiveDataProvider({ layer, children }: PropsWithChildren<{ layer: ArchiveDataLayer }>) {
	return <ArchiveDataContext.Provider value={layer}>{children}</ArchiveDataContext.Provider>;
}

export function useArchiveDataLayer(): ArchiveDataLayer {
	const layer = useContext(ArchiveDataContext);
	if (!layer) throw new Error("ArchiveDataProvider is required");
	return layer;
}

export function useArchiveCommands(): ArchiveCommands {
	return useArchiveDataLayer().commands;
}

export function useArchiveIndex() {
	const layer = useArchiveDataLayer();
	return useQuery(layer.queries.index());
}

export function useArchiveCaptures() {
	const layer = useArchiveDataLayer();
	return useQuery(layer.queries.captures());
}

export function useArchiveFolders() {
	const layer = useArchiveDataLayer();
	return useQuery(layer.queries.folders());
}

export function useArchiveCaptureSummaries() {
	const layer = useArchiveDataLayer();
	return useQuery(layer.queries.captureSummaries());
}

export function useArchiveQueue() {
	const layer = useArchiveDataLayer();
	return useQuery(layer.queries.queue());
}

export function useArchiveHistory() {
	const layer = useArchiveDataLayer();
	return useQuery(layer.queries.history());
}

export function useArchiveSettings() {
	const layer = useArchiveDataLayer();
	return useQuery(layer.queries.settings());
}

export function useArchiveCapture(captureId: string | null | undefined) {
	const layer = useArchiveDataLayer();
	const captureQuery = useQuery({ ...layer.queries.capture(captureId || ""), enabled: Boolean(captureId) });
	const summariesQuery = useArchiveCaptureSummaries();
	const data = useMemo(() => {
		if (!captureQuery.data) return captureQuery.data;
		const summary = summariesQuery.data?.find(item => item.id === String(captureQuery.data?.id));
		return summary?.status ? { ...captureQuery.data, storageStatus: summary.status } : captureQuery.data;
	}, [captureQuery.data, summariesQuery.data]);
	return { ...captureQuery, data };
}

export function useArchiveNotes(captureId: string | null | undefined) {
	const layer = useArchiveDataLayer();
	return useQuery({ ...layer.queries.notes(captureId || ""), enabled: Boolean(captureId) });
}

export function useSelectedCaptureId(): string | null {
	return useApplicationSelector(selectSelectedCaptureId);
}

export function useArchiveSelectionSync(): void {
	const { data: index } = useArchiveIndex();
	const selectedCaptureId = useSelectedCaptureId();
	const send = useApplicationSend();
	useEffect(() => {
		if (!index || selectedCaptureId !== null) return;
		send({ type: "capture/selected-changed", captureId: index.activeId ?? index.captures[0]?.id ?? null });
	}, [index, selectedCaptureId, send]);
}

export function useSelectedArchiveCapture() {
	const captureId = useSelectedCaptureId();
	return { captureId, ...useArchiveCapture(captureId) };
}

export type ArchiveListModel = {
	captures: ArchiveCapture[];
	folders: ArchiveFolder[];
	index: ArchiveIndex | undefined;
	isLoading: boolean;
	error: Error | null;
	retry: () => void;
};

function archiveCapture(capture: CaptureListItem): ArchiveCapture {
	return {
		id: capture.id,
		name: capture.name,
		view: capture.view,
		folderId: capture.folderId,
		params: capture.params.map(parameter => ({ key: parameter.key, value: parameter.value })),
		messageCount: capture.messageCount,
		storageStatus: capture.storageStatus
	};
}

export function useArchiveList(): ArchiveListModel {
	const indexQuery = useArchiveIndex();
	const capturesQuery = useArchiveCaptures();
	const foldersQuery = useArchiveFolders();
	const summariesQuery = useArchiveCaptureSummaries();
	const captures = useMemo(() => {
		const indexById = new Map((indexQuery.data?.captures ?? []).map(item => [item.id, item]));
		const statusById = new Map((summariesQuery.data ?? []).map(item => [item.id, item.status]));
		const byId = new Map((capturesQuery.data ?? []).map(capture => {
			const id = String(capture.id);
			const indexItem = indexById.get(id);
			return [id, archiveCapture({
				...capture,
				folderId: indexItem?.folderId ?? capture.folderId,
				storageStatus: statusById.get(id) ?? capture.storageStatus
			})];
		}));
		const order = new Map((indexQuery.data?.captures ?? []).map(item => [item.id, item.position]));
		return [...byId.values()].sort((left, right) =>
			(order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
		);
	}, [capturesQuery.data, indexQuery.data, summariesQuery.data]);
	const folders = useMemo(() => {
		const order = new Map((indexQuery.data?.folders ?? []).map(item => [item.id, item.position]));
		return [...(foldersQuery.data ?? [])]
			.map(folder => ({ id: String(folder.id), name: String(folder.name ?? ""), collapsed: Boolean(folder.collapsed) }))
			.sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER));
	}, [foldersQuery.data, indexQuery.data]);
	const retry = useCallback(() => {
		void Promise.all([indexQuery.refetch(), capturesQuery.refetch(), foldersQuery.refetch(), summariesQuery.refetch()]);
	}, [capturesQuery, foldersQuery, indexQuery, summariesQuery]);
	return {
		captures,
		folders,
		index: indexQuery.data,
		isLoading: indexQuery.isLoading || capturesQuery.isLoading || foldersQuery.isLoading || summariesQuery.isLoading,
		error: (indexQuery.error || capturesQuery.error || foldersQuery.error || summariesQuery.error) as Error | null,
		retry
	};
}

export function useArchiveGroups(query: string, storageFilter: Parameters<typeof buildArchiveGroups>[4]) {
	const list = useArchiveList();
	const groups = useMemo(
		() => buildArchiveGroups(list.captures, list.folders, query, list.index?.unfiledCollapsed, storageFilter),
		[list.captures, list.folders, list.index?.unfiledCollapsed, query, storageFilter]
	);
	return { ...list, ...groups };
}

export function useSendQueryState() {
	const settings = useArchiveSettings();
	const queue = useArchiveQueue();
	const history = useArchiveHistory();
	return {
		settings: settings.data,
		queue: queue.data ?? [],
		history: history.data ?? [],
		isLoading: settings.isLoading || queue.isLoading || history.isLoading,
		error: (settings.error || queue.error || history.error) as Error | null,
		retry: () => {
			void Promise.all([settings.refetch(), queue.refetch(), history.refetch()]);
		}
	};
}

export function sendSelectedCaptureEvent(captureId: string | null): ApplicationEvent {
	return { type: "capture/selected-changed", captureId };
}

export { archiveQueryKeys };

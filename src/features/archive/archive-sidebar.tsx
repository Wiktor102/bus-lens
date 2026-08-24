import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type MouseEvent as ReactMouseEvent
} from "react";
import { getArchiveActions } from "./archive-bridge";
import { type ArchiveCapture, type ArchiveGroup } from "./archive-list";
import { captureStorageLabel, captureStorageUiStatus } from "../capture/capture-storage";
import { ArrowUp, Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Download, Folder, Pencil, Plus, Search, Trash, Upload, X } from "lucide-react";
import { useArchiveGroups, useArchiveList, useSelectedCaptureId } from "../../data/archive-react.tsx";

const FOLDER_ICON = (
	<Folder aria-hidden="true" />
);

type CaptureContextMenuState = {
	captureId: string;
	clientX: number;
	clientY: number;
	origin: HTMLElement;
};

type FolderContextMenuState = {
	folderId: string;
	clientX: number;
	clientY: number;
	origin: HTMLElement;
};

function FolderGroup({
	group,
	searching,
	activeId,
	folderContextMenuOpen,
	onToggle,
	onSelect,
	onCaptureContextMenu,
	onFolderContextMenu,
	contextMenuCaptureId
}: {
	group: ArchiveGroup;
	searching: boolean;
	activeId: string | null | undefined;
	folderContextMenuOpen: boolean;
	onToggle: (folderId: string | null) => void;
	onSelect: (captureId: string) => void;
	onCaptureContextMenu: (event: ReactMouseEvent<HTMLDivElement>, captureId: string) => void;
	onFolderContextMenu: (event: ReactMouseEvent<HTMLElement>, folderId: string) => void;
	contextMenuCaptureId: string | null;
}) {
	const collapsed = group.collapsed && !searching;
	const hasLiveCapture = group.captures.some(capture => capture.isRecording);

	return (
		<section
			className={`capture-folder ${collapsed ? "collapsed" : ""} ${folderContextMenuOpen ? "context-menu-open" : ""}`.trim()}
			data-folder-id={group.id}
		>
			<header
				className="folder-header"
				onContextMenu={event => {
					if (!group.system) onFolderContextMenu(event, group.id);
				}}
			>
				<button
					className="folder-toggle"
					type="button"
					data-folder-toggle={group.id}
					aria-expanded={!collapsed}
					aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.name}`}
					onClick={() => onToggle(group.id || null)}
				>
					<span className="folder-chevron" aria-hidden="true" />
					<span className="folder-icon">{FOLDER_ICON}</span>
					<strong>{group.name}</strong>
					{collapsed && hasLiveCapture ? <span className="recording-badge folder-live-badge">LIVE</span> : null}
					<small>{group.captures.length}</small>
				</button>
			</header>
			<div className="folder-captures">
				{group.captures.length ? (
					group.captures.map(capture => (
						<CaptureItem
							key={capture.id}
							capture={capture}
							active={capture.id === activeId}
							contextMenuOpen={capture.id === contextMenuCaptureId}
							onSelect={onSelect}
							onContextMenu={event => onCaptureContextMenu(event, capture.id)}
						/>
					))
				) : (
					<p className="folder-empty">No captures here yet</p>
				)}
			</div>
		</section>
	);
}

function CaptureItem({
	capture,
	active,
	contextMenuOpen,
	onSelect,
	onContextMenu
}: {
	capture: ArchiveCapture;
	active: boolean;
	contextMenuOpen: boolean;
	onSelect: (captureId: string) => void;
	onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
	const storageStatus = captureStorageUiStatus(capture.storageStatus);

	return (
		<div
			className={`capture-item ${active ? "active" : ""} ${contextMenuOpen ? "context-menu-open" : ""}`.trim()}
			onContextMenu={onContextMenu}
		>
			<button className="capture-open" type="button" data-capture-id={capture.id} onClick={() => onSelect(capture.id)}>
				<strong className="capture-name-row">
					<span className="capture-name">{capture.name}</span>
					<span className="capture-badges">
						{capture.isRecording ? <span className="recording-badge">LIVE</span> : null}
						{storageStatus === "legacy" || storageStatus === "failed" ? (
							<span className={`storage-badge storage-${storageStatus}`} data-storage-status={capture.storageStatus || "legacy-not-canonicalized"}>
								{captureStorageLabel(storageStatus)}
							</span>
						) : null}
					</span>
				</strong>
				<small>
					<span>{capture.view || "Unassigned view"}</span>
					<span>{capture.messageCount} msg</span>
				</small>
				<span className="capture-tags">
					{capture.params.slice(0, 2).map((parameter, parameterIndex) => (
						<i key={`${parameter.key}:${parameter.value}:${parameterIndex}`}>
							{parameter.key}: {parameter.value}
						</i>
					))}
				</span>
			</button>
		</div>
	);
}

export function ArchiveSidebar() {
	const actions = getArchiveActions();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const selectedCaptureId = useSelectedCaptureId();
	const archiveData = useArchiveGroups(query, "all");
	const [folderDialogId, setFolderDialogId] = useState<string | null | undefined>(undefined);
	const [folderMoveCaptureId, setFolderMoveCaptureId] = useState<string | null>(null);
	const [captureMenuState, setCaptureMenuState] = useState<CaptureContextMenuState | null>(null);
	const [folderMenuState, setFolderMenuState] = useState<FolderContextMenuState | null>(null);
	const openNewFolder = useCallback((captureId: string | null = null) => {
		setFolderMoveCaptureId(captureId);
		setFolderDialogId(null);
	}, []);
	const handleFolderCreated = useCallback((folderId: string) => {
		if (folderMoveCaptureId) actions.moveCapture(folderMoveCaptureId, folderId);
		setFolderMoveCaptureId(null);
	}, [actions, folderMoveCaptureId]);
	const closeCaptureMenu = useCallback((restoreFocus = false) => {
		setCaptureMenuState(current => {
			if (restoreFocus && current?.origin.isConnected) current.origin.focus();
			return null;
		});
	}, []);
	const closeFolderMenu = useCallback((restoreFocus = false) => {
		setFolderMenuState(current => {
			if (restoreFocus && current?.origin.isConnected) current.origin.focus();
			return null;
		});
	}, []);
	const archive = archiveData;
	const allFoldersCollapsed = archive.folders.every(folder => folder.collapsed) && Boolean(archive.index?.unfiledCollapsed);
	const folderToggleLabel = allFoldersCollapsed ? "Expand all folders" : "Collapse all folders";

	return (
		<>
			<aside className="sidebar">
				<div className="sidebar-heading">
					<div>
						<h1>Capture sets</h1>
					</div>
					<div className="sidebar-create-actions">
						<button
							id="newFolderBtn"
							className="icon-btn"
							title="New folder"
							aria-label="New folder"
							onClick={() => openNewFolder()}
						>
							{FOLDER_ICON}
						</button>
						<button
							id="newCaptureBtn"
							className="icon-btn"
							title="New capture"
							aria-label="New capture"
							onClick={() => actions.openNewCapture()}
						>
							<Plus aria-hidden="true" />
						</button>
					</div>
				</div>
			<div className="sidebar-search-row">
				<button
					id="toggleFoldersBtn"
					className="icon-btn folder-collapse-btn"
					type="button"
					title={folderToggleLabel}
					aria-label={folderToggleLabel}
					aria-pressed={allFoldersCollapsed}
					onClick={() => actions.setAllFoldersCollapsed(!allFoldersCollapsed)}
				>
					{allFoldersCollapsed ? <ChevronsUpDown aria-hidden="true" /> : <ChevronsDownUp aria-hidden="true" />}
				</button>
				<label className="search-box">
					<Search aria-hidden="true" />
					<input
						id="captureSearch"
						type="search"
						placeholder="Filter captures…"
						value={query}
						onChange={event => setQuery(event.currentTarget.value)}
					/>
				</label>
			</div>
			<div id="captureList" className="capture-list">
				{archive.error ? (
					<div className="sidebar-empty" role="alert">
						<strong>Archive unavailable</strong>
						<span>{archive.error.message}</span>
						<button className="btn btn-secondary" type="button" onClick={() => archive.retry()}>Retry</button>
					</div>
				) : archive.visibleCaptures.length ? (
					archive.groups.map(group => (
						<FolderGroup
							key={group.id || "unfiled"}
							group={group}
							searching={archive.searching}
							activeId={selectedCaptureId}
							folderContextMenuOpen={group.id !== "" && folderMenuState?.folderId === group.id}
							contextMenuCaptureId={captureMenuState?.captureId ?? null}
							onToggle={actions.toggleFolder}
							onSelect={actions.selectCapture}
							onCaptureContextMenu={(event, captureId) => {
								event.preventDefault();
								closeFolderMenu();
								setCaptureMenuState({
									captureId,
									clientX: event.clientX,
									clientY: event.clientY,
									origin:
										(event.target instanceof Element ? event.target.closest("button") : null) || event.currentTarget
								});
							}}
							onFolderContextMenu={(event, folderId) => {
								event.preventDefault();
								closeCaptureMenu();
								setFolderMenuState({
									folderId,
									clientX: event.clientX,
									clientY: event.clientY,
									origin:
										(event.target instanceof Element ? event.target.closest("button") : null) || event.currentTarget
								});
							}}
						/>
					))
				) : (
					<div className="sidebar-empty">
						<strong>No matching captures</strong>
						<span>Try another name, folder, view, or parameter.</span>
					</div>
				)}
			</div>
			<div className="sidebar-actions">
				<button id="importBtn" className="text-btn" onClick={() => fileInputRef.current?.click()}>
					<Upload aria-hidden="true" /> Import
				</button>
				<button
					id="exportBtn"
					className="text-btn"
						disabled={!archiveData.captures.length}
					onClick={() => actions.openExport()}
				>
					<Download aria-hidden="true" /> Export
				</button>
				<input
					id="fileInput"
					ref={fileInputRef}
					type="file"
					accept=".txt,.json,.csv"
					hidden
					onChange={event => {
						const file = event.currentTarget.files?.[0];
						if (file) actions.importFile(file);
						event.currentTarget.value = "";
					}}
				/>
			</div>
			</aside>
			<ArchiveFolderDialog
				folderId={folderDialogId}
				isMoveDestination={folderMoveCaptureId !== null}
				onCreated={handleFolderCreated}
				onClose={() => {
					setFolderDialogId(undefined);
					setFolderMoveCaptureId(null);
				}}
			/>
			<CaptureContextMenu
				state={captureMenuState}
				onClose={closeCaptureMenu}
				onCreateFolder={captureId => openNewFolder(captureId)}
			/>
			<FolderContextMenu
				state={folderMenuState}
				onClose={closeFolderMenu}
				onRename={folderId => setFolderDialogId(folderId)}
				onDelete={actions.deleteFolder}
			/>
		</>
	);
}

function FolderContextMenu({
	state,
	onClose,
	onRename,
	onDelete
}: {
	state: FolderContextMenuState | null;
	onClose: (restoreFocus?: boolean) => void;
	onRename: (folderId: string) => void;
	onDelete: (folderId: string) => void;
}) {
	const archive = useArchiveList();
	const menuRef = useRef<HTMLDivElement>(null);
	const positionRef = useRef({ left: 10, top: 10 });
	const [position, setPosition] = useState({ left: 10, top: 10 });
	positionRef.current = position;

	const folder = state ? archive.folders.find(item => item.id === state.folderId) : undefined;

	useLayoutEffect(() => {
		if (!state || !menuRef.current) return;
		const edge = 10;
		const bounds = menuRef.current.getBoundingClientRect();
		const next = {
			left: Math.max(edge, Math.min(state.clientX, window.innerWidth - bounds.width - edge)),
			top: Math.max(edge, Math.min(state.clientY, window.innerHeight - bounds.height - edge))
		};
		if (next.left !== positionRef.current.left || next.top !== positionRef.current.top) setPosition(next);
	}, [state]);

	useEffect(() => {
		if (!state) return;
		const closeOnOutsideClick = (event: MouseEvent) => {
			if (!menuRef.current?.contains(event.target as Node)) onClose();
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose(true);
		};
		const closeOnOutsideContextMenu = (event: MouseEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			if (!target?.closest("#folderContextMenu, #captureList")) onClose();
		};
		const closeOnResize = () => onClose();
		document.addEventListener("click", closeOnOutsideClick);
		document.addEventListener("contextmenu", closeOnOutsideContextMenu);
		document.addEventListener("keydown", closeOnEscape);
		window.addEventListener("resize", closeOnResize);
		return () => {
			document.removeEventListener("click", closeOnOutsideClick);
			document.removeEventListener("contextmenu", closeOnOutsideContextMenu);
			document.removeEventListener("keydown", closeOnEscape);
			window.removeEventListener("resize", closeOnResize);
		};
	}, [onClose, state]);

	return (
		<div
			id="folderContextMenu"
			ref={menuRef}
			onContextMenu={event => event.preventDefault()}
			className={`message-context-menu folder-context-menu ${state && folder ? "" : "hidden"}`.trim()}
			data-folder-id={state?.folderId}
			style={{ left: position.left, top: position.top }}
			role="menu"
			aria-label="Folder actions"
			aria-hidden={state && folder ? "false" : "true"}
		>
			<button
				type="button"
				role="menuitem"
				data-context-action="rename"
				onClick={() => {
					if (!state) return;
					onClose();
					onRename(state.folderId);
				}}
			>
				<Pencil aria-hidden="true" />
				<span>Rename</span>
			</button>
			<button
				type="button"
				role="menuitem"
				className="context-delete"
				data-context-action="delete"
				onClick={() => {
					if (!state) return;
					onClose();
					onDelete(state.folderId);
				}}
			>
				<Trash aria-hidden="true" />
				<span>Delete</span>
			</button>
		</div>
	);
}

function CaptureContextMenu({
	state,
	onClose,
	onCreateFolder
}: {
	state: CaptureContextMenuState | null;
	onClose: (restoreFocus?: boolean) => void;
	onCreateFolder: (captureId: string) => void;
}) {
	const archive = useArchiveList();
	const actions = getArchiveActions();
	const menuRef = useRef<HTMLDivElement>(null);
	const positionRef = useRef({ left: 10, top: 10 });
	const [position, setPosition] = useState({ left: 10, top: 10 });
	const [moveOpen, setMoveOpen] = useState(false);
	positionRef.current = position;

	const capture = state ? archive.captures.find(item => item.id === state.captureId) : undefined;
	const storageStatus = capture ? captureStorageUiStatus(capture.storageStatus) : null;
	const canUpgrade = storageStatus === "legacy" || storageStatus === "failed";
	const currentFolderId = capture?.folderId || null;
	const orderedFolders = [
		...archive.folders.filter(folder => folder.id === currentFolderId),
		...archive.folders.filter(folder => folder.id !== currentFolderId)
	];
	const moveDestinations = [
		...(currentFolderId === null ? [{ id: null, name: "Unfiled" }] : []),
		...orderedFolders.map(folder => ({ id: folder.id, name: folder.name })),
		...(currentFolderId !== null ? [{ id: null, name: "Unfiled" }] : [])
	];

	useEffect(() => {
		setMoveOpen(false);
	}, [state?.captureId]);

	useLayoutEffect(() => {
		if (!state || !menuRef.current) return;
		const edge = 10;
		const bounds = menuRef.current.getBoundingClientRect();
		const next = {
			left: Math.max(edge, Math.min(state.clientX, window.innerWidth - bounds.width - edge)),
			top: Math.max(edge, Math.min(state.clientY, window.innerHeight - bounds.height - edge))
		};
		if (next.left !== positionRef.current.left || next.top !== positionRef.current.top) setPosition(next);
	}, [moveOpen, state]);

	useEffect(() => {
		if (!state) return;
		const closeOnOutsideClick = (event: MouseEvent) => {
			if (!menuRef.current?.contains(event.target as Node)) onClose();
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose(true);
		};
		const closeOnOutsideContextMenu = (event: MouseEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			if (!target?.closest("#captureContextMenu, #captureList")) onClose();
		};
		const closeOnResize = () => onClose();
		document.addEventListener("click", closeOnOutsideClick);
		document.addEventListener("contextmenu", closeOnOutsideContextMenu);
		document.addEventListener("keydown", closeOnEscape);
		window.addEventListener("resize", closeOnResize);
		return () => {
			document.removeEventListener("click", closeOnOutsideClick);
			document.removeEventListener("contextmenu", closeOnOutsideContextMenu);
			document.removeEventListener("keydown", closeOnEscape);
			window.removeEventListener("resize", closeOnResize);
		};
	}, [onClose, state]);

	const handleMove = (folderId: string | null) => {
		if (!state) return;
		onClose();
		actions.moveCapture(state.captureId, folderId);
	};

	return (
		<div
			id="captureContextMenu"
			ref={menuRef}
			onContextMenu={event => event.preventDefault()}
			className={`message-context-menu capture-context-menu ${state && capture ? "" : "hidden"}`.trim()}
			data-capture-id={state?.captureId}
			style={{ left: position.left, top: position.top }}
			role="menu"
			aria-label="Capture actions"
			aria-hidden={state && capture ? "false" : "true"}
		>
			<button
				type="button"
				role="menuitem"
				data-context-action="move"
				aria-haspopup="menu"
				aria-expanded={moveOpen}
				onClick={() => setMoveOpen(open => !open)}
			>
				<span className="capture-context-icon">{FOLDER_ICON}</span>
				<span>Move to</span>
				<span className="capture-context-chevron" aria-hidden="true"><ChevronRight /></span>
			</button>
			{moveOpen ? (
				<div className="capture-context-submenu" role="menu" aria-label="Move capture to folder">
					{moveDestinations.map(destination => (
						<button
							key={destination.id || "unfiled"}
							type="button"
							role="menuitem"
							data-context-action="move-to"
							data-folder-option={destination.id || "unfiled"}
							disabled={currentFolderId === destination.id}
							onClick={() => handleMove(destination.id)}
						>
							<span>{destination.name}</span>
							{currentFolderId === destination.id ? <Check aria-hidden="true" /> : null}
						</button>
					))}
					<button
						type="button"
						role="menuitem"
						className="capture-context-new-folder"
						data-context-action="new-folder"
						onClick={() => {
							if (!state) return;
							onClose();
							onCreateFolder(state.captureId);
						}}
					>
						<Plus aria-hidden="true" />
						<span>New folder…</span>
					</button>
				</div>
			) : null}
			{canUpgrade ? (
				<button
					type="button"
					role="menuitem"
					id="upgradeCaptureBtn"
					data-context-action="upgrade"
					onClick={() => {
						if (!state) return;
						onClose();
						actions.upgradeCapture(state.captureId);
					}}
				>
					<ArrowUp aria-hidden="true" />
					<span>Upgrade</span>
				</button>
			) : null}
			<button
				type="button"
				role="menuitem"
				id="duplicateCaptureContextBtn"
				data-context-action="duplicate"
				onClick={() => {
					if (!state) return;
					onClose();
					actions.duplicateCapture(state.captureId);
				}}
			>
				<Copy aria-hidden="true" />
				<span>Duplicate capture</span>
			</button>
			<button
				type="button"
				role="menuitem"
				className="context-delete"
				data-context-action="delete"
				onClick={() => {
					if (!state) return;
					onClose();
					actions.deleteCapture(state.captureId);
				}}
			>
				<Trash aria-hidden="true" />
				<span>Delete</span>
			</button>
		</div>
	);
}

export function ArchiveFolderDialog({
	folderId,
	isMoveDestination = false,
	onCreated,
	onClose
}: {
	folderId: string | null | undefined;
	isMoveDestination?: boolean;
	onCreated?: (folderId: string) => void;
	onClose: () => void;
}) {
	const archive = useArchiveList();
	const actions = getArchiveActions();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState<{ editingId: string | null; name: string } | null>(null);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (folderId === undefined) {
			if (dialog.open) dialog.close();
			setDraft(null);
			return;
		}
		const folder = archive.folders.find(item => item.id === folderId);
		setDraft({ editingId: folder?.id || null, name: folder?.name || "" });
		if (!dialog.open) dialog.showModal();
		inputRef.current?.focus();
	}, [archive.folders, folderId]);

	const name = draft?.name.trim() || "";
	const editingId = draft?.editingId || null;
	const duplicate = archive.folders.some(
		folder => folder.id !== editingId && folder.name.toLowerCase() === name.toLowerCase()
	);
	const valid = Boolean(name && !duplicate);
	const title = folderId ? "Rename folder" : isMoveDestination ? "Move to new folder" : "Create folder";

	return (
		<dialog id="folderDialog" className="modal folder-modal" ref={dialogRef} onClose={onClose}>
			<form
				id="folderForm"
				method="dialog"
				onSubmit={event => {
					const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
					if (submitter?.value === "cancel") return;
					event.preventDefault();
					if (!valid || !draft) return;
					if (actions.saveFolder(name, editingId, folderId => {
						if (!editingId) onCreated?.(folderId);
					})) {
						if (dialogRef.current?.open) dialogRef.current.close();
						else onClose();
					}
				}}
			>
				<div className="modal-heading">
					<div>
						<h2>{title}</h2>
					</div>
					<button className="icon-btn" value="cancel" formMethod="dialog" formNoValidate aria-label="Close">
						<X aria-hidden="true" />
					</button>
				</div>
				<label className="field">
					Folder name
					<input
						id="folderName"
						required
						maxLength={80}
						placeholder="e.g. Ventilation tests"
						ref={inputRef}
						value={draft?.name || ""}
						onChange={event => {
							const name = event.currentTarget.value;
							setDraft(current => ({ editingId: current?.editingId || editingId, name }));
						}}
					/>
				</label>
				<div id="folderHint" className={`validation-hint ${valid ? "ready" : ""}`} aria-live="polite">
					{duplicate ? "A folder with this name already exists." : name ? "Ready to save." : "Enter a folder name."}
				</div>
				<div className="modal-actions">
					<button className="btn btn-secondary" value="cancel" formMethod="dialog" formNoValidate>
						Cancel
					</button>
					<button id="saveFolderBtn" className="btn btn-primary" value="default" disabled={!valid}>
						{folderId ? "Save name" : "Create folder"}
					</button>
				</div>
			</form>
		</dialog>
	);
}

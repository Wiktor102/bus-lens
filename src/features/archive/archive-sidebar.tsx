import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type MouseEvent as ReactMouseEvent
} from "react";
import { getArchiveActions, getArchiveSnapshot, subscribeToArchive } from "./archive-bridge";
import { buildArchiveGroups, type ArchiveCapture, type ArchiveGroup } from "./archive-list";

const FOLDER_ICON = (
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<path d="M3.75 6.75h5.1l1.8 2.1h9.6v8.4a1.5 1.5 0 0 1-1.5 1.5h-15a1.5 1.5 0 0 1-1.5-1.5v-9a1.5 1.5 0 0 1 1.5-1.5Z" />
		<path d="M2.25 10.35h18" />
	</svg>
);

type CaptureContextMenuState = {
	captureId: string;
	clientX: number;
	clientY: number;
	origin: HTMLElement;
};

function FolderGroup({
	group,
	searching,
	activeId,
	onToggle,
	onRename,
	onDelete,
	onSelect,
	onContextMenu
}: {
	group: ArchiveGroup;
	searching: boolean;
	activeId: string | null | undefined;
	onToggle: (folderId: string | null) => void;
	onRename: (folderId: string) => void;
	onDelete: (folderId: string) => void;
	onSelect: (captureId: string) => void;
	onContextMenu: (event: ReactMouseEvent<HTMLDivElement>, captureId: string) => void;
}) {
	const collapsed = group.collapsed && !searching;

	return (
		<section className={`capture-folder ${collapsed ? "collapsed" : ""}`} data-folder-id={group.id}>
			<header className="folder-header">
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
					<small>{group.captures.length}</small>
				</button>
				{group.system ? (
					<span className="folder-actions folder-actions-placeholder" aria-hidden="true" />
				) : (
					<span className="folder-actions">
						<button
							type="button"
							data-folder-rename={group.id}
							title="Rename folder"
							aria-label={`Rename ${group.name}`}
							onClick={() => onRename(group.id)}
						>
							✎
						</button>
						<button
							type="button"
							data-folder-delete={group.id}
							title="Delete folder"
							aria-label={`Delete ${group.name}`}
							onClick={() => onDelete(group.id)}
						>
							×
						</button>
					</span>
				)}
			</header>
			<div className="folder-captures">
				{group.captures.length ? (
					group.captures.map(capture => (
						<CaptureItem
							key={capture.id}
							capture={capture}
							active={capture.id === activeId}
							onSelect={onSelect}
							onContextMenu={event => onContextMenu(event, capture.id)}
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
	onSelect,
	onContextMenu
}: {
	capture: ArchiveCapture;
	active: boolean;
	onSelect: (captureId: string) => void;
	onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
	return (
		<div
			className={`capture-item ${active ? "active" : ""}`}
			onContextMenu={onContextMenu}
		>
			<button className="capture-open" type="button" data-capture-id={capture.id} onClick={() => onSelect(capture.id)}>
				<strong>{capture.name}</strong>
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
	const snapshot = useSyncExternalStore(subscribeToArchive, getArchiveSnapshot, getArchiveSnapshot);
	const actions = getArchiveActions();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [folderDialogId, setFolderDialogId] = useState<string | null | undefined>(undefined);
	const [folderMoveCaptureId, setFolderMoveCaptureId] = useState<string | null>(null);
	const [captureMenuState, setCaptureMenuState] = useState<CaptureContextMenuState | null>(null);
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
	const archive = useMemo(
		() => buildArchiveGroups(snapshot.captures, snapshot.folders, query, snapshot.unfiledCollapsed),
		[snapshot, query]
	);

	return (
		<>
			<aside className="sidebar">
				<div className="sidebar-heading">
					<div>
						<span className="eyebrow">Archive</span>
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
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<path d="M3.75 6.75h5.1l1.8 2.1h9.6v8.4a1.5 1.5 0 0 1-1.5 1.5h-15a1.5 1.5 0 0 1-1.5-1.5v-9a1.5 1.5 0 0 1 1.5-1.5Z" />
								<path d="M2.25 10.35h18" />
							</svg>
						</button>
						<button
							id="newCaptureBtn"
							className="icon-btn"
							title="New capture"
							aria-label="New capture"
							onClick={actions.openNewCapture}
						>
							＋
						</button>
					</div>
				</div>
			<label className="search-box">
				<span>⌕</span>
				<input
					id="captureSearch"
					type="search"
					placeholder="Filter captures…"
					value={query}
					onChange={event => setQuery(event.currentTarget.value)}
				/>
			</label>
			<div id="captureList" className="capture-list">
				{archive.visibleCaptures.length ? (
					archive.groups.map(group => (
						<FolderGroup
							key={group.id || "unfiled"}
							group={group}
							searching={archive.searching}
							activeId={snapshot.activeId}
							onToggle={actions.toggleFolder}
							onRename={folderId => setFolderDialogId(folderId)}
							onDelete={actions.deleteFolder}
							onSelect={actions.selectCapture}
							onContextMenu={(event, captureId) => {
								event.preventDefault();
								setCaptureMenuState({
									captureId,
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
					↥ Import
				</button>
				<button
					id="exportBtn"
					className="text-btn"
					disabled={!snapshot.captures.length}
					onClick={actions.openExport}
				>
					↧ Export
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
		</>
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
	const snapshot = useSyncExternalStore(subscribeToArchive, getArchiveSnapshot, getArchiveSnapshot);
	const actions = getArchiveActions();
	const menuRef = useRef<HTMLDivElement>(null);
	const positionRef = useRef({ left: 10, top: 10 });
	const [position, setPosition] = useState({ left: 10, top: 10 });
	const [moveOpen, setMoveOpen] = useState(false);
	positionRef.current = position;

	const capture = state ? snapshot.captures.find(item => item.id === state.captureId) : undefined;
	const currentFolderId = capture?.folderId || null;
	const orderedFolders = [
		...snapshot.folders.filter(folder => folder.id === currentFolderId),
		...snapshot.folders.filter(folder => folder.id !== currentFolderId)
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
				<span className="capture-context-chevron" aria-hidden="true">›</span>
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
							{currentFolderId === destination.id ? <span aria-hidden="true">✓</span> : null}
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
						<span aria-hidden="true">＋</span>
						<span>New folder…</span>
					</button>
				</div>
			) : null}
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
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<path d="M5.5 7.5h13M9.5 7.5V5h5v2.5M7 7.5l.75 12h8.5L17 7.5M10 11v5.5M14 11v5.5" />
				</svg>
				<span>Delete</span>
			</button>
		</div>
	);
}

export function ArchiveFolderDialog({
	folderId,
	onCreated,
	onClose
}: {
	folderId: string | null | undefined;
	onCreated?: (folderId: string) => void;
	onClose: () => void;
}) {
	const snapshot = useSyncExternalStore(subscribeToArchive, getArchiveSnapshot, getArchiveSnapshot);
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
		const folder = snapshot.folders.find(item => item.id === folderId);
		setDraft({ editingId: folder?.id || null, name: folder?.name || "" });
		if (!dialog.open) dialog.showModal();
		inputRef.current?.focus();
	}, [folderId]);

	const name = draft?.name.trim() || "";
	const editingId = draft?.editingId || null;
	const duplicate = snapshot.folders.some(
		folder => folder.id !== editingId && folder.name.toLowerCase() === name.toLowerCase()
	);
	const valid = Boolean(name && !duplicate);
	const title = folderId ? "Rename folder" : "Create folder";

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
					if (actions.saveFolder(name, editingId)) {
						if (!editingId) {
							const createdFolder = getArchiveSnapshot().folders.find(
								folder => folder.name.toLowerCase() === name.toLowerCase()
							);
							if (createdFolder) onCreated?.(createdFolder.id);
						}
						if (dialogRef.current?.open) dialogRef.current.close();
						else onClose();
					}
				}}
			>
				<div className="modal-heading">
					<div>
						<span className="eyebrow">Archive organization</span>
						<h2>{title}</h2>
					</div>
					<button className="icon-btn" value="cancel" formMethod="dialog" formNoValidate aria-label="Close">
						×
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

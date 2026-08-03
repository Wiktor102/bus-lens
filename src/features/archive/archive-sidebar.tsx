import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getArchiveActions, getArchiveSnapshot, subscribeToArchive } from "./archive-bridge";
import { buildArchiveGroups, type ArchiveCapture, type ArchiveGroup } from "./archive-list";

const FOLDER_ICON = (
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<path d="M3.75 6.75h5.1l1.8 2.1h9.6v8.4a1.5 1.5 0 0 1-1.5 1.5h-15a1.5 1.5 0 0 1-1.5-1.5v-9a1.5 1.5 0 0 1 1.5-1.5Z" />
		<path d="M2.25 10.35h18" />
	</svg>
);

function FolderGroup({
	group,
	searching,
	activeId,
	onToggle,
	onRename,
	onDelete,
	onSelect,
	onMove,
	folders
}: {
	group: ArchiveGroup;
	searching: boolean;
	activeId: string | null | undefined;
	onToggle: (folderId: string | null) => void;
	onRename: (folderId: string) => void;
	onDelete: (folderId: string) => void;
	onSelect: (captureId: string) => void;
	onMove: (captureId: string, folderId: string | null) => void;
	folders: { id: string; name: string }[];
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
							folders={folders}
							onSelect={onSelect}
							onMove={onMove}
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
	folders,
	onSelect,
	onMove
}: {
	capture: ArchiveCapture;
	active: boolean;
	folders: { id: string; name: string }[];
	onSelect: (captureId: string) => void;
	onMove: (captureId: string, folderId: string | null) => void;
}) {
	return (
		<div className={`capture-item ${active ? "active" : ""}`}>
			<button className="capture-open" type="button" data-capture-id={capture.id} onClick={() => onSelect(capture.id)}>
				<strong>{capture.name}</strong>
				<small>
					<span>{capture.view || "Unassigned view"}</span>
					<span>{capture.messageCount} msg</span>
				</small>
				<span className="capture-tags">
					{capture.params.slice(0, 2).map(parameter => (
						<i key={`${parameter.key}:${parameter.value}`}>
							{parameter.key}: {parameter.value}
						</i>
					))}
				</span>
			</button>
			<label className="capture-move" title="Move capture to another folder">
				<span>Move to</span>
				<select
					data-capture-folder={capture.id}
					aria-label={`Move ${capture.name} to folder`}
					value={capture.folderId || ""}
					onChange={event => onMove(capture.id, event.currentTarget.value || null)}
				>
					<option value="">Unfiled</option>
					{folders.map(folder => (
						<option key={folder.id} value={folder.id} data-folder-option={folder.id}>
							{folder.name}
						</option>
					))}
				</select>
			</label>
		</div>
	);
}

export function ArchiveSidebar() {
	const snapshot = useSyncExternalStore(subscribeToArchive, getArchiveSnapshot, getArchiveSnapshot);
	const actions = getArchiveActions();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [folderDialogId, setFolderDialogId] = useState<string | null | undefined>(undefined);
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
							onClick={() => setFolderDialogId(null)}
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
							folders={snapshot.folders}
							onToggle={actions.toggleFolder}
							onRename={folderId => setFolderDialogId(folderId)}
							onDelete={actions.deleteFolder}
							onSelect={actions.selectCapture}
							onMove={actions.moveCapture}
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
				onClose={() => setFolderDialogId(undefined)}
			/>
		</>
	);
}

export function ArchiveFolderDialog({
	folderId,
	onClose
}: {
	folderId: string | null | undefined;
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
						onChange={event => setDraft(current => ({ editingId: current?.editingId || editingId, name: event.currentTarget.value }))}
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

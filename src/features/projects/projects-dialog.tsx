import { useEffect, useRef, useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import type { ProjectSummary } from "../../persistence/archive-client.ts";
import { useArchiveCommands, useProjects } from "../../data/archive-react";
import {
	DEFAULT_PROJECT_ID,
	normalizeProjectName,
	projectDeletionBlocker,
	projectNameIsValid
} from "./projects-model";

type RenameDraft = Readonly<{ projectId: string; name: string }>;
type PendingProjectAction = Readonly<{ projectId: string }>;

function ProjectRow({
	project,
	activeProjectId,
	busy,
	onRename,
	onDelete
}: {
	project: ProjectSummary;
	activeProjectId: string | null;
	busy: boolean;
	onRename: (projectId: string, name: string) => void;
	onDelete: (projectId: string) => void;
}) {
	const [renaming, setRenaming] = useState<RenameDraft | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const blocker = projectDeletionBlocker(project, activeProjectId);
	const isActive = project.id === activeProjectId;

	useEffect(() => {
		if (!confirmingDelete) return;
		const timer = setTimeout(() => setConfirmingDelete(false), 4000);
		return () => clearTimeout(timer);
	}, [confirmingDelete]);

	if (renaming && renaming.projectId === project.id) {
		return (
			<li className="project-row" data-project-id={project.id}>
				<form
					className="project-row-main"
					onSubmit={event => {
						event.preventDefault();
						const name = normalizeProjectName(renaming.name);
						if (!projectNameIsValid(name)) return;
						onRename(project.id, name);
						setRenaming(null);
					}}
				>
					<input
						aria-label="Project name"
						value={renaming.name}
						autoFocus
						onChange={event => setRenaming({ projectId: project.id, name: event.currentTarget.value })}
					/>
					<button className="icon-btn" type="submit" disabled={!projectNameIsValid(renaming.name)} aria-label="Save name">
						<Check aria-hidden="true" />
					</button>
					<button className="icon-btn" type="button" aria-label="Cancel rename" onClick={() => setRenaming(null)}>
						<X aria-hidden="true" />
					</button>
				</form>
			</li>
		);
	}

	return (
		<li className="project-row" data-project-id={project.id} data-active={isActive || undefined}>
			<div className="project-row-main">
				<div className="project-copy">
					<strong>{project.name}</strong>
					{isActive ? <span className="project-active-chip">Active</span> : null}
					{project.id === DEFAULT_PROJECT_ID ? <span className="project-default-chip">Default</span> : null}
					<small title={project.dbPath}>{project.dbPath}</small>
				</div>
				<div className="project-row-actions">
					<button
						className="icon-btn"
						type="button"
						disabled={busy}
						aria-label={`Rename ${project.name}`}
						onClick={() => setRenaming({ projectId: project.id, name: project.name })}
					>
						<Pencil aria-hidden="true" />
					</button>
					<button
						id={`deleteProject-${project.id}`}
						className={`icon-btn danger ${confirmingDelete ? "confirming" : ""}`.trim()}
						type="button"
						disabled={busy || Boolean(blocker)}
						title={blocker ?? undefined}
						aria-label={confirmingDelete ? `Confirm delete ${project.name}` : `Delete ${project.name}`}
						onClick={() => {
							if (!confirmingDelete) {
								setConfirmingDelete(true);
								return;
							}
							setConfirmingDelete(false);
							onDelete(project.id);
						}}
					>
						<Trash2 aria-hidden="true" />
					</button>
				</div>
			</div>
			{blocker ? <small className="project-blocker">{blocker}</small> : null}
		</li>
	);
}

export function ProjectsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const commands = useArchiveCommands();
	const projectsQuery = useProjects();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const nameRef = useRef<HTMLInputElement>(null);
	const activeProjectId = commands.activeProjectId();
	const projects = projectsQuery.data ?? [];
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	// Only the row being renamed/deleted locks up; unrelated rows stay
	// interactive during list refetches and other rows' mutations.
	const [pendingAction, setPendingAction] = useState<PendingProjectAction | null>(null);
	const [creating, setCreating] = useState(false);
	// A ref keeps the guard synchronous: two rapid Enter presses both see it
	// before any re-render could update state.
	const creatingRef = useRef(false);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (!open) {
			if (dialog.open) dialog.close();
			setDraft("");
			setError(null);
			return;
		}
		if (!dialog.open) dialog.showModal();
	}, [open]);

	const create = async () => {
		if (creatingRef.current) return;
		const name = normalizeProjectName(draft);
		if (!projectNameIsValid(name)) return;
		creatingRef.current = true;
		setCreating(true);
		try {
			await commands.createProject(name);
			setDraft("");
			setError(null);
		} catch (createError) {
			setError(createError instanceof Error ? createError.message : "Could not create the project");
		} finally {
			creatingRef.current = false;
			setCreating(false);
		}
	};

	return (
		<dialog
			id="projectsDialog"
			className="modal projects-modal"
			ref={dialogRef}
			onClose={() => onClose()}
			onCancel={event => {
				event.preventDefault();
				onClose();
			}}
		>
			<div className="modal-heading">
				<div>
					<span className="eyebrow">Workspaces</span>
					<h2>Projects</h2>
				</div>
				<button className="icon-btn" type="button" aria-label="Close" onClick={() => onClose()}>
					<X aria-hidden="true" />
				</button>
			</div>
			<p className="modal-lede">
				Each project is a separate capture database with its own folders, notes, and send queue.
			</p>
			<form
				id="projectCreateForm"
				className="project-create"
				onSubmit={event => {
					event.preventDefault();
					void create();
				}}
			>
				<label className="field">
					New project
					<input
						ref={nameRef}
						placeholder="e.g. Bench tests"
						value={draft}
						onChange={event => setDraft(event.currentTarget.value)}
					/>
				</label>
			<button id="createProjectBtn" className="btn btn-primary" type="submit" disabled={creating || !projectNameIsValid(draft)}>
				<Plus aria-hidden="true" /> Create
			</button>
			</form>
			{error ? <p className="conversion-error" role="alert">{error}</p> : null}
			<ul id="projectsList" className="projects-list">
				{projects.map(project => (
					<ProjectRow
						key={project.id}
						project={project}
						activeProjectId={activeProjectId}
						busy={pendingAction?.projectId === project.id}
						onRename={(projectId, name) => {
							setPendingAction({ projectId });
							void commands.renameProject(projectId, name)
								.catch(renameError =>
									setError(renameError instanceof Error ? renameError.message : "Could not rename the project")
								)
								.finally(() => setPendingAction(null));
						}}
						onDelete={projectId => {
							setPendingAction({ projectId });
							void commands.deleteProject(projectId)
								.catch(deleteError =>
									setError(deleteError instanceof Error ? deleteError.message : "Could not delete the project")
								)
								.finally(() => setPendingAction(null));
						}}
					/>
				))}
				{!projects.length && !projectsQuery.isLoading ? (
					<li className="muted">No registered projects.</li>
				) : null}
			</ul>
			<p className="project-switch-hint">
				Use the project selector in the toolbar to switch; switching reloads the workbench.
			</p>
			<div className="modal-actions">
				<button className="btn btn-secondary" type="button" onClick={() => onClose()}>
					Done
				</button>
			</div>
		</dialog>
	);
}

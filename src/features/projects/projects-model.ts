import type { ProjectSummary } from "../../persistence/archive-client.ts";

export const MANAGE_PROJECTS_VALUE = "__bus-lens-manage__";
export const DEFAULT_PROJECT_ID = "default";

export type ProjectOption = Readonly<{
	value: string;
	label: string;
	isDefault: boolean;
}>;

export type ProjectSelectorState = Readonly<{
	options: readonly ProjectOption[];
	activeValue: string;
	disabled: boolean;
	/** Present only while disabled; explains why the control cannot switch now. */
	disabledReason: string | null;
}>;

export type ProjectSelectorInput = Readonly<{
	projects: readonly ProjectSummary[];
	activeProjectId: string | null;
	transportConnected: boolean;
	recordingCaptureId: string | null;
}>;

/**
 * The Default project always leads the list so a fresh install has exactly one
 * meaningful choice; everything else follows registry creation order.
 */
export function orderedProjectOptions(projects: readonly ProjectSummary[]): ProjectOption[] {
	const sorted = [...projects].sort((left, right) => {
		if ((left.id === DEFAULT_PROJECT_ID) !== (right.id === DEFAULT_PROJECT_ID)) {
			return left.id === DEFAULT_PROJECT_ID ? -1 : 1;
		}
		return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id.localeCompare(right.id);
	});
	return sorted.map(project => ({
		value: project.id,
		label: project.id === DEFAULT_PROJECT_ID ? `${project.name} (Default)` : project.name,
		isDefault: project.id === DEFAULT_PROJECT_ID
	}));
}

export function deriveProjectSelectorState(input: ProjectSelectorInput): ProjectSelectorState {
	const busy = input.transportConnected || input.recordingCaptureId !== null;
	return {
		options: orderedProjectOptions(input.projects),
		activeValue: input.activeProjectId ?? DEFAULT_PROJECT_ID,
		disabled: busy,
		disabledReason: busy
			? input.recordingCaptureId !== null
				? "Stop recording before switching projects"
				: "Disconnect the serial port before switching projects"
			: null
	};
}

/** Server-mirrored guard text; null means the delete request may proceed. */
export function projectDeletionBlocker(
	project: Pick<ProjectSummary, "id">,
	activeProjectId: string | null
): string | null {
	if (project.id === DEFAULT_PROJECT_ID) return "The Default project cannot be deleted.";
	if (project.id === activeProjectId) return "Switch away from this project before deleting it.";
	return null;
}

export function normalizeProjectName(value: string): string {
	return value.trim().slice(0, 200);
}

export function projectNameIsValid(value: string): boolean {
	return normalizeProjectName(value).length > 0;
}

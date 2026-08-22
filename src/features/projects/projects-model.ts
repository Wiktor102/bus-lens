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
 * meaningful choice; everything else follows registry creation order. Names
 * are not unique server-side, so duplicates are disambiguated with a short id
 * suffix instead of silently coexisting.
 */
export function orderedProjectOptions(projects: readonly ProjectSummary[]): ProjectOption[] {
	const sorted = [...projects].sort((left, right) => {
		if ((left.id === DEFAULT_PROJECT_ID) !== (right.id === DEFAULT_PROJECT_ID)) {
			return left.id === DEFAULT_PROJECT_ID ? -1 : 1;
		}
		return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id.localeCompare(right.id);
	});
	const nameCounts = new Map<string, number>();
	for (const project of sorted) nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1);
	return sorted.map(project => ({
		value: project.id,
		label: projectLabel(project, nameCounts.get(project.name) ?? 1),
		isDefault: project.id === DEFAULT_PROJECT_ID
	}));
}

function projectLabel(project: ProjectSummary, sameNameCount: number): string {
	const base = project.id === DEFAULT_PROJECT_ID ? `${project.name} (Default)` : project.name;
	if (sameNameCount > 1 && project.id !== DEFAULT_PROJECT_ID) return `${base} · ${project.id.slice(0, 8)}`;
	return base;
}

export function deriveProjectSelectorState(input: ProjectSelectorInput): ProjectSelectorState {
	const busy = input.transportConnected || input.recordingCaptureId !== null;
	const options = orderedProjectOptions(input.projects);
	// A stored id can dangle when another profile deleted that project. The
	// data layer heals it back to Default, but until the list confirms that,
	// showing an explicit entry beats a silently blank controlled select.
	const stored = input.activeProjectId;
	if (stored && !options.some(option => option.value === stored)) {
		options.unshift({ value: stored, label: "Unknown project", isDefault: false });
	}
	return {
		options,
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

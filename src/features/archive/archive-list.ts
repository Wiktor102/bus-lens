export type ArchiveParameter = {
	key: string;
	value: string;
};

export type ArchiveCapture = {
	id: string;
	name: string;
	view: string;
	folderId: string | null;
	params: ArchiveParameter[];
	messageCount: number;
};

export type ArchiveFolder = {
	id: string;
	name: string;
	collapsed: boolean;
};

export type ArchiveGroup = ArchiveFolder & {
	captures: ArchiveCapture[];
	system?: boolean;
};

export function buildArchiveGroups(
	captures: ArchiveCapture[],
	folders: ArchiveFolder[],
	query: string,
	unfiledCollapsed = false
) {
	const normalizedQuery = query.trim().toLowerCase();
	const folderNameById = new Map(folders.map(folder => [folder.id, folder.name]));
	const visibleCaptures = captures.filter(capture =>
		`${capture.name} ${capture.view} ${folderNameById.get(capture.folderId || "") || "unfiled"} ${capture.params
			.map(parameter => `${parameter.key} ${parameter.value}`)
			.join(" ")}`
			.toLowerCase()
			.includes(normalizedQuery)
	);
	const groups: ArchiveGroup[] = [
		...folders.map(folder => ({
			...folder,
			captures: visibleCaptures.filter(capture => capture.folderId === folder.id)
		})),
		{
			id: "",
			name: "Unfiled",
			collapsed: Boolean(unfiledCollapsed),
			captures: visibleCaptures.filter(capture => !capture.folderId),
			system: true
		}
	].filter(group => !normalizedQuery || group.captures.length);

	return { visibleCaptures, groups, searching: Boolean(normalizedQuery) };
}

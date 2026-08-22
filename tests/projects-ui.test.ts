import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSummary } from "../src/persistence/archive-client.ts";
import {
	MANAGE_PROJECTS_VALUE,
	deriveProjectSelectorState,
	normalizeProjectName,
	orderedProjectOptions,
	projectDeletionBlocker,
	projectNameIsValid
} from "../src/features/projects/projects-model.ts";

function project(id: string, name = id, createdAt = id): ProjectSummary {
	return { id, name, dbPath: `/data/projects/${id}.sqlite`, createdAt, lastUsedAt: createdAt };
}

test("selector options pin the Default project first and keep registry order otherwise", () => {
	const options = orderedProjectOptions([project("zeta"), project("default", "Default"), project("alpha")]);
	assert.deepEqual(options.map(option => option.value), ["default", "alpha", "zeta"]);
	assert.equal(options[0]?.label, "Default (Default)");
	assert.equal(options.find(option => option.value === "default")?.isDefault, true);
});

test("the selector disables switching while connected or recording and explains why", () => {
	const base = {
		projects: [project("default", "Default")],
		activeProjectId: null
	};
	const idle = deriveProjectSelectorState({ ...base, transportConnected: false, recordingCaptureId: null });
	assert.equal(idle.disabled, false);
	assert.equal(idle.disabledReason, null);
	assert.equal(idle.activeValue, "default");

	const recording = deriveProjectSelectorState({ ...base, transportConnected: true, recordingCaptureId: "cap-1" });
	assert.equal(recording.disabled, true);
	assert.match(recording.disabledReason ?? "", /recording/i);

	const connected = deriveProjectSelectorState({ ...base, transportConnected: true, recordingCaptureId: null });
	assert.equal(connected.disabled, true);
	assert.match(connected.disabledReason ?? "", /disconnect/i);
});

test("deletion guards mirror the server contract for Default and active projects", () => {
	assert.match(projectDeletionBlocker({ id: "default" }, null) ?? "", /Default project cannot be deleted/);
	assert.match(projectDeletionBlocker({ id: "p-1" }, "p-1") ?? "", /Switch away/);
	assert.equal(projectDeletionBlocker({ id: "p-1" }, "p-2"), null);
});

test("project names are trimmed and bounded before validation", () => {
	assert.equal(normalizeProjectName("  Bench tests \n"), "Bench tests");
	assert.equal(normalizeProjectName("x".repeat(300)).length, 200);
	assert.equal(projectNameIsValid("   "), false);
	assert.equal(projectNameIsValid("Field log"), true);
});

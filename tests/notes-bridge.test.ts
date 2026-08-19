import assert from "node:assert/strict";
import test from "node:test";
import { getNotesActions } from "../src/features/notes/notes-bridge.ts";
import { applicationStore, type ApplicationCommand } from "../src/shared/application-store.ts";

test("keeps rejected note drafts and dispatches normalized valid text", () => {
	const commands: ApplicationCommand[] = [];
	const unsubscribe = applicationStore.subscribeToCommands(command => commands.push(command));
	try {
		const actions = getNotesActions();
		assert.equal(actions.addSequenceNote({ start: 1, end: 2, text: "   " }), false);
		assert.deepEqual(commands, []);

		assert.equal(actions.addSequenceNote({ start: 1, end: 2, text: "  observation  " }), true);
		assert.deepEqual(commands, [{
			type: "notes/add-sequence",
			start: 1,
			end: 2,
			text: "observation"
		}]);
	} finally {
		unsubscribe();
	}
});

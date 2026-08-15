import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY
} from "@modelcontextprotocol/server";
import { ArchiveRepository } from "../server/archive-repository.ts";
import { CanonicalCaptureCommandService } from "../server/canonical-capture-command-service.ts";
import { CanonicalQueryService } from "../server/canonical-query.ts";
import { openDatabase } from "../server/database.ts";
import { createArchiveHttpService } from "../server/http-service.ts";

function seed() {
	const database = openDatabase(":memory:", () => "2026-08-10T00:00:00.000Z");
	const commands = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-10T00:00:00.000Z" });
	commands.createCapture({ captureId: "navigation-capture", framing: [{ start: 0, framingMode: "length", frameSize: 2 }], inputFormat: "binary" });
	commands.startSession({ captureId: "navigation-capture", sessionId: "navigation-session" });
	const append = commands.appendChunk({ captureId: "navigation-capture", sessionId: "navigation-session", requestId: "navigation-request", sequence: 0, expectedStartOffset: 0, bytes: [1, 2, 3, 4] });
	const finalized = commands.finalizeSession({ captureId: "navigation-capture", sessionId: "navigation-session", expectedDataRevision: append.dataRevision });
	const firstFrame = database.prepare("SELECT id FROM materialized_frames WHERE capture_id = 'navigation-capture' AND profile_id = @profileId AND ordinal = 0").get({ profileId: finalized.profileId }) as { id: string };
	const reframed = commands.reframe({
		captureId: "navigation-capture",
		expectedActiveProfileId: finalized.profileId,
		expectedDataRevision: finalized.dataRevision,
		sections: [{ start: 0, framingMode: "length", frameSize: 4 }]
	});
	const secondFrame = database.prepare("SELECT id FROM materialized_frames WHERE capture_id = 'navigation-capture' AND profile_id = @profileId AND ordinal = 0").get({ profileId: reframed.profileId }) as { id: string };
	return { database, commands, firstProfile: finalized, secondProfile: reframed, firstFrameId: firstFrame.id, secondFrameId: secondFrame.id };
}

async function modernCall(baseUrl: string, name: string, argumentsValue: Record<string, unknown>): Promise<Response> {
	return fetch(`${baseUrl}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2026-07-28",
			"Mcp-Method": "tools/call",
			"Mcp-Name": name
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name,
				arguments: argumentsValue,
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
					[CLIENT_INFO_META_KEY]: { name: "evidence-navigation-test", version: "1.0" },
					[CLIENT_CAPABILITIES_META_KEY]: {}
				}
			}
		})
	});
}

test("framing profile discovery exposes raw, current, and historical selections", () => {
	const { database, firstProfile, secondProfile } = seed();
	try {
		const queries = new CanonicalQueryService(database);
		const firstPage = queries.listFramingProfiles({ captureId: "navigation-capture", limit: 1 });
		assert.equal(firstPage.data.activeProfileId, secondProfile.profileId);
		assert.equal(firstPage.data.activeProfile?.version, secondProfile.version);
		assert.equal(firstPage.data.profiles.length, 1);
		assert.equal(firstPage.data.profiles[0]?.id, secondProfile.profileId);
		assert.equal(firstPage.data.profiles[0]?.createdAt, "2026-08-10T00:00:00.000Z");
		assert.equal(firstPage.data.profiles[0]?.sourceDataRevision, secondProfile.sourceDataRevision);
		assert.match(firstPage.data.profiles[0]?.framingSummary.text ?? "", /length.*4 bytes/);
		assert.equal(firstPage.data.selectionOptions.raw.kind, "raw");
		assert.equal(firstPage.data.selectionOptions.raw.sourceDataRevision, secondProfile.sourceDataRevision);
		assert.equal(firstPage.data.selectionOptions.current?.profileId, secondProfile.profileId);
		assert.deepEqual(firstPage.data.selectionOptions.historical, []);
		assert.ok(firstPage.meta.page?.nextCursor);

		const secondPage = queries.listFramingProfiles({ captureId: "navigation-capture", cursor: firstPage.meta.page?.nextCursor, limit: 1 });
		assert.deepEqual(secondPage.data.profiles.map(profile => profile.id), [firstProfile.profileId]);
		assert.deepEqual(secondPage.data.selectionOptions.historical.map(selection => selection.profileId), [firstProfile.profileId]);
		assert.equal(secondPage.meta.page?.nextCursor, undefined);
	} finally {
		database.close();
	}
});

test("note queries return bounded text, exact anchors, filters, and keyset pages", () => {
	const { database, commands, firstProfile, secondProfile, firstFrameId, secondFrameId } = seed();
	try {
		new ArchiveRepository(database).setSetting("allow_agent_authored_notes", true);
		commands.createNote({ captureId: "navigation-capture", noteId: "old-frame-note", text: "The first framing was selected for the initial observation.", target: { kind: "frame", frameId: firstFrameId }, createdAt: "2026-08-10T00:00:01.000Z" });
		commands.createNote({ captureId: "navigation-capture", noteId: "raw-action-note", text: "Raw byte 2 was hidden during review.", target: { kind: "raw-range", startRawOffset: 2, endRawOffset: 2 }, createdAt: "2026-08-10T00:00:02.000Z" });
		commands.createAgentNote({
			captureId: "navigation-capture",
			noteId: "current-agent-note",
			text: "Known state: the current profile frames all four retained bytes together.",
			target: { kind: "frame", frameId: secondFrameId },
			profileId: secondProfile.profileId,
			profileVersion: secondProfile.version,
			sourceDataRevision: secondProfile.sourceDataRevision,
			attribution: { authorType: "agent", reportedClientName: "navigation-test", protocolVersion: "2026-07-28" }
		});
		const queries = new CanonicalQueryService(database);

		const byFrame = queries.queryNotes({ frameId: firstFrameId, textLimit: 12 });
		assert.deepEqual(byFrame.data.notes.map(note => note.id), ["old-frame-note"]);
		assert.equal(byFrame.data.notes[0]?.text, "The first f…");
		assert.equal(byFrame.data.notes[0]?.textTruncated, true);
		assert.equal(byFrame.data.notes[0]?.anchors.frameId, firstFrameId);
		assert.equal(byFrame.data.notes[0]?.anchors.profileId, firstProfile.profileId);
		assert.equal(byFrame.data.notes[0]?.anchors.profileVersion, firstProfile.profileVersion);
		assert.deepEqual(byFrame.data.notes[0]?.anchors.rawRange, { startOffset: 0, endOffset: 1 });

		const byRawRange = queries.queryNotes({ captureId: "navigation-capture", rawOffsetFrom: 1, rawOffsetTo: 2, authorType: "human", limit: 1 });
		assert.equal(byRawRange.data.notes.length, 1);
		assert.ok(byRawRange.meta.page?.nextCursor);
		const nextRawPage = queries.queryNotes({ captureId: "navigation-capture", rawOffsetFrom: 1, rawOffsetTo: 2, authorType: "human", cursor: byRawRange.meta.page?.nextCursor, limit: 10 });
		assert.deepEqual(nextRawPage.data.notes.map(note => note.id), ["old-frame-note"]);

		const agentNotes = queries.queryNotes({ captureId: "navigation-capture", authorType: "agent" });
		assert.deepEqual(agentNotes.data.notes.map(note => note.id), ["current-agent-note"]);
		assert.equal(agentNotes.data.notes[0]?.anchors.sourceDataRevision, secondProfile.sourceDataRevision);
		const timeFiltered = queries.queryNotes({ captureId: "navigation-capture", createdFrom: "2026-08-10T00:00:02.000Z", createdTo: "2026-08-10T00:00:02.000Z" });
		assert.deepEqual(timeFiltered.data.notes.map(note => note.id), ["raw-action-note"]);
	} finally {
		database.close();
	}
});

test("message context can include short note summaries without changing note ID references", () => {
	const { database, commands, secondFrameId, secondProfile } = seed();
	try {
		commands.createNote({ captureId: "navigation-capture", noteId: "context-note", text: "Known state: this is the selected current framing.", target: { kind: "frame", frameId: secondFrameId }, createdAt: "2026-08-10T00:00:03.000Z" });
		const queries = new CanonicalQueryService(database);
		const context = queries.getMessageContext({ frameId: secondFrameId, rowsBefore: 1, rowsAfter: 1, includeNoteSummaries: true });
		const center = context.data.messages.find(message => message.frameId === secondFrameId);
		assert.ok(center);
		assert.deepEqual(center.noteReferences, ["context-note"]);
		assert.equal(center.noteSummaries?.[0]?.id, "context-note");
		assert.match(center.noteSummaries?.[0]?.textPreview ?? "", /Known state/);
		assert.equal(center.noteSummaries?.[0]?.profileId, secondProfile.profileId);
	} finally {
		database.close();
	}
});

test("MCP publishes and executes both evidence-navigation tools", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-mcp-evidence-navigation-"));
	const service = createArchiveHttpService({ databasePath: join(directory, "archive.sqlite"), mcpEndpoint: "http://127.0.0.1:4174/mcp" });
	try {
		service.commandService.createCapture({ captureId: "mcp-navigation-capture", framing: [{ start: 0, framingMode: "length", frameSize: 2 }], inputFormat: "binary" });
		service.commandService.startSession({ captureId: "mcp-navigation-capture", sessionId: "mcp-navigation-session" });
		const append = service.commandService.appendChunk({ captureId: "mcp-navigation-capture", sessionId: "mcp-navigation-session", requestId: "mcp-navigation-request", sequence: 0, expectedStartOffset: 0, bytes: [1, 2] });
		const finalized = service.commandService.finalizeSession({ captureId: "mcp-navigation-capture", sessionId: "mcp-navigation-session", expectedDataRevision: append.dataRevision });
		service.commandService.createNote({ captureId: "mcp-navigation-capture", noteId: "mcp-navigation-note", text: "known state", target: { kind: "capture" }, createdAt: "2026-08-10T00:00:01.000Z" });
		await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
		const address = service.server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind to a port");
		const baseUrl = `http://127.0.0.1:${address.port}`;

		const toolsResponse = await modernCall(baseUrl, "list_framing_profiles", { captureId: "mcp-navigation-capture" });
		assert.equal(toolsResponse.status, 200);
		const profilesBody = await toolsResponse.json() as { result: { structuredContent: { data: { activeProfileId: string; selectionOptions: { current: { profileId: string } }; profiles: Array<{ version: number }> } } } };
		assert.equal(profilesBody.result.structuredContent.data.activeProfileId, finalized.profileId);
		assert.equal(profilesBody.result.structuredContent.data.selectionOptions.current.profileId, finalized.profileId);
		assert.equal(profilesBody.result.structuredContent.data.profiles[0]?.version, finalized.profileVersion);

		const notesResponse = await modernCall(baseUrl, "query_notes", { captureId: "mcp-navigation-capture", noteId: "mcp-navigation-note" });
		assert.equal(notesResponse.status, 200);
		const notesBody = await notesResponse.json() as { result: { structuredContent: { data: { notes: Array<{ id: string; text: string; anchors: { captureId: string } }> } } } };
		assert.deepEqual(notesBody.result.structuredContent.data.notes, [{
			id: "mcp-navigation-note",
			captureId: "mcp-navigation-capture",
			text: "known state",
			textTruncated: false,
			createdAt: "2026-08-10T00:00:01.000Z",
			updatedAt: null,
			authorType: "human",
			anchors: {
				targetKind: "capture",
				captureId: "mcp-navigation-capture",
				profileId: null,
				profileVersion: null,
				sourceDataRevision: null,
				frameId: null,
				messageId: null,
				bytePosition: null,
				rawOffset: null,
				rawOffsets: null,
				rawRange: null,
				frameRange: null,
				sequenceGroupId: null,
				sequenceKey: null
			}
		}]);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

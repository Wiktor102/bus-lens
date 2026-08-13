import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY
} from "@modelcontextprotocol/server";
import { ArchiveRepository } from "../server/archive-repository.ts";
import { CanonicalCaptureCommandService } from "../server/canonical-capture-command-service.ts";
import { createArchiveHttpService } from "../server/http-service.ts";
import { openDatabase } from "../server/database.ts";

function seed(database: ReturnType<typeof openDatabase>) {
	const commands = new CanonicalCaptureCommandService(database, { nowIso: () => "2026-08-10T00:00:00.000Z" });
	commands.createCapture({ captureId: "notes-capture", framing: [{ start: 0, framingMode: "length", frameSize: 2 }], inputFormat: "binary" });
	commands.startSession({ captureId: "notes-capture", sessionId: "notes-session" });
	const append = commands.appendChunk({ captureId: "notes-capture", sessionId: "notes-session", requestId: "notes-request", sequence: 0, expectedStartOffset: 0, bytes: [1, 2, 3, 4] });
	const finalized = commands.finalizeSession({ captureId: "notes-capture", sessionId: "notes-session", expectedDataRevision: append.dataRevision });
	const frame = database.prepare("SELECT id FROM materialized_frames WHERE capture_id = 'notes-capture' AND ordinal = 0").get() as { id: string };
	return { commands, frameId: frame.id, profileId: finalized.profileId, profileVersion: finalized.profileVersion, sourceDataRevision: finalized.dataRevision };
}

test("agent notes are disabled by default, append-only through the command, and attributed", () => {
	const database = openDatabase(":memory:");
	try {
		const { commands, frameId, profileId, profileVersion, sourceDataRevision } = seed(database);
		assert.equal(commands.isAgentNotesEnabled(), false);
		assert.throws(() => commands.createAgentNote({ captureId: "notes-capture", text: "disabled", target: { kind: "frame", frameId }, profileId, profileVersion, sourceDataRevision, attribution: { authorType: "agent", reportedClientName: "test-client", protocolVersion: "2026-07-28" } }), error => (error as { code?: string }).code === "ANNOTATION_DISABLED");
		new ArchiveRepository(database).setSetting("allow_agent_authored_notes", true);
		const created = commands.createAgentNote({ captureId: "notes-capture", noteId: "agent-note", text: "stable finding", target: { kind: "frame", frameId }, profileId, profileVersion, sourceDataRevision, attribution: { authorType: "agent", reportedClientName: "test-client", reportedClientVersion: "2.0", protocolVersion: "2026-07-28" } });
		assert.equal(created.note.authorType, "agent");
		assert.equal(created.note.reportedClientName, "test-client");
		assert.equal(created.note.protocolVersion, "2026-07-28");
		assert.equal((database.prepare("SELECT author_type, reported_client_name, reported_client_version, protocol_version FROM stable_notes WHERE id = 'agent-note'").get() as { author_type: string; reported_client_name: string; reported_client_version: string; protocol_version: string }).author_type, "agent");
		const raw = commands.createAgentNote({ captureId: "notes-capture", noteId: "agent-raw-range", text: "raw span", target: { kind: "raw-range", startRawOffset: 0, endRawOffset: 1 }, attribution: { authorType: "agent", reportedClientName: "test-client", protocolVersion: "2026-07-28" } });
		assert.equal(raw.note.target.kind, "raw-range");
		assert.equal(commands.getCaptureState("notes-capture").notes.find(note => note.id === "agent-note")?.authorType, "agent");
	} finally {
		database.close();
	}
});

test("frame-range notes reject requests that extend beyond resolved frames", () => {
	const database = openDatabase(":memory:");
	try {
		const { commands, profileId } = seed(database);
		assert.throws(
			() => commands.createNote({
				captureId: "notes-capture",
				noteId: "partial-frame-range",
				text: "partial frame range",
				target: { kind: "frame-range", profileId, startOrdinal: 0, endOrdinal: 999 }
			}),
			error => (error as { code?: string; message?: string }).code === "VALIDATION_ERROR"
				&& error instanceof Error
				&& error.message === "frame range does not cover all requested ordinals"
		);
		assert.equal((database.prepare("SELECT COUNT(*) AS count FROM stable_notes WHERE id = 'partial-frame-range'").get() as { count: number }).count, 0);

		const created = commands.createNote({
			captureId: "notes-capture",
			noteId: "complete-frame-range",
			text: "complete frame range",
			target: { kind: "frame-range", profileId, startOrdinal: 0, endOrdinal: 1 }
		});
		assert.deepEqual(created.note.target, { kind: "frame-range", profileId, startOrdinal: 0, endOrdinal: 1 });
	} finally {
		database.close();
	}
});

test("the MCP note tool keeps discovery stable while gating writes and deriving attribution from metadata", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-mcp-notes-test-"));
	const service = createArchiveHttpService({ databasePath: join(directory, "archive.sqlite"), mcpEndpoint: "http://127.0.0.1:4174/mcp" });
	const { frameId, profileId, profileVersion, sourceDataRevision } = seed(service.database);
	await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
	const address = service.server.address();
	if (!address || typeof address === "string") throw new Error("test server did not bind to a port");
	const meta = {
		[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
		[CLIENT_INFO_META_KEY]: { name: "metadata-client", version: "4.2" },
		[CLIENT_CAPABILITIES_META_KEY]: {}
	};
	const call = async (id: number, text: string) => fetch(`http://127.0.0.1:${address.port}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "add_agent_note" },
		body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "add_agent_note", arguments: { captureId: "notes-capture", text, target: { kind: "frame", frameId }, profileId, profileVersion, sourceDataRevision }, _meta: meta } })
	});
	try {
		const disabled = await call(1, "should be rejected");
		const disabledBody = await disabled.json() as { result: { isError: boolean; structuredContent: { data: { error: { code: string } } } } };
		assert.equal(disabledBody.result.isError, true);
		assert.equal(disabledBody.result.structuredContent.data.error.code, "annotation-disabled");
		service.repository.setSetting("allow_agent_authored_notes", true);
		const enabled = await call(2, "agent conclusion");
		const enabledBody = await enabled.json() as { result: { structuredContent: { data: { note: { authorType: string; reportedClientName: string } } } } };
		assert.equal(enabledBody.result.structuredContent.data.note.authorType, "agent");
		assert.equal(enabledBody.result.structuredContent.data.note.reportedClientName, "metadata-client");
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

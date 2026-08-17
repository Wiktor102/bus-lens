import assert from "node:assert/strict";
import test from "node:test";
import {
	ArchiveClient,
	type CaptureWriter,
	type CreateCaptureRequest
} from "../src/persistence/archive-client.ts";

type Call = {
	path: string;
	method: string;
	body?: unknown;
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function bodyOf(init: RequestInit | undefined): unknown {
	return init?.body ? JSON.parse(String(init.body)) : undefined;
}

test("new capture creation is POST /api/captures and the legacy document path is explicit", async () => {
	const originalFetch = globalThis.fetch;
	const calls: Call[] = [];
	globalThis.fetch = async (input, init) => {
		calls.push({ path: String(input), method: init?.method ?? "GET", body: bodyOf(init) });
		return jsonResponse({});
	};

	try {
		const client = new ArchiveClient();
		const writer: CaptureWriter = client;
		const create: CreateCaptureRequest = {
			captureId: "new-capture",
			name: "New capture",
			framing: [{ start: 0, framingMode: "length", frameSize: 3 }],
			inputFormat: "binary"
		};
		await writer.createCapture(create);
		await client.saveLegacyCaptureDocument({ id: "legacy-capture", name: "Legacy", messages: [], byteStream: [] });

		assert.deepEqual(calls.map(call => [call.path, call.method]), [
			["/api/captures", "POST"],
			["/api/captures/legacy-capture", "PUT"]
		]);
		assert.deepEqual(calls[0]?.body, create);
		assert.equal("saveCapture" in client, false);
		assert.equal(typeof client.saveLegacyCaptureDocument, "function");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("canonical CaptureWriter commands use dedicated HTTP endpoints", async () => {
	const originalFetch = globalThis.fetch;
	const calls: Call[] = [];
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		const method = init?.method ?? "GET";
		calls.push({ path, method, body: bodyOf(init) });
		if (path.endsWith("/notes/note") && method === "DELETE") return jsonResponse({ contentRevision: 3 });
		if (method === "DELETE") return new Response(null, { status: 204 });
		if (path.endsWith("/notes") && method === "GET") return jsonResponse([]);
		return jsonResponse({});
	};

	try {
		const client = new ArchiveClient();
		await client.patchMetadata({ captureId: "capture", patch: { name: "Renamed" } });
		await client.startSession({ captureId: "capture", sessionId: "session" });
		await client.appendChunk({
			captureId: "capture",
			sessionId: "session",
			requestId: "request",
			sequence: 0,
			expectedStartOffset: 0,
			segments: [{ bytes: [1, 2], timestamp: 10, direction: "rx" }]
		});
		await client.finalizeSession({ captureId: "capture", sessionId: "session" });
		await client.updateFramingDraft({ captureId: "capture", sections: [{ start: 0, framingMode: "length", frameSize: 2 }] });
		await client.reframe({
			captureId: "capture",
			sections: [{ start: 0, framingMode: "length", frameSize: 2 }],
			expectedActiveProfileId: "profile",
			expectedDataRevision: 1
		});
		await client.updateFramingSectionView({
			captureId: "capture",
			profileId: "profile",
			sectionId: "section",
			collapsed: true
		});
		await client.setByteVisibility({ captureId: "capture", rawOffset: 1, hidden: true });
		await client.deleteByteVisibility("capture", 1);
		await client.setFrameVisibility({ captureId: "capture", frameId: "frame", hidden: true });
		await client.deleteFrameVisibility({ captureId: "capture", frameId: "frame" });
		await client.listNotes("capture");
		await client.createNote({ captureId: "capture", text: "note", target: { kind: "capture" } });
		await client.updateNote({ captureId: "capture", noteId: "note", text: "updated" });
		assert.deepEqual(await client.deleteNote({ captureId: "capture", noteId: "note" }), { contentRevision: 3 });
		await client.clearData({ captureId: "capture" });
		await client.duplicate({ captureId: "capture", duplicateCaptureId: "copy" });
		await client.delete("capture");

		assert.deepEqual(calls.map(call => [call.path, call.method]), [
			["/api/captures/capture/metadata", "PATCH"],
			["/api/captures/capture/sessions", "POST"],
			["/api/captures/capture/raw-chunks", "POST"],
			["/api/captures/capture/sessions/session/finalize", "POST"],
			["/api/captures/capture/framing-draft", "PATCH"],
			["/api/captures/capture/framing-revisions", "POST"],
			["/api/captures/capture/framing-sections/section/view", "PATCH"],
			["/api/captures/capture/bytes/1/visibility", "PUT"],
			["/api/captures/capture/bytes/1/visibility", "DELETE"],
			["/api/captures/capture/frames/frame/visibility", "PUT"],
			["/api/captures/capture/frames/frame/visibility", "DELETE"],
			["/api/captures/capture/notes", "GET"],
			["/api/captures/capture/notes", "POST"],
			["/api/captures/capture/notes/note", "PATCH"],
			["/api/captures/capture/notes/note", "DELETE"],
			["/api/captures/capture/data", "DELETE"],
			["/api/captures/capture/duplicate", "POST"],
			["/api/captures/capture", "DELETE"]
		]);
		assert.deepEqual(calls[2]?.body, {
			sessionId: "session",
			requestId: "request",
			sequence: 0,
			expectedStartOffset: 0,
			segments: [{ bytes: [1, 2], timestamp: 10, direction: "rx" }]
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

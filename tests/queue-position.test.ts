import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArchiveHttpService, type ArchiveHttpService } from "../server/http-service.ts";

type QueueRecord = {
	id: string;
	document: Record<string, unknown>;
};

async function withHttpService(run: (baseUrl: string, service: ArchiveHttpService) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "bus-lens-queue-position-"));
	const service = createArchiveHttpService({ databasePath: join(directory, "archive.sqlite") });
	try {
		await new Promise<void>((resolve, reject) => {
			service.server.once("error", reject);
			service.server.listen(0, "127.0.0.1", () => {
				service.server.off("error", reject);
				resolve();
			});
		});
		const address = service.server.address() as AddressInfo | null;
		assert.ok(address && typeof address !== "string");
		await run(`http://127.0.0.1:${address.port}`, service);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
}

async function putQueueItem(baseUrl: string, id: string, position: unknown): Promise<Response> {
	return fetch(`${baseUrl}/api/queue/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "content-type": "application/json", connection: "close" },
		body: JSON.stringify({ id, bytes: [id === "first" ? 1 : 2], createdAt: 1, position })
	});
}

test("HTTP queue persistence uses the requested positions when listing items", async () => {
	await withHttpService(async (baseUrl, service) => {
		assert.equal((await putQueueItem(baseUrl, "first", 10)).status, 200);
		assert.equal((await putQueueItem(baseUrl, "second", 0)).status, 200);

		const response = await fetch(`${baseUrl}/api/queue`, { headers: { connection: "close" } });
		assert.equal(response.status, 200);
		const records = await response.json() as QueueRecord[];
		assert.deepEqual(records.map(record => record.id), ["second", "first"]);
		assert.deepEqual(
			service.database.prepare("SELECT id, position FROM send_queue ORDER BY position").all(),
			[
				{ id: "second", position: 0 },
				{ id: "first", position: 10 }
			]
		);
	});
});

test("HTTP queue persistence rejects invalid positions", async () => {
	await withHttpService(async baseUrl => {
		const response = await putQueueItem(baseUrl, "invalid", -1);
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: "Queue position must be a non-negative integer" });
	});
});

test("concurrent imported queue writes preserve the exported order", async () => {
	await withHttpService(async baseUrl => {
		const secondWrite = putQueueItem(baseUrl, "imported-second", 1);
		await new Promise(resolve => setTimeout(resolve, 20));
		const firstWrite = putQueueItem(baseUrl, "imported-first", 0);
		const responses = await Promise.all([secondWrite, firstWrite]);
		assert.deepEqual(responses.map(response => response.status), [200, 200]);

		const response = await fetch(`${baseUrl}/api/queue`, { headers: { connection: "close" } });
		assert.equal(response.status, 200);
		const records = await response.json() as QueueRecord[];
		assert.deepEqual(records.map(record => record.id), ["imported-first", "imported-second"]);
	});
});

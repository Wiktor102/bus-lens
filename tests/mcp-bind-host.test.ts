import assert from "node:assert/strict";
import test from "node:test";
import {
	hostHeaderValidationResponse,
	localhostAllowedHostnames,
	localhostAllowedOrigins,
	originValidationResponse
} from "@modelcontextprotocol/server";
import { assertLoopbackHost, isLoopbackHost } from "../server/config.ts";

function validationStatuses(host: string, origin: string): { host: number; origin: number } {
	const request = new Request("http://127.0.0.1:4174/mcp", { headers: { host, origin } });
	return {
		host: hostHeaderValidationResponse(request, localhostAllowedHostnames())?.status ?? 200,
		origin: originValidationResponse(request, localhostAllowedOrigins())?.status ?? 200
	};
}

test("MCP bind hosts are restricted to values covered by SDK Host and Origin validation", () => {
	for (const [bindHost, host, origin] of [
		["localhost", "localhost:4174", "http://localhost:4174"],
		["127.0.0.1", "127.0.0.1:4174", "http://127.0.0.1:4174"],
		["::1", "[::1]:4174", "http://[::1]:4174"]
	]) {
		assert.equal(isLoopbackHost(bindHost), true, `expected ${bindHost} to be accepted`);
		assert.doesNotThrow(() => assertLoopbackHost(bindHost));
		assert.deepEqual(validationStatuses(host, origin), { host: 200, origin: 200 });
	}

	for (const bindHost of ["ip6-localhost", "0:0:0:0:0:0:0:1", "0.0.0.0", "[::1]"]) {
		assert.equal(isLoopbackHost(bindHost), false, `expected ${bindHost} to be rejected`);
		assert.throws(() => assertLoopbackHost(bindHost), /loopback/);
	}

	assert.deepEqual(validationStatuses("ip6-localhost:4174", "http://ip6-localhost:4174"), { host: 403, origin: 403 });
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createPostgresPool, PostgresLogStore } from "../src/storage/postgres-log-store.js";
import { PostgresResourceIndex } from "../src/storage/resource-index.js";

const url = String(process.env.TEST_POSTGRES_URL || "");
if (!url) throw new Error("TEST_POSTGRES_URL is required");

const pool = createPostgresPool({ url, ssl: "disable", poolMax: 2 });
const logs = new PostgresLogStore(pool, 16 * 1024 * 1024);
const resources = new PostgresResourceIndex(pool);
const suffix = crypto.randomBytes(8).toString("hex");
const publicKey = `postgres-test-${suffix}`;
const sourceHash = crypto.createHash("sha256").update(`source-${suffix}`).digest("hex");
const resourceHash = crypto.createHash("sha256").update(`resource-${suffix}`).digest("hex");
const resourceId = `${resourceHash}.bin`;

try {
	await logs.initialize();
	await resources.initialize();
	const now = Date.now();
	await resources.remember({ resourceId, relativePath: `files/${resourceHash.slice(0, 2)}/${resourceId}`, category: "files", mime: "application/octet-stream", byteSize: 12, createdAtMs: now, lastAccessedAtMs: now }, sourceHash);
	assert.equal((await resources.findBySources([sourceHash])).get(sourceHash)?.resourceId, resourceId);
	await resources.rememberFailure(sourceHash, "test failure", Number.MAX_SAFE_INTEGER);
	assert((await resources.findDeferredSources([sourceHash], Date.now())).has(sourceHash));
	await resources.clearFailure(sourceHash);
	assert.equal((await resources.findDeferredSources([sourceHash], Date.now())).size, 0);

	const original = JSON.stringify({ data: "original" });
	const hydrated = JSON.stringify({ data: "hydrated" });
	await logs.addLogRecord({ publicKey, password: "secret", uniformId: `test:${suffix}`, storedText: original });
	assert.equal(await logs.replaceStoredLog(publicKey, original, hydrated), true);
	assert.equal(await logs.replaceStoredLog(publicKey, original, original), false);
	assert.equal(await logs.readPublicLog(publicKey, "secret"), hydrated);
	console.log("PostgreSQL resource index and background log CAS checks passed.");
} finally {
	await logs.deleteLogs([publicKey]).catch(() => undefined);
	await resources.deleteObject(resourceId).catch(() => undefined);
	await pool.end();
}

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CqResourceCache } from "../src/storage/cq-resource-cache.js";
import { SqliteResourceIndex } from "../src/storage/resource-index.js";
import { DEFAULT_RESOURCE_ALLOWED_HOSTS, resourceHostMatches } from "../src/storage/resource-host-policy.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lorana-resource-storage-"));
const legacy = path.join(root, "legacy");
const resources = path.join(root, "resources");
const indexPath = path.join(root, "indexes", "resources.sqlite");

try {
	assert.equal(resourceHostMatches("multimedia.nt.qq.com.cn", DEFAULT_RESOURCE_ALLOWED_HOSTS), true);
	assert.equal(resourceHostMatches("gchat.qpic.cn", DEFAULT_RESOURCE_ALLOWED_HOSTS), true);
	assert.equal(resourceHostMatches("qqbot.ugcimg.cn", DEFAULT_RESOURCE_ALLOWED_HOSTS), true);
	assert.equal(resourceHostMatches("mat1.gtimg.com", DEFAULT_RESOURCE_ALLOWED_HOSTS), true);
	assert.equal(resourceHostMatches("attacker-qq.com.cn", DEFAULT_RESOURCE_ALLOWED_HOSTS), false);
	assert.equal(resourceHostMatches("qq.com.cn.evil.example", DEFAULT_RESOURCE_ALLOWED_HOSTS), false);
	assert.equal(resourceHostMatches("multimedia.nt.qq.com.cn", ["*.qq.com"]), false);

	await fs.mkdir(legacy, { recursive: true });
	await fs.writeFile(path.join(legacy, "source-index.json"), "{}", "utf8");
	const legacyCache = new CqResourceCache(
		{ enabled: true, path: legacy },
		new SqliteResourceIndex(path.join(root, "legacy-index.sqlite")),
	);
	await assert.rejects(
		legacyCache.initialize(),
		/legacy or unmarked resource directory detected/,
		"an unmarked non-empty legacy directory must never be migrated implicitly",
	);

	const index = new SqliteResourceIndex(indexPath);
	const cache = new CqResourceCache(
		{ enabled: true, path: resources, max_file_mb: 1, max_total_mb: 8 },
		index,
	);
	await cache.initialize();
	assert.equal(await fs.readFile(path.join(resources, ".lorana-resource-layout-v2"), "utf8"), "lorana-resource-layout=2\n");
	if (process.platform !== "win32") {
		assert.equal((await fs.stat(resources)).mode & 0o777, 0o700, "resource root must be private");
		assert.equal((await fs.stat(indexPath)).mode & 0o777, 0o600, "SQLite resource index must be private");
	}

	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=", "base64");
	const saved = await cache.cacheUploadedResource(png, "image", "image/png");
	assert.match(saved.resourceId, /^[a-f0-9]{64}\.webp$/);
	const record = await index.findObject(saved.resourceId);
	assert(record, "resource index row must exist");
	assert.equal(record.category, "uploads");
	assert.match(record.relativePath, /^uploads\/[a-f0-9]{2}\/[a-f0-9]{64}\.webp(?:\.br)?$/);
	if (process.platform !== "win32") assert.equal((await fs.stat(path.join(resources, record.relativePath))).mode & 0o777, 0o600, "stored resource must be private");
	await assert.rejects(index.remember({ ...record, relativePath: "../escape.bin" }), /invalid resource index path/);
	assert.equal(path.dirname(indexPath) === resources, false, "the SQLite index must support a path outside the resource directory");
	assert((await cache.readResource(saved.resourceId, false))?.body.byteLength, "stored resource must be readable");
	await cache.close();

	const digest = crypto.createHash("sha256").update(png).digest("hex");
	assert.notEqual(saved.resourceId.split(".", 1)[0], digest, "image normalization should hash the stored logical resource");
	console.log("Resource layout guard, categorized storage and independent SQLite index checks passed.");
} finally {
	const resolved = path.resolve(root);
	if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith("lorana-resource-storage-")) {
		await fs.rm(resolved, { recursive: true, force: true });
	}
}

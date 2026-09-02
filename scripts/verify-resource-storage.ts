import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
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

		const tinyGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
		const resourceBytes = (index: number) => Buffer.concat([tinyGif, Buffer.from(`resource-${index}`)]);
		const messages = Array.from({ length: 10_000 }, (_, index) => ({
			message: `[CQ:image,file=base64://${resourceBytes(index).toString("base64")}]`,
		}));
		const hugeStoredLog = JSON.stringify({
			client: "Scardice",
			data: deflateSync(Buffer.from(JSON.stringify({ items: messages }))).toString("base64"),
		});
		const boundedCache = new CqResourceCache(
			{ enabled: true, path: resources, max_file_mb: 1, max_total_mb: 8, max_resources_per_log: 5, max_concurrent_jobs: 2 },
			index,
		);
		const archived = await boundedCache.archiveStoredLog(hugeStoredLog, "https://example.test");
		assert.equal(archived.cachedCount, 5, "huge logs must archive only the bounded newest candidate set");
		const archivedPayload = JSON.parse(inflateSync(Buffer.from(JSON.parse(archived.storedText).data, "base64")).toString("utf8"));
		assert.match(archivedPayload.items.at(-1).message, /\/cq-resources\/[a-f0-9]{64}\.gif/);
		assert.match(archivedPayload.items[0].message, /base64:\/\//, "old candidates outside the configured batch must remain available for a later pass");
		const newestSource = `base64://${resourceBytes(9999).toString("base64")}`;
		const indexedNewest = await index.findBySource(crypto.createHash("sha256").update(newestSource).digest("hex"));
		assert(indexedNewest, "source URL/fingerprint to content hash mapping must be persisted");
		assert.equal(indexedNewest.resourceId.split(".", 1)[0], crypto.createHash("sha256").update(resourceBytes(9999)).digest("hex"));
		const repeated = await boundedCache.archiveStoredLog(hugeStoredLog, "https://example.test");
		assert.equal(repeated.cachedCount, 10, "already indexed sources must be skipped so the next uncached batch can make progress");
		assert.equal((await index.findBySource(crypto.createHash("sha256").update(newestSource).digest("hex")))?.resourceId, indexedNewest.resourceId, "the existing source-to-content hash mapping must remain stable");

		const expiredSource = "https://expired.invalid.example/resource.png";
		const mixedLog = JSON.stringify({ client: "Scardice", data: deflateSync(Buffer.from(JSON.stringify({ items: [
			{ message: `[CQ:image,file=base64://${resourceBytes(20_000).toString("base64")}]` },
			{ message: `[CQ:image,url=${expiredSource}]` },
		] }))).toString("base64") });
		const oneAttemptCache = new CqResourceCache({ enabled: true, path: resources, max_file_mb: 1, max_total_mb: 8, max_resources_per_log: 1 }, index);
		assert.equal((await oneAttemptCache.archiveStoredLog(mixedLog)).cachedCount, 0, "the newest failed source consumes only its first attempt");
		const expiredHash = crypto.createHash("sha256").update(expiredSource).digest("hex");
		assert((await index.findDeferredSources([expiredHash], Date.now())).has(expiredHash), "a failed complete source URL must be persisted as permanently skipped");
		assert.equal((await oneAttemptCache.archiveStoredLog(mixedLog)).cachedCount, 1, "a permanently skipped expired URL must let another uncached source progress on the next pass");
		await cache.close();

	const digest = crypto.createHash("sha256").update(png).digest("hex");
	assert.notEqual(saved.resourceId.split(".", 1)[0], digest, "image normalization should hash the stored logical resource");
	console.log("Resource layout guard, categorized storage and independent SQLite index checks passed.");
} finally {
	const resolved = path.resolve(root);
	if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith("lorana-resource-storage-")) {
		await fs.rm(resolved, { recursive: true, force: true }).catch((error) => console.warn(`Temporary resource test cleanup skipped: ${error instanceof Error ? error.message : String(error)}`));
	}
}

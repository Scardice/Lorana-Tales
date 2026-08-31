import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import Database from "better-sqlite3";
import { AccountStore } from "../src/accounts/account-store.js";
import { publicProjectPayload } from "../src/accounts/router.js";
import { getClientIp } from "../src/server/client-ip.js";
import { isPublicIp, qqAvatarIds } from "../src/storage/cq-resource-cache.js";
import { inflateTextBounded, InflateLimitError } from "../src/security/bounded-inflate.js";
import { decodeBase64UploadLimited, handleDiceApiRequest } from "../src/api/dice.js";
import { SqliteLogStore } from "../src/storage/sqlite-log-store.js";
import { createPostgresPool } from "../src/storage/postgres-log-store.js";

const verifiedPool = createPostgresPool({ url: "postgresql://user:pass@db.example.test/app?sslmode=disable", ssl: "verify-full" });
assert.deepEqual(verifiedPool.options.ssl, { rejectUnauthorized: true }, "URL parameters must not weaken the configured PostgreSQL TLS policy");
assert.doesNotMatch(String(verifiedPool.options.connectionString), /sslmode=/, "conflicting PostgreSQL URL TLS parameters must be removed");
await verifiedPool.end();
const localPool = createPostgresPool({ url: "postgresql://user:pass@127.0.0.1/app", ssl: "disable" });
assert.equal(localPool.options.ssl, false);
await localPool.end();

const compressed = deflateSync(Buffer.alloc(8 * 1024, 65));
assert.throws(
	() => inflateTextBounded(compressed, 4 * 1024),
	(error) => error instanceof InflateLimitError,
	"compressed uploads must stop at the configured decoded-size boundary",
);
assert.equal(inflateTextBounded(compressed, 16 * 1024).bytes.byteLength, 8 * 1024);
assert.equal(decodeBase64UploadLimited(Buffer.alloc(2048).toString("base64"), 1024), null);
assert.equal(decodeBase64UploadLimited(Buffer.alloc(512).toString("base64"), 1024)?.byteLength, 512);
assert.equal(decodeBase64UploadLimited("not base64!", 1024), null);
assert.equal(decodeBase64UploadLimited("=", 1024), null);
assert.equal(decodeBase64UploadLimited("YQ=", 1024), null);
assert.equal(Buffer.from(decodeBase64UploadLimited("YQ==", 1024) || []).toString(), "a");
assert.deepEqual(qqAvatarIds({ items: [{ IMUserId: "732899935" }, { imUserId: 3482215720 }, { message: "不要把正文 123456789 当作 QQ" }], nested: { qq: "10001", userId: "999999999" } }), ["732899935", "3482215720", "10001"]);
assert.deepEqual(qqAvatarIds({ IMUserId: "1234", qq: "1234567890123", uin: "not-a-number" }), []);

const oldStoredLog = JSON.stringify({ data: "old-log" });
const hydratedStoredLog = JSON.stringify({ data: "hydrated-old-log" });
let oldLogHydrated = 0;
const oldLogResponse = await handleDiceApiRequest({
	request: new Request("http://localhost/api/dice/load_data?key=old-link&password=secret"),
	env: {
		LOG_STORE: { readPublicLog: async () => oldStoredLog },
		CQ_RESOURCE_CACHE: { enabled: true, archiveStoredLog: async (text: string) => { oldLogHydrated += 1; assert.equal(text, oldStoredLog); return { storedText: hydratedStoredLog, cachedCount: 1, avatarCount: 1 }; } },
	},
});
assert.equal(oldLogResponse.status, 200);
assert.equal(await oldLogResponse.text(), hydratedStoredLog);
assert.equal(oldLogHydrated, 1, "opening an old API link must retry CQ and QQ avatar hydration");

const uploadOrder: string[] = [];
const uploadBody = new FormData();
uploadBody.set("name", "resource hydration upload");
uploadBody.set("uniform_id", "security:resource-hydration");
uploadBody.set("client", "Scardice");
uploadBody.set("file", new Blob([deflateSync(Buffer.from(JSON.stringify({ version: 105, items: [{ IMUserId: "732899935", message: "hello" }] })))], { type: "application/octet-stream" }), "log.dat");
const uploadResponse = await handleDiceApiRequest({
	request: new Request("http://localhost/api/dice/log", { method: "PUT", body: uploadBody }),
	env: {
		CLEANUP_AFTER_UPLOAD: "false",
		INJECTION_GUARD_ENABLED: "false",
		LOG_STORE: { addLogRecord: async () => { uploadOrder.push("store"); } },
		CQ_RESOURCE_CACHE: { enabled: true, archiveStoredLog: async (text: string) => { uploadOrder.push("resources"); return { storedText: text, cachedCount: 1, avatarCount: 1 }; } },
	},
});
assert.equal(uploadResponse.status, 200);
assert.deepEqual(uploadOrder, ["resources", "store"], "API upload must prepare CQ resources and QQ avatars before persisting the link");

const quotaStore = new SqliteLogStore(":memory:", { maxTotalBytes: 32 });
await assert.rejects(
	quotaStore.addLogRecord({ publicKey: "quota", password: "secret", uniformId: "test:quota", storedText: JSON.stringify({ data: "payload larger than quota" }) }),
	/log_storage_quota_exceeded/,
);
quotaStore.close();

const writableQuotaStore = new SqliteLogStore(":memory:", { maxTotalBytes: 2 * 1024 * 1024 });
const withinQuotaPayload = JSON.stringify({ data: "ok" });
await writableQuotaStore.addLogRecord({ publicKey: "within-quota", password: "secret", uniformId: "test:within", storedText: withinQuotaPayload });
assert.equal(await writableQuotaStore.readPublicLog("within-quota", "secret"), withinQuotaPayload);
writableQuotaStore.close();

for (const address of [
	"127.0.0.1",
	"169.254.169.254",
	"192.168.1.1",
	"::1",
	"::ffff:127.0.0.1",
	"64:ff9b::7f00:1",
	"2001:0:4136:e378:8000:63bf:3fff:fdd2",
	"2002:7f00:1::",
	"fe80::1",
	"febf::1",
	"fec0::1",
	"ff02::1",
]) {
	assert.equal(isPublicIp(address), false, `${address} must not pass remote-resource SSRF checks`);
}

for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) {
	assert.equal(isPublicIp(address), true, `${address} should remain a valid public address`);
}

const shared = publicProjectPayload({
	id: "project-1",
	title: "public story",
	document: { story: true },
	owner: { email: "private@example.test", status: "active" },
	shareExpiryMode: "fixed",
	shareExpiresAt: "2030-01-01T00:00:00.000Z",
	lastActivityAt: "2029-01-01T00:00:00.000Z",
});
assert.deepEqual(shared.document, { story: true });
assert.equal("owner" in shared, false, "shared legacy projects must not expose account metadata");
assert.equal("shareExpiryMode" in shared, false, "share policy internals must not leak in project payloads");

const forwardedRequest = (forwardedFor: string) => ({
	headers: { "x-forwarded-for": forwardedFor },
	socket: { remoteAddress: "127.0.0.1" },
});
assert.equal(
	getClientIp(forwardedRequest("198.51.100.50, 203.0.113.25") as never, ["127.0.0.1/32"]),
	"203.0.113.25",
	"a prepended X-Forwarded-For value must not override the nearest untrusted client hop",
);
assert.equal(
	getClientIp(forwardedRequest("198.51.100.50, 10.0.0.5") as never, ["127.0.0.1/32", "10.0.0.0/8"]),
	"198.51.100.50",
	"trusted proxy hops should be skipped from right to left",
);
assert.equal(
	getClientIp({ headers: { forwarded: "for=198.51.100.50, for=203.0.113.25" }, socket: { remoteAddress: "127.0.0.1" } } as never, ["127.0.0.1/32"]),
	"203.0.113.25",
	"a prepended RFC 7239 Forwarded value must not override the nearest untrusted client hop",
);

const database = new Database(":memory:");
database.pragma("foreign_keys = ON");
const accountStore = new AccountStore(database);
const verificationId = accountStore.createVerificationCode("code@example.test", "login", "123456", "203.0.113.0/24", 10);
assert.equal(accountStore.verifyCode(verificationId, "code@example.test", "login", "123456", false), true);
assert.equal(accountStore.verifyCode(verificationId, "code@example.test", "login", "123456"), true, "risk checks must not consume the email code before CAPTCHA succeeds");
const failedDeliveryId = accountStore.createVerificationCode("retry@example.test", "login", "654321", "203.0.113.0/24", 10);
accountStore.deleteVerificationCode(failedDeliveryId);
assert.equal(accountStore.verifyCode(failedDeliveryId, "retry@example.test", "login", "654321"), false, "failed SMTP delivery must not leave an unusable verification code behind");
assert.equal(accountStore.lastVerificationAt("retry@example.test", "login"), 0, "failed SMTP delivery must not trigger the resend cooldown");
const account = await accountStore.createUser({
	email: "owner@example.test",
	password: "test-password-not-for-production",
	username: "security_owner",
	nickname: "Security Owner",
	group: "default",
});
assert.equal(accountStore.getUserByEmail("  OWNER@EXAMPLE.TEST ")?.id, account.id, "email lookup must be case-insensitive and trim surrounding whitespace");
assert.equal(accountStore.getUserByIdentity("OWNER@EXAMPLE.TEST")?.id, account.id, "email login identity must be case-insensitive");
assert.equal((await accountStore.verifyPasswordIdentity("OWNER@EXAMPLE.TEST", "test-password-not-for-production"))?.id, account.id, "password login by email must be case-insensitive");
const project = accountStore.createProject(account.id, "shared", { story: true });
const share = accountStore.shareProject(account.id, project.id);
assert.ok(share);
const storedShare = accountStore.getSharedProject(share.token);
assert.ok(storedShare);
assert.deepEqual(storedShare.owner, {
	id: account.id,
	group: "default",
	quotaMbOverride: null,
	retentionDaysOverride: null,
});
assert.equal("email" in storedShare.owner, false, "shared-project lookup must not read private owner fields");
database.close();

console.log("Security boundary checks passed");

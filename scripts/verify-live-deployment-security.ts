import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { loadConfig } from "../src/config/load-config.js";
import { startServer } from "../src/server/main.js";

type CookieJar = Map<string, string>;

function captureCookies(jar: CookieJar, response: Response) {
	const headers = response.headers as Headers & { getSetCookie?: () => string[] };
	const values = headers.getSetCookie?.() || String(response.headers.get("set-cookie") || "").split(/,\s*(?=scardice_[^=]+=)/).filter(Boolean);
	for (const value of values) {
		const pair = value.split(";", 1)[0];
		const index = pair.indexOf("=");
		if (index < 1) continue;
		const name = pair.slice(0, index), cookieValue = pair.slice(index + 1);
		if (cookieValue) jar.set(name, cookieValue); else jar.delete(name);
	}
}

function cookieHeader(jar: CookieJar) {
	return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function requestWithHost(port: number, host: string) {
	return new Promise<number>((resolve, reject) => {
		const request = http.request({ hostname: "127.0.0.1", port, path: "/healthz", headers: { Host: host } }, (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode || 0));
		});
		request.on("error", reject);
		request.end();
	});
}

async function jsonRequest(base: string, route: string, init: RequestInit = {}, jar?: CookieJar) {
	const headers = new Headers(init.headers);
	if (!headers.has("user-agent")) headers.set("user-agent", "lorana-security-audit");
	if (!headers.has("content-type") && init.body !== undefined) headers.set("content-type", "application/json");
	if (jar?.size) headers.set("cookie", cookieHeader(jar));
	const response = await fetch(`${base}${route}`, { ...init, headers, redirect: "manual" });
	if (jar) captureCookies(jar, response);
	const text = await response.text();
	let body: unknown = text;
	try { body = text ? JSON.parse(text) : null; } catch { /* assertion sites inspect text */ }
	return { response, body, text };
}

async function main() {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lorana-live-security-"));
	const config = loadConfig();
	config.server.host = "127.0.0.1";
	config.server.port = 0;
	config.server.trust_proxy = false;
	config.server.allowed_hosts = ["127.0.0.1", "localhost"];
	config.server.hsts_max_age_seconds = 0;
	config.database.driver = "sqlite";
	config.database.sqlite_path = path.join(tempRoot, "audit.sqlite");
	config.storage.max_total_mb = 128;
	config.app.cleanup_on_start = false;
	config.resource_cache.enabled = false;
	config.accounts.enabled = true;
	config.accounts.registration_enabled = false;
	config.accounts.initial_admin_username = "audit_admin";
	config.accounts.initial_admin_password = "Audit-admin-password-2026";
	config.accounts.initial_admin_email = "admin@example.test";
	config.accounts.encryption_key = "audit-only-encryption-key-that-is-longer-than-thirty-two-bytes";
	config.accounts.smtp.host = "";
	config.accounts.smtp.from = "";
	config.metrics.enabled = true;
	config.metrics.token = "audit-metrics-token";

	const result = await startServer(config);
	try {
		if (!result.server.listening) await once(result.server, "listening");
		const address = result.server.address();
		assert(address && typeof address === "object");
		const base = `http://127.0.0.1:${address.port}`;
		const service = result.accountService;
		assert(service, "account service must be enabled");

		const userA = await service.store.createUser({ email: "a@example.test", password: "Audit-user-password-A", username: "audit_user_a", nickname: "A" });
		const userB = await service.store.createUser({ email: "b@example.test", password: "Audit-user-password-B", username: "audit_user_b", nickname: "B" });
		const admin = await service.store.createUser({ email: "second-admin@example.test", password: "Audit-admin-password-B", username: "audit_admin_b", nickname: "Admin", role: "admin", group: "admin" });

		// The security job runs before the frontend build, so assert global response
		// headers on the always-present health endpoint instead of static output.
		const health = await fetch(`${base}/healthz`, { headers: { host: "127.0.0.1" } });
		assert.equal(health.status, 200);
		assert.equal(health.headers.get("x-content-type-options"), "nosniff");
		assert.equal(health.headers.get("x-frame-options"), "DENY");
		assert.match(health.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);

		assert.equal(await requestWithHost(address.port, "evil.example"), 400);
		assert.equal(await requestWithHost(address.port, "127.0.0.1@evil.example"), 400);
		assert.equal(await requestWithHost(address.port, "127.0.0.1:65536"), 400);
		assert.equal((await fetch(`${base}/metrics`)).status, 401);
		assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: "Bearer audit-metrics-token" } })).status, 200);
		assert.equal((await jsonRequest(base, "/api/account/projects")).response.status, 401);

		const firstLogin = await jsonRequest(base, "/api/account/login", { method: "POST", body: JSON.stringify({ username: userA.username, password: "Audit-user-password-A" }) });
		assert.equal(firstLogin.response.status, 428, "new devices require email verification");
		const codeId = service.store.createVerificationCode(userA.email, "login", "123456", "127.0.0.0/24", 10);
		const invalidCode = await jsonRequest(base, "/api/account/login", { method: "POST", body: JSON.stringify({ username: userA.username, password: "Audit-user-password-A", codeId, code: "000000" }) });
		assert.equal(invalidCode.response.status, 401);
		assert.equal((invalidCode.body as { error?: string }).error, "verification_invalid", "an entered but invalid device code must not be reported as a missing verification step");
		const jarA: CookieJar = new Map();
		const loginA = await jsonRequest(base, "/api/account/login", { method: "POST", body: JSON.stringify({ username: userA.username, password: "Audit-user-password-A", codeId, code: "123456" }) }, jarA);
		assert.equal(loginA.response.status, 200);
		const loginBody = loginA.body as { csrfToken: string };
		assert(loginBody.csrfToken && jarA.has("scardice_account_session") && jarA.has("scardice_account_device"));
		assert.match(loginA.response.headers.get("set-cookie") || "", /HttpOnly/i);
		assert.match(loginA.response.headers.get("set-cookie") || "", /SameSite=/i);

		const noCsrf = await jsonRequest(base, "/api/account/projects", { method: "POST", body: JSON.stringify({ title: "blocked", document: { messages: [] } }) }, jarA);
		assert.equal(noCsrf.response.status, 403);
		const createA = await jsonRequest(base, "/api/account/projects", { method: "POST", headers: { "x-csrf-token": loginBody.csrfToken }, body: JSON.stringify({ title: "A story", document: { messages: [{ text: "hello" }] } }) }, jarA);
		assert.equal(createA.response.status, 201);
		const projectId = String((createA.body as { id: string }).id || "");
		assert(projectId);

		const sessionB = service.store.createSession(userB, { sessionDays: 1, ipPrefix: "127.0.0.0/24", userAgent: "lorana-security-audit" });
		const jarB: CookieJar = new Map([["scardice_account_session", sessionB.token], ["scardice_account_csrf", sessionB.csrfToken]]);
		assert.equal((await jsonRequest(base, `/api/account/projects/${projectId}`, {}, jarB)).response.status, 404, "projects are owner-isolated");
		assert.equal((await jsonRequest(base, `/api/account/projects/${projectId}`, { method: "DELETE", headers: { "x-csrf-token": sessionB.csrfToken } }, jarB)).response.status, 404);
		assert.equal((await jsonRequest(base, "/admin/api/users", {}, jarB)).response.status, 401, "ordinary users cannot access admin APIs");
		const adminSession = service.store.createSession(admin, { sessionDays: 1, ipPrefix: "127.0.0.0/24", userAgent: "lorana-security-audit" });
		const adminJar: CookieJar = new Map([["scardice_account_session", adminSession.token], ["scardice_account_csrf", adminSession.csrfToken]]);
		assert.equal((await jsonRequest(base, "/admin/api/users", {}, adminJar)).response.status, 200, "configured admin group can access admin APIs");
		assert.equal((await jsonRequest(base, "/admin/api/users", { method: "POST", body: JSON.stringify({}) }, adminJar)).response.status, 403, "admin mutations require CSRF");
		const malformedAdmin = await jsonRequest(base, `/admin/api/users/${userB.id}/status`, { method: "POST", headers: { "x-csrf-token": adminSession.csrfToken }, body: "{broken" }, adminJar);
		assert.equal(malformedAdmin.response.status, 400);
		assert.equal((malformedAdmin.body as { error: string }).error, "invalid_request");

		const invalidShare = await jsonRequest(base, `/api/account/projects/${projectId}/share`, { method: "POST", headers: { "x-csrf-token": loginBody.csrfToken }, body: JSON.stringify({ expiryMode: "fixed", durationDays: 999 }) }, jarA);
		assert.equal(invalidShare.response.status, 400);
		const share = await jsonRequest(base, `/api/account/projects/${projectId}/share`, { method: "POST", headers: { "x-csrf-token": loginBody.csrfToken }, body: JSON.stringify({ expiryMode: "fixed", durationDays: 1 }) }, jarA);
		assert.equal(share.response.status, 200);
		const shareToken = String((share.body as { token: string }).token || "");
		assert.match(shareToken, /^[A-Za-z0-9_-]{20,40}$/);
		const publicProject = await jsonRequest(base, `/api/shared-projects/${shareToken}`);
		assert.equal(publicProject.response.status, 200);
		assert(!JSON.stringify(publicProject.body).includes(userA.email), "public shares must not expose owner account data");

		const malformed = await jsonRequest(base, "/api/account/login", { method: "POST", body: "{broken" });
		assert.equal(malformed.response.status, 400);
		assert.equal(malformed.response.headers.get("content-type")?.startsWith("application/json"), true);
		assert.equal((malformed.body as { error: string }).error, "invalid_request");
		const oversized = await fetch(`${base}/api/account/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(28 * 1024 * 1024) });
		assert.equal(oversized.status, 413);
		assert.equal((await oversized.json() as { error: string }).error, "payload_too_large");
		assert.equal((await fetch(`${base}/healthz`)).status, 200, "server remains healthy after rejected requests");

		const logout = await jsonRequest(base, "/api/account/logout", { method: "POST", headers: { "x-csrf-token": loginBody.csrfToken } }, jarA);
		assert.equal(logout.response.status, 200);
		assert(jarA.has("scardice_account_device"), "logout preserves the trusted-device cookie");
		const relogin = await jsonRequest(base, "/api/account/login", { method: "POST", body: JSON.stringify({ username: userA.username, password: "Audit-user-password-A" }) }, jarA);
		assert.equal(relogin.response.status, 200, "trusted browser and network can log in without another email code");

		console.log("Live deployment security checks passed.");
	} finally {
		await new Promise<void>((resolve, reject) => result.server.close((error) => error ? reject(error) : resolve()));
		result.store.db.close();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

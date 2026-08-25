import crypto from "node:crypto";
import fs from "node:fs";
import type { LogStore } from "../storage/log-store.js";
import { getClientIp } from "../server/client-ip.js";
import type { AccountService } from "../accounts/router.js";

const SESSION_COOKIE = "scardice_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashText(value) {
	return crypto.createHash("sha256").update(String(value)).digest();
}

function timingSafeTextEqual(left, right) {
	return crypto.timingSafeEqual(hashText(left), hashText(right));
}

function parseCookies(header) {
	const cookies = new Map();
	if (!header) return cookies;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index === -1) continue;
		const key = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (!key) continue;
		try {
			cookies.set(key, decodeURIComponent(value));
		} catch {
			cookies.set(key, value);
		}
	}
	return cookies;
}

function readJsonBody(req): JsonObject {
	if (!req.body) return {};
	const raw = Buffer.isBuffer(req.body)
		? req.body.toString("utf-8")
		: String(req.body);
	if (!raw.trim()) return {};
	const parsed: unknown = JSON.parse(raw);
	return isJsonObject(parsed) ? parsed : {};
}

function sendJson(res, status, body) {
	res.status(status);
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Pragma", "no-cache");
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.send(JSON.stringify(body));
}

function clampInt(value, fallback, min, max) {
	const parsed = parseInt(String(value || ""), 10);
	if (Number.isNaN(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

function safeDownloadName(key) {
	return `${String(key || "log").replace(/[^A-Za-z0-9_.-]+/g, "_")}.json`;
}

function keysFromRequest(req) {
	const body = readJsonBody(req);
	const keys = Array.isArray(body.keys)
		? body.keys
		: body.key
			? [body.key]
			: [];
	return keys.map((key) => String(key || "").trim()).filter(Boolean);
}

function sanitizeCredential(value: unknown): string {
	const text = String(value ?? "")
		.replaceAll(/[\r\n\t]+/g, " ")
		.trim();
	return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

export function createAdminRouter({
	app,
	store,
	password,
	adminFilePath,
	trustProxy = false,
	retentionDays = 60,
	accountService = null,
	security = {},
}: {
	app;
	store: LogStore;
	password: string;
	adminFilePath: string;
	trustProxy?: boolean;
	retentionDays?: number;
	accountService?: AccountService | null;
	security?: {
		bruteforceBlockEnabled?: boolean;
		maxAttempts?: number;
		windowMs?: number;
		onBlock?: (clientIp: string, credentials: string[]) => Promise<unknown>;
	};
}) {
	const sessions = new Map();
	const failedLogins = new Map();
	const bruteForceMaxAttempts = Math.max(1, Number(security.maxAttempts || 8));
	const bruteForceWindowMs = Math.max(1000, Number(security.windowMs || 60_000));

	app.use("/admin", (_req, res, next) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Pragma", "no-cache");
		next();
	});

	function cleanupSessions() {
		const now = Date.now();
		for (const [token, session] of sessions) {
			if (session.expiresAt <= now) sessions.delete(token);
		}
	}

	function getSession(req) {
		cleanupSessions();
		const token = parseCookies(req.headers.cookie || "").get(SESSION_COOKIE);
		if (!token) return null;
		const session = sessions.get(token);
		if (!session || session.expiresAt <= Date.now()) {
			sessions.delete(token);
			return null;
		}
		return { token, session };
	}

	function isAuthenticated(req) {
		return !!getSession(req) || !!accountService?.isAdmin(req);
	}

	function requireAuth(req, res) {
		if (isAuthenticated(req)) return true;
		sendJson(res, 401, { error: "admin authentication required" });
		return false;
	}

	function requireMutationAuth(req, res) {
		if (getSession(req)) return true;
		const session = accountService?.getSession(req);
		if (session?.user.role === "admin" && !session.user.mustChangePassword && accountService?.store.verifyCsrf(session, String(req.headers["x-csrf-token"] || ""))) return true;
		sendJson(res, session ? 403 : 401, { error: session ? "csrf_failed" : "admin authentication required" });
		return false;
	}

	function actor(req) {
		return getSession(req) ? "root" : accountService?.getSession(req)?.user.id || "unknown";
	}

	function setSessionCookie(req, res, token) {
		const forwardedProto = Array.isArray(req.headers["x-forwarded-proto"])
			? req.headers["x-forwarded-proto"][0] || ""
			: String(req.headers["x-forwarded-proto"] || "");
		const secure =
			req.secure ||
			(trustProxy && forwardedProto.split(",")[0].trim() === "https");
		const parts = [
			`${SESSION_COOKIE}=${encodeURIComponent(token)}`,
			"Path=/",
			"HttpOnly",
			"SameSite=Strict",
			`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
		];
		if (secure) parts.push("Secure");
		res.setHeader("Set-Cookie", parts.join("; "));
	}

	function clearSessionCookie(res) {
		res.setHeader(
			"Set-Cookie",
			`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
		);
	}

	function loginAllowed(req) {
		const ip = getClientIp(req, trustProxy);
		const record = failedLogins.get(ip);
		if (!record) return true;
		if (record.firstFailedAt + bruteForceWindowMs <= Date.now()) {
			failedLogins.delete(ip);
			return true;
		}
		return true;
	}

	async function recordFailedLogin(req, credential: unknown) {
		const ip = getClientIp(req, trustProxy);
		const now = Date.now();
		const current =
			failedLogins.get(ip)?.firstFailedAt + bruteForceWindowMs > now
				? failedLogins.get(ip)
				: { count: 0, firstFailedAt: now, credentials: [] };
		const nextCount = current.count + 1;
		const credentials = [
			...current.credentials,
			sanitizeCredential(credential),
		].slice(-bruteForceMaxAttempts);
		const next = {
			count: nextCount,
			firstFailedAt: current.firstFailedAt,
			credentials,
		};
		failedLogins.set(ip, next);
		if (
			security.bruteforceBlockEnabled !== false &&
			nextCount >= bruteForceMaxAttempts
		) {
			failedLogins.delete(ip);
			await security.onBlock?.(ip, credentials);
			return true;
		}
		return false;
	}

	function clearFailedLogin(req) {
		failedLogins.delete(getClientIp(req, trustProxy));
	}

	app.get(["/admin", "/admin/"], (_req, res) => {
		if (adminFilePath && fs.existsSync(adminFilePath)) {
			return res.sendFile(adminFilePath);
		}
		res
			.status(404)
			.type("text/plain")
			.send("Admin console has not been built yet");
	});

	app.get("/admin/api/session", (req, res) => {
		const account = accountService?.getSession(req);
		sendJson(res, 200, { authenticated: isAuthenticated(req), accountMode: !!accountService, mode: getSession(req) ? "root" : account?.user.role === "admin" && !account.user.mustChangePassword ? "account" : "none", user: account?.user.role === "admin" && !account.user.mustChangePassword ? account.user : null });
	});

	app.post("/admin/api/login", async (req, res) => {
		if (accountService) { sendJson(res, 410, { error: "root_login_disabled", message: "请从编辑器顶栏登录管理员账号。" }); return; }
		if (!loginAllowed(req)) {
			sendJson(res, 429, { error: "too many failed login attempts" });
			return;
		}

		let body: JsonObject;
		try {
			body = readJsonBody(req);
		} catch {
			sendJson(res, 400, { error: "invalid JSON body" });
			return;
		}

		if (
			typeof body.password !== "string" ||
			!timingSafeTextEqual(body.password, password)
		) {
			const blocked = await recordFailedLogin(req, body.password);
			if (blocked) {
				sendJson(res, 429, { error: "security intercept active" });
				return;
			}
			sendJson(res, 401, { error: "invalid password" });
			return;
		}

		clearFailedLogin(req);
		const token = crypto.randomUUID();
		sessions.set(token, {
			createdAt: Date.now(),
			expiresAt: Date.now() + SESSION_TTL_MS,
			ip: getClientIp(req, trustProxy),
		});
		setSessionCookie(req, res, token);
		sendJson(res, 200, { authenticated: true });
	});

	app.post("/admin/api/logout", (req, res) => {
		const active = getSession(req);
		if (active) sessions.delete(active.token);
		clearSessionCookie(res);
		sendJson(res, 200, { authenticated: false });
	});

	app.get("/admin/api/users", (req, res) => {
		if (!requireAuth(req, res)) return;
		if (!accountService) { sendJson(res, 404, { error: "accounts_disabled" }); return; }
		sendJson(res, 200, accountService.store.listUsers(String(req.query.q || ""), clampInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER), clampInt(req.query.pageSize, 20, 1, 100)));
	});

	app.get("/admin/api/account-audit", (req, res) => {
		if (!requireAuth(req, res)) return;
		if (!accountService) { sendJson(res, 404, { error: "accounts_disabled" }); return; }
		sendJson(res, 200, accountService.store.listAudit(clampInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER), clampInt(req.query.pageSize, 50, 1, 100)));
	});

	app.get("/admin/api/projects", (req, res) => {
		if (!requireAuth(req, res)) return;
		if (!accountService) { sendJson(res, 404, { error: "accounts_disabled" }); return; }
		sendJson(res, 200, accountService.store.listAllProjects(clampInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER), clampInt(req.query.pageSize, 50, 1, 100)));
	});

	app.get("/admin/api/projects/:id", (req, res) => {
		if (!requireAuth(req, res)) return;
		if (!accountService) { sendJson(res, 404, { error: "accounts_disabled" }); return; }
		const project = accountService.store.getProjectAsAdmin(req.params.id);
		sendJson(res, project ? 200 : 404, project || { error: "project_not_found" });
	});

	app.post("/admin/api/users", async (req, res) => {
		if (!requireMutationAuth(req, res)) return;
		if (!accountService) { sendJson(res, 404, { error: "accounts_disabled" }); return; }
		try {
			const body = readJsonBody(req); const email = String(body.email || ""); const newPassword = String(body.password || ""); const username = String(body.username || body.displayName || email.split("@")[0]).trim(); const nickname = String(body.nickname || body.displayName || username).trim();
			if (!email.includes("@") || newPassword.length < 10) { sendJson(res, 400, { error: "invalid_user" }); return; }
			if (accountService.store.getUserByIdentity(username)) { sendJson(res, 409, { error: "user_exists" }); return; }
			const user = await accountService.store.createUser({ email, password: newPassword, username, nickname, role: body.role === "admin" ? "admin" : "user", mustChangePassword: body.mustChangePassword !== false });
			accountService.store.audit(actor(req), "admin.user-create", user.id, { email: user.email, role: user.role }); sendJson(res, 201, user);
		} catch (error) { console.error("[admin] create user failed", error); sendJson(res, 409, { error: "user_exists" }); }
	});

	app.patch("/admin/api/users/:id", (req, res) => {
		if (!requireMutationAuth(req, res)) return;
		if (!accountService) { sendJson(res, 404, { error: "accounts_disabled" }); return; }
		try {
			const current = accountService.store.getUserById(req.params.id); if (!current) { sendJson(res, 404, { error: "user_not_found" }); return; }
			const body = readJsonBody(req);
			if (current.role === "admin" && body.role === "user" && current.status === "active" && accountService.store.activeAdminCount() <= 1) { sendJson(res, 409, { error: "last_admin" }); return; }
			const nextRole = body.role === "admin" || body.role === "user" ? body.role : current.role; const nextName = typeof body.username === "string" ? body.username.trim() : current.username; const duplicateName = accountService.store.getUserByIdentity(nextName);
			if (duplicateName && duplicateName.id !== current.id) { sendJson(res, 409, { error: "user_update_failed" }); return; }
			const user = accountService.store.updateUser(current.id, { email: typeof body.email === "string" ? body.email : undefined, username: typeof body.username === "string" ? body.username : undefined, nickname: typeof body.nickname === "string" ? body.nickname : typeof body.displayName === "string" ? body.displayName : undefined, role: body.role === "admin" || body.role === "user" ? body.role : undefined });
			accountService.store.audit(actor(req), "admin.user-update", current.id, body); sendJson(res, 200, user);
		} catch { sendJson(res, 409, { error: "user_update_failed" }); }
	});

	app.post("/admin/api/users/:id/password", async (req, res) => {
		if (!requireMutationAuth(req, res)) return;
		if (!accountService) { sendJson(res, 404, { error: "accounts_disabled" }); return; }
		try { const body = readJsonBody(req); const newPassword = String(body.password || ""); if (newPassword.length < 10 || !accountService.store.getUserById(req.params.id)) { sendJson(res, 400, { error: "invalid_password" }); return; } await accountService.store.updatePassword(req.params.id, newPassword, body.mustChangePassword !== false); accountService.store.audit(actor(req), "admin.password-reset", req.params.id); sendJson(res, 200, { ok: true }); }
		catch { sendJson(res, 400, { error: "password_update_failed" }); }
	});

	app.post("/admin/api/users/:id/status", (req, res) => {
		if (!requireMutationAuth(req, res)) return;
		if (!accountService) { sendJson(res, 404, { error: "accounts_disabled" }); return; }
		const current = accountService.store.getUserById(req.params.id); if (!current) { sendJson(res, 404, { error: "user_not_found" }); return; }
		const body = readJsonBody(req); const status = String(body.status || "active"); const reason = String(body.reason || "").trim();
		if (!["active", "disabled", "banned"].includes(status) || (status === "banned" && !reason)) { sendJson(res, 400, { error: "ban_reason_required" }); return; }
		if (current.role === "admin" && current.status === "active" && status !== "active" && accountService.store.activeAdminCount() <= 1) { sendJson(res, 409, { error: "last_admin" }); return; }
		const user = accountService.store.setStatus(current.id, status as "active" | "disabled" | "banned", reason, String(body.until || "")); accountService.store.audit(actor(req), `admin.user-${status}`, current.id, { reason, until: body.until || "" }); sendJson(res, 200, user);
	});

	app.delete("/admin/api/users/:id", (req, res) => {
		if (!requireMutationAuth(req, res)) return;
		if (!accountService) { sendJson(res, 404, { error: "accounts_disabled" }); return; }
		const current = accountService.store.getUserById(req.params.id); if (!current) { sendJson(res, 404, { error: "user_not_found" }); return; }
		if (current.role === "admin" && current.status === "active" && accountService.store.activeAdminCount() <= 1) { sendJson(res, 409, { error: "last_admin" }); return; }
		const body = readJsonBody(req); const action = String(body.projectAction || "archive");
		if (!["delete", "archive", "transfer"].includes(action) || (action === "transfer" && !accountService.store.getUserById(String(body.transferUserId || "")))) { sendJson(res, 400, { error: "invalid_project_action" }); return; }
		const ok = accountService.store.deleteUser(current.id, action as "delete" | "archive" | "transfer", String(body.transferUserId || "")); accountService.store.audit(actor(req), "admin.user-delete", current.id, { projectAction: action, transferUserId: body.transferUserId || "" }); sendJson(res, ok ? 200 : 404, { ok });
	});

	app.get("/admin/api/logs", async (req, res) => {
		if (!requireAuth(req, res)) return;

		const page = clampInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
		const pageSize = clampInt(
			req.query.pageSize,
			DEFAULT_PAGE_SIZE,
			1,
			MAX_PAGE_SIZE,
		);
		const query = String(req.query.q || "").trim();

		try {
			const data = await store.listLogMetadata({ page, pageSize, query });
			sendJson(res, 200, data);
		} catch (error) {
			console.error("[admin] Failed to list logs:", error);
			sendJson(res, 500, { error: "failed to list logs" });
		}
	});

	app.post("/admin/api/logs/delete", async (req, res) => {
		if (!requireMutationAuth(req, res)) return;

		let keys: string[];
		try {
			keys = keysFromRequest(req);
		} catch {
			sendJson(res, 400, { error: "invalid JSON body" });
			return;
		}

		if (!keys.length) {
			sendJson(res, 400, { error: "no log keys provided" });
			return;
		}

		try {
			sendJson(res, 200, await store.deleteLogs(keys));
		} catch (error) {
			console.error("[admin] Failed to delete logs:", error);
			sendJson(res, 500, { error: "failed to delete logs" });
		}
	});

	app.get("/admin/api/logs/:key/raw", async (req, res) => {
		if (!requireAuth(req, res)) return;

		try {
			const key = req.params.key;
			if (!key) {
				sendJson(res, 400, { error: "invalid log key" });
				return;
			}

			const raw = await store.readRawLog(key);
			if (!raw) {
				sendJson(res, 404, { error: "log not found" });
				return;
			}

			res.status(200);
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("Pragma", "no-cache");
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.setHeader(
				"Content-Disposition",
				`attachment; filename="${safeDownloadName(key)}"`,
			);
			res.send(raw);
		} catch (error) {
			console.error("[admin] Failed to export raw log:", error);
			sendJson(res, 500, { error: "failed to export raw log" });
		}
	});

	app.delete("/admin/api/logs/:key", async (req, res) => {
		if (!requireMutationAuth(req, res)) return;

		try {
			const key = String(req.params.key || "");
			if (!key) {
				sendJson(res, 400, { error: "invalid log key" });
				return;
			}
			sendJson(res, 200, await store.deleteLogs([key]));
		} catch (error) {
			console.error("[admin] Failed to delete log:", error);
			sendJson(res, 500, { error: "failed to delete log" });
		}
	});

	app.get("/admin/api/logs/:key", async (req, res) => {
		if (!requireAuth(req, res)) return;

		try {
			const key = req.params.key;
			if (!key) {
				sendJson(res, 400, { error: "invalid log key" });
				return;
			}

			const record = await store.readLogDetail(key);
			if (!record) {
				sendJson(res, 404, { error: "log not found" });
				return;
			}

			sendJson(res, 200, record);
		} catch (error) {
			console.error("[admin] Failed to read log:", error);
			sendJson(res, 500, { error: "failed to read log" });
		}
	});

	app.post("/admin/api/cleanup", async (req, res) => {
		if (!requireMutationAuth(req, res)) return;

		let requestedRetentionDays = retentionDays;
		try {
			const body = readJsonBody(req);
			if (body?.retentionDays) {
				requestedRetentionDays = clampInt(
					body.retentionDays,
					retentionDays,
					1,
					36500,
				);
			}
		} catch {
			sendJson(res, 400, { error: "invalid JSON body" });
			return;
		}

		try {
			sendJson(res, 200, await store.cleanupOldLogs(requestedRetentionDays));
		} catch (error) {
			console.error("[admin] Failed to cleanup logs:", error);
			sendJson(res, 500, { error: "failed to cleanup logs" });
		}
	});

	app.post("/admin/api/database/maintenance", async (req, res) => {
		if (!requireMutationAuth(req, res)) return;

		let vacuum = false;
		try {
			const body = readJsonBody(req);
			vacuum = body?.vacuum === true;
		} catch (_error) {
			sendJson(res, 400, { error: "invalid JSON body" });
			return;
		}

		try {
			sendJson(res, 200, await store.maintainDatabase({ vacuum }));
		} catch (error) {
			console.error("[admin] Failed to maintain database:", error);
			sendJson(res, 500, { error: "failed to maintain database" });
		}
	});
}

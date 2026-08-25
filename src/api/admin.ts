import crypto from "node:crypto";
import fs from "node:fs";
import type { LogStore } from "../storage/log-store.js";
import { getClientIp } from "../server/client-ip.js";

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
	security = {},
}: {
	app;
	store: LogStore;
	password: string;
	adminFilePath: string;
	trustProxy?: boolean;
	retentionDays?: number;
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
		return !!getSession(req);
	}

	function requireAuth(req, res) {
		if (isAuthenticated(req)) return true;
		sendJson(res, 401, { error: "admin authentication required" });
		return false;
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
		sendJson(res, 200, { authenticated: isAuthenticated(req) });
	});

	app.post("/admin/api/login", async (req, res) => {
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
		if (!requireAuth(req, res)) return;

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
		if (!requireAuth(req, res)) return;

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
		if (!requireAuth(req, res)) return;

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
		if (!requireAuth(req, res)) return;

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

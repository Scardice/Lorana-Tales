import crypto from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import express from "express";
import { AccountService } from "../accounts/router.js";
import { AccountStore } from "../accounts/account-store.js";
import { createAdminRouter } from "../api/admin.js";
import { handleDiceApiRequest } from "../api/dice.js";
import { loadConfig } from "../config/load-config.js";
import { getClientIp } from "./client-ip.js";
import {
	createSecurityInterceptId,
	formatBruteforceDetail,
	formatSecurityWarning,
} from "../security/injection-guard.js";
import type { LogStore } from "../storage/log-store.js";
import { SqliteLogStore } from "../storage/sqlite-log-store.js";
import { CqResourceCache } from "../storage/cq-resource-cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

type StartServerResult = {
	app: Express;
	server: Server;
	store: SqliteLogStore;
	config: ReturnType<typeof loadConfig>;
	accountService: AccountService | null;
};

type SecurityBlockRecord = {
	interceptId: string;
	clientIp: string;
	reason: string;
	detail: string;
	warningText: string;
	createdAt: string;
	expiresAt: number;
};

const ADMIN_BRUTEFORCE_REASON =
	"检测到管理员登录页面疑似爆破行为，当前来源已被安全系统临时封禁。请求内容以及IP已经被记录，请规范个人行为。";

function firstHeaderValue(value) {
	if (Array.isArray(value)) return value[0] || "";
	return String(value || "");
}

function getExternalProtocol(req, trustProxy) {
	if (trustProxy) {
		const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"])
			.split(",")[0]
			.trim();
		if (forwardedProto) return forwardedProto;
	}
	return req.protocol;
}

function getExternalHost(req, trustProxy) {
	if (trustProxy) {
		const forwardedHost = firstHeaderValue(req.headers["x-forwarded-host"])
			.split(",")[0]
			.trim();
		if (forwardedHost) return forwardedHost;
	}
	return req.get("host");
}

function hostnameFromHost(value): string {
	const host = String(value || "")
		.trim()
		.toLowerCase();
	if (!host) return "";
	try {
		return new URL(`http://${host}`).hostname.toLowerCase();
	} catch {
		if (host.startsWith("[") && host.includes("]")) {
			return host.slice(1, host.indexOf("]"));
		}
		const colonCount = (host.match(/:/g) || []).length;
		if (colonCount === 1) return host.split(":")[0];
		return host;
	}
}

function hostFromUrl(value): string {
	if (typeof value !== "string" || !value.trim()) return "";
	const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
	try {
		return new URL(withProtocol).hostname.toLowerCase();
	} catch {
		return "";
	}
}

function getAllowedHosts(config): Set<string> {
	const allowed = new Set<string>();
	for (const host of config.server?.allowed_hosts || []) {
		const normalized = hostnameFromHost(host);
		if (normalized) allowed.add(normalized);
	}
	const frontendHost = hostFromUrl(config.app?.frontend_url);
	if (frontendHost) allowed.add(frontendHost);
	return allowed;
}

function isAllowedHost(host, allowedHosts: Set<string>): boolean {
	const normalized = hostnameFromHost(host);
	return !!normalized && allowedHosts.has(normalized);
}

function setSecurityHeaders(_req, res, next) {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader(
		"Permissions-Policy",
		"camera=(), microphone=(), geolocation=(), payment=()",
	);
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader(
		"Content-Security-Policy",
		[
			"default-src 'self'",
			"script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com https://js.hcaptcha.com",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data: blob: http: https:",
			"media-src 'self' http: https:",
			"font-src 'self' data:",
			"connect-src 'self' https://dice-api.weizaima.com https://challenges.cloudflare.com https://api.hcaptcha.com https://*.hcaptcha.com",
			"frame-src https://challenges.cloudflare.com https://*.hcaptcha.com",
			"worker-src 'self' blob:",
			"object-src 'none'",
			"base-uri 'self'",
			"frame-ancestors 'none'",
			"form-action 'self'",
		].join("; "),
	);
	next();
}

function isMetricsAuthorized(req, config): boolean {
	if (!config.metrics?.enabled) return false;
	const token = String(config.metrics?.token || "").trim();
	if (!token) return true;
	const header = firstHeaderValue(req.headers.authorization);
	const match = /^Bearer\s+(.+)$/i.exec(header);
	if (!match) return false;
	const provided = crypto.createHash("sha256").update(match[1]).digest();
	const expected = crypto.createHash("sha256").update(token).digest();
	return crypto.timingSafeEqual(provided, expected);
}

function isPathInside(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function securityBypassPath(pathname: string): boolean {
	return (
		pathname === "/security-warning.html" ||
		pathname === "/icon.png" ||
		pathname.startsWith("/assets/") ||
		pathname.startsWith("/api/security/intercepts/")
	);
}

function securityQuotes(config): string[] {
	return Array.isArray(config.security?.warning_quotes)
		? config.security.warning_quotes.map(String)
		: [];
}

async function appendSecurityAuditRecord(config, record) {
	const auditLogPath = String(config.security?.audit_log_path || "");
	if (!auditLogPath) return;
	await fs.promises.mkdir(path.dirname(auditLogPath), { recursive: true });
	await fs.promises.appendFile(
		auditLogPath,
		`${JSON.stringify(record)}\n`,
		"utf-8",
	);
}

async function sendMetrics(res, store: LogStore) {
	const metrics = await store.getLogMetrics();
	res.status(200);
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
	res.send(
		[
			"# HELP scardice_log_total Number of logs stored in SQLite.",
			"# TYPE scardice_log_total gauge",
			`scardice_log_total ${metrics.totalLogs}`,
			"# HELP scardice_log_stored_bytes_total Total stored JSON bytes.",
			"# TYPE scardice_log_stored_bytes_total gauge",
			`scardice_log_stored_bytes_total ${metrics.totalStoredBytes}`,
			"# HELP scardice_log_decoded_bytes_total Total decoded log bytes.",
			"# TYPE scardice_log_decoded_bytes_total gauge",
			`scardice_log_decoded_bytes_total ${metrics.totalDecodedBytes}`,
			"# HELP scardice_sqlite_wal_enabled Whether SQLite WAL mode is enabled.",
			"# TYPE scardice_sqlite_wal_enabled gauge",
			`scardice_sqlite_wal_enabled ${metrics.walEnabled ? 1 : 0}`,
			"# HELP scardice_sqlite_pages SQLite page count.",
			"# TYPE scardice_sqlite_pages gauge",
			`scardice_sqlite_pages ${metrics.sqlitePageCount}`,
			"# HELP scardice_sqlite_page_size_bytes SQLite page size in bytes.",
			"# TYPE scardice_sqlite_page_size_bytes gauge",
			`scardice_sqlite_page_size_bytes ${metrics.sqlitePageSize}`,
			"",
		].join("\n"),
	);
}

export async function startServer(
	config = loadConfig(),
): Promise<StartServerResult> {
	const configuredAdminPassword = String(config.admin?.password || "").trim();
	const adminPassword = configuredAdminPassword || crypto.randomUUID();
	const isGeneratedAdminPassword = !configuredAdminPassword;
	const trustProxy = !!config.server?.trust_proxy;
	const allowedHosts = getAllowedHosts(config);
	const securityBlocksByIp = new Map<string, SecurityBlockRecord>();
	const securityBlocksById = new Map<string, SecurityBlockRecord>();
	const editorAssetFetches = new Map<string, { startedAt: number; count: number }>();
	function takeEditorFetchQuota(kind: "asset" | "avatar", clientIp: string, limit: number) {
		const key = `${kind}:${clientIp}`;
		const now = Date.now();
		const current = editorAssetFetches.get(key);
		const quota = current && current.startedAt > now - 10 * 60 * 1000 ? current : { startedAt: now, count: 0 };
		if (quota.count >= limit) return false;
		quota.count += 1;
		editorAssetFetches.set(key, quota);
		if (editorAssetFetches.size > 5000) editorAssetFetches.delete(editorAssetFetches.keys().next().value as string);
		return true;
	}

	function cleanupSecurityBlocks() {
		const now = Date.now();
		for (const [ip, record] of securityBlocksByIp) {
			if (record.expiresAt <= now) securityBlocksByIp.delete(ip);
		}
		for (const [id, record] of securityBlocksById) {
			if (record.expiresAt <= now) securityBlocksById.delete(id);
		}
	}

	function activeSecurityBlockForIp(clientIp: string) {
		cleanupSecurityBlocks();
		const record = securityBlocksByIp.get(clientIp);
		if (!record || record.expiresAt <= Date.now()) return null;
		return record;
	}

	async function createAdminBruteforceBlock(clientIp: string, credentials: string[]) {
		const interceptId = createSecurityInterceptId();
		const detail = formatBruteforceDetail(credentials);
		const expiresAt =
			Date.now() +
			Math.max(1, Number(config.security?.admin_bruteforce_block_seconds || 60)) *
				1000;
		const record: SecurityBlockRecord = {
			interceptId,
			clientIp,
			reason: ADMIN_BRUTEFORCE_REASON,
			detail,
			warningText: formatSecurityWarning({
				interceptId,
				reason: ADMIN_BRUTEFORCE_REASON,
				detail,
				quotes: securityQuotes(config),
			}),
			createdAt: new Date().toISOString(),
			expiresAt,
		};
		securityBlocksByIp.set(clientIp, record);
		securityBlocksById.set(interceptId, record);
		await appendSecurityAuditRecord(config, {
			timestamp: record.createdAt,
			interceptId,
			event: "admin_bruteforce_blocked",
			clientIp,
			reason: record.reason,
			detail: record.detail,
			expiresAt: new Date(expiresAt).toISOString(),
			metadata: {
				credentials,
			},
		}).catch((error) => {
			console.error("Security audit log write failed:", error);
		});
		return record;
	}

	const store = new SqliteLogStore(config.storage.sqlite_path);
	let accountService: AccountService | null = null;
	if (config.accounts?.enabled) {
		if (String(config.accounts.encryption_key || "").length < 32) {
			throw new Error("accounts.encryption_key must contain at least 32 characters when accounts are enabled");
		}
		accountService = new AccountService(new AccountStore(store.db), config.accounts, trustProxy, store);
	}
	const resourceCache = new CqResourceCache(config.resource_cache);
	if (resourceCache.enabled) {
		const deleted = await resourceCache.cleanupExpired();
		console.log(`[server] CQ resource cache startup cleanup: ${deleted} files removed`);
	}

	if (config.app.cleanup_on_start) {
		const result = await store.cleanupOldLogs(config.app.log_retention_days);
		console.log(
			`[server] Startup cleanup deleted ${result.deletedCount} of ${result.processedCount} logs`,
		);
	}

	const appEnv = {
		FRONTEND_URL: config.app.frontend_url,
		LOG_RETENTION_DAYS: String(config.app.log_retention_days),
		MAX_UPLOAD_MB: String(config.app.max_upload_mb),
		CLEANUP_AFTER_UPLOAD: String(config.app.cleanup_after_upload),
		BACKUP_UPLOAD_API: config.app.backup_upload_api,
		INJECTION_GUARD_ENABLED: String(
			config.security?.injection_guard_enabled ?? true,
		),
		SECURITY_AUDIT_LOG_PATH: config.security?.audit_log_path,
		SECURITY_WARNING_QUOTES: JSON.stringify(
			config.security?.warning_quotes || [],
		),
		CQ_RESOURCE_CACHE: resourceCache,
		LOG_STORE: store,
	};

	const app = express();
	app.disable("x-powered-by");
	app.set("trust proxy", trustProxy);
	app.use(setSecurityHeaders);
	app.use((req, res, next) => {
		const host = getExternalHost(req, trustProxy);
		if (!isAllowedHost(host, allowedHosts)) {
			res.status(400).type("text/plain").send("Invalid Host header");
			return;
		}
		next();
	});
	app.use((req, res, next) => {
		if (securityBypassPath(req.path)) {
			next();
			return;
		}
		const block = activeSecurityBlockForIp(getClientIp(req, trustProxy));
		if (block) {
			res.redirect(
				302,
				`/security-warning.html?intercept_id=${encodeURIComponent(block.interceptId)}`,
			);
			return;
		}
		next();
	});

	// Parse raw body for all content types (up to 10 MB to handle the default
	// 5 MB upload limit plus multipart overhead).
	const accountBodyLimitMb = config.accounts?.enabled ? Number(config.accounts.max_project_mb || 25) + 2 : 0;
	const rawLimitMb = Math.max(10, Number(config.app.max_upload_mb || 5) * 2, accountBodyLimitMb);
	app.use(express.raw({ type: "*/*", limit: `${rawLimitMb}mb` }));
	accountService?.register(app);

	app.get("/healthz", (_req, res) => {
		res.status(200);
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.send(JSON.stringify({ ok: true, timestamp: new Date().toISOString() }));
	});

	app.get("/metrics", async (req, res) => {
		if (!config.metrics?.enabled) {
			res.status(404).type("text/plain").send("Not Found");
			return;
		}
		if (!isMetricsAuthorized(req, config)) {
			res.setHeader("WWW-Authenticate", 'Bearer realm="metrics"');
			res.status(401).type("text/plain").send("Unauthorized");
			return;
		}
		try {
			await sendMetrics(res, store);
		} catch (error) {
			console.error("[server] Failed to render metrics:", error);
			res.status(500).type("text/plain").send("metrics unavailable");
		}
	});

	app.get("/api/security/intercepts/:id", (req, res) => {
		const record = securityBlocksById.get(String(req.params.id || ""));
		if (
			!record ||
			record.expiresAt <= Date.now() ||
			record.clientIp !== getClientIp(req, trustProxy)
		) {
			res.status(404).type("application/json").send(JSON.stringify({ error: "Not Found" }));
			return;
		}
		res.status(200);
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.send(
			JSON.stringify({
				interceptId: record.interceptId,
				reason: record.reason,
				detail: record.detail,
				warningText: record.warningText,
				expiresAt: new Date(record.expiresAt).toISOString(),
			}),
		);
	});

	app.get("/cq-resources/:resourceId", async (req, res) => {
		try {
			const acceptsBrotli = /(?:^|,)\s*br(?:;q=(?!0(?:\.0+)?$)[0-9.]+)?\s*(?:,|$)/i.test(
				String(req.headers["accept-encoding"] || ""),
			);
			const resource = await resourceCache.readResource(
				String(req.params.resourceId || ""),
				acceptsBrotli,
			);
			if (!resource) {
				res.status(404).type("text/plain").send("Not Found");
				return;
			}
			res.status(200);
			res.setHeader("Content-Type", resource.contentType);
			res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
			res.setHeader("Vary", "Accept-Encoding");
			if (resource.contentEncoding) res.setHeader("Content-Encoding", resource.contentEncoding);
			res.send(resource.body);
		} catch (error) {
			console.error("[server] CQ resource read failed:", error);
			res.status(500).type("text/plain").send("Resource unavailable");
		}
	});

	app.get("/api/editor/avatar/qq/:uin", async (req, res) => {
		const uin = String(req.params.uin || "");
		if (!/^\d{5,12}$/.test(uin)) {
			res.status(400).type("text/plain").send("Invalid QQ number");
			return;
		}
		if (!takeEditorFetchQuota("avatar", getClientIp(req, trustProxy), 120)) {
			res.status(429).type("text/plain").send("Avatar fetch rate limited");
			return;
		}
		try {
			const resourceId = await resourceCache.cacheRemoteImage(`http://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100`);
			res.setHeader("Cache-Control", "public, max-age=86400");
			res.redirect(302, resourceCache.resourceUrl(resourceId));
		} catch (error) {
			console.error("[server] QQ avatar cache failed:", error);
			res.status(502).type("text/plain").send("Avatar unavailable");
		}
	});

	app.post("/api/editor/assets/fetch", async (req, res) => {
		const clientIp = getClientIp(req, trustProxy);
		if (!takeEditorFetchQuota("asset", clientIp, 40)) {
			res.status(429).type("application/json").send(JSON.stringify({ error: "asset_fetch_rate_limited" }));
			return;
		}
		try {
			const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : "{}";
			const sourceUrl = String(JSON.parse(raw || "{}").url || "");
			const resourceId = await resourceCache.cacheRemoteImage(sourceUrl);
			res.status(200).set({ "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }).send(JSON.stringify({ resourceId, url: resourceCache.resourceUrl(resourceId) }));
		} catch (error) {
			console.error("[server] Editor asset fetch failed:", error);
			res.status(400).type("application/json").send(JSON.stringify({ error: "asset_fetch_failed" }));
		}
	});

	const staticDir = path.resolve(projectRoot, "out");
	if (fs.existsSync(staticDir)) {
		console.log(`[server] Serving static files from: ${staticDir}`);
		app.use(express.static(staticDir));
	}

	createAdminRouter({
		app,
		store,
		password: adminPassword,
		adminFilePath: path.resolve(staticDir, "admin.html"),
		trustProxy,
		retentionDays: config.app.log_retention_days,
		accountService,
		security: {
			bruteforceBlockEnabled:
				config.security?.admin_bruteforce_block_enabled !== false,
			maxAttempts: Number(config.security?.admin_bruteforce_max_attempts || 8),
			windowMs:
				Math.max(1, Number(config.security?.admin_bruteforce_window_seconds || 60)) *
				1000,
			onBlock: createAdminBruteforceBlock,
		},
	});

	app.get(["/api-docs", "/api-docs/"], (_req, res) => {
		const docsFile = path.resolve(staticDir, "api-docs.html");
		if (fs.existsSync(docsFile)) {
			res.setHeader("Cache-Control", "no-store");
			return res.sendFile(docsFile);
		}
		res.status(404).type("text/plain").send("API docs have not been built yet");
	});

	app.all(/^\/(?:api\/dice|dice\/api)\//, async (req, res) => {
		try {
			const protocol = getExternalProtocol(req, trustProxy);
			const host = getExternalHost(req, trustProxy);
			const url = `${protocol}://${host}${req.originalUrl}`;

			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) {
				if (value === undefined || value === null) continue;
				if (Array.isArray(value)) {
					for (const item of value) headers.append(key, item);
				} else {
					headers.set(key, value);
				}
			}
			headers.set("x-scardice-client-ip", getClientIp(req, trustProxy));

			const hasBody = !["GET", "HEAD"].includes(req.method.toUpperCase());
			const body = hasBody && req.body instanceof Buffer ? req.body : undefined;

			const webRequest = new Request(url, {
				method: req.method,
				headers,
				body,
			});

			const webResponse = await handleDiceApiRequest({
				request: webRequest,
				env: appEnv,
			});

			res.status(webResponse.status);
			for (const [key, value] of webResponse.headers.entries()) {
				res.setHeader(key, value);
			}

			const responseBody = await webResponse.text();
			if (responseBody) {
				res.send(responseBody);
			} else {
				res.end();
			}
		} catch (error) {
			console.error("[server] Unhandled error:", error);
			res.status(500);
			res.setHeader("Content-Type", "text/plain");
			res.send("Internal Server Error");
		}
	});

	app.use((req, res) => {
		if (
			!req.path.startsWith("/api/dice/") &&
			!req.path.startsWith("/dice/api/")
		) {
			const staticFile = path.resolve(
				staticDir,
				req.path === "/" ? "index.html" : req.path.slice(1),
			);
			if (
				fs.existsSync(staticDir) &&
				fs.existsSync(staticFile) &&
				isPathInside(staticDir, staticFile) &&
				fs.statSync(staticFile).isFile()
			) {
				return res.sendFile(staticFile);
			}
		}
		res.status(404).type("text/plain").send("Not Found");
	});

	const { host, port } = config.server;
	const server = app.listen(port, host, () => {
		console.log(
			`[server] Scardice Log Backend running at http://${host}:${port}`,
		);
		console.log(
			`[server] SQLite database: ${path.resolve(config.storage.sqlite_path)}`,
		);
		console.log(`[server] Frontend URL: ${config.app.frontend_url || "auto"}`);
		console.log(
			`[server] Log retention: ${config.app.log_retention_days} days`,
		);
		console.log(`[server] Max upload: ${config.app.max_upload_mb} MB`);
		console.log(
			`[server] CQ resource cache: ${resourceCache.enabled ? `enabled (${config.resource_cache.retention_days} days, ${config.resource_cache.path})` : "disabled"}`,
		);
		console.log(`[server] Accounts: ${accountService ? "enabled" : "disabled"}`);
		console.log(`[server] Trust proxy: ${trustProxy ? "enabled" : "disabled"}`);
		console.log(
			`[server] Allowed hosts: ${[...allowedHosts].join(", ") || "none"}`,
		);
		console.log(
			`[server] Metrics: ${config.metrics?.enabled ? "enabled" : "disabled"}`,
		);
		console.log(
			`[server] Injection guard: ${config.security?.injection_guard_enabled ? "enabled" : "disabled"}`,
		);
		if (config.app.backup_upload_api) {
			console.log(
				`[server] Backup upload API: ${config.app.backup_upload_api}`,
			);
		}
		if (isGeneratedAdminPassword) {
			console.log(
				`[admin] Generated one-time admin password: ${adminPassword}`,
			);
		} else {
			console.log(`[admin] Admin password loaded from configuration`);
		}
	});

	return { app, server, store, config, accountService };
}

const directRunPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (directRunPath && fileURLToPath(import.meta.url) === directRunPath) {
	startServer().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}

import crypto from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import express from "express";
import { AccountService } from "../accounts/router.js";
import { AccountStore } from "../accounts/account-store.js";
import { PostgresAccountStore } from "../accounts/postgres-account-store.js";
import { createAdminRouter } from "../api/admin.js";
import { handleDiceApiRequest } from "../api/dice.js";
import { loadConfig } from "../config/load-config.js";
import { getClientIp, isTrustedProxyRequest, type TrustedProxyPolicy } from "./client-ip.js";
import {
	createSecurityInterceptId,
	formatBruteforceDetail,
	formatSecurityWarning,
} from "../security/injection-guard.js";
import type { LogStore } from "../storage/log-store.js";
import { SqliteLogStore } from "../storage/sqlite-log-store.js";
import { createPostgresPool, PostgresLogStore } from "../storage/postgres-log-store.js";
import { CqResourceCache } from "../storage/cq-resource-cache.js";
import { PostgresResourceIndex, SqliteResourceIndex } from "../storage/resource-index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

type StartServerResult = {
	app: Express;
	server: Server;
	store: LogStore;
	resourceCache: CqResourceCache;
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

type BrandingAsset = {
	filePath: string;
	contentType: string;
	version: string;
};

const BRANDING_CONTENT_TYPES = new Map([
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".ico", "image/x-icon"],
]);

function resolveBrandingAsset(
	configuredPath: unknown,
	allowedExtensions: Set<string>,
	label: string,
): BrandingAsset | null {
	const filePath = String(configuredPath || "").trim();
	if (!filePath) return null;
	const extension = path.extname(filePath).toLowerCase();
	if (!allowedExtensions.has(extension)) {
		console.warn(`[branding] Ignoring ${label}: unsupported file type ${extension || "(none)"}`);
		return null;
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
		if (!stat.isFile()) throw new Error("not a file");
	} catch {
		console.warn(`[branding] Ignoring ${label}: configured file is unavailable`);
		return null;
	}
	return {
		filePath,
		contentType: BRANDING_CONTENT_TYPES.get(extension) || "application/octet-stream",
		version: `${Math.trunc(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}`,
	};
}

const ADMIN_BRUTEFORCE_REASON =
	"检测到管理员登录页面疑似爆破行为，当前来源已被安全系统临时封禁。请求内容以及IP已经被记录，请规范个人行为。";

function firstHeaderValue(value) {
	if (Array.isArray(value)) return value[0] || "";
	return String(value || "");
}

function getExternalProtocol(req, trustProxy: TrustedProxyPolicy) {
	if (isTrustedProxyRequest(req, trustProxy)) {
		const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"])
			.split(",")[0]
			.trim();
		if (forwardedProto) return forwardedProto;
	}
	return req.protocol;
}

function getExternalHost(req, trustProxy: TrustedProxyPolicy) {
	if (isTrustedProxyRequest(req, trustProxy)) {
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
	if (!host || /[\s,\\/@]/.test(host)) return "";
	const bracketed = /^\[([^\]]+)](?::(\d{1,5}))?$/.exec(host);
	if (bracketed) return isIP(bracketed[1]) === 6 && validHostPort(bracketed[2]) ? bracketed[1] : "";
	const regular = /^([^:]+)(?::(\d{1,5}))?$/.exec(host);
	if (!regular || !validHostPort(regular[2])) return "";
	const hostname = regular[1].replace(/\.$/, "");
	if (isIP(hostname)) return hostname;
	return hostname.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(hostname) ? hostname : "";
}

function validHostPort(value: string | undefined): boolean {
	if (value === undefined) return true;
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65_535;
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
	if (config.metrics?.enabled && !String(config.metrics?.token || "").trim()) {
		throw new Error("metrics.token (or METRICS_TOKEN) is required when metrics are enabled");
	}
	const accountMode = !!config.accounts?.enabled;
	const adminPassword = accountMode ? "" : configuredAdminPassword || crypto.randomUUID();
	const isGeneratedAdminPassword = !accountMode && !configuredAdminPassword;
	const trustProxy = !!config.server?.trust_proxy;
	const trustProxyPolicy: TrustedProxyPolicy = trustProxy
		? (Array.isArray(config.server?.trusted_proxy_cidrs) ? config.server.trusted_proxy_cidrs.map(String) : [])
		: false;
	const allowedHosts = getAllowedHosts(config);
	const brandingLogo = resolveBrandingAsset(
		config.branding?.logo_path,
		new Set([".png", ".svg"]),
		"logo",
	);
	const brandingFavicon = resolveBrandingAsset(
		config.branding?.favicon_path,
		new Set([".ico", ".png", ".svg"]),
		"favicon",
	);
	const securityBlocksByIp = new Map<string, SecurityBlockRecord>();
	const securityBlocksById = new Map<string, SecurityBlockRecord>();
	const editorAssetFetches = new Map<string, { startedAt: number; count: number }>();
	function takeEditorFetchQuota(kind: "asset" | "avatar" | "avatar-candidates", clientIp: string, limit: number) {
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
		while (securityBlocksByIp.size > 5000) securityBlocksByIp.delete(securityBlocksByIp.keys().next().value as string);
		while (securityBlocksById.size > 5000) securityBlocksById.delete(securityBlocksById.keys().next().value as string);
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

	const maxLogBytes = Math.max(1, Number(config.storage.max_total_mb || 4096)) * 1024 * 1024;
	const postgres = config.database.driver === "postgres"
		? createPostgresPool({ url: config.database.postgres_url, poolMax: config.database.pool_max, ssl: config.database.ssl })
		: null;
	const store: LogStore = postgres
		? new PostgresLogStore(postgres, maxLogBytes)
		: new SqliteLogStore(config.database.sqlite_path, { maxTotalBytes: maxLogBytes });
	if (store instanceof PostgresLogStore) await store.initialize();
	const resourceIndex = postgres
		? new PostgresResourceIndex(postgres)
		: new SqliteResourceIndex(config.resource_cache.index_sqlite_path);
	let accountService: AccountService | null = null;
	if (config.accounts?.enabled) {
		if (String(config.accounts.encryption_key || "").length < 32) {
			throw new Error("accounts.encryption_key must contain at least 32 characters when accounts are enabled");
		}
		const publicBase = String(config.app.frontend_url || "").replace(/\/$/, "");
		const accountStore = postgres
			? new PostgresAccountStore(postgres)
			: new AccountStore((store as SqliteLogStore).db);
		if (accountStore instanceof PostgresAccountStore) await accountStore.initialize();
		accountService = new AccountService(accountStore, config.accounts, trustProxyPolicy, store, {
			siteTitle: String(config.branding.site_title || "Lorana Tales"),
			logoUrl: brandingLogo && publicBase ? `${publicBase}/branding/logo?v=${brandingLogo.version}` : "",
		});
		await accountService.ensureInitialAdmin();
		const projectCleanup = await accountService.cleanupInactiveProjects();
		console.log(`[server] Account project cleanup deleted ${projectCleanup.deletedProjects} inactive projects and freed ${projectCleanup.freedBytes} bytes`);
		const projectCleanupTimer = setInterval(async () => {
			try {
				const result = await accountService?.cleanupInactiveProjects();
				if (result?.deletedProjects) console.log(`[server] Account project cleanup deleted ${result.deletedProjects} inactive projects and freed ${result.freedBytes} bytes`);
			} catch (error) {
				console.error("[server] Account project cleanup failed:", error);
			}
		}, 6 * 60 * 60 * 1000);
		projectCleanupTimer.unref();
	}
	const resourceCache = new CqResourceCache(config.resource_cache, resourceIndex);
	if (resourceCache.enabled) {
		await resourceCache.initialize();
		const deleted = await resourceCache.cleanupExpired();
		console.log(`[server] Resource cache startup cleanup: ${deleted} files removed`);
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
	app.set("trust proxy", trustProxy ? trustProxyPolicy : false);
	app.use((req, res, next) => {
		if (!req.url.startsWith("/") || req.url.startsWith("//")) {
			res.status(400).type("text/plain").send("Bad Request");
			return;
		}
		next();
	});
	app.use(setSecurityHeaders);
	app.use((req, res, next) => {
		const hstsSeconds = Math.max(0, Math.min(63_072_000, Number(config.server?.hsts_max_age_seconds || 0)));
		if (hstsSeconds > 0 && getExternalProtocol(req, trustProxyPolicy) === "https") {
			res.setHeader("Strict-Transport-Security", `max-age=${Math.floor(hstsSeconds)}`);
		}
		next();
	});
	app.use((req, res, next) => {
		const host = getExternalHost(req, trustProxyPolicy);
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
		const block = activeSecurityBlockForIp(getClientIp(req, trustProxyPolicy));
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
	const resourceBodyLimitMb = resourceCache.enabled ? Number(config.resource_cache?.max_file_mb || 12) + 2 : 0;
	const rawLimitMb = Math.max(10, Number(config.app.max_upload_mb || 5) * 2, accountBodyLimitMb, resourceBodyLimitMb);
	app.use(express.raw({ type: "*/*", limit: `${rawLimitMb}mb` }));
	accountService?.register(app);

	app.get("/healthz", (_req, res) => {
		res.status(200);
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.send(JSON.stringify({ ok: true, timestamp: new Date().toISOString(), version: String(process.env.LORANA_BUILD_VERSION || ""), commit: String(process.env.LORANA_BUILD_COMMIT || "") }));
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
			record.clientIp !== getClientIp(req, trustProxyPolicy)
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

	function sendBrandingAsset(res, asset: BrandingAsset | null) {
		if (!asset) {
			res.status(404).type("text/plain").send("Not Found");
			return;
		}
		res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
		res.setHeader("X-Content-Type-Options", "nosniff");
		if (asset.contentType === "image/svg+xml") {
			res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
		}
		res.type(asset.contentType).sendFile(asset.filePath);
	}

	app.get("/branding/logo", (_req, res) => sendBrandingAsset(res, brandingLogo));
	app.get("/favicon.ico", (_req, res) => sendBrandingAsset(res, brandingFavicon));

	app.get("/api/editor/config", (_req, res) => {
		res.status(200);
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.send(JSON.stringify({
			defaultMode: config.editor?.default_mode === "legacy" ? "legacy" : "story",
			storyModeEnabled: config.editor?.enable_story_mode !== false,
			siteTitle: String(config.branding?.site_title || "Lorana Tales").trim() || "Lorana Tales",
			showSiteTitle: config.branding?.show_site_title !== false,
			logoUrl: brandingLogo ? `/branding/logo?v=${brandingLogo.version}` : "",
			faviconUrl: brandingFavicon ? `/favicon.ico?v=${brandingFavicon.version}` : "",
			communityNotice: String(config.branding?.community_notice || "").trim(),
		}));
	});

	app.post("/api/editor/resources", async (req, res) => {
		if (!resourceCache.enabled) {
			res.status(503).type("application/json").send(JSON.stringify({ error: "服务端资源存储未开启" }));
			return;
		}
		if (!takeEditorFetchQuota("asset", getClientIp(req, trustProxyPolicy), 20)) {
			res.status(429).type("application/json").send(JSON.stringify({ error: "resource_upload_rate_limited" }));
			return;
		}
		const kind = String(req.headers["x-resource-kind"] || "").toLowerCase();
		if (kind !== "image" && kind !== "audio") {
			res.status(400).type("application/json").send(JSON.stringify({ error: "只允许图片或语音" }));
			return;
		}
		const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
		try {
			const result = await resourceCache.cacheUploadedResource(body, kind, String(req.headers["content-type"] || ""));
			res.status(200).type("application/json").send(JSON.stringify({
				id: result.resourceId,
				url: resourceCache.resourceUrl(result.resourceId),
				reused: result.reused,
			}));
		} catch (error) {
			res.status(422).type("application/json").send(JSON.stringify({ error: error instanceof Error ? error.message : "资源处理失败" }));
		}
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

	app.get("/api/editor/cq-face/:faceId", async (req, res) => {
		const faceId = String(req.params.faceId || "");
		const configuredRoot = String(config.resource_cache.cq_face_path || "").trim();
		if (!/^\d{1,4}$/.test(faceId) || !configuredRoot) {
			res.status(404).type("text/plain").send("Not Found");
			return;
		}
		const root = path.resolve(configuredRoot);
		const candidates = [
			path.join(root, "faces", faceId, "apng", `${faceId}.png`),
			path.join(root, faceId, "apng", `${faceId}.png`),
			path.join(root, `${faceId}.png`),
		];
		for (const candidate of candidates) {
			try {
				const resolved = path.resolve(candidate);
				if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) continue;
				const body = await fs.promises.readFile(resolved);
				res.status(200).setHeader("Cache-Control", "public, max-age=31536000, immutable");
				res.type("image/png").send(body);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[server] CQ face read failed:", error);
			}
		}
		res.status(404).type("text/plain").send("Not Found");
	});

	type AvatarCandidate = { platform: "discord" | "kook" | "qq"; imageUrl: string; names: string[] };
	const avatarName = (value: unknown) => String(value || "").trim().toLocaleLowerCase().replace(/[\s_\-·「」『』]/g, "");
	async function fetchPlatformAvatar(platform: "discord" | "kook", userId: string): Promise<AvatarCandidate> {
		const providers = config.avatar_providers;
		const enabled = platform === "discord" ? providers.discord_enabled : providers.kook_enabled;
		const token = String(platform === "discord" ? providers.discord_bot_token : providers.kook_bot_token || "").trim();
		if (!enabled || !token) throw new Error(`${platform} avatar provider disabled`);
		const url = platform === "discord"
			? `https://discord.com/api/v10/users/${encodeURIComponent(userId)}`
			: `https://www.kookapp.cn/api/v3/user/view?user_id=${encodeURIComponent(userId)}`;
		const response = await fetch(url, { headers: { Authorization: `Bot ${token}`, "User-Agent": "Lorana-Tales/1.0" }, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error(`${platform} user lookup failed (${response.status})`);
		const payload: any = await response.json();
		const user = platform === "discord" ? payload : payload?.data;
		if (!user || String(user.id || "") !== userId) throw new Error(`${platform} user id mismatch`);
		if (platform === "discord") {
			const avatarHash = String(user.avatar || "");
			const defaultIndex = Number((BigInt(userId) >> 22n) % 6n);
			return { platform, imageUrl: avatarHash ? `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.webp?size=256` : `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`, names: [user.global_name, user.username].filter(Boolean).map(String) };
		}
		if (!user.avatar) throw new Error("kook avatar missing");
		return { platform, imageUrl: String(user.avatar), names: [user.nickname, user.username].filter(Boolean).map(String) };
	}
	async function resolveUserAvatar(userId: string, expectedName: string): Promise<AvatarCandidate> {
		const length = userId.length;
		const order: Array<"discord" | "kook" | "qq"> = length >= 16 ? ["discord"] : length >= 13 ? ["discord", "kook"] : length >= 9 ? ["kook", "qq"] : ["qq"];
		const resolved: AvatarCandidate[] = [];
		for (const platform of order) {
			try {
				resolved.push(platform === "qq" ? { platform, imageUrl: `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(userId)}&s=100`, names: [] } : await fetchPlatformAvatar(platform, userId));
			} catch { /* Try the next configured provider. */ }
		}
		if (!resolved.length) throw new Error("No avatar provider resolved this identity");
		const expected = avatarName(expectedName);
		const nameMatch = expected && resolved.find((item) => item.names.some((name) => avatarName(name) === expected || avatarName(name).includes(expected) || expected.includes(avatarName(name))));
		return nameMatch || (expected ? resolved.find((item) => item.platform === "qq") : undefined) || resolved[0];
	}
	async function resolveAvatarCandidates(userId: string, expectedName: string, refresh = false) {
		const refreshSuffix = refresh ? `&t=${Date.now()}` : "";
		const probes: Array<Promise<AvatarCandidate>> = [Promise.resolve({ platform: "qq" as const, imageUrl: `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(userId)}&s=100${refreshSuffix}`, names: [] })];
		if (config.avatar_providers.discord_enabled && config.avatar_providers.discord_bot_token) probes.push(fetchPlatformAvatar("discord", userId));
		if (config.avatar_providers.kook_enabled && config.avatar_providers.kook_bot_token) probes.push(fetchPlatformAvatar("kook", userId));
		const settled = await Promise.allSettled(probes);
		const expected = avatarName(expectedName);
		const candidates = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
		const weighted = candidates.map((candidate) => ({ candidate, nameMatch: !!expected && candidate.names.some((name) => avatarName(name) === expected || avatarName(name).includes(expected) || expected.includes(avatarName(name))) }))
			.sort((left, right) => Number(right.nameMatch) - Number(left.nameMatch) || Number(right.candidate.platform === "qq") - Number(left.candidate.platform === "qq"));
		const result: Array<{ platform: AvatarCandidate["platform"]; url: string; names: string[]; nameMatch: boolean }> = [];
		for (const item of weighted) {
			try {
				const resourceId = await resourceCache.cacheRemoteImage(item.candidate.imageUrl);
				result.push({ platform: item.candidate.platform, url: resourceCache.resourceUrl(resourceId), names: item.candidate.names, nameMatch: item.nameMatch });
			} catch { /* A platform response without a usable image is not a candidate. */ }
		}
		return result;
	}

	app.get("/api/editor/avatar/candidates/:id", async (req, res) => {
		const userId = String(req.params.id || "");
		if (!/^\d{5,20}$/.test(userId)) { res.status(400).type("application/json").send(JSON.stringify({ error: "invalid_platform_user_id" })); return; }
		if (!takeEditorFetchQuota("avatar-candidates", getClientIp(req, trustProxyPolicy), 30)) { res.status(429).type("application/json").send(JSON.stringify({ error: "avatar_fetch_rate_limited" })); return; }
		try {
			const candidates = await resolveAvatarCandidates(userId, String(req.query.name || ""), req.query.refresh != null);
			res.status(200).set({ "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }).send(JSON.stringify({ candidates }));
		} catch (error) {
			console.error("[server] avatar candidates failed:", error instanceof Error ? error.message : error);
			res.status(200).type("application/json").send(JSON.stringify({ candidates: [] }));
		}
	});

	app.get("/api/editor/avatar/user/:id", async (req, res) => {
		const userId = String(req.params.id || "");
		if (!/^\d{5,20}$/.test(userId)) { res.status(400).type("text/plain").send("Invalid platform user id"); return; }
		if (!takeEditorFetchQuota("avatar", getClientIp(req, trustProxyPolicy), 120)) { res.status(429).type("text/plain").send("Avatar fetch rate limited"); return; }
		try {
			const candidate = await resolveUserAvatar(userId, String(req.query.name || ""));
			const resourceId = await resourceCache.cacheRemoteImage(candidate.imageUrl);
			res.setHeader("Cache-Control", req.query.refresh == null ? "public, max-age=86400" : "no-store");
			res.setHeader("X-Avatar-Provider", candidate.platform);
			res.redirect(302, resourceCache.resourceUrl(resourceId));
		} catch (error) {
			console.error("[server] platform avatar resolution failed:", error instanceof Error ? error.message : error);
			res.status(502).type("text/plain").send("Avatar unavailable");
		}
	});

	app.get("/api/editor/avatar/qq/:uin", async (req, res) => {
		const uin = String(req.params.uin || "");
		if (!/^\d{5,20}$/.test(uin)) {
			res.status(400).type("text/plain").send("Invalid user id");
			return;
		}
		if (!takeEditorFetchQuota("avatar", getClientIp(req, trustProxyPolicy), 120)) {
			res.status(429).type("text/plain").send("Avatar fetch rate limited");
			return;
		}
		try {
			const refreshSuffix = req.query.refresh == null ? "" : `&t=${Date.now()}`;
			const resourceId = await resourceCache.cacheRemoteImage(`https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100${refreshSuffix}`);
			res.setHeader("Cache-Control", req.query.refresh == null ? "public, max-age=86400" : "no-store");
			res.setHeader("X-Avatar-Provider", "qq");
			res.redirect(302, resourceCache.resourceUrl(resourceId));
		} catch (error) {
			console.error("[server] QQ avatar cache failed:", error);
			res.status(502).type("text/plain").send("Avatar unavailable");
		}
	});

	app.post("/api/editor/assets/fetch", async (req, res) => {
		const clientIp = getClientIp(req, trustProxyPolicy);
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
		for (const route of ["/story", "/story/", "/legacy", "/legacy/", "/play", "/play/"]) {
			app.get(route, (_req, res) => res.sendFile(path.join(staticDir, "index.html")));
		}
	}

	createAdminRouter({
		app,
		store,
		password: adminPassword,
		adminFilePath: path.resolve(staticDir, "admin.html"),
		trustProxy: trustProxyPolicy,
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

	app.get(["/docs", "/docs/"], (_req, res) => {
		const docsFile = path.resolve(staticDir, "docs.html");
		if (fs.existsSync(docsFile)) {
			res.setHeader("Cache-Control", "no-store");
			return res.sendFile(docsFile);
		}
		res.status(404).type("text/plain").send("Docs have not been built yet");
	});

	app.all(/^\/(?:api\/dice|dice\/api)\//, async (req, res) => {
		try {
			const protocol = getExternalProtocol(req, trustProxyPolicy);
			const host = getExternalHost(req, trustProxyPolicy);
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
			headers.set("x-scardice-client-ip", getClientIp(req, trustProxyPolicy));

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

	// Keep parser and route failures on a small, stable response boundary. Express'
	// default handler emits HTML and can include implementation details outside of
	// production mode, which is unsuitable for a public JSON API.
	app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
		if (res.headersSent) {
			next(error);
			return;
		}
		const candidate = error as { status?: unknown; statusCode?: unknown; type?: unknown };
		const reportedStatus = Number(candidate?.status || candidate?.statusCode || 0);
		const tooLarge = candidate?.type === "entity.too.large" || reportedStatus === 413;
		const invalidRequest = error instanceof SyntaxError || reportedStatus === 400;
		const status = tooLarge ? 413 : invalidRequest ? 400 : 500;
		const apiRequest = req.path.startsWith("/api/") || req.path.startsWith("/dice/api/") || req.path.startsWith("/admin/api/");
		if (status === 500) console.error("[server] Unhandled request error:", error);
		res.status(status).setHeader("Cache-Control", "no-store");
		if (apiRequest) {
			res.type("application/json").send(JSON.stringify({ error: tooLarge ? "payload_too_large" : invalidRequest ? "invalid_request" : "internal_error" }));
			return;
		}
		res.type("text/plain").send(tooLarge ? "Payload Too Large" : invalidRequest ? "Bad Request" : "Internal Server Error");
	});

	const { host, port } = config.server;
	const server = app.listen(port, host, () => {
		server.ref();
		console.log(
			`[server] Lorana Tales Backend running at http://${host}:${port}`,
		);
		console.log(
			`[server] Database: ${postgres ? "PostgreSQL" : path.resolve(config.database.sqlite_path)}`,
		);
		console.log(`[server] Frontend URL: ${config.app.frontend_url || "auto"}`);
		console.log(
			`[server] Log retention: ${config.app.log_retention_days} days`,
		);
		console.log(`[server] Max upload: ${config.app.max_upload_mb} MB`);
		console.log(
			`[server] Resource cache: ${resourceCache.enabled ? `enabled (${config.resource_cache.retention_days} days, ${config.resource_cache.path})` : "disabled"}`,
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
		} else if (!accountMode) {
			console.log(`[admin] Admin password loaded from configuration`);
		}
	});
	server.on("clientError", (_error, socket) => {
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
	});
	// Keep the socket referenced once binding has completed. The CLI also owns
	// the returned runtime until this server closes.
	return { app, server, store, config, accountService, resourceCache };
}

const directRunPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (directRunPath && fileURLToPath(import.meta.url) === directRunPath) {
	startServer().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}

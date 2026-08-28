import crypto from "node:crypto";
import net from "node:net";
import type { Express, Request, Response } from "express";
import { getClientIp, isTrustedProxyRequest, type TrustedProxyPolicy } from "../server/client-ip.js";
import { AccountStore, type AccountUser, isValidUsername, normalizeEmail } from "./account-store.js";
import { CaptchaService } from "./captcha.js";
import { AccountMailer } from "./mailer.js";
import type { LogStore } from "../storage/log-store.js";

const SESSION_COOKIE = "scardice_account_session";
const DEVICE_COOKIE = "scardice_account_device";
const CSRF_COOKIE = "scardice_account_csrf";

type JsonObject = Record<string, unknown>;

function readJson(req: Request): JsonObject {
	const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : String(req.body || "");
	if (!raw.trim()) return {};
	const value = JSON.parse(raw);
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function json(res: Response, status: number, value: unknown) {
	res.status(status).set({ "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }).send(JSON.stringify(value));
}

function cookies(req: Request) {
	const result = new Map<string, string>();
	for (const item of String(req.headers.cookie || "").split(";")) {
		const index = item.indexOf("=");
		if (index < 1) continue;
		try { result.set(item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim())); }
		catch { result.set(item.slice(0, index).trim(), item.slice(index + 1).trim()); }
	}
	return result;
}

function ipv6Prefix(ip: string) {
	const parts = ip.split(":");
	const expanded: string[] = [];
	const empty = parts.indexOf("");
	if (empty >= 0) {
		const missing = 8 - (parts.length - 1);
		for (let i = 0; i < empty; i++) expanded.push(parts[i] || "0");
		for (let i = 0; i < missing; i++) expanded.push("0");
		for (let i = empty + 1; i < parts.length; i++) expanded.push(parts[i] || "0");
	} else expanded.push(...parts);
	return `${expanded.slice(0, 4).map((part) => parseInt(part || "0", 16).toString(16)).join(":")}::/64`;
}

export function networkPrefix(ip: string) {
	const clean = String(ip || "unknown").replace(/^::ffff:/, "").split("%")[0];
	if (net.isIP(clean) === 4) return `${clean.split(".").slice(0, 3).join(".")}.0/24`;
	if (net.isIP(clean) === 6) return ipv6Prefix(clean);
	return "unknown";
}

function validEmail(value: string) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function validPassword(value: string) {
	return value.length >= 10 && value.length <= 256;
}

function validNickname(value: string) {
	return value.trim().length >= 1 && value.trim().length <= 80;
}

function validAvatarUrl(value: string) {
	if (!value) return true;
	if (/^\/api\/editor\/resource\/[A-Za-z0-9._-]+$/.test(value)) return true;
	try { return new URL(value).protocol === "https:"; }
	catch { return false; }
}

function sanitizeEffectPreset(value: JsonObject) {
	const name = String(value.name || "").trim().slice(0, 60);
	const source = value.config && typeof value.config === "object" && !Array.isArray(value.config) ? value.config as JsonObject : {};
	const kind = String(value.kind || "screen");
	if (kind === "interaction") {
		const effects = new Set(["throw", "heart", "magic", "surprise", "impact", "bullet", "blade"]);
		const reactions = new Set(["none", "bounce", "stagger", "faint", "shatter", "gray", "affection"]);
		const interactionEffect = String(source.interactionEffect || "throw");
		const reaction = String(source.reaction || "stagger");
		const emoji = String(source.emoji || "").trim().slice(0, 16);
		if (!name || !effects.has(interactionEffect) || !reactions.has(reaction)) return null;
		return { name, kind: "interaction", folderId: String(value.folderId || "").slice(0, 80), config: { interactionEffect, reaction, emoji } };
	}
	const effects = new Set(["none", "shake-light", "shake-heavy", "glow", "warm-glow", "cold-flash", "flash", "flicker", "damage", "heartbeat", "blackout", "dream", "vignette", "ripple", "curtain", "chromatic", "zoom-focus"]);
	const colors = new Set(["auto", "neutral", "red", "orange", "gold", "green", "cyan", "blue", "purple", "pink"]);
	const screenEffect = String(source.screenEffect || "none"); const color = String(source.color || "auto");
	if (!name || !effects.has(screenEffect) || !colors.has(color)) return null;
	return { name, kind: "screen", folderId: String(value.folderId || "").slice(0, 80), config: { screenEffect, color, durationMs: Math.min(10000, Math.max(120, Math.round(Number(source.durationMs) || 900))), speedPercent: Math.min(400, Math.max(25, Math.round(Number(source.speedPercent) || 100))), repeat: Math.min(12, Math.max(1, Math.round(Number(source.repeat) || 1))) } };
}

function validateSspZip(value: Buffer, config): "project_invalid" | "project_too_large" | "asset_too_large" | "" {
	const maxProject = Number(config.max_project_mb || 25) * 1024 * 1024;
	const maxAsset = Number(config.max_asset_mb || 12) * 1024 * 1024;
	if (value.length > maxProject || value.length < 22) return value.length > maxProject ? "project_too_large" : "project_invalid";
	let eocd = -1;
	for (let index = value.length - 22, minimum = Math.max(0, value.length - 65557); index >= minimum; index -= 1) if (value.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
	if (eocd < 0) return "project_invalid";
	const entries = value.readUInt16LE(eocd + 10), centralSize = value.readUInt32LE(eocd + 12), centralOffset = value.readUInt32LE(eocd + 16);
	if (!entries || entries > 1024 || centralOffset + centralSize > value.length) return "project_invalid";
	let cursor = centralOffset, totalUncompressed = 0;
	for (let count = 0; count < entries; count += 1) {
		if (cursor + 46 > value.length || value.readUInt32LE(cursor) !== 0x02014b50) return "project_invalid";
		const flags = value.readUInt16LE(cursor + 8), compression = value.readUInt16LE(cursor + 10), compressed = value.readUInt32LE(cursor + 20), uncompressed = value.readUInt32LE(cursor + 24);
		const nameLength = value.readUInt16LE(cursor + 28), extraLength = value.readUInt16LE(cursor + 30), commentLength = value.readUInt16LE(cursor + 32);
		const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;
		if (!nameLength || nameLength > 240 || nextCursor > value.length || nextCursor > centralOffset + centralSize) return "project_invalid";
		const name = value.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf-8");
		if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) return "project_invalid";
		if (flags & 1 || ![0, 8].includes(compression) || (uncompressed > 0 && uncompressed / Math.max(1, compressed) > 100)) return "project_invalid";
		if (name.startsWith("assets/") && uncompressed > maxAsset) return "asset_too_large";
		totalUncompressed += uncompressed;
		if (totalUncompressed > Math.max(maxProject * 2, 64 * 1024 * 1024)) return "project_too_large";
		cursor = nextCursor;
	}
	if (cursor !== centralOffset + centralSize) return "project_invalid";
	return "";
}

function validateProjectDocument(value: unknown, config): "project_invalid" | "project_too_large" | "asset_too_large" | "" {
	if (Buffer.isBuffer(value)) return validateSspZip(value, config);
	const encoded = Buffer.byteLength(JSON.stringify(value ?? null));
	if (encoded > Number(config.max_project_mb || 25) * 1024 * 1024) return "project_too_large";
	const assets = value && typeof value === "object" && Array.isArray((value as JsonObject).assets) ? (value as JsonObject).assets as unknown[] : [];
	const maxAssetBytes = Number(config.max_asset_mb || 12) * 1024 * 1024;
	for (const entry of assets) {
		if (!Array.isArray(entry) || typeof entry[1] !== "string") continue;
		if (Math.floor(entry[1].length * 0.75) > maxAssetBytes) return "asset_too_large";
	}
	return "";
}

const SSP_CONTENT_TYPE = "application/vnd.lorana-tales.story+zip";

function projectRequest(req: Request): { document: unknown; meta: JsonObject } {
	if (String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== SSP_CONTENT_TYPE) {
		const body = readJson(req);
		return { document: body.document, meta: body };
	}
	const document = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
	if (document.length < 4 || document[0] !== 0x50 || document[1] !== 0x4b) throw new Error("project_invalid");
	const encoded = String(req.headers["x-lorana-project-meta"] || "");
	if (!encoded || encoded.length > 8192) throw new Error("project_invalid");
	const meta = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("project_invalid");
	return { document, meta };
}

function projectSummary(project: Record<string, unknown> | null) {
	if (!project) return null;
	const { document: _document, owner: _owner, shareExpiryMode: _shareExpiryMode, shareExpiresAt: _shareExpiresAt, lastActivityAt: _lastActivityAt, ...summary } = project;
	return summary;
}

export function publicProjectPayload(project: Record<string, unknown>) {
	return { ...projectSummary(project), document: project.document };
}

function sendProject(res: Response, project: Record<string, unknown> | null) {
	if (!project) { json(res, 404, { error: "project_not_found" }); return; }
	const meta = projectSummary(project);
	if (!Buffer.isBuffer(project.document)) {
		// Shared legacy JSON projects used to expose the joined owner row here,
		// including email, account status and policy fields. Keep the document
		// payload but apply the same public metadata allow-list as SSP responses.
		json(res, 200, publicProjectPayload(project));
		return;
	}
	res.status(200).set({
		"Cache-Control": "no-store",
		"Content-Type": SSP_CONTENT_TYPE,
		"Content-Length": String(project.document.length),
		"X-Lorana-Project-Meta": Buffer.from(JSON.stringify(meta), "utf-8").toString("base64url"),
	}).send(project.document);
}

export class AccountService {
	readonly store: AccountStore;
	readonly config;
	readonly captcha: CaptchaService;
	readonly mailer: AccountMailer | null;
	readonly trustProxy: TrustedProxyPolicy;
	readonly logStore: LogStore | null;
	readonly branding: { siteTitle: string; logoUrl: string };
	private captchaChallengeTimes = new Map<string, number[]>();
	private passwordAttemptTimes = new Map<string, number[]>();

	constructor(store: AccountStore, config, trustProxy: TrustedProxyPolicy = false, logStore: LogStore | null = null, branding = { siteTitle: "Lorana Tales", logoUrl: "" }) {
		this.store = store;
		this.config = config;
		this.captcha = new CaptchaService(config);
		this.trustProxy = trustProxy;
		this.logStore = logStore;
		this.branding = branding;
		this.mailer = config.smtp?.host && config.smtp?.from ? new AccountMailer(config.smtp) : null;
	}

	async ensureInitialAdmin() {
		const adminGroup = String(this.config.admin_group || "admin");
		this.store.normalizeAdminGroup(adminGroup, String(this.config.default_group || "default"));
		if (this.store.activeAdminCount() > 0) return;
		const username = String(this.config.initial_admin_username || "").trim();
		const password = String(this.config.initial_admin_password || "");
		if (!username || username.length > 80 || !validPassword(password)) {
			throw new Error("accounts.initial_admin_username and a 10+ character accounts.initial_admin_password are required when no administrator exists");
		}
		const configuredEmail = normalizeEmail(this.config.initial_admin_email);
		const email = validEmail(configuredEmail) ? configuredEmail : `${crypto.createHash("sha256").update(username).digest("hex").slice(0, 16)}@bootstrap.invalid`;
		const existing = this.store.getUserByEmail(email);
		if (existing) {
			this.store.updateUser(existing.id, { username, nickname: username, role: "admin", group: adminGroup });
			await this.store.updatePassword(existing.id, password, true);
			this.store.audit("system", "account.bootstrap-admin", existing.id);
			return;
		}
		const user = await this.store.createUser({ email, password, username, nickname: username, role: "admin", group: adminGroup, mustChangePassword: true });
		this.store.audit("system", "account.bootstrap-admin", user.id);
	}

	private secure(req: Request) {
		const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
		return req.secure || (isTrustedProxyRequest(req, this.trustProxy) && forwarded === "https");
	}

	private sameSite(): "Strict" | "Lax" | "None" {
		const value = String(this.config.cookie_same_site || "auto").toLowerCase();
		return value === "none" ? "None" : value === "strict" ? "Strict" : "Lax";
	}

	private cookie(req: Request, name: string, value: string, maxAge: number, httpOnly = true) {
		const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}`, `SameSite=${this.sameSite()}`];
		if (httpOnly) parts.push("HttpOnly");
		if (this.secure(req) || this.sameSite() === "None") parts.push("Secure");
		return parts.join("; ");
	}

	private userAgent(req: Request) { return String(req.headers["user-agent"] || "unknown").slice(0, 500); }
	private ip(req: Request) { return getClientIp(req, this.trustProxy); }
	private prefix(req: Request) { return networkPrefix(this.ip(req)); }

	getSession(req: Request) {
		const token = cookies(req).get(SESSION_COOKIE) || "";
		const session = this.store.getSession(token);
		if (!session) return null;
		if (!this.store.sessionMatchesContext(session, this.prefix(req), this.userAgent(req))) {
			this.store.revokeSession(token);
			return null;
		}
		const user = this.store.refreshExpiredBan(session.user);
		if (user.status !== "active") return null;
		return { ...session, user };
	}

	isAdmin(req: Request) { const user = this.getSession(req)?.user; return user?.role === "admin" && user.group === String(this.config.admin_group || "admin") && !user.mustChangePassword; }

	private requireSession(req: Request, res: Response, mutate = false, allowInitialChange = false) {
		const session = this.getSession(req);
		if (!session) { json(res, 401, { error: "authentication_required" }); return null; }
		if (session.user.mustChangePassword && !allowInitialChange) { json(res, 428, { error: "credentials_change_required" }); return null; }
		if (mutate && !this.store.verifyCsrf(session, String(req.headers["x-csrf-token"] || ""))) {
			json(res, 403, { error: "csrf_failed" }); return null;
		}
		return session;
	}

	private emailAllowed(email: string) {
		const domains = Array.isArray(this.config.allowed_email_domains) ? this.config.allowed_email_domains : [];
		return !domains.length || domains.map((v) => String(v).toLowerCase()).includes(email.split("@")[1] || "");
	}

	private setAuthCookies(req: Request, res: Response, session, deviceToken: string) {
		const ttl = session.expiresAt - Date.now();
		res.append("Set-Cookie", this.cookie(req, SESSION_COOKIE, session.token, ttl, true));
		res.append("Set-Cookie", this.cookie(req, CSRF_COOKIE, session.csrfToken, ttl, false));
		if (deviceToken) res.append("Set-Cookie", this.cookie(req, DEVICE_COOKIE, deviceToken, Number(this.config.trusted_device_days || 90) * 86400000, true));
	}

	private clearAuthCookies(req: Request, res: Response) {
		for (const [name, httpOnly] of [[SESSION_COOKIE, true], [DEVICE_COOKIE, true], [CSRF_COOKIE, false]] as const) {
			res.append("Set-Cookie", this.cookie(req, name, "", 0, httpOnly));
		}
	}

	private clearSessionCookies(req: Request, res: Response) {
		// Signing out ends only the current authenticated session. The separate,
		// long-lived trusted-device cookie must survive so a later password login
		// from the same browser and network prefix does not require email again.
		for (const [name, httpOnly] of [[SESSION_COOKIE, true], [CSRF_COOKIE, false]] as const) {
			res.append("Set-Cookie", this.cookie(req, name, "", 0, httpOnly));
		}
	}

	private publicUser(user: AccountUser) {
		return { ...user, canAdmin: user.role === "admin" && user.group === String(this.config.admin_group || "admin") && !user.mustChangePassword, banReason: user.status === "banned" ? user.banReason : "", projectCount: this.store.projectCount(user.id) };
	}

	private storagePolicy(user: Pick<AccountUser, "id" | "group" | "quotaMbOverride" | "retentionDaysOverride">) {
		const groups = this.config.storage_groups && typeof this.config.storage_groups === "object" ? this.config.storage_groups : {};
		const fallbackName = String(this.config.default_group || "default");
		const group = String(user.group || fallbackName);
		const raw = groups[group] || groups[fallbackName] || { quota_mb: 256, max_projects: 100, retention_days: 180 };
		const groupRetentionDays = Math.max(0, Math.floor(Number(raw.retention_days ?? 180)));
		return {
			group,
			quotaBytes: Math.max(1, user.quotaMbOverride ?? Number(raw.quota_mb || 256)) * 1024 * 1024,
			quotaSource: user.quotaMbOverride === null ? "group" : "user",
			maxProjects: Math.max(1, Math.floor(Number(raw.max_projects || 100))),
			retentionDays: user.retentionDaysOverride === null ? groupRetentionDays : user.retentionDaysOverride,
			retentionSource: user.retentionDaysOverride === null ? "group" : "user",
		};
	}

	private sharedProjectIsActive(project: Record<string, unknown>) {
		const mode = String(project.shareExpiryMode || "project");
		const owner = project.owner as AccountUser | undefined;
		if (!owner) return false;
		const days = this.storagePolicy(owner).retentionDays;
		const lastActivity = Date.parse(String(project.lastActivityAt || project.updatedAt || ""));
		if (!Number.isFinite(lastActivity)) return false;
		const projectExpires = days > 0 ? lastActivity + days * 86400000 : Number.POSITIVE_INFINITY;
		if (projectExpires <= Date.now()) return false;
		if (mode === "project") return days > 0;
		if (mode !== "fixed") return false;
		const shareExpires = Date.parse(String(project.shareExpiresAt || ""));
		return Number.isFinite(shareExpires) && shareExpires > Date.now();
	}

	cleanupInactiveProjects() {
		return this.store.cleanupInactiveProjects((user) => this.storagePolicy(user).retentionDays);
	}

	storageUsage(user: AccountUser) {
		const policy = this.storagePolicy(user);
		const usedBytes = this.store.projectStorageBytes(user.id);
		const projectCount = this.store.projectCount(user.id);
		return { ...policy, usedBytes, remainingBytes: Math.max(0, policy.quotaBytes - usedBytes), projectCount };
	}

	private riskNeedsCaptcha(userId: string, req: Request) {
		const windowMs = Math.max(1, Number(this.config.risk_cooldown_minutes || 15)) * 60000;
		return this.store.recentRiskCount(userId, this.prefix(req), Date.now() - windowMs) >= 5;
	}

	private requireRiskClearance(userId: string, scope: string, req: Request, res: Response) {
		if (!this.riskNeedsCaptcha(userId, req)) return true;
		const subject = `${userId}:${this.prefix(req)}`;
		if (this.captcha.isTrusted(subject)) return true;
		const token = String(req.headers["x-captcha-clearance"] || "");
		if (this.captcha.consumeClearance(token, subject, scope)) return true;
		json(res, 428, { error: "captcha_required", scope, message: "检测到异常行为，请先完成人机验证后重试。" });
		return false;
	}

	private allowCaptchaChallenge(req: Request) {
		const key = this.prefix(req);
		const cutoff = Date.now() - 60000;
		const recent = (this.captchaChallengeTimes.get(key) || []).filter((value) => value >= cutoff);
		if (recent.length >= 20) return false;
		recent.push(Date.now());
		this.captchaChallengeTimes.set(key, recent);
		if (this.captchaChallengeTimes.size > 5000) this.captchaChallengeTimes.delete(this.captchaChallengeTimes.keys().next().value as string);
		return true;
	}

	private allowPasswordAttempt(req: Request) {
		const key = this.prefix(req);
		const cutoff = Date.now() - 60000;
		const recent = (this.passwordAttemptTimes.get(key) || []).filter((value) => value >= cutoff);
		const limit = Math.max(5, Math.min(120, Number(this.config.password_attempts_per_minute || 20)));
		if (recent.length >= limit) return false;
		recent.push(Date.now());
		this.passwordAttemptTimes.set(key, recent);
		if (this.passwordAttemptTimes.size > 5000) this.passwordAttemptTimes.delete(this.passwordAttemptTimes.keys().next().value as string);
		return true;
	}

	register(app: Express) {
		app.get("/api/account/config", (_req, res) => json(res, 200, {
			enabled: true,
			registrationEnabled: this.config.registration_enabled !== false,
			captchaProvider: String(this.config.captcha_provider || "image"),
			turnstileSiteKey: String(this.config.turnstile?.site_key || ""),
			hcaptchaSiteKey: String(this.config.hcaptcha?.site_key || ""),
		}));

		app.post("/api/account/captcha/challenge", async (req, res) => {
			if (!this.allowCaptchaChallenge(req)) { json(res, 429, { error: "captcha_rate_limited" }); return; }
			try { json(res, 200, await this.captcha.create()); }
			catch (error) { console.error("[accounts] captcha challenge failed", error); json(res, 500, { error: "captcha_unavailable" }); }
		});

		app.post("/api/account/captcha/verify", async (req, res) => {
			try {
				const body = readJson(req);
				const session = this.getSession(req);
				const scope = String(body.scope || "verification-send").slice(0, 80);
				const email = normalizeEmail(body.email);
				const account = scope === "verification-send" ? null : this.store.getUserByEmail(email);
				const subject = session ? `${session.user.id}:${this.prefix(req)}` : `${account?.id || email}:${this.prefix(req)}`;
				const valid = await this.captcha.verify({ id: String(body.id || ""), answer: String(body.answer || ""), payload: body.payload, token: String(body.token || ""), remoteIp: this.ip(req) });
				if (!valid) { json(res, 400, { error: "captcha_invalid" }); return; }
				json(res, 200, { clearance: this.captcha.issueClearance(subject, scope) });
			} catch (error) {
				if (error instanceof Error && error.message === "password_work_queue_busy") { json(res, 503, { error: "authentication_busy" }); return; }
				json(res, 400, { error: "invalid_request" });
			}
		});

		app.post("/api/account/verification/send", async (req, res) => {
			try {
				const body = readJson(req);
				const email = normalizeEmail(body.email);
				const purpose = ["register", "login", "reset-password", "change-email"].includes(String(body.purpose)) ? String(body.purpose) : "login";
				if (!validEmail(email) || !this.emailAllowed(email)) { json(res, 400, { error: "email_not_allowed" }); return; }
				if (purpose === "register" && this.config.registration_enabled === false) { json(res, 403, { error: "registration_disabled" }); return; }
				const currentSession = this.getSession(req);
				const subject = currentSession ? `${currentSession.user.id}:${this.prefix(req)}` : `${email}:${this.prefix(req)}`;
				if (!this.captcha.consumeClearance(String(body.captchaClearance || ""), subject, "verification-send")) { json(res, 428, { error: "captcha_required", scope: "verification-send" }); return; }
				if (!this.mailer) { json(res, 503, { error: "smtp_not_configured" }); return; }
				// Do not disclose whether a registration email already exists. Return the
				// same shaped success response after CAPTCHA without sending another mail.
				const targetAccount = this.store.getUserByEmail(email);
				if ((purpose === "register" && targetAccount) || (["login", "reset-password"].includes(purpose) && !targetAccount)) {
					json(res, 200, { id: crypto.randomUUID(), resendAfterSeconds: Number(this.config.email_code_resend_seconds || 60) });
					return;
				}
				const counts = this.store.verificationSendCounts(email, this.prefix(req), Date.now() - 3600000);
				const resendMs = Math.max(1, Number(this.config.email_code_resend_seconds || 60)) * 1000;
				if (this.store.lastVerificationAt(email, purpose) > Date.now() - resendMs) { json(res, 429, { error: "verification_resend_wait", retryAfterSeconds: Math.ceil(resendMs / 1000) }); return; }
				if (counts.emailCount >= Number(this.config.email_code_per_hour || 5) || counts.ipCount >= Number(this.config.ip_email_code_per_hour || 10)) {
					this.store.recordRisk("", this.prefix(req), "verification-rate-limit", email);
					json(res, 429, { error: "verification_rate_limited" }); return;
				}
				const code = crypto.randomInt(100000, 1000000).toString();
				const id = this.store.createVerificationCode(email, purpose, code, this.prefix(req), Number(this.config.email_code_ttl_minutes || 10));
				const account = targetAccount || currentSession?.user;
				await this.mailer.sendCode(email, code, purpose, {
					username: account?.username || String(body.username || ""),
					nickname: account?.nickname || String(body.nickname || ""),
					site_title: this.branding.siteTitle,
					logo_url: this.branding.logoUrl,
					expires_minutes: String(this.config.email_code_ttl_minutes || 10),
				});
				json(res, 200, { id, resendAfterSeconds: Number(this.config.email_code_resend_seconds || 60) });
			} catch (error) { console.error("[accounts] verification send failed", error); json(res, 400, { error: "verification_send_failed" }); }
		});

		app.post("/api/account/register", async (req, res) => {
			try {
				const body = readJson(req); const email = normalizeEmail(body.email); const password = String(body.password || ""); const username = String(body.username || "").trim(); const nickname = String(body.nickname || "").trim();
				if (this.config.registration_enabled === false) { json(res, 403, { error: "registration_disabled" }); return; }
				if (!validEmail(email) || !this.emailAllowed(email) || !validPassword(password) || !isValidUsername(username) || nickname.length < 1 || nickname.length > 80) { json(res, 400, { error: "invalid_registration" }); return; }
				if (!this.store.verifyCode(String(body.codeId || ""), email, "register", String(body.code || ""))) { json(res, 400, { error: "verification_invalid" }); return; }
				const user = await this.store.createUser({ email, password, username, nickname, group: String(this.config.default_group || "default") });
				this.store.audit(user.id, "account.register", user.id);
				const device = this.store.createTrustedDevice(user.id, this.prefix(req), this.userAgent(req), Number(this.config.trusted_device_days || 90));
				const session = this.store.createSession(user, { sessionDays: Number(this.config.session_days || 30), deviceToken: device, ipPrefix: this.prefix(req), userAgent: this.userAgent(req) });
				this.setAuthCookies(req, res, session, device); json(res, 201, { user: this.publicUser(user), csrfToken: session.csrfToken });
			} catch (error) { console.error("[accounts] register failed", error); json(res, 409, { error: "account_exists" }); }
		});

		app.post("/api/account/login", async (req, res) => {
			try {
				if (!this.allowPasswordAttempt(req)) { json(res, 429, { error: "login_rate_limited" }); return; }
				const body = readJson(req); const identity = String(body.email || body.username || "").trim(); const password = String(body.password || "");
				if (identity.length > 254 || password.length > 256) { json(res, 401, { error: "invalid_credentials" }); return; }
				const known = this.store.getUserByIdentity(identity);
				const user = await this.store.verifyPasswordIdentity(identity, password);
				if (!user) { this.store.recordRisk(known?.id || "", this.prefix(req), "login-failed", identity); json(res, 401, { error: "invalid_credentials" }); return; }
				if (!this.requireRiskClearance(user.id, "login", req, res)) return;
				const current = this.store.refreshExpiredBan(user);
				if (current.status === "banned") { json(res, 403, { error: "account_banned", reason: current.banReason, until: current.banUntil }); return; }
				if (current.status !== "active") { json(res, 403, { error: "account_disabled" }); return; }
				const existingDevice = cookies(req).get(DEVICE_COOKIE) || "";
				const trusted = this.store.isTrustedDevice(current.id, existingDevice, this.prefix(req), this.userAgent(req));
				if (!current.mustChangePassword && !trusted && !this.store.verifyCode(String(body.codeId || ""), current.email, "login", String(body.code || ""))) {
					json(res, 428, { error: "email_verification_required", email: current.email }); return;
				}
				const device = trusted ? existingDevice : this.store.createTrustedDevice(current.id, this.prefix(req), this.userAgent(req), Number(this.config.trusted_device_days || 90));
				const session = this.store.createSession(current, { sessionDays: Number(this.config.session_days || 30), deviceToken: device, ipPrefix: this.prefix(req), userAgent: this.userAgent(req) });
				this.setAuthCookies(req, res, session, device); this.store.audit(current.id, "account.login", current.id);
				json(res, 200, { user: this.publicUser(current), csrfToken: session.csrfToken });
			} catch { json(res, 400, { error: "invalid_request" }); }
		});

		app.post("/api/account/login/code", async (req, res) => {
			try {
				const body = readJson(req); const email = normalizeEmail(body.email); const user = this.store.getUserByEmail(email);
				if (!user) { json(res, 401, { error: "verification_invalid" }); return; }
				const codeId = String(body.codeId || ""); const code = String(body.code || "");
				if (!this.store.verifyCode(codeId, email, "login", code, false)) { json(res, 401, { error: "verification_invalid" }); return; }
				if (!this.requireRiskClearance(user.id, "login-code", req, res)) return;
				if (!this.store.verifyCode(codeId, email, "login", code)) { json(res, 401, { error: "verification_invalid" }); return; }
				const current = this.store.refreshExpiredBan(user);
				if (current.status === "banned") { json(res, 403, { error: "account_banned", reason: current.banReason, until: current.banUntil }); return; }
				if (current.status !== "active") { json(res, 403, { error: "account_disabled" }); return; }
				const device = this.store.createTrustedDevice(current.id, this.prefix(req), this.userAgent(req), Number(this.config.trusted_device_days || 90));
				const session = this.store.createSession(current, { sessionDays: Number(this.config.session_days || 30), deviceToken: device, ipPrefix: this.prefix(req), userAgent: this.userAgent(req) });
				this.setAuthCookies(req, res, session, device); this.store.audit(current.id, "account.login-code", current.id);
				json(res, 200, { user: this.publicUser(current), csrfToken: session.csrfToken });
			} catch { json(res, 400, { error: "invalid_request" }); }
		});

		app.get("/api/account/me", (req, res) => {
			const session = this.getSession(req); json(res, 200, session ? { authenticated: true, user: this.publicUser(session.user), storage: this.storageUsage(session.user) } : { authenticated: false });
		});

		app.patch("/api/account/onboarding", (req, res) => {
			const session = this.requireSession(req, res, true, true); if (!session) return;
			try {
				const body = readJson(req);
				const user = this.store.markOnboarding(session.user.id, {
					tutorialPromptSeen: body.tutorialPromptSeen === true,
					manualPlaybackHintSeen: body.manualPlaybackHintSeen === true,
					tutorialPlaybackCoachSeen: body.tutorialPlaybackCoachSeen === true,
				});
				json(res, user ? 200 : 404, user ? { user: this.publicUser(user) } : { error: "account_not_found" });
			} catch { json(res, 400, { error: "onboarding_invalid" }); }
		});

		app.patch("/api/account/profile", (req, res) => {
			const session = this.requireSession(req, res, true); if (!session || !this.requireRiskClearance(session.user.id, "profile-change", req, res)) return;
			try {
				const body = readJson(req); const nickname = String(body.nickname ?? session.user.nickname).trim(); const email = normalizeEmail(body.email ?? session.user.email); const avatarUrl = String(body.avatarUrl ?? session.user.avatarUrl).trim();
				if (!validNickname(nickname) || !validEmail(email) || !this.emailAllowed(email) || !validAvatarUrl(avatarUrl)) { json(res, 400, { error: "profile_invalid" }); return; }
				if (email !== session.user.email && !this.store.verifyCode(String(body.codeId || ""), email, "change-email", String(body.code || ""))) { json(res, 400, { error: "verification_invalid" }); return; }
				const duplicate = this.store.getUserByEmail(email); if (duplicate && duplicate.id !== session.user.id) { json(res, 409, { error: "account_exists" }); return; }
				const user = this.store.updateUser(session.user.id, { email, nickname, avatarUrl });
				this.store.audit(session.user.id, "account.profile-update", session.user.id, { emailChanged: email !== session.user.email, avatarChanged: avatarUrl !== session.user.avatarUrl });
				json(res, 200, { user: this.publicUser(user as AccountUser) });
			} catch { json(res, 400, { error: "profile_invalid" }); }
		});

		app.post("/api/account/bootstrap/complete", async (req, res) => {
			const session = this.getSession(req);
			if (!session) { json(res, 401, { error: "authentication_required" }); return; }
			if (!this.store.verifyCsrf(session, String(req.headers["x-csrf-token"] || ""))) { json(res, 403, { error: "csrf_failed" }); return; }
			if (!session.user.mustChangePassword || session.user.role !== "admin") { json(res, 409, { error: "initial_credentials_already_replaced" }); return; }
			try {
				const body = readJson(req); const email = normalizeEmail(body.email); const username = String(body.username || "").trim(); const nickname = String(body.nickname || username).trim(); const password = String(body.password || "");
				const checked = await this.store.verifyPassword(session.user.email, String(body.currentPassword || ""));
				if (!checked || !validEmail(email) || !this.emailAllowed(email) || !isValidUsername(username) || !validNickname(nickname) || !validPassword(password)) { json(res, 400, { error: "initial_credentials_invalid" }); return; }
				const duplicate = this.store.getUserByEmail(email); const duplicateName = this.store.getUserByIdentity(username); if ((duplicate && duplicate.id !== session.user.id) || (duplicateName && duplicateName.id !== session.user.id)) { json(res, 409, { error: "account_exists" }); return; }
				await this.store.completeInitialCredentials(session.user.id, { email, username, nickname, password });
				this.clearAuthCookies(req, res); this.store.audit(session.user.id, "account.bootstrap-complete", session.user.id); json(res, 200, { reloginRequired: true });
			} catch { json(res, 400, { error: "initial_credentials_invalid" }); }
		});

		app.post("/api/account/logout", (req, res) => {
			const session = this.requireSession(req, res, true, true); if (!session) return;
			this.store.revokeSession(session.token); this.clearSessionCookies(req, res); json(res, 200, { authenticated: false });
		});

		app.post("/api/account/password/reset", async (req, res) => {
			try {
				const body = readJson(req); const email = normalizeEmail(body.email); const password = String(body.password || ""); const user = this.store.getUserByEmail(email);
				if (!user || !validPassword(password) || !this.store.verifyCode(String(body.codeId || ""), email, "reset-password", String(body.code || ""))) { json(res, 400, { error: "reset_invalid" }); return; }
				await this.store.updatePassword(user.id, password); this.store.audit(user.id, "account.password-reset", user.id); json(res, 200, { ok: true });
			} catch { json(res, 400, { error: "reset_invalid" }); }
		});

		app.post("/api/account/password", async (req, res) => {
			const session = this.requireSession(req, res, true, true); if (!session || !this.requireRiskClearance(session.user.id, "password-change", req, res)) return;
			try {
				const body = readJson(req); const checked = await this.store.verifyPassword(session.user.email, String(body.currentPassword || "")); const password = String(body.password || "");
				if (!checked || !validPassword(password)) { json(res, 400, { error: "password_invalid" }); return; }
				await this.store.updatePassword(session.user.id, password); this.clearAuthCookies(req, res); this.store.audit(session.user.id, "account.password-change", session.user.id); json(res, 200, { reloginRequired: true });
			} catch { json(res, 400, { error: "password_invalid" }); }
		});

		app.get("/api/account/projects", (req, res) => { const session = this.requireSession(req, res); if (session) json(res, 200, this.store.listProjects(session.user.id)); });
		app.get("/api/shared-projects/:token", (req, res) => {
			const token = String(req.params.token || "");
			if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) { json(res, 404, { error: "share_not_found" }); return; }
			const shared = this.store.getSharedProject(token) as unknown as Record<string, unknown> | null;
			if (!shared) { json(res, 404, { error: "share_not_found" }); return; }
			if (!this.sharedProjectIsActive(shared)) { json(res, 410, { error: "share_expired" }); return; }
			sendProject(res, shared);
		});
		app.get("/api/account/effect-presets", (req, res) => { const session = this.requireSession(req, res); if (session) json(res, 200, { items: this.store.listEffectPresets(session.user.id), folders: this.store.listEffectFolders(session.user.id), limit: Number(this.config.max_effect_presets || 100) }); });
		app.post("/api/account/effect-presets", (req, res) => { const session = this.requireSession(req, res, true); if (!session) return; if(this.store.effectPresetCount(session.user.id)>=Number(this.config.max_effect_presets||100)){json(res,413,{error:"effect_preset_limit"});return;} const body = readJson(req); const preset = sanitizeEffectPreset(body); if (!preset) { json(res, 400, { error: "effect_preset_invalid" }); return; } const folders=new Set(this.store.listEffectFolders(session.user.id).map((item)=>item.id));const folderId=folders.has(preset.folderId)?preset.folderId:"";json(res, 201, this.store.createEffectPreset(session.user.id, preset.name, preset.config,folderId,preset.kind)); });
		app.put("/api/account/effect-presets/:id", (req, res) => { const session = this.requireSession(req, res, true); if (!session) return; const body = readJson(req); const preset = sanitizeEffectPreset(body); if (!preset) { json(res, 400, { error: "effect_preset_invalid" }); return; } const folders=new Set(this.store.listEffectFolders(session.user.id).map((item)=>item.id));const folderId=folders.has(preset.folderId)?preset.folderId:"";const saved = this.store.updateEffectPreset(session.user.id, req.params.id, preset.name, preset.config,folderId,preset.kind); json(res, saved ? 200 : 404, saved || { error: "effect_preset_not_found" }); });
		app.delete("/api/account/effect-presets/:id", (req, res) => { const session = this.requireSession(req, res, true); if (!session) return; json(res, this.store.deleteEffectPreset(session.user.id, req.params.id) ? 200 : 404, { ok: true }); });
		app.post("/api/account/effect-presets/:id/share",(req,res)=>{const session=this.requireSession(req,res,true);if(!session)return;const share=this.store.createEffectShare(session.user.id,req.params.id);json(res,share?201:404,share||{error:"effect_preset_not_found"});});
		app.post("/api/account/effect-presets/import",(req,res)=>{const session=this.requireSession(req,res,true);if(!session)return;if(this.store.effectPresetCount(session.user.id)>=Number(this.config.max_effect_presets||100)){json(res,413,{error:"effect_preset_limit"});return;}const body=readJson(req),shared=this.store.getEffectShare(String(body.code||"").trim());if(!shared){json(res,404,{error:"effect_share_not_found"});return;}const safe=sanitizeEffectPreset({name:shared.name,kind:shared.kind,config:shared.config});if(!safe){json(res,400,{error:"effect_preset_invalid"});return;}let folder=this.store.listEffectFolders(session.user.id).find(item=>item.name==="导入的特效");if(!folder){if(this.store.effectFolderCount(session.user.id)>=100){json(res,413,{error:"effect_folder_limit"});return;}folder=this.store.createEffectFolder(session.user.id,"导入的特效");}json(res,201,this.store.createEffectPreset(session.user.id,safe.name,safe.config,folder.id,safe.kind));});
		app.get("/api/account/effect-folders",(req,res)=>{const session=this.requireSession(req,res);if(session)json(res,200,this.store.listEffectFolders(session.user.id));});
		app.post("/api/account/effect-folders",(req,res)=>{const session=this.requireSession(req,res,true);if(!session)return;if(this.store.effectFolderCount(session.user.id)>=100){json(res,413,{error:"effect_folder_limit"});return;}const name=String(readJson(req).name||"").trim();if(!name){json(res,400,{error:"effect_folder_invalid"});return;}json(res,201,this.store.createEffectFolder(session.user.id,name));});
		app.put("/api/account/effect-folders/:id",(req,res)=>{const session=this.requireSession(req,res,true);if(!session)return;const name=String(readJson(req).name||"").trim();const saved=Boolean(name&&this.store.renameEffectFolder(session.user.id,req.params.id,name));json(res,saved?200:404,saved?{ok:true}:{error:"effect_folder_not_found"});});
		app.delete("/api/account/effect-folders/:id",(req,res)=>{const session=this.requireSession(req,res,true);if(!session)return;json(res,this.store.deleteEffectFolder(session.user.id,req.params.id)?200:404,{ok:true});});
		app.post("/api/account/projects", (req, res) => {
			const session = this.requireSession(req, res, true); if (!session || !this.requireRiskClearance(session.user.id, "project-write", req, res)) return;
			try {
				const { document, meta: body } = projectRequest(req); const sizeError = validateProjectDocument(document, this.config);
				if (sizeError) { json(res, 413, { error: sizeError }); return; }
				const encryptedSecret = body.sourceSecret ? AccountStore.encryptSecret(String(body.sourceSecret), String(this.config.encryption_key || "")) : "";
				const policy = this.storagePolicy(session.user);
				const project = this.store.createProject(session.user.id, String(body.title || "跑团记录"), document, { key: String(body.sourceKey || ""), revision: String(body.sourceRevision || ""), encryptedSecret }, policy);
				this.store.audit(session.user.id, "project.create", project?.id || ""); json(res, 201, projectSummary(project as unknown as Record<string, unknown>));
			} catch (error) { const code = error instanceof Error ? error.message : ""; json(res, code === "storage_quota_exceeded" || code === "project_limit_reached" ? 413 : 400, { error: code || "project_invalid" }); }
		});
		app.get("/api/account/projects/:id", (req, res) => { const session = this.requireSession(req, res); if (!session) return; sendProject(res, this.store.getProject(session.user.id, req.params.id) as unknown as Record<string, unknown> | null); });
		app.post("/api/account/projects/:id/share", (req, res) => {
			const session = this.requireSession(req, res, true); if (!session) return;
			const body = readJson(req);
			const requestedMode = String(body.expiryMode || "project");
			if (requestedMode !== "project" && requestedMode !== "fixed") { json(res, 400, { error: "share_expiry_invalid" }); return; }
			const expiryMode: "project" | "fixed" = requestedMode;
			const project = this.store.getProjectShareInfo(session.user.id, req.params.id);
			if (!project) { json(res, 404, { error: "project_not_found" }); return; }
			const retentionDays = this.storagePolicy(session.user).retentionDays;
			const lastActivity = Date.parse(project.lastActivityAt);
			if (!Number.isFinite(lastActivity)) { json(res, 400, { error: "share_expiry_invalid" }); return; }
			const projectExpires = retentionDays > 0 ? lastActivity + retentionDays * 86400000 : Number.POSITIVE_INFINITY;
			if (projectExpires <= Date.now()) { json(res, 410, { error: "project_expired" }); return; }
			let expiresAt = "";
			if (expiryMode === "project") {
				if (retentionDays === 0) { json(res, 400, { error: "share_expiry_required" }); return; }
			} else {
				const durationDays = Math.floor(Number(body.durationDays));
				if (![1, 3, 7, 14, 30, 90, 180, 365].includes(durationDays)) { json(res, 400, { error: "share_expiry_invalid" }); return; }
				const requestedExpiry = Date.now() + durationDays * 86400000;
				if (requestedExpiry > projectExpires) { json(res, 400, { error: "share_expiry_exceeds_project", projectExpiresAt: new Date(projectExpires).toISOString() }); return; }
				expiresAt = new Date(requestedExpiry).toISOString();
			}
			const share = this.store.shareProject(session.user.id, req.params.id, expiryMode, expiresAt);
			json(res, share ? 200 : 404, share || { error: "project_not_found" });
		});
		app.get("/api/account/projects/:id/source", async (req, res) => {
			const session = this.requireSession(req, res); if (!session) return;
			const source = this.store.getProjectSource(session.user.id, req.params.id);
			if (!source?.key || !source.encryptedSecret || !this.logStore) { json(res, 404, { error: "source_unavailable" }); return; }
			try {
				const secret = AccountStore.decryptSecret(source.encryptedSecret, String(this.config.encryption_key || ""));
				const stored = await this.logStore.readPublicLog(source.key, secret);
				if (!stored) { json(res, 404, { error: "source_unavailable" }); return; }
				json(res, 200, { record: JSON.parse(stored), sourceKey: source.key, sourceRevision: source.revision });
			} catch { json(res, 404, { error: "source_unavailable" }); }
		});
		app.put("/api/account/projects/:id", (req, res) => {
			const session = this.requireSession(req, res, true); if (!session || !this.requireRiskClearance(session.user.id, "project-write", req, res)) return;
			try { const { document, meta: body } = projectRequest(req); const sizeError = validateProjectDocument(document, this.config); if (sizeError) { json(res, 413, { error: sizeError }); return; } const project = this.store.updateProject(session.user.id, req.params.id, Number(body.revision || 0), document, body.title ? String(body.title) : undefined, this.storagePolicy(session.user)); json(res, project ? 200 : 409, project ? projectSummary(project as unknown as Record<string, unknown>) : { error: "revision_conflict" }); }
			catch (error) { const code = error instanceof Error ? error.message : ""; json(res, code === "storage_quota_exceeded" ? 413 : 400, { error: code || "project_invalid" }); }
		});
		app.delete("/api/account/projects/:id", (req, res) => { const session = this.requireSession(req, res, true); if (!session || !this.requireRiskClearance(session.user.id, "project-delete", req, res)) return; json(res, this.store.deleteProject(session.user.id, req.params.id) ? 200 : 404, { ok: true }); });
	}
}

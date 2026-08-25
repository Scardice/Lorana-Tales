import crypto from "node:crypto";
import net from "node:net";
import type { Express, Request, Response } from "express";
import { getClientIp } from "../server/client-ip.js";
import { AccountStore, type AccountUser, normalizeEmail } from "./account-store.js";
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

function validateProjectDocument(value: unknown, config): "project_too_large" | "asset_too_large" | "" {
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

export class AccountService {
	readonly store: AccountStore;
	readonly config;
	readonly captcha: CaptchaService;
	readonly mailer: AccountMailer | null;
	readonly trustProxy: boolean;
	readonly logStore: LogStore | null;
	private captchaChallengeTimes = new Map<string, number[]>();

	constructor(store: AccountStore, config, trustProxy = false, logStore: LogStore | null = null) {
		this.store = store;
		this.config = config;
		this.captcha = new CaptchaService(config);
		this.trustProxy = trustProxy;
		this.logStore = logStore;
		this.mailer = config.smtp?.host && config.smtp?.from ? new AccountMailer(config.smtp) : null;
	}

	private secure(req: Request) {
		const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
		return req.secure || (this.trustProxy && forwarded === "https");
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

	isAdmin(req: Request) { return this.getSession(req)?.user.role === "admin"; }

	private requireSession(req: Request, res: Response, mutate = false) {
		const session = this.getSession(req);
		if (!session) { json(res, 401, { error: "authentication_required" }); return null; }
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

	private publicUser(user: AccountUser) {
		return { ...user, banReason: user.status === "banned" ? user.banReason : "", projectCount: this.store.projectCount(user.id) };
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
			} catch { json(res, 400, { error: "invalid_request" }); }
		});

		app.post("/api/account/verification/send", async (req, res) => {
			try {
				const body = readJson(req);
				const email = normalizeEmail(body.email);
				const purpose = ["register", "login", "reset-password"].includes(String(body.purpose)) ? String(body.purpose) : "login";
				if (!validEmail(email) || !this.emailAllowed(email)) { json(res, 400, { error: "email_not_allowed" }); return; }
				if (purpose === "register" && (this.config.registration_enabled === false || this.store.getUserByEmail(email))) { json(res, 409, { error: "registration_unavailable" }); return; }
				const subject = `${email}:${this.prefix(req)}`;
				if (!this.captcha.consumeClearance(String(body.captchaClearance || ""), subject, "verification-send")) { json(res, 428, { error: "captcha_required", scope: "verification-send" }); return; }
				const counts = this.store.verificationSendCounts(email, this.prefix(req), Date.now() - 3600000);
				const resendMs = Math.max(1, Number(this.config.email_code_resend_seconds || 60)) * 1000;
				if (this.store.lastVerificationAt(email, purpose) > Date.now() - resendMs) { json(res, 429, { error: "verification_resend_wait", retryAfterSeconds: Math.ceil(resendMs / 1000) }); return; }
				if (counts.emailCount >= Number(this.config.email_code_per_hour || 5) || counts.ipCount >= Number(this.config.ip_email_code_per_hour || 10)) {
					this.store.recordRisk("", this.prefix(req), "verification-rate-limit", email);
					json(res, 429, { error: "verification_rate_limited" }); return;
				}
				if (!this.mailer) { json(res, 503, { error: "smtp_not_configured" }); return; }
				const code = crypto.randomInt(100000, 1000000).toString();
				const id = this.store.createVerificationCode(email, purpose, code, this.prefix(req), Number(this.config.email_code_ttl_minutes || 10));
				await this.mailer.sendCode(email, code, purpose);
				json(res, 200, { id, resendAfterSeconds: Number(this.config.email_code_resend_seconds || 60) });
			} catch (error) { console.error("[accounts] verification send failed", error); json(res, 400, { error: "verification_send_failed" }); }
		});

		app.post("/api/account/register", async (req, res) => {
			try {
				const body = readJson(req); const email = normalizeEmail(body.email); const password = String(body.password || "");
				if (this.config.registration_enabled === false) { json(res, 403, { error: "registration_disabled" }); return; }
				if (!validEmail(email) || !this.emailAllowed(email) || !validPassword(password)) { json(res, 400, { error: "invalid_registration" }); return; }
				if (!this.store.verifyCode(String(body.codeId || ""), email, "register", String(body.code || ""))) { json(res, 400, { error: "verification_invalid" }); return; }
				const user = await this.store.createUser({ email, password, displayName: String(body.displayName || "") });
				this.store.audit(user.id, "account.register", user.id);
				const device = this.store.createTrustedDevice(user.id, this.prefix(req), this.userAgent(req), Number(this.config.trusted_device_days || 90));
				const session = this.store.createSession(user, { sessionDays: Number(this.config.session_days || 30), deviceToken: device, ipPrefix: this.prefix(req), userAgent: this.userAgent(req) });
				this.setAuthCookies(req, res, session, device); json(res, 201, { user: this.publicUser(user), csrfToken: session.csrfToken });
			} catch (error) { console.error("[accounts] register failed", error); json(res, 409, { error: "account_exists" }); }
		});

		app.post("/api/account/login", async (req, res) => {
			try {
				const body = readJson(req); const email = normalizeEmail(body.email); const known = this.store.getUserByEmail(email);
				if (known && !this.requireRiskClearance(known.id, "login", req, res)) return;
				const user = await this.store.verifyPassword(email, String(body.password || ""));
				if (!user) { const known = this.store.getUserByEmail(email); this.store.recordRisk(known?.id || "", this.prefix(req), "login-failed", email); json(res, 401, { error: "invalid_credentials" }); return; }
				const current = this.store.refreshExpiredBan(user);
				if (current.status === "banned") { json(res, 403, { error: "account_banned", reason: current.banReason, until: current.banUntil }); return; }
				if (current.status !== "active") { json(res, 403, { error: "account_disabled" }); return; }
				const existingDevice = cookies(req).get(DEVICE_COOKIE) || "";
				const trusted = this.store.isTrustedDevice(current.id, existingDevice, this.prefix(req), this.userAgent(req));
				if (!trusted && !this.store.verifyCode(String(body.codeId || ""), email, "login", String(body.code || ""))) {
					json(res, 428, { error: "email_verification_required", email }); return;
				}
				const device = trusted ? existingDevice : this.store.createTrustedDevice(current.id, this.prefix(req), this.userAgent(req), Number(this.config.trusted_device_days || 90));
				const session = this.store.createSession(current, { sessionDays: Number(this.config.session_days || 30), deviceToken: device, ipPrefix: this.prefix(req), userAgent: this.userAgent(req) });
				this.setAuthCookies(req, res, session, device); this.store.audit(current.id, "account.login", current.id);
				json(res, 200, { user: this.publicUser(current), csrfToken: session.csrfToken });
			} catch { json(res, 400, { error: "invalid_request" }); }
		});

		app.get("/api/account/me", (req, res) => {
			const session = this.getSession(req); json(res, 200, session ? { authenticated: true, user: this.publicUser(session.user) } : { authenticated: false });
		});

		app.post("/api/account/logout", (req, res) => {
			const session = this.requireSession(req, res, true); if (!session) return;
			this.store.revokeSession(session.token); this.clearAuthCookies(req, res); json(res, 200, { authenticated: false });
		});

		app.post("/api/account/password/reset", async (req, res) => {
			try {
				const body = readJson(req); const email = normalizeEmail(body.email); const password = String(body.password || ""); const user = this.store.getUserByEmail(email);
				if (!user || !validPassword(password) || !this.store.verifyCode(String(body.codeId || ""), email, "reset-password", String(body.code || ""))) { json(res, 400, { error: "reset_invalid" }); return; }
				await this.store.updatePassword(user.id, password); this.store.audit(user.id, "account.password-reset", user.id); json(res, 200, { ok: true });
			} catch { json(res, 400, { error: "reset_invalid" }); }
		});

		app.post("/api/account/password", async (req, res) => {
			const session = this.requireSession(req, res, true); if (!session || !this.requireRiskClearance(session.user.id, "password-change", req, res)) return;
			try {
				const body = readJson(req); const checked = await this.store.verifyPassword(session.user.email, String(body.currentPassword || "")); const password = String(body.password || "");
				if (!checked || !validPassword(password)) { json(res, 400, { error: "password_invalid" }); return; }
				await this.store.updatePassword(session.user.id, password); this.clearAuthCookies(req, res); this.store.audit(session.user.id, "account.password-change", session.user.id); json(res, 200, { reloginRequired: true });
			} catch { json(res, 400, { error: "password_invalid" }); }
		});

		app.get("/api/account/projects", (req, res) => { const session = this.requireSession(req, res); if (session) json(res, 200, this.store.listProjects(session.user.id)); });
		app.post("/api/account/projects", (req, res) => {
			const session = this.requireSession(req, res, true); if (!session || !this.requireRiskClearance(session.user.id, "project-write", req, res)) return;
			try {
				const body = readJson(req); const sizeError = validateProjectDocument(body.document, this.config);
				if (sizeError) { json(res, 413, { error: sizeError }); return; }
				const encryptedSecret = body.sourceSecret ? AccountStore.encryptSecret(String(body.sourceSecret), String(this.config.encryption_key || "")) : "";
				const project = this.store.createProject(session.user.id, String(body.title || "跑团记录"), body.document, { key: String(body.sourceKey || ""), revision: String(body.sourceRevision || ""), encryptedSecret });
				this.store.audit(session.user.id, "project.create", project?.id || ""); json(res, 201, project);
			} catch { json(res, 400, { error: "project_invalid" }); }
		});
		app.get("/api/account/projects/:id", (req, res) => { const session = this.requireSession(req, res); if (!session) return; const project = this.store.getProject(session.user.id, req.params.id); json(res, project ? 200 : 404, project || { error: "project_not_found" }); });
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
			try { const body = readJson(req); const sizeError = validateProjectDocument(body.document, this.config); if (sizeError) { json(res, 413, { error: sizeError }); return; } const project = this.store.updateProject(session.user.id, req.params.id, Number(body.revision || 0), body.document, body.title ? String(body.title) : undefined); json(res, project ? 200 : 409, project || { error: "revision_conflict" }); }
			catch { json(res, 400, { error: "project_invalid" }); }
		});
		app.delete("/api/account/projects/:id", (req, res) => { const session = this.requireSession(req, res, true); if (!session || !this.requireRiskClearance(session.user.id, "project-delete", req, res)) return; json(res, this.store.deleteProject(session.user.id, req.params.id) ? 200 : 404, { ok: true }); });
	}
}

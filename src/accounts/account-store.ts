import crypto from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type Database from "better-sqlite3";

const PASSWORD_PREFIX = "scrypt-v1";

function scryptAsync(password: string, salt: Buffer, length: number): Promise<Buffer> {
	return new Promise((resolve, reject) => crypto.scrypt(password, salt, length, {
		N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
	}, (error, result) => error ? reject(error) : resolve(result)));
}

export type AccountRole = "user" | "admin";
export type AccountStatus = "active" | "disabled" | "banned";

export interface AccountUser {
	id: string;
	email: string;
	displayName: string;
	role: AccountRole;
	status: AccountStatus;
	banReason: string;
	banUntil: string;
	mustChangePassword: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface AccountSession {
	token: string;
	csrfToken: string;
	user: AccountUser;
	expiresAt: number;
}

export interface EditorProjectSummary {
	id: string;
	title: string;
	revision: number;
	sourceKey: string;
	sourceRevision: string;
	createdAt: string;
	updatedAt: string;
}

type SqlRow = Record<string, unknown>;

function nowIso() {
	return new Date().toISOString();
}

function sha256(value: string | Buffer): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken(bytes = 32): string {
	return crypto.randomBytes(bytes).toString("base64url");
}

export function normalizeEmail(value: unknown): string {
	return String(value || "").trim().toLowerCase();
}

function rowToUser(row: SqlRow): AccountUser {
	return {
		id: String(row.id || ""),
		email: String(row.email || ""),
		displayName: String(row.display_name || ""),
		role: row.role === "admin" ? "admin" : "user",
		status:
			row.status === "banned" ? "banned" : row.status === "disabled" ? "disabled" : "active",
		banReason: String(row.ban_reason || ""),
		banUntil: String(row.ban_until || ""),
		mustChangePassword: Number(row.must_change_password || 0) === 1,
		createdAt: String(row.created_at || ""),
		updatedAt: String(row.updated_at || ""),
	};
}

async function passwordHash(password: string): Promise<string> {
	const salt = crypto.randomBytes(16);
	const derived = await scryptAsync(password, salt, 64);
	return [PASSWORD_PREFIX, salt.toString("base64url"), derived.toString("base64url")].join("$");
}

async function passwordMatches(password: string, encoded: string): Promise<boolean> {
	const [prefix, saltText, expectedText] = encoded.split("$");
	if (prefix !== PASSWORD_PREFIX || !saltText || !expectedText) return false;
	const expected = Buffer.from(expectedText, "base64url");
	const actual = await scryptAsync(password, Buffer.from(saltText, "base64url"), expected.length);
	return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function compressDocument(value: unknown): Buffer {
	return deflateRawSync(Buffer.from(JSON.stringify(value), "utf-8"), { level: 9 });
}

function decompressDocument(value: Buffer): unknown {
	return JSON.parse(inflateRawSync(value).toString("utf-8"));
}

export class AccountStore {
	readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
		this.migrate();
	}

	private migrate() {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS account_users (
				id TEXT PRIMARY KEY,
				email TEXT NOT NULL UNIQUE COLLATE NOCASE,
				display_name TEXT NOT NULL DEFAULT '',
				password_hash TEXT NOT NULL,
				role TEXT NOT NULL DEFAULT 'user',
				status TEXT NOT NULL DEFAULT 'active',
				ban_reason TEXT NOT NULL DEFAULT '',
				ban_until TEXT NOT NULL DEFAULT '',
				must_change_password INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_account_users_email ON account_users(email);
			CREATE INDEX IF NOT EXISTS idx_account_users_status ON account_users(status);

			CREATE TABLE IF NOT EXISTS account_sessions (
				token_hash TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				csrf_hash TEXT NOT NULL,
				device_hash TEXT NOT NULL DEFAULT '',
				ip_prefix_hash TEXT NOT NULL DEFAULT '',
				user_agent_hash TEXT NOT NULL DEFAULT '',
				created_at_ms INTEGER NOT NULL,
				expires_at_ms INTEGER NOT NULL,
				FOREIGN KEY(user_id) REFERENCES account_users(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_account_sessions_user ON account_sessions(user_id);

			CREATE TABLE IF NOT EXISTS account_devices (
				token_hash TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				ip_prefix_hash TEXT NOT NULL,
				user_agent_hash TEXT NOT NULL,
				created_at_ms INTEGER NOT NULL,
				last_used_at_ms INTEGER NOT NULL,
				expires_at_ms INTEGER NOT NULL,
				FOREIGN KEY(user_id) REFERENCES account_users(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_account_devices_user ON account_devices(user_id);

			CREATE TABLE IF NOT EXISTS account_verification_codes (
				id TEXT PRIMARY KEY,
				email TEXT NOT NULL COLLATE NOCASE,
				purpose TEXT NOT NULL,
				code_hash TEXT NOT NULL,
				ip_prefix_hash TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				created_at_ms INTEGER NOT NULL,
				expires_at_ms INTEGER NOT NULL,
				consumed_at_ms INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_account_codes_email ON account_verification_codes(email, created_at_ms DESC);

			CREATE TABLE IF NOT EXISTS editor_projects (
				id TEXT PRIMARY KEY,
				user_id TEXT,
				title TEXT NOT NULL,
				revision INTEGER NOT NULL DEFAULT 1,
				document_blob BLOB NOT NULL,
				source_key TEXT NOT NULL DEFAULT '',
				source_revision TEXT NOT NULL DEFAULT '',
				source_secret_cipher TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				archived INTEGER NOT NULL DEFAULT 0,
				FOREIGN KEY(user_id) REFERENCES account_users(id) ON DELETE SET NULL
			);
			CREATE INDEX IF NOT EXISTS idx_editor_projects_user ON editor_projects(user_id, updated_at DESC);

			CREATE TABLE IF NOT EXISTS account_audit_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				actor TEXT NOT NULL,
				action TEXT NOT NULL,
				target TEXT NOT NULL DEFAULT '',
				detail TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_account_audit_created ON account_audit_log(created_at DESC);

			CREATE TABLE IF NOT EXISTS account_risk_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id TEXT NOT NULL DEFAULT '',
				ip_prefix_hash TEXT NOT NULL DEFAULT '',
				event TEXT NOT NULL,
				detail TEXT NOT NULL DEFAULT '',
				created_at_ms INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_account_risk_user ON account_risk_events(user_id, created_at_ms DESC);
		`);
	}

	async createUser(input: {
		email: string;
		password: string;
		displayName?: string;
		role?: AccountRole;
		mustChangePassword?: boolean;
	}): Promise<AccountUser> {
		const email = normalizeEmail(input.email);
		const now = nowIso();
		const id = crypto.randomUUID();
		this.db.prepare(`
			INSERT INTO account_users (
				id, email, display_name, password_hash, role, status,
				must_change_password, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
		`).run(
			id,
			email,
			String(input.displayName || email.split("@")[0]).slice(0, 80),
			await passwordHash(input.password),
			input.role === "admin" ? "admin" : "user",
			input.mustChangePassword ? 1 : 0,
			now,
			now,
		);
		return this.getUserById(id) as AccountUser;
	}

	getUserById(id: string): AccountUser | null {
		const row = this.db.prepare("SELECT * FROM account_users WHERE id = ?").get(id) as SqlRow | undefined;
		return row ? rowToUser(row) : null;
	}

	getUserByEmail(email: string): AccountUser | null {
		const row = this.db.prepare("SELECT * FROM account_users WHERE email = ? COLLATE NOCASE").get(normalizeEmail(email)) as SqlRow | undefined;
		return row ? rowToUser(row) : null;
	}

	refreshExpiredBan(user: AccountUser): AccountUser {
		if (user.status === "banned" && user.banUntil && Date.parse(user.banUntil) <= Date.now()) {
			return this.setStatus(user.id, "active") as AccountUser;
		}
		return user;
	}

	async verifyPassword(email: string, password: string): Promise<AccountUser | null> {
		const row = this.db.prepare("SELECT * FROM account_users WHERE email = ? COLLATE NOCASE").get(normalizeEmail(email)) as SqlRow | undefined;
		if (!row || !(await passwordMatches(password, String(row.password_hash || "")))) return null;
		return rowToUser(row);
	}

	async updatePassword(userId: string, password: string, mustChange = false): Promise<void> {
		this.db.prepare("UPDATE account_users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?")
			.run(await passwordHash(password), mustChange ? 1 : 0, nowIso(), userId);
		this.revokeSessions(userId);
	}

	updateUser(userId: string, input: Partial<{ email: string; displayName: string; role: AccountRole }>) {
		const current = this.getUserById(userId);
		if (!current) return null;
		const email = input.email ? normalizeEmail(input.email) : current.email;
		const displayName = input.displayName === undefined ? current.displayName : String(input.displayName).slice(0, 80);
		const role = input.role || current.role;
		this.db.prepare("UPDATE account_users SET email = ?, display_name = ?, role = ?, updated_at = ? WHERE id = ?")
			.run(email, displayName, role, nowIso(), userId);
		if (input.email) this.revokeSessions(userId);
		return this.getUserById(userId);
	}

	setStatus(userId: string, status: AccountStatus, reason = "", until = "") {
		this.db.prepare("UPDATE account_users SET status = ?, ban_reason = ?, ban_until = ?, updated_at = ? WHERE id = ?")
			.run(status, status === "banned" ? reason.slice(0, 500) : "", status === "banned" ? until : "", nowIso(), userId);
		if (status !== "active") this.revokeSessions(userId);
		return this.getUserById(userId);
	}

	activeAdminCount(): number {
		return Number((this.db.prepare("SELECT COUNT(*) AS total FROM account_users WHERE role = 'admin' AND status = 'active'").get() as SqlRow).total || 0);
	}

	listUsers(query = "", page = 1, pageSize = 20) {
		const normalized = query.trim().toLowerCase();
		const where = normalized ? "WHERE lower(email) LIKE @like OR lower(display_name) LIKE @like" : "";
		const params = normalized ? { like: `%${normalized.replace(/[\\%_]/g, "\\$&")}%` } : {};
		const total = Number((this.db.prepare(`SELECT COUNT(*) AS total FROM account_users ${where}`).get(params) as SqlRow).total || 0);
		const rows = this.db.prepare(`SELECT * FROM account_users ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
			.all({ ...params, limit: Math.min(100, Math.max(1, pageSize)), offset: Math.max(0, page - 1) * pageSize }) as SqlRow[];
		return { items: rows.map(rowToUser), total, page, pageSize };
	}

	listAudit(page = 1, pageSize = 50) {
		const limit = Math.min(100, Math.max(1, pageSize));
		const total = Number((this.db.prepare("SELECT COUNT(*) AS total FROM account_audit_log").get() as SqlRow).total || 0);
		const items = this.db.prepare("SELECT * FROM account_audit_log ORDER BY id DESC LIMIT ? OFFSET ?")
			.all(limit, Math.max(0, page - 1) * limit) as SqlRow[];
		return { items, total, page, pageSize: limit };
	}

	projectCount(userId: string): number {
		return Number((this.db.prepare("SELECT COUNT(*) AS total FROM editor_projects WHERE user_id = ? AND archived = 0").get(userId) as SqlRow).total || 0);
	}

	createSession(user: AccountUser, input: { sessionDays: number; deviceToken?: string; ipPrefix: string; userAgent: string }): AccountSession {
		const token = randomToken();
		const csrfToken = randomToken(24);
		const expiresAt = Date.now() + Math.max(1, input.sessionDays) * 86400000;
		this.db.prepare(`INSERT INTO account_sessions (
			token_hash, user_id, csrf_hash, device_hash, ip_prefix_hash, user_agent_hash,
			created_at_ms, expires_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(sha256(token), user.id, sha256(csrfToken), input.deviceToken ? sha256(input.deviceToken) : "", sha256(input.ipPrefix), sha256(input.userAgent), Date.now(), expiresAt);
		return { token, csrfToken, user, expiresAt };
	}

	getSession(token: string): (AccountSession & { csrfHash: string; ipPrefixHash: string; userAgentHash: string }) | null {
		if (!token) return null;
		const row = this.db.prepare(`SELECT s.*, u.*,
			s.token_hash AS session_token_hash, s.csrf_hash AS session_csrf_hash,
			s.ip_prefix_hash AS session_ip_prefix_hash, s.user_agent_hash AS session_user_agent_hash,
			s.expires_at_ms AS session_expires_at_ms
			FROM account_sessions s JOIN account_users u ON u.id = s.user_id
			WHERE s.token_hash = ? AND s.expires_at_ms > ?`).get(sha256(token), Date.now()) as SqlRow | undefined;
		if (!row) return null;
		return {
			token,
			csrfToken: "",
			csrfHash: String(row.session_csrf_hash || ""),
			ipPrefixHash: String(row.session_ip_prefix_hash || ""),
			userAgentHash: String(row.session_user_agent_hash || ""),
			user: rowToUser(row),
			expiresAt: Number(row.session_expires_at_ms || 0),
		};
	}

	verifyCsrf(session: { csrfHash: string }, token: string): boolean {
		return !!token && sha256(token) === session.csrfHash;
	}

	sessionMatchesContext(session: { ipPrefixHash: string; userAgentHash: string }, ipPrefix: string, userAgent: string): boolean {
		return session.ipPrefixHash === sha256(ipPrefix) && session.userAgentHash === sha256(userAgent);
	}

	revokeSession(token: string) {
		this.db.prepare("DELETE FROM account_sessions WHERE token_hash = ?").run(sha256(token));
	}

	revokeSessions(userId: string) {
		this.db.prepare("DELETE FROM account_sessions WHERE user_id = ?").run(userId);
	}

	createTrustedDevice(userId: string, ipPrefix: string, userAgent: string, days: number) {
		const token = randomToken();
		const now = Date.now();
		this.db.prepare(`INSERT INTO account_devices (
			token_hash, user_id, ip_prefix_hash, user_agent_hash, created_at_ms, last_used_at_ms, expires_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(sha256(token), userId, sha256(ipPrefix), sha256(userAgent), now, now, now + Math.max(1, days) * 86400000);
		return token;
	}

	isTrustedDevice(userId: string, token: string, ipPrefix: string, userAgent: string): boolean {
		if (!token) return false;
		const row = this.db.prepare(`SELECT token_hash FROM account_devices
			WHERE token_hash = ? AND user_id = ? AND ip_prefix_hash = ? AND user_agent_hash = ? AND expires_at_ms > ?`)
			.get(sha256(token), userId, sha256(ipPrefix), sha256(userAgent), Date.now()) as SqlRow | undefined;
		if (!row) return false;
		this.db.prepare("UPDATE account_devices SET last_used_at_ms = ? WHERE token_hash = ?").run(Date.now(), sha256(token));
		return true;
	}

	createVerificationCode(email: string, purpose: string, code: string, ipPrefix: string, ttlMinutes: number) {
		const id = crypto.randomUUID();
		const now = Date.now();
		this.db.prepare(`INSERT INTO account_verification_codes (
			id, email, purpose, code_hash, ip_prefix_hash, created_at_ms, expires_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(id, normalizeEmail(email), purpose, sha256(`${id}:${code}`), sha256(ipPrefix), now, now + ttlMinutes * 60000);
		return id;
	}

	verifyCode(id: string, email: string, purpose: string, code: string): boolean {
		const row = this.db.prepare(`SELECT * FROM account_verification_codes
			WHERE id = ? AND email = ? COLLATE NOCASE AND purpose = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?`)
			.get(id, normalizeEmail(email), purpose, Date.now()) as SqlRow | undefined;
		if (!row || Number(row.attempts || 0) >= 5) return false;
		const valid = String(row.code_hash) === sha256(`${id}:${code}`);
		this.db.prepare(`UPDATE account_verification_codes SET attempts = attempts + 1,
			consumed_at_ms = CASE WHEN ? THEN ? ELSE consumed_at_ms END WHERE id = ?`)
			.run(valid ? 1 : 0, Date.now(), id);
		return valid;
	}

	verificationSendCounts(email: string, ipPrefix: string, sinceMs: number) {
		const emailCount = Number((this.db.prepare("SELECT COUNT(*) AS total FROM account_verification_codes WHERE email = ? COLLATE NOCASE AND created_at_ms >= ?")
			.get(normalizeEmail(email), sinceMs) as SqlRow).total || 0);
		const ipCount = Number((this.db.prepare("SELECT COUNT(*) AS total FROM account_verification_codes WHERE ip_prefix_hash = ? AND created_at_ms >= ?")
			.get(sha256(ipPrefix), sinceMs) as SqlRow).total || 0);
		return { emailCount, ipCount };
	}

	lastVerificationAt(email: string, purpose: string): number {
		const row = this.db.prepare("SELECT MAX(created_at_ms) AS latest FROM account_verification_codes WHERE email = ? COLLATE NOCASE AND purpose = ?")
			.get(normalizeEmail(email), purpose) as SqlRow;
		return Number(row.latest || 0);
	}

	createProject(userId: string, title: string, document: unknown, source: { key?: string; revision?: string; encryptedSecret?: string } = {}) {
		const id = crypto.randomUUID();
		const now = nowIso();
		this.db.prepare(`INSERT INTO editor_projects (
			id, user_id, title, revision, document_blob, source_key, source_revision,
			source_secret_cipher, created_at, updated_at
		) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
			.run(id, userId, title.slice(0, 160) || "跑团记录", compressDocument(document), source.key || "", source.revision || "", source.encryptedSecret || "", now, now);
		return this.getProject(userId, id);
	}

	listProjects(userId: string): EditorProjectSummary[] {
		return (this.db.prepare(`SELECT id, title, revision, source_key, source_revision, created_at, updated_at
			FROM editor_projects WHERE user_id = ? AND archived = 0 ORDER BY updated_at DESC`).all(userId) as SqlRow[])
			.map((row) => ({
				id: String(row.id), title: String(row.title), revision: Number(row.revision),
				sourceKey: String(row.source_key || ""), sourceRevision: String(row.source_revision || ""),
				createdAt: String(row.created_at), updatedAt: String(row.updated_at),
			}));
	}

	getProject(userId: string, id: string) {
		const row = this.db.prepare("SELECT * FROM editor_projects WHERE id = ? AND user_id = ? AND archived = 0").get(id, userId) as SqlRow | undefined;
		if (!row) return null;
		return {
			id: String(row.id), title: String(row.title), revision: Number(row.revision),
			document: decompressDocument(row.document_blob as Buffer), sourceKey: String(row.source_key || ""),
			sourceRevision: String(row.source_revision || ""),
			createdAt: String(row.created_at), updatedAt: String(row.updated_at),
		};
	}

	getProjectSource(userId: string, id: string) {
		const row = this.db.prepare("SELECT source_key, source_revision, source_secret_cipher FROM editor_projects WHERE id = ? AND user_id = ? AND archived = 0").get(id, userId) as SqlRow | undefined;
		return row ? { key: String(row.source_key || ""), revision: String(row.source_revision || ""), encryptedSecret: String(row.source_secret_cipher || "") } : null;
	}

	updateProject(userId: string, id: string, expectedRevision: number, document: unknown, title?: string) {
		const result = this.db.prepare(`UPDATE editor_projects SET document_blob = ?, title = COALESCE(?, title),
			revision = revision + 1, updated_at = ? WHERE id = ? AND user_id = ? AND revision = ? AND archived = 0`)
			.run(compressDocument(document), title ? title.slice(0, 160) : null, nowIso(), id, userId, expectedRevision);
		return result.changes === 1 ? this.getProject(userId, id) : null;
	}

	deleteProject(userId: string, id: string) {
		return this.db.prepare("DELETE FROM editor_projects WHERE id = ? AND user_id = ?").run(id, userId).changes === 1;
	}

	deleteUser(userId: string, projectAction: "delete" | "archive" | "transfer", transferUserId = "") {
		const transaction = this.db.transaction(() => {
			if (projectAction === "delete") this.db.prepare("DELETE FROM editor_projects WHERE user_id = ?").run(userId);
			if (projectAction === "archive") this.db.prepare("UPDATE editor_projects SET user_id = NULL, archived = 1 WHERE user_id = ?").run(userId);
			if (projectAction === "transfer") this.db.prepare("UPDATE editor_projects SET user_id = ?, updated_at = ? WHERE user_id = ?").run(transferUserId, nowIso(), userId);
			return this.db.prepare("DELETE FROM account_users WHERE id = ?").run(userId).changes === 1;
		});
		return transaction();
	}

	audit(actor: string, action: string, target = "", detail: unknown = "") {
		this.db.prepare("INSERT INTO account_audit_log (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(actor, action, target, typeof detail === "string" ? detail : JSON.stringify(detail), nowIso());
	}

	recordRisk(userId: string, ipPrefix: string, event: string, detail = "") {
		this.db.prepare("INSERT INTO account_risk_events (user_id, ip_prefix_hash, event, detail, created_at_ms) VALUES (?, ?, ?, ?, ?)")
			.run(userId, sha256(ipPrefix), event, detail.slice(0, 500), Date.now());
	}

	recentRiskCount(userId: string, ipPrefix: string, sinceMs: number): number {
		return Number((this.db.prepare(`SELECT COUNT(*) AS total FROM account_risk_events
			WHERE created_at_ms >= ? AND (user_id = ? OR ip_prefix_hash = ?)`)
			.get(sinceMs, userId, sha256(ipPrefix)) as SqlRow).total || 0);
	}

	static encryptSecret(secret: string, masterKey: string): string {
		if (!secret) return "";
		const key = crypto.createHash("sha256").update(masterKey).digest();
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
		const encrypted = Buffer.concat([cipher.update(secret, "utf-8"), cipher.final()]);
		return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
	}

	static decryptSecret(value: string, masterKey: string): string {
		if (!value) return "";
		const [ivText, tagText, encryptedText] = value.split(".");
		const key = crypto.createHash("sha256").update(masterKey).digest();
		const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
		decipher.setAuthTag(Buffer.from(tagText, "base64url"));
		return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf-8");
	}
}

import crypto from "node:crypto";
import { inflateRawSync } from "node:zlib";
import type Database from "better-sqlite3";

const PASSWORD_PREFIX = "scrypt-v1";
const MAX_EFFECT_SHARES_PER_USER = 500;

class WorkQueue {
	private active = 0;
	private readonly waiting: Array<() => void> = [];
	constructor(private readonly limit: number, private readonly maxWaiting: number) {}
	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.active >= this.limit) {
			if (this.waiting.length >= this.maxWaiting) throw new Error("password_work_queue_busy");
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		}
		this.active += 1;
		try { return await task(); }
		finally {
			this.active -= 1;
			this.waiting.shift()?.();
		}
	}
}

// Scrypt is intentionally expensive. Bound parallel work so a burst of login
// attempts cannot reserve unbounded native memory and take down the process.
const passwordWork = new WorkQueue(
	Math.max(1, Math.min(4, Number(process.env.ACCOUNT_KDF_CONCURRENCY || 2) || 2)),
	Math.max(8, Math.min(256, Number(process.env.ACCOUNT_KDF_QUEUE_LIMIT || 64) || 64)),
);
const DUMMY_PASSWORD_HASH = [PASSWORD_PREFIX, crypto.randomBytes(16).toString("base64url"), crypto.randomBytes(64).toString("base64url")].join("$");

function scryptAsync(password: string, salt: Buffer, length: number): Promise<Buffer> {
	return passwordWork.run(() => new Promise((resolve, reject) => crypto.scrypt(password, salt, length, {
		N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
	}, (error, result) => error ? reject(error) : resolve(result))));
}

export type AccountRole = "user" | "admin";
export type AccountStatus = "active" | "disabled" | "banned";

export interface AccountUser {
	id: string;
	email: string;
	username: string;
	nickname: string;
	avatarUrl: string;
	displayName: string;
	role: AccountRole;
	group: string;
	quotaMbOverride: number | null;
	retentionDaysOverride: number | null;
	status: AccountStatus;
	banReason: string;
	banUntil: string;
	mustChangePassword: boolean;
	tutorialPromptSeen: boolean;
	manualPlaybackHintSeen: boolean;
	tutorialPlaybackCoachSeen: boolean;
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
	lastActivityAt: string;
	storedBytes: number;
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

export function isValidUsername(value: unknown): boolean {
	return /^[A-Za-z0-9_-]{3,32}$/.test(String(value || "").trim());
}

function fallbackUsername(value: unknown, id: string): string {
	const normalized = String(value || "user")
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 24);
	const base = normalized.length >= 3 ? normalized : "user";
	return `${base}_${id.replace(/-/g, "").slice(0, 7)}`.slice(0, 32);
}

function rowToUser(row: SqlRow): AccountUser {
	return {
		id: String(row.id || ""),
		email: String(row.email || ""),
		username: String(row.username || ""),
		nickname: String(row.nickname || row.display_name || row.username || ""),
		avatarUrl: String(row.avatar_url || ""),
		displayName: String(row.nickname || row.display_name || row.username || ""),
		role: row.role === "admin" ? "admin" : "user",
		group: String(row.account_group || "default"),
		quotaMbOverride: row.quota_mb_override === null || row.quota_mb_override === undefined
			? null
			: Math.max(1, Number(row.quota_mb_override)),
		retentionDaysOverride: row.retention_days_override === null || row.retention_days_override === undefined
			? null
			: Math.max(0, Number(row.retention_days_override)),
		status:
			row.status === "banned" ? "banned" : row.status === "disabled" ? "disabled" : "active",
		banReason: String(row.ban_reason || ""),
		banUntil: String(row.ban_until || ""),
		mustChangePassword: Number(row.must_change_password || 0) === 1,
		tutorialPromptSeen: Number(row.tutorial_prompt_seen || 0) === 1,
		manualPlaybackHintSeen: Number(row.manual_playback_hint_seen || 0) === 1,
		tutorialPlaybackCoachSeen: Number(row.tutorial_playback_coach_seen || 0) === 1,
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


const SSP_BINARY_PREFIX = Buffer.from("LORANA_SSP2\0", "ascii");
const JSON_BINARY_PREFIX = Buffer.from("LORANA_JSON2\0", "ascii");
const MAX_LEGACY_JSON_BYTES = 64 * 1024 * 1024;

function compressDocument(value: unknown): Buffer {
	if (Buffer.isBuffer(value)) return Buffer.concat([SSP_BINARY_PREFIX, value]);
	// New JSON records are stored directly. SQLite already accounts for their
	// size, and avoiding synchronous level-9 deflate keeps large saves off the
	// event-loop hot path. Legacy compressed records remain readable below.
	return Buffer.concat([JSON_BINARY_PREFIX, Buffer.from(JSON.stringify(value), "utf-8")]);
}

function decompressDocument(value: Buffer): unknown {
	if (value.subarray(0, SSP_BINARY_PREFIX.length).equals(SSP_BINARY_PREFIX)) return value.subarray(SSP_BINARY_PREFIX.length);
	if (value.subarray(0, JSON_BINARY_PREFIX.length).equals(JSON_BINARY_PREFIX)) return JSON.parse(value.subarray(JSON_BINARY_PREFIX.length).toString("utf-8"));
	return JSON.parse(inflateRawSync(value, { maxOutputLength: MAX_LEGACY_JSON_BYTES }).toString("utf-8"));
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
				username TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
				nickname TEXT NOT NULL DEFAULT '',
				avatar_url TEXT NOT NULL DEFAULT '',
				display_name TEXT NOT NULL DEFAULT '',
				password_hash TEXT NOT NULL,
				role TEXT NOT NULL DEFAULT 'user',
				account_group TEXT NOT NULL DEFAULT 'default',
				quota_mb_override INTEGER,
				retention_days_override INTEGER,
				status TEXT NOT NULL DEFAULT 'active',
				ban_reason TEXT NOT NULL DEFAULT '',
				ban_until TEXT NOT NULL DEFAULT '',
				must_change_password INTEGER NOT NULL DEFAULT 0,
				tutorial_prompt_seen INTEGER NOT NULL DEFAULT 0,
				manual_playback_hint_seen INTEGER NOT NULL DEFAULT 0,
				tutorial_playback_coach_seen INTEGER NOT NULL DEFAULT 0,
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
			CREATE INDEX IF NOT EXISTS idx_account_sessions_expiry ON account_sessions(expires_at_ms);

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
			CREATE INDEX IF NOT EXISTS idx_account_devices_expiry ON account_devices(expires_at_ms);

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
			CREATE INDEX IF NOT EXISTS idx_account_codes_expiry ON account_verification_codes(expires_at_ms);

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
				last_activity_at TEXT NOT NULL,
				archived INTEGER NOT NULL DEFAULT 0,
				FOREIGN KEY(user_id) REFERENCES account_users(id) ON DELETE SET NULL
			);
			CREATE INDEX IF NOT EXISTS idx_editor_projects_user ON editor_projects(user_id, updated_at DESC);
			CREATE TABLE IF NOT EXISTS editor_project_shares (
				token TEXT PRIMARY KEY,
				project_id TEXT NOT NULL UNIQUE,
				created_by TEXT NOT NULL,
				created_at TEXT NOT NULL,
				FOREIGN KEY(project_id) REFERENCES editor_projects(id) ON DELETE CASCADE,
				FOREIGN KEY(created_by) REFERENCES account_users(id) ON DELETE CASCADE
			);

			CREATE TABLE IF NOT EXISTS account_effect_presets (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				name TEXT NOT NULL,
				kind TEXT NOT NULL DEFAULT 'screen',
				folder_id TEXT NOT NULL DEFAULT '',
				preset_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				FOREIGN KEY(user_id) REFERENCES account_users(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_effect_presets_user ON account_effect_presets(user_id, updated_at DESC);
			CREATE TABLE IF NOT EXISTS account_effect_folders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES account_users(id) ON DELETE CASCADE);
			CREATE INDEX IF NOT EXISTS idx_effect_folders_user ON account_effect_folders(user_id, updated_at DESC);
			CREATE TABLE IF NOT EXISTS effect_preset_shares (code TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, preset_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(created_by) REFERENCES account_users(id) ON DELETE CASCADE);

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
		const columns = new Set((this.db.prepare("PRAGMA table_info(account_users)").all() as SqlRow[]).map((row) => String(row.name || "")));
		if (!columns.has("username")) this.db.exec("ALTER TABLE account_users ADD COLUMN username TEXT NOT NULL DEFAULT '' COLLATE NOCASE");
		if (!columns.has("nickname")) this.db.exec("ALTER TABLE account_users ADD COLUMN nickname TEXT NOT NULL DEFAULT ''");
		if (!columns.has("avatar_url")) this.db.exec("ALTER TABLE account_users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''");
		if (!columns.has("account_group")) this.db.exec("ALTER TABLE account_users ADD COLUMN account_group TEXT NOT NULL DEFAULT 'default'");
		if (!columns.has("quota_mb_override")) this.db.exec("ALTER TABLE account_users ADD COLUMN quota_mb_override INTEGER");
		if (!columns.has("retention_days_override")) this.db.exec("ALTER TABLE account_users ADD COLUMN retention_days_override INTEGER");
		if (!columns.has("tutorial_prompt_seen")) this.db.exec("ALTER TABLE account_users ADD COLUMN tutorial_prompt_seen INTEGER NOT NULL DEFAULT 0");
		if (!columns.has("manual_playback_hint_seen")) this.db.exec("ALTER TABLE account_users ADD COLUMN manual_playback_hint_seen INTEGER NOT NULL DEFAULT 0");
		if (!columns.has("tutorial_playback_coach_seen")) this.db.exec("ALTER TABLE account_users ADD COLUMN tutorial_playback_coach_seen INTEGER NOT NULL DEFAULT 0");
		const projectColumns = new Set((this.db.prepare("PRAGMA table_info(editor_projects)").all() as SqlRow[]).map((row) => String(row.name || "")));
		if (!projectColumns.has("last_activity_at")) {
			this.db.exec("ALTER TABLE editor_projects ADD COLUMN last_activity_at TEXT NOT NULL DEFAULT ''");
			this.db.exec("UPDATE editor_projects SET last_activity_at = updated_at WHERE last_activity_at = ''");
		}
		const shareColumns = new Set((this.db.prepare("PRAGMA table_info(editor_project_shares)").all() as SqlRow[]).map((row) => String(row.name || "")));
		if (!shareColumns.has("expiry_mode")) this.db.exec("ALTER TABLE editor_project_shares ADD COLUMN expiry_mode TEXT NOT NULL DEFAULT 'project'");
		if (!shareColumns.has("expires_at")) this.db.exec("ALTER TABLE editor_project_shares ADD COLUMN expires_at TEXT NOT NULL DEFAULT ''");
		const presetColumns = new Set((this.db.prepare("PRAGMA table_info(account_effect_presets)").all() as SqlRow[]).map((row) => String(row.name || "")));
		if (!presetColumns.has("kind")) this.db.exec("ALTER TABLE account_effect_presets ADD COLUMN kind TEXT NOT NULL DEFAULT 'screen'");
		if (!presetColumns.has("folder_id")) this.db.exec("ALTER TABLE account_effect_presets ADD COLUMN folder_id TEXT NOT NULL DEFAULT ''");
		const legacyUsers = this.db.prepare("SELECT id, email, display_name, username, nickname FROM account_users").all() as SqlRow[];
		const updateLegacy = this.db.prepare("UPDATE account_users SET username = ?, nickname = ?, display_name = ? WHERE id = ?");
		for (const row of legacyUsers) {
			const id = String(row.id || "");
			let username = String(row.username || "").trim();
			if (!isValidUsername(username)) username = fallbackUsername(String(row.display_name || String(row.email || "").split("@")[0]), id);
			while (this.db.prepare("SELECT 1 FROM account_users WHERE username = ? COLLATE NOCASE AND id <> ? LIMIT 1").get(username, id)) {
				username = fallbackUsername(username, crypto.randomUUID());
			}
			const nickname = String(row.nickname || row.display_name || username).trim().slice(0, 80) || username;
			updateLegacy.run(username, nickname, nickname, id);
		}
		this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_account_users_username ON account_users(username COLLATE NOCASE)");
	}

	async createUser(input: {
		email: string;
		password: string;
		username: string;
		nickname?: string;
		avatarUrl?: string;
		role?: AccountRole;
		group?: string;
		mustChangePassword?: boolean;
	}): Promise<AccountUser> {
		const email = normalizeEmail(input.email);
		const username = String(input.username || "").trim();
		if (!isValidUsername(username)) throw new Error("invalid_username");
		const nickname = String(input.nickname || username).trim().slice(0, 80) || username;
		const now = nowIso();
		const id = crypto.randomUUID();
		this.db.prepare(`
			INSERT INTO account_users (
				id, email, username, nickname, avatar_url, display_name, password_hash, role, account_group, status,
				must_change_password, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
		`).run(
			id,
			email,
			username,
			nickname,
			String(input.avatarUrl || "").slice(0, 2048),
			nickname,
			await passwordHash(input.password),
			input.role === "admin" ? "admin" : "user",
			String(input.group || "default").trim().slice(0, 40) || "default",
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

	getUserByIdentity(identity: string): AccountUser | null {
		const value = String(identity || "").trim();
		if (!value) return null;
		const row = this.db.prepare(`SELECT * FROM account_users
			WHERE email = ? COLLATE NOCASE
				OR username = ? COLLATE NOCASE
			ORDER BY CASE WHEN email = ? COLLATE NOCASE THEN 0 ELSE 1 END LIMIT 1`)
			.get(normalizeEmail(value), value, normalizeEmail(value)) as SqlRow | undefined;
		return row ? rowToUser(row) : null;
	}

	getAdminByDisplayName(displayName: string): AccountUser | null {
		const value = String(displayName || "").trim();
		if (!value) return null;
		const row = this.db.prepare("SELECT * FROM account_users WHERE role = 'admin' AND username = ? COLLATE NOCASE LIMIT 1").get(value) as SqlRow | undefined;
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
		if (!row) { await passwordMatches(password, DUMMY_PASSWORD_HASH); return null; }
		if (!(await passwordMatches(password, String(row.password_hash || "")))) return null;
		return rowToUser(row);
	}

	async verifyPasswordIdentity(identity: string, password: string): Promise<AccountUser | null> {
		const user = this.getUserByIdentity(identity);
		if (!user) { await passwordMatches(password, DUMMY_PASSWORD_HASH); return null; }
		const row = this.db.prepare("SELECT password_hash FROM account_users WHERE id = ?").get(user.id) as SqlRow | undefined;
		if (!row || !(await passwordMatches(password, String(row.password_hash || "")))) return null;
		return user;
	}

	async updatePassword(userId: string, password: string, mustChange = false): Promise<void> {
		this.db.prepare("UPDATE account_users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?")
			.run(await passwordHash(password), mustChange ? 1 : 0, nowIso(), userId);
		this.revokeSessions(userId);
	}

	async completeInitialCredentials(userId: string, input: { email: string; username: string; nickname?: string; password: string }) {
		const email = normalizeEmail(input.email);
		const username = String(input.username || "").trim();
		const nickname = String(input.nickname || username).trim().slice(0, 80) || username;
		this.db.prepare(`UPDATE account_users SET email = ?, username = ?, nickname = ?, display_name = ?, password_hash = ?,
			must_change_password = 0, updated_at = ? WHERE id = ?`)
			.run(email, username, nickname, nickname, await passwordHash(input.password), nowIso(), userId);
		this.revokeSessions(userId);
		return this.getUserById(userId);
	}

	updateUser(userId: string, input: Partial<{ email: string; username: string; nickname: string; displayName: string; avatarUrl: string; role: AccountRole; group: string; quotaMbOverride: number | null; retentionDaysOverride: number | null }>) {
		const current = this.getUserById(userId);
		if (!current) return null;
		const email = input.email ? normalizeEmail(input.email) : current.email;
		const username = input.username === undefined ? current.username : String(input.username).trim();
		const nicknameInput = input.nickname === undefined ? input.displayName : input.nickname;
		const nickname = nicknameInput === undefined ? current.nickname : String(nicknameInput).trim().slice(0, 80) || username;
		const avatarUrl = input.avatarUrl === undefined ? current.avatarUrl : String(input.avatarUrl).trim().slice(0, 2048);
		const role = input.role || current.role;
		const group = input.group === undefined ? current.group : String(input.group).trim().slice(0, 40) || "default";
		const quotaMbOverride = input.quotaMbOverride === undefined
			? current.quotaMbOverride
			: input.quotaMbOverride === null ? null : Math.max(1, Math.floor(Number(input.quotaMbOverride)));
		const retentionDaysOverride = input.retentionDaysOverride === undefined
			? current.retentionDaysOverride
			: input.retentionDaysOverride === null ? null : Math.max(0, Math.floor(Number(input.retentionDaysOverride)));
		this.db.prepare("UPDATE account_users SET email = ?, username = ?, nickname = ?, avatar_url = ?, display_name = ?, role = ?, account_group = ?, quota_mb_override = ?, retention_days_override = ?, updated_at = ? WHERE id = ?")
			.run(email, username, nickname, avatarUrl, nickname, role, group, quotaMbOverride, retentionDaysOverride, nowIso(), userId);
		return this.getUserById(userId);
	}

	markOnboarding(userId: string, input: { tutorialPromptSeen?: boolean; manualPlaybackHintSeen?: boolean; tutorialPlaybackCoachSeen?: boolean }) {
		const current = this.getUserById(userId);
		if (!current) return null;
		this.db.prepare(`UPDATE account_users SET
			tutorial_prompt_seen = CASE WHEN ? = 1 THEN 1 ELSE tutorial_prompt_seen END,
			manual_playback_hint_seen = CASE WHEN ? = 1 THEN 1 ELSE manual_playback_hint_seen END,
			tutorial_playback_coach_seen = CASE WHEN ? = 1 THEN 1 ELSE tutorial_playback_coach_seen END,
			updated_at = ? WHERE id = ?`)
			.run(input.tutorialPromptSeen ? 1 : 0, input.manualPlaybackHintSeen ? 1 : 0, input.tutorialPlaybackCoachSeen ? 1 : 0, nowIso(), userId);
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

	normalizeAdminGroup(adminGroup: string, defaultGroup: string): void {
		const safeAdminGroup = String(adminGroup || "admin").trim().slice(0, 40) || "admin";
		const safeDefaultGroup = String(defaultGroup || "default").trim().slice(0, 40) || "default";
		this.db.prepare("UPDATE account_users SET account_group = ?, updated_at = ? WHERE role = 'admin' AND account_group <> ?")
			.run(safeAdminGroup, nowIso(), safeAdminGroup);
		this.db.prepare("UPDATE account_users SET account_group = ?, updated_at = ? WHERE role <> 'admin' AND account_group = ?")
			.run(safeDefaultGroup, nowIso(), safeAdminGroup);
	}

	listUsers(query = "", page = 1, pageSize = 20) {
		const normalized = query.trim().toLowerCase();
		const where = normalized ? "WHERE lower(email) LIKE @like OR lower(username) LIKE @like OR lower(nickname) LIKE @like" : "";
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

	projectStorageBytes(userId: string): number {
		return Number((this.db.prepare("SELECT COALESCE(SUM(length(document_blob)), 0) AS total FROM editor_projects WHERE user_id = ? AND archived = 0").get(userId) as SqlRow).total || 0);
	}

	cleanupInactiveProjects(retentionDaysForUser: (user: AccountUser) => number) {
		const users = (this.db.prepare("SELECT * FROM account_users").all() as SqlRow[]).map(rowToUser);
		let deletedProjects = 0;
		let freedBytes = 0;
		const cleanup = this.db.transaction(() => {
			for (const user of users) {
				const retentionDays = Math.max(0, Math.floor(retentionDaysForUser(user)));
				if (retentionDays === 0) continue;
				const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
				const summary = this.db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(length(document_blob)), 0) AS bytes
					FROM editor_projects WHERE user_id = ? AND archived = 0 AND last_activity_at < ?`).get(user.id, cutoff) as SqlRow;
				const count = Number(summary.total || 0);
				if (!count) continue;
				freedBytes += Number(summary.bytes || 0);
				deletedProjects += this.db.prepare("DELETE FROM editor_projects WHERE user_id = ? AND archived = 0 AND last_activity_at < ?").run(user.id, cutoff).changes;
			}
		});
		cleanup();
		return { deletedProjects, freedBytes };
	}

	createSession(user: AccountUser, input: { sessionDays: number; deviceToken?: string; ipPrefix: string; userAgent: string }): AccountSession {
		this.db.prepare("DELETE FROM account_sessions WHERE expires_at_ms <= ?").run(Date.now());
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
		this.db.prepare("DELETE FROM account_devices WHERE expires_at_ms <= ?").run(Date.now());
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
		// Keep enough history for the hourly rate limit while preventing an
		// internet-facing instance from retaining expired codes forever.
		this.db.prepare("DELETE FROM account_verification_codes WHERE expires_at_ms < ?").run(now - 86400000);
		this.db.prepare(`INSERT INTO account_verification_codes (
			id, email, purpose, code_hash, ip_prefix_hash, created_at_ms, expires_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(id, normalizeEmail(email), purpose, sha256(`${id}:${code}`), sha256(ipPrefix), now, now + ttlMinutes * 60000);
		return id;
	}

	verifyCode(id: string, email: string, purpose: string, code: string, consume = true): boolean {
		const row = this.db.prepare(`SELECT * FROM account_verification_codes
			WHERE id = ? AND email = ? COLLATE NOCASE AND purpose = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?`)
			.get(id, normalizeEmail(email), purpose, Date.now()) as SqlRow | undefined;
		if (!row || Number(row.attempts || 0) >= 5) return false;
		const valid = String(row.code_hash) === sha256(`${id}:${code}`);
		if (!valid || consume) {
			this.db.prepare(`UPDATE account_verification_codes SET attempts = attempts + 1,
				consumed_at_ms = CASE WHEN ? THEN ? ELSE consumed_at_ms END WHERE id = ?`)
				.run(valid && consume ? 1 : 0, Date.now(), id);
		}
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

	createProject(userId: string, title: string, document: unknown, source: { key?: string; revision?: string; encryptedSecret?: string } = {}, limits?: { quotaBytes: number; maxProjects: number }) {
		const id = crypto.randomUUID();
		const now = nowIso();
		const blob = compressDocument(document);
		const insert = this.db.transaction(() => {
			if (limits && this.projectCount(userId) >= limits.maxProjects) throw new Error("project_limit_reached");
			if (limits && this.projectStorageBytes(userId) + blob.length > limits.quotaBytes) throw new Error("storage_quota_exceeded");
			this.db.prepare(`INSERT INTO editor_projects (
			id, user_id, title, revision, document_blob, source_key, source_revision,
			source_secret_cipher, created_at, updated_at, last_activity_at
		) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
				.run(id, userId, title.slice(0, 160) || "跑团记录", blob, source.key || "", source.revision || "", source.encryptedSecret || "", now, now, now);
		});
		insert();
		return this.getProject(userId, id);
	}

	listProjects(userId: string): EditorProjectSummary[] {
		return (this.db.prepare(`SELECT id, title, revision, source_key, source_revision, created_at, updated_at, last_activity_at, length(document_blob) AS stored_bytes
			FROM editor_projects WHERE user_id = ? AND archived = 0 ORDER BY updated_at DESC`).all(userId) as SqlRow[])
			.map((row) => ({
				id: String(row.id), title: String(row.title), revision: Number(row.revision),
				sourceKey: String(row.source_key || ""), sourceRevision: String(row.source_revision || ""),
				createdAt: String(row.created_at), updatedAt: String(row.updated_at), lastActivityAt: String(row.last_activity_at || row.updated_at), storedBytes: Number(row.stored_bytes || 0),
			}));
	}

	getProjectShareInfo(userId: string, id: string) {
		const row = this.db.prepare("SELECT id, last_activity_at, updated_at FROM editor_projects WHERE id = ? AND user_id = ? AND archived = 0").get(id, userId) as SqlRow | undefined;
		return row ? { id: String(row.id), lastActivityAt: String(row.last_activity_at || row.updated_at) } : null;
	}

	listAllProjects(page = 1, pageSize = 50) {
		const limit = Math.min(100, Math.max(1, pageSize));
		const offset = Math.max(0, page - 1) * limit;
		const total = Number((this.db.prepare("SELECT COUNT(*) AS total FROM editor_projects WHERE archived = 0").get() as SqlRow).total || 0);
		const rows = this.db.prepare(`SELECT p.id, p.title, p.revision, p.source_key, p.source_revision,
			p.created_at, p.updated_at, p.user_id, u.username, u.nickname, u.email
			FROM editor_projects p LEFT JOIN account_users u ON u.id = p.user_id
			WHERE p.archived = 0 ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as SqlRow[];
		return { items: rows.map((row) => ({
			id: String(row.id), title: String(row.title), revision: Number(row.revision), sourceKey: String(row.source_key || ""),
			sourceRevision: String(row.source_revision || ""), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
			userId: String(row.user_id || ""), username: String(row.username || ""), nickname: String(row.nickname || ""), email: String(row.email || ""),
		})), total, page, pageSize: limit };
	}

	getProjectAsAdmin(id: string) {
		const row = this.db.prepare(`SELECT p.*, u.username, u.nickname, u.email FROM editor_projects p
			LEFT JOIN account_users u ON u.id = p.user_id WHERE p.id = ? AND p.archived = 0`).get(id) as SqlRow | undefined;
		if (!row) return null;
		return { id: String(row.id), title: String(row.title), revision: Number(row.revision), document: decompressDocument(row.document_blob as Buffer),
			owner: { id: String(row.user_id || ""), username: String(row.username || ""), nickname: String(row.nickname || ""), email: String(row.email || "") },
			createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
	}

	getProject(userId: string, id: string) {
		const row = this.db.prepare("SELECT * FROM editor_projects WHERE id = ? AND user_id = ? AND archived = 0").get(id, userId) as SqlRow | undefined;
		if (!row) return null;
		this.db.prepare("UPDATE editor_projects SET last_activity_at = ? WHERE id = ? AND user_id = ?").run(nowIso(), id, userId);
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

	updateProject(userId: string, id: string, expectedRevision: number, document: unknown, title?: string, limits?: { quotaBytes: number; maxProjects: number }) {
		const blob = compressDocument(document);
		const update = this.db.transaction(() => {
			const current = this.db.prepare("SELECT revision, length(document_blob) AS stored_bytes FROM editor_projects WHERE id = ? AND user_id = ? AND archived = 0").get(id, userId) as SqlRow | undefined;
			if (!current) return null;
			if (Number(current.revision || 0) !== expectedRevision) return null;
			if (limits && this.projectStorageBytes(userId) - Number(current.stored_bytes || 0) + blob.length > limits.quotaBytes) throw new Error("storage_quota_exceeded");
			const now = nowIso();
			const result = this.db.prepare(`UPDATE editor_projects SET document_blob = ?, title = COALESCE(?, title),
			revision = revision + 1, updated_at = ?, last_activity_at = ? WHERE id = ? AND user_id = ? AND revision = ? AND archived = 0`)
				.run(blob, title ? title.slice(0, 160) : null, now, now, id, userId, expectedRevision);
			return result.changes === 1 ? this.getProject(userId, id) : null;
		});
		return update();
	}

	deleteProject(userId: string, id: string) {
		return this.db.prepare("DELETE FROM editor_projects WHERE id = ? AND user_id = ?").run(id, userId).changes === 1;
	}

	shareProject(userId: string, id: string, expiryMode: "project" | "fixed" = "project", expiresAt = "") {
		const project = this.db.prepare("SELECT id FROM editor_projects WHERE id = ? AND user_id = ? AND archived = 0").get(id, userId) as SqlRow | undefined;
		if (!project) return null;
		const existing = this.db.prepare("SELECT token FROM editor_project_shares WHERE project_id = ?").get(id) as SqlRow | undefined;
		if (existing) {
			this.db.prepare("UPDATE editor_project_shares SET expiry_mode = ?, expires_at = ? WHERE project_id = ?").run(expiryMode, expiresAt, id);
			return { token: String(existing.token), expiryMode, expiresAt };
		}
		const token = randomToken(18);
		this.db.prepare("INSERT INTO editor_project_shares (token, project_id, created_by, created_at, expiry_mode, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(token, id, userId, nowIso(), expiryMode, expiresAt);
		return { token, expiryMode, expiresAt };
	}

	getSharedProject(token: string) {
		const row = this.db.prepare(`SELECT
			p.id AS project_id, p.title, p.revision, p.document_blob,
			p.created_at AS project_created_at, p.updated_at AS project_updated_at, p.last_activity_at,
			s.expiry_mode AS share_expiry_mode, s.expires_at AS share_expires_at,
			u.id AS owner_id, u.account_group AS owner_account_group,
			u.retention_days_override AS owner_retention_days_override
			FROM editor_project_shares s
			JOIN editor_projects p ON p.id = s.project_id
			JOIN account_users u ON u.id = p.user_id
			WHERE s.token = ? AND p.archived = 0`).get(token) as SqlRow | undefined;
		if (!row) return null;
		return {
			id: String(row.project_id), title: String(row.title), revision: Number(row.revision),
			document: decompressDocument(row.document_blob as Buffer), createdAt: String(row.project_created_at), updatedAt: String(row.project_updated_at),
			lastActivityAt: String(row.last_activity_at || row.project_updated_at),
			shareExpiryMode: String(row.share_expiry_mode || ""),
			shareExpiresAt: String(row.share_expires_at || ""),
			owner: {
				id: String(row.owner_id || ""),
				group: String(row.owner_account_group || "default"),
				quotaMbOverride: null,
				retentionDaysOverride: row.owner_retention_days_override === null || row.owner_retention_days_override === undefined
					? null
					: Math.max(0, Number(row.owner_retention_days_override)),
			},
		};
	}

	listEffectPresets(userId: string) {
		return (this.db.prepare("SELECT id, name, kind, folder_id, preset_json, created_at, updated_at FROM account_effect_presets WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as SqlRow[]).map((row) => ({ id: String(row.id), name: String(row.name), kind: String(row.kind || "screen"), folderId: String(row.folder_id || ""), config: JSON.parse(String(row.preset_json)), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }));
	}

	effectPresetCount(userId: string) { return Number((this.db.prepare("SELECT COUNT(*) AS total FROM account_effect_presets WHERE user_id = ?").get(userId) as SqlRow).total || 0); }
	effectFolderCount(userId: string) { return Number((this.db.prepare("SELECT COUNT(*) AS total FROM account_effect_folders WHERE user_id = ?").get(userId) as SqlRow).total || 0); }
	createEffectPreset(userId: string, name: string, config: unknown, folderId = "", kind = "screen") {
		const id = crypto.randomUUID(); const now = nowIso();
		this.db.prepare("INSERT INTO account_effect_presets (id, user_id, name, kind, folder_id, preset_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, userId, name.slice(0, 60), kind, folderId, JSON.stringify(config), now, now);
		return this.listEffectPresets(userId).find((item) => item.id === id);
	}

	updateEffectPreset(userId: string, id: string, name: string, config: unknown, folderId = "", kind = "screen") {
		const result = this.db.prepare("UPDATE account_effect_presets SET name = ?, kind = ?, folder_id = ?, preset_json = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(name.slice(0, 60), kind, folderId, JSON.stringify(config), nowIso(), id, userId);
		return result.changes ? this.listEffectPresets(userId).find((item) => item.id === id) : null;
	}

	deleteEffectPreset(userId: string, id: string) {
		return this.db.prepare("DELETE FROM account_effect_presets WHERE id = ? AND user_id = ?").run(id, userId).changes === 1;
	}
	listEffectFolders(userId: string) { return (this.db.prepare("SELECT id, name FROM account_effect_folders WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as SqlRow[]).map((row) => ({ id: String(row.id), name: String(row.name) })); }
	createEffectFolder(userId: string, name: string) { const id = crypto.randomUUID(); const now = nowIso(); this.db.prepare("INSERT INTO account_effect_folders (id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(id,userId,name.slice(0,40),now,now); return { id, name: name.slice(0,40) }; }
	renameEffectFolder(userId: string, id: string, name: string) { return this.db.prepare("UPDATE account_effect_folders SET name=?,updated_at=? WHERE id=? AND user_id=?").run(name.slice(0,40),nowIso(),id,userId).changes === 1; }
	deleteEffectFolder(userId: string, id: string) { const transaction=this.db.transaction(()=>{this.db.prepare("UPDATE account_effect_presets SET folder_id='' WHERE user_id=? AND folder_id=?").run(userId,id);return this.db.prepare("DELETE FROM account_effect_folders WHERE id=? AND user_id=?").run(id,userId).changes===1});return transaction(); }
	createEffectShare(userId: string, presetId: string) {
		const preset = this.db.prepare("SELECT name,kind,preset_json FROM account_effect_presets WHERE id=? AND user_id=?").get(presetId, userId) as SqlRow | undefined;
		if (!preset) return null;
		const excess = Number((this.db.prepare("SELECT COUNT(*) AS total FROM effect_preset_shares WHERE created_by=?").get(userId) as SqlRow).total || 0) - MAX_EFFECT_SHARES_PER_USER + 1;
		if (excess > 0) {
			this.db.prepare("DELETE FROM effect_preset_shares WHERE code IN (SELECT code FROM effect_preset_shares WHERE created_by=? ORDER BY created_at ASC LIMIT ?)").run(userId, excess);
		}
		let code = "";
		do { code = `LT-${crypto.randomBytes(6).toString("base64url").toUpperCase()}`; }
		while (this.db.prepare("SELECT 1 FROM effect_preset_shares WHERE code=?").get(code));
		this.db.prepare("INSERT INTO effect_preset_shares (code,name,kind,preset_json,created_by,created_at) VALUES (?,?,?,?,?,?)").run(code, preset.name, preset.kind, preset.preset_json, userId, nowIso());
		return { code };
	}
	getEffectShare(code:string){const row=this.db.prepare("SELECT name,kind,preset_json FROM effect_preset_shares WHERE code=?").get(code.toUpperCase()) as SqlRow|undefined;return row?{name:String(row.name),kind:String(row.kind),config:JSON.parse(String(row.preset_json))}:null;}

	deleteUser(userId: string, projectAction: "delete" | "archive" | "transfer", transferUserId = "") {
		const transaction = this.db.transaction(() => {
			if (projectAction === "delete") this.db.prepare("DELETE FROM editor_projects WHERE user_id = ?").run(userId);
			if (projectAction === "archive") this.db.prepare("UPDATE editor_projects SET user_id = NULL, archived = 1 WHERE user_id = ?").run(userId);
			if (projectAction === "transfer") {
				const now = nowIso();
				this.db.prepare("UPDATE editor_projects SET user_id = ?, updated_at = ?, last_activity_at = ? WHERE user_id = ?").run(transferUserId, now, now, userId);
			}
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

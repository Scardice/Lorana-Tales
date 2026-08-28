import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
	type AddLogRecordInput,
	type CleanupLogsResult,
	type DatabaseMaintenanceResult,
	type DeleteLogsResult,
	deriveLogRecord,
	type LogDetail,
	type LogListOptions,
	type LogListResult,
	type LogMetadata,
	type LogMetrics,
	type LogStore,
	normalizeMetadata,
} from "./log-store.js";

type SqlRow = Record<string, unknown>;
const RECORD_STORAGE_OVERHEAD_BYTES = 64 * 1024;

const MIGRATIONS = [
	{
		version: 1,
		sql: `
      CREATE TABLE log_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        client TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        uploader_ip TEXT NOT NULL DEFAULT 'unknown',
        uniform_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        stored_bytes INTEGER NOT NULL DEFAULT 0,
        encoded_bytes INTEGER NOT NULL DEFAULT 0,
        compressed_bytes INTEGER NOT NULL DEFAULT 0,
        decoded_bytes INTEGER NOT NULL DEFAULT 0,
        decode_error TEXT NOT NULL DEFAULT '',
        payload_sha256 TEXT NOT NULL
      );

      CREATE TABLE log_payloads (
        log_id INTEGER PRIMARY KEY,
        stored_json TEXT NOT NULL,
        FOREIGN KEY (log_id) REFERENCES log_records(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_log_records_created_at_ms ON log_records(created_at_ms DESC);
      CREATE INDEX idx_log_records_public_key ON log_records(public_key);
      CREATE INDEX idx_log_records_name ON log_records(name);
      CREATE INDEX idx_log_records_uploader_ip ON log_records(uploader_ip);
      CREATE INDEX idx_log_records_uniform_id ON log_records(uniform_id);
    `,
	},
	{
		version: 2,
		sql: `
      ALTER TABLE log_records ADD COLUMN access_password TEXT NOT NULL DEFAULT '';
    `,
	},
];

function sha256(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function timestampMs(value: string): number {
	const parsed = Date.parse(value || "");
	return Number.isNaN(parsed) ? Date.now() : parsed;
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
	const parsed = parseInt(String(value || ""), 10);
	if (Number.isNaN(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function rowToMetadata(row): LogMetadata {
	const accessPassword = String(row.access_password || "");
	const viewUrl = accessPassword
		? `/?key=${encodeURIComponent(String(row.public_key))}#${encodeURIComponent(accessPassword)}`
		: undefined;

	return normalizeMetadata(String(row.public_key), {
		viewUrl,
		name: row.name,
		client: row.client,
		version: "",
		note: row.note,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		uploaderIp: row.uploader_ip,
		uniformId: row.uniform_id,
		messageCount: row.message_count,
		size: {
			storedBytes: row.stored_bytes,
			encodedBytes: row.encoded_bytes,
			compressedBytes: row.compressed_bytes,
			decodedBytes: row.decoded_bytes,
		},
		decodeError: row.decode_error,
	});
}

export class SqliteLogStore implements LogStore {
	db: Database.Database;
	dbPath: string;
	maxTotalBytes: number;

	constructor(dbPath: string, options: { maxTotalBytes?: number } = {}) {
		this.dbPath = dbPath === ":memory:" ? dbPath : path.resolve(dbPath);
		this.maxTotalBytes = Math.max(1, Number(options.maxTotalBytes || 4096 * 1024 * 1024));
		if (this.dbPath !== ":memory:") fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
		this.db = new Database(this.dbPath);

		this.db.pragma("journal_mode = WAL");
		this.db.pragma("synchronous = NORMAL");
		this.db.pragma("foreign_keys = ON");
		this.db.pragma("busy_timeout = 5000");
		this.db.pragma(`journal_size_limit = ${Math.min(64 * 1024 * 1024, Math.max(1024 * 1024, Math.floor(this.maxTotalBytes / 16)))}`);
		this.migrate();
	}

	private migrate(): void {
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

		const applied = new Set(
			(
				this.db
					.prepare("SELECT version FROM schema_migrations")
					.all() as SqlRow[]
			).map((row) => Number(row.version)),
		);

		const insertMigration = this.db.prepare(
			"INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
		);
		const applyMigration = this.db.transaction((migration) => {
			this.db.exec(migration.sql);
			insertMigration.run(migration.version, new Date().toISOString());
		});

		for (const migration of MIGRATIONS) {
			if (!applied.has(migration.version)) applyMigration(migration);
		}
	}

	async addLogRecord(input: AddLogRecordInput): Promise<LogMetadata> {
		const record = deriveLogRecord(
			input.publicKey,
			input.storedText,
			input.uniformId,
		);
		const metadata = record.metadata;
		const now = new Date().toISOString();
		const createdAt = metadata.createdAt || now;
		const updatedAt = metadata.updatedAt || createdAt;

		const insertRecord = this.db.prepare(`
      INSERT INTO log_records (
        public_key,
        access_password,
        password_hash,
        name,
        client,
        note,
        uploader_ip,
        uniform_id,
        created_at,
        updated_at,
        created_at_ms,
        updated_at_ms,
        message_count,
        stored_bytes,
        encoded_bytes,
        compressed_bytes,
        decoded_bytes,
        decode_error,
        payload_sha256
      ) VALUES (
        @publicKey,
        @accessPassword,
        @passwordHash,
        @name,
        @client,
        @note,
        @uploaderIp,
        @uniformId,
        @createdAt,
        @updatedAt,
        @createdAtMs,
        @updatedAtMs,
        @messageCount,
        @storedBytes,
        @encodedBytes,
        @compressedBytes,
        @decodedBytes,
        @decodeError,
        @payloadSha256
      )
    `);
		const insertPayload = this.db.prepare(
			"INSERT INTO log_payloads (log_id, stored_json) VALUES (?, ?)",
		);

		const write = this.db.transaction(() => {
			const usage = this.db.prepare("SELECT COALESCE(SUM(stored_bytes), 0) AS total FROM log_records").get() as SqlRow;
			const pageCount = Number(this.db.pragma("page_count", { simple: true }));
			const pageSize = Number(this.db.pragma("page_size", { simple: true }));
			const projectedContentBytes = Number(usage.total || 0) + metadata.size.storedBytes;
			const projectedAllocatedBytes = pageCount * pageSize + metadata.size.storedBytes + RECORD_STORAGE_OVERHEAD_BYTES;
			if (Math.max(projectedContentBytes, projectedAllocatedBytes) > this.maxTotalBytes) {
				throw new Error("log_storage_quota_exceeded");
			}
			const result = insertRecord.run({
				publicKey: input.publicKey,
				accessPassword: input.password,
				passwordHash: sha256(input.password),
				name: metadata.name,
				client: metadata.client,
				note: metadata.note,
				uploaderIp: metadata.uploaderIp,
				uniformId: input.uniformId,
				createdAt,
				updatedAt,
				createdAtMs: timestampMs(createdAt),
				updatedAtMs: timestampMs(updatedAt),
				messageCount: metadata.messageCount,
				storedBytes: metadata.size.storedBytes,
				encodedBytes: metadata.size.encodedBytes,
				compressedBytes: metadata.size.compressedBytes,
				decodedBytes: metadata.size.decodedBytes,
				decodeError: metadata.decodeError,
				payloadSha256: sha256(input.storedText),
			});
			insertPayload.run(result.lastInsertRowid, input.storedText);
		});

		write();
		return normalizeMetadata(input.publicKey, {
			...metadata,
			key: input.publicKey,
			viewUrl: `/?key=${encodeURIComponent(input.publicKey)}#${encodeURIComponent(input.password)}`,
			uniformId: input.uniformId,
			createdAt,
			updatedAt,
		});
	}

	async readPublicLog(
		publicKey: string,
		password: string,
	): Promise<string | null> {
		const row = this.db
			.prepare(
				`
        SELECT p.stored_json
        FROM log_records r
        JOIN log_payloads p ON p.log_id = r.id
        WHERE r.public_key = ? AND r.password_hash = ?
      `,
			)
			.get(publicKey, sha256(password)) as SqlRow | undefined;
		return row?.stored_json === undefined ? null : String(row.stored_json);
	}

	async listLogMetadata(options: LogListOptions = {}): Promise<LogListResult> {
		const page = clampInt(options.page, 1, 1, Number.MAX_SAFE_INTEGER);
		const pageSize = clampInt(options.pageSize, 20, 1, 100);
		const query = String(options.query || "")
			.trim()
			.toLowerCase();
		const offset = (page - 1) * pageSize;

		const where = query
			? `WHERE
          lower(public_key) LIKE @like ESCAPE '\\'
          OR lower(name) LIKE @like ESCAPE '\\'
          OR lower(client) LIKE @like ESCAPE '\\'
          OR lower(note) LIKE @like ESCAPE '\\'
          OR lower(uploader_ip) LIKE @like ESCAPE '\\'
          OR lower(uniform_id) LIKE @like ESCAPE '\\'
          OR lower(created_at) LIKE @like ESCAPE '\\'
          OR lower(updated_at) LIKE @like ESCAPE '\\'`
			: "";
		const params = query ? { like: `%${escapeLike(query)}%` } : {};

		const totalRow = this.db
			.prepare(`SELECT COUNT(*) AS total FROM log_records ${where}`)
			.get(params) as SqlRow | undefined;
		const total = Number(totalRow?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / pageSize));
		const currentPage = Math.min(page, totalPages);
		const currentOffset = (currentPage - 1) * pageSize;

		const rows = this.db
			.prepare(
				`
        SELECT *
        FROM log_records
        ${where}
        ORDER BY created_at_ms DESC, public_key DESC
        LIMIT @limit OFFSET @offset
      `,
			)
			.all({
				...params,
				limit: pageSize,
				offset: total === 0 ? offset : currentOffset,
			}) as SqlRow[];

		return {
			items: rows.map(rowToMetadata),
			page: currentPage,
			pageSize,
			total,
			totalPages,
			query,
		};
	}

	async readLogDetail(publicKey: string): Promise<LogDetail | null> {
		const row = this.db
			.prepare(
				`
        SELECT r.*, p.stored_json
        FROM log_records r
        JOIN log_payloads p ON p.log_id = r.id
        WHERE r.public_key = ?
      `,
			)
			.get(publicKey) as SqlRow | undefined;
		if (!row) return null;

		const baseMetadata = rowToMetadata(row);
		const derived = deriveLogRecord(
			String(row.public_key),
			String(row.stored_json),
			String(row.uniform_id),
		);
		return {
			...baseMetadata,
			version: derived.metadata.version,
			content: derived.content,
		};
	}

	async readRawLog(publicKey: string): Promise<string | null> {
		const row = this.db
			.prepare(
				`
        SELECT p.stored_json
        FROM log_records r
        JOIN log_payloads p ON p.log_id = r.id
        WHERE r.public_key = ?
      `,
			)
			.get(publicKey) as SqlRow | undefined;
		return row?.stored_json === undefined ? null : String(row.stored_json);
	}

	async deleteLogs(keys: string[]): Promise<DeleteLogsResult> {
		const uniqueKeys = [
			...new Set(keys.map((key) => String(key || "").trim()).filter(Boolean)),
		];
		const deleted: string[] = [];
		const missing: string[] = [];
		const errors: Array<{ key: string; error: string }> = [];
		const deleteRecord = this.db.prepare(
			"DELETE FROM log_records WHERE public_key = ?",
		);

		const remove = this.db.transaction(() => {
			for (const key of uniqueKeys) {
				try {
					const result = deleteRecord.run(key);
					if (result.changes > 0) deleted.push(key);
					else missing.push(key);
				} catch (error) {
					errors.push({ key, error: error?.message || "delete failed" });
				}
			}
		});

		remove();
		return {
			requested: uniqueKeys.length,
			deleted,
			missing,
			errors,
		};
	}

	async cleanupOldLogs(retentionDays: number): Promise<CleanupLogsResult> {
		const safeRetentionDays = Math.max(1, Number(retentionDays || 1));
		const cutoffMs = Date.now() - safeRetentionDays * 24 * 60 * 60 * 1000;
		const logs: string[] = [];
		const addLog = (message: string) => {
			const line = `[${new Date().toISOString()}] ${message}`;
			logs.push(line);
			console.log(line);
		};

		const processedRow = this.db
			.prepare("SELECT COUNT(*) AS total FROM log_records")
			.get() as SqlRow | undefined;
		const processedCount = Number(processedRow?.total || 0);
		const rows = this.db
			.prepare("SELECT public_key FROM log_records WHERE created_at_ms < ?")
			.all(cutoffMs) as SqlRow[];
		const deleted = rows.map((row) => String(row.public_key));
		const removeOld = this.db.transaction(() => {
			this.db
				.prepare("DELETE FROM log_records WHERE created_at_ms < ?")
				.run(cutoffMs);
		});
		removeOld();

		addLog(
			`SQLite cleanup: ${deleted.length} of ${processedCount} logs older than ${safeRetentionDays} days`,
		);

		return {
			deletedCount: deleted.length,
			processedCount,
			retentionDays: safeRetentionDays,
			deleted,
			errors: [],
			logs,
		};
	}

	async getLogMetrics(): Promise<LogMetrics> {
		const row = this.db
			.prepare(
				`
        SELECT
          COUNT(*) AS total_logs,
          COALESCE(SUM(stored_bytes), 0) AS total_stored_bytes,
          COALESCE(SUM(decoded_bytes), 0) AS total_decoded_bytes,
          COALESCE(MIN(created_at), '') AS oldest_created_at,
          COALESCE(MAX(created_at), '') AS newest_created_at
        FROM log_records
      `,
			)
			.get() as SqlRow | undefined;
		const journalMode = String(
			this.db.pragma("journal_mode", { simple: true }) || "",
		).toLowerCase();
		const pageCount = Number(
			this.db.pragma("page_count", { simple: true }) || 0,
		);
		const pageSize = Number(this.db.pragma("page_size", { simple: true }) || 0);

		return {
			totalLogs: Number(row.total_logs || 0),
			totalStoredBytes: Number(row.total_stored_bytes || 0),
			totalDecodedBytes: Number(row.total_decoded_bytes || 0),
			oldestCreatedAt: String(row.oldest_created_at || ""),
			newestCreatedAt: String(row.newest_created_at || ""),
			walEnabled: journalMode === "wal",
			sqlitePageCount: pageCount,
			sqlitePageSize: pageSize,
		};
	}

	async maintainDatabase(
		options: { vacuum?: boolean } = {},
	): Promise<DatabaseMaintenanceResult> {
		const integrity = String(
			this.db.pragma("integrity_check", { simple: true }) || "",
		);
		const walCheckpoint = this.db.pragma("wal_checkpoint(PASSIVE)");
		let vacuumed = false;

		if (options.vacuum) {
			this.db.exec("VACUUM");
			vacuumed = true;
		}

		return {
			integrity,
			walCheckpoint,
			vacuumed,
		};
	}

	close(): void {
		this.db.close();
	}
}

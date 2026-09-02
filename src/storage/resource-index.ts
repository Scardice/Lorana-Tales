import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Pool } from "pg";

export type ResourceCategory = "cq-images" | "cq-audio" | "avatars" | "uploads" | "files";
const RESOURCE_CATEGORIES = new Set<ResourceCategory>(["cq-images", "cq-audio", "avatars", "uploads", "files"]);
const RESOURCE_ID_RE = /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/;
const SOURCE_HASH_RE = /^[a-f0-9]{64}$/;

export type ResourceObjectRecord = {
	resourceId: string;
	relativePath: string;
	category: ResourceCategory;
	mime: string;
	byteSize: number;
	createdAtMs: number;
	lastAccessedAtMs: number;
};

export interface ResourceIndex {
	initialize(): Promise<void>;
	findBySource(sourceHash: string): Promise<ResourceObjectRecord | null>;
	findBySources(sourceHashes: string[]): Promise<Map<string, ResourceObjectRecord>>;
	findDeferredSources(sourceHashes: string[], atMs: number): Promise<Set<string>>;
	rememberFailure(sourceHash: string, reason: string, retryAfterMs: number): Promise<void>;
	clearFailure(sourceHash: string): Promise<void>;
	findObject(resourceId: string): Promise<ResourceObjectRecord | null>;
	remember(record: ResourceObjectRecord, sourceHash?: string): Promise<void>;
	touch(resourceId: string, atMs: number): Promise<void>;
	totalBytes(): Promise<number>;
	listExpired(cutoffMs: number, limit: number): Promise<ResourceObjectRecord[]>;
	deleteObject(resourceId: string): Promise<void>;
	close(): Promise<void>;
}

function rowToResource(row: Record<string, unknown> | undefined): ResourceObjectRecord | null {
	if (!row) return null;
	const resourceId = String(row.resource_id || "");
	const category = String(row.category || "") as ResourceCategory;
	const relativePath = String(row.relative_path || "").replaceAll("\\", "/");
	const record = {
		resourceId,
		relativePath,
		category,
		mime: String(row.mime || "application/octet-stream"),
		byteSize: Number(row.byte_size || 0),
		createdAtMs: Number(row.created_at_ms || 0),
		lastAccessedAtMs: Number(row.last_accessed_at_ms || 0),
	};
	try { validateResourceRecord(record, ""); return record; } catch { return null; }
}

function validateResourceRecord(record: ResourceObjectRecord, sourceHash = ""): void {
	const normalizedPath = String(record.relativePath || "").replaceAll("\\", "/");
	if (!RESOURCE_ID_RE.test(record.resourceId) || !RESOURCE_CATEGORIES.has(record.category)) throw new Error("invalid resource index record");
	const expectedPrefix = `${record.category}/${record.resourceId.slice(0, 2)}/${record.resourceId}`;
	if (normalizedPath !== expectedPrefix && normalizedPath !== `${expectedPrefix}.br`) throw new Error("invalid resource index path");
	if (!/^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}$/i.test(record.mime)) throw new Error("invalid resource MIME type");
	if (!Number.isSafeInteger(record.byteSize) || record.byteSize < 0 || !Number.isSafeInteger(record.createdAtMs) || record.createdAtMs < 0 || !Number.isSafeInteger(record.lastAccessedAtMs) || record.lastAccessedAtMs < 0) throw new Error("invalid resource index numeric value");
	if (sourceHash && !SOURCE_HASH_RE.test(sourceHash)) throw new Error("invalid resource source hash");
}

export class SqliteResourceIndex implements ResourceIndex {
	readonly databasePath: string;
	private db: Database.Database | null = null;

	constructor(databasePath: string) {
		this.databasePath = path.resolve(databasePath);
	}

	async initialize() {
		fs.mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
		const existed = fs.existsSync(this.databasePath);
		this.db = new Database(this.databasePath);
		if (!existed && process.platform !== "win32") fs.chmodSync(this.databasePath, 0o600);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("synchronous = NORMAL");
		this.db.pragma("foreign_keys = ON");
		this.db.pragma("busy_timeout = 5000");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS resource_objects (
				resource_id TEXT PRIMARY KEY,
				relative_path TEXT NOT NULL UNIQUE,
				category TEXT NOT NULL,
				mime TEXT NOT NULL,
				byte_size INTEGER NOT NULL,
				created_at_ms INTEGER NOT NULL,
				last_accessed_at_ms INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS resource_sources (
				source_hash TEXT PRIMARY KEY,
				resource_id TEXT NOT NULL,
				last_seen_at_ms INTEGER NOT NULL,
				FOREIGN KEY(resource_id) REFERENCES resource_objects(resource_id) ON DELETE CASCADE
				);
				CREATE INDEX IF NOT EXISTS idx_resource_objects_access ON resource_objects(last_accessed_at_ms);
				CREATE INDEX IF NOT EXISTS idx_resource_sources_resource ON resource_sources(resource_id);
				CREATE TABLE IF NOT EXISTS resource_source_failures (
					source_hash TEXT PRIMARY KEY,
					reason TEXT NOT NULL,
					attempts INTEGER NOT NULL DEFAULT 1,
					last_failed_at_ms INTEGER NOT NULL,
					retry_after_ms INTEGER NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_resource_failures_retry ON resource_source_failures(retry_after_ms);
			`);
	}

	private database() {
		if (!this.db) throw new Error("resource index is not initialized");
		return this.db;
	}

	async findBySource(sourceHash: string) {
		return rowToResource(this.database().prepare(`SELECT o.* FROM resource_sources s JOIN resource_objects o ON o.resource_id=s.resource_id WHERE s.source_hash=?`).get(sourceHash) as Record<string, unknown> | undefined);
	}

	async findBySources(sourceHashes: string[]) {
		const unique = [...new Set(sourceHashes.filter((value) => SOURCE_HASH_RE.test(value)))];
		const found = new Map<string, ResourceObjectRecord>();
		for (let offset = 0; offset < unique.length; offset += 500) {
			const chunk = unique.slice(offset, offset + 500);
			if (!chunk.length) continue;
			const rows = this.database().prepare(`SELECT s.source_hash,o.* FROM resource_sources s JOIN resource_objects o ON o.resource_id=s.resource_id WHERE s.source_hash IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Record<string, unknown>[];
			for (const row of rows) {
				const record = rowToResource(row);
				if (record) found.set(String(row.source_hash), record);
			}
		}
		return found;
	}

	async findDeferredSources(sourceHashes: string[], atMs: number) {
		const unique = [...new Set(sourceHashes.filter((value) => SOURCE_HASH_RE.test(value)))];
		const deferred = new Set<string>();
		for (let offset = 0; offset < unique.length; offset += 500) {
			const chunk = unique.slice(offset, offset + 500);
			if (!chunk.length) continue;
			const rows = this.database().prepare(`SELECT source_hash FROM resource_source_failures WHERE retry_after_ms>? AND source_hash IN (${chunk.map(() => "?").join(",")})`).all(atMs, ...chunk) as Array<{ source_hash: string }>;
			for (const row of rows) deferred.add(String(row.source_hash));
		}
		return deferred;
	}
	async rememberFailure(sourceHash: string, reason: string, retryAfterMs: number) {
		if (!SOURCE_HASH_RE.test(sourceHash)) throw new Error("invalid resource source hash");
		this.database().prepare(`INSERT INTO resource_source_failures(source_hash,reason,attempts,last_failed_at_ms,retry_after_ms) VALUES(?,?,1,?,?)
			ON CONFLICT(source_hash) DO UPDATE SET reason=excluded.reason,attempts=resource_source_failures.attempts+1,last_failed_at_ms=excluded.last_failed_at_ms,retry_after_ms=excluded.retry_after_ms`).run(sourceHash, reason.slice(0, 240), Date.now(), retryAfterMs);
	}
	async clearFailure(sourceHash: string) { this.database().prepare("DELETE FROM resource_source_failures WHERE source_hash=?").run(sourceHash); }

	async findObject(resourceId: string) {
		return rowToResource(this.database().prepare("SELECT * FROM resource_objects WHERE resource_id=?").get(resourceId) as Record<string, unknown> | undefined);
	}

	async remember(record: ResourceObjectRecord, sourceHash = "") {
		validateResourceRecord(record, sourceHash);
		const db = this.database();
		db.transaction(() => {
			db.prepare(`INSERT INTO resource_objects(resource_id,relative_path,category,mime,byte_size,created_at_ms,last_accessed_at_ms)
				VALUES(?,?,?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET last_accessed_at_ms=excluded.last_accessed_at_ms`).run(record.resourceId, record.relativePath, record.category, record.mime, record.byteSize, record.createdAtMs, record.lastAccessedAtMs);
			if (sourceHash) db.prepare(`INSERT INTO resource_sources(source_hash,resource_id,last_seen_at_ms) VALUES(?,?,?)
				ON CONFLICT(source_hash) DO UPDATE SET resource_id=excluded.resource_id,last_seen_at_ms=excluded.last_seen_at_ms`).run(sourceHash, record.resourceId, record.lastAccessedAtMs);
			if (sourceHash) db.prepare("DELETE FROM resource_source_failures WHERE source_hash=?").run(sourceHash);
		})();
	}

	async touch(resourceId: string, atMs: number) { this.database().prepare("UPDATE resource_objects SET last_accessed_at_ms=? WHERE resource_id=?").run(atMs, resourceId); }
	async totalBytes() { return Number((this.database().prepare("SELECT COALESCE(SUM(byte_size),0) AS total FROM resource_objects").get() as { total?: number }).total || 0); }
	async listExpired(cutoffMs: number, limit: number) { return (this.database().prepare("SELECT * FROM resource_objects WHERE last_accessed_at_ms < ? ORDER BY last_accessed_at_ms ASC LIMIT ?").all(cutoffMs, limit) as Record<string, unknown>[]).map(rowToResource).filter((row): row is ResourceObjectRecord => Boolean(row)); }
	async deleteObject(resourceId: string) { this.database().prepare("DELETE FROM resource_objects WHERE resource_id=?").run(resourceId); }
	async close() { this.db?.close(); this.db = null; }
}

export class PostgresResourceIndex implements ResourceIndex {
	constructor(private readonly pool: Pool) {}

	async initialize() {
		const client = await this.pool.connect();
		try {
			await client.query("SELECT pg_advisory_lock(hashtext('lorana-tales-schema-v2'))");
			await client.query(`
			CREATE TABLE IF NOT EXISTS resource_objects (
				resource_id TEXT PRIMARY KEY,
				relative_path TEXT NOT NULL UNIQUE,
				category TEXT NOT NULL,
				mime TEXT NOT NULL,
				byte_size BIGINT NOT NULL,
				created_at_ms BIGINT NOT NULL,
				last_accessed_at_ms BIGINT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS resource_sources (
				source_hash TEXT PRIMARY KEY,
				resource_id TEXT NOT NULL REFERENCES resource_objects(resource_id) ON DELETE CASCADE,
				last_seen_at_ms BIGINT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_resource_objects_access ON resource_objects(last_accessed_at_ms);
				CREATE INDEX IF NOT EXISTS idx_resource_sources_resource ON resource_sources(resource_id);
				CREATE TABLE IF NOT EXISTS resource_source_failures (
					source_hash TEXT PRIMARY KEY,
					reason TEXT NOT NULL,
					attempts INTEGER NOT NULL DEFAULT 1,
					last_failed_at_ms BIGINT NOT NULL,
					retry_after_ms BIGINT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_resource_failures_retry ON resource_source_failures(retry_after_ms);
				`);
		} finally {
			await client.query("SELECT pg_advisory_unlock(hashtext('lorana-tales-schema-v2'))").catch(() => undefined);
			client.release();
		}
	}

	async findBySource(sourceHash: string) { return rowToResource((await this.pool.query(`SELECT o.* FROM resource_sources s JOIN resource_objects o ON o.resource_id=s.resource_id WHERE s.source_hash=$1`, [sourceHash])).rows[0]); }
	async findBySources(sourceHashes: string[]) {
		const unique = [...new Set(sourceHashes.filter((value) => SOURCE_HASH_RE.test(value)))];
		if (!unique.length) return new Map<string, ResourceObjectRecord>();
		const rows = (await this.pool.query(`SELECT s.source_hash,o.* FROM resource_sources s JOIN resource_objects o ON o.resource_id=s.resource_id WHERE s.source_hash=ANY($1::text[])`, [unique])).rows;
		const found = new Map<string, ResourceObjectRecord>();
		for (const row of rows) { const record = rowToResource(row); if (record) found.set(String(row.source_hash), record); }
		return found;
	}
	async findDeferredSources(sourceHashes: string[], atMs: number) {
		const unique = [...new Set(sourceHashes.filter((value) => SOURCE_HASH_RE.test(value)))];
		if (!unique.length) return new Set<string>();
		return new Set<string>((await this.pool.query("SELECT source_hash FROM resource_source_failures WHERE retry_after_ms>$1 AND source_hash=ANY($2::text[])", [atMs, unique])).rows.map((row) => String(row.source_hash)));
	}
	async rememberFailure(sourceHash: string, reason: string, retryAfterMs: number) {
		if (!SOURCE_HASH_RE.test(sourceHash)) throw new Error("invalid resource source hash");
		await this.pool.query(`INSERT INTO resource_source_failures(source_hash,reason,attempts,last_failed_at_ms,retry_after_ms) VALUES($1,$2,1,$3,$4)
			ON CONFLICT(source_hash) DO UPDATE SET reason=EXCLUDED.reason,attempts=resource_source_failures.attempts+1,last_failed_at_ms=EXCLUDED.last_failed_at_ms,retry_after_ms=EXCLUDED.retry_after_ms`, [sourceHash, reason.slice(0, 240), Date.now(), retryAfterMs]);
	}
	async clearFailure(sourceHash: string) { await this.pool.query("DELETE FROM resource_source_failures WHERE source_hash=$1", [sourceHash]); }
	async findObject(resourceId: string) { return rowToResource((await this.pool.query("SELECT * FROM resource_objects WHERE resource_id=$1", [resourceId])).rows[0]); }

	async remember(record: ResourceObjectRecord, sourceHash = "") {
		validateResourceRecord(record, sourceHash);
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(`INSERT INTO resource_objects(resource_id,relative_path,category,mime,byte_size,created_at_ms,last_accessed_at_ms)
				VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(resource_id) DO UPDATE SET last_accessed_at_ms=EXCLUDED.last_accessed_at_ms`, [record.resourceId, record.relativePath, record.category, record.mime, record.byteSize, record.createdAtMs, record.lastAccessedAtMs]);
			if (sourceHash) await client.query(`INSERT INTO resource_sources(source_hash,resource_id,last_seen_at_ms) VALUES($1,$2,$3)
				ON CONFLICT(source_hash) DO UPDATE SET resource_id=EXCLUDED.resource_id,last_seen_at_ms=EXCLUDED.last_seen_at_ms`, [sourceHash, record.resourceId, record.lastAccessedAtMs]);
			if (sourceHash) await client.query("DELETE FROM resource_source_failures WHERE source_hash=$1", [sourceHash]);
			await client.query("COMMIT");
		} catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
		finally { client.release(); }
	}

	async touch(resourceId: string, atMs: number) { await this.pool.query("UPDATE resource_objects SET last_accessed_at_ms=$1 WHERE resource_id=$2", [atMs, resourceId]); }
	async totalBytes() { return Number((await this.pool.query("SELECT COALESCE(SUM(byte_size),0) AS total FROM resource_objects")).rows[0]?.total || 0); }
	async listExpired(cutoffMs: number, limit: number) { return (await this.pool.query("SELECT * FROM resource_objects WHERE last_accessed_at_ms < $1 ORDER BY last_accessed_at_ms ASC LIMIT $2", [cutoffMs, limit])).rows.map(rowToResource).filter((row): row is ResourceObjectRecord => Boolean(row)); }
	async deleteObject(resourceId: string) { await this.pool.query("DELETE FROM resource_objects WHERE resource_id=$1", [resourceId]); }
	async close() { /* shared PostgreSQL pool is owned by the application database */ }
}

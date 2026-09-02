import crypto from "node:crypto";
import { Pool } from "pg";
import { deriveLogRecord, normalizeMetadata, type AddLogRecordInput, type CleanupLogsResult, type DatabaseMaintenanceResult, type DeleteLogsResult, type LogDetail, type LogListOptions, type LogListResult, type LogMetadata, type LogMetrics, type LogStore } from "./log-store.js";

type SqlRow = Record<string, unknown>;
const RECORD_STORAGE_OVERHEAD_BYTES = 64 * 1024;

function sha256(value: string) { return crypto.createHash("sha256").update(value).digest("hex"); }
function timestampMs(value: string) { const parsed = Date.parse(value || ""); return Number.isNaN(parsed) ? Date.now() : parsed; }
function clampInt(value: unknown, fallback: number, min: number, max: number) { const parsed = parseInt(String(value || ""), 10); return Number.isNaN(parsed) ? fallback : Math.max(min, Math.min(max, parsed)); }
function escapeLike(value: string) { return value.replace(/[\\%_]/g, (match) => `\\${match}`); }
function rowToMetadata(row: SqlRow): LogMetadata { const accessPassword=String(row.access_password||"");return normalizeMetadata(String(row.public_key),{viewUrl:accessPassword?`/?key=${encodeURIComponent(String(row.public_key))}#${encodeURIComponent(accessPassword)}`:undefined,name:String(row.name||""),client:String(row.client||""),note:String(row.note||""),createdAt:String(row.created_at||""),updatedAt:String(row.updated_at||""),uploaderIp:String(row.uploader_ip||""),uniformId:String(row.uniform_id||""),messageCount:Number(row.message_count),size:{storedBytes:Number(row.stored_bytes),encodedBytes:Number(row.encoded_bytes),compressedBytes:Number(row.compressed_bytes),decodedBytes:Number(row.decoded_bytes)},decodeError:String(row.decode_error||"")}); }

export type PostgresDatabaseOptions={url:string;poolMax?:number;ssl?:"disable"|"prefer"|"require"|"verify-full"};

export function createPostgresPool(options:PostgresDatabaseOptions){
	// node-postgres does not implement libpq's opportunistic TLS fallback when
	// ssl is left undefined. Treat the legacy "prefer" value as verified TLS so
	// it can never silently send credentials and application data in plaintext.
	const ssl=options.ssl==="disable"?false:options.ssl==="require"?{rejectUnauthorized:false}:{rejectUnauthorized:true};
	const connectionUrl = new URL(options.url);
	if (!["postgres:", "postgresql:"].includes(connectionUrl.protocol)) throw new Error("database.postgres_url must be a PostgreSQL URL");
	// pg-connection-string lets URL query parameters override the top-level ssl
	// object. Remove those aliases so [database].ssl remains the sole policy and
	// a copied DATABASE_URL cannot silently weaken certificate verification.
	for (const key of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) connectionUrl.searchParams.delete(key);
	return new Pool({connectionString:connectionUrl.toString(),max:Math.max(1,Math.min(100,Number(options.poolMax||10))),ssl,application_name:"lorana-tales",idleTimeoutMillis:30_000,connectionTimeoutMillis:10_000});
}

export class PostgresLogStore implements LogStore {
	constructor(readonly pool:Pool,readonly maxTotalBytes:number){}

	async initialize(){
		const client=await this.pool.connect();
		try{await client.query("SELECT pg_advisory_lock(hashtext('lorana-tales-schema-v2'))");await client.query(`
			CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS log_records(
				id BIGSERIAL PRIMARY KEY,public_key TEXT NOT NULL UNIQUE,access_password TEXT NOT NULL DEFAULT '',password_hash TEXT NOT NULL,
				name TEXT NOT NULL,client TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',uploader_ip TEXT NOT NULL DEFAULT 'unknown',uniform_id TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL,updated_at TEXT NOT NULL,created_at_ms BIGINT NOT NULL,updated_at_ms BIGINT NOT NULL,message_count INTEGER NOT NULL DEFAULT 0,
				stored_bytes BIGINT NOT NULL DEFAULT 0,encoded_bytes BIGINT NOT NULL DEFAULT 0,compressed_bytes BIGINT NOT NULL DEFAULT 0,decoded_bytes BIGINT NOT NULL DEFAULT 0,
				decode_error TEXT NOT NULL DEFAULT '',payload_sha256 TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS log_payloads(log_id BIGINT PRIMARY KEY REFERENCES log_records(id) ON DELETE CASCADE,stored_json TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS idx_log_records_created_at_ms ON log_records(created_at_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_log_records_name ON log_records(name);
			CREATE INDEX IF NOT EXISTS idx_log_records_uploader_ip ON log_records(uploader_ip);
			CREATE INDEX IF NOT EXISTS idx_log_records_uniform_id ON log_records(uniform_id);
		`);}finally{await client.query("SELECT pg_advisory_unlock(hashtext('lorana-tales-schema-v2'))").catch(()=>undefined);client.release()}
	}

	async addLogRecord(input:AddLogRecordInput){
		const record=deriveLogRecord(input.publicKey,input.storedText,input.uniformId),metadata=record.metadata,now=new Date().toISOString(),createdAt=metadata.createdAt||now,updatedAt=metadata.updatedAt||createdAt;
		const client=await this.pool.connect();
		try{await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtext('lorana_log_quota'))");const usage=Number((await client.query("SELECT COALESCE(SUM(stored_bytes),0) AS total FROM log_records")).rows[0]?.total||0);if(usage+metadata.size.storedBytes+RECORD_STORAGE_OVERHEAD_BYTES>this.maxTotalBytes)throw new Error("log_storage_quota_exceeded");
			const inserted=await client.query(`INSERT INTO log_records(public_key,access_password,password_hash,name,client,note,uploader_ip,uniform_id,created_at,updated_at,created_at_ms,updated_at_ms,message_count,stored_bytes,encoded_bytes,compressed_bytes,decoded_bytes,decode_error,payload_sha256)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,[input.publicKey,input.password,sha256(input.password),metadata.name,metadata.client,metadata.note,metadata.uploaderIp,input.uniformId,createdAt,updatedAt,timestampMs(createdAt),timestampMs(updatedAt),metadata.messageCount,metadata.size.storedBytes,metadata.size.encodedBytes,metadata.size.compressedBytes,metadata.size.decodedBytes,metadata.decodeError,sha256(input.storedText)]);
			await client.query("INSERT INTO log_payloads(log_id,stored_json) VALUES($1,$2)",[inserted.rows[0].id,input.storedText]);await client.query("COMMIT");
		}catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error}finally{client.release()}
		return normalizeMetadata(input.publicKey,{...metadata,key:input.publicKey,viewUrl:`/?key=${encodeURIComponent(input.publicKey)}#${encodeURIComponent(input.password)}`,uniformId:input.uniformId,createdAt,updatedAt});
	}
	async replaceStoredLog(publicKey:string,expectedStoredText:string,storedText:string){
			const expectedHash=sha256(expectedStoredText),nextHash=sha256(storedText),next=deriveLogRecord(publicKey,storedText),client=await this.pool.connect();
			try{await client.query("BEGIN");const selected=(await client.query("SELECT id,stored_bytes,payload_sha256,updated_at FROM log_records WHERE public_key=$1 FOR UPDATE",[publicKey])).rows[0];if(!selected||String(selected.payload_sha256)!==expectedHash){await client.query("ROLLBACK");return false}if(expectedHash===nextHash){await client.query("COMMIT");return true}await client.query("SELECT pg_advisory_xact_lock(hashtext('lorana_log_quota'))");const usage=Number((await client.query("SELECT COALESCE(SUM(stored_bytes),0) AS total FROM log_records")).rows[0]?.total||0),oldBytes=Number(selected.stored_bytes||0);if(usage-oldBytes+next.metadata.size.storedBytes>this.maxTotalBytes)throw new Error("log_storage_quota_exceeded");const updatedAt=next.metadata.updatedAt||String(selected.updated_at||"");await client.query("UPDATE log_payloads SET stored_json=$1 WHERE log_id=$2",[storedText,selected.id]);await client.query(`UPDATE log_records SET name=$1,client=$2,note=$3,uploader_ip=$4,updated_at=$5,updated_at_ms=$6,message_count=$7,stored_bytes=$8,encoded_bytes=$9,compressed_bytes=$10,decoded_bytes=$11,decode_error=$12,payload_sha256=$13 WHERE id=$14`,[next.metadata.name,next.metadata.client,next.metadata.note,next.metadata.uploaderIp,updatedAt,timestampMs(updatedAt),next.metadata.messageCount,next.metadata.size.storedBytes,next.metadata.size.encodedBytes,next.metadata.size.compressedBytes,next.metadata.size.decodedBytes,next.metadata.decodeError,nextHash,selected.id]);await client.query("COMMIT");return true}catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error}finally{client.release()}
	}

	async readPublicLog(publicKey:string,password:string){const row=(await this.pool.query(`SELECT p.stored_json FROM log_records r JOIN log_payloads p ON p.log_id=r.id WHERE r.public_key=$1 AND r.password_hash=$2`,[publicKey,sha256(password)])).rows[0];return row?.stored_json===undefined?null:String(row.stored_json)}
	async listLogMetadata(options:LogListOptions={}):Promise<LogListResult>{const page=clampInt(options.page,1,1,Number.MAX_SAFE_INTEGER),pageSize=clampInt(options.pageSize,20,1,100),query=String(options.query||"").trim().toLowerCase();const like=`%${escapeLike(query)}%`;const where=query?`WHERE lower(public_key) LIKE $1 ESCAPE '\\' OR lower(name) LIKE $1 ESCAPE '\\' OR lower(client) LIKE $1 ESCAPE '\\' OR lower(note) LIKE $1 ESCAPE '\\' OR lower(uploader_ip) LIKE $1 ESCAPE '\\' OR lower(uniform_id) LIKE $1 ESCAPE '\\' OR lower(created_at) LIKE $1 ESCAPE '\\' OR lower(updated_at) LIKE $1 ESCAPE '\\'`:"";const params=query?[like]:[];const total=Number((await this.pool.query(`SELECT COUNT(*) AS total FROM log_records ${where}`,params)).rows[0]?.total||0),totalPages=Math.max(1,Math.ceil(total/pageSize)),currentPage=Math.min(page,totalPages),offset=(currentPage-1)*pageSize;const rows=(await this.pool.query(`SELECT * FROM log_records ${where} ORDER BY created_at_ms DESC,public_key DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,pageSize,offset])).rows;return{items:rows.map(rowToMetadata),page:currentPage,pageSize,total,totalPages,query}}
	async readLogDetail(publicKey:string):Promise<LogDetail|null>{const row=(await this.pool.query(`SELECT r.*,p.stored_json FROM log_records r JOIN log_payloads p ON p.log_id=r.id WHERE r.public_key=$1`,[publicKey])).rows[0];if(!row)return null;const derived=deriveLogRecord(String(row.public_key),String(row.stored_json),String(row.uniform_id));return{...rowToMetadata(row),version:derived.metadata.version,content:derived.content}}
	async readRawLog(publicKey:string){const row=(await this.pool.query(`SELECT p.stored_json FROM log_records r JOIN log_payloads p ON p.log_id=r.id WHERE r.public_key=$1`,[publicKey])).rows[0];return row?.stored_json===undefined?null:String(row.stored_json)}
	async deleteLogs(keys:string[]):Promise<DeleteLogsResult>{const unique=[...new Set(keys.map(String).map(v=>v.trim()).filter(Boolean))],deleted:string[]=[],missing:string[]=[],errors:Array<{key:string;error:string}>=[];const client=await this.pool.connect();try{await client.query("BEGIN");for(const key of unique)try{const result=await client.query("DELETE FROM log_records WHERE public_key=$1",[key]);(result.rowCount||0)>0?deleted.push(key):missing.push(key)}catch(error){errors.push({key,error:error instanceof Error?error.message:"delete failed"})}await client.query("COMMIT")}catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error}finally{client.release()}return{requested:unique.length,deleted,missing,errors}}
	async cleanupOldLogs(retentionDays:number):Promise<CleanupLogsResult>{const safe=Math.max(1,Number(retentionDays||1)),cutoff=Date.now()-safe*86400000,processed=Number((await this.pool.query("SELECT COUNT(*) AS total FROM log_records")).rows[0]?.total||0),rows=(await this.pool.query("DELETE FROM log_records WHERE created_at_ms<$1 RETURNING public_key",[cutoff])).rows,deleted=rows.map(row=>String(row.public_key)),line=`[${new Date().toISOString()}] PostgreSQL cleanup: ${deleted.length} of ${processed} logs older than ${safe} days`;console.log(line);return{deletedCount:deleted.length,processedCount:processed,retentionDays:safe,deleted,errors:[],logs:[line]}}
	async getLogMetrics():Promise<LogMetrics>{const row=(await this.pool.query(`SELECT COUNT(*) AS total_logs,COALESCE(SUM(stored_bytes),0) AS total_stored_bytes,COALESCE(SUM(decoded_bytes),0) AS total_decoded_bytes,COALESCE(MIN(created_at),'') AS oldest_created_at,COALESCE(MAX(created_at),'') AS newest_created_at FROM log_records`)).rows[0]||{};const size=Number((await this.pool.query("SELECT pg_database_size(current_database()) AS size")).rows[0]?.size||0);return{totalLogs:Number(row.total_logs||0),totalStoredBytes:Number(row.total_stored_bytes||0),totalDecodedBytes:Number(row.total_decoded_bytes||0),oldestCreatedAt:String(row.oldest_created_at||""),newestCreatedAt:String(row.newest_created_at||""),walEnabled:true,sqlitePageCount:size,sqlitePageSize:1}}
	async maintainDatabase(options:{vacuum?:boolean}={}):Promise<DatabaseMaintenanceResult>{await this.pool.query("SELECT 1");if(options.vacuum)await this.pool.query("VACUUM (ANALYZE)");return{integrity:"ok",walCheckpoint:{backend:"postgres"},vacuumed:!!options.vacuum}}
	async close(){await this.pool.end()}
}

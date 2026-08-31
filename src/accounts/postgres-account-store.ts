import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
	MAX_EFFECT_SHARES_PER_USER,
	DUMMY_PASSWORD_HASH,
	compressDocument,
	decompressDocument,
	isValidUsername,
	normalizeEmail,
	nowIso,
	passwordHash,
	passwordMatches,
	randomToken,
	rowToUser,
	sha256,
	type AccountRole,
	type AccountSession,
	type AccountStatus,
	type AccountUser,
	type EditorProjectSummary,
} from "./account-store.js";

type Row = Record<string, unknown>;

export class PostgresAccountStore {
	constructor(readonly pool: Pool) {}

	async initialize() {
		const client = await this.pool.connect();
		try {
			await client.query("SELECT pg_advisory_lock(hashtext('lorana-tales-schema-v2'))");
			await client.query(`
				CREATE TABLE IF NOT EXISTS account_users (
					id text PRIMARY KEY, email text NOT NULL, username text NOT NULL DEFAULT '', nickname text NOT NULL DEFAULT '',
					author_signature text NOT NULL DEFAULT '', avatar_url text NOT NULL DEFAULT '', display_name text NOT NULL DEFAULT '',
					password_hash text NOT NULL, role text NOT NULL DEFAULT 'user', account_group text NOT NULL DEFAULT 'default',
					quota_mb_override integer, retention_days_override integer, status text NOT NULL DEFAULT 'active',
					ban_reason text NOT NULL DEFAULT '', ban_until text NOT NULL DEFAULT '', must_change_password boolean NOT NULL DEFAULT false,
					tutorial_prompt_seen boolean NOT NULL DEFAULT false, manual_playback_hint_seen boolean NOT NULL DEFAULT false,
					tutorial_playback_coach_seen boolean NOT NULL DEFAULT false, recording_guide_seen boolean NOT NULL DEFAULT false,
					legacy_link_hint_seen boolean NOT NULL DEFAULT false, created_at text NOT NULL, updated_at text NOT NULL
				);
				CREATE UNIQUE INDEX IF NOT EXISTS idx_account_users_email_ci ON account_users(lower(email));
				CREATE UNIQUE INDEX IF NOT EXISTS idx_account_users_username_ci ON account_users(lower(username));
				CREATE INDEX IF NOT EXISTS idx_account_users_status ON account_users(status);
				CREATE TABLE IF NOT EXISTS account_sessions (
					token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
					csrf_hash text NOT NULL, device_hash text NOT NULL DEFAULT '', ip_prefix_hash text NOT NULL DEFAULT '',
					user_agent_hash text NOT NULL DEFAULT '', created_at_ms bigint NOT NULL, expires_at_ms bigint NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_account_sessions_user ON account_sessions(user_id);
				CREATE INDEX IF NOT EXISTS idx_account_sessions_expiry ON account_sessions(expires_at_ms);
				CREATE TABLE IF NOT EXISTS account_devices (
					token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
					ip_prefix_hash text NOT NULL, user_agent_hash text NOT NULL, created_at_ms bigint NOT NULL,
					last_used_at_ms bigint NOT NULL, expires_at_ms bigint NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_account_devices_user ON account_devices(user_id);
				CREATE INDEX IF NOT EXISTS idx_account_devices_expiry ON account_devices(expires_at_ms);
				CREATE TABLE IF NOT EXISTS account_verification_codes (
					id text PRIMARY KEY, email text NOT NULL, purpose text NOT NULL, code_hash text NOT NULL,
					ip_prefix_hash text NOT NULL, attempts integer NOT NULL DEFAULT 0, created_at_ms bigint NOT NULL,
					expires_at_ms bigint NOT NULL, consumed_at_ms bigint
				);
				CREATE INDEX IF NOT EXISTS idx_account_codes_email ON account_verification_codes(lower(email), created_at_ms DESC);
				CREATE INDEX IF NOT EXISTS idx_account_codes_expiry ON account_verification_codes(expires_at_ms);
				CREATE TABLE IF NOT EXISTS editor_projects (
					id text PRIMARY KEY, user_id text REFERENCES account_users(id) ON DELETE SET NULL, title text NOT NULL,
					revision integer NOT NULL DEFAULT 1, document_blob bytea NOT NULL, source_key text NOT NULL DEFAULT '',
					source_revision text NOT NULL DEFAULT '', source_secret_cipher text NOT NULL DEFAULT '', created_at text NOT NULL,
					updated_at text NOT NULL, last_activity_at text NOT NULL, archived boolean NOT NULL DEFAULT false
				);
				CREATE INDEX IF NOT EXISTS idx_editor_projects_user ON editor_projects(user_id, updated_at DESC);
				CREATE TABLE IF NOT EXISTS editor_project_shares (
					token text PRIMARY KEY, project_id text NOT NULL UNIQUE REFERENCES editor_projects(id) ON DELETE CASCADE,
					created_by text NOT NULL REFERENCES account_users(id) ON DELETE CASCADE, created_at text NOT NULL,
					expiry_mode text NOT NULL DEFAULT 'project', expires_at text NOT NULL DEFAULT ''
				);
				CREATE TABLE IF NOT EXISTS account_effect_folders (
					id text PRIMARY KEY, user_id text NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
					name text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_effect_folders_user ON account_effect_folders(user_id, updated_at DESC);
				CREATE TABLE IF NOT EXISTS account_effect_presets (
					id text PRIMARY KEY, user_id text NOT NULL REFERENCES account_users(id) ON DELETE CASCADE, name text NOT NULL,
					kind text NOT NULL DEFAULT 'screen', folder_id text NOT NULL DEFAULT '', preset_json text NOT NULL,
					created_at text NOT NULL, updated_at text NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_effect_presets_user ON account_effect_presets(user_id, updated_at DESC);
				CREATE TABLE IF NOT EXISTS effect_preset_shares (
					code text PRIMARY KEY, name text NOT NULL, kind text NOT NULL, preset_json text NOT NULL,
					created_by text NOT NULL REFERENCES account_users(id) ON DELETE CASCADE, created_at text NOT NULL
				);
				CREATE TABLE IF NOT EXISTS account_audit_log (
					id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, actor text NOT NULL, action text NOT NULL,
					target text NOT NULL DEFAULT '', detail text NOT NULL DEFAULT '', created_at text NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_account_audit_created ON account_audit_log(created_at DESC);
				CREATE TABLE IF NOT EXISTS account_risk_events (
					id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, user_id text NOT NULL DEFAULT '',
					ip_prefix_hash text NOT NULL DEFAULT '', event text NOT NULL, detail text NOT NULL DEFAULT '', created_at_ms bigint NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_account_risk_user ON account_risk_events(user_id, created_at_ms DESC)
			`);
		} finally {
			await client.query("SELECT pg_advisory_unlock(hashtext('lorana-tales-schema-v2'))").catch(() => undefined);
			client.release();
		}
	}

	private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
		const client = await this.pool.connect();
		try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
		catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
		finally { client.release(); }
	}

	async createUser(input: { email: string; password: string; username: string; nickname?: string; avatarUrl?: string; role?: AccountRole; group?: string; mustChangePassword?: boolean }): Promise<AccountUser> {
		const email = normalizeEmail(input.email), username = String(input.username || "").trim();
		if (!isValidUsername(username)) throw new Error("invalid_username");
		const nickname = String(input.nickname || username).trim().slice(0, 80) || username, now = nowIso(), id = crypto.randomUUID();
		await this.pool.query(`INSERT INTO account_users (id,email,username,nickname,avatar_url,display_name,password_hash,role,account_group,status,must_change_password,created_at,updated_at)
			VALUES ($1,$2,$3,$4,$5,$4,$6,$7,$8,'active',$9,$10,$10)`, [id,email,username,nickname,String(input.avatarUrl||"").slice(0,2048),await passwordHash(input.password),input.role==="admin"?"admin":"user",String(input.group||"default").trim().slice(0,40)||"default",!!input.mustChangePassword,now]);
		return (await this.getUserById(id)) as AccountUser;
	}
	async getUserById(id:string){const r=await this.pool.query("SELECT * FROM account_users WHERE id=$1",[id]);return r.rows[0]?rowToUser(r.rows[0]):null;}
	async getUserByEmail(email:string){const r=await this.pool.query("SELECT * FROM account_users WHERE lower(email)=lower($1)",[normalizeEmail(email)]);return r.rows[0]?rowToUser(r.rows[0]):null;}
	async getUserByIdentity(identity:string){const value=String(identity||"").trim();if(!value)return null;const r=await this.pool.query("SELECT * FROM account_users WHERE lower(email)=lower($1) OR lower(username)=lower($1) ORDER BY CASE WHEN lower(email)=lower($1) THEN 0 ELSE 1 END LIMIT 1",[value]);return r.rows[0]?rowToUser(r.rows[0]):null;}
	async getAdminByDisplayName(name:string){const r=await this.pool.query("SELECT * FROM account_users WHERE role='admin' AND lower(username)=lower($1) LIMIT 1",[String(name||"").trim()]);return r.rows[0]?rowToUser(r.rows[0]):null;}
	async refreshExpiredBan(user:AccountUser){return user.status==="banned"&&user.banUntil&&Date.parse(user.banUntil)<=Date.now()?(await this.setStatus(user.id,"active")) as AccountUser:user;}
	async verifyPassword(email:string,password:string){const r=await this.pool.query("SELECT * FROM account_users WHERE lower(email)=lower($1)",[normalizeEmail(email)]);if(!r.rows[0]){await passwordMatches(password,DUMMY_PASSWORD_HASH);return null;}return await passwordMatches(password,String(r.rows[0].password_hash||""))?rowToUser(r.rows[0]):null;}
	async verifyPasswordIdentity(identity:string,password:string){const user=await this.getUserByIdentity(identity);if(!user){await passwordMatches(password,DUMMY_PASSWORD_HASH);return null;}const r=await this.pool.query("SELECT password_hash FROM account_users WHERE id=$1",[user.id]);return r.rows[0]&&await passwordMatches(password,String(r.rows[0].password_hash||""))?user:null;}
	async updatePassword(id:string,password:string,mustChange=false){await this.transaction(async c=>{await c.query("UPDATE account_users SET password_hash=$1,must_change_password=$2,updated_at=$3 WHERE id=$4",[await passwordHash(password),mustChange,nowIso(),id]);await c.query("DELETE FROM account_sessions WHERE user_id=$1",[id]);});}
	async completeInitialCredentials(id:string,input:{email:string;username:string;nickname?:string;password:string}){const nickname=String(input.nickname||input.username).trim().slice(0,80)||input.username;await this.transaction(async c=>{await c.query("UPDATE account_users SET email=$1,username=$2,nickname=$3,display_name=$3,password_hash=$4,must_change_password=false,updated_at=$5 WHERE id=$6",[normalizeEmail(input.email),input.username,nickname,await passwordHash(input.password),nowIso(),id]);await c.query("DELETE FROM account_sessions WHERE user_id=$1",[id]);});return this.getUserById(id);}
	async updateUser(id:string,input:Partial<{email:string;username:string;nickname:string;authorSignature:string;displayName:string;avatarUrl:string;role:AccountRole;group:string;quotaMbOverride:number|null;retentionDaysOverride:number|null}>){
		return this.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtext('lorana-admin-invariant'))");const row=(await client.query("SELECT * FROM account_users WHERE id=$1 FOR UPDATE",[id])).rows[0];if(!row)return null;const current=rowToUser(row);if(current.role==="admin"&&current.status==="active"&&input.role==="user"){const count=Number((await client.query("SELECT count(*) AS total FROM account_users WHERE role='admin' AND status='active'")).rows[0]?.total||0);if(count<=1)throw new Error("last_admin");}
			const email=input.email?normalizeEmail(input.email):current.email,username=input.username===undefined?current.username:String(input.username).trim();const ni=input.nickname===undefined?input.displayName:input.nickname,nickname=ni===undefined?current.nickname:String(ni).trim().slice(0,80)||username;const author=input.authorSignature===undefined?current.authorSignature:String(input.authorSignature).trim().slice(0,120),avatar=input.avatarUrl===undefined?current.avatarUrl:String(input.avatarUrl).trim().slice(0,2048);const group=input.group===undefined?current.group:String(input.group).trim().slice(0,40)||"default";const quota=input.quotaMbOverride===undefined?current.quotaMbOverride:input.quotaMbOverride===null?null:Math.max(1,Math.floor(Number(input.quotaMbOverride)));const retention=input.retentionDaysOverride===undefined?current.retentionDaysOverride:input.retentionDaysOverride===null?null:Math.max(0,Math.floor(Number(input.retentionDaysOverride)));
			const updated=(await client.query("UPDATE account_users SET email=$1,username=$2,nickname=$3,author_signature=$4,avatar_url=$5,display_name=$3,role=$6,account_group=$7,quota_mb_override=$8,retention_days_override=$9,updated_at=$10 WHERE id=$11 RETURNING *",[email,username,nickname,author,avatar,input.role||current.role,group,quota,retention,nowIso(),id])).rows[0];return updated?rowToUser(updated):null;});
	}
	async markOnboarding(id:string,input:{tutorialPromptSeen?:boolean;manualPlaybackHintSeen?:boolean;tutorialPlaybackCoachSeen?:boolean;recordingGuideSeen?:boolean;legacyLinkHintSeen?:boolean}){await this.pool.query(`UPDATE account_users SET tutorial_prompt_seen=tutorial_prompt_seen OR $1,manual_playback_hint_seen=manual_playback_hint_seen OR $2,tutorial_playback_coach_seen=tutorial_playback_coach_seen OR $3,recording_guide_seen=recording_guide_seen OR $4,legacy_link_hint_seen=legacy_link_hint_seen OR $5,updated_at=$6 WHERE id=$7`,[!!input.tutorialPromptSeen,!!input.manualPlaybackHintSeen,!!input.tutorialPlaybackCoachSeen,!!input.recordingGuideSeen,!!input.legacyLinkHintSeen,nowIso(),id]);return this.getUserById(id);}
	async setStatus(id:string,status:AccountStatus,reason="",until=""){return this.transaction(async c=>{await c.query("SELECT pg_advisory_xact_lock(hashtext('lorana-admin-invariant'))");const current=(await c.query("SELECT * FROM account_users WHERE id=$1 FOR UPDATE",[id])).rows[0];if(current&&current.role==="admin"&&current.status==="active"&&status!=="active"&&Number((await c.query("SELECT count(*) AS total FROM account_users WHERE role='admin' AND status='active'")).rows[0]?.total||0)<=1)throw new Error("last_admin");await c.query("UPDATE account_users SET status=$1,ban_reason=$2,ban_until=$3,updated_at=$4 WHERE id=$5",[status,status==="banned"?reason.slice(0,500):"",status==="banned"?until:"",nowIso(),id]);if(status!=="active")await c.query("DELETE FROM account_sessions WHERE user_id=$1",[id]);const r=await c.query("SELECT * FROM account_users WHERE id=$1",[id]);return r.rows[0]?rowToUser(r.rows[0]):null;});}
	async activeAdminCount(){return Number((await this.pool.query("SELECT count(*) AS total FROM account_users WHERE role='admin' AND status='active'")).rows[0]?.total||0);}
	async normalizeAdminGroup(adminGroup:string,defaultGroup:string){const a=String(adminGroup||"admin").trim().slice(0,40)||"admin",d=String(defaultGroup||"default").trim().slice(0,40)||"default",now=nowIso();await this.transaction(async c=>{await c.query("UPDATE account_users SET account_group=$1,updated_at=$2 WHERE role='admin' AND account_group<>$1",[a,now]);await c.query("UPDATE account_users SET account_group=$1,updated_at=$2 WHERE role<>'admin' AND account_group=$3",[d,now,a]);});}
	async listUsers(query="",page=1,pageSize=20){const q=query.trim(),limit=Math.min(100,Math.max(1,pageSize)),offset=Math.max(0,page-1)*limit;const where=q?"WHERE strpos(lower(email),lower($1))>0 OR strpos(lower(username),lower($1))>0 OR strpos(lower(nickname),lower($1))>0":"",params=q?[q]:[];const [count,rows]=await Promise.all([this.pool.query(`SELECT count(*) AS total FROM account_users ${where}`,params),this.pool.query(`SELECT * FROM account_users ${where} ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset])]);return{items:rows.rows.map(rowToUser),total:Number(count.rows[0]?.total||0),page,pageSize:limit};}
	async listAudit(page=1,pageSize=50){const limit=Math.min(100,Math.max(1,pageSize)),offset=Math.max(0,page-1)*limit;const [c,r]=await Promise.all([this.pool.query("SELECT count(*) AS total FROM account_audit_log"),this.pool.query("SELECT * FROM account_audit_log ORDER BY id DESC LIMIT $1 OFFSET $2",[limit,offset])]);return{items:r.rows,total:Number(c.rows[0]?.total||0),page,pageSize:limit};}
	async projectCount(userId:string,client:Pool|PoolClient=this.pool){return Number((await client.query("SELECT count(*) AS total FROM editor_projects WHERE user_id=$1 AND archived=false",[userId])).rows[0]?.total||0);}
	async projectStorageBytes(userId:string,client:Pool|PoolClient=this.pool){return Number((await client.query("SELECT COALESCE(sum(octet_length(document_blob)),0) AS total FROM editor_projects WHERE user_id=$1 AND archived=false",[userId])).rows[0]?.total||0);}
	async cleanupInactiveProjects(policy:(user:AccountUser)=>number){return this.transaction(async c=>{const users=(await c.query("SELECT * FROM account_users")).rows.map(rowToUser);let deletedProjects=0,freedBytes=0;for(const user of users){const days=Math.max(0,Math.floor(policy(user)));if(!days)continue;const cutoff=new Date(Date.now()-days*86400000).toISOString();const r=await c.query("DELETE FROM editor_projects WHERE user_id=$1 AND archived=false AND last_activity_at<$2 RETURNING octet_length(document_blob) AS bytes",[user.id,cutoff]);deletedProjects+=r.rowCount||0;freedBytes+=r.rows.reduce((sum,row)=>sum+Number(row.bytes||0),0);}return{deletedProjects,freedBytes};});}
	async createSession(user:AccountUser,input:{sessionDays:number;deviceToken?:string;ipPrefix:string;userAgent:string}):Promise<AccountSession>{const token=randomToken(),csrfToken=randomToken(24),now=Date.now(),expiresAt=now+Math.max(1,input.sessionDays)*86400000;await this.transaction(async c=>{await c.query("DELETE FROM account_sessions WHERE expires_at_ms<=$1",[now]);await c.query("INSERT INTO account_sessions(token_hash,user_id,csrf_hash,device_hash,ip_prefix_hash,user_agent_hash,created_at_ms,expires_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[sha256(token),user.id,sha256(csrfToken),input.deviceToken?sha256(input.deviceToken):"",sha256(input.ipPrefix),sha256(input.userAgent),now,expiresAt]);});return{token,csrfToken,user,expiresAt};}
	async getSession(token:string){if(!token)return null;const r=await this.pool.query(`SELECT u.*,s.csrf_hash AS session_csrf_hash,s.ip_prefix_hash AS session_ip_prefix_hash,s.user_agent_hash AS session_user_agent_hash,s.expires_at_ms AS session_expires_at_ms FROM account_sessions s JOIN account_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at_ms>$2`,[sha256(token),Date.now()]);const row=r.rows[0];return row?{token,csrfToken:"",csrfHash:String(row.session_csrf_hash||""),ipPrefixHash:String(row.session_ip_prefix_hash||""),userAgentHash:String(row.session_user_agent_hash||""),user:rowToUser(row),expiresAt:Number(row.session_expires_at_ms||0)}:null;}
	verifyCsrf(session:{csrfHash:string},token:string){return!!token&&sha256(token)===session.csrfHash;}
	sessionMatchesContext(session:{ipPrefixHash:string;userAgentHash:string},ip:string,ua:string){return session.ipPrefixHash===sha256(ip)&&session.userAgentHash===sha256(ua);}
	async revokeSession(token:string){await this.pool.query("DELETE FROM account_sessions WHERE token_hash=$1",[sha256(token)]);}
	async revokeSessions(id:string){await this.pool.query("DELETE FROM account_sessions WHERE user_id=$1",[id]);}
	async createTrustedDevice(id:string,ip:string,ua:string,days:number){const token=randomToken(),now=Date.now();await this.transaction(async c=>{await c.query("DELETE FROM account_devices WHERE expires_at_ms<=$1",[now]);await c.query("INSERT INTO account_devices(token_hash,user_id,ip_prefix_hash,user_agent_hash,created_at_ms,last_used_at_ms,expires_at_ms) VALUES($1,$2,$3,$4,$5,$5,$6)",[sha256(token),id,sha256(ip),sha256(ua),now,now+Math.max(1,days)*86400000]);});return token;}
	async isTrustedDevice(id:string,token:string,ip:string,ua:string){if(!token)return false;const hash=sha256(token),r=await this.pool.query("UPDATE account_devices SET last_used_at_ms=$1 WHERE token_hash=$2 AND user_id=$3 AND ip_prefix_hash=$4 AND user_agent_hash=$5 AND expires_at_ms>$1 RETURNING token_hash",[Date.now(),hash,id,sha256(ip),sha256(ua)]);return(r.rowCount||0)>0;}
	async createVerificationCode(email:string,purpose:string,code:string,ip:string,ttl:number){const id=crypto.randomUUID(),now=Date.now();await this.transaction(async c=>{await c.query("DELETE FROM account_verification_codes WHERE expires_at_ms<$1",[now-86400000]);await c.query("INSERT INTO account_verification_codes(id,email,purpose,code_hash,ip_prefix_hash,created_at_ms,expires_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,normalizeEmail(email),purpose,sha256(`${id}:${code}`),sha256(ip),now,now+ttl*60000]);});return id;}
	async deleteVerificationCode(id:string){await this.pool.query("DELETE FROM account_verification_codes WHERE id=$1",[id]);}
	async verifyCode(id:string,email:string,purpose:string,code:string,consume=true){return this.transaction(async c=>{const r=await c.query("SELECT * FROM account_verification_codes WHERE id=$1 AND lower(email)=lower($2) AND purpose=$3 AND consumed_at_ms IS NULL AND expires_at_ms>$4 FOR UPDATE",[id,normalizeEmail(email),purpose,Date.now()]);const row=r.rows[0];if(!row||Number(row.attempts||0)>=5)return false;const valid=String(row.code_hash)===sha256(`${id}:${code}`);if(!valid||consume)await c.query("UPDATE account_verification_codes SET attempts=attempts+1,consumed_at_ms=CASE WHEN $1 THEN $2 ELSE consumed_at_ms END WHERE id=$3",[valid&&consume,Date.now(),id]);return valid;});}
	async verificationSendCounts(email:string,ip:string,since:number){const [e,p]=await Promise.all([this.pool.query("SELECT count(*) AS total FROM account_verification_codes WHERE lower(email)=lower($1) AND created_at_ms>=$2",[normalizeEmail(email),since]),this.pool.query("SELECT count(*) AS total FROM account_verification_codes WHERE ip_prefix_hash=$1 AND created_at_ms>=$2",[sha256(ip),since])]);return{emailCount:Number(e.rows[0]?.total||0),ipCount:Number(p.rows[0]?.total||0)};}
	async lastVerificationAt(email:string,purpose:string){return Number((await this.pool.query("SELECT max(created_at_ms) AS latest FROM account_verification_codes WHERE lower(email)=lower($1) AND purpose=$2",[normalizeEmail(email),purpose])).rows[0]?.latest||0);}
	async createProject(userId:string,title:string,document:unknown,source:{key?:string;revision?:string;encryptedSecret?:string}={},limits?:{quotaBytes:number;maxProjects:number}){const id=crypto.randomUUID(),now=nowIso(),blob=compressDocument(document);await this.transaction(async c=>{await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`project-quota:${userId}`]);if(limits&&await this.projectCount(userId,c)>=limits.maxProjects)throw new Error("project_limit_reached");if(limits&&await this.projectStorageBytes(userId,c)+blob.length>limits.quotaBytes)throw new Error("storage_quota_exceeded");await c.query("INSERT INTO editor_projects(id,user_id,title,revision,document_blob,source_key,source_revision,source_secret_cipher,created_at,updated_at,last_activity_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$8,$8)",[id,userId,title.slice(0,160)||"跑团记录",blob,source.key||"",source.revision||"",source.encryptedSecret||"",now]);});return this.getProject(userId,id);}
	async listProjects(userId:string):Promise<EditorProjectSummary[]>{const r=await this.pool.query("SELECT id,title,revision,source_key,source_revision,created_at,updated_at,last_activity_at,octet_length(document_blob) AS stored_bytes FROM editor_projects WHERE user_id=$1 AND archived=false ORDER BY updated_at DESC",[userId]);return r.rows.map(row=>({id:String(row.id),title:String(row.title),revision:Number(row.revision),sourceKey:String(row.source_key||""),sourceRevision:String(row.source_revision||""),createdAt:String(row.created_at),updatedAt:String(row.updated_at),lastActivityAt:String(row.last_activity_at||row.updated_at),storedBytes:Number(row.stored_bytes||0)}));}
	async getProjectShareInfo(userId:string,id:string){const r=await this.pool.query("SELECT id,last_activity_at,updated_at FROM editor_projects WHERE id=$1 AND user_id=$2 AND archived=false",[id,userId]);const row=r.rows[0];return row?{id:String(row.id),lastActivityAt:String(row.last_activity_at||row.updated_at)}:null;}
	async listAllProjects(page=1,pageSize=50){const limit=Math.min(100,Math.max(1,pageSize)),offset=Math.max(0,page-1)*limit;const [c,r]=await Promise.all([this.pool.query("SELECT count(*) AS total FROM editor_projects WHERE archived=false"),this.pool.query(`SELECT p.id,p.title,p.revision,p.source_key,p.source_revision,p.created_at,p.updated_at,p.user_id,u.username,u.nickname,u.email FROM editor_projects p LEFT JOIN account_users u ON u.id=p.user_id WHERE p.archived=false ORDER BY p.updated_at DESC LIMIT $1 OFFSET $2`,[limit,offset])]);return{items:r.rows.map(row=>({id:String(row.id),title:String(row.title),revision:Number(row.revision),sourceKey:String(row.source_key||""),sourceRevision:String(row.source_revision||""),createdAt:String(row.created_at),updatedAt:String(row.updated_at),userId:String(row.user_id||""),username:String(row.username||""),nickname:String(row.nickname||""),email:String(row.email||"")})),total:Number(c.rows[0]?.total||0),page,pageSize:limit};}
	async getProjectAsAdmin(id:string){const r=await this.pool.query("SELECT p.*,u.username,u.nickname,u.email FROM editor_projects p LEFT JOIN account_users u ON u.id=p.user_id WHERE p.id=$1 AND p.archived=false",[id]);const row=r.rows[0];return row?{id:String(row.id),title:String(row.title),revision:Number(row.revision),document:decompressDocument(row.document_blob as Buffer),owner:{id:String(row.user_id||""),username:String(row.username||""),nickname:String(row.nickname||""),email:String(row.email||"")},createdAt:String(row.created_at),updatedAt:String(row.updated_at)}:null;}
	async getProject(userId:string,id:string){const r=await this.pool.query("UPDATE editor_projects SET last_activity_at=$1 WHERE id=$2 AND user_id=$3 AND archived=false RETURNING *",[nowIso(),id,userId]);const row=r.rows[0];return row?{id:String(row.id),title:String(row.title),revision:Number(row.revision),document:decompressDocument(row.document_blob as Buffer),sourceKey:String(row.source_key||""),sourceRevision:String(row.source_revision||""),createdAt:String(row.created_at),updatedAt:String(row.updated_at)}:null;}
	async getProjectSource(userId:string,id:string){const r=await this.pool.query("SELECT source_key,source_revision,source_secret_cipher FROM editor_projects WHERE id=$1 AND user_id=$2 AND archived=false",[id,userId]);const row=r.rows[0];return row?{key:String(row.source_key||""),revision:String(row.source_revision||""),encryptedSecret:String(row.source_secret_cipher||"")}:null;}
	async updateProject(userId:string,id:string,expected:number,document:unknown,title?:string,limits?:{quotaBytes:number;maxProjects:number}){const blob=compressDocument(document);return this.transaction(async c=>{await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`project-quota:${userId}`]);const r=await c.query("SELECT revision,octet_length(document_blob) AS stored_bytes FROM editor_projects WHERE id=$1 AND user_id=$2 AND archived=false FOR UPDATE",[id,userId]);const current=r.rows[0];if(!current||Number(current.revision)!==expected)return null;if(limits&&await this.projectStorageBytes(userId,c)-Number(current.stored_bytes||0)+blob.length>limits.quotaBytes)throw new Error("storage_quota_exceeded");const now=nowIso(),u=await c.query("UPDATE editor_projects SET document_blob=$1,title=COALESCE($2,title),revision=revision+1,updated_at=$3,last_activity_at=$3 WHERE id=$4 AND user_id=$5 AND revision=$6 AND archived=false RETURNING *",[blob,title?title.slice(0,160):null,now,id,userId,expected]);const row=u.rows[0];return row?{id:String(row.id),title:String(row.title),revision:Number(row.revision),document:decompressDocument(row.document_blob as Buffer),sourceKey:String(row.source_key||""),sourceRevision:String(row.source_revision||""),createdAt:String(row.created_at),updatedAt:String(row.updated_at)}:null;});}
	async deleteProject(userId:string,id:string){return((await this.pool.query("DELETE FROM editor_projects WHERE id=$1 AND user_id=$2",[id,userId])).rowCount||0)===1;}
	async shareProject(userId:string,id:string,mode:"project"|"fixed"="project",expiresAt=""){return this.transaction(async c=>{const p=await c.query("SELECT id FROM editor_projects WHERE id=$1 AND user_id=$2 AND archived=false",[id,userId]);if(!p.rows[0])return null;const token=randomToken(18),r=await c.query(`INSERT INTO editor_project_shares(token,project_id,created_by,created_at,expiry_mode,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id) DO UPDATE SET expiry_mode=EXCLUDED.expiry_mode,expires_at=EXCLUDED.expires_at RETURNING token`,[token,id,userId,nowIso(),mode,expiresAt]);return{token:String(r.rows[0].token),expiryMode:mode,expiresAt};});}
	async getSharedProject(token:string){const r=await this.pool.query(`SELECT p.id AS project_id,p.title,p.revision,p.document_blob,p.created_at AS project_created_at,p.updated_at AS project_updated_at,p.last_activity_at,s.expiry_mode AS share_expiry_mode,s.expires_at AS share_expires_at,u.id AS owner_id,u.account_group AS owner_account_group,u.retention_days_override AS owner_retention_days_override FROM editor_project_shares s JOIN editor_projects p ON p.id=s.project_id JOIN account_users u ON u.id=p.user_id WHERE s.token=$1 AND p.archived=false`,[token]);const row=r.rows[0];return row?{id:String(row.project_id),title:String(row.title),revision:Number(row.revision),document:decompressDocument(row.document_blob as Buffer),createdAt:String(row.project_created_at),updatedAt:String(row.project_updated_at),lastActivityAt:String(row.last_activity_at||row.project_updated_at),shareExpiryMode:String(row.share_expiry_mode||""),shareExpiresAt:String(row.share_expires_at||""),owner:{id:String(row.owner_id||""),group:String(row.owner_account_group||"default"),quotaMbOverride:null,retentionDaysOverride:row.owner_retention_days_override==null?null:Math.max(0,Number(row.owner_retention_days_override))}}:null;}
	async listEffectPresets(userId:string){const r=await this.pool.query("SELECT id,name,kind,folder_id,preset_json,created_at,updated_at FROM account_effect_presets WHERE user_id=$1 ORDER BY updated_at DESC",[userId]);return r.rows.map(row=>({id:String(row.id),name:String(row.name),kind:String(row.kind||"screen"),folderId:String(row.folder_id||""),config:JSON.parse(String(row.preset_json)),createdAt:String(row.created_at),updatedAt:String(row.updated_at)}));}
	async effectPresetCount(id:string){return Number((await this.pool.query("SELECT count(*) AS total FROM account_effect_presets WHERE user_id=$1",[id])).rows[0]?.total||0);}
	async effectFolderCount(id:string){return Number((await this.pool.query("SELECT count(*) AS total FROM account_effect_folders WHERE user_id=$1",[id])).rows[0]?.total||0);}
	async createEffectPreset(userId:string,name:string,config:unknown,folderId="",kind="screen"){const id=crypto.randomUUID(),now=nowIso();await this.pool.query("INSERT INTO account_effect_presets(id,user_id,name,kind,folder_id,preset_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)",[id,userId,name.slice(0,60),kind,folderId,JSON.stringify(config),now]);return(await this.listEffectPresets(userId)).find(x=>x.id===id);}
	async updateEffectPreset(userId:string,id:string,name:string,config:unknown,folderId="",kind="screen"){const r=await this.pool.query("UPDATE account_effect_presets SET name=$1,kind=$2,folder_id=$3,preset_json=$4,updated_at=$5 WHERE id=$6 AND user_id=$7",[name.slice(0,60),kind,folderId,JSON.stringify(config),nowIso(),id,userId]);return r.rowCount?(await this.listEffectPresets(userId)).find(x=>x.id===id):null;}
	async deleteEffectPreset(userId:string,id:string){return((await this.pool.query("DELETE FROM account_effect_presets WHERE id=$1 AND user_id=$2",[id,userId])).rowCount||0)===1;}
	async listEffectFolders(userId:string){return(await this.pool.query("SELECT id,name FROM account_effect_folders WHERE user_id=$1 ORDER BY updated_at DESC",[userId])).rows.map(row=>({id:String(row.id),name:String(row.name)}));}
	async createEffectFolder(userId:string,name:string){const id=crypto.randomUUID(),safe=name.slice(0,40),now=nowIso();await this.pool.query("INSERT INTO account_effect_folders(id,user_id,name,created_at,updated_at) VALUES($1,$2,$3,$4,$4)",[id,userId,safe,now]);return{id,name:safe};}
	async renameEffectFolder(userId:string,id:string,name:string){return((await this.pool.query("UPDATE account_effect_folders SET name=$1,updated_at=$2 WHERE id=$3 AND user_id=$4",[name.slice(0,40),nowIso(),id,userId])).rowCount||0)===1;}
	async deleteEffectFolder(userId:string,id:string){return this.transaction(async c=>{await c.query("UPDATE account_effect_presets SET folder_id='' WHERE user_id=$1 AND folder_id=$2",[userId,id]);return((await c.query("DELETE FROM account_effect_folders WHERE id=$1 AND user_id=$2",[id,userId])).rowCount||0)===1;});}
	async createEffectShare(userId:string,presetId:string){return this.transaction(async c=>{await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`effect-share:${userId}`]);const p=await c.query("SELECT name,kind,preset_json FROM account_effect_presets WHERE id=$1 AND user_id=$2",[presetId,userId]);if(!p.rows[0])return null;await c.query("DELETE FROM effect_preset_shares WHERE code IN (SELECT code FROM effect_preset_shares WHERE created_by=$1 ORDER BY created_at ASC OFFSET $2)",[userId,MAX_EFFECT_SHARES_PER_USER-1]);for(let i=0;i<8;i++){const code=`LT-${crypto.randomBytes(6).toString("base64url").toUpperCase()}`;const r=await c.query("INSERT INTO effect_preset_shares(code,name,kind,preset_json,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",[code,p.rows[0].name,p.rows[0].kind,p.rows[0].preset_json,userId,nowIso()]);if(r.rowCount)return{code};}throw new Error("effect_share_code_collision");});}
	async getEffectShare(code:string){const row=(await this.pool.query("SELECT name,kind,preset_json FROM effect_preset_shares WHERE code=$1",[code.toUpperCase()])).rows[0];return row?{name:String(row.name),kind:String(row.kind),config:JSON.parse(String(row.preset_json))}:null;}
	async deleteUser(userId:string,action:"delete"|"archive"|"transfer",transferUserId=""){return this.transaction(async c=>{await c.query("SELECT pg_advisory_xact_lock(hashtext('lorana-admin-invariant'))");const current=(await c.query("SELECT role,status FROM account_users WHERE id=$1 FOR UPDATE",[userId])).rows[0];if(current?.role==="admin"&&current?.status==="active"&&Number((await c.query("SELECT count(*) AS total FROM account_users WHERE role='admin' AND status='active'")).rows[0]?.total||0)<=1)throw new Error("last_admin");if(action==="delete")await c.query("DELETE FROM editor_projects WHERE user_id=$1",[userId]);if(action==="archive")await c.query("UPDATE editor_projects SET user_id=NULL,archived=true WHERE user_id=$1",[userId]);if(action==="transfer")await c.query("UPDATE editor_projects SET user_id=$1,updated_at=$2,last_activity_at=$2 WHERE user_id=$3",[transferUserId,nowIso(),userId]);return((await c.query("DELETE FROM account_users WHERE id=$1",[userId])).rowCount||0)===1;});}
	async audit(actor:string,action:string,target="",detail:unknown=""){await this.pool.query("INSERT INTO account_audit_log(actor,action,target,detail,created_at) VALUES($1,$2,$3,$4,$5)",[actor,action,target,typeof detail==="string"?detail:JSON.stringify(detail),nowIso()]);}
	async recordRisk(userId:string,ip:string,event:string,detail=""){await this.pool.query("INSERT INTO account_risk_events(user_id,ip_prefix_hash,event,detail,created_at_ms) VALUES($1,$2,$3,$4,$5)",[userId,sha256(ip),event,detail.slice(0,500),Date.now()]);}
	async recentRiskCount(userId:string,ip:string,since:number){return Number((await this.pool.query("SELECT count(*) AS total FROM account_risk_events WHERE created_at_ms>=$1 AND (user_id=$2 OR ip_prefix_hash=$3)",[since,userId,sha256(ip)])).rows[0]?.total||0);}
}

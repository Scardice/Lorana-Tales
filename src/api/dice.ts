import crypto from "node:crypto";
import { zlibSync } from "fflate";
import {
	createSecurityInterceptId,
	formatUploadInjectionWarning,
	type InspectionPart,
	inspectUploadParts,
	writeSecurityAuditLog,
} from "../security/injection-guard.js";
import type { LogStore } from "../storage/log-store.js";
import type { CqResourceCache } from "../storage/cq-resource-cache.js";

const DEFAULT_FILE_SIZE_LIMIT_MB = 5;
const API_PREFIXES = ["/api/dice", "/dice/api"];
const LOAD_DATA_FAILURE_LIMIT = 10;
const LOAD_DATA_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const UPLOAD_LIMIT = 30;
const UPLOAD_WINDOW_MS = 10 * 60 * 1000;

type RateLimitRecord = {
	count: number;
	resetAt: number;
};

const loadDataFailures = new Map<string, RateLimitRecord>();
const uploadAttempts = new Map<string, RateLimitRecord>();

function randomToken(bytes = 18): string {
	return crypto.randomBytes(bytes).toString("base64url");
}

function cleanupRateLimitRecords(
	records: Map<string, RateLimitRecord>,
	now = Date.now(),
) {
	for (const [key, record] of records) {
		if (record.resetAt <= now) records.delete(key);
	}
}

function consumeRateLimit(
	records: Map<string, RateLimitRecord>,
	key: string,
	limit: number,
	windowMs: number,
): RateLimitRecord | null {
	const now = Date.now();
	cleanupRateLimitRecords(records, now);
	const current = records.get(key);
	if (!current || current.resetAt <= now) {
		const next = { count: 1, resetAt: now + windowMs };
		records.set(key, next);
		return next;
	}
	if (current.count >= limit) return null;
	current.count += 1;
	return current;
}

function clearRateLimit(records: Map<string, RateLimitRecord>, key: string) {
	records.delete(key);
}

function retryAfterSeconds(record: RateLimitRecord | undefined): string {
	if (!record) return "60";
	return String(Math.max(1, Math.ceil((record.resetAt - Date.now()) / 1000)));
}

function generateStorageData(
	data: string,
	name: string,
	uploaderIp: string,
	note = "",
	client = "Scardice",
	version = "",
) {
	const now = new Date().toISOString();
	return {
		client,
		created_at: now,
		data,
		name,
		note,
		uploader_ip: uploaderIp || "unknown",
		updated_at: now,
		version,
	};
}

function getRuntimeValue(env, key: string): unknown {
	return (
		(typeof globalThis !== "undefined" && globalThis[key]) ||
		(typeof process !== "undefined" && process.env && process.env[key]) ||
		env?.[key]
	);
}

function getNumberConfig(
	env,
	key: string,
	fallback: number,
	minimum = 1,
): number {
	const value = getRuntimeValue(env, key);
	const parsed = parseInt(String(value || ""), 10);
	if (Number.isNaN(parsed)) return fallback;
	return Math.max(parsed, minimum);
}

function getBooleanConfig(env, key: string, fallback: boolean): boolean {
	const value = getRuntimeValue(env, key);
	if (value === undefined || value === null || value === "") return fallback;
	return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function getLogRetentionDays(env): number {
	return getNumberConfig(env, "LOG_RETENTION_DAYS", 30, 1);
}

function getUploadLimitMb(env): number {
	return getNumberConfig(env, "MAX_UPLOAD_MB", DEFAULT_FILE_SIZE_LIMIT_MB, 1);
}

function shouldCleanupAfterUpload(env): boolean {
	return getBooleanConfig(env, "CLEANUP_AFTER_UPLOAD", true);
}

function isInjectionGuardEnabled(env): boolean {
	return getBooleanConfig(env, "INJECTION_GUARD_ENABLED", true);
}

function getSecurityAuditLogPath(env): string {
	return String(getRuntimeValue(env, "SECURITY_AUDIT_LOG_PATH") || "");
}

function getSecurityWarningQuotes(env): string[] {
	const value = getRuntimeValue(env, "SECURITY_WARNING_QUOTES");
	if (Array.isArray(value)) return value.map(String);
	if (typeof value !== "string" || !value.trim()) return [];
	try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed.map(String);
	} catch {
		// Fall through to comma-separated env-var parsing.
	}
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function getUploaderIp(request: Request): string {
	const forwardedFor = String(request.headers.get("x-forwarded-for") || "")
		.split(",")[0]
		.trim();
	return (
		request.headers.get("x-scardice-client-ip") ||
		request.headers.get("cf-connecting-ip") ||
		request.headers.get("x-real-ip") ||
		forwardedFor ||
		"unknown"
	);
}

function normalize(url: string): string {
	if (typeof url !== "string" || !url) {
		throw new Error(
			"未配置前端地址参数 FRONTEND_URL ，请设置运行时的变量 FRONTEND_URL。FRONTEND_URL is not configured. Please set runtime variable FRONTEND_URL.",
		);
	}
	const withProtocol = /^https?:\/\//i.test(url) ? url : `https://${url}`;
	return withProtocol.replace(/\/+$/, "/");
}

function isUnsetFrontendUrl(url: unknown): boolean {
	return (
		typeof url !== "string" ||
		url.trim() === "" ||
		url.includes("your-frontend.example.com")
	);
}

function resolveRequestOrigin(request: Request): string {
	const url = new URL(request.url);
	return `${url.protocol}//${url.host}/`;
}

function normalizeBackupApi(url: unknown): string | null {
	if (typeof url !== "string" || !url) return null;
	const withProtocol = /^https?:\/\//i.test(url) ? url : `https://${url}`;
	return withProtocol.replace(/\/+$/, "/");
}

async function resolveFrontendUrl(env, request: Request): Promise<string> {
	const runtimeVar =
		(typeof globalThis !== "undefined" && globalThis.FRONTEND_URL) ||
		(typeof process !== "undefined" && process.env && process.env.FRONTEND_URL);
	if (!isUnsetFrontendUrl(runtimeVar)) return normalize(String(runtimeVar));
	if (!isUnsetFrontendUrl(env?.FRONTEND_URL))
		return normalize(env.FRONTEND_URL);
	return normalize(resolveRequestOrigin(request));
}

async function resolveBackupApi(env): Promise<string | null> {
	const runtimeVar =
		(typeof globalThis !== "undefined" && globalThis.BACKUP_UPLOAD_API) ||
		(typeof process !== "undefined" &&
			process.env &&
			process.env.BACKUP_UPLOAD_API);
	if (runtimeVar) return normalizeBackupApi(runtimeVar);
	if (env?.BACKUP_UPLOAD_API) return normalizeBackupApi(env.BACKUP_UPLOAD_API);
	return null;
}

function getCorsHeaders(frontendUrl: string, methods = "GET, PUT, OPTIONS") {
	return {
		"Access-Control-Allow-Origin": frontendUrl.slice(0, -1),
		"Access-Control-Allow-Methods": methods,
		"Access-Control-Allow-Headers": "Content-Type, Accept-Version",
	};
}

function jsonResponse(
	body: unknown,
	status: number,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			...headers,
			"Content-Type": "application/json",
		},
	});
}

function textResponse(
	body: string,
	status: number,
	headers: Record<string, string> = {},
): Response {
	return new Response(body, {
		status,
		headers: {
			...headers,
			"Cache-Control": "no-store",
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}

function matchesApiPath(pathname: string, routePath: string): boolean {
	return API_PREFIXES.some((prefix) => {
		const fullPath = `${prefix}${routePath}`;
		return pathname === fullPath || pathname.endsWith(fullPath);
	});
}

function validateUniformId(value: string): boolean {
	return /^[^:]+:[A-Za-z0-9_.-]+$/.test(value);
}

function getTextField(value: FormDataEntryValue | null): string {
	return typeof value === "string" ? value.trim() : "";
}

function isFileLike(value: FormDataEntryValue | null): value is File {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as File).arrayBuffer === "function" &&
		typeof (value as File).size === "number"
	);
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
	return Buffer.from(
		bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
	).toString("base64");
}

function rejectOversizedRequest(
	request: Request,
	maxUploadMb: number,
	corsHeaders: Record<string, string>,
): Response | null {
	const contentLength = request.headers.get("Content-Length");
	if (
		contentLength &&
		parseInt(contentLength, 10) > maxUploadMb * 1024 * 1024
	) {
		return jsonResponse(
			{
				success: false,
				message: `File size exceeds ${maxUploadMb}MB limit`,
			},
			413,
			corsHeaders,
		);
	}
	return null;
}

function makeStorageKey() {
	return {
		key: randomToken(16),
		password: randomToken(18),
	};
}

async function rejectDangerousUpload({
	request,
	env,
	route,
	name,
	uniformId,
	parts,
	headers,
}: {
	request: Request;
	env;
	route: string;
	name: string;
	uniformId: string;
	parts: InspectionPart[];
	headers?: Record<string, string>;
}): Promise<Response | null> {
	if (!isInjectionGuardEnabled(env)) return null;
	const inspection = inspectUploadParts(parts);
	if (inspection.findings.length === 0) return null;
	const interceptId = createSecurityInterceptId();

	const auditLogPath = getSecurityAuditLogPath(env);
	try {
		if (auditLogPath) {
			await writeSecurityAuditLog({
				auditLogPath,
				interceptId,
				clientIp: getUploaderIp(request),
				route,
				method: request.method,
				name,
				uniformId,
				inspection,
			});
		}
	} catch (error) {
		console.error("Security audit log write failed:", error);
	}

	return textResponse(
		formatUploadInjectionWarning(
			interceptId,
			inspection.findings,
			getSecurityWarningQuotes(env),
		),
		422,
		headers,
	);
}

function maybeCleanupAfterUpload(store: LogStore, env): void {
	if (!shouldCleanupAfterUpload(env)) return;
	const retentionDays = getLogRetentionDays(env);
	store.cleanupOldLogs(retentionDays).catch((error) => {
		console.error(`Background cleanup failed (non-critical): ${error.message}`);
	});
}

async function archiveCqResources(
	env,
	logContent: string,
	request: Request,
): Promise<string> {
	const resourceCache = env?.CQ_RESOURCE_CACHE as CqResourceCache | undefined;
	if (!resourceCache?.enabled) return logContent;
	try {
		const result = await resourceCache.archiveStoredLog(
			logContent,
			new URL(request.url).origin,
		);
		if (result.cachedCount > 0) {
			console.log(
				`[resource-cache] Archived ${result.cachedCount} CQ resources for uploaded log`,
			);
		}
		return result.storedText;
	} catch (error) {
		// Resource retention is best effort: an expired or blocked upstream URL
		// must not make the actual log upload fail.
		console.warn(
			`[resource-cache] Log resource archival skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
		return logContent;
	}
}

async function uploadToBackupApi(
	backupApiUrl: string,
	uniformId: string,
	name: string,
	logdata: string,
	visitedHosts: string[] = [],
) {
	const backupHost = new URL(backupApiUrl).host;
	if (visitedHosts.includes(backupHost)) {
		throw new Error(
			`Circular reference detected: ${backupHost} has already been visited in the backup chain`,
		);
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 5000);

	try {
		const response = await fetch(backupApiUrl, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				uniform_id: uniformId,
				name,
				logdata,
				visitedHosts: [...visitedHosts, backupHost],
			}),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);
		const responseBody = await response.text().catch(() => "");

		if (!response.ok) {
			throw new Error(
				`Backup API URL ${backupApiUrl} returned status ${response.status}: ${responseBody}`,
			);
		}

		try {
			return JSON.parse(responseBody);
		} catch {
			return { url: responseBody };
		}
	} catch (error) {
		clearTimeout(timeoutId);
		if (error?.name === "AbortError") {
			throw new Error(`Backup API ${backupApiUrl} timeout after 5 seconds`);
		}
		throw error;
	}
}

async function persistLogOrBackup({
	request,
	env,
	store,
	frontendUrl,
	key,
	password,
	uniformId,
	name,
	logdata,
	logContent,
	corsHeaders,
}) {
	try {
		const storedText = await archiveCqResources(env, logContent, request);
		await store.addLogRecord({
			publicKey: key,
			password,
			uniformId,
			storedText,
		});
		maybeCleanupAfterUpload(store, env);
		return jsonResponse(
			{ url: `${frontendUrl}?key=${key}#${password}` },
			200,
			corsHeaders,
		);
	} catch (uploadError) {
		const errorMsg = String(
			uploadError?.message || uploadError?.toString() || "Unknown error",
		);
		console.error(`Upload Error - database write failed: ${errorMsg}`);

		const backupApiUrl = await resolveBackupApi(env);
		if (!backupApiUrl) {
			return jsonResponse(
				{ success: false, message: "Database storage unavailable" },
				500,
				corsHeaders,
			);
		}

		try {
			const currentHost = new URL(request.url).host;
			const backupResult = await uploadToBackupApi(
				backupApiUrl,
				uniformId,
				name,
				logdata,
				[currentHost],
			);
			return jsonResponse(backupResult, 202, corsHeaders);
		} catch (backupError) {
			const backupMsg = String(
				backupError?.message || backupError?.toString() || "Unknown error",
			);
			console.error(`Upload Error - backup API failed: ${backupMsg}`);
			return jsonResponse(
				{ success: false, message: "Backup API unavailable" },
				500,
				corsHeaders,
			);
		}
	}
}

export async function handleDiceApiRequest({ request, env }) {
	const { pathname, searchParams } = new URL(request.url);
	console.log(`[DEBUG] Request: ${request.method} ${pathname}`);

	let frontendUrl: string;
	try {
		frontendUrl = await resolveFrontendUrl(env, request);
	} catch (error) {
		const msg =
			error?.message ||
			"未配置前端地址参数FRONTEND_URL。FRONTEND_URL is not configured. Please set FRONTEND_URL in config.toml or via environment variable.";
		return new Response(msg, { status: 500 });
	}

	if (request.method === "OPTIONS") {
		return new Response(null, { headers: getCorsHeaders(frontendUrl) });
	}

	const store: LogStore | undefined = env?.LOG_STORE;
	if (!store) {
		return new Response(
			"Error: log database storage not configured in environment.",
			{
				status: 500,
			},
		);
	}

	const maxUploadMb = getUploadLimitMb(env);

	if (matchesApiPath(pathname, "/log") && request.method === "PUT") {
		const corsHeaders = getCorsHeaders(frontendUrl, "PUT, OPTIONS");
		const uploadRateKey = `${getUploaderIp(request)}:log`;
		const uploadRecord = consumeRateLimit(
			uploadAttempts,
			uploadRateKey,
			UPLOAD_LIMIT,
			UPLOAD_WINDOW_MS,
		);
		if (!uploadRecord) {
			const activeRecord = uploadAttempts.get(uploadRateKey);
			return jsonResponse(
				{ success: false, message: "Too many upload requests" },
				429,
				{
					...corsHeaders,
					"Retry-After": retryAfterSeconds(activeRecord),
				},
			);
		}
		const sizeError = rejectOversizedRequest(request, maxUploadMb, corsHeaders);
		if (sizeError) return sizeError;

		try {
			const formData = await request.formData();
			const name = getTextField(formData.get("name"));
			const uniformId = getTextField(formData.get("uniform_id"));
			const client = getTextField(formData.get("client")) || "Scardice";
			const version = getTextField(formData.get("version"));
			const file = formData.get("file");

			if (!name || !uniformId || !isFileLike(file)) {
				return jsonResponse(
					{
						success: false,
						message: "Missing required fields: name, uniform_id, or file",
					},
					400,
					corsHeaders,
				);
			}

			if (!validateUniformId(uniformId)) {
				return jsonResponse(
					{
						success: false,
						message: "uniform_id field did not pass validation",
					},
					400,
					corsHeaders,
				);
			}

			if (file.size > maxUploadMb * 1024 * 1024) {
				return jsonResponse(
					{
						success: false,
						message: `File size exceeds ${maxUploadMb}MB limit`,
					},
					413,
					corsHeaders,
				);
			}

			const fileBytes = new Uint8Array(await file.arrayBuffer());
			const blocked = await rejectDangerousUpload({
				request,
				env,
				route: "/api/dice/log",
				name,
				uniformId,
				headers: corsHeaders,
				parts: [
					{ source: "field:name", text: name },
					{ source: "field:uniform_id", text: uniformId },
					{ source: "field:client", text: client },
					{ source: "field:version", text: version },
					{ source: "file", bytes: fileBytes },
				],
			});
			if (blocked) return blocked;

			const logdata = bytesToBase64(fileBytes);
			const { key, password } = makeStorageKey();
			const logContent = JSON.stringify(
				generateStorageData(
					logdata,
					name,
					getUploaderIp(request),
					"",
					client,
					version,
				),
			);

			return persistLogOrBackup({
				request,
				env,
				store,
				frontendUrl,
				key,
				password,
				uniformId,
				name,
				logdata,
				logContent,
				corsHeaders,
			});
		} catch (error) {
			console.error("Upload error:", error);
			return jsonResponse(
				{ success: false, message: "Internal Server Error" },
				500,
				corsHeaders,
			);
		}
	}

	if (
		matchesApiPath(pathname, "/cleanup") &&
		(request.method === "GET" || request.method === "POST")
	) {
		const corsHeaders = getCorsHeaders(frontendUrl, "GET, POST, OPTIONS");
		return jsonResponse({ error: "Not Found" }, 404, corsHeaders);
	}

	if (matchesApiPath(pathname, "/load_data") && request.method === "GET") {
		const corsHeaders = getCorsHeaders(frontendUrl, "GET, OPTIONS");
		try {
			const key = searchParams.get("key");
			const password = searchParams.get("password");

			if (!key || !password) {
				return jsonResponse(
					{ error: "Missing key or password" },
					400,
					corsHeaders,
				);
			}

			const clientIp = getUploaderIp(request);
			const loadFailureKey = `${clientIp}:${key}`;
			const activeRecord = loadDataFailures.get(loadFailureKey);
			if (
				activeRecord &&
				activeRecord.count >= LOAD_DATA_FAILURE_LIMIT &&
				activeRecord.resetAt > Date.now()
			) {
				return jsonResponse(
					{ error: "Too many failed load attempts" },
					429,
					{
						...corsHeaders,
						"Retry-After": retryAfterSeconds(activeRecord),
					},
				);
			}

			const storedData = await store.readPublicLog(key, password);
			if (storedData === null) {
				consumeRateLimit(
					loadDataFailures,
					loadFailureKey,
					LOAD_DATA_FAILURE_LIMIT,
					LOAD_DATA_FAILURE_WINDOW_MS,
				);
				return jsonResponse({ error: "Data not found" }, 404, corsHeaders);
			}
			clearRateLimit(loadDataFailures, loadFailureKey);

			return new Response(storedData, {
				status: 200,
				headers: {
					...corsHeaders,
					"Content-Type": "application/json",
				},
			});
		} catch (error) {
			console.error("Load data error:", error);
			return jsonResponse(
				{ error: "服务器错误 Internal Server Error" },
				500,
				corsHeaders,
			);
		}
	}

	if (matchesApiPath(pathname, "/backup-upload") && request.method === "PUT") {
		const uploadRateKey = `${getUploaderIp(request)}:backup-upload`;
		const uploadRecord = consumeRateLimit(
			uploadAttempts,
			uploadRateKey,
			UPLOAD_LIMIT,
			UPLOAD_WINDOW_MS,
		);
		if (!uploadRecord) {
			const activeRecord = uploadAttempts.get(uploadRateKey);
			return jsonResponse(
				{ success: false, message: "Too many upload requests" },
				429,
				{
					"Retry-After": retryAfterSeconds(activeRecord),
				},
			);
		}
		const sizeError = rejectOversizedRequest(request, maxUploadMb, {});
		if (sizeError) return sizeError;

		try {
			const body = await request.json();
			const name = String(body?.name || "").trim();
			const uniformId = String(body?.uniform_id || "").trim();
			const logdata = String(body?.logdata || "");
			const client = String(body?.client || "Scardice").trim() || "Scardice";
			const version = String(body?.version || "").trim();

			if (!uniformId || !name || !logdata) {
				return jsonResponse(
					{
						success: false,
						message: "Missing required fields: uniform_id, name, or logdata",
					},
					400,
				);
			}

			if (!validateUniformId(uniformId)) {
				return jsonResponse(
					{
						success: false,
						message: "uniform_id field did not pass validation",
					},
					400,
				);
			}

			const blocked = await rejectDangerousUpload({
				request,
				env,
				route: "/api/dice/backup-upload",
				name,
				uniformId,
				parts: [
					{ source: "field:name", text: name },
					{ source: "field:uniform_id", text: uniformId },
					{ source: "field:client", text: client },
					{ source: "field:version", text: version },
					{ source: "field:logdata", base64: logdata },
				],
			});
			if (blocked) return blocked;

			const { key, password } = makeStorageKey();
			const logContent = JSON.stringify(
				generateStorageData(
					logdata,
					name,
					getUploaderIp(request),
					"Backup upload",
					client,
					version,
				),
			);

			try {
				const storedText = await archiveCqResources(env, logContent, request);
				await store.addLogRecord({
					publicKey: key,
					password,
					uniformId,
					storedText,
				});
				maybeCleanupAfterUpload(store, env);
				return jsonResponse(
					{ url: `${frontendUrl}?key=${key}#${password}` },
					200,
				);
			} catch (storageError) {
				const errorMsg = String(
					storageError?.message || storageError?.toString() || "Unknown error",
				);
				console.error(`Backup Upload: database storage failed: ${errorMsg}`);

				const backupApiUrl = await resolveBackupApi(env);
				if (!backupApiUrl) {
					return jsonResponse(
						{ success: false, message: "Database storage unavailable" },
						500,
					);
				}

				try {
					const visitedHosts = Array.isArray(body?.visitedHosts)
						? body.visitedHosts.map(String)
						: [];
					const currentHost = new URL(request.url).host;
					const backupResult = await uploadToBackupApi(
						backupApiUrl,
						uniformId,
						name,
						logdata,
						[...visitedHosts, currentHost],
					);
					return jsonResponse(backupResult, 202);
				} catch (backupError) {
					const backupMsg = String(
						backupError?.message || backupError?.toString() || "Unknown error",
					);
					console.error(`Backup Upload: next level backup failed: ${backupMsg}`);
					return jsonResponse(
						{ success: false, message: "Backup API unavailable" },
						500,
					);
				}
			}
		} catch (error) {
			console.error("Backup upload error:", error);
			return jsonResponse(
				{ success: false, message: "Internal Server Error" },
				500,
			);
		}
	}

	if (
		matchesApiPath(pathname, "/w4123") &&
		(request.method === "PUT" || request.method === "POST")
	) {
		const corsHeaders = getCorsHeaders(frontendUrl, "PUT, POST, OPTIONS");
		const uploadRateKey = `${getUploaderIp(request)}:w4123`;
		const uploadRecord = consumeRateLimit(
			uploadAttempts,
			uploadRateKey,
			UPLOAD_LIMIT,
			UPLOAD_WINDOW_MS,
		);
		if (!uploadRecord) {
			const activeRecord = uploadAttempts.get(uploadRateKey);
			return jsonResponse(
				{ success: false, message: "Too many upload requests" },
				429,
				{
					...corsHeaders,
					"Retry-After": retryAfterSeconds(activeRecord),
				},
			);
		}
		const sizeError = rejectOversizedRequest(request, maxUploadMb, corsHeaders);
		if (sizeError) return sizeError;

		try {
			let name = "";
			let uniformId = "";
			let logdata = "";
			let textUpload = "";
			let inspectionParts: InspectionPart[] = [];

			const contentType = request.headers.get("Content-Type") || "";
			if (contentType.includes("multipart/form-data")) {
				const formData = await request.formData();
				name = getTextField(formData.get("name"));
				uniformId = getTextField(formData.get("uniform_id"));
				const file = formData.get("file");

				if (!name || !uniformId || !isFileLike(file)) {
					return jsonResponse(
						{
							success: false,
							message: "Missing required fields: name, uniform_id, or file",
						},
						400,
						corsHeaders,
					);
				}

				if (file.size > maxUploadMb * 1024 * 1024) {
					return jsonResponse(
						{
							success: false,
							message: `File size exceeds ${maxUploadMb}MB limit`,
						},
						413,
						corsHeaders,
					);
				}

				const fileBytes = new Uint8Array(await file.arrayBuffer());
				textUpload = new TextDecoder("utf-8").decode(fileBytes);
				inspectionParts = [
					{ source: "field:name", text: name },
					{ source: "field:uniform_id", text: uniformId },
					{ source: "file:text", text: textUpload },
				];
			} else {
				const body = await request.json();
				name = String(body?.name || "").trim();
				logdata = String(body?.logdata || "");
				uniformId = String(body?.uniform_id || "").trim();

				if (!uniformId || !name || !logdata) {
					return jsonResponse(
						{
							success: false,
							message: "Missing required fields: uniform_id, name, or logdata",
						},
						400,
						corsHeaders,
					);
				}
				inspectionParts = [
					{ source: "field:name", text: name },
					{ source: "field:uniform_id", text: uniformId },
					{ source: "field:logdata", base64: logdata },
				];
			}

			if (!validateUniformId(uniformId)) {
				return jsonResponse(
					{
						success: false,
						message: "uniform_id field did not pass validation",
					},
					400,
					corsHeaders,
				);
			}

			const blocked = await rejectDangerousUpload({
				request,
				env,
				route: "/api/dice/w4123",
				name,
				uniformId,
				headers: corsHeaders,
				parts: inspectionParts,
			});
			if (blocked) return blocked;

			if (contentType.includes("multipart/form-data")) {
				const logItems = parseTextLogToScardiceFormat(textUpload);

				if (logItems.length === 0) {
					return jsonResponse(
						{
							success: false,
							message: "日志解析失败：没有找到有效的日志条目",
						},
						400,
						corsHeaders,
					);
				}

				const logJson = JSON.stringify({
					version: 1,
					items: logItems,
				});
				const logBytes = new TextEncoder().encode(logJson);
				const compressed = zlibSync(logBytes);
				logdata = bytesToBase64(compressed);

				console.log(
					`[W4123] Original size: ${logBytes.length} bytes, Compressed: ${compressed.length} bytes, Ratio: ${((compressed.length / logBytes.length) * 100).toFixed(1)}%`,
				);
			}

			const { key, password } = makeStorageKey();
			const logContent = JSON.stringify(
				generateStorageData(
					logdata,
					name,
					getUploaderIp(request),
					"Uploaded by w4123 plugin",
				),
			);

			const storedText = await archiveCqResources(env, logContent, request);
			await store.addLogRecord({
				publicKey: key,
				password,
				uniformId,
				storedText,
			});
			maybeCleanupAfterUpload(store, env);

			return jsonResponse(
				{ url: `${frontendUrl}?key=${key}#${password}` },
				200,
				corsHeaders,
			);
		} catch (error) {
			console.error("W4123 upload error:", error);
			return jsonResponse(
				{
					success: false,
					message: "Internal Server Error",
				},
				500,
				corsHeaders,
			);
		}
	}

	console.log(`[FALLBACK] No route matched for: ${request.method} ${pathname}`);
	return new Response("访问的API接口不存在或方式错误，检查API设置是否正确", {
		status: 404,
	});
}

/**
 * Parse text log to Scardice format.
 * Example: 昵称(ID) 时间\n消息内容\n\n
 */
function parseTextLogToScardiceFormat(text: string) {
	const items = [];
	const lines = text.split("\n");
	let currentItem = null;
	let id = 0;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		const headerMatch = line.match(/^(.+)\((.+?)\)\s+(.+)$/);

		if (headerMatch) {
			if (currentItem?.message) {
				currentItem.id = ++id;
				currentItem.isDice = isDiceCommand(currentItem.message);
				currentItem.commandId = currentItem.isDice ? 1 : 0;
				items.push(currentItem);
			}

			currentItem = {
				nickname: headerMatch[1],
				IMUserId: headerMatch[2],
				timeText: headerMatch[3],
				message: "",
			};

			const timeMatch = headerMatch[3].match(
				/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/,
			);
			if (timeMatch) {
				const time = new Date(timeMatch[1]);
				if (!Number.isNaN(time.getTime())) {
					currentItem.time = Math.floor(time.getTime() / 1000);
				}
			}
		} else if (currentItem && line !== "") {
			currentItem.message = currentItem.message
				? `${currentItem.message}\n${line}`
				: line;
		}
	}

	if (currentItem?.message) {
		currentItem.id = ++id;
		currentItem.isDice = isDiceCommand(currentItem.message);
		currentItem.commandId = currentItem.isDice ? 1 : 0;
		items.push(currentItem);
	}

	return items;
}

function isDiceCommand(message: string): boolean {
	const diceCommands = [
		".r",
		".rh",
		".ra",
		".raa",
		".rs",
		".rc",
		".d",
		".log",
		".nn",
		".n",
	];
	const lowerMsg = message.trim().toLowerCase();
	return diceCommands.some((cmd) => lowerMsg.startsWith(cmd));
}

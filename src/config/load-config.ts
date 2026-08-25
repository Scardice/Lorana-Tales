import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import toml from "toml";

/**
 * Default configuration values used when config.toml omits a field.
 */
const PROJECT_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const EXPLICIT_CONFIG_PATH =
	process.env.SCARDICE_CONFIG || process.env.CONFIG_FILE;

const CONFIG_CANDIDATES = [
	path.join(PROJECT_ROOT, "config.toml"),
	"/etc/scardice-story-painter/config.toml",
	"/etc/scardice-story-painter.toml",
].filter(Boolean);

const DEFAULT_CONFIG = {
	server: {
		host: "0.0.0.0",
		port: 3000,
		trust_proxy: false,
		allowed_hosts: ["localhost", "127.0.0.1", "::1"],
	},
	storage: {
		sqlite_path: "./data/scardice.db",
	},
	resource_cache: {
		enabled: false,
		path: "./data/cq-resources",
		retention_days: 60,
		max_file_mb: 12,
		max_resources_per_log: 40,
		image_quality: 65,
		allowed_hosts: ["*.qq.com", "*.qlogo.cn", "*.qpic.cn", "*.gtimg.cn"],
		allow_public_hosts: false,
		download_timeout_seconds: 15,
	},
	accounts: {
		enabled: false,
		registration_enabled: true,
		encryption_key: "",
		session_days: 30,
		trusted_device_days: 90,
		cookie_same_site: "auto",
		allowed_email_domains: [],
		max_project_mb: 25,
		max_asset_mb: 12,
		captcha_provider: "image",
		captcha_ttl_seconds: 120,
		risk_trust_minutes: 30,
		risk_cooldown_minutes: 15,
		email_code_ttl_minutes: 10,
		email_code_resend_seconds: 60,
		email_code_per_hour: 5,
		ip_email_code_per_hour: 10,
		smtp: {
			host: "",
			port: 587,
			secure: false,
			user: "",
			password: "",
			from: "",
		},
		altcha: {
			hmac_key: "",
			max_number: 100000,
		},
		turnstile: {
			site_key: "",
			secret_key: "",
		},
		hcaptcha: {
			site_key: "",
			secret_key: "",
		},
	},
	app: {
		frontend_url: "",
		log_retention_days: 60,
		max_upload_mb: 5,
		cleanup_on_start: false,
		cleanup_after_upload: true,
		backup_upload_api: "",
	},
	admin: {
		password: "",
	},
	metrics: {
		enabled: false,
		token: "",
	},
	security: {
		injection_guard_enabled: true,
		audit_log_path: "./data/security-audit.log",
		warning_quotes: [
			"Hey bro, what the fuck are you doing? Stop dreaming about being a hacker, you low-tech noob! 👎👎👎 Wake up, the floor is freezing!",
		],
		admin_bruteforce_block_enabled: true,
		admin_bruteforce_max_attempts: 8,
		admin_bruteforce_window_seconds: 60,
		admin_bruteforce_block_seconds: 60,
	},
};

/**
 * Deep-merge a partial config into defaults.
 * Only merges known top-level sections (server, storage, app).
 */
function deepMerge(defaults, override) {
	const result = { ...defaults };
	if (!override) return result;
	for (const key of Object.keys(defaults)) {
		if (override[key] && typeof override[key] === "object") {
			result[key] = { ...defaults[key], ...override[key] };
		}
	}
	return result;
}

function parseBoolean(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function parseList(value) {
	if (Array.isArray(value)) {
		return value.map(String).map((item) => item.trim()).filter(Boolean);
	}
	if (typeof value !== "string") return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function resolveConfigPath() {
	if (EXPLICIT_CONFIG_PATH) {
		const explicitPath = path.resolve(EXPLICIT_CONFIG_PATH);
		if (!fs.existsSync(explicitPath)) {
			throw new Error(
				`[config] Explicit config file does not exist: ${explicitPath}`,
			);
		}
		return explicitPath;
	}

	return CONFIG_CANDIDATES.find((candidate) => fs.existsSync(candidate));
}

/**
 * Load configuration from config.toml with optional env-var overrides.
 *
 * Priority (highest to lowest):
 *   1. Environment variables
 *   2. config.toml values
 *   3. Built-in defaults
 *
 * @returns {object} Config object with server, storage, and app sections.
 */
export function loadConfig() {
	let fileConfig: any = {};

	// Load the first available config file.
	const configPath = resolveConfigPath();
	if (configPath) {
		try {
			const raw = fs.readFileSync(configPath, "utf-8");
			fileConfig = toml.parse(raw);
			console.error(`[config] Loaded ${configPath}`);
		} catch (err) {
			throw new Error(`[config] Failed to parse ${configPath}: ${err.message}`);
		}
	} else {
		console.error(`[config] No config file found, using defaults`);
	}

	// Merge: defaults ← file config
	const config = deepMerge(DEFAULT_CONFIG, fileConfig);
	config.accounts.smtp = {
		...DEFAULT_CONFIG.accounts.smtp,
		...(fileConfig.accounts?.smtp || {}),
	};
	config.accounts.altcha = {
		...DEFAULT_CONFIG.accounts.altcha,
		...(fileConfig.accounts?.altcha || {}),
	};
	config.accounts.turnstile = {
		...DEFAULT_CONFIG.accounts.turnstile,
		...(fileConfig.accounts?.turnstile || {}),
	};
	config.accounts.hcaptcha = {
		...DEFAULT_CONFIG.accounts.hcaptcha,
		...(fileConfig.accounts?.hcaptcha || {}),
	};

	// Environment variable overrides (highest priority)
	if (process.env.HOST) config.server.host = process.env.HOST;
	if (process.env.PORT) {
		const p = parseInt(process.env.PORT, 10);
		if (!Number.isNaN(p)) config.server.port = p;
	}
	if (process.env.TRUST_PROXY !== undefined)
		config.server.trust_proxy = parseBoolean(
			process.env.TRUST_PROXY,
			config.server.trust_proxy,
		);
	if (process.env.ALLOWED_HOSTS)
		config.server.allowed_hosts = parseList(process.env.ALLOWED_HOSTS);
	if (process.env.SQLITE_PATH)
		config.storage.sqlite_path = process.env.SQLITE_PATH;
	if (process.env.DATABASE_PATH)
		config.storage.sqlite_path = process.env.DATABASE_PATH;
	if (process.env.CQ_RESOURCE_CACHE_ENABLED !== undefined)
		config.resource_cache.enabled = parseBoolean(
			process.env.CQ_RESOURCE_CACHE_ENABLED,
			config.resource_cache.enabled,
		);
	if (process.env.CQ_RESOURCE_CACHE_PATH)
		config.resource_cache.path = process.env.CQ_RESOURCE_CACHE_PATH;
	if (process.env.CQ_RESOURCE_CACHE_RETENTION_DAYS) {
		const d = parseInt(process.env.CQ_RESOURCE_CACHE_RETENTION_DAYS, 10);
		if (!Number.isNaN(d) && d > 0) config.resource_cache.retention_days = d;
	}
	if (process.env.CQ_RESOURCE_CACHE_MAX_FILE_MB) {
		const mb = parseInt(process.env.CQ_RESOURCE_CACHE_MAX_FILE_MB, 10);
		if (!Number.isNaN(mb) && mb > 0) config.resource_cache.max_file_mb = mb;
	}
	if (process.env.CQ_RESOURCE_CACHE_MAX_RESOURCES_PER_LOG) {
		const value = parseInt(process.env.CQ_RESOURCE_CACHE_MAX_RESOURCES_PER_LOG, 10);
		if (!Number.isNaN(value) && value > 0)
			config.resource_cache.max_resources_per_log = value;
	}
	if (process.env.CQ_RESOURCE_CACHE_IMAGE_QUALITY) {
		const value = parseInt(process.env.CQ_RESOURCE_CACHE_IMAGE_QUALITY, 10);
		if (!Number.isNaN(value)) config.resource_cache.image_quality = value;
	}
	if (process.env.CQ_RESOURCE_CACHE_ALLOWED_HOSTS)
		config.resource_cache.allowed_hosts = parseList(
			process.env.CQ_RESOURCE_CACHE_ALLOWED_HOSTS,
		);
	if (process.env.CQ_RESOURCE_CACHE_ALLOW_PUBLIC_HOSTS !== undefined)
		config.resource_cache.allow_public_hosts = parseBoolean(
			process.env.CQ_RESOURCE_CACHE_ALLOW_PUBLIC_HOSTS,
			config.resource_cache.allow_public_hosts,
		);
	if (process.env.CQ_RESOURCE_CACHE_DOWNLOAD_TIMEOUT_SECONDS) {
		const value = parseInt(process.env.CQ_RESOURCE_CACHE_DOWNLOAD_TIMEOUT_SECONDS, 10);
		if (!Number.isNaN(value) && value > 0)
			config.resource_cache.download_timeout_seconds = value;
	}
	if (process.env.ACCOUNTS_ENABLED !== undefined)
		config.accounts.enabled = parseBoolean(process.env.ACCOUNTS_ENABLED, config.accounts.enabled);
	if (process.env.ACCOUNTS_REGISTRATION_ENABLED !== undefined)
		config.accounts.registration_enabled = parseBoolean(
			process.env.ACCOUNTS_REGISTRATION_ENABLED,
			config.accounts.registration_enabled,
		);
	if (process.env.ACCOUNTS_ENCRYPTION_KEY)
		config.accounts.encryption_key = process.env.ACCOUNTS_ENCRYPTION_KEY;
	if (process.env.ACCOUNTS_SESSION_DAYS)
		config.accounts.session_days = parseInt(process.env.ACCOUNTS_SESSION_DAYS, 10) || config.accounts.session_days;
	if (process.env.ACCOUNTS_TRUSTED_DEVICE_DAYS)
		config.accounts.trusted_device_days = parseInt(process.env.ACCOUNTS_TRUSTED_DEVICE_DAYS, 10) || config.accounts.trusted_device_days;
	if (process.env.ACCOUNTS_COOKIE_SAME_SITE)
		config.accounts.cookie_same_site = process.env.ACCOUNTS_COOKIE_SAME_SITE;
	if (process.env.ACCOUNTS_ALLOWED_EMAIL_DOMAINS)
		config.accounts.allowed_email_domains = parseList(process.env.ACCOUNTS_ALLOWED_EMAIL_DOMAINS);
	if (process.env.ACCOUNTS_CAPTCHA_PROVIDER)
		config.accounts.captcha_provider = process.env.ACCOUNTS_CAPTCHA_PROVIDER;
	if (process.env.SMTP_HOST) config.accounts.smtp.host = process.env.SMTP_HOST;
	if (process.env.SMTP_PORT) config.accounts.smtp.port = parseInt(process.env.SMTP_PORT, 10) || config.accounts.smtp.port;
	if (process.env.SMTP_SECURE !== undefined)
		config.accounts.smtp.secure = parseBoolean(process.env.SMTP_SECURE, config.accounts.smtp.secure);
	if (process.env.SMTP_USER) config.accounts.smtp.user = process.env.SMTP_USER;
	if (process.env.SMTP_PASSWORD) config.accounts.smtp.password = process.env.SMTP_PASSWORD;
	if (process.env.SMTP_FROM) config.accounts.smtp.from = process.env.SMTP_FROM;
	if (process.env.ALTCHA_HMAC_KEY) config.accounts.altcha.hmac_key = process.env.ALTCHA_HMAC_KEY;
	if (process.env.TURNSTILE_SITE_KEY) config.accounts.turnstile.site_key = process.env.TURNSTILE_SITE_KEY;
	if (process.env.TURNSTILE_SECRET_KEY) config.accounts.turnstile.secret_key = process.env.TURNSTILE_SECRET_KEY;
	if (process.env.HCAPTCHA_SITE_KEY) config.accounts.hcaptcha.site_key = process.env.HCAPTCHA_SITE_KEY;
	if (process.env.HCAPTCHA_SECRET_KEY) config.accounts.hcaptcha.secret_key = process.env.HCAPTCHA_SECRET_KEY;
	if (process.env.FRONTEND_URL)
		config.app.frontend_url = process.env.FRONTEND_URL;
	if (process.env.LOG_RETENTION_DAYS) {
		const d = parseInt(process.env.LOG_RETENTION_DAYS, 10);
		if (!Number.isNaN(d) && d > 0) config.app.log_retention_days = d;
	}
	if (process.env.MAX_UPLOAD_MB) {
		const mb = parseInt(process.env.MAX_UPLOAD_MB, 10);
		if (!Number.isNaN(mb) && mb > 0) config.app.max_upload_mb = mb;
	}
	if (process.env.CLEANUP_ON_START !== undefined)
		config.app.cleanup_on_start = parseBoolean(
			process.env.CLEANUP_ON_START,
			config.app.cleanup_on_start,
		);
	if (process.env.CLEANUP_AFTER_UPLOAD !== undefined)
		config.app.cleanup_after_upload = parseBoolean(
			process.env.CLEANUP_AFTER_UPLOAD,
			config.app.cleanup_after_upload,
		);
	if (process.env.BACKUP_UPLOAD_API)
		config.app.backup_upload_api = process.env.BACKUP_UPLOAD_API;
	if (process.env.ADMIN_PASSWORD)
		config.admin.password = process.env.ADMIN_PASSWORD;
	if (process.env.METRICS_ENABLED !== undefined)
		config.metrics.enabled = parseBoolean(
			process.env.METRICS_ENABLED,
			config.metrics.enabled,
		);
	if (process.env.METRICS_TOKEN) config.metrics.token = process.env.METRICS_TOKEN;
	if (process.env.INJECTION_GUARD_ENABLED !== undefined)
		config.security.injection_guard_enabled = parseBoolean(
			process.env.INJECTION_GUARD_ENABLED,
			config.security.injection_guard_enabled,
		);
	if (process.env.SECURITY_AUDIT_LOG_PATH)
		config.security.audit_log_path = process.env.SECURITY_AUDIT_LOG_PATH;
	if (process.env.SECURITY_WARNING_QUOTES)
		config.security.warning_quotes = parseList(
			process.env.SECURITY_WARNING_QUOTES,
		);
	if (process.env.ADMIN_BRUTEFORCE_BLOCK_ENABLED !== undefined)
		config.security.admin_bruteforce_block_enabled = parseBoolean(
			process.env.ADMIN_BRUTEFORCE_BLOCK_ENABLED,
			config.security.admin_bruteforce_block_enabled,
		);
	if (process.env.ADMIN_BRUTEFORCE_MAX_ATTEMPTS) {
		const value = parseInt(process.env.ADMIN_BRUTEFORCE_MAX_ATTEMPTS, 10);
		if (!Number.isNaN(value) && value > 0)
			config.security.admin_bruteforce_max_attempts = value;
	}
	if (process.env.ADMIN_BRUTEFORCE_WINDOW_SECONDS) {
		const value = parseInt(process.env.ADMIN_BRUTEFORCE_WINDOW_SECONDS, 10);
		if (!Number.isNaN(value) && value > 0)
			config.security.admin_bruteforce_window_seconds = value;
	}
	if (process.env.ADMIN_BRUTEFORCE_BLOCK_SECONDS) {
		const value = parseInt(process.env.ADMIN_BRUTEFORCE_BLOCK_SECONDS, 10);
		if (!Number.isNaN(value) && value > 0)
			config.security.admin_bruteforce_block_seconds = value;
	}

	config.server.allowed_hosts = parseList(config.server.allowed_hosts);
	config.resource_cache.allowed_hosts = parseList(config.resource_cache.allowed_hosts);
	config.accounts.allowed_email_domains = parseList(config.accounts.allowed_email_domains);
	config.security.warning_quotes = parseList(config.security.warning_quotes);

	if (!path.isAbsolute(config.storage.sqlite_path)) {
		config.storage.sqlite_path = path.resolve(
			PROJECT_ROOT,
			config.storage.sqlite_path,
		);
	}
	if (!path.isAbsolute(config.security.audit_log_path)) {
		config.security.audit_log_path = path.resolve(
			PROJECT_ROOT,
			config.security.audit_log_path,
		);
	}
	if (!path.isAbsolute(config.resource_cache.path)) {
		config.resource_cache.path = path.resolve(PROJECT_ROOT, config.resource_cache.path);
	}

	return config;
}

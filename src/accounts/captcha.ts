import crypto from "node:crypto";
import { createChallenge, verifySolution } from "altcha-lib/v1";
import svgCaptcha from "svg-captcha";

type Provider = "image" | "altcha" | "turnstile" | "hcaptcha";

type ChallengeRecord = {
	provider: Provider;
	answerHash?: string;
	altchaSignature?: string;
	expiresAt: number;
	used: boolean;
};

function hash(value: string) {
	return crypto.createHash("sha256").update(value).digest("hex");
}

export class CaptchaService {
	readonly config;
	private challenges = new Map<string, ChallengeRecord>();
	private clearanceTokens = new Map<string, { scope: string; subject: string; expiresAt: number; used: boolean }>();
	private trustedSubjects = new Map<string, number>();

	constructor(config) {
		this.config = config;
	}

	private provider(): Provider {
		const value = String(this.config.captcha_provider || "image").toLowerCase();
		return ["altcha", "turnstile", "hcaptcha"].includes(value) ? (value as Provider) : "image";
	}

	private cleanup() {
		const now = Date.now();
		for (const [id, value] of this.challenges) if (value.expiresAt <= now || value.used) this.challenges.delete(id);
		for (const [id, value] of this.clearanceTokens) if (value.expiresAt <= now || value.used) this.clearanceTokens.delete(id);
		for (const [subject, expiresAt] of this.trustedSubjects) if (expiresAt <= now) this.trustedSubjects.delete(subject);
	}

	async create() {
		this.cleanup();
		if (this.challenges.size >= 5000) this.challenges.delete(this.challenges.keys().next().value as string);
		const provider = this.provider();
		const id = crypto.randomUUID();
		const expiresAt = Date.now() + Math.max(30, Number(this.config.captcha_ttl_seconds || 120)) * 1000;
		if (provider === "image") {
			const generated = svgCaptcha.create({
				size: 5,
				noise: 5,
				color: true,
				background: "#eef2f7",
				ignoreChars: "0oO1ilI",
				width: 180,
				height: 56,
			});
			this.challenges.set(id, { provider, answerHash: hash(`${id}:${generated.text.toLowerCase()}`), expiresAt, used: false });
			return { id, provider, expiresAt, image: generated.data };
		}
		if (provider === "altcha") {
			const hmacKey = String(this.config.altcha?.hmac_key || this.config.encryption_key || "");
			const challenge = await createChallenge({
				hmacKey,
				maxNumber: Math.max(10000, Number(this.config.altcha?.max_number || 100000)),
				expires: new Date(expiresAt),
				params: { challengeId: id },
			});
			this.challenges.set(id, { provider, altchaSignature: challenge.signature, expiresAt, used: false });
			return { id, provider, expiresAt, challenge };
		}
		const siteKey = String(this.config[provider]?.site_key || "");
		this.challenges.set(id, { provider, expiresAt, used: false });
		return { id, provider, expiresAt, siteKey };
	}

	async verify(input: { id: string; answer?: string; payload?: unknown; token?: string; remoteIp?: string }): Promise<boolean> {
		this.cleanup();
		const record = this.challenges.get(input.id);
		if (!record || record.used || record.expiresAt <= Date.now()) return false;
		let valid = false;
		if (record.provider === "image") {
			valid = hash(`${input.id}:${String(input.answer || "").trim().toLowerCase()}`) === record.answerHash;
		} else if (record.provider === "altcha") {
			try {
				valid = await verifySolution(input.payload as string, String(this.config.altcha?.hmac_key || this.config.encryption_key || ""));
			} catch {
				valid = false;
			}
		} else {
			const endpoint = record.provider === "turnstile"
				? "https://challenges.cloudflare.com/turnstile/v0/siteverify"
				: "https://api.hcaptcha.com/siteverify";
			const body = new URLSearchParams({
				secret: String(this.config[record.provider]?.secret_key || ""),
				response: String(input.token || ""),
			});
			if (input.remoteIp) body.set("remoteip", input.remoteIp);
			try {
				const response = await fetch(endpoint, { method: "POST", body, signal: AbortSignal.timeout(8000) });
				valid = !!(await response.json() as { success?: boolean }).success;
			} catch {
				valid = false;
			}
		}
		if (valid) record.used = true;
		return valid;
	}

	issueClearance(subject: string, scope: string): string {
		this.cleanup();
		if (this.clearanceTokens.size >= 5000) this.clearanceTokens.delete(this.clearanceTokens.keys().next().value as string);
		const token = crypto.randomBytes(32).toString("base64url");
		this.clearanceTokens.set(hash(token), {
			subject,
			scope,
			expiresAt: Date.now() + Math.max(1, Number(this.config.risk_trust_minutes || 30)) * 60000,
			used: false,
		});
		return token;
	}

	consumeClearance(token: string, subject: string, scope: string): boolean {
		this.cleanup();
		const record = this.clearanceTokens.get(hash(token || ""));
		if (!record || record.used || record.expiresAt <= Date.now() || record.subject !== subject || record.scope !== scope) return false;
		record.used = true;
		if (this.trustedSubjects.size >= 5000 && !this.trustedSubjects.has(subject)) {
			this.trustedSubjects.delete(this.trustedSubjects.keys().next().value as string);
		}
		this.trustedSubjects.set(subject, record.expiresAt);
		return true;
	}

	isTrusted(subject: string): boolean {
		this.cleanup();
		return (this.trustedSubjects.get(subject) || 0) > Date.now();
	}
}

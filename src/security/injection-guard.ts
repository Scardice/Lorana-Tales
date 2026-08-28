import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inflateTextBounded } from "./bounded-inflate.js";

export type InjectionFinding = {
	ruleId: string;
	label: string;
	match: string;
	context: string;
	source: string;
};

export type InspectionPart = {
	source: string;
	text?: string;
	base64?: string;
	bytes?: Uint8Array;
};

export type InspectionResult = {
	findings: InjectionFinding[];
	inspectedBytes: number;
	contentSha256: string;
};

export type SecurityAuditInput = {
	auditLogPath: string;
	interceptId: string;
	event?: string;
	clientIp: string;
	route: string;
	method: string;
	name: string;
	uniformId: string;
	inspection: InspectionResult;
	metadata?: Record<string, unknown>;
};

export type SecurityWarningInput = {
	interceptId: string;
	reason: string;
	detail: string;
	quotes?: string[];
};

const MAX_FINDINGS = 12;
const CONTEXT_RADIUS = 72;
const MAX_INSPECTABLE_DECODED_BYTES = 16 * 1024 * 1024;
export const UPLOAD_INJECTION_REASON =
	"由于本次上传的日志包含危险的注入代码，已被安全系统拦截，请求内容以及IP已经被记录，请规范个人行为。";
const DEFAULT_WARNING_QUOTES = [
	"Hey bro, what the fuck are you doing? Stop dreaming about being a hacker, you low-tech noob! 👎👎👎 Wake up, the floor is freezing!",
];

const INJECTION_PATTERNS: Array<{
	ruleId: string;
	label: string;
	pattern: RegExp;
}> = [
	{
		ruleId: "html-script-tag",
		label: "HTML script tag",
		pattern: /<\s*\/?\s*script\b[^>]*>/gi,
	},
	{
		ruleId: "html-active-element",
		label: "Active HTML element",
		pattern: /<\s*(?:img|svg|iframe|object|embed|link|meta|base|form|input|button|math)\b[^>]*>/gi,
	},
	{
		ruleId: "html-event-handler",
		label: "Inline HTML event handler",
		pattern: /\bon[a-z]{3,}\s*=/gi,
	},
	{
		ruleId: "javascript-url",
		label: "JavaScript URL",
		pattern: /\bjavascript\s*:/gi,
	},
	{
		ruleId: "html-data-document",
		label: "HTML data document",
		pattern: /\bdata\s*:\s*text\/html\b/gi,
	},
	{
		ruleId: "ssti-expression",
		label: "Server-side template expression",
		pattern: /(?:\{\{[\s\S]{0,120}?\}\}|\$\{[\s\S]{0,120}?\}|<%=?[\s\S]{0,120}?%>)/g,
	},
	{
		ruleId: "sql-tautology",
		label: "SQL tautology",
		pattern: /(?:'|%27|")\s*(?:or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+/gi,
	},
	{
		ruleId: "sql-union",
		label: "SQL UNION query",
		pattern: /\bunion\s+(?:all\s+)?select\b/gi,
	},
	{
		ruleId: "sql-destructive",
		label: "Destructive SQL statement",
		pattern: /;\s*(?:drop|alter|truncate|delete)\s+(?:table|from|database)\b/gi,
	},
	{
		ruleId: "sql-time-delay",
		label: "SQL time-delay primitive",
		pattern: /\b(?:sleep|benchmark|pg_sleep|waitfor\s+delay)\s*\(/gi,
	},
	{
		ruleId: "command-substitution",
		label: "Shell command substitution",
		pattern: /(?:`[^`\n]{1,160}`|\$\([^)\n]{1,160}\))/g,
	},
	{
		ruleId: "sensitive-file-probe",
		label: "Sensitive file probe",
		pattern: /(?:\/etc\/passwd|\/proc\/self\/environ|c:\\\\windows\\\\win\.ini)/gi,
	},
];

function normalizeSnippet(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 260);
}

function contextFor(text: string, index: number, length: number): string {
	const start = Math.max(0, index - CONTEXT_RADIUS);
	const end = Math.min(text.length, index + length + CONTEXT_RADIUS);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < text.length ? "..." : "";
	return `${prefix}${normalizeSnippet(text.slice(start, end))}${suffix}`;
}

function scanText(
	source: string,
	text: string,
	findings: InjectionFinding[],
) {
	for (const rule of INJECTION_PATTERNS) {
		rule.pattern.lastIndex = 0;
		for (const match of text.matchAll(rule.pattern)) {
			if (findings.length >= MAX_FINDINGS) return;
			const matchedText = match[0] || "";
			findings.push({
				ruleId: rule.ruleId,
				label: rule.label,
				match: normalizeSnippet(matchedText),
				context: contextFor(text, match.index || 0, matchedText.length),
				source,
			});
		}
	}
}

function bytesFromBase64(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "base64"));
}

function decodeInspectableTexts(part: InspectionPart): string[] {
	const texts: string[] = [];
	if (part.text) texts.push(part.text);

	const bytes = part.bytes || (part.base64 ? bytesFromBase64(part.base64) : null);
	if (!bytes || bytes.byteLength === 0) return texts;

	try {
		texts.push(inflateTextBounded(bytes, MAX_INSPECTABLE_DECODED_BYTES).text);
		return texts;
	} catch {
		// Fall through to UTF-8/plaintext inspection below.
	}

	try {
		texts.push(Buffer.from(bytes).toString("utf-8"));
	} catch {
		// Binary data that cannot be decoded is not inspectable as text.
	}
	return texts;
}

export function inspectUploadParts(parts: InspectionPart[]): InspectionResult {
	const hash = crypto.createHash("sha256");
	const findings: InjectionFinding[] = [];
	let inspectedBytes = 0;

	for (const part of parts) {
		if (part.text) {
			hash.update(part.text);
			inspectedBytes += Buffer.byteLength(part.text, "utf-8");
		}
		if (part.base64) hash.update(part.base64);
		if (part.bytes) {
			hash.update(part.bytes);
			inspectedBytes += part.bytes.byteLength;
		}

		for (const [index, text] of decodeInspectableTexts(part).entries()) {
			scanText(index === 0 ? part.source : `${part.source}:decoded`, text, findings);
			if (findings.length >= MAX_FINDINGS) break;
		}
	}

	return {
		findings,
		inspectedBytes,
		contentSha256: hash.digest("hex"),
	};
}

function selectWarningQuote(quotes: string[] = []): string {
	const candidates = quotes.map((quote) => quote.trim()).filter(Boolean);
	const usable = candidates.length > 0 ? candidates : DEFAULT_WARNING_QUOTES;
	return usable[crypto.randomInt(0, usable.length)];
}

export function createSecurityInterceptId(): string {
	return `SIC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto
		.randomBytes(6)
		.toString("hex")
		.toUpperCase()}`;
}

export function formatInjectionFindingDetails(
	findings: InjectionFinding[],
): string {
	return findings
		.map((finding, index) =>
			[
				`[${index + 1}] ${finding.label} (${finding.ruleId})`,
				`source: ${finding.source}`,
				`match: ${finding.match}`,
				`context: ${finding.context}`,
			].join("\n"),
		)
		.join("\n\n");
}

export function formatSecurityWarning(input: SecurityWarningInput): string {
	const quote = selectWarningQuote(input.quotes);
	return [
		"操作已被安全系统拦截",
		"",
		`拦截ID：${input.interceptId}`,
		"如果认为是误报，请向系统管理员报告拦截ID。",
		"",
		"原因：",
		input.reason,
		"",
		`> “${quote}”——某人`,
		"",
		"原因详情：",
		"```text",
		input.detail,
		"```",
		"",
	].join("\n");
}

export function formatUploadInjectionWarning(
	interceptId: string,
	findings: InjectionFinding[],
	quotes: string[] = [],
): string {
	return formatSecurityWarning({
		interceptId,
		reason: UPLOAD_INJECTION_REASON,
		detail: formatInjectionFindingDetails(findings),
		quotes,
	});
}

export function formatBruteforceDetail(credentials: string[]): string {
	const credentialList =
		credentials.length > 0
			? credentials.map((credential) => `- ${credential}`).join("\n")
			: "- 未记录到凭据";
	return ["检测到爆破行为，尝试的凭据：", credentialList].join("\n");
}

export function formatFindingsForLegacyDisplay(
	findings: InjectionFinding[],
): string {
	return findings.map((finding, index) =>
		[
			`[${index + 1}] ${finding.label} (${finding.ruleId})`,
			`source: ${finding.source}`,
			`match: ${finding.match}`,
			`context: ${finding.context}`,
		].join("\n"),
	).join("\n\n");
}

export async function writeSecurityAuditLog(input: SecurityAuditInput) {
	const record = {
		timestamp: new Date().toISOString(),
		interceptId: input.interceptId,
		event: input.event || "upload_injection_blocked",
		clientIp: input.clientIp,
		route: input.route,
		method: input.method,
		name: input.name,
		uniformId: input.uniformId,
		contentSha256: input.inspection.contentSha256,
		inspectedBytes: input.inspection.inspectedBytes,
		findings: input.inspection.findings,
		metadata: input.metadata || {},
	};
	await fs.mkdir(path.dirname(input.auditLogPath), { recursive: true });
	await fs.appendFile(input.auditLogPath, `${JSON.stringify(record)}\n`, "utf-8");
}

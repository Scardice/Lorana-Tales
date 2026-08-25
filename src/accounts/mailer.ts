import nodemailer from "nodemailer";
import fs from "node:fs";

type TemplateValues = Record<"code" | "username" | "nickname" | "site_title" | "logo_url" | "purpose" | "expires_minutes", string>;

const DEFAULT_SUBJECT = "{{site_title}} {{purpose}}验证码";
const DEFAULT_TEXT = "{{nickname}}，你好：\n\n你的{{purpose}}验证码是：{{code}}\n验证码 {{expires_minutes}} 分钟内有效。若非本人操作，请忽略本邮件。";
const DEFAULT_HTML = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.7;color:#18201f">
{{logo_block}}<h2 style="margin:0 0 16px">{{site_title}}</h2><p>{{nickname}}，你好：</p>
<p>你的{{purpose}}验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">{{code}}</p>
<p>验证码 {{expires_minutes}} 分钟内有效。若非本人操作，请忽略本邮件。</p></div>`;

function escapeHtml(value: string) {
	return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
}

function renderTemplate(template: string, values: TemplateValues, html = false) {
	const safeValues = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, html ? escapeHtml(value) : value.replace(/[\r\n]+/g, " ")])) as Record<string, string>;
	safeValues.logo = safeValues.logo_url;
	const logoBlock = values.logo_url ? `<img src="${escapeHtml(values.logo_url)}" alt="${escapeHtml(values.site_title)}" style="display:block;max-width:220px;max-height:64px;margin:0 0 18px">` : "";
	return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, key: string) => key === "logo_block" && html ? logoBlock : safeValues[key] ?? "");
}

export class AccountMailer {
	readonly config;
	readonly transporter;

	constructor(config) {
		this.config = config;
		this.transporter = nodemailer.createTransport({
			host: config.host,
			port: Number(config.port || 587),
			secure: !!config.secure,
			auth: config.user ? { user: config.user, pass: config.password } : undefined,
			connectionTimeout: 10000,
			greetingTimeout: 10000,
			socketTimeout: 20000,
			tls: { rejectUnauthorized: true },
		});
	}

	async verifyConnection() {
		return this.transporter.verify();
	}

	private configuredTemplate(inlineValue: unknown, pathValue: unknown, fallback: string) {
		const configuredPath = String(pathValue || "").trim();
		if (configuredPath) return fs.readFileSync(configuredPath, "utf-8");
		return String(inlineValue || "").trim() || fallback;
	}

	async sendCode(email: string, code: string, purpose: string, context: Partial<TemplateValues> = {}) {
		const purposeText = purpose === "register" ? "注册" : purpose === "reset-password" ? "重置密码" : purpose === "change-email" ? "更改邮箱" : "登录";
		const values: TemplateValues = {
			code,
			username: String(context.username || ""),
			nickname: String(context.nickname || context.username || "用户"),
			site_title: String(context.site_title || this.config.site_title || "Lorana Tales"),
			logo_url: String(context.logo_url || this.config.logo_url || ""),
			purpose: purposeText,
			expires_minutes: String(context.expires_minutes || this.config.expires_minutes || "10"),
		};
		const subject = renderTemplate(this.configuredTemplate(this.config.subject_template, "", DEFAULT_SUBJECT), values);
		const text = renderTemplate(this.configuredTemplate(this.config.text_template, this.config.text_template_path, DEFAULT_TEXT), values);
		const html = renderTemplate(this.configuredTemplate(this.config.html_template, this.config.html_template_path, DEFAULT_HTML), values, true);
		await this.transporter.sendMail({
			from: this.config.from,
			to: email,
			subject,
			text,
			html,
		});
	}
}

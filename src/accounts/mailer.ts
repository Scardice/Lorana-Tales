import nodemailer from "nodemailer";

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

	async sendCode(email: string, code: string, purpose: string) {
		const purposeText = purpose === "register" ? "注册" : purpose === "reset-password" ? "重置密码" : "登录";
		await this.transporter.sendMail({
			from: this.config.from,
			to: email,
			subject: `余烬染色器${purposeText}验证码`,
			text: `你的${purposeText}验证码是：${code}\n\n验证码 10 分钟内有效。若非本人操作，请忽略本邮件。`,
			html: `<div style="font-family:system-ui,sans-serif;line-height:1.7"><h2>余烬染色器</h2><p>你的${purposeText}验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>验证码 10 分钟内有效。若非本人操作，请忽略本邮件。</p></div>`,
		});
	}
}

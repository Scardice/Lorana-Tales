export const DEFAULT_RESOURCE_ALLOWED_HOSTS = [
	"*.qq.com",
	"*.qq.com.cn",
	"*.qlogo.cn",
	"*.qpic.cn",
	"*.gtimg.cn",
	"*.gtimg.com",
	"*.ugcimg.cn",
	"*.discordapp.com",
	"*.kookapp.cn",
	"*.kookcdn.com",
	"*.kaiheila.cn",
] as const;

export function resourceHostMatches(host: string, allowedHosts: readonly string[]): boolean {
	const normalizedHost = host.trim().toLowerCase();
	return allowedHosts.some((rawRule) => {
		const rule = rawRule.trim().toLowerCase();
		return rule === normalizedHost || (rule.startsWith("*.") && normalizedHost.endsWith(rule.slice(1)));
	});
}

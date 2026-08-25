export function storyAvatarPlatform(id: string): "Discord" | "KOOK / QQ" | "QQ" | "其他平台" {
	const length = id.trim().length;
	if (length >= 16) return "Discord";
	if (length >= 9 && length <= 12) return "KOOK / QQ";
	if (length >= 5 && length <= 8) return "QQ";
	return "其他平台";
}

export function storyAvatarUrl(id: string, name = "", refresh = false): string {
	const value = id.trim();
	if (!/^\d{5,20}$/.test(value)) return "";
	const query = new URLSearchParams();
	if (name.trim()) query.set("name", name.trim());
	if (refresh) query.set("refresh", String(Date.now()));
	const suffix = query.size ? `?${query}` : "";
	return `/api/editor/avatar/user/${encodeURIComponent(value)}${suffix}`;
}

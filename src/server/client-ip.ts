import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";

type RequestLike = Pick<IncomingMessage, "headers" | "socket"> & {
	ip?: string;
};

const DIRECT_CLIENT_IP_HEADERS = [
	"cf-connecting-ip", // Cloudflare
	"true-client-ip", // Cloudflare Enterprise / Akamai
	"fastly-client-ip", // Fastly
	"x-real-ip", // Nginx and common reverse proxies
	"x-client-ip",
] as const;

function firstHeaderValue(
	value: IncomingHttpHeaders[string] | undefined,
): string {
	if (Array.isArray(value)) return value[0] || "";
	return String(value || "");
}

function normalizeCandidate(value: string): string {
	let candidate = value.trim().replace(/^"|"$/g, "");
	if (candidate.toLowerCase() === "unknown") return "";

	// RFC 7239 permits IPv6 values in brackets and may include a port.
	if (candidate.startsWith("[") && candidate.includes("]")) {
		candidate = candidate.slice(1, candidate.indexOf("]"));
	}

	return isIP(candidate) ? candidate : "";
}

function firstValidForwardedFor(value: string): string {
	for (const item of value.split(",")) {
		const candidate = normalizeCandidate(item);
		if (candidate) return candidate;
	}
	return "";
}

function firstValidRfc7239Forwarded(value: string): string {
	for (const entry of value.split(",")) {
		const match = /(?:^|;)\s*for\s*=\s*("[^"]+"|[^;,\s]+)/i.exec(entry);
		const candidate = match ? normalizeCandidate(match[1]) : "";
		if (candidate) return candidate;
	}
	return "";
}

function socketAddress(req: RequestLike): string {
	return req.socket?.remoteAddress || req.ip || "unknown";
}

/**
 * Resolve the client address only when the request came through a trusted
 * proxy. This keeps direct deployments safe from forged forwarding headers.
 */
export type TrustedProxyPolicy = boolean | string[];

export function isTrustedProxyRequest(req: RequestLike, policy: TrustedProxyPolicy): boolean {
	if (!policy) return false;
	const socket = normalizeCandidate(socketAddress(req).replace(/^::ffff:/, ""));
	if (!socket) return false;
	const entries = Array.isArray(policy) ? policy : ["127.0.0.1/32", "::1/128"];
	const list = new BlockList();
	for (const entry of entries) {
		const [address, prefixText] = String(entry).trim().split("/");
		const family = isIP(address);
		const prefix = Number(prefixText);
		if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) continue;
		list.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
	}
	return list.check(socket, isIP(socket) === 4 ? "ipv4" : "ipv6");
}

export function getClientIp(req: RequestLike, trustProxy: TrustedProxyPolicy): string {
	if (!isTrustedProxyRequest(req, trustProxy)) return socketAddress(req);

	for (const header of DIRECT_CLIENT_IP_HEADERS) {
		const candidate = normalizeCandidate(firstHeaderValue(req.headers[header]));
		if (candidate) return candidate;
	}

	const forwardedFor = firstValidForwardedFor(
		firstHeaderValue(req.headers["x-forwarded-for"]),
	);
	if (forwardedFor) return forwardedFor;

	const forwarded = firstValidRfc7239Forwarded(
		firstHeaderValue(req.headers.forwarded),
	);
	if (forwarded) return forwarded;

	return socketAddress(req);
}

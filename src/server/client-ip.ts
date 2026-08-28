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

function validForwardedFor(value: string): string[] {
	return value.split(",").map(normalizeCandidate).filter(Boolean);
}


function validRfc7239Forwarded(value: string): string[] {
	const result: string[] = [];
	for (const entry of value.split(",")) {
		const match = /(?:^|;)\s*for\s*=\s*("[^"]+"|[^;,\s]+)/i.exec(entry);
		const candidate = match ? normalizeCandidate(match[1]) : "";
		if (candidate) result.push(candidate);
	}
	return result;
}

function socketAddress(req: RequestLike): string {
	return req.socket?.remoteAddress || req.ip || "unknown";
}

/**
 * Resolve the client address only when the request came through a trusted
 * proxy. This keeps direct deployments safe from forged forwarding headers.
 */
export type TrustedProxyPolicy = boolean | string[];

function isTrustedAddress(candidate: string, policy: TrustedProxyPolicy): boolean {
	if (!policy) return false;
	const address = normalizeCandidate(candidate.replace(/^::ffff:/, ""));
	if (!address) return false;
	const entries = Array.isArray(policy) ? policy : ["127.0.0.1/32", "::1/128"];
	const list = new BlockList();
	for (const entry of entries) {
		const [address, prefixText] = String(entry).trim().split("/");
		const family = isIP(address);
		const prefix = Number(prefixText);
		if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) continue;
		list.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
	}
	return list.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
}

export function isTrustedProxyRequest(req: RequestLike, policy: TrustedProxyPolicy): boolean {
	return isTrustedAddress(socketAddress(req), policy);
}

export function getClientIp(req: RequestLike, trustProxy: TrustedProxyPolicy): string {
	if (!isTrustedProxyRequest(req, trustProxy)) return socketAddress(req);

	for (const header of DIRECT_CLIENT_IP_HEADERS) {
		const candidate = normalizeCandidate(firstHeaderValue(req.headers[header]));
		if (candidate) return candidate;
	}

	const forwardedFor = validForwardedFor(
		firstHeaderValue(req.headers["x-forwarded-for"]),
	);
	// Walk from the proxy nearest to us towards the client and stop at the
	// first untrusted hop. Taking the left-most value lets an attacker prepend
	// a forged address whenever a proxy appends instead of replacing XFF.
	for (let index = forwardedFor.length - 1; index >= 0; index -= 1) {
		if (!isTrustedAddress(forwardedFor[index], trustProxy)) return forwardedFor[index];
	}
	if (forwardedFor.length) return forwardedFor[0];

	const forwarded = validRfc7239Forwarded(
		firstHeaderValue(req.headers.forwarded),
	);
	for (let index = forwarded.length - 1; index >= 0; index -= 1) {
		if (!isTrustedAddress(forwarded[index], trustProxy)) return forwarded[index];
	}
	if (forwarded.length) return forwarded[0];

	return socketAddress(req);
}

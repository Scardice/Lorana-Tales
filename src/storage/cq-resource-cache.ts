import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import {
	constants as zlibConstants,
	brotliCompressSync,
	brotliDecompressSync,
	deflateSync,
	inflateSync,
} from "node:zlib";

type ResourceKind = "image" | "audio" | "video" | "file";

export type CqResourceCacheOptions = {
	enabled?: boolean;
	path?: string;
	retention_days?: number;
	max_file_mb?: number;
	max_resources_per_log?: number;
	image_quality?: number;
	audio_bitrate_kbps?: number;
	ffmpeg_path?: string;
	allowed_hosts?: string[];
	allow_public_hosts?: boolean;
	download_timeout_seconds?: number;
};

type NormalizedOptions = {
	enabled: boolean;
	storagePath: string;
	retentionDays: number;
	maxFileBytes: number;
	maxResourcesPerLog: number;
	imageQuality: number;
	audioBitrateKbps: number;
	ffmpegPath: string;
	allowedHosts: string[];
	allowPublicHosts: boolean;
	downloadTimeoutMs: number;
};

type ResourceCandidate = {
	source: string;
	kind: ResourceKind;
	remoteUrl?: string;
	base64?: string;
};

type ResourceResponse = {
	body: Buffer;
	contentType: string;
	contentEncoding?: "br";
};

type ImageDataLike = {
	data: Uint8ClampedArray;
	width: number;
	height: number;
};

const require = createRequire(import.meta.url);
const RESOURCE_ID_RE = /^[a-f0-9]{64}\.(?:webp|png|jpg|jpeg|gif|avif|mp3|ogg|wav|aac|amr|silk|mp4|bin)$/;
const MAX_DECODED_LOG_BYTES = 32 * 1024 * 1024;
const cleanupIntervalMs = 60 * 60 * 1000;

let codecsPromise: Promise<{
	decodePng: (data: ArrayBuffer) => Promise<ImageDataLike>;
	decodeJpeg: (data: ArrayBuffer) => Promise<ImageDataLike>;
	decodeWebp: (data: ArrayBuffer) => Promise<ImageDataLike>;
	encodeWebp: (
		image: ImageDataLike,
		options: Record<string, number>,
	) => Promise<ArrayBuffer>;
}> | null = null;

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseBoolean(value: unknown, fallback: boolean) {
	if (value === undefined || value === null || value === "") return fallback;
	return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function moduleFile(moduleName: string, relativePath: string): URL {
	return new URL(relativePath, `file://${require.resolve(moduleName).replaceAll("\\", "/")}`);
}

function supportsWasmSimd(): boolean {
	return WebAssembly.validate(
		new Uint8Array([
			0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
			10, 10, 1, 8, 0, 65, 0, 253, 15, 11,
		]),
	);
}

async function loadImageCodecs() {
	codecsPromise ??= (async () => {
		const [png, jpeg, webpEncode, webpDecode] = await Promise.all([
			import("@jsquash/png/decode.js"),
			import("@jsquash/jpeg/decode.js"),
			import("@jsquash/webp/encode.js"),
			import("@jsquash/webp/decode.js"),
		]);

		const pngWasm = await fs.readFile(
			moduleFile("@jsquash/png/decode.js", "./codec/pkg/squoosh_png_bg.wasm"),
		);
		await png.init(pngWasm);

		const jpegWasm = await fs.readFile(
			moduleFile("@jsquash/jpeg/decode.js", "./codec/dec/mozjpeg_dec.wasm"),
		);
		await jpeg.init(new WebAssembly.Module(jpegWasm));

		const webpDecodeWasm = await fs.readFile(
			moduleFile("@jsquash/webp/decode.js", "./codec/dec/webp_dec.wasm"),
		);
		await webpDecode.init(new WebAssembly.Module(webpDecodeWasm));

		const webpEncodeWasm = await fs.readFile(
			moduleFile(
				"@jsquash/webp/encode.js",
				supportsWasmSimd()
					? "./codec/enc/webp_enc_simd.wasm"
					: "./codec/enc/webp_enc.wasm",
			),
		);
		await webpEncode.init(new WebAssembly.Module(webpEncodeWasm));

		return {
			decodePng: png.decode,
			decodeJpeg: jpeg.default,
			decodeWebp: webpDecode.default,
			encodeWebp: webpEncode.default,
		};
	})();
	return codecsPromise;
}

function normalizeOptions(options: CqResourceCacheOptions = {}): NormalizedOptions {
	return {
		enabled: parseBoolean(options.enabled, false),
		storagePath: path.resolve(String(options.path || "./data/cq-resources")),
		retentionDays: clampNumber(options.retention_days, 60, 1, 3650),
		maxFileBytes: clampNumber(options.max_file_mb, 12, 1, 128) * 1024 * 1024,
		maxResourcesPerLog: clampNumber(options.max_resources_per_log, 40, 1, 200),
			imageQuality: clampNumber(options.image_quality, 65, 1, 100),
			audioBitrateKbps: clampNumber(options.audio_bitrate_kbps, 128, 32, 320),
			ffmpegPath: String(options.ffmpeg_path || "ffmpeg").trim() || "ffmpeg",
		allowedHosts: Array.isArray(options.allowed_hosts)
			? options.allowed_hosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean)
			: ["*.qq.com", "*.qlogo.cn", "*.qpic.cn", "*.gtimg.cn"],
		allowPublicHosts: parseBoolean(options.allow_public_hosts, false),
		downloadTimeoutMs:
			clampNumber(options.download_timeout_seconds, 15, 1, 60) * 1000,
	};
}

function inferKind(type: string): ResourceKind | null {
	const value = type.toLowerCase();
	if (["image", "face"].includes(value)) return "image";
	if (["record", "voice", "audio"].includes(value)) return "audio";
	if (["video", "shortvideo"].includes(value)) return "video";
	if (value === "file") return "file";
	return null;
}

function resourceCandidates(message: string): ResourceCandidate[] {
	const candidates: ResourceCandidate[] = [];
	const cqRe = /\[CQ:([A-Za-z0-9_-]+),([\s\S]*?)\]/g;
	for (const match of message.matchAll(cqRe)) {
		const kind = inferKind(match[1]);
		if (!kind) continue;
		// Video archives grow without a practical upper bound. Keep a readable
		// placeholder in the stored log, but never download or persist the video.
		if (kind === "video") continue;
		const attrs = match[2];
		for (const value of attrs.matchAll(/\burl=\[(https?:\/\/[^\]]+)\]/gi)) {
			candidates.push({ source: value[1], kind, remoteUrl: value[1] });
		}
		for (const value of attrs.matchAll(/\b(?:url|file|data|path)=(https?:\/\/[^,\]\s]+)/gi)) {
			candidates.push({ source: value[1], kind, remoteUrl: value[1] });
		}
		for (const value of attrs.matchAll(/\b(?:file|data)=base64:\/\/([A-Za-z0-9+/=\s]+)/gi)) {
			candidates.push({ source: `base64://${value[1]}`, kind, base64: value[1] });
		}
		if (kind === "image") {
			for (const value of attrs.matchAll(/\bfile=([A-Fa-f0-9]{32,64})(?:\.[A-Za-z0-9]+)?/g)) {
				const id = value[1].toUpperCase();
				candidates.push({
					source: value[1],
					kind,
					remoteUrl: `https://gchat.qpic.cn/gchatpic_new/0/0-0-${id}/0?term=2,subType=1`,
				});
			}
			for (const value of attrs.matchAll(/\bfile_unique=([A-Fa-f0-9]{32})/g)) {
				const id = value[1].toUpperCase();
				candidates.push({
					source: value[1],
					kind,
					remoteUrl: `https://gchat.qpic.cn/gchatpic_new/0/0-0-${id}/0?term=2`,
				});
			}
		}
	}
	return candidates;
}

function inferMime(bytes: Buffer, fallback = ""): string {
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
	if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
	if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	if (bytes.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
	if (bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
	if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
	if (bytes.subarray(0, 6).toString("ascii") === "#!AMR\n") return "audio/amr";
	if (bytes.subarray(0, 6).toString("ascii") === "#!SILK") return "audio/silk";
	if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
	return fallback.split(";")[0].trim().toLowerCase();
}

function extensionForMime(mime: string, kind: ResourceKind): string {
	const extensions: Record<string, string> = {
		"image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/avif": "avif",
		"audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "audio/aac": "aac", "audio/amr": "amr", "audio/silk": "silk", "video/mp4": "mp4",
	};
	return extensions[mime] || (kind === "file" ? "bin" : kind === "video" ? "mp4" : "bin");
}

function mimeForExtension(extension: string): string {
	const mime: Record<string, string> = {
		webp: "image/webp", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", avif: "image/avif",
		mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", aac: "audio/aac", amr: "audio/amr", silk: "audio/silk", mp4: "video/mp4",
	};
	return mime[extension] || "application/octet-stream";
}

function hostMatches(host: string, allowedHosts: string[]): boolean {
	return allowedHosts.some((rule) => rule === host || (rule.startsWith("*.") && host.endsWith(rule.slice(1))));
}

function isPublicIp(address: string): boolean {
	if (net.isIP(address) === 4) {
		const [a, b] = address.split(".").map(Number);
		return !(
			a === 0 || a === 10 || a === 127 || a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19))
		);
	}
	const normalized = address.toLowerCase();
	if (normalized.startsWith("::ffff:")) {
		const mapped = normalized.slice("::ffff:".length);
		if (net.isIP(mapped) === 4) return isPublicIp(mapped);
	}
	return !(
		normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
		normalized.startsWith("fd") || normalized.startsWith("fe80:") || normalized.startsWith("::ffff:127.")
	);
}

async function assertSafeRemoteUrl(rawUrl: string, options: NormalizedOptions) {
	const url = new URL(rawUrl);
	if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("unsupported resource URL");
	const host = url.hostname.toLowerCase();
	if (!options.allowPublicHosts && !hostMatches(host, options.allowedHosts)) throw new Error(`resource host is not allowed: ${host}`);
	if (net.isIP(host)) {
		if (!isPublicIp(host)) throw new Error("resource host resolves to a private address");
		return url;
	}
	const addresses = await lookup(host, { all: true, verbatim: true });
	if (!addresses.length || addresses.some((record) => !isPublicIp(record.address))) throw new Error("resource host resolves to a private address");
	return url;
}

async function readRemoteResource(rawUrl: string, options: NormalizedOptions): Promise<{ bytes: Buffer; mime: string }> {
	let url = await assertSafeRemoteUrl(rawUrl, options);
	for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), options.downloadTimeoutMs);
		try {
			const response = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { Accept: "image/*,audio/*,application/octet-stream;q=0.7" } });
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				const location = response.headers.get("location");
				if (!location) throw new Error("resource redirect has no location");
				url = await assertSafeRemoteUrl(new URL(location, url).toString(), options);
				continue;
			}
			if (!response.ok || !response.body) throw new Error(`resource download returned ${response.status}`);
			const contentLength = Number(response.headers.get("content-length") || 0);
			if (contentLength > options.maxFileBytes) throw new Error("resource exceeds configured size limit");
			const chunks: Uint8Array[] = [];
			let total = 0;
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				total += chunk.byteLength;
				if (total > options.maxFileBytes) throw new Error("resource exceeds configured size limit");
				chunks.push(chunk);
			}
			return { bytes: Buffer.concat(chunks), mime: response.headers.get("content-type") || "" };
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error("resource redirect limit exceeded");
}

async function optimizeImage(bytes: Buffer, mime: string, quality: number): Promise<{ bytes: Buffer; mime: string }> {
	if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) return { bytes, mime };
	try {
		const codecs = await loadImageCodecs();
		const input = toArrayBuffer(bytes);
		const image = mime === "image/png"
			? await codecs.decodePng(input)
			: mime === "image/jpeg"
				? await codecs.decodeJpeg(input)
				: await codecs.decodeWebp(input);
		const encoded = Buffer.from(await codecs.encodeWebp(image, { quality, method: 6 }));
		return encoded.byteLength < bytes.byteLength
			? { bytes: encoded, mime: "image/webp" }
			: { bytes, mime };
	} catch (error) {
		console.warn(`[resource-cache] Image optimization skipped: ${error instanceof Error ? error.message : String(error)}`);
		return { bytes, mime };
	}
}

async function optimizeAudio(bytes: Buffer, mime: string, options: NormalizedOptions): Promise<{ bytes: Buffer; mime: string }> {
	return new Promise((resolve) => {
		const child = spawn(options.ffmpegPath, [
			"-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-map_metadata", "-1", "-vn",
			"-c:a", "libopus", "-b:a", `${options.audioBitrateKbps}k`, "-vbr", "on",
			"-compression_level", "10", "-application", "audio", "-flags:a", "+bitexact",
			"-fflags", "+bitexact", "-f", "ogg", "pipe:1",
		], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const output: Buffer[] = []; let outputBytes = 0; let stderr = ""; let settled = false;
		const finish = (value: { bytes: Buffer; mime: string }) => { if (settled) return; settled = true; resolve(value); };
		const timer = setTimeout(() => { child.kill(); finish({ bytes, mime: inferMime(bytes, mime) }); }, 120_000);
		child.stdout.on("data", (chunk: Buffer) => { outputBytes += chunk.byteLength; if (outputBytes <= options.maxFileBytes) output.push(chunk); else child.kill(); });
		child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 2048) stderr += chunk.toString("utf-8"); });
		child.once("error", (error) => { clearTimeout(timer); console.warn(`[resource-cache] Audio optimization skipped: ${error.message}`); finish({ bytes, mime: inferMime(bytes, mime) }); });
		child.once("close", (code) => { clearTimeout(timer); const encoded = Buffer.concat(output); if (code === 0 && encoded.byteLength && encoded.byteLength < bytes.byteLength) finish({ bytes: encoded, mime: "audio/ogg" }); else { if (code !== 0) console.warn(`[resource-cache] Audio optimization skipped: ${stderr.trim() || `FFmpeg exited with ${code}`}`); finish({ bytes, mime: inferMime(bytes, mime) }); } });
		child.stdin.end(bytes);
	});
}

export class CqResourceCache {
	readonly options: NormalizedOptions;
	private lastCleanupAt = 0;

	constructor(options: CqResourceCacheOptions = {}) {
		this.options = normalizeOptions(options);
	}

	get enabled() {
		return this.options.enabled;
	}

	async cacheRemoteImage(remoteUrl: string): Promise<string> {
		const { resourceId } = await this.cacheCandidate({ source: remoteUrl, remoteUrl, kind: "image" });
		this.cleanupExpired().catch((error) => console.warn(`[resource-cache] Cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
		return resourceId;
	}

	async cacheUploadedResource(bytes: Buffer, kind: "image" | "audio", declaredMime = ""): Promise<{ resourceId: string; reused: boolean }> {
		if (!this.enabled) throw new Error("resource cache is disabled");
		if (!bytes.byteLength || bytes.byteLength > this.options.maxFileBytes) throw new Error("resource exceeds configured size limit");
		return this.cacheCandidate({ source: "upload", kind }, { bytes, mime: declaredMime });
	}

	resourceUrl(resourceId: string, resourceBaseUrl = ""): string {
		return this.publicResourceUrl(resourceId, resourceBaseUrl);
	}

	async archiveStoredLog(
		storedText: string,
		resourceBaseUrl = "",
	): Promise<{ storedText: string; cachedCount: number }> {
		if (!this.enabled) return { storedText, cachedCount: 0 };
		let stored: Record<string, unknown>;
		try { stored = JSON.parse(storedText); } catch { return { storedText, cachedCount: 0 }; }
		if (typeof stored.data !== "string" || String(stored.client || "").toLowerCase() === "parquet") return { storedText, cachedCount: 0 };

		let decoded: Buffer;
		try { decoded = inflateSync(Buffer.from(stored.data, "base64"), { maxOutputLength: MAX_DECODED_LOG_BYTES }); } catch { return { storedText, cachedCount: 0 }; }
		let payload: unknown;
		try { payload = JSON.parse(decoded.toString("utf-8")); } catch { return { storedText, cachedCount: 0 }; }

		let videoCount = 0;
		const replaceVideos = (value: unknown): unknown => {
			if (typeof value === "string") {
				return value.replace(/\[CQ:(?:video|shortvideo),(?:[^\[\]]|\[[^\]]*\])*\]/gi, () => {
					videoCount += 1;
					return "【视频】";
				});
			}
			if (Array.isArray(value)) return value.map(replaceVideos);
			if (value && typeof value === "object") {
				for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
					(value as Record<string, unknown>)[key] = replaceVideos(child);
				}
			}
			return value;
		};
		payload = replaceVideos(payload);

		const messages: string[] = [];
		const visit = (value: unknown) => {
			if (typeof value === "string" && value.includes("[CQ:")) messages.push(value);
			else if (Array.isArray(value)) value.forEach(visit);
			else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(visit);
		};
		visit(payload);
		const candidates = messages.flatMap(resourceCandidates);
		const replacements = new Map<string, string>();
		for (const candidate of candidates) {
			if (replacements.size >= this.options.maxResourcesPerLog || replacements.has(candidate.source)) continue;
			try {
				replacements.set(
					candidate.source,
					this.publicResourceUrl(
							(await this.cacheCandidate(candidate)).resourceId,
						resourceBaseUrl,
					),
				);
			} catch (error) {
				console.warn(`[resource-cache] Resource skipped: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (!replacements.size && !videoCount) return { storedText, cachedCount: 0 };

		const rewrite = (value: unknown): unknown => {
			if (typeof value === "string") {
				let next = value;
				for (const [source, replacement] of replacements) next = next.replaceAll(source, replacement);
				return next;
			}
			if (Array.isArray(value)) return value.map(rewrite);
			if (value && typeof value === "object") {
				for (const [key, child] of Object.entries(value as Record<string, unknown>)) (value as Record<string, unknown>)[key] = rewrite(child);
			}
			return value;
		};
		rewrite(payload);
		stored.data = deflateSync(Buffer.from(JSON.stringify(payload)), { level: 9 }).toString("base64");
		this.cleanupExpired().catch((error) => console.warn(`[resource-cache] Cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
		return { storedText: JSON.stringify(stored), cachedCount: replacements.size };
	}

	private publicResourceUrl(resourceId: string, resourceBaseUrl: string): string {
		const base = resourceBaseUrl.replace(/\/+$/, "");
		return `${base}/cq-resources/${resourceId}`;
	}

	private async cacheCandidate(candidate: ResourceCandidate, supplied?: { bytes: Buffer; mime: string }): Promise<{ resourceId: string; reused: boolean }> {
		const downloaded = supplied || (candidate.base64
			? { bytes: Buffer.from(candidate.base64.replaceAll(/\s+/g, ""), "base64"), mime: "" }
			: await readRemoteResource(candidate.remoteUrl || "", this.options));
		if (!downloaded.bytes.byteLength || downloaded.bytes.byteLength > this.options.maxFileBytes) throw new Error("resource exceeds configured size limit");
		let mime = inferMime(downloaded.bytes, downloaded.mime);
		if (mime === "text/html" || mime === "application/xhtml+xml") throw new Error("resource is not media");
		let normalized = candidate.kind === "image"
			? await optimizeImage(downloaded.bytes, mime, this.options.imageQuality)
			: candidate.kind === "audio"
				? await optimizeAudio(downloaded.bytes, mime, this.options)
				: { bytes: downloaded.bytes, mime };
		mime = normalized.mime;
		const extension = extensionForMime(mime, candidate.kind);
		const resourceId = `${crypto.createHash("sha256").update(normalized.bytes).digest("hex")}.${extension}`;
		const reused = await this.writeResource(resourceId, normalized.bytes);
		return { resourceId, reused };
	}

	private async writeResource(resourceId: string, bytes: Buffer): Promise<boolean> {
		await fs.mkdir(this.options.storagePath, { recursive: true });
		const rawPath = path.join(this.options.storagePath, resourceId);
		const brPath = `${rawPath}.br`;
		try { await fs.access(rawPath); await fs.utimes(rawPath, new Date(), new Date()); return true; } catch { /* try Brotli path */ }
		try { await fs.access(brPath); await fs.utimes(brPath, new Date(), new Date()); return true; } catch { /* write below */ }
		const compressed = brotliCompressSync(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } });
		const target = compressed.byteLength < bytes.byteLength ? brPath : rawPath;
		const body = compressed.byteLength < bytes.byteLength ? compressed : bytes;
		const temporary = `${target}.${crypto.randomUUID()}.tmp`;
		await fs.writeFile(temporary, body, { flag: "wx" });
		try { await fs.rename(temporary, target); return false; } catch (error) { await fs.unlink(temporary).catch(() => undefined); if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; return true; }
	}

	async readResource(resourceId: string, acceptsBrotli: boolean): Promise<ResourceResponse | null> {
		if (!RESOURCE_ID_RE.test(resourceId)) return null;
		const rawPath = path.join(this.options.storagePath, resourceId);
		const extension = resourceId.slice(resourceId.lastIndexOf(".") + 1);
		try {
			const compressed = await fs.readFile(`${rawPath}.br`);
			return { body: acceptsBrotli ? compressed : brotliDecompressSync(compressed), contentType: mimeForExtension(extension), contentEncoding: acceptsBrotli ? "br" : undefined };
		} catch { /* try raw file */ }
		try { return { body: await fs.readFile(rawPath), contentType: mimeForExtension(extension) }; } catch { return null; }
	}

	async cleanupExpired(): Promise<number> {
		if (Date.now() - this.lastCleanupAt < cleanupIntervalMs) return 0;
		this.lastCleanupAt = Date.now();
		let entries: string[];
		try { entries = await fs.readdir(this.options.storagePath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
		const cutoff = Date.now() - this.options.retentionDays * 24 * 60 * 60 * 1000;
		let deleted = 0;
		for (const entry of entries) {
			if (!RESOURCE_ID_RE.test(entry.replace(/\.br$/, "")) && !/^[a-f0-9-]+\.tmp$/.test(entry)) continue;
			const target = path.join(this.options.storagePath, entry);
			try { const stat = await fs.stat(target); if (stat.isFile() && stat.mtimeMs < cutoff) { await fs.unlink(target); deleted += 1; } } catch { /* another request may have removed it */ }
		}
		return deleted;
	}
}

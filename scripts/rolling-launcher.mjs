#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import toml from "toml";

const OFFICIAL_REPOSITORY = "Scardice/Lorana-Tales";
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 30_000;
const TRUSTED_DOWNLOAD_HOSTS = new Set([
	"github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
]);
const launcherRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.resolve(process.env.SCARDICE_CONFIG || process.env.CONFIG_FILE || path.join(launcherRoot, "config.toml"));
const markerPath = path.join(launcherRoot, "OFFICIAL_BUILD.json");
const serverEntry = path.join(launcherRoot, "dist/bin/scardice-story-painter.js");

function readConfiguration() {
	const value = fs.existsSync(configPath) ? toml.parse(fs.readFileSync(configPath, "utf8")) : {};
	const channel = ["off", "test", "stable"].includes(String(value.auto_update?.channel || "test")) ? String(value.auto_update?.channel || "test") : "off";
	const trustedProxyCidrs = Array.isArray(value.server?.trusted_proxy_cidrs)
		? value.server.trusted_proxy_cidrs.map(String)
		: ["127.0.0.1/32", "::1/128"];
	const allowedHosts = Array.isArray(value.server?.allowed_hosts)
		? value.server.allowed_hosts.map(normalizeConfiguredHost).filter(Boolean)
		: ["localhost", "127.0.0.1", "::1"];
	const frontendHost = normalizeConfiguredHost(value.app?.frontend_url);
	if (frontendHost && !allowedHosts.includes(frontendHost)) allowedHosts.push(frontendHost);
	return { host: String(value.server?.host || "0.0.0.0"), port: Number(value.server?.port || 3000), trustProxy: Boolean(value.server?.trust_proxy), trustedProxyCidrs, allowedHosts, channel, intervalSeconds: Math.max(60, Number(value.auto_update?.check_interval_seconds || 300)), dataPath: path.resolve(launcherRoot, String(value.auto_update?.staging_path || "./data/updates")) };
}

export function normalizedHostHeader(value) {
	const input = String(value || "").trim().toLowerCase();
	if (!input || /[\s,\\/@]/.test(input)) return "";
	if (input.startsWith("[")) {
		const match = /^\[([^\]]+)](?::(\d{1,5}))?$/.exec(input);
		return match && net.isIP(match[1]) === 6 && validOptionalPort(match[2]) ? match[1] : "";
	}
	const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(input);
	if (!match) return "";
	if (!validOptionalPort(match[2])) return "";
	const hostname = match[1].replace(/\.$/, "");
	if (net.isIP(hostname)) return hostname;
	return hostname.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(hostname) ? hostname : "";
}

function validOptionalPort(value) {
	if (value === undefined) return true;
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function normalizeConfiguredHost(value) {
	const input = String(value || "").trim();
	if (!input) return "";
	try {
		if (/^https?:\/\//i.test(input)) return normalizedHostHeader(new URL(input).host);
	} catch {
		return "";
	}
	return normalizedHostHeader(input);
}

export function isAllowedHostHeader(value, allowedHosts) {
	const hostname = normalizedHostHeader(value);
	return Boolean(hostname && allowedHosts.includes(hostname));
}

function normalizedIp(value) {
	const candidate = String(value || "").trim().replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
	return net.isIP(candidate) ? candidate : "";
}

export function isTrustedProxyAddress(value, cidrs = []) {
	const candidate = normalizedIp(value);
	if (!candidate) return false;
	const blockList = new net.BlockList();
	for (const entry of cidrs) {
		const [address, prefixText] = String(entry || "").trim().split("/");
		const family = net.isIP(address);
		const prefix = Number(prefixText);
		if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) continue;
		blockList.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
	}
	return blockList.check(candidate, net.isIP(candidate) === 4 ? "ipv4" : "ipv6");
}

function forwardedClientIp(headers) {
	for (const value of [headers["cf-connecting-ip"], headers["true-client-ip"], headers["fastly-client-ip"], headers["x-real-ip"]]) {
		const candidate = normalizedIp(Array.isArray(value) ? value[0] : value);
		if (candidate) return candidate;
	}
	const forwarded = String(headers["x-forwarded-for"] || "").split(",").map(normalizedIp).filter(Boolean);
	return forwarded[0] || "";
}

export function sanitizedForwarding(request, config) {
	const peerIp = normalizedIp(request.socket.remoteAddress) || "unknown";
	const trustedPeer = config.trustProxy && isTrustedProxyAddress(peerIp, config.trustedProxyCidrs);
	return {
		clientIp: trustedPeer ? forwardedClientIp(request.headers) || peerIp : peerIp,
		protocol: trustedPeer
			? String(request.headers["x-forwarded-proto"] || "http").split(",")[0].trim().toLowerCase() === "https" ? "https" : "http"
			: request.socket.encrypted ? "https" : "http",
	};
}

export function sanitizedProxyHeaders(source) {
	const headers = { ...source };
	const connectionTokens = String(headers.connection || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
	for (const name of [
		...connectionTokens,
		"connection", "proxy-connection", "keep-alive", "transfer-encoding",
		"te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate",
		"forwarded", "cf-connecting-ip", "true-client-ip", "fastly-client-ip",
		"x-client-ip", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
	]) delete headers[name];
	return headers;
}

function spawnWorker(entry, port, version) {
	return spawn(process.execPath, [entry], { cwd: launcherRoot, env: { ...process.env, SCARDICE_CONFIG: configPath, LORANA_RUNTIME_ROOT: launcherRoot, LORANA_INTERNAL_PORT: String(port), LORANA_UPDATE_WORKER: "1", LORANA_BUILD_VERSION: String(version || "") }, stdio: "inherit", windowsHide: true });
}
function waitForExit(child) { return new Promise((resolve) => child.once("exit", resolve)); }
async function readBoundedBody(response, maxBytes) {
	const declared = Number(response.headers.get("content-length") || 0);
	if (declared > maxBytes) throw new Error("远端响应超过大小上限");
	if (!response.body) throw new Error("远端响应缺少正文");
	const chunks = [];
	let total = 0;
	for await (const chunk of response.body) {
		const bytes = Buffer.from(chunk);
		total += bytes.byteLength;
		if (total > maxBytes) throw new Error("远端响应超过大小上限");
		chunks.push(bytes);
	}
	return Buffer.concat(chunks, total);
}
async function requestJson(url) {
	const target = new URL(url);
	if (target.protocol !== "https:" || target.hostname !== "api.github.com" || !target.pathname.startsWith(`/repos/${OFFICIAL_REPOSITORY}/`)) throw new Error("拒绝非官方 GitHub API 地址");
	const response = await fetch(target, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Lorana-Tales-Updater", "X-GitHub-Api-Version": "2022-11-28" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
	if (!response.ok) throw new Error(`GitHub API ${response.status}`);
	return JSON.parse((await readBoundedBody(response, MAX_API_BYTES)).toString("utf8"));
}
function availablePort() { return new Promise((resolve, reject) => { const probe=http.createServer();probe.once("error",reject);probe.listen(0,"127.0.0.1",()=>{const address=probe.address();const port=typeof address==="object"&&address?address.port:0;probe.close(error=>error?reject(error):resolve(port))}) }); }
export function healthCheckHost(allowedHosts) { return Array.isArray(allowedHosts) && allowedHosts.length ? String(allowedHosts[0]) : "127.0.0.1"; }
async function healthy(port, expectedVersion, host) { for(let attempt=0;attempt<40;attempt+=1){try{const response=await fetch(`http://127.0.0.1:${port}/healthz`,{headers:{Host:healthCheckHost([host])},signal:AbortSignal.timeout(1200)});if(response.ok){const body=await response.json();if(body?.ok===true&&String(body.version||"")===String(expectedVersion||""))return true}}catch{}await new Promise(resolve=>setTimeout(resolve,500))}return false }

export function parseSemver(value) {
	const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(String(value || ""));
	if (!match) return null;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ? match[4].split(".").map(part => /^\d+$/.test(part) ? Number(part) : part) : [] };
}
export function compareSemver(left, right) {
	const a = parseSemver(left), b = parseSemver(right);
	if (!a || !b) throw new Error("无效版本号");
	for (const field of ["major", "minor", "patch"]) if (a[field] !== b[field]) return a[field] > b[field] ? 1 : -1;
	if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
	for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
		const x = a.prerelease[index], y = b.prerelease[index];
		if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
		if (x === y) continue;
		if (typeof x === "number" && typeof y === "number") return x > y ? 1 : -1;
		if (typeof x === "number") return -1;
		if (typeof y === "number") return 1;
		return x > y ? 1 : -1;
	}
	return 0;
}
export function selectRelease(releases, channel, currentVersion) {
	return releases
		.filter(item => !item?.draft && parseSemver(item.tag_name) && (channel === "test" || (!item.prerelease && !parseSemver(item.tag_name).prerelease.length)))
		.filter(item => compareSemver(item.tag_name, currentVersion) > 0)
		.sort((a, b) => compareSemver(b.tag_name, a.tag_name))[0] || null;
}
async function sha256(file){const hash=crypto.createHash("sha256");await new Promise((resolve,reject)=>{const stream=fs.createReadStream(file);stream.on("data",chunk=>hash.update(chunk));stream.once("error",reject);stream.once("end",resolve)});return hash.digest("hex")}
export function validateDownloadUrl(rawUrl, tagName, assetName, initial) {
	const target = new URL(rawUrl);
	if (target.protocol !== "https:" || !TRUSTED_DOWNLOAD_HOSTS.has(target.hostname)) throw new Error("Release 下载地址不受信任");
	if (initial) {
		const parts = target.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
		if (target.hostname !== "github.com" || parts.length !== 6 || parts.slice(0, 4).join("/") !== `${OFFICIAL_REPOSITORY}/releases/download` || parts[4] !== tagName || parts[5] !== assetName) throw new Error("Release 下载地址与官方仓库资产不匹配");
	}
	return target;
}
async function fetchReleaseAsset(url, tagName, assetName) {
	let target = validateDownloadUrl(url, tagName, assetName, true);
	for (let redirects = 0; redirects <= 5; redirects += 1) {
		const response = await fetch(target, { headers: { "User-Agent": "Lorana-Tales-Updater" }, redirect: "manual", signal: AbortSignal.timeout(120_000) });
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new Error("Release 重定向缺少地址");
			target = validateDownloadUrl(new URL(location, target).toString(), tagName, assetName, false);
			continue;
		}
		if (!response.ok) throw new Error(`下载失败 ${response.status}`);
		return response;
	}
	throw new Error("Release 下载重定向次数过多");
}
async function download(url,target,tagName,assetName,maxBytes){const response=await fetchReleaseAsset(url,tagName,assetName);const declared=Number(response.headers.get("content-length")||0);if(declared>maxBytes)throw new Error("Release 包超过下载大小上限");if(!response.body)throw new Error("下载响应缺少正文");const temporary=`${target}.${crypto.randomUUID()}.part`;await fsp.mkdir(path.dirname(target),{recursive:true,mode:0o700});const output=fs.createWriteStream(temporary,{flags:"wx",mode:0o600});let total=0;try{await new Promise((resolve,reject)=>{const reader=response.body.getReader();const fail=error=>{output.destroy();reject(error)};const pump=()=>reader.read().then(({done,value})=>{if(done){output.end(resolve);return}total+=value.byteLength;if(total>maxBytes){fail(new Error("Release 包超过下载大小上限"));return}if(!output.write(Buffer.from(value)))output.once("drain",pump);else pump()}).catch(fail);output.once("error",reject);pump()});await fsp.rename(temporary,target)}catch(error){output.destroy();await fsp.rm(temporary,{force:true});throw error}}
function capture(command,args){return new Promise((resolve,reject)=>{const child=spawn(command,args,{env:{...process.env,LC_ALL:"C"},stdio:["ignore","pipe","pipe"],windowsHide:true});let output="",error="",overflow=false;const append=(current,chunk)=>{const next=current+chunk;if(next.length>32*1024*1024){overflow=true;child.kill("SIGKILL");return current}return next};child.stdout.on("data",chunk=>{output=append(output,chunk)});child.stderr.on("data",chunk=>{error=append(error,chunk)});child.once("error",reject);child.once("exit",code=>code===0&&!overflow?resolve(output):reject(new Error(`${command} 退出码 ${code}: ${overflow?"输出过大":error.slice(0,500)}`)))})}
export function validateTarPaths(names) { const seen=new Set();for(const name of names){const normalized=name.endsWith("/")?name.slice(0,-1):name;if(!normalized||/[\0-\x1f\x7f\\]/.test(normalized)||normalized.startsWith("/")||normalized.split("/").some(part=>part===".."||part==="")){throw new Error("Release 包包含不安全路径")}if(seen.has(normalized))throw new Error("Release 包包含重复路径");seen.add(normalized)}return seen.size }
export async function inspectTar(archive){const rawNames=(await capture("tar",["-tzf",archive,"--quoting-style=escape"])).split(/\r?\n/).filter(Boolean);if(!rawNames.length||rawNames.length>MAX_ARCHIVE_ENTRIES)throw new Error("Release 包文件数量无效");validateTarPaths(rawNames);const names=rawNames.map(name=>name.endsWith("/")?name.slice(0,-1):name);const nameSet=new Set(names);const listing=(await capture("tar",["-tvzf",archive,"--numeric-owner","--quoting-style=escape"])).split(/\r?\n/).filter(Boolean);if(listing.length!==names.length)throw new Error("Release 包目录清单不一致");let total=0;const symlinks=new Set();for(let index=0;index<listing.length;index+=1){const line=listing[index];const match=/^([-dl])\S*\s+\d+\/\d+\s+(\d+)\s+/.exec(line);if(!match)throw new Error("Release 包含硬链接、设备或无法识别的目录项");const size=Number(match[2]);if(!Number.isSafeInteger(size)||size<0)throw new Error("Release 包文件大小无效");total+=size;if(total>MAX_EXTRACTED_BYTES)throw new Error("Release 包解压体积超过 2 GiB");if(match[1]==="l"){const marker=" -> ",arrow=line.lastIndexOf(marker);if(arrow<0)throw new Error("Release 包符号链接格式无效");const target=line.slice(arrow+marker.length);if(!target||/[\0-\x1f\x7f\\]/.test(target)||target.startsWith("/"))throw new Error("Release 包符号链接目标不安全");const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(names[index]),target));const root=names[index].split("/")[0];if(resolved!==root&&!resolved.startsWith(`${root}/`))throw new Error("Release 包符号链接越出包根目录");if(!nameSet.has(resolved))throw new Error("Release 包符号链接目标不存在");symlinks.add(names[index])}}
	for(const name of names){let parent=path.posix.dirname(name);while(parent!=="."&&parent!=="/"){if(symlinks.has(parent))throw new Error("Release 包试图通过符号链接写入子路径");parent=path.posix.dirname(parent)}}return {entries:names.length,totalBytes:total,symlinks:symlinks.size}}
async function extractTar(archive,target){await inspectTar(archive);await fsp.mkdir(target,{recursive:false,mode:0o700});await new Promise((resolve,reject)=>{const child=spawn("tar",["-xzf",archive,"-C",target,"--no-same-owner","--no-same-permissions","--delay-directory-restore"],{stdio:["ignore","ignore","pipe"],windowsHide:true});let error="";child.stderr.on("data",chunk=>{if(error.length<8192)error+=chunk});child.once("error",reject);child.once("exit",code=>code===0?resolve():reject(new Error(`tar 退出码 ${code}: ${error.slice(0,500)}`)))})}

function assetDigest(asset) {
	const match = /^sha256:([a-f0-9]{64})$/i.exec(String(asset?.digest || ""));
	if (!match) throw new Error(`Release 资产 ${asset?.name || ""} 缺少 GitHub SHA-256 摘要`);
	return match[1].toLowerCase();
}
export function checksumForAsset(text, assetName) {
	const matches = String(text).split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim())).filter(Boolean).filter(match => match[2] === assetName);
	if (matches.length !== 1) throw new Error("Release SHA-256 清单缺少唯一匹配项");
	return matches[0][1].toLowerCase();
}
function safeEqualHex(left, right) { return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) && crypto.timingSafeEqual(Buffer.from(left,"hex"),Buffer.from(right,"hex")); }
function sha256Bytes(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
async function ensurePrivateDirectory(target) {
	const resolved = path.resolve(target);
	if (resolved === path.parse(resolved).root) throw new Error("更新暂存目录不得是文件系统根目录");
	await fsp.mkdir(resolved,{recursive:true,mode:0o700});
	await fsp.chmod(resolved,0o700);
	const stat = await fsp.lstat(resolved);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("更新暂存路径必须是实体目录");
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("更新暂存目录不属于当前服务用户");
	return resolved;
}
async function validatePackageRoot(extracted, release, version) {
	const roots=(await fsp.readdir(extracted,{withFileTypes:true})).filter(item=>item.isDirectory());
	if(roots.length!==1||(await fsp.readdir(extracted,{withFileTypes:true})).some(item=>!item.isDirectory()))throw new Error("Release 包目录结构无效");
	const nextRoot=path.join(extracted,roots[0].name);
	for(const required of ["OFFICIAL_BUILD.json","package.json","dist/bin/scardice-story-painter.js","out/index.html","node_modules"]){const stat=await fsp.lstat(path.join(nextRoot,required));if(stat.isSymbolicLink()||(required==="node_modules"?!stat.isDirectory():!stat.isFile()))throw new Error(`Release 包缺少安全的 ${required}`)}
	const nextMarker=JSON.parse(await fsp.readFile(path.join(nextRoot,"OFFICIAL_BUILD.json"),"utf8"));
	if(nextMarker.repository!==OFFICIAL_REPOSITORY||String(nextMarker.version)!==version||!/^[a-f0-9]{40}$/i.test(String(nextMarker.commit||""))||String(nextMarker.commit)!==String(release.target_commitish)||String(nextMarker.channel)!==(release.prerelease?"Test Release":"Release"))throw new Error("Release 官方构建标记与标签提交不一致");
	const manifest=JSON.parse(await fsp.readFile(path.join(nextRoot,"package.json"),"utf8"));
	if(manifest.name!=="lorana-tales"||String(manifest.version)!==version||String(manifest.engines?.node)!==">=24.20.0")throw new Error("Release 运行清单无效或与当前 Node 基线不兼容");
	return {nextRoot,nextMarker};
}

async function main(){
	const config=readConfiguration();
	let marker=null;try{marker=JSON.parse(await fsp.readFile(markerPath,"utf8"))}catch{}
	if(process.env.LORANA_UPDATE_WORKER==="1"||process.platform!=="linux"||config.channel==="off"||marker?.repository!==OFFICIAL_REPOSITORY){
		const child=spawn(process.execPath,[serverEntry],{cwd:launcherRoot,env:process.env,stdio:"inherit",windowsHide:true});process.on("SIGTERM",()=>child.kill("SIGTERM"));process.on("SIGINT",()=>child.kill("SIGINT"));process.exitCode=await waitForExit(child)??0;return;
	}
	let currentVersion=String(marker.version||"0.0.0");
	if(!parseSemver(currentVersion))throw new Error("当前官方构建版本号无效");
	config.dataPath=await ensurePrivateDirectory(config.dataPath);
	const internalHealthHost=healthCheckHost(config.allowedHosts);
	let activePort=await availablePort();let worker=spawnWorker(serverEntry,activePort,currentVersion);if(!await healthy(activePort,currentVersion,internalHealthHost)){worker.kill("SIGTERM");throw new Error("初始服务健康检查失败")}
	let stopping=false;
	const proxy=http.createServer((request,response)=>{
		if(!request.url?.startsWith("/")||request.url.startsWith("//")){response.writeHead(400,{"content-type":"text/plain;charset=utf-8"});response.end("Bad Request");return}
		if(!isAllowedHostHeader(request.headers.host,config.allowedHosts)){response.writeHead(400,{"content-type":"text/plain;charset=utf-8"});response.end("Invalid Host header");return}
		const headers=sanitizedProxyHeaders(request.headers);
		const {clientIp,protocol}=sanitizedForwarding(request,config);
		headers["x-forwarded-for"]=clientIp;
		headers["x-real-ip"]=clientIp;
		headers["x-forwarded-host"]=String(request.headers.host||"");
		headers["x-forwarded-proto"]=protocol;
		headers.host=request.headers.host;
		const upstream=http.request({host:"127.0.0.1",port:activePort,path:request.url,method:request.method,headers},upstreamResponse=>{response.writeHead(upstreamResponse.statusCode||502,upstreamResponse.headers);upstreamResponse.pipe(response)});
		upstream.setTimeout(120_000,()=>upstream.destroy(new Error("Upstream timeout")));
		request.once("aborted",()=>upstream.destroy());
		response.once("close",()=>{if(!response.writableEnded)upstream.destroy()});
		upstream.on("error",()=>{if(!response.headersSent)response.writeHead(503,{"content-type":"text/plain;charset=utf-8","retry-after":"1"});if(!response.writableEnded)response.end("Service is switching versions")});request.pipe(upstream)
	});
	proxy.headersTimeout=15_000;proxy.requestTimeout=120_000;proxy.keepAliveTimeout=5_000;proxy.maxHeadersCount=100;
	proxy.on("clientError",(_error,socket)=>socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
	proxy.listen(config.port,config.host,()=>console.log(`[updater] Rolling proxy listening at http://${config.host}:${config.port}; channel=${config.channel}`));
	let updating=false;
	const check=async()=>{if(updating)return;updating=true;try{
		const releases=await requestJson(`https://api.github.com/repos/${OFFICIAL_REPOSITORY}/releases?per_page=30`);
		if(!Array.isArray(releases))throw new Error("GitHub Release 响应格式无效");
		const release=selectRelease(releases,config.channel,currentVersion);if(!release)return;
		const version=String(release.tag_name).replace(/^v/,"");
		if(!/^[a-f0-9]{40}$/i.test(String(release.target_commitish||"")))throw new Error("Release 必须固定到完整 Git 提交");
		const archiveName=`lorana-tales-${version}-linux-x64.tar.gz`,sumsName=`SHA256SUMS-${version}.txt`;
		const archiveAsset=release.assets?.find(item=>item.name===archiveName),sumsAsset=release.assets?.find(item=>item.name===sumsName);
		if(!archiveAsset||!sumsAsset)throw new Error("Release 缺少名称严格匹配的 Linux 包或 SHA256SUMS");
		const apiArchiveDigest=assetDigest(archiveAsset),apiSumsDigest=assetDigest(sumsAsset);
		const sumsResponse=await fetchReleaseAsset(sumsAsset.browser_download_url,release.tag_name,sumsName);
		const sumsBytes=await readBoundedBody(sumsResponse,MAX_CHECKSUM_BYTES);
		if(!safeEqualHex(apiSumsDigest,sha256Bytes(sumsBytes)))throw new Error("SHA256SUMS 与 GitHub 资产摘要不一致");
		const expected=checksumForAsset(sumsBytes.toString("utf8"),archiveName);
		if(!safeEqualHex(expected,apiArchiveDigest))throw new Error("校验清单与 GitHub 资产摘要不一致");
		const releaseDir=await ensurePrivateDirectory(path.join(config.dataPath,version));
		const archivePath=path.join(releaseDir,archiveName);
		if(fs.existsSync(archivePath)&&!safeEqualHex(await sha256(archivePath),expected))await fsp.unlink(archivePath);
		if(!fs.existsSync(archivePath))await download(archiveAsset.browser_download_url,archivePath,release.tag_name,archiveName,MAX_ARCHIVE_BYTES);
		if(!safeEqualHex(await sha256(archivePath),expected)){await fsp.unlink(archivePath).catch(()=>undefined);throw new Error("Release SHA-256 校验失败")}
		const extracted=path.join(releaseDir,`package-${expected}`);
		if(!fs.existsSync(extracted)){
			const temporary=path.join(releaseDir,`.extract-${crypto.randomUUID()}`);
			try{await extractTar(archivePath,temporary);await validatePackageRoot(temporary,release,version);await fsp.rename(temporary,extracted)}catch(error){await fsp.rm(temporary,{recursive:true,force:true});throw error}
		}
		const {nextRoot,nextMarker}=await validatePackageRoot(extracted,release,version);
		const nextPort=await availablePort();const nextWorker=spawnWorker(path.join(nextRoot,"dist/bin/scardice-story-painter.js"),nextPort,nextMarker.version);
		if(!await healthy(nextPort,nextMarker.version,internalHealthHost)){nextWorker.kill("SIGTERM");throw new Error("新版本健康检查失败，继续使用旧版本")}
		if(nextWorker.exitCode!==null)throw new Error("新版本在切换前意外退出，继续使用旧版本");
		const previous=worker,previousPort=activePort,previousVersion=currentVersion;
		let retirement=null;
		nextWorker.once("exit",(code,signal)=>{if(stopping||worker!==nextWorker)return;if(previous.exitCode===null&&!previous.killed){worker=previous;activePort=previousPort;currentVersion=previousVersion;if(retirement)clearTimeout(retirement);console.error(`[updater] New version exited during rollback window (${code??signal}); restored ${currentVersion}`)}else{console.error(`[updater] Active worker exited (${code??signal}); public listener remains available with 503 responses`)}});
		worker=nextWorker;activePort=nextPort;currentVersion=String(nextMarker.version);console.log(`[updater] Switched to ${currentVersion} without closing public listener`);retirement=setTimeout(()=>previous.kill("SIGTERM"),30_000);retirement.unref()
	}catch(error){console.error("[updater]",error)}finally{updating=false}};
	const timer=setInterval(check,config.intervalSeconds*1000);timer.unref();setTimeout(check,10_000).unref();
	const stop=signal=>{if(stopping)return;stopping=true;clearInterval(timer);proxy.close(()=>worker.kill(signal));setTimeout(()=>worker.kill(signal),5000).unref()};process.on("SIGTERM",()=>stop("SIGTERM"));process.on("SIGINT",()=>stop("SIGINT"));
}
const directEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directEntry) main().catch(error=>{console.error(error);process.exitCode=1});

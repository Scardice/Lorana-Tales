import { strFromU8, strToU8, unzip, zip } from "fflate";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { storyFromLogItems } from "./model";
import { archiveForSignedExport } from "./author";
import { parseStoryScript, serializeStoryScript } from "./raw-script";
import type { StoryArchive, StoryAssetRef } from "./types";

const PACKAGE_VERSION = 2;
const STORY_PATH = "story.lorana";
const MANIFEST_PATH = "manifest.lorana";
const METADATA_PATH = "metadata.lorana";
const PACKAGE_MTIME = new Date("2020-01-01T00:00:00.000Z");

export interface StoryPackageLimits {
  maxFiles: number;
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxAssetBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_STORY_PACKAGE_LIMITS: StoryPackageLimits = {
  maxFiles: 1024,
  maxCompressedBytes: 128 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxAssetBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 100,
};

interface ManifestAsset { id:string; path:string; hash:string; size:number; mime:string; name?:string; width?:number; height?:number }

function safeArchivePath(value: string): boolean {
  return (
    !!value && value.length <= 240 &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split(/[\\/]/).includes("..") && /^[\w./-]+$/.test(value)
  );
}

const quote = (value:unknown) => String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
const unquote = (value="") => value.replace(/\\(n|"|\\)/g, (_match, escaped) => escaped === "n" ? "\n" : escaped);
function attributes(line:string){const result=new Map<string,string>();for(const match of line.matchAll(/([\w-]+)="((?:\\.|[^"\\])*)"/g))result.set(match[1],unquote(match[2]));return result}
function mimeExtension(mime:string){const known:Record<string,string>={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif","image/avif":"avif","image/svg+xml":"svg","audio/ogg":"ogg","audio/opus":"opus","audio/mpeg":"mp3","audio/mp4":"m4a","audio/webm":"webm","audio/wav":"wav","audio/flac":"flac","audio/aac":"aac"};return known[mime.toLowerCase().split(";")[0]]||"bin"}
async function sha256(bytes:Uint8Array){return bytesToHex(nobleSha256(bytes))}
function zipAsync(files:Record<string,Uint8Array>){return new Promise<Uint8Array>((resolve,reject)=>zip(files,{level:9,mtime:PACKAGE_MTIME},(error,data)=>error?reject(error):resolve(data)))}
function unzipAsync(bytes:Uint8Array,limits:StoryPackageLimits){let files=0,total=0;return new Promise<Record<string,Uint8Array>>((resolve,reject)=>unzip(bytes,{filter(file){if(!safeArchivePath(file.name))throw new Error("压缩包包含不安全路径");files+=1;const original=Number(file.originalSize||0),compressed=Number(file.size||0);total+=original;if(files>limits.maxFiles)throw new Error("压缩包文件数量过多");if(total>limits.maxUncompressedBytes)throw new Error("压缩包声明的解压大小过大");if(original>0&&original/Math.max(1,compressed)>limits.maxCompressionRatio)throw new Error("压缩包压缩率异常，已拒绝解压");if(file.name.startsWith("assets/")&&original>limits.maxAssetBytes)throw new Error("压缩包包含过大的单个资源");return true}},(error,data)=>error?reject(error):resolve(data)))}
function assetReferences(archive:StoryArchive){const refs=new Map<string,StoryAssetRef>();for(const character of archive.document.characters)if(character.avatar)refs.set(character.avatar.id,character.avatar);for(const message of archive.document.messages)if(message.kind!=="text")refs.set(message.asset.id,message.asset);return refs}
function serializeManifest(assets:ManifestAsset[]){const lines=["<!-- Lorana Tales Package Manifest 2 -->",`<package version="${PACKAGE_VERSION}" story="${STORY_PATH}" metadata="${METADATA_PATH}">`,""];for(const asset of assets){const fields=[`id="${quote(asset.id)}"`,`path="${asset.path}"`,`hash="sha256:${asset.hash}"`,`size="${asset.size}"`,`mime="${quote(asset.mime)}"`];if(asset.name)fields.push(`name="${quote(asset.name)}"`);if(asset.width!=null)fields.push(`width="${asset.width}"`);if(asset.height!=null)fields.push(`height="${asset.height}"`);lines.push(`<asset ${fields.join(" ")}>`)}return`${lines.join("\n").trimEnd()}\n`}
function serializeMetadata(title:string,author:string){return `<!-- Lorana Tales Package Metadata 1 -->\n<metadata version="1" title="${quote(title)}" author="${quote(author)}" />\n`}
function parseMetadata(text:string){const meaningful=text.replace(/<!--[^]*?-->/g,"").trim().split(/\r?\n/).filter(Boolean);if(meaningful.length!==1||!meaningful[0].startsWith("<metadata "))throw new Error("SSP 元信息文件无效");const value=attributes(meaningful[0]);if(value.get("version")!=="1")throw new Error("不支持的 SSP 元信息版本");return{title:(value.get("title")||"跑团记录").trim().slice(0,200)||"跑团记录",author:(value.get("author")||"").trim().slice(0,120)}}
function parseManifest(text:string){let packageSeen=false;const assets:ManifestAsset[]=[];const ids=new Set<string>();for(const [index,raw] of text.replace(/\r\n?/g,"\n").split("\n").entries()){const line=raw.trim();if(!line||line.startsWith("<!--"))continue;if(line.startsWith("<package ")){if(packageSeen)throw new Error("SSP 清单重复声明 package");const values=attributes(line);if(values.get("version")!==String(PACKAGE_VERSION)||values.get("story")!==STORY_PATH||values.get("metadata")!==METADATA_PATH)throw new Error("不支持的 SSP 清单版本");packageSeen=true;continue}if(line.startsWith("<asset ")){const values=attributes(line),id=values.get("id")||"",path=values.get("path")||"",hash=values.get("hash")?.match(/^sha256:([a-f0-9]{64})$/)?.[1]||"",size=Number(values.get("size")),mime=values.get("mime")||"application/octet-stream";if(!packageSeen||!id||id.length>240||ids.has(id)||!safeArchivePath(path)||!path.startsWith("assets/")||!hash||!Number.isSafeInteger(size)||size<0)throw new Error(`SSP 清单第 ${index+1} 行无效`);ids.add(id);const width=Number(values.get("width")),height=Number(values.get("height"));assets.push({id,path,hash,size,mime,name:values.get("name")||undefined,width:Number.isFinite(width)&&width>0?width:undefined,height:Number.isFinite(height)&&height>0?height:undefined});continue}throw new Error(`SSP 清单第 ${index+1} 行包含未知指令`)}if(!packageSeen)throw new Error("SSP 缺少 package 声明");return assets}
function applyAssetMetadata(archive:StoryArchive,metadata:Map<string,ManifestAsset>){const enhance=(ref?:StoryAssetRef)=>{if(!ref)return;const item=metadata.get(ref.id);if(item)Object.assign(ref,{mime:item.mime,name:item.name,width:item.width,height:item.height})};for(const character of archive.document.characters)enhance(character.avatar);for(const message of archive.document.messages)if(message.kind!=="text")enhance(message.asset)}

/** Resolve cached/remote media into the package so a saved cloud project no longer depends on expiring CQ URLs. */
export async function embedRemoteStoryAssets(source:StoryArchive):Promise<{archive:StoryArchive;failed:number}>{
  const archive:StoryArchive={document:structuredClone(source.document),assets:new Map(source.assets)};let failed=0;const refs=[...archive.document.characters.map(item=>item.avatar),...archive.document.messages.flatMap(item=>item.kind!=="text"?[item.asset]:[])].filter((item):item is StoryAssetRef=>!!item);const seen=new Map<string,string>();
  for(const ref of refs){if(archive.assets.has(ref.id))continue;const sourceUrl=ref.sourceUrl||(/^https?:\/\//i.test(ref.id)||ref.id.startsWith("/")?ref.id:"");if(!sourceUrl)continue;try{let localUrl=sourceUrl;const absolute=new URL(sourceUrl,location.href);if(absolute.origin!==location.origin){const response=await fetch("/api/editor/assets/fetch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:sourceUrl}),signal:AbortSignal.timeout(10_000)});if(!response.ok)throw new Error("资源归档失败");localUrl=(await response.json()).url}const existing=seen.get(localUrl);if(existing){ref.id=existing;ref.sourceUrl=undefined;ref.external=false;continue}const response=await fetch(localUrl,{signal:AbortSignal.timeout(10_000)});if(!response.ok)throw new Error("资源下载失败");const bytes=new Uint8Array(await response.arrayBuffer());const hash=bytesToHex(nobleSha256(bytes));const mime=response.headers.get("content-type")||ref.mime||"application/octet-stream";const id=`${hash}.${mimeExtension(mime)}`;archive.assets.set(id,bytes);seen.set(localUrl,id);ref.id=id;ref.sourceUrl=undefined;ref.external=false;ref.mime=mime}catch(error){failed+=1;console.warn(`SSP 资源无法内嵌：${ref.name||sourceUrl}`,error)}
  }
  return{archive,failed};
}

export async function createStoryPackage(archive: StoryArchive, limits:StoryPackageLimits=DEFAULT_STORY_PACKAGE_LIMITS): Promise<Blob> {
  archive=archiveForSignedExport(archive);
  const files:Record<string,Uint8Array>={[STORY_PATH]:strToU8(serializeStoryScript(archive,{includeIdentity:false})),[METADATA_PATH]:strToU8(serializeMetadata(archive.document.title,archive.document.author))};
  const refs=assetReferences(archive),manifest:ManifestAsset[]=[];const contentPaths=new Map<string,string>();let total=files[STORY_PATH].byteLength;
  if(archive.assets.size+3>limits.maxFiles)throw new Error("工程资源数量超过 SSP 上限");
  for (const [assetId, bytes] of archive.assets) {
    if(!assetId||assetId.length>240)throw new Error("资源标识无效");if(bytes.byteLength>limits.maxAssetBytes)throw new Error(`资源 ${assetId} 超过单文件上限`);total+=bytes.byteLength;if(total>limits.maxUncompressedBytes)throw new Error("工程解压体积超过 SSP 上限");
    const ref=refs.get(assetId),hash=await sha256(bytes);let path=contentPaths.get(hash);if(!path){path=`assets/${hash}.${mimeExtension(ref?.mime||"")}`;contentPaths.set(hash,path);files[path]=bytes}manifest.push({id:assetId,path,hash,size:bytes.byteLength,mime:ref?.mime||"application/octet-stream",name:ref?.name,width:ref?.width,height:ref?.height});
  }
  files[MANIFEST_PATH]=strToU8(serializeManifest(manifest));const zipped=await zipAsync(files);if(zipped.byteLength>limits.maxCompressedBytes)throw new Error("SSP 压缩包超过体积上限");
  return new Blob([zipped], { type: "application/vnd.lorana-tales.story+zip" });
}

export async function readStoryPackage(input: Blob | Uint8Array, limits:StoryPackageLimits=DEFAULT_STORY_PACKAGE_LIMITS): Promise<StoryArchive> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
  if (bytes.byteLength > limits.maxCompressedBytes) throw new Error("SSP 文件过大");
  const entries = await unzipAsync(bytes,limits);
  const names = Object.keys(entries);
  if (names.length > limits.maxFiles) throw new Error("压缩包文件数量过多");
  const totalBytes = names.reduce((sum, name) => sum + entries[name].byteLength, 0);
  if (totalBytes > limits.maxUncompressedBytes) throw new Error("压缩包解压后过大");

  const storyBytes = entries[STORY_PATH];
  if (!storyBytes) throw new Error("缺少 story.lorana；新版 SSP 只使用 Lorana Tales Story Language，不保存 JSON 文档");
  const metadataBytes=entries[METADATA_PATH];if(!metadataBytes)throw new Error("缺少 metadata.lorana；标题和作者必须保存在 SSP 顶层元信息文件中");const identity=parseMetadata(strFromU8(metadataBytes));
  const assets=new Map<string,Uint8Array>(),metadata=new Map<string,ManifestAsset>();
  if(entries[MANIFEST_PATH]){for(const asset of parseManifest(strFromU8(entries[MANIFEST_PATH]))){const body=entries[asset.path];if(!body||body.byteLength!==asset.size||body.byteLength>limits.maxAssetBytes)throw new Error(`资源 ${asset.id} 缺失或大小不符`);if(await sha256(body)!==asset.hash)throw new Error(`资源 ${asset.id} 完整性校验失败`);assets.set(asset.id,body);metadata.set(asset.id,asset)}const allowed=new Set([STORY_PATH,METADATA_PATH,MANIFEST_PATH,...[...metadata.values()].map(item=>item.path)]);if(names.some(name=>!allowed.has(name)))throw new Error("SSP 包含清单外文件")}else throw new Error("SSP 缺少 manifest.lorana");
  const base: StoryArchive = { document: storyFromLogItems([], [], { title: "故事", assets }), assets };
  const archive=parseStoryScript(strFromU8(storyBytes),base);archive.document.title=identity.title;archive.document.author=identity.author;applyAssetMetadata(archive,metadata);return archive;
}

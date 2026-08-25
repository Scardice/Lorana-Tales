import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { normalizeStoryDocument } from "./model";
import type {
  StoryArchive,
  StoryDocument,
  StoryPackageManifest,
} from "./types";

const MAX_FILES = 512;
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MANIFEST_PATH = "manifest.json";
const DOCUMENT_PATH = "document.json";

function safeArchivePath(value: string): boolean {
  return (
    !!value &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function contentTypeForPath(path: string): string {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".png")) return "image/png";
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

export async function createStoryPackage(archive: StoryArchive): Promise<Blob> {
  const documentBytes = strToU8(JSON.stringify(archive.document));
  const files = new Map<string, Uint8Array>([[DOCUMENT_PATH, documentBytes]]);
  for (const [assetId, bytes] of archive.assets) {
    const path = assetId.startsWith("assets/") ? assetId : `assets/${assetId}`;
    if (!safeArchivePath(path)) throw new Error("资源路径不安全");
    files.set(path, bytes);
  }

  const manifestFiles: StoryPackageManifest["files"] = [];
  for (const [path, bytes] of files) {
    manifestFiles.push({
      path,
      sha256: await sha256(bytes),
      size: bytes.byteLength,
      mime: contentTypeForPath(path),
    });
  }
  const manifest: StoryPackageManifest = {
    format: "scardice-story-package",
    version: 1,
    createdAt: new Date().toISOString(),
    document: DOCUMENT_PATH,
    files: manifestFiles,
  };

  const zipInput: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: strToU8(JSON.stringify(manifest)),
  };
  for (const [path, bytes] of files) zipInput[path] = bytes;
  const zipped = zipSync(zipInput, { level: 9 });
  return new Blob([zipped], { type: "application/vnd.scardice.story+zip" });
}

export async function readStoryPackage(input: Blob | Uint8Array): Promise<StoryArchive> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
  if (bytes.byteLength > MAX_UNCOMPRESSED_BYTES) throw new Error("SSP 文件过大");
  let announcedFiles = 0;
  let announcedBytes = 0;
  const entries = unzipSync(bytes, {
    filter(file) {
      if (!safeArchivePath(file.name)) throw new Error("压缩包包含不安全路径");
      announcedFiles += 1;
      announcedBytes += Number(file.originalSize || 0);
      if (announcedFiles > MAX_FILES) throw new Error("压缩包文件数量过多");
      if (announcedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("压缩包声明的解压大小过大");
      return true;
    },
  });
  const names = Object.keys(entries);
  if (names.length > MAX_FILES) throw new Error("压缩包文件数量过多");
  const totalBytes = names.reduce((sum, name) => sum + entries[name].byteLength, 0);
  if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("压缩包解压后过大");

  const manifestBytes = entries[MANIFEST_PATH];
  if (!manifestBytes) throw new Error("缺少 manifest.json");
  const manifest = JSON.parse(strFromU8(manifestBytes)) as StoryPackageManifest;
  if (manifest.format !== "scardice-story-package" || manifest.version !== 1) {
    throw new Error("不支持的 SSP 格式版本");
  }
  if (!safeArchivePath(manifest.document)) throw new Error("文档路径不安全");

  for (const expected of manifest.files) {
    if (!safeArchivePath(expected.path)) throw new Error("清单包含不安全路径");
    const actual = entries[expected.path];
    if (!actual || actual.byteLength !== expected.size) throw new Error(`文件损坏: ${expected.path}`);
    if ((await sha256(actual)) !== expected.sha256) throw new Error(`校验失败: ${expected.path}`);
  }

  const documentBytes = entries[manifest.document];
  if (!documentBytes) throw new Error("缺少故事文档");
  const document = normalizeStoryDocument(JSON.parse(strFromU8(documentBytes)) as StoryDocument);
  const assets = new Map<string, Uint8Array>();
  for (const entry of manifest.files) {
    if (entry.path.startsWith("assets/")) {
      assets.set(entry.path.slice("assets/".length), entries[entry.path]);
    }
  }
  return { document, assets };
}

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { storyFromLogItems } from "./model";
import { parseStoryScript, serializeStoryScript } from "./raw-script";
import type { StoryArchive } from "./types";

const MAX_FILES = 512;
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const STORY_PATH = "story.lorana";

function safeArchivePath(value: string): boolean {
  return (
    !!value &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

export async function createStoryPackage(archive: StoryArchive): Promise<Blob> {
  const files = new Map<string, Uint8Array>([[STORY_PATH, strToU8(serializeStoryScript(archive))]]);
  for (const [assetId, bytes] of archive.assets) {
    const path = assetId.startsWith("assets/") ? assetId : `assets/${assetId}`;
    if (!safeArchivePath(path)) throw new Error("资源路径不安全");
    files.set(path, bytes);
  }

  const zipInput: Record<string, Uint8Array> = {};
  for (const [path, bytes] of files) zipInput[path] = bytes;
  const zipped = zipSync(zipInput, { level: 9 });
  return new Blob([zipped], { type: "application/vnd.lorana-tales.story+zip" });
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

  const storyBytes = entries[STORY_PATH];
  if (!storyBytes) throw new Error("缺少 story.lorana；新版 SSP 只使用 Lorana Tales Story Language，不保存 JSON 文档");
  const assets = new Map<string, Uint8Array>();
  for (const name of names) {
    if (name.startsWith("assets/") && name.length > "assets/".length) {
      assets.set(name.slice("assets/".length), entries[name]);
    }
  }
  const base: StoryArchive = { document: storyFromLogItems([], [], { title: "故事", assets }), assets };
  return parseStoryScript(strFromU8(storyBytes), base);
}

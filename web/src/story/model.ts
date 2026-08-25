import type { CharItem, LogItem } from "~/logManager/types";
import {
  defaultStorySettings,
  STORY_SCHEMA_VERSION,
  type StoryCharacter,
  type StoryDocument,
  type StoryMessage,
  type StoryPosition,
} from "./types";

const cqSingleImage = /^\s*\[CQ:(?:image|face),([\s\S]+)\]\s*$/i;
const bracketSingleImage = /^\s*\[(?:image|图):base64:\/\/([A-Za-z0-9+/=\s]+)\]\s*$/i;

export function createStoryId(prefix = "story"): string {
  const random = globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function characterKey(name: string, imUserId: string): string {
  return `${name}\u0000${imUserId}`;
}

function rolePosition(role: string | undefined): StoryPosition {
  if (role === "主持人") return "right";
  if (role === "骰子") return "narrator";
  return "left";
}

function messageFingerprint(item: LogItem, occurrence: number): string {
  if (item.id !== undefined && item.id !== null) {
    return `source-id-${String(item.id).replace(/[^A-Za-z0-9_.-]/g, "_")}-${occurrence}`;
  }
  const raw = [
    item.IMUserId || "",
    item.nickname || "",
    item.time ?? "",
    item.timeText || "",
    item.message || "",
    occurrence,
  ].join("\u001f");
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `source-${(hash >>> 0).toString(16).padStart(8, "0")}-${occurrence}`;
}

function parseCqAttrs(value: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const part of value.split(",")) {
    const [key, ...rest] = part.split("=");
    if (key) attrs.set(key.trim(), rest.join("=").trim());
  }
  return attrs;
}

function imageMessageFromLog(
  item: LogItem,
  base: Omit<StoryMessage, "kind">,
  assets?: Map<string, Uint8Array>,
): StoryMessage | null {
  const mirai = /^\s*\[mirai:(?:image|marketface):\{?([A-Fa-f0-9-]{32,36})\}?(?:\.[A-Za-z0-9]+)?\]\s*$/i.exec(item.message || "");
  if (mirai) {
    const hash = mirai[1].replaceAll("-", "").toUpperCase();
    const source = `https://gchat.qpic.cn/gchatpic_new/0/0-0-${hash}/0?term=2`;
    return { ...base, kind: "image", asset: { id: source, mime: "image/*", sourceUrl: source, name: "图片" }, alt: "图片" };
  }
  const match = cqSingleImage.exec(item.message || "");
  const bracket = bracketSingleImage.exec(item.message || "");
  const body = match?.[1] || "";
  const base64 = bracket?.[1] || /\b(?:file|data)=base64:\/\/([A-Za-z0-9+/=\s]+)/i.exec(body)?.[1];
  if (base64) {
    try {
      const compact = base64.replaceAll(/\s+/g, "");
      const bytes = Uint8Array.from(atob(compact), (char) => char.charCodeAt(0));
      const mime = compact.startsWith("/9j/") ? "image/jpeg" : compact.startsWith("R0lG") ? "image/gif" : compact.startsWith("UklGR") ? "image/webp" : "image/png";
      const id = createStoryId("asset");
      assets?.set(id, bytes);
      return { ...base, kind: "image", asset: { id, mime, name: "内嵌图片" }, alt: "图片" };
    } catch { return null; }
  }
  if (!match) return null;
  const attrs = parseCqAttrs(body);
  const urlMatch = /\burl=(?:\[(https?:\/\/[^\]]+)\]\(https?:\/\/[^)]+\)|\[?(https?:\/\/[^,\]\s]+))/i.exec(body);
  const fileUrlMatch = /\bfile=(https?:\/\/[^,\]\s]+)/i.exec(body);
  const source = urlMatch?.[1] || urlMatch?.[2] || fileUrlMatch?.[1] || attrs.get("url") || attrs.get("file") || "";
  if (!/^https?:\/\//i.test(source) && !source.startsWith("/cq-resources/")) return null;
  return {
    ...base,
    kind: "image",
    asset: {
      id: source,
      mime: "image/*",
      sourceUrl: source,
      name: attrs.get("summary") || "图片",
    },
    alt: attrs.get("summary") || "图片",
  };
}

export function storyFromLogItems(
  items: readonly LogItem[],
  chars: readonly CharItem[],
  options: { title?: string; sourceKey?: string; sourceRevision?: string; assets?: Map<string, Uint8Array> } = {},
): StoryDocument {
  const characters: StoryCharacter[] = [];
  const characterIds = new Map<string, string>();
  const sourceChars = new Map(
    chars.map((char) => [characterKey(char.name, char.IMUserId), char]),
  );

  const narrator: StoryCharacter = {
    id: "character-narrator",
    name: "旁白",
    imUserId: "",
    position: "narrator",
    color: "#9ca3af",
    isNarrator: true,
    isDice: false,
    hidden: false,
  };
  characters.push(narrator);

  for (const item of items) {
    if (item.isRaw) continue;
    const key = characterKey(item.nickname || "未知角色", item.IMUserId || "");
    if (characterIds.has(key)) continue;
    const char = sourceChars.get(key);
    const id = createStoryId("character");
    characterIds.set(key, id);
    characters.push({
      id,
      name: char?.name || item.nickname || "未知角色",
      imUserId: char?.IMUserId || item.IMUserId || "",
      position: rolePosition(char?.role || item.role || (item.isDice ? "骰子" : undefined)),
      color: char?.color || item.color || "#64748b",
      isNarrator: false,
      isDice: !!item.isDice || char?.role === "骰子",
      hidden: char?.role === "隐藏" || item.role === "隐藏",
    });
  }

  const occurrence = new Map<string, number>();
  const messages: StoryMessage[] = [];
  for (const item of items) {
    if (item.isRaw) continue;
    const key = characterKey(item.nickname || "未知角色", item.IMUserId || "");
    const characterId = characterIds.get(key);
    if (!characterId) continue;
    const signature = `${item.id ?? ""}:${item.IMUserId}:${item.time}:${item.message}`;
    const count = (occurrence.get(signature) || 0) + 1;
    occurrence.set(signature, count);
    const fingerprint = messageFingerprint(item, count);
    const base = {
      id: fingerprint,
      characterId,
      time: Number(item.time || 0),
      timeText: item.timeText,
      sourceFingerprint: fingerprint,
      sourceItem: { ...item },
    };
    messages.push(
      imageMessageFromLog(item, base as Omit<StoryMessage, "kind">, options.assets) || {
        ...base,
        kind: "text",
        text: item.message || "",
      },
    );
  }

  const now = new Date().toISOString();
  return {
    format: "scardice-story-document",
    schemaVersion: STORY_SCHEMA_VERSION,
    id: createStoryId("document"),
    title: options.title || "跑团记录",
    createdAt: now,
    updatedAt: now,
    characters,
    messages,
    settings: defaultStorySettings(),
    source: options.sourceKey
      ? {
          kind: "remote-log",
          key: options.sourceKey,
          revision: options.sourceRevision,
          syncedAt: now,
        }
      : { kind: "none" },
  };
}

export function storyToLogItems(document: StoryDocument): LogItem[] {
  const characterMap = new Map(document.characters.map((item) => [item.id, item]));
  return document.messages.map((message, index) => {
    const character = characterMap.get(message.characterId) || document.characters[0];
    const text =
      message.kind === "text"
        ? message.text
        : `[CQ:image,file=${message.asset.sourceUrl || message.asset.id}]`;
    return {
      ...(message.sourceItem || {}),
      id: message.sourceItem?.id ?? index + 1,
      nickname: character?.name || "旁白",
      IMUserId: character?.imUserId || "",
      time: message.time || 0,
      timeText: message.timeText,
      message: text.endsWith("\n\n") ? text : `${text}\n\n`,
      isDice: !!character?.isDice,
      commandId: message.sourceItem?.commandId ?? 0,
      color: character?.color,
      role: character?.hidden
        ? "隐藏"
        : character?.isDice
          ? "骰子"
          : character?.position === "right"
            ? "主持人"
            : "角色",
    };
  });
}

export function normalizeStoryDocument(input: StoryDocument): StoryDocument {
  const defaults = defaultStorySettings();
  const characters = Array.isArray(input.characters) ? input.characters : [];
  if (!characters.some((item) => item.isNarrator)) {
    characters.unshift({
      id: "character-narrator",
      name: "旁白",
      imUserId: "",
      position: "narrator",
      color: "#9ca3af",
      isNarrator: true,
      isDice: false,
      hidden: false,
    });
  }
  return {
    ...input,
    format: "scardice-story-document",
    schemaVersion: STORY_SCHEMA_VERSION,
    id: input.id || createStoryId("document"),
    title: input.title || "跑团记录",
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
    characters,
    messages: Array.isArray(input.messages) ? input.messages : [],
    settings: { ...defaults, ...(input.settings || {}) },
    source: input.source || { kind: "none" },
  };
}

export function playbackDelay(message: StoryMessage, document: StoryDocument): number {
  const settings = document.settings;
  if (settings.playbackTiming === "fixed") return settings.fixedDelayMs;
  const text = message.kind === "text" ? message.text : message.alt || "图片";
  const chineseCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const englishWords = text
    .replace(/[\u3400-\u9fff]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const punctuation = (text.match(/[，。！？；：,.!?;:]/g) || []).length;
  const milliseconds =
    (chineseCount / Math.max(1, settings.chineseCharsPerMinute)) * 60_000 +
    (englishWords / Math.max(1, settings.englishWordsPerMinute)) * 60_000 +
    punctuation * 120;
  return Math.max(1500, Math.min(15_000, Math.round(milliseconds || 1500)));
}

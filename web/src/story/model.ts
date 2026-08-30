import type { CharItem, LogItem } from "~/logManager/types";
import {
  defaultStorySettings,
  STORY_SCHEMA_VERSION,
  type StoryCharacter,
  type StoryDocument,
  type StoryMessage,
  type StoryPosition,
} from "./types";

const cqSingleImage = /^\s*\[CQ:image,([\s\S]+)\]\s*$/i;
const cqSingleAudio = /^\s*\[CQ:(?:record|voice|audio),([\s\S]+)\]\s*$/i;
const cqSingleVideo = /^\s*\[CQ:(?:video|shortvideo),[^\]]*\]\s*$/i;
const bracketSingleImage = /^\s*\[(?:image|图):base64:\/\/([A-Za-z0-9+/=\s]+)\]\s*$/i;
const obsoleteDemoImage = "[CQ:image,file=base64://iVBORw0KGgoAAAANSUhEUgAAABkAAAAZCAYAAADE6YVjAAAAJklEQVR42u3NIQEAAAgDsPdPQ8OTAtTE9NJJr0UikUgkEolE8pIsTbqLKR00etoAAAAASUVORK5CYII=]";

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

function cqUnescape(value: string): string {
  return value.replace(/&#44;/gi, ",").replace(/&#91;/gi, "[").replace(/&#93;/gi, "]").replace(/&amp;/gi, "&");
}

function cqReplySourceId(value: string): string {
  const match = /\[CQ:reply(?:,([^\]]*))?\]/i.exec(value);
  if (!match) return "";
  const attrs = parseCqAttrs(match[1] || "");
  return cqUnescape(attrs.get("id") || attrs.get("message_id") || attrs.get("msg_id") || "");
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
  const face = /^\s*\[CQ:face,/i.test(item.message || "") ? attrs.get("id") || attrs.get("face_id") || "" : "";
  if (/^\d{1,4}$/.test(face)) {
    const source = `/api/editor/cq-face/${face}`;
    return { ...base, kind: "image", asset: { id: source, mime: "image/png", sourceUrl: source, name: `QQ 表情 ${face}` }, alt: `QQ 表情 ${face}` };
  }
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

function audioMessageFromLog(item: LogItem, base: Omit<StoryMessage, "kind">): StoryMessage | null {
  const match = cqSingleAudio.exec(item.message || ""); if (!match) return null;
  const attrs = parseCqAttrs(match[1]);
  const urlMatch = /\burl=(?:\[(https?:\/\/[^\]]+)\]\(https?:\/\/[^)]+\)|\[?(https?:\/\/[^,\]\s]+))/i.exec(match[1]);
  const fileUrlMatch = /\bfile=(https?:\/\/[^,\]\s]+)/i.exec(match[1]);
  const source = urlMatch?.[1] || urlMatch?.[2] || fileUrlMatch?.[1] || attrs.get("url") || attrs.get("file") || "";
  if (!/^https?:\/\//i.test(source) && !source.startsWith("/cq-resources/")) return null;
  return { ...base, kind: "audio", asset: { id: source, mime: "audio/*", sourceUrl: source, name: attrs.get("file") || "语音" }, alt: "语音" };
}

interface SourceMessagePart {
  kind: "text" | "image" | "audio" | "video";
  value: string;
}

function splitCqImageParts(message: string): SourceMessagePart[] {
  const parts: SourceMessagePart[] = [];
  const marker = /\[CQ:(image|record|voice|audio|video|shortvideo),/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(message))) {
    let depth = 0;
    let end = -1;
    for (let index = match.index; index < message.length; index += 1) {
      if (message[index] === "[") depth += 1;
      if (message[index] === "]") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end < 0) break;
    const before = message.slice(cursor, match.index).trim();
    if (before) parts.push({ kind: "text", value: before });
    const cqKind = match[1].toLowerCase();
    parts.push({ kind: ["record","voice","audio"].includes(cqKind) ? "audio" : ["video","shortvideo"].includes(cqKind) ? "video" : "image", value: message.slice(match.index, end) });
    cursor = end;
    marker.lastIndex = end;
  }
  const after = message.slice(cursor).trim();
  if (after) parts.push({ kind: "text", value: after });
  return parts;
}

function messagesFromLogItem(
  item: LogItem,
  base: Omit<StoryMessage, "kind">,
  assets?: Map<string, Uint8Array>,
): StoryMessage[] {
  const parts = splitCqImageParts(item.message || "");
  if (parts.some((part) => part.kind !== "text") && parts.length > 1) {
    const messages: StoryMessage[] = [];
    for (const [index, part] of parts.entries()) {
      const sourceFingerprint = `${base.sourceFingerprint}-part-${index + 1}`;
      const partBase = {
        ...base,
        id: sourceFingerprint,
        sourceFingerprint,
      };
      if (part.kind === "text") {
        messages.push({ ...partBase, kind: "text", text: part.value.trim(), sourcePartText: part.value });
        continue;
      }
      if (part.kind === "video") {
        messages.push({ ...partBase, kind: "text", text: "【视频】", sourcePartText: part.value });
        continue;
      }
      const resource = part.kind === "audio" ? audioMessageFromLog(
        { ...item, message: part.value },
        partBase as Omit<StoryMessage, "kind">,
      ) : imageMessageFromLog(
        { ...item, message: part.value },
        partBase as Omit<StoryMessage, "kind">,
        assets,
      );
      if (resource) {
        messages.push({ ...resource, sourcePartText: resource.kind !== "text" ? resource.asset.sourceUrl || resource.asset.id : part.value });
      } else {
        messages.push({ ...partBase, kind: "text", text: part.kind === "audio" ? "【语音】" : "【图片】", sourcePartText: part.value });
      }
    }
    return messages;
  }
  const image = imageMessageFromLog(item, base, assets);
  if (image) return [image];
  const audio = audioMessageFromLog(item, base);
  if (audio) return [audio];
  if (cqSingleImage.test(item.message || "")) return [{ ...base, kind: "text", text: "【图片】" }];
  if (cqSingleAudio.test(item.message || "")) return [{ ...base, kind: "text", text: "【语音】" }];
  if (cqSingleVideo.test(item.message || "")) return [{ ...base, kind: "text", text: "【视频】" }];
  return [{ ...base, kind: "text", text: (item.message || "").trim() }];
}

export function storyFromLogItems(
  items: readonly LogItem[],
  chars: readonly CharItem[],
  options: { title?: string; author?: string; sourceKey?: string; sourceRevision?: string; assets?: Map<string, Uint8Array> } = {},
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
    narratorAvatar: false,
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
      narratorAvatar: false,
      isNarrator: false,
      isDice: !!item.isDice || char?.role === "骰子",
      hidden: char?.role === "隐藏" || item.role === "隐藏",
    });
  }

  const occurrence = new Map<string, number>();
  const messages: StoryMessage[] = [];
  const sourceMessageIds = new Map<string, string>();
  const pendingReplies: Array<{ messageId: string; sourceId: string }> = [];
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
    const imported = messagesFromLogItem(item, base as Omit<StoryMessage, "kind">, options.assets);
    messages.push(...imported);
    if (item.id !== undefined && item.id !== null && imported[0]) sourceMessageIds.set(String(item.id), imported[0].id);
    const replySourceId = cqReplySourceId(item.message || "");
    if (replySourceId && imported[0]) pendingReplies.push({ messageId: imported[0].id, sourceId: replySourceId });
  }
  for (const pending of pendingReplies) {
    const targetId = sourceMessageIds.get(pending.sourceId);
    const message = messages.find((item) => item.id === pending.messageId);
    if (message && targetId) message.replyToId = targetId;
  }

  const now = new Date().toISOString();
  return {
    format: "lorana-tales-document",
    schemaVersion: STORY_SCHEMA_VERSION,
    id: createStoryId("document"),
    title: options.title || "跑团记录",
    author: options.author?.trim() || "",
    createdAt: now,
    updatedAt: now,
    characters,
    messages,
    effectTracks: [],
    characterStateEvents: [],
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
    const text = message.kind === "text" ? message.text : message.kind === "audio" ? `[CQ:record,file=${message.asset.sourceUrl || message.asset.id}]` : `[CQ:image,file=${message.asset.sourceUrl || message.asset.id}]`;
    return {
      ...(message.sourceItem || {}),
      id: message.sourcePartText !== undefined ? index + 1 : message.sourceItem?.id ?? index + 1,
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
  const settings = {
    ...defaults,
    ...(input.settings || {}),
    ...((input.schemaVersion || 0) < 7
      ? { canvasWidth: defaults.canvasWidth }
      : {}),
  };
  const inheritedNarratorAvatar = input.settings?.showNarratorAvatar ?? defaults.showNarratorAvatar;
  const characters = Array.isArray(input.characters)
    ? input.characters.map((item) => ({
        ...item,
        narratorAvatar:
          item.narratorAvatar ?? (item.position === "narrator" && inheritedNarratorAvatar),
      }))
    : [];
  if (!characters.some((item) => item.isNarrator)) {
    characters.unshift({
      id: "character-narrator",
      name: "旁白",
      imUserId: "",
      position: "narrator",
      color: "#9ca3af",
      narratorAvatar: inheritedNarratorAvatar,
      isNarrator: true,
      isDice: false,
      hidden: false,
    });
  }
  return {
    ...input,
    format: "lorana-tales-document",
    schemaVersion: STORY_SCHEMA_VERSION,
    id: input.id || createStoryId("document"),
    title: input.title || "跑团记录",
    author: String(input.author || "").trim().slice(0, 120),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
    characters,
    messages: Array.isArray(input.messages)
      ? input.messages.flatMap((message) => {
          if (message.kind === "image" && message.sourceItem?.message.trim() === obsoleteDemoImage) return [];
          if (message.kind !== "text" || !/\[CQ:image,/i.test(message.text) || /base64:\/\//i.test(message.text)) return [message];
          const { kind: _kind, text, ...base } = message;
          const source = message.sourceItem || {
            id: 0,
            nickname: "",
            IMUserId: "",
            time: message.time || 0,
            message: text,
            isDice: false,
            commandId: 0,
          };
          const migrated = messagesFromLogItem(
            { ...source, message: text },
            base as Omit<StoryMessage, "kind">,
          );
          return migrated.some((item) => item.kind === "image") ? migrated : [message];
        })
      : [],
    effectTracks: Array.isArray(input.effectTracks)
      ? input.effectTracks.filter((track) => track && typeof track.id === "string" && typeof track.startMessageId === "string" && typeof track.endMessageId === "string").map((track) => ({ ...track, color: typeof track.color === "string" && ["auto", "neutral", "red", "orange", "gold", "green", "cyan", "blue", "purple", "pink"].includes(track.color) ? track.color : undefined,intensityPercent:typeof track.intensityPercent==="number"?Math.max(10,Math.min(200,track.intensityPercent)):undefined,opacityPercent:typeof track.opacityPercent==="number"?Math.max(5,Math.min(100,track.opacityPercent)):undefined,speedPercent:typeof track.speedPercent==="number"?Math.max(10,Math.min(300,track.speedPercent)):undefined }))
      : [],
    characterStateEvents: Array.isArray(input.characterStateEvents)
      ? input.characterStateEvents.filter((event) => event && typeof event.id === "string" && typeof event.characterId === "string" && typeof event.afterMessageId === "string" && ["normal", "gray", "injured", "frozen", "cursed", "out", "dead", "wasted"].includes(event.state))
      : [],
    settings,
    source: input.source || { kind: "none" },
  };
}

export type StoryMessageGroupPosition = "single" | "first" | "middle" | "last";

function canMergeAt(document: StoryDocument, leftIndex: number, rightIndex: number): boolean {
  if (!document.settings.mergeMessages || leftIndex < 0 || rightIndex >= document.messages.length) return false;
  const left = document.messages[leftIndex];
  const right = document.messages[rightIndex];
  if (!left || !right || left.characterId !== right.characterId) return false;
  const character = document.characters.find((item) => item.id === right.characterId);
  return character?.position !== "narrator" || document.settings.mergeNarration;
}

export function storyMessageGroupPosition(document: StoryDocument, index: number): StoryMessageGroupPosition {
  const previous = canMergeAt(document, index - 1, index);
  const next = canMergeAt(document, index, index + 1);
  if (previous && next) return "middle";
  if (previous) return "last";
  if (next) return "first";
  return "single";
}

export function storyDisplayText(text: string, preserveLineBreaks: boolean): string {
  const normalized = text.replace(/\[CQ:reply(?:,[^\]]*)?\]/gi, "").replace(/\r\n?/g, "\n").trim();
  if (preserveLineBreaks) return normalized;
  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split("\n").map((line) => line.trim()).filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n\n");
}

export interface StoryTextSegment {
  text: string;
  character?: StoryCharacter;
  faceId?: string;
}

export function storyTextSegments(text: string, characters: readonly StoryCharacter[], preserveLineBreaks: boolean): StoryTextSegment[] {
  const source = storyDisplayText(text, preserveLineBreaks);
  const byQq = new Map(characters.filter((item) => item.imUserId).map((item) => [String(item.imUserId), item]));
  const byName = [...characters].filter((item) => item.name).sort((left, right) => right.name.length - left.name.length);
  const result: StoryTextSegment[] = [];
  const appendPlain = (value: string) => {
    let cursor = 0;
    const names = byName.map((item) => item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!names.length) { if (value) result.push({ text: value }); return; }
    const mention = new RegExp(`@(${names.join("|")})(?![\\p{L}\\p{N}_])`, "gu");
    for (const match of value.matchAll(mention)) {
      if (match.index! > cursor) result.push({ text: value.slice(cursor, match.index) });
      const character = byName.find((item) => item.name === match[1]);
      result.push({ text: match[0], character });
      cursor = match.index! + match[0].length;
    }
    if (cursor < value.length) result.push({ text: value.slice(cursor) });
  };
  let cursor = 0;
  const resourceLabels: Record<string, string> = {
    image: "【图片】", record: "【语音】", audio: "【语音】", video: "【视频】", file: "【文件】",
    music: "【音乐】", share: "【分享】", location: "【位置】", json: "【卡片消息】", xml: "【卡片消息】",
    forward: "【合并转发】", node: "【转发消息】", contact: "【联系人】", poke: "【戳一戳】",
    dice: "【骰子】", rps: "【猜拳】", shake: "【窗口抖动】",
  };
  for (const match of source.matchAll(/\[CQ:([a-zA-Z0-9_-]+)(?:,([^\]]*))?\]/gi)) {
    appendPlain(source.slice(cursor, match.index));
    const type = match[1].toLowerCase();
    const attrs = parseCqAttrs(match[2] || "");
    if (type === "face") {
      const faceId = cqUnescape(attrs.get("id") || attrs.get("face_id") || "");
      if (/^\d{1,4}$/.test(faceId)) result.push({ text: "", faceId });
      else result.push({ text: "【表情】" });
      cursor = match.index! + match[0].length;
      continue;
    }
    if (type !== "at") {
      result.push({ text: resourceLabels[type] || "【消息资源】" });
      cursor = match.index! + match[0].length;
      continue;
    }
    const qq = cqUnescape(attrs.get("qq") || "");
    const character = byQq.get(qq);
    const fallback = cqUnescape(attrs.get("name") || qq || "未知用户");
    result.push({ text: `@${character?.name || (qq === "all" ? "全体成员" : fallback)}`, character });
    cursor = match.index! + match[0].length;
  }
  appendPlain(source.slice(cursor));
  return result.filter((item) => item.text || item.faceId);
}

export function storyPlainText(text: string, characters: readonly StoryCharacter[], preserveLineBreaks: boolean): string {
  return storyTextSegments(text, characters, preserveLineBreaks).map((item) => item.text).join("");
}

/** Text used by the streaming renderer: CQ segments are converted atomically to their visible representation. */
export function storyStreamingText(text: string, characters: readonly StoryCharacter[], preserveLineBreaks: boolean): string {
  return storyTextSegments(text, characters, preserveLineBreaks).map((item) => item.faceId ? "【表情】" : item.text).join("");
}

export function playbackDelay(message: StoryMessage, document: StoryDocument): number {
  const settings = document.settings;
  if (message.performance?.durationMs && message.performance.durationMs > 0) return message.performance.durationMs;
  if (settings.playbackTiming === "fixed") return settings.fixedDelayMs;
  const text = message.kind === "text"
    ? storyStreamingText(message.text, document.characters, settings.preserveLineBreaks)
    : message.alt || "图片";
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

export interface StoryStreamToken {
  index: number;
  text: string;
  start: number;
  end: number;
  wordLike: boolean;
  pauseEligible: boolean;
  custom: boolean;
}

/**
 * Segment text without shipping a language dictionary. Intl.Segmenter keeps
 * English words intact and uses the browser's locale-aware Chinese word data.
 */
export function segmentStoryText(text: string, customGroups: Array<{ start: number; end: number }> = []): StoryStreamToken[] {
  type Segment = { segment: string; isWordLike?: boolean };
  type Segmenter = { segment: (value: string) => Iterable<Segment> };
  const SegmenterCtor = (Intl as unknown as {
    Segmenter?: new (locale?: string | string[], options?: { granularity: "word" }) => Segmenter;
  }).Segmenter;
  const automatic = (value: string, baseOffset: number) => {
    const segments: Segment[] = SegmenterCtor
      ? Array.from(new SegmenterCtor(["zh-CN", "en"], { granularity: "word" }).segment(value))
      : Array.from(value.matchAll(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|\s+|[\u3400-\u9fff]|./gu), (match) => ({
          segment: match[0],
          isWordLike: /[A-Za-z0-9\u3400-\u9fff]/u.test(match[0]),
        }));
    let offset = baseOffset;
    return segments.map((item) => {
      const start = offset;
      offset += item.segment.length;
      return { text: item.segment, start, end: offset, wordLike: !!item.isWordLike, custom: false };
    });
  };
  const groups = customGroups
    .map((group) => ({ start: Math.max(0, Math.min(text.length, Math.round(group.start))), end: Math.max(0, Math.min(text.length, Math.round(group.end))) }))
    .filter((group) => group.end > group.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .filter((group, index, all) => index === 0 || group.start >= all[index - 1].end);
  const tokens: Array<{ text: string; start: number; end: number; wordLike: boolean; custom: boolean }> = [];
  let cursor = 0;
  for (const group of groups) {
    if (group.start > cursor) tokens.push(...automatic(text.slice(cursor, group.start), cursor));
    const value = text.slice(group.start, group.end);
    tokens.push({ text: value, start: group.start, end: group.end, wordLike: /\S/u.test(value), custom: true });
    cursor = group.end;
  }
  if (cursor < text.length) tokens.push(...automatic(text.slice(cursor), cursor));
  return tokens.map((item, index) => ({
    ...item,
    index,
    pauseEligible: item.wordLike || /[，。！？；：,.!?;:]$/u.test(item.text),
  }));
}

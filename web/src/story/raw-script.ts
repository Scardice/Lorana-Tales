import { createStoryId, normalizeStoryDocument, segmentStoryText } from "./model";
import { storyPalette } from "./palette";
import type { StoryArchive, StoryCharacter, StoryInteractionEffect, StoryMessage, StoryPersistentEffect, StoryScreenEffect, StorySettings, StoryStreamTokenAnimation } from "./types";

const tokenAnimations = new Set<StoryStreamTokenAnimation>(["none", "fade", "rise", "blur", "impact", "shake", "ghost"]);
const screenEffects = new Set<StoryScreenEffect>(["none", "shake-light", "shake-heavy", "glow", "warm-glow", "cold-flash", "flash", "flicker", "damage", "heartbeat", "blackout", "dream", "vignette"]);
const interactionEffects = new Set<StoryInteractionEffect>(["throw", "heart", "magic", "surprise", "impact"]);
const persistentEffects = new Set<StoryPersistentEffect>(["low-health", "curse", "dream-haze", "storm", "magic-aura"]);

const settingKeys = new Set<keyof StorySettings>([
	"mergeMessages", "mergeNarration", "showAvatars", "stickyGroupAvatar", "avatarAlignment", "showNarratorAvatar",
  "previewOnly", "showQqInEditor", "showQqInPreview", "showNames", "showNarratorNames",
  "showTime", "hideOffTopic", "hideDiceCommands", "enterKeyBehavior", "preserveLineBreaks", "theme", "density", "fontSize", "avatarSize",
  "narratorAvatarSize", "bubbleMaxWidth", "canvasWidth", "centerGutterPercent",
  "imageMaxWidthPercent", "imageMaxHeightVh", "animation", "animationDurationMs",
  "autoplay", "playbackTiming", "fixedDelayMs", "chineseCharsPerMinute", "englishWordsPerMinute",
  "streamEnabled", "streamTokensPerSecond", "streamSpeedJitterPercent", "streamPauseMinMs",
  "streamPauseMaxMs", "streamTokenAnimation", "streamCursor", "typingIndicatorEnabled",
  "typingIndicatorText", "typingIndicatorEffect", "typingIndicatorMs",
]);

const quote = (value: unknown) => String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
const unquote = (value = "") => value.replace(/\\(n|"|\\)/g, (_match, escaped) => escaped === "n" ? "\n" : escaped);
const textEscape = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("<", "\\<");
const textUnescape = (value: string) => value.replace(/\\(<|\\)/g, "$1");

function tagAttributes(line: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of line.matchAll(/([\w-]+)="((?:\\.|[^"\\])*)"/g)) result.set(match[1], unquote(match[2]));
  return result;
}

function formatSetting(value: StorySettings[keyof StorySettings]) { return typeof value === "boolean" ? (value ? "on" : "off") : String(value); }
function parseSetting(value: string, current: unknown) {
  if (typeof current === "boolean") return ["on", "true", "yes", "1"].includes(value.toLowerCase());
  if (typeof current === "number") { const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error(`“${value}”不是有效数字`); return parsed; }
  return value;
}

function serializeTimedText(message: Extract<StoryMessage, { kind: "text" }>) {
  const tokens = segmentStoryText(message.text, message.performance?.tokenGroups); const delays = message.performance?.tokenDelays || {}; const output: string[] = [];
  for (const token of tokens) {
    const delay = delays[token.index];
    let body = textEscape(token.text);
    if (token.custom) body = `<word>${body}<word/>`;
    if (delay != null) body = `<wt:${Math.round(delay)}ms>${body}<wt/>`;
    output.push(body);
  }
  return output.join("");
}

function parseTimedText(markup: string) {
  const ranges: Array<{ start: number; end: number; delay: number }> = [];
  const tokenGroups: Array<{ start: number; end: number }> = [];
  let plain = ""; let cursor = 0; let delay: number | undefined; let delayStart = 0; let groupStart: number | undefined;
  const regex = /(?<!\\)<wt:([+-]?\d+(?:\.\d+)?)ms>|(?<!\\)<wt\/>|(?<!\\)<word>|(?<!\\)<word\/>/g;
  let match: RegExpExecArray | null;
  const append = (value: string) => { plain += textUnescape(value); };
  while ((match = regex.exec(markup))) {
    append(markup.slice(cursor, match.index));
    const tag = match[0];
    if (tag.startsWith("<wt:")) { if (delay != null) throw new Error("逐词偏移标签不能嵌套"); delay = Math.round(Number(match[1])); delayStart = plain.length; }
    else if (tag === "<wt/>") { if (delay == null) throw new Error("发现没有起始标签的 <wt/>"); ranges.push({ start:delayStart, end:plain.length, delay }); delay = undefined; }
    else if (tag === "<word>") { if (groupStart != null) throw new Error("分词标签不能嵌套"); groupStart = plain.length; }
    else if (tag === "<word/>") { if (groupStart == null) throw new Error("发现没有起始标签的 <word/>"); if (plain.length > groupStart) tokenGroups.push({ start:groupStart, end:plain.length }); groupStart = undefined; }
    cursor = match.index + tag.length;
  }
  append(markup.slice(cursor));
  if (delay != null) throw new Error("缺少 <wt/>");
  if (groupStart != null) throw new Error("缺少 <word/>");
  const tokenDelays: Record<number, number> = {}; let offset = 0;
  for (const token of segmentStoryText(plain, tokenGroups)) {
    const end = offset + token.text.length; const range = ranges.find((item) => offset < item.end && end > item.start);
    if (range) tokenDelays[token.index] = range.delay; offset = end;
  }
  return { text: plain, tokenDelays, tokenGroups };
}

export function serializeStoryScript(archive: StoryArchive): string {
  const { document } = archive; const lines = ["<!-- Lorana Tales Story Language 1 -->", `<story title="${quote(document.title)}">`, ""];
  for (const key of settingKeys) lines.push(`<set name="${key}" value="${quote(formatSetting(document.settings[key]))}">`);
  lines.push("");
  for (const character of document.characters) lines.push(`<role id="${quote(character.id)}" name="${quote(character.name)}" qq="${quote(character.imUserId)}" side="${character.position}" color="${quote(character.color)}" palette="${quote(character.paletteId || "")}" bubble="${quote(character.bubblePaletteId || "")}" avatar="${quote(character.avatar?.id || "")}" narrator-avatar="${character.narratorAvatar ? "on" : "off"}" narrator="${character.isNarrator ? "on" : "off"}" dice="${character.isDice ? "on" : "off"}" hidden="${character.hidden ? "on" : "off"}">`);
  lines.push("");
  for (const track of document.effectTracks) lines.push(`<effect id="${quote(track.id)}" type="${track.effect}" from="${quote(track.startMessageId)}" to="${quote(track.endMessageId)}">`);
  lines.push("");
  for (const message of document.messages) {
    const performance = message.performance; const attrs = [`by="${quote(message.characterId)}"`, `id="${quote(message.id)}"`, `at="${message.time || 0}"`, `kind="${message.kind}"`];
    if (message.replyToId) attrs.push(`reply="${quote(message.replyToId)}"`);
    if (performance?.stream != null) attrs.push(`stream="${performance.stream ? "on" : "off"}"`);
    if (performance?.tokenAnimation) attrs.push(`text-animation="${performance.tokenAnimation}"`);
    if (performance?.screenEffect && performance.screenEffect !== "none") attrs.push(`screen="${performance.screenEffect}"`);
    if (performance?.interaction) attrs.push(`interact="${performance.interaction.effect}"`, `target="${quote(performance.interaction.targetCharacterId)}"`, `emoji="${quote(performance.interaction.emoji || "")}"`);
		if (message.kind !== "text") { attrs.push(`asset="${quote(message.asset.id)}"`, `mime="${quote(message.asset.mime)}"`); if (message.asset.sourceUrl) attrs.push(`url="${quote(message.asset.sourceUrl)}"`); if (message.asset.external) attrs.push('external="on"'); }
    if (message.kind === "image" && performance?.imagePreview) attrs.push(`view="${performance.imagePreview.openAfterMs}ms/${performance.imagePreview.durationMs}ms"`);
    if (message.kind === "audio" && performance?.audioPlayback) attrs.push(`play="${performance.audioPlayback.maxDurationMs}ms"`);
    if (message.replyToId && performance?.replyPreview) attrs.push(`visit-reply="${performance.replyPreview.durationMs}ms"`);
    lines.push(`<msg ${attrs.join(" ")}>`);
    if (performance?.durationMs != null) lines.push(`<time:${Math.max(0, Math.round(performance.durationMs))}ms>`);
		lines.push(message.kind === "text" ? serializeTimedText(message) : textEscape(message.kind === "audio" ? message.caption || "" : message.alt || message.asset.name || "图片"), "<msg/>", "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function parseStoryScript(script: string, base: StoryArchive): StoryArchive {
  const lines = script.replace(/\r\n?/g, "\n").split("\n"); const document = structuredClone(base.document); document.characters = []; document.messages = []; document.effectTracks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim(); if (!line || line.startsWith("<!--")) continue;
    if (line.startsWith("<story ")) { document.title = tagAttributes(line).get("title")?.trim() || "跑团记录"; continue; }
    if (line.startsWith("<set ")) { const values = tagAttributes(line); const key = values.get("name") as keyof StorySettings; if (!settingKeys.has(key)) throw new Error(`第 ${index + 1} 行：未知设置 ${key || ""}`); try { (document.settings as unknown as Record<string, unknown>)[key] = parseSetting(values.get("value") || "", document.settings[key]); } catch (error) { throw new Error(`第 ${index + 1} 行：${error instanceof Error ? error.message : "设置无效"}`); } continue; }
    if (line.startsWith("<role ")) { const value = tagAttributes(line); const id = value.get("id") || ""; const name = value.get("name") || ""; const side = value.get("side") || "left"; if (!id || !name) throw new Error(`第 ${index + 1} 行：角色缺少 id 或 name`); if (!["left", "right", "narrator"].includes(side)) throw new Error(`第 ${index + 1} 行：side 只能是 left、right 或 narrator`); const palette=value.get("palette")||"";const bubble=value.get("bubble")||"";if(palette&&!storyPalette(palette))throw new Error(`第 ${index + 1} 行：未知 palette ${palette}`);if(bubble&&!storyPalette(bubble))throw new Error(`第 ${index + 1} 行：未知 bubble ${bubble}`);const avatar = value.get("avatar") || ""; const on = (key:string) => ["on","true","1"].includes((value.get(key)||"").toLowerCase()); document.characters.push({ id, name, imUserId:value.get("qq")||"", position:side as StoryCharacter["position"], color:value.get("color")||"#9ca3af", paletteId:palette||undefined, bubblePaletteId:bubble||undefined, ...(avatar?{avatar:{id:avatar,mime:"image/*"},avatarSource:"package" as const}:{}), narratorAvatar:on("narrator-avatar"), isNarrator:on("narrator"), isDice:on("dice"), hidden:on("hidden") }); continue; }
    if (line.startsWith("<effect ")) { const value = tagAttributes(line); const effect = value.get("type") as StoryPersistentEffect; const startMessageId = value.get("from") || ""; const endMessageId = value.get("to") || ""; if (!persistentEffects.has(effect)) throw new Error(`第 ${index + 1} 行：未知持续效果 ${effect || ""}`); if (!startMessageId || !endMessageId) throw new Error(`第 ${index + 1} 行：持续效果缺少 from 或 to`); document.effectTracks.push({ id:value.get("id")||createStoryId("effect"), effect, startMessageId, endMessageId }); continue; }
    if (line.startsWith("<msg ")) {
      const value = tagAttributes(line); const characterId = value.get("by") || ""; if (!document.characters.some((item)=>item.id===characterId)) throw new Error(`第 ${index + 1} 行：消息引用了不存在的角色 ${characterId}`);
      const body: string[] = []; let durationMs: number | undefined; let ended = false;
      while (++index < lines.length) { const bodyLine = lines[index]; if (bodyLine.trim() === "<msg/>") { ended = true; break; } const timeMatch = bodyLine.trim().match(/^<time:(\d+(?:\.\d+)?)ms>$/); if (timeMatch) { durationMs = Math.round(Number(timeMatch[1])); continue; } body.push(bodyLine); }
      if (!ended) throw new Error(`消息 ${value.get("id") || characterId} 缺少 <msg/>`);
		const kind = value.get("kind") === "image" ? "image" : value.get("kind") === "audio" ? "audio" : "text"; const streamValue = value.get("stream"); const tokenAnimation = value.get("text-animation") as StoryStreamTokenAnimation | undefined; const screenEffect = value.get("screen") as StoryScreenEffect | undefined; const interactionEffect = value.get("interact") as StoryInteractionEffect | undefined; const interactionTarget = value.get("target") || ""; if (tokenAnimation && !tokenAnimations.has(tokenAnimation)) throw new Error(`第 ${index + 1} 行：未知文字动画 ${tokenAnimation}`); if (screenEffect && !screenEffects.has(screenEffect)) throw new Error(`第 ${index + 1} 行：未知屏幕效果 ${screenEffect}`); if (interactionEffect && !interactionEffects.has(interactionEffect)) throw new Error(`第 ${index + 1} 行：未知角色互动 ${interactionEffect}`); if (interactionEffect && !document.characters.some((item) => item.id === interactionTarget)) throw new Error(`第 ${index + 1} 行：角色互动目标不存在 ${interactionTarget || "（空）"}`); const timed = parseTimedText(body.join("\n")); const performance = { ...(durationMs != null ? { durationMs } : {}), ...(streamValue ? { stream:["on","true","1"].includes(streamValue) } : {}), ...(tokenAnimation ? { tokenAnimation } : {}), ...(screenEffect && screenEffect !== "none" ? { screenEffect } : {}), ...(interactionEffect ? { interaction:{ effect:interactionEffect, targetCharacterId:interactionTarget, emoji:value.get("emoji")||undefined } } : {}), ...(Object.keys(timed.tokenDelays).length ? { tokenDelays:timed.tokenDelays } : {}), ...(timed.tokenGroups.length ? { tokenGroups:timed.tokenGroups } : {}) };
		const reply=value.get("reply")||"";const play=(value.get("play")||"").match(/^(\d+)ms$/);const visitReply=(value.get("visit-reply")||"").match(/^(\d+)ms$/);if(play)(performance as Record<string,unknown>).audioPlayback={maxDurationMs:Number(play[1])};if(visitReply){if(!reply)throw new Error(`第 ${index + 1} 行：visit-reply 只能用于带 reply 的消息`);(performance as Record<string,unknown>).replyPreview={durationMs:Number(visitReply[1])}}const common = { id:value.get("id")||createStoryId("message"), characterId, time:Number(value.get("at"))||Date.now(), locallyInserted:true, replyToId:reply||undefined };
			if (kind !== "text") { const asset=value.get("asset")||""; if(!asset)throw new Error(`${kind==='audio'?'语音':'图片'}消息 ${common.id} 缺少 asset`); const view=(value.get("view")||"").match(/^(\d+)ms\/(\d+)ms$/); if(kind==='image'&&view)(performance as Record<string,unknown>).imagePreview={openAfterMs:Number(view[1]),durationMs:Number(view[2])}; const assetRef={id:asset,mime:value.get("mime")||(kind==='audio'?"audio/*":"image/*"),sourceUrl:value.get("url")||undefined,external:["on","true","1"].includes((value.get("external")||"").toLowerCase())}; document.messages.push(kind==='audio'?{ ...common, performance:Object.keys(performance).length?performance:undefined, kind, asset:assetRef, alt:"语音", caption:timed.text||undefined }:{ ...common, performance:Object.keys(performance).length?performance:undefined, kind, asset:assetRef, alt:timed.text }); } else document.messages.push({ ...common, performance:Object.keys(performance).length?performance:undefined, kind:"text", text:timed.text });
      continue;
    }
    throw new Error(`第 ${index + 1} 行：无法识别“${line.slice(0, 48)}”`);
  }
  if (!document.characters.length) throw new Error("至少需要一个 <role> 角色"); document.updatedAt = new Date().toISOString(); return { document:normalizeStoryDocument(document), assets:new Map(base.assets) };
}

export const STORY_SCRIPT_HELP = `<!-- Lorana Tales Story Language 1 -->
<story title="我的故事">

<role id="alice" name="爱丽丝" qq="12345678" side="left" palette="ocean" bubble="ocean" avatar="">
<role id="narrator" name="旁白" side="narrator" color="#9ca3af" narrator="on">

<msg by="alice" stream="on">
<time:2000ms>
<wt:100ms>你好<wt/>，欢迎回来。
<msg/>

<msg by="alice" kind="image" asset="asset-123" mime="image/webp" view="0ms/3000ms">
图片说明
<msg/>

<msg by="alice" kind="audio" asset="voice-1" mime="audio/ogg">
语音
<msg/>

标签说明：
• <time:2000ms>：消息完整出现后停留 2 秒。
• <wt:100ms>文本<wt/>：在全局智能延迟上，每词额外增加 100ms。
• <wt:-50ms>文本<wt/>：在全局智能延迟上，每词减少 50ms；最终延迟不会低于 0。
• <word>自定义词组<word/>：把标签内文本视为一个完整词；GUI 分词选择器会自动写入该标签。
• stream="on"：本条启用流式输出；省略则跟随全局设置。
• text-animation="impact"：本条使用重击落字；还支持 fade、rise、blur、shake、ghost、none。
• screen="damage"：消息出现时触发一次受伤红闪；也支持震屏、辉光、闪烁、心跳和黑场等内置效果。
• interact="throw" target="角色 id" emoji="🪨"：让发言角色向目标角色投掷符号；也支持 heart、magic、surprise、impact。
• view="0ms/3000ms"：图片出现后打开并查看 3 秒；事件结束前不会推进演出。
• play="8000ms"：自动播放语音，播放结束或到达 8 秒上限后再继续。
• visit-reply="3000ms"：定位引用消息 3 秒，再返回当前消息后继续。
• <effect type="low-health" from="消息 id" to="消息 id">：在含首尾消息的区间持续显示残血红边。
• reply="消息 id"：引用另一条消息；图形编辑器里的“引用”会自动生成。
• side 可写 left、right、narrator；avatar 引用 SSP 包内资源。
• palette 和 bubble 只能使用编辑器内置的高对比预设名。
• <set name="streamSpeedJitterPercent" value="25"> 可修改全局设置。
• <set name="hideOffTopic" value="on"> 隐藏以 ( 或 （ 开头的场外发言，不删除原消息。
• <set name="hideDiceCommands" value="on"> 隐藏以 .、。或 / 开头的骰子指令，保留骰子结果。
• <set name="enterKeyBehavior" value="auto"> 编辑器回车按设备决定；也可写 send 或 newline。
• id 和 at 可省略；导出时自动写入稳定 id，以保留演出编排。`;

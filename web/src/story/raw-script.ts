import { createStoryId, normalizeStoryDocument, segmentStoryText } from "./model";
import { storyPalette } from "./palette";
import type { StoryArchive, StoryCharacter, StoryCharacterState, StoryEffectColor, StoryInteractionEffect, StoryInteractionReaction, StoryMessage, StoryPersistentEffect, StoryScreenEffect, StorySettings, StoryStreamTokenAnimation } from "./types";

const tokenAnimations = new Set<StoryStreamTokenAnimation>(["none", "fade", "rise", "blur", "impact", "shake", "ghost"]);
const screenEffects = new Set<StoryScreenEffect>(["none", "shake-light", "shake-heavy", "glow", "warm-glow", "cold-flash", "flash", "flicker", "damage", "heartbeat", "blackout", "dream", "vignette", "ripple", "curtain", "chromatic", "zoom-focus"]);
const interactionEffects = new Set<StoryInteractionEffect>(["throw", "heart", "magic", "surprise", "impact", "bullet", "blade"]);
const interactionReactions = new Set<StoryInteractionReaction>(["none", "bounce", "stagger", "faint", "shatter", "gray", "affection"]);
const characterStates = new Set<StoryCharacterState>(["normal", "gray", "injured", "frozen", "cursed", "out", "dead", "wasted"]);
const persistentEffects = new Set<StoryPersistentEffect>(["low-health", "curse", "dream-haze", "storm", "magic-aura"]);
const effectColors = new Set<StoryEffectColor>(["auto", "neutral", "red", "orange", "gold", "green", "cyan", "blue", "purple", "pink"]);

const settingKeys = new Set<keyof StorySettings>([
	"enabled", "mergeMessages", "mergeNarration", "showAvatars", "stickyGroupAvatar", "avatarAlignment", "showNarratorAvatar",
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
  const { document } = archive; const source=document.source;const storyAttrs=[`title="${quote(document.title)}"`,`id="${quote(document.id)}"`,`schema="${document.schemaVersion}"`,`created="${quote(document.createdAt)}"`,`updated="${quote(document.updatedAt)}"`,`source-kind="${source.kind}"`];if(source.key)storyAttrs.push(`source-key="${quote(source.key)}"`);if(source.revision)storyAttrs.push(`source-revision="${quote(source.revision)}"`);if(source.syncedAt)storyAttrs.push(`source-synced="${quote(source.syncedAt)}"`);if(source.name)storyAttrs.push(`source-name="${quote(source.name)}"`);const lines = ["<!-- Lorana Tales Story Language 2 -->", `<story ${storyAttrs.join(" ")}>`, ""];
  for (const key of settingKeys) lines.push(`<set name="${key}" value="${quote(formatSetting(document.settings[key]))}">`);
  lines.push("");
  for (const character of document.characters) lines.push(`<role id="${quote(character.id)}" name="${quote(character.name)}" qq="${quote(character.imUserId)}" side="${character.position}" color="${quote(character.color)}" palette="${quote(character.paletteId || "")}" bubble="${quote(character.bubblePaletteId || "")}" avatar="${quote(character.avatar?.id || "")}" avatar-source="${quote(character.avatarSource || "")}" narrator-avatar="${character.narratorAvatar ? "on" : "off"}" narrator="${character.isNarrator ? "on" : "off"}" dice="${character.isDice ? "on" : "off"}" hidden="${character.hidden ? "on" : "off"}">`);
  lines.push("");
  for (const track of document.effectTracks) lines.push(`<effect id="${quote(track.id)}" type="${track.effect}" color="${track.color || "auto"}" from="${quote(track.startMessageId)}" to="${quote(track.endMessageId)}">`);
  for (const event of document.characterStateEvents) lines.push(`<character-state id="${quote(event.id)}" character="${quote(event.characterId)}" state="${event.state}" after="${quote(event.afterMessageId)}" label="${quote(event.label || "")}">`);
  lines.push("");
  for (const message of document.messages) {
    const performance = message.performance; const attrs = [`by="${quote(message.characterId)}"`, `id="${quote(message.id)}"`, `at="${message.time || 0}"`, `kind="${message.kind}"`];
    if (message.replyToId) attrs.push(`reply="${quote(message.replyToId)}"`);
    if(message.timeText)attrs.push(`time-text="${quote(message.timeText)}"`);if(message.sourceFingerprint)attrs.push(`source-fingerprint="${quote(message.sourceFingerprint)}"`);if(message.sourcePartText)attrs.push(`source-part="${quote(message.sourcePartText)}"`);if(message.conflict)attrs.push(`conflict="${message.conflict}"`);if(message.locallyInserted)attrs.push('inserted="on"');
    if (performance?.stream != null) attrs.push(`stream="${performance.stream ? "on" : "off"}"`);
    if (performance?.typingDurationMs != null) attrs.push(`typing="${Math.max(0,Math.round(performance.typingDurationMs))}ms"`);
    if (performance?.tokenAnimation) attrs.push(`text-animation="${performance.tokenAnimation}"`);
    if (performance?.screenEffect && performance.screenEffect !== "none") attrs.push(`screen="${performance.screenEffect}"`);
    if (performance?.screenEffect && performance.screenEffect !== "none") attrs.push(`screen-color="${performance.screenEffectColor || "auto"}"`);
    if (performance?.screenEffect && performance.screenEffect !== "none") attrs.push(`screen-duration="${Math.max(120,Math.round(performance.screenEffectDurationMs||900))}ms"`, `screen-speed="${Math.max(25,Math.round(performance.screenEffectSpeedPercent||100))}%"`, `screen-repeat="${Math.max(1,Math.round(performance.screenEffectRepeat||1))}"`);
    if (performance?.interaction) attrs.push(`interact="${performance.interaction.effect}"`, `target="${quote(performance.interaction.targetCharacterId)}"`, `emoji="${quote(performance.interaction.emoji || "")}"`, `reaction="${performance.interaction.reaction || "stagger"}"`);
		if (message.kind !== "text") { attrs.push(`asset="${quote(message.asset.id)}"`, `mime="${quote(message.asset.mime)}"`); if (message.asset.sourceUrl) attrs.push(`url="${quote(message.asset.sourceUrl)}"`); if (message.asset.external) attrs.push('external="on"'); }
    if(message.kind==="audio"&&message.durationMs!=null)attrs.push(`media-duration="${Math.max(0,Math.round(message.durationMs))}ms"`);
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
  const lines = script.replace(/\r\n?/g, "\n").split("\n"); const document = structuredClone(base.document); document.characters = []; document.messages = []; document.effectTracks = []; document.characterStateEvents = []; let declaredUpdatedAt = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim(); if (!line || line.startsWith("<!--")) continue;
    if (line.startsWith("<story ")) { const value=tagAttributes(line);document.title=value.get("title")?.trim()||"跑团记录";document.id=value.get("id")||document.id;const schema=Number(value.get("schema"));if(Number.isSafeInteger(schema)&&schema>0)document.schemaVersion=schema;document.createdAt=value.get("created")||document.createdAt;declaredUpdatedAt=value.get("updated")||"";document.updatedAt=declaredUpdatedAt||document.updatedAt;const sourceKind=value.get("source-kind");if(sourceKind&&!["remote-log","file","none"].includes(sourceKind))throw new Error(`第 ${index + 1} 行：未知 source-kind`);document.source={kind:(sourceKind||document.source.kind) as typeof document.source.kind,key:value.get("source-key")||undefined,revision:value.get("source-revision")||undefined,syncedAt:value.get("source-synced")||undefined,name:value.get("source-name")||undefined};continue; }
    if (line.startsWith("<set ")) { const values = tagAttributes(line); const key = values.get("name") as keyof StorySettings; if (!settingKeys.has(key)) throw new Error(`第 ${index + 1} 行：未知设置 ${key || ""}`); try { (document.settings as unknown as Record<string, unknown>)[key] = parseSetting(values.get("value") || "", document.settings[key]); } catch (error) { throw new Error(`第 ${index + 1} 行：${error instanceof Error ? error.message : "设置无效"}`); } continue; }
    if (line.startsWith("<role ")) { const value = tagAttributes(line); const id = value.get("id") || ""; const name = value.get("name") || ""; const side = value.get("side") || "left"; if (!id || !name) throw new Error(`第 ${index + 1} 行：角色缺少 id 或 name`); if (!["left", "right", "narrator"].includes(side)) throw new Error(`第 ${index + 1} 行：side 只能是 left、right 或 narrator`); const palette=value.get("palette")||"";const bubble=value.get("bubble")||"";if(palette&&!storyPalette(palette))throw new Error(`第 ${index + 1} 行：未知 palette ${palette}`);if(bubble&&!storyPalette(bubble))throw new Error(`第 ${index + 1} 行：未知 bubble ${bubble}`);const avatar = value.get("avatar") || "";const avatarSource=value.get("avatar-source");if(avatarSource&&!['qq','discord','kook','upload','package'].includes(avatarSource))throw new Error(`第 ${index + 1} 行：未知 avatar-source`); const on = (key:string) => ["on","true","1"].includes((value.get(key)||"").toLowerCase()); document.characters.push({ id, name, imUserId:value.get("qq")||"", position:side as StoryCharacter["position"], color:value.get("color")||"#9ca3af", paletteId:palette||undefined, bubblePaletteId:bubble||undefined, ...(avatar?{avatar:{id:avatar,mime:"image/*"},avatarSource:(avatarSource||"package") as StoryCharacter['avatarSource']}:{}), narratorAvatar:on("narrator-avatar"), isNarrator:on("narrator"), isDice:on("dice"), hidden:on("hidden") }); continue; }
    if (line.startsWith("<effect ")) { const value = tagAttributes(line); const effect = value.get("type") as StoryPersistentEffect; const color = (value.get("color") || "auto") as StoryEffectColor; const startMessageId = value.get("from") || ""; const endMessageId = value.get("to") || ""; if (!persistentEffects.has(effect)) throw new Error(`第 ${index + 1} 行：未知持续效果 ${effect || ""}`); if (!effectColors.has(color)) throw new Error(`第 ${index + 1} 行：未知特效颜色 ${color}`); if (!startMessageId || !endMessageId) throw new Error(`第 ${index + 1} 行：持续效果缺少 from 或 to`); document.effectTracks.push({ id:value.get("id")||createStoryId("effect"), effect, color, startMessageId, endMessageId }); continue; }
    if (line.startsWith("<character-state ")) { const value=tagAttributes(line);const characterId=value.get("character")||"",state=value.get("state") as StoryCharacterState,afterMessageId=value.get("after")||"";if(!document.characters.some((item)=>item.id===characterId))throw new Error(`第 ${index + 1} 行：角色状态引用了不存在的角色`);if(!characterStates.has(state))throw new Error(`第 ${index + 1} 行：未知角色状态 ${state||""}`);if(!afterMessageId)throw new Error(`第 ${index + 1} 行：角色状态缺少 after`);document.characterStateEvents.push({id:value.get("id")||createStoryId("state"),characterId,state,afterMessageId,label:value.get("label")||undefined});continue; }
    if (line.startsWith("<msg ")) {
      const value = tagAttributes(line); const characterId = value.get("by") || ""; if (!document.characters.some((item)=>item.id===characterId)) throw new Error(`第 ${index + 1} 行：消息引用了不存在的角色 ${characterId}`);
      const body: string[] = []; let durationMs: number | undefined; let ended = false;
      while (++index < lines.length) { const bodyLine = lines[index]; if (bodyLine.trim() === "<msg/>") { ended = true; break; } const timeMatch = bodyLine.trim().match(/^<time:(\d+(?:\.\d+)?)ms>$/); if (timeMatch) { durationMs = Math.round(Number(timeMatch[1])); continue; } body.push(bodyLine); }
      if (!ended) throw new Error(`消息 ${value.get("id") || characterId} 缺少 <msg/>`);
		const kind = value.get("kind") === "image" ? "image" : value.get("kind") === "audio" ? "audio" : "text"; const streamValue = value.get("stream"); const tokenAnimation = value.get("text-animation") as StoryStreamTokenAnimation | undefined; const screenEffect = value.get("screen") as StoryScreenEffect | undefined; const screenEffectColor = (value.get("screen-color") || "auto") as StoryEffectColor;const screenDuration=Math.max(120,Number((value.get("screen-duration")||"900ms").replace(/ms$/,""))||900);const screenSpeed=Math.max(25,Number((value.get("screen-speed")||"100%").replace(/%$/,""))||100);const screenRepeat=Math.max(1,Math.min(12,Number(value.get("screen-repeat"))||1)); const interactionEffect = value.get("interact") as StoryInteractionEffect | undefined; const interactionTarget = value.get("target") || "";const interactionReaction=(value.get("reaction")||"stagger") as StoryInteractionReaction;if (tokenAnimation && !tokenAnimations.has(tokenAnimation)) throw new Error(`第 ${index + 1} 行：未知文字动画 ${tokenAnimation}`); if (screenEffect && !screenEffects.has(screenEffect)) throw new Error(`第 ${index + 1} 行：未知屏幕效果 ${screenEffect}`); if (screenEffect && !effectColors.has(screenEffectColor)) throw new Error(`第 ${index + 1} 行：未知特效颜色 ${screenEffectColor}`); if (interactionEffect && !interactionEffects.has(interactionEffect)) throw new Error(`第 ${index + 1} 行：未知角色互动 ${interactionEffect}`);if(interactionEffect&&!interactionReactions.has(interactionReaction))throw new Error(`第 ${index + 1} 行：未知互动反应 ${interactionReaction}`); if (interactionEffect && !document.characters.some((item) => item.id === interactionTarget)) throw new Error(`第 ${index + 1} 行：角色互动目标不存在 ${interactionTarget || "（空）"}`); const timed = parseTimedText(body.join("\n")); const performance = { ...(durationMs != null ? { durationMs } : {}), ...(streamValue ? { stream:["on","true","1"].includes(streamValue) } : {}), ...(tokenAnimation ? { tokenAnimation } : {}), ...(screenEffect && screenEffect !== "none" ? { screenEffect, screenEffectColor,screenEffectDurationMs:screenDuration,screenEffectSpeedPercent:screenSpeed,screenEffectRepeat:screenRepeat } : {}), ...(interactionEffect ? { interaction:{ effect:interactionEffect, targetCharacterId:interactionTarget, emoji:value.get("emoji")||undefined,reaction:interactionReaction } } : {}), ...(Object.keys(timed.tokenDelays).length ? { tokenDelays:timed.tokenDelays } : {}), ...(timed.tokenGroups.length ? { tokenGroups:timed.tokenGroups } : {}) };
		const reply=value.get("reply")||"";const play=(value.get("play")||"").match(/^(\d+)ms$/);const visitReply=(value.get("visit-reply")||"").match(/^(\d+)ms$/);if(play)(performance as Record<string,unknown>).audioPlayback={maxDurationMs:Number(play[1])};if(visitReply){if(!reply)throw new Error(`第 ${index + 1} 行：visit-reply 只能用于带 reply 的消息`);(performance as Record<string,unknown>).replyPreview={durationMs:Number(visitReply[1])}}const conflict=value.get("conflict");if(conflict&&conflict!=="source-changed"&&conflict!=="source-deleted")throw new Error(`第 ${index + 1} 行：未知 conflict`);const common = { id:value.get("id")||createStoryId("message"), characterId, time:Number(value.get("at"))||Date.now(),timeText:value.get("time-text")||undefined,sourceFingerprint:value.get("source-fingerprint")||undefined,sourcePartText:value.get("source-part")||undefined,locallyInserted:["on","true","1"].includes((value.get("inserted")||"").toLowerCase()),conflict:conflict as "source-changed"|"source-deleted"|undefined, replyToId:reply||undefined };
			if (kind !== "text") { const asset=value.get("asset")||""; if(!asset)throw new Error(`${kind==='audio'?'语音':'图片'}消息 ${common.id} 缺少 asset`);const url=value.get("url")||"";if(url&&!/^https?:\/\//i.test(url)&&!url.startsWith('/'))throw new Error(`消息 ${common.id} 的资源 URL 只允许 HTTP(S) 或站内路径`); const view=(value.get("view")||"").match(/^(\d+)ms\/(\d+)ms$/); if(kind==='image'&&view)(performance as Record<string,unknown>).imagePreview={openAfterMs:Number(view[1]),durationMs:Number(view[2])}; const assetRef={id:asset,mime:value.get("mime")||(kind==='audio'?"audio/*":"image/*"),sourceUrl:url||undefined,external:["on","true","1"].includes((value.get("external")||"").toLowerCase())};const mediaDuration=(value.get("media-duration")||"").match(/^(\d+)ms$/); document.messages.push(kind==='audio'?{ ...common, performance:Object.keys(performance).length?performance:undefined, kind, asset:assetRef, alt:"语音",durationMs:mediaDuration?Number(mediaDuration[1]):undefined, caption:timed.text||undefined }:{ ...common, performance:Object.keys(performance).length?performance:undefined, kind, asset:assetRef, alt:timed.text }); } else document.messages.push({ ...common, performance:Object.keys(performance).length?performance:undefined, kind:"text", text:timed.text });
      continue;
    }
    throw new Error(`第 ${index + 1} 行：无法识别“${line.slice(0, 48)}”`);
  }
  for (const match of script.matchAll(/<msg\s+([^>]*\btyping="\d+ms"[^>]*)>/g)) {
    const value=tagAttributes(match[0]);const id=value.get("id")||"";const duration=(value.get("typing")||"").match(/^(\d+)ms$/);const message=document.messages.find(item=>item.id===id);
    if(message&&duration)message.performance={...(message.performance||{}),typingDurationMs:Number(duration[1])};
  }
  if (!document.characters.length) throw new Error("至少需要一个 <role> 角色"); document.updatedAt = declaredUpdatedAt || new Date().toISOString(); return { document:normalizeStoryDocument(document), assets:new Map(base.assets) };
}

export const STORY_SCRIPT_HELP = `<!-- Lorana Tales Story Language 2 -->
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
• screen="damage" screen-color="red" screen-duration="900ms" screen-speed="100%" screen-repeat="1"：屏幕形态、预制色和节奏彼此独立。
• interact="throw" target="角色 id" emoji="🪨" reaction="stagger"：让双方头像在独立动画层互动；还支持 heart、magic、surprise、impact、bullet、blade。
• reaction 可写 none、bounce、stagger、faint、shatter、gray、affection，分别表示不回应、跳起、踉跄、晕倒、碎裂、灰化和贴近回应。
• <character-state character="角色 id" state="dead" after="消息 id" label="阵亡">：从该消息之后持续改变角色状态，后续用 state="normal" 恢复；还支持 gray、injured、frozen、cursed、out、wasted。
• view="0ms/3000ms"：图片出现后打开并查看 3 秒；事件结束前不会推进演出。
• play="8000ms"：自动播放语音，播放结束或到达 8 秒上限后再继续。
• visit-reply="3000ms"：定位引用消息 3 秒，再返回当前消息后继续。
• <effect type="low-health" color="red" from="消息 id" to="消息 id">：在含首尾消息的区间持续显示边缘警戒效果。
• reply="消息 id"：引用另一条消息；图形编辑器里的“引用”会自动生成。
• side 可写 left、right、narrator；avatar 引用 SSP 包内资源。
• palette 和 bubble 只能使用编辑器内置的高对比预设名。
• <set name="streamSpeedJitterPercent" value="25"> 可修改全局设置。
• <set name="hideOffTopic" value="on"> 隐藏以 ( 或 （ 开头的场外发言，不删除原消息。
• <set name="hideDiceCommands" value="on"> 隐藏以 .、。或 / 开头的骰子指令，保留骰子结果。
• <set name="enterKeyBehavior" value="auto"> 编辑器回车按设备决定；也可写 send 或 newline。
• id 和 at 可省略；导出时自动写入稳定 id，以保留演出编排。`;

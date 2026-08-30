import { createStoryId, normalizeStoryDocument, segmentStoryText } from "./model";
import { messageEffectSegments } from "./message-effects";
import { storyPalette } from "./palette";
import type { StoryArchive, StoryCharacter, StoryCharacterState, StoryEffectColor, StoryEffectTrack, StoryInteractionEffect, StoryInteractionReaction, StoryMessage, StoryMessageEffectSegment, StoryPersistentEffect, StoryScreenEffect, StorySettings, StoryStreamTokenAnimation } from "./types";

const tokenAnimations = new Set<StoryStreamTokenAnimation>(["none", "fade", "rise", "blur", "impact", "shake", "ghost"]);
const screenEffects = new Set<StoryScreenEffect>(["none", "shake-light", "shake-heavy", "glow", "warm-glow", "cold-flash", "flash", "flicker", "damage", "heartbeat", "blackout", "dream", "vignette", "ripple", "curtain", "chromatic", "zoom-focus"]);
const interactionEffects = new Set<StoryInteractionEffect>(["throw", "heart", "magic", "magic-circle", "surprise", "impact", "bullet", "blade"]);
const interactionReactions = new Set<StoryInteractionReaction>(["none", "bounce", "stagger", "faint", "shatter", "gray", "affection"]);
const characterStates = new Set<StoryCharacterState>(["normal", "gray", "injured", "frozen", "cursed", "out", "dead", "wasted"]);
const persistentEffects = new Set<StoryPersistentEffect>(["low-health", "curse", "dream-haze", "storm", "magic-aura", "rain-glass", "blood-stain", "snowfall", "underwater", "film-grain"]);
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

function serializeMessageEffect(segment: StoryMessageEffectSegment) {
  const attrs = [`id="${quote(segment.id)}"`, `delay="${Math.max(0, Math.round(segment.delayMs || 0))}ms"`];
  if (segment.textAnimation) attrs.push(`text="${segment.textAnimation}"`);
  if (segment.screen) attrs.push(`screen="${segment.screen.effect}"`, `screen-color="${segment.screen.color || "auto"}"`, `screen-duration="${Math.max(120, Math.round(segment.screen.durationMs || 900))}ms"`, `screen-speed="${Math.max(25, Math.min(400, Math.round(segment.screen.speedPercent || 100)))}%"`, `screen-repeat="${Math.max(1, Math.min(12, Math.round(segment.screen.repeat || 1)))}"`);
  if (segment.interaction) { attrs.push(`interact="${segment.interaction.effect}"`); if(segment.interaction.targetCharacterId)attrs.push(`target="${quote(segment.interaction.targetCharacterId)}"`); attrs.push(`emoji="${quote(segment.interaction.emoji || "")}"`, `reaction="${segment.interaction.reaction || "stagger"}"`, `interaction-color="${segment.interaction.color || "auto"}"`, `interaction-speed="${Math.max(25, Math.min(400, Math.round(segment.interaction.speedPercent || 100)))}%"`); }
  return `<effect ${attrs.join(" ")} />`;
}

function parseMessageEffect(line: string, lineNumber: number, characters: StoryCharacter[]): StoryMessageEffectSegment {
  const value = tagAttributes(line); const textAnimation=value.get("text") as StoryStreamTokenAnimation|undefined;const screenEffect=value.get("screen") as StoryScreenEffect|undefined;const screenColor=(value.get("screen-color")||"auto") as StoryEffectColor;const interactionEffect=value.get("interact") as StoryInteractionEffect|undefined;const interactionColor=(value.get("interaction-color")||"auto") as StoryEffectColor;const reaction=(value.get("reaction")||"stagger") as StoryInteractionReaction;const target=value.get("target")||"";
  if(textAnimation&&!tokenAnimations.has(textAnimation))throw new Error(`第 ${lineNumber} 行：未知文字动画 ${textAnimation}`);if(screenEffect&&(screenEffect==="none"||!screenEffects.has(screenEffect)))throw new Error(`第 ${lineNumber} 行：未知屏幕效果 ${screenEffect}`);if(screenEffect&&!effectColors.has(screenColor))throw new Error(`第 ${lineNumber} 行：未知特效颜色 ${screenColor}`);if(interactionEffect&&!interactionEffects.has(interactionEffect))throw new Error(`第 ${lineNumber} 行：未知角色互动 ${interactionEffect}`);if(interactionEffect&&!interactionReactions.has(reaction))throw new Error(`第 ${lineNumber} 行：未知互动反应 ${reaction}`);if(interactionEffect&&!effectColors.has(interactionColor))throw new Error(`第 ${lineNumber} 行：未知互动颜色 ${interactionColor}`);if(interactionEffect&&target&&!characters.some(item=>item.id===target))throw new Error(`第 ${lineNumber} 行：角色互动目标不存在 ${target}`);if(!textAnimation&&!screenEffect&&!interactionEffect)throw new Error(`第 ${lineNumber} 行：effect 至少需要文字、屏幕或互动中的一项`);
  return {id:value.get("id")||createStoryId("message-effect"),delayMs:Math.max(0,Math.min(120_000,Number((value.get("delay")||"0ms").replace(/ms$/, ""))||0)),...(textAnimation?{textAnimation}:{}),...(screenEffect?{screen:{effect:screenEffect as Exclude<StoryScreenEffect,"none">,color:screenColor,durationMs:Math.max(120,Number((value.get("screen-duration")||"900ms").replace(/ms$/, ""))||900),speedPercent:Math.max(25,Math.min(400,Number((value.get("screen-speed")||"100%").replace(/%$/, ""))||100)),repeat:Math.max(1,Math.min(12,Number(value.get("screen-repeat"))||1))}}:{}),...(interactionEffect?{interaction:{effect:interactionEffect,...(target?{targetCharacterId:target}:{}),emoji:value.get("emoji")||undefined,reaction,color:interactionColor,speedPercent:Math.max(25,Math.min(400,Number((value.get("interaction-speed")||"100%").replace(/%$/, ""))||100))}}:{})};
}

export function serializeStoryScript(archive: StoryArchive, options: { includeIdentity?: boolean } = {}): string {
  const { document } = archive; const source=document.source;const storyAttrs=[...(options.includeIdentity===false?[]:[`title="${quote(document.title)}"`,`author="${quote(document.author || "")}"`]),`id="${quote(document.id)}"`,`schema="${document.schemaVersion}"`,`created="${quote(document.createdAt)}"`,`updated="${quote(document.updatedAt)}"`,`source-kind="${source.kind}"`];if(source.key)storyAttrs.push(`source-key="${quote(source.key)}"`);if(source.revision)storyAttrs.push(`source-revision="${quote(source.revision)}"`);if(source.syncedAt)storyAttrs.push(`source-synced="${quote(source.syncedAt)}"`);if(source.name)storyAttrs.push(`source-name="${quote(source.name)}"`);const lines = ["<!-- Lorana Tales Story Language 2 -->", `<story ${storyAttrs.join(" ")}>`, "  <settings>"];
  for (const key of settingKeys) lines.push(`    <set name="${key}" value="${quote(formatSetting(document.settings[key]))}" />`);
  lines.push("  </settings>","", "  <roles>");
  for (const character of document.characters) lines.push(`    <role id="${quote(character.id)}" name="${quote(character.name)}" qq="${quote(character.imUserId)}" side="${character.position}" color="${quote(character.color)}" palette="${quote(character.paletteId || "")}" bubble="${quote(character.bubblePaletteId || "")}" avatar="${quote(character.avatar?.id || "")}" avatar-source="${quote(character.avatarSource || "")}" narrator-avatar="${character.narratorAvatar ? "on" : "off"}" narrator="${character.isNarrator ? "on" : "off"}" dice="${character.isDice ? "on" : "off"}" hidden="${character.hidden ? "on" : "off"}" />`);
  lines.push("  </roles>","", "  <character-states>");
  for (const event of document.characterStateEvents) lines.push(`    <character-state id="${quote(event.id)}" character="${quote(event.characterId)}" state="${event.state}" after="${quote(event.afterMessageId)}" label="${quote(event.label || "")}" />`);
  lines.push("  </character-states>","", "  <messages>");
  const messageIndices = new Map(document.messages.map((message, index) => [message.id, index]));
  const starts = new Map<string, typeof document.effectTracks>(); const ends = new Map<string, typeof document.effectTracks>();
  for (const track of document.effectTracks) { const left=messageIndices.get(track.startMessageId),right=messageIndices.get(track.endMessageId);if(left==null||right==null)continue;const startId=document.messages[Math.min(left,right)].id,endId=document.messages[Math.max(left,right)].id;starts.set(startId,[...(starts.get(startId)||[]),track]);ends.set(endId,[...(ends.get(endId)||[]),track]); }
  for (const message of document.messages) {
    for (const track of starts.get(message.id) || []) lines.push(`    <effect-start id="${quote(track.id)}" type="${track.effect}" color="${track.color || "auto"}" intensity="${Math.max(10,Math.min(200,Math.round(track.intensityPercent || 100)))}%" opacity="${Math.max(5,Math.min(100,Math.round(track.opacityPercent || 100)))}%" speed="${Math.max(10,Math.min(400,Math.round(track.speedPercent || 100)))}%" />`);
    const performance = message.performance; const attrs = [`by="${quote(message.characterId)}"`, `id="${quote(message.id)}"`, `at="${message.time || 0}"`, `kind="${message.kind}"`];
    if (message.replyToId) attrs.push(`reply="${quote(message.replyToId)}"`);
    if(message.timeText)attrs.push(`time-text="${quote(message.timeText)}"`);if(message.sourceFingerprint)attrs.push(`source-fingerprint="${quote(message.sourceFingerprint)}"`);if(message.sourcePartText)attrs.push(`source-part="${quote(message.sourcePartText)}"`);if(message.conflict)attrs.push(`conflict="${message.conflict}"`);if(message.locallyInserted)attrs.push('inserted="on"');
    if (performance?.stream != null) attrs.push(`stream="${performance.stream ? "on" : "off"}"`);
    if (performance?.typingDurationMs != null) attrs.push(`typing="${Math.max(0,Math.round(performance.typingDurationMs))}ms"`);
		if (message.kind !== "text") { attrs.push(`asset="${quote(message.asset.id)}"`, `mime="${quote(message.asset.mime)}"`); if (message.asset.sourceUrl) attrs.push(`url="${quote(message.asset.sourceUrl)}"`); if (message.asset.external) attrs.push('external="on"'); }
    if(message.kind==="audio"&&message.durationMs!=null)attrs.push(`media-duration="${Math.max(0,Math.round(message.durationMs))}ms"`);
    if (message.kind === "image" && performance?.imagePreview) attrs.push(`view="${performance.imagePreview.openAfterMs}ms/${performance.imagePreview.durationMs}ms"`);
    if (message.kind === "audio" && performance?.audioPlayback) attrs.push(`play="${performance.audioPlayback.maxDurationMs}ms"`);
    if (message.replyToId && performance?.replyPreview) attrs.push(`visit-reply="${performance.replyPreview.durationMs}ms"`);
    const effects=messageEffectSegments(performance);const indent=effects.length?"      ":"    ";
    if(effects.length){lines.push("    <effects>");for(const segment of effects)lines.push(`      ${serializeMessageEffect(segment)}`)}
    lines.push(`${indent}<msg ${attrs.join(" ")}>`);
    if (performance?.durationMs != null) lines.push(`${indent}  <time duration="${Math.max(0, Math.round(performance.durationMs))}ms" />`);
		const body=message.kind === "text" ? serializeTimedText(message) : textEscape(message.kind === "audio" ? message.caption || "" : message.alt || message.asset.name || "图片");for(const bodyLine of body.split("\n"))lines.push(`${indent}  ${bodyLine}`);lines.push(`${indent}</msg>`);if(effects.length)lines.push("    </effects>");lines.push("");
    for (const track of ends.get(message.id) || []) lines.push(`    <effect-end id="${quote(track.id)}" />`, "");
  }
  lines.push("  </messages>","</story>");return lines.join("\n").trimEnd() + "\n";
}

export function parseStoryScript(script: string, base: StoryArchive): StoryArchive {
  const lines = script.replace(/\r\n?/g, "\n").split("\n"); const document = structuredClone(base.document); document.characters = []; document.messages = []; document.effectTracks = []; document.characterStateEvents = []; let declaredUpdatedAt = ""; let lastMessageId = "";let effectWrapperOpen=false;let effectWrapperHasMessage=false;let pendingMessageEffects:StoryMessageEffectSegment[]=[];
  type PendingEffect = Omit<StoryEffectTrack,"startMessageId"|"endMessageId">;
  let pendingEffectStarts: PendingEffect[] = []; const openEffects = new Map<string,PendingEffect & {startMessageId:string}>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim(); if (!line || line.startsWith("<!--")) continue;
    if(["<settings>","</settings>","<roles>","</roles>","<character-states>","</character-states>","<messages>","</messages>","</story>"].includes(line))continue;
    if(line==="<effects>"){if(effectWrapperOpen)throw new Error(`第 ${index+1} 行：effects 不能嵌套`);effectWrapperOpen=true;effectWrapperHasMessage=false;pendingMessageEffects=[];continue}
    if(line.startsWith("<effect ")){if(!effectWrapperOpen||effectWrapperHasMessage)throw new Error(`第 ${index+1} 行：消息特效必须写在 effects 内并位于 msg 前`);if(pendingMessageEffects.length>=5)throw new Error(`第 ${index+1} 行：单条消息最多叠加 5 段特效`);pendingMessageEffects.push(parseMessageEffect(line,index+1,document.characters));continue}
    if(line==="</effects>"){if(!effectWrapperOpen)throw new Error(`第 ${index+1} 行：发现没有起始标签的 </effects>`);if(!effectWrapperHasMessage)throw new Error(`第 ${index+1} 行：effects 内必须包含一条消息`);effectWrapperOpen=false;effectWrapperHasMessage=false;pendingMessageEffects=[];continue}
    if (line.startsWith("<story ")) { const value=tagAttributes(line);document.title=value.get("title")?.trim()||"跑团记录";document.author=(value.get("author")||"").trim().slice(0,120);document.id=value.get("id")||document.id;const schema=Number(value.get("schema"));if(Number.isSafeInteger(schema)&&schema>0)document.schemaVersion=schema;document.createdAt=value.get("created")||document.createdAt;declaredUpdatedAt=value.get("updated")||"";document.updatedAt=declaredUpdatedAt||document.updatedAt;const sourceKind=value.get("source-kind");if(sourceKind&&!["remote-log","file","none"].includes(sourceKind))throw new Error(`第 ${index + 1} 行：未知 source-kind`);document.source={kind:(sourceKind||document.source.kind) as typeof document.source.kind,key:value.get("source-key")||undefined,revision:value.get("source-revision")||undefined,syncedAt:value.get("source-synced")||undefined,name:value.get("source-name")||undefined};continue; }
    if (line.startsWith("<set ")) { const values = tagAttributes(line); const key = values.get("name") as keyof StorySettings; if (!settingKeys.has(key)) throw new Error(`第 ${index + 1} 行：未知设置 ${key || ""}`); try { (document.settings as unknown as Record<string, unknown>)[key] = parseSetting(values.get("value") || "", document.settings[key]); } catch (error) { throw new Error(`第 ${index + 1} 行：${error instanceof Error ? error.message : "设置无效"}`); } continue; }
    if (line.startsWith("<role ")) { const value = tagAttributes(line); const id = value.get("id") || ""; const name = value.get("name") || ""; const side = value.get("side") || "left"; if (!id || !name) throw new Error(`第 ${index + 1} 行：角色缺少 id 或 name`); if (!["left", "right", "narrator"].includes(side)) throw new Error(`第 ${index + 1} 行：side 只能是 left、right 或 narrator`); const palette=value.get("palette")||"";const bubble=value.get("bubble")||"";if(palette&&!storyPalette(palette))throw new Error(`第 ${index + 1} 行：未知 palette ${palette}`);if(bubble&&!storyPalette(bubble))throw new Error(`第 ${index + 1} 行：未知 bubble ${bubble}`);const avatar = value.get("avatar") || "";const avatarSource=value.get("avatar-source");if(avatarSource&&!['qq','discord','kook','upload','package'].includes(avatarSource))throw new Error(`第 ${index + 1} 行：未知 avatar-source`); const on = (key:string) => ["on","true","1"].includes((value.get(key)||"").toLowerCase()); document.characters.push({ id, name, imUserId:value.get("qq")||"", position:side as StoryCharacter["position"], color:value.get("color")||"#9ca3af", paletteId:palette||undefined, bubblePaletteId:bubble||undefined, ...(avatar?{avatar:{id:avatar,mime:"image/*"},avatarSource:(avatarSource||"package") as StoryCharacter['avatarSource']}:{}), narratorAvatar:on("narrator-avatar"), isNarrator:on("narrator"), isDice:on("dice"), hidden:on("hidden") }); continue; }
    if (line.startsWith("<effect-start ")) { const value=tagAttributes(line);const id=value.get("id")||createStoryId("effect"),effect=value.get("type") as StoryPersistentEffect,color=(value.get("color")||"auto") as StoryEffectColor;if(!persistentEffects.has(effect))throw new Error(`第 ${index+1} 行：未知持续效果 ${effect||""}`);if(!effectColors.has(color))throw new Error(`第 ${index+1} 行：未知特效颜色 ${color}`);if(openEffects.has(id)||pendingEffectStarts.some(item=>item.id===id))throw new Error(`第 ${index+1} 行：持续效果 ${id} 已经开始`);const percent=(key:string,fallback:number,min:number,max:number)=>Math.max(min,Math.min(max,Number((value.get(key)||`${fallback}%`).replace(/%$/,""))||fallback));pendingEffectStarts.push({id,effect,color,intensityPercent:percent("intensity",100,10,200),opacityPercent:percent("opacity",100,5,100),speedPercent:percent("speed",100,10,400)});continue; }
    if (line.startsWith("<effect-end ")) { const value=tagAttributes(line),id=value.get("id")||"",opened=openEffects.get(id);if(!id||!opened)throw new Error(`第 ${index+1} 行：持续效果结束标签没有对应的起始 ${id||"（空）"}`);if(!lastMessageId)throw new Error(`第 ${index+1} 行：持续效果结束前没有消息`);document.effectTracks.push({...opened,endMessageId:lastMessageId});openEffects.delete(id);continue; }
    if (line.startsWith("<character-state ")) { const value=tagAttributes(line);const characterId=value.get("character")||"",state=value.get("state") as StoryCharacterState,afterMessageId=value.get("after")||"";if(!document.characters.some((item)=>item.id===characterId))throw new Error(`第 ${index + 1} 行：角色状态引用了不存在的角色`);if(!characterStates.has(state))throw new Error(`第 ${index + 1} 行：未知角色状态 ${state||""}`);if(!afterMessageId)throw new Error(`第 ${index + 1} 行：角色状态缺少 after`);document.characterStateEvents.push({id:value.get("id")||createStoryId("state"),characterId,state,afterMessageId,label:value.get("label")||undefined});continue; }
    if (line.startsWith("<msg ")) {
      if(effectWrapperOpen&&effectWrapperHasMessage)throw new Error(`第 ${index+1} 行：一个 effects 只能包裹一条消息`);if(effectWrapperOpen)effectWrapperHasMessage=true;
      const messageIndent=lines[index].match(/^\s*/)?.[0].length||0;
      const value = tagAttributes(line); const characterId = value.get("by") || ""; if (!document.characters.some((item)=>item.id===characterId)) throw new Error(`第 ${index + 1} 行：消息引用了不存在的角色 ${characterId}`);if(pendingMessageEffects.some((segment)=>segment.interaction?.targetCharacterId===characterId))throw new Error(`第 ${index + 1} 行：互动目标不能是发送者自己`);
      const body: string[] = []; let durationMs: number | undefined; let ended = false;
      while (++index < lines.length) { const bodyLine = lines[index]; const trimmedBodyLine=bodyLine.trim();if (trimmedBodyLine === "<msg/>"||trimmedBodyLine==="</msg>") { ended = true; break; } const timeMatch = trimmedBodyLine.match(/^<time:(\d+(?:\.\d+)?)ms>$/)||trimmedBodyLine.match(/^<time\s+duration="(\d+(?:\.\d+)?)ms"\s*\/>$/); if (timeMatch) { durationMs = Math.round(Number(timeMatch[1])); continue; } const expectedIndent=messageIndent+2;body.push(bodyLine.startsWith(" ".repeat(expectedIndent))?bodyLine.slice(expectedIndent):bodyLine); }
      if (!ended) throw new Error(`消息 ${value.get("id") || characterId} 缺少 <msg/>`);
		const kind = value.get("kind") === "image" ? "image" : value.get("kind") === "audio" ? "audio" : "text"; const streamValue = value.get("stream"); const tokenAnimation = value.get("text-animation") as StoryStreamTokenAnimation | undefined; const screenEffect = value.get("screen") as StoryScreenEffect | undefined; const screenEffectColor = (value.get("screen-color") || "auto") as StoryEffectColor;const screenDuration=Math.max(120,Number((value.get("screen-duration")||"900ms").replace(/ms$/,""))||900);const screenSpeed=Math.max(25,Number((value.get("screen-speed")||"100%").replace(/%$/,""))||100);const screenRepeat=Math.max(1,Math.min(12,Number(value.get("screen-repeat"))||1)); const interactionEffect = value.get("interact") as StoryInteractionEffect | undefined; const interactionTarget = value.get("target") || "";const interactionReaction=(value.get("reaction")||"stagger") as StoryInteractionReaction;const interactionColor=(value.get("interaction-color")||"auto") as StoryEffectColor;const interactionSpeed=Math.max(25,Math.min(400,Number((value.get("interaction-speed")||"100%").replace(/%$/,""))||100));if (tokenAnimation && !tokenAnimations.has(tokenAnimation)) throw new Error(`第 ${index + 1} 行：未知文字动画 ${tokenAnimation}`); if (screenEffect && !screenEffects.has(screenEffect)) throw new Error(`第 ${index + 1} 行：未知屏幕效果 ${screenEffect}`); if (screenEffect && !effectColors.has(screenEffectColor)) throw new Error(`第 ${index + 1} 行：未知特效颜色 ${screenEffectColor}`);if(interactionEffect&&!effectColors.has(interactionColor))throw new Error(`第 ${index + 1} 行：未知互动颜色 ${interactionColor}`); if (interactionEffect && !interactionEffects.has(interactionEffect)) throw new Error(`第 ${index + 1} 行：未知角色互动 ${interactionEffect}`);if(interactionEffect&&!interactionReactions.has(interactionReaction))throw new Error(`第 ${index + 1} 行：未知互动反应 ${interactionReaction}`); if (interactionEffect && interactionTarget && !document.characters.some((item) => item.id === interactionTarget)) throw new Error(`第 ${index + 1} 行：角色互动目标不存在 ${interactionTarget}`);if(interactionEffect&&interactionTarget===characterId)throw new Error(`第 ${index + 1} 行：互动目标不能是发送者自己`); const timed = parseTimedText(body.join("\n")); const performance = { ...(durationMs != null ? { durationMs } : {}), ...(streamValue ? { stream:["on","true","1"].includes(streamValue) } : {}), ...(pendingMessageEffects.length ? { effects:structuredClone(pendingMessageEffects) } : {}), ...(tokenAnimation ? { tokenAnimation } : {}), ...(screenEffect && screenEffect !== "none" ? { screenEffect, screenEffectColor,screenEffectDurationMs:screenDuration,screenEffectSpeedPercent:screenSpeed,screenEffectRepeat:screenRepeat } : {}), ...(interactionEffect ? { interaction:{ effect:interactionEffect, ...(interactionTarget?{targetCharacterId:interactionTarget}:{}), emoji:value.get("emoji")||undefined,reaction:interactionReaction,color:interactionColor,speedPercent:interactionSpeed } } : {}), ...(Object.keys(timed.tokenDelays).length ? { tokenDelays:timed.tokenDelays } : {}), ...(timed.tokenGroups.length ? { tokenGroups:timed.tokenGroups } : {}) };
		const reply=value.get("reply")||"";const play=(value.get("play")||"").match(/^(\d+)ms$/);const visitReply=(value.get("visit-reply")||"").match(/^(\d+)ms$/);if(play)(performance as Record<string,unknown>).audioPlayback={maxDurationMs:Number(play[1])};if(visitReply){if(!reply)throw new Error(`第 ${index + 1} 行：visit-reply 只能用于带 reply 的消息`);(performance as Record<string,unknown>).replyPreview={durationMs:Number(visitReply[1])}}const conflict=value.get("conflict");if(conflict&&conflict!=="source-changed"&&conflict!=="source-deleted")throw new Error(`第 ${index + 1} 行：未知 conflict`);const common = { id:value.get("id")||createStoryId("message"), characterId, time:Number(value.get("at"))||Date.now(),timeText:value.get("time-text")||undefined,sourceFingerprint:value.get("source-fingerprint")||undefined,sourcePartText:value.get("source-part")||undefined,locallyInserted:["on","true","1"].includes((value.get("inserted")||"").toLowerCase()),conflict:conflict as "source-changed"|"source-deleted"|undefined, replyToId:reply||undefined };
			if (kind !== "text") { const asset=value.get("asset")||""; if(!asset)throw new Error(`${kind==='audio'?'语音':'图片'}消息 ${common.id} 缺少 asset`);const url=value.get("url")||"";if(url&&!/^https?:\/\//i.test(url)&&!url.startsWith('/'))throw new Error(`消息 ${common.id} 的资源 URL 只允许 HTTP(S) 或站内路径`); const view=(value.get("view")||"").match(/^(\d+)ms\/(\d+)ms$/); if(kind==='image'&&view)(performance as Record<string,unknown>).imagePreview={openAfterMs:Number(view[1]),durationMs:Number(view[2])}; const assetRef={id:asset,mime:value.get("mime")||(kind==='audio'?"audio/*":"image/*"),sourceUrl:url||undefined,external:["on","true","1"].includes((value.get("external")||"").toLowerCase())};const mediaDuration=(value.get("media-duration")||"").match(/^(\d+)ms$/); document.messages.push(kind==='audio'?{ ...common, performance:Object.keys(performance).length?performance:undefined, kind, asset:assetRef, alt:"语音",durationMs:mediaDuration?Number(mediaDuration[1]):undefined, caption:timed.text||undefined }:{ ...common, performance:Object.keys(performance).length?performance:undefined, kind, asset:assetRef, alt:timed.text }); } else document.messages.push({ ...common, performance:Object.keys(performance).length?performance:undefined, kind:"text", text:timed.text });
      lastMessageId=common.id;for(const pending of pendingEffectStarts)openEffects.set(pending.id,{...pending,startMessageId:common.id});pendingEffectStarts=[];
      continue;
    }
    throw new Error(`第 ${index + 1} 行：无法识别“${line.slice(0, 48)}”`);
  }
  for (const match of script.matchAll(/<msg\s+([^>]*\btyping="\d+ms"[^>]*)>/g)) {
    const value=tagAttributes(match[0]);const id=value.get("id")||"";const duration=(value.get("typing")||"").match(/^(\d+)ms$/);const message=document.messages.find(item=>item.id===id);
    if(message&&duration)message.performance={...(message.performance||{}),typingDurationMs:Number(duration[1])};
  }
  if(effectWrapperOpen)throw new Error("effects 缺少 </effects>");if(pendingEffectStarts.length)throw new Error(`持续效果 ${pendingEffectStarts[0].id} 的起始标签后没有消息`);if(openEffects.size)throw new Error(`持续效果 ${openEffects.keys().next().value} 缺少 <effect-end>`);if (!document.characters.length) throw new Error("至少需要一个 <role> 角色"); document.updatedAt = declaredUpdatedAt || new Date().toISOString(); return { document:normalizeStoryDocument(document), assets:new Map(base.assets) };
}

export const STORY_SCRIPT_HELP = `<!-- Lorana Tales Story Language 2 -->
<story title="我的故事">

  <roles>
    <role id="alice" name="爱丽丝" qq="12345678" side="left" palette="ocean" bubble="ocean" avatar="" />
    <role id="narrator" name="旁白" side="narrator" color="#9ca3af" narrator="on" />
  </roles>

  <messages>
    <effects>
      <effect id="fx-1" delay="0ms" text="impact" />
      <effect id="fx-2" delay="420ms" screen="damage" color="red" duration="600ms" speed="120%" repeat="1" />
      <effect id="fx-3" delay="800ms" interact="magic" target="narrator" interaction-color="purple" interaction-speed="130%" />
      <msg by="alice" stream="on">
        <time duration="2000ms" />
        <wt:100ms>你好<wt/>，欢迎回来。
      </msg>
    </effects>

    <msg by="alice" kind="image" asset="asset-123" mime="image/webp" view="0ms/3000ms">
      图片说明
    </msg>
  </messages>
</story>

标签说明：
• <time duration="2000ms" />：消息完整出现后停留 2 秒。
• <effects> 可包裹一条消息及最多 5 个 <effect />；delay 是相对消息出现时刻的延迟。
• <wt:100ms>文本<wt/>：在全局智能延迟上，每词额外增加 100ms。
• <wt:-50ms>文本<wt/>：在全局智能延迟上，每词减少 50ms；最终延迟不会低于 0。
• <word>自定义词组<word/>：把标签内文本视为一个完整词；GUI 分词选择器会自动写入该标签。
• stream="on"：本条启用流式输出；省略则跟随全局设置。
• text-animation="impact"：本条使用重击落字；还支持 fade、rise、blur、shake、ghost、none。
• screen="damage" screen-color="red" screen-duration="900ms" screen-speed="100%" screen-repeat="1"：屏幕形态、预制色和节奏彼此独立。
• interact="throw" target="角色 id" emoji="🪨" reaction="stagger"：让头像在独立动画层互动；target 可省略为仅发送者动作，还支持 heart、magic、magic-circle、surprise、impact、bullet、blade。
• reaction 可写 none、bounce、stagger、faint、shatter、gray、affection，分别表示不回应、跳起、踉跄、晕倒、碎裂、灰化和贴近回应。
• <character-state character="角色 id" state="dead" after="消息 id" label="阵亡">：从该消息之后持续改变角色状态，后续用 state="normal" 恢复；还支持 gray、injured、frozen、cursed、out、wasted。
• view="0ms/3000ms"：图片出现后打开并查看 3 秒；事件结束前不会推进演出。
• play="8000ms"：自动播放语音，播放结束或到达 8 秒上限后再继续。
• visit-reply="3000ms"：定位引用消息 3 秒，再返回当前消息后继续。
• <effect-start id="危机" type="low-health" color="red" intensity="100%" opacity="100%" speed="100%" />：下一条消息起持续显示效果。
• <effect-end id="危机" />：上一条消息是该区间终点；起止标签必须成对并写在消息时间线中。
• reply="消息 id"：引用另一条消息；图形编辑器里的“引用”会自动生成。
• side 可写 left、right、narrator；avatar 引用 SSP 包内资源。
• palette 和 bubble 只能使用编辑器内置的高对比预设名。
• <set name="streamSpeedJitterPercent" value="25"> 可修改全局设置。
• <set name="hideOffTopic" value="on"> 隐藏以 ( 或 （ 开头的场外发言，不删除原消息。
• <set name="hideDiceCommands" value="on"> 隐藏以 .、。或 / 开头的骰子指令，保留骰子结果。
• <set name="enterKeyBehavior" value="auto"> 编辑器回车按设备决定；也可写 send 或 newline。
• id 和 at 可省略；导出时自动写入稳定 id，以保留演出编排。`;

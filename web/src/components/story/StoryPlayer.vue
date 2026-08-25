<template>
  <Teleport to="body">
    <div v-if="show" ref="scrollEl" class="player" :class="[`player--${document.settings.theme}`, `player--${document.settings.density}`]" :style="playerStyle" @click.self="advanceFromCanvas">
      <header><button @click="$emit('close')">← 返回</button><div><strong>{{ document.title }}</strong><small>{{ started ? `${visibleCount} / ${document.messages.length}` : `${document.messages.length} 条消息` }}</small></div><button @click="headerAction">{{ finished ? '重新开始' : !started ? '开始预览' : paused ? '继续预览' : '暂停预览' }}</button></header>
      <main :style="canvasStyle" @click="advanceFromCanvas">
        <TransitionGroup :name="started && document.settings.animation !== 'none' ? document.settings.animation : ''">
          <article v-for="(message,index) in visibleMessages" :key="message.id" class="player-message" :class="[`player-message--${character(message.characterId)?.position || 'left'}`, `player-message--group-${groupPosition(index)}`]">
            <span v-if="avatarSlot(message.characterId)" class="player-avatar-slot" :class="{ 'player-avatar-slot--bottom': document.settings.avatarAlignment==='bottom' }"><span v-if="showAvatar(message.characterId,index)" class="player-avatar"><img v-if="avatar(character(message.characterId))" :src="avatar(character(message.characterId))" alt="" /><i v-else>{{ character(message.characterId)?.name?.slice(0,1) || '旁' }}</i></span></span>
            <div><small v-if="showOutsideName(message.characterId,index) || document.settings.showTime"><template v-if="showOutsideName(message.characterId,index)"><span class="character-name">{{ character(message.characterId)?.name }}</span><span v-if="document.settings.showQqInPreview && character(message.characterId)?.imUserId" class="character-account"> · {{ character(message.characterId)?.imUserId }}</span></template><span v-if="document.settings.showTime" class="message-time">{{ showOutsideName(message.characterId,index) ? ' · ' : '' }}{{ messageTime(message) }}</span></small><div class="bubble" :class="{ 'bubble--narrator-avatar': showNarratorBubbleAvatar(message.characterId,index) }"><div v-if="showNarratorBubbleAvatar(message.characterId,index)" class="narrator-identity"><span class="narrator-avatar"><img v-if="avatar(character(message.characterId))" :src="avatar(character(message.characterId))" alt="" /><i v-else>{{ character(message.characterId)?.name?.slice(0,1) || '旁' }}</i></span><span v-if="showNarratorName(message.characterId,index)" class="narrator-identity__text"><span class="character-name">{{ character(message.characterId)?.name }}</span><span v-if="document.settings.showQqInPreview && character(message.characterId)?.imUserId" class="character-account"> · {{ character(message.characterId)?.imUserId }}</span></span></div><img v-if="message.kind === 'image'" :src="imageUrl(message.asset)" :alt="message.alt || '图片'" /><span v-else>{{ displayText(message.text) }}</span></div></div>
          </article>
        </TransitionGroup>
      </main>
      <footer>
        <label class="player-switch"><input v-model="autoplay" type="checkbox" /><span aria-hidden="true"></span>自动播放</label>
        <div class="player-timing">
          <button class="player-timing__button" aria-haspopup="listbox" :aria-expanded="timingMenuOpen" @click.stop="toggleTimingMenu">{{ timing==='dynamic' ? '按字数动态' : '固定间隔' }}<span aria-hidden="true">⌃</span></button>
          <div v-if="timingMenuOpen" class="player-timing__menu" role="listbox" aria-label="自动播放计时方式">
            <button role="option" :aria-selected="timing==='dynamic'" @click.stop="setTiming('dynamic')">按字数动态<span v-if="timing==='dynamic'">✓</span></button>
            <button role="option" :aria-selected="timing==='fixed'" @click.stop="setTiming('fixed')">固定间隔<span v-if="timing==='fixed'">✓</span></button>
          </div>
        </div>
        <n-input-number v-if="timing === 'fixed'" class="player-number" :value="fixedMs" aria-label="固定播放间隔毫秒" :min="500" :max="30000" :step="250" :show-button="false" @update:value="fixedMs=$event ?? 2500" />
        <label v-else>字/分钟 <n-input-number class="player-number" :value="readingSpeed" aria-label="中文阅读速度" :min="80" :max="1000" :step="20" :show-button="false" @update:value="readingSpeed=$event ?? 280" /></label>
        <button class="display-settings-toggle" :aria-expanded="displaySettingsOpen" @click.stop="toggleDisplaySettings">显示设置</button>
        <section v-if="displaySettingsOpen" class="player-display-settings" aria-label="沉浸预览显示设置" @click.stop>
          <div class="player-display-settings__title"><strong>显示设置</strong><button @click="resetDisplaySettings">恢复文档设置</button></div>
          <label><span>头像 {{ avatarSize }}px</span><n-slider v-model:value="avatarSize" :min="24" :max="96" :step="2" /></label>
          <label><span>字体 {{ fontSize }}px</span><n-slider v-model:value="fontSize" :min="12" :max="32" /></label>
          <label><span>气泡 {{ bubbleMaxWidth }}%</span><n-slider v-model:value="bubbleMaxWidth" :min="45" :max="95" /></label>
          <label><span>画布 {{ width }}px</span><n-slider v-model:value="width" :min="360" :max="1600" :step="20" /></label>
        </section>
      </footer>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { playbackDelay, storyDisplayText, storyMessageGroupPosition } from "~/story/model";
import type { StoryArchive, StoryAssetRef, StoryCharacter, StoryMessage } from "~/story/types";
const props = defineProps<{ show: boolean; archive: StoryArchive; assetUrl: (id: string) => string }>();
defineEmits<{ close: [] }>();
const document = computed(() => props.archive.document); const visibleCount = ref(document.value.messages.length); const started = ref(false); const paused = ref(false); const autoplay = ref(document.value.settings.autoplay); const timing = ref(document.value.settings.playbackTiming); const fixedMs = ref(document.value.settings.fixedDelayMs); const readingSpeed = ref(document.value.settings.chineseCharsPerMinute); const width = ref(document.value.settings.canvasWidth); const avatarSize=ref(document.value.settings.avatarSize);const fontSize=ref(document.value.settings.fontSize);const bubbleMaxWidth=ref(document.value.settings.bubbleMaxWidth);const displaySettingsOpen=ref(false);const timingMenuOpen=ref(false); const scrollEl = ref<HTMLElement>(); let timer = 0; let previousPageOverflow="";
const visibleMessages = computed(() => document.value.messages.slice(0,visibleCount.value)); const canvasStyle = computed(() => ({'--canvas-width':`${width.value}px`,'--bubble-width':`${Math.round(720*bubbleMaxWidth.value/100)}px`,'--font-size':`${fontSize.value}px`,'--avatar-size':`${avatarSize.value}px`,'--narrator-avatar-size':`${Math.max(20,Math.round(avatarSize.value*.68))}px`}));const playerStyle=computed(()=>({'--animation-duration':`${document.value.settings.animationDurationMs}ms`}));
const finished=computed(()=>started.value&&visibleCount.value>=document.value.messages.length);
function character(id:string){return document.value.characters.find(c=>c.id===id)} function assetUrl(asset?:StoryAssetRef){return asset ? (props.archive.assets.has(asset.id)?props.assetUrl(asset.id):asset.sourceUrl||asset.id) : ''} function avatar(c?:StoryCharacter){return assetUrl(c?.avatar)||(c?.imUserId?`/api/editor/avatar/qq/${encodeURIComponent(c.imUserId)}`:"")} function imageUrl(asset:StoryAssetRef){return assetUrl(asset)}
function groupPosition(index:number){return storyMessageGroupPosition({...document.value,messages:visibleMessages.value},index)}function groupStarts(index:number){const position=groupPosition(index);return position==='single'||position==='first'}
function isDefaultNarrator(c?:StoryCharacter){return !!(c?.position==='narrator'&&c.name.trim()==='旁白'&&!c.avatar&&!c.imUserId)}function showOutsideName(id:string,index:number){const c=character(id);return !!(document.value.settings.showNames&&groupStarts(index)&&c?.position!=='narrator')}function avatarSlot(id:string){const c=character(id);return document.value.settings.showAvatars&&!c?.isNarrator&&c?.position!=='narrator'}function showAvatar(id:string,index:number){if(!avatarSlot(id))return false;const position=groupPosition(index);return document.value.settings.avatarAlignment==='bottom'?(position==='single'||position==='last'):(position==='single'||position==='first')}function showNarratorBubbleAvatar(id:string,index:number){const c=character(id);return !!(document.value.settings.showAvatars&&!c?.isNarrator&&c?.position==='narrator'&&c.narratorAvatar&&!isDefaultNarrator(c)&&groupStarts(index))}function showNarratorName(id:string,index:number){return !!(document.value.settings.showNames&&document.value.settings.showNarratorNames&&showNarratorBubbleAvatar(id,index))}function displayText(text:string){return storyDisplayText(text,document.value.settings.preserveLineBreaks)}function messageTime(message:StoryMessage){if(message.timeText)return message.timeText;if(!message.time)return '--:--';const value=message.time>10_000_000_000?message.time:message.time*1000;return new Date(value).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}
function dynamicDelay(message:StoryMessage){const settings={...document.value.settings,chineseCharsPerMinute:Math.max(80,readingSpeed.value||280)};return playbackDelay(message,{...document.value,settings})}
function setTiming(value:string){timing.value=value==='fixed'?'fixed':'dynamic';timingMenuOpen.value=false}
function toggleTimingMenu(){displaySettingsOpen.value=false;timingMenuOpen.value=!timingMenuOpen.value}
function toggleDisplaySettings(){timingMenuOpen.value=false;displaySettingsOpen.value=!displaySettingsOpen.value}
function resetDisplaySettings(){width.value=document.value.settings.canvasWidth;avatarSize.value=document.value.settings.avatarSize;fontSize.value=document.value.settings.fontSize;bubbleMaxWidth.value=document.value.settings.bubbleMaxWidth}
function stopTimer(){window.clearTimeout(timer)} function schedule(){stopTimer();if(!started.value||paused.value||!autoplay.value||finished.value)return;const msg=document.value.messages[visibleCount.value];timer=window.setTimeout(()=>{next();schedule()},timing.value==='fixed'?fixedMs.value:dynamicDelay(msg))}
function next(){if(finished.value)return;visibleCount.value=Math.min(document.value.messages.length,visibleCount.value+1);nextTick(()=>scrollEl.value?.scrollTo({top:scrollEl.value.scrollHeight,behavior:'smooth'}))}
function startPlayback(){stopTimer();started.value=true;paused.value=false;visibleCount.value=0;if(autoplay.value){next();schedule()}else nextTick(()=>scrollEl.value?.scrollTo({top:0}))}
function headerAction(){if(!started.value||finished.value){startPlayback();return}paused.value=!paused.value;if(paused.value)stopTimer();else schedule()}
function advanceFromCanvas(){if(!started.value||paused.value||finished.value)return;next();if(autoplay.value)schedule()}
watch(()=>props.show,(show)=>{stopTimer();started.value=false;paused.value=false;visibleCount.value=show?document.value.messages.length:visibleCount.value;if(show){resetDisplaySettings();displaySettingsOpen.value=false;timingMenuOpen.value=false;previousPageOverflow=globalThis.document.documentElement.style.overflow;globalThis.document.documentElement.style.overflow="hidden"}else globalThis.document.documentElement.style.overflow=previousPageOverflow},{immediate:true});watch([autoplay,timing,fixedMs,readingSpeed],schedule);onBeforeUnmount(()=>{stopTimer();globalThis.document.documentElement.style.overflow=previousPageOverflow});
</script>

<style scoped>
.player{position:fixed;inset:0;z-index:10000;display:grid;grid-template-rows:auto 1fr auto;background:#0b1110;color:#eef2f1}.player--light{background:#eef2f7;color:#17202a}.player header,.player footer{display:flex;align-items:center;gap:1rem;padding:max(.8rem,env(safe-area-inset-top)) max(1rem,env(safe-area-inset-right));background:rgba(20,29,28,.96);color:white}.player header{justify-content:space-between}.player header div{display:grid;text-align:center}.player header small{opacity:.65}.player button{border:0;border-radius:10px;padding:.6rem .8rem;background:#2b3837;color:inherit}.player main{box-sizing:border-box;width:100%;margin:0;padding:clamp(1rem,3vw,2.5rem);overflow-y:auto;scrollbar-gutter:stable}.player-message{display:flex;align-items:flex-start;gap:.7rem;width:min(var(--canvas-width),100%);margin:.45rem auto;font-size:var(--font-size)}.player-message--merged{margin-top:-.2rem}.player-avatar{width:var(--avatar-size);height:var(--avatar-size);border-radius:50%;overflow:hidden;display:grid;place-items:center;flex:0 0 var(--avatar-size);background:#334342}.player-avatar img{width:100%;height:100%;object-fit:cover}.player-avatar i{font-style:normal}.player-message>div{max-width:min(var(--bubble-width),calc(100% - var(--avatar-size) - .7rem))}.player-message small{display:block;margin:0 .35rem .25rem;color:#97a5a2}.character-name{color:#63d9a5;font-weight:650}.character-account,.message-time{color:#97a5a2;font-weight:400}.bubble{padding:.75rem 1rem;border-radius:18px;background:#182120;white-space:pre-wrap;overflow-wrap:anywhere}.bubble img{display:block;max-width:100%;max-height:72vh;border-radius:14px}.player-message--right{flex-direction:row-reverse;text-align:right}.player-message--right .bubble{background:#1f4f52}.player-message--narrator{justify-content:center;text-align:center}.player-message--narrator .bubble{position:relative;background:#252c2b;color:#c5cfcd;border-radius:10px}.bubble--narrator-avatar{text-align:left}.narrator-identity{display:flex;align-items:center;gap:.45rem;margin:0 0 .45rem}.narrator-avatar{width:var(--narrator-avatar-size);height:var(--narrator-avatar-size);overflow:hidden;border:2px solid color-mix(in srgb,#252c2b,white 18%);border-radius:50%;background:#334342;display:grid;place-items:center;flex:0 0 var(--narrator-avatar-size)}.narrator-avatar img{width:100%;height:100%;object-fit:cover}.narrator-avatar i{font-size:.72rem;font-style:normal}.narrator-identity__text{min-width:0;font-size:.78em;line-height:1.2;text-align:left}.player--compact .player-message{margin:.25rem auto}.player--compact .bubble{padding:.5rem .75rem}.player--spacious .player-message{margin:.85rem auto}.player--spacious .bubble{padding:.95rem 1.15rem}.player footer{justify-content:center;flex-wrap:wrap;padding-bottom:max(.8rem,env(safe-area-inset-bottom))}.player footer label{display:flex;align-items:center;gap:.4rem}.player-timing{position:relative;width:9rem}.player-timing__button{display:flex;align-items:center;justify-content:space-between;width:100%;border:1px solid #53615f!important;background:#2b3837!important}.player-timing__menu{position:absolute;right:0;bottom:calc(100% + .55rem);left:0;z-index:5;display:grid;gap:.15rem;padding:.35rem;border:1px solid #53615f;border-radius:12px;background:#202a29;box-shadow:0 12px 36px #000a}.player-timing__menu button{display:flex;align-items:center;justify-content:space-between;width:100%;padding:.55rem .65rem;white-space:nowrap}.player-timing__menu button[aria-selected="true"]{background:#31514f;color:#8ae9df}.player-number{width:7rem}.slide-fade-enter-active,.fade-enter-active{transition:var(--animation-duration,.28s) ease}.slide-fade-enter-from{opacity:0;transform:translateY(18px)}.fade-enter-from{opacity:0}@media(prefers-color-scheme:light){.player--auto{background:#eef2f7;color:#17202a}}@media(max-width:600px){.player main{width:100%;padding:1rem}.player-message>div{max-width:82%}}
/* Telegram-style connected groups use a stable avatar rail and compact joins. */
.player{--group-gap:.58rem;--joined-gap:.11rem}
.player--compact{--group-gap:.34rem;--joined-gap:.08rem}
.player--spacious{--group-gap:.92rem;--joined-gap:.16rem}
.player-message{margin:var(--group-gap) auto}
.player .player-message--group-first{margin-bottom:var(--joined-gap)}
.player .player-message--group-middle{margin-top:var(--joined-gap);margin-bottom:var(--joined-gap)}
.player .player-message--group-last{margin-top:var(--joined-gap)}
.player-avatar-slot{display:flex;align-items:flex-start;width:var(--avatar-size);align-self:stretch;flex:0 0 var(--avatar-size)}
.player-avatar-slot--bottom{align-items:flex-end}
.player-message>div{min-width:0}
.player-message--left.player-message--group-first .bubble{border-bottom-left-radius:7px}
.player-message--left.player-message--group-middle .bubble{border-top-left-radius:7px;border-bottom-left-radius:7px}
.player-message--left.player-message--group-last .bubble{border-top-left-radius:7px}
.player-message--right.player-message--group-first .bubble{border-bottom-right-radius:7px}
.player-message--right.player-message--group-middle .bubble{border-top-right-radius:7px;border-bottom-right-radius:7px}
.player-message--right.player-message--group-last .bubble{border-top-right-radius:7px}
@media(max-width:600px){.player-message{gap:.5rem}}
.player{display:block;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#465956 transparent}
.player::-webkit-scrollbar{width:8px}
.player::-webkit-scrollbar-track{background:transparent}
.player::-webkit-scrollbar-thumb{border:2px solid transparent;border-radius:999px;background:#465956;background-clip:padding-box}
.player main{box-sizing:border-box;height:auto;min-height:calc(100vh - 8rem);padding-bottom:7rem;overflow:visible;touch-action:pan-y;cursor:pointer}
.player header{position:sticky;top:0;z-index:3}
.player footer{position:fixed;right:0;bottom:0;left:0;z-index:3}
.player-display-settings{position:absolute;right:1rem;bottom:calc(100% + .65rem);left:1rem;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem 1rem;width:min(640px,calc(100% - 2rem));box-sizing:border-box;margin:auto;padding:1rem;border:1px solid #465553;border-radius:16px;background:#182120;box-shadow:0 16px 50px #000a;color:#eef2f1}
.player-display-settings__title{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:1rem}
.player-display-settings__title button{padding:.4rem .65rem;font-size:.78rem}
.player-display-settings label{display:grid!important;grid-template-columns:6.5rem minmax(0,1fr);gap:.65rem!important;min-width:0}
.player-display-settings :deep(.n-slider){min-width:0}
.player-switch{display:inline-flex!important;align-items:center;gap:.55rem;cursor:pointer;user-select:none}
.player-switch input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.player-switch span{position:relative;width:2.6rem;height:1.45rem;border:1px solid #53615f;border-radius:999px;background:#273230;transition:.18s}
.player-switch span::after{content:"";position:absolute;top:2px;left:2px;width:1.05rem;height:1.05rem;border-radius:50%;background:#c8d2d0;box-shadow:0 1px 4px #0006;transition:.18s}
.player-switch input:checked+span{border-color:#38bfc8;background:#168a92}
.player-switch input:checked+span::after{transform:translateX(1.13rem);background:#fff}
.player-switch input:focus-visible+span{outline:2px solid #73e1e7;outline-offset:2px}
.slide-fade-enter-active{will-change:transform,opacity}
.slide-fade-enter-from{opacity:0;transform:translateY(28px)}
@media(max-width:600px){.player header{gap:.45rem;padding:.65rem .75rem}.player header>button{padding:.55rem .65rem;white-space:nowrap}.player header strong{font-size:.92rem}.player footer{gap:.55rem;padding:.65rem .75rem max(.65rem,env(safe-area-inset-bottom))}.player-timing{width:8rem}.player-number{width:5.75rem}.player-display-settings{grid-template-columns:1fr;right:.75rem;left:.75rem;width:calc(100% - 1.5rem)}.player-display-settings__title{grid-column:1}.player-display-settings label{grid-template-columns:5.8rem minmax(0,1fr)}}
</style>

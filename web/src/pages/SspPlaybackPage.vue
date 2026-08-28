<template>
  <main class="ssp-player-page" @dragover.prevent @drop.prevent="onDrop">
    <section class="ssp-player-card">
      <div class="ssp-player-mark" aria-hidden="true">
        <svg viewBox="0 0 48 48"><path d="M12 7h17l8 8v26H12z"/><path d="M29 7v9h8M19 23h11M19 29h11M19 35h7"/><path class="play" d="m21 14 8 5-8 5z"/></svg>
      </div>
      <div>
        <small>Lorana Tales</small>
        <h1>SSP 播放器</h1>
        <p>直接在浏览器中播放完整故事。支持手动点击推进、自动播放、暂停与变速；文件只在当前浏览器内解析。</p>
      </div>
      <label class="ssp-file-button">
        <input type="file" accept=".ssp,application/vnd.lorana-tales.story+zip" @change="onFile" />
        <svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L8 8m4-4 4 4M5 14v5h14v-5"/></svg>
        选择 SSP 文件
      </label>
      <p class="ssp-drop-hint">也可以把 `.ssp` 文件拖到这里</p>
      <div v-if="loading" class="ssp-status"><i></i>正在打开故事……</div>
      <div v-else-if="error" class="ssp-status ssp-status--error"><strong>没有成功打开</strong><span>{{ error }}</span></div>
      <footer><a href="/story">返回编辑器</a><button type="button" @click="openTutorials">浏览内置教程</button></footer>
    </section>
  </main>
  <StoryPlayer v-if="archive" :show="playerOpen" :archive="archive" :asset-url="assetUrl" playback-only @change="archive=$event" @close="closePlayer" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import StoryPlayer from "~/components/story/StoryPlayer.vue";
import { readStoryPackage } from "~/story/package";
import type { StoryArchive, StoryAssetRef } from "~/story/types";

const archive=ref<StoryArchive>();const playerOpen=ref(false);const loading=ref(false);const error=ref("");
const objectUrls=new Map<string,string>();

function clearObjectUrls(){for(const url of objectUrls.values())URL.revokeObjectURL(url);objectUrls.clear()}
function assetUrl(id:string){const existing=objectUrls.get(id);if(existing)return existing;const bytes=archive.value?.assets.get(id);if(!bytes)return id;const refs:StoryAssetRef[]=[...(archive.value?.document.characters.map(item=>item.avatar).filter(Boolean) as StoryAssetRef[]||[]),...(archive.value?.document.messages.flatMap(item=>item.kind==="text"?[]:[item.asset])||[])];const url=URL.createObjectURL(new Blob([bytes],{type:refs.find(item=>item.id===id)?.mime||"application/octet-stream"}));objectUrls.set(id,url);return url}
async function openBlob(blob:Blob){loading.value=true;error.value="";try{clearObjectUrls();archive.value=await readStoryPackage(blob);playerOpen.value=true}catch(exception){archive.value=undefined;error.value=exception instanceof Error?exception.message:"无法读取 SSP 文件"}finally{loading.value=false}}
function onFile(event:Event){const input=event.target as HTMLInputElement;const file=input.files?.[0];if(file)void openBlob(file);input.value=""}
function onDrop(event:DragEvent){const file=event.dataTransfer?.files?.[0];if(file)void openBlob(file)}
function closePlayer(){playerOpen.value=false;archive.value=undefined;clearObjectUrls()}
function openTutorials(){window.dispatchEvent(new Event("lorana-open-tutorials"))}
async function openSourceFromQuery(){const source=new URLSearchParams(location.search).get("src")?.trim();if(!source)return;try{const url=new URL(source,location.href);if(!["http:","https:"].includes(url.protocol))throw new Error("只允许 HTTP 或 HTTPS 的 SSP 地址");loading.value=true;const response=await fetch(url,{cache:"no-store",credentials:url.origin===location.origin?"same-origin":"omit"});if(!response.ok)throw new Error(`SSP 请求失败（${response.status}）`);await openBlob(await response.blob())}catch(exception){error.value=exception instanceof Error?exception.message:"无法载入分享内容";loading.value=false}}
onMounted(()=>void openSourceFromQuery());
onBeforeUnmount(clearObjectUrls);
</script>

<style scoped>
.ssp-player-page{display:grid;min-height:var(--app-visual-height,100dvh);box-sizing:border-box;place-items:center;padding:1rem;background:radial-gradient(circle at 50% 15%,color-mix(in srgb,var(--focus-color) 10%,transparent),transparent 35%),var(--app-bg);color:var(--control-text)}.ssp-player-card{display:grid;justify-items:center;gap:1rem;width:min(520px,100%);box-sizing:border-box;border:1px solid var(--control-border);border-radius:22px;padding:clamp(1.2rem,5vw,2.2rem);background:var(--panel-surface);box-shadow:0 22px 70px #0004;text-align:center}.ssp-player-card h1,.ssp-player-card p{margin:0}.ssp-player-card h1{margin:.15rem 0 .4rem;font-size:clamp(1.45rem,5vw,2rem)}.ssp-player-card small{color:var(--focus-color);font-weight:750;letter-spacing:.08em}.ssp-player-card p{color:var(--muted-text);line-height:1.6}.ssp-player-mark{display:grid;width:78px;height:78px;border-radius:22px;place-items:center;background:var(--selected-bg);color:var(--focus-color)}.ssp-player-mark svg{width:46px;height:46px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.ssp-player-mark .play{fill:currentColor;stroke:none}.ssp-file-button{display:flex;align-items:center;justify-content:center;gap:.5rem;min-height:42px;border-radius:11px;padding:.1rem 1rem;background:var(--primary-bg);color:var(--primary-text);font-weight:700;cursor:pointer}.ssp-file-button input{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.ssp-file-button svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.ssp-drop-hint{font-size:.75rem}.ssp-status{display:flex;align-items:center;gap:.5rem;border-radius:10px;padding:.55rem .75rem;background:var(--soft-surface);color:var(--muted-text);font-size:.78rem}.ssp-status i{width:16px;height:16px;border:2px solid var(--control-border);border-top-color:var(--focus-color);border-radius:50%;animation:ssp-spin .7s linear infinite}.ssp-status--error{display:grid;color:var(--danger-text)}.ssp-player-card footer{display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;padding-top:.5rem;border-top:1px solid var(--control-border)}.ssp-player-card footer a,.ssp-player-card footer button{border:0;border-radius:9px;padding:.48rem .7rem;background:var(--control-surface);color:var(--control-text);font:inherit;font-size:.76rem;text-decoration:none;cursor:pointer}@keyframes ssp-spin{to{transform:rotate(360deg)}}
@media(max-width:650px){.ssp-player-page{align-items:stretch;padding:0}.ssp-player-card{align-content:center;width:100%;min-height:var(--app-visual-height,100dvh);border:0;border-radius:0;padding:max(1rem,env(safe-area-inset-top)) 1rem max(1rem,env(safe-area-inset-bottom))}}
</style>

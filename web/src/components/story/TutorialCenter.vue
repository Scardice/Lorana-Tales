<template>
  <Teleport to="body">
    <Transition name="tutorial-window">
      <div v-if="show && !playerOpen" class="tutorial-overlay" @click.self="$emit('close')">
        <section class="tutorial-center" role="dialog" aria-modal="true" aria-label="教程中心">
          <header>
            <div><small>Lorana Tales 学院</small><h2>边看故事，边学会创作</h2><p>每课都很短；选择一课后可手动点击推进，也可以打开自动播放。</p></div>
            <button class="tutorial-close" type="button" aria-label="关闭教程" @click="$emit('close')"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
          </header>
          <div v-if="loading" class="tutorial-state"><span></span><strong>正在整理教室……</strong></div>
          <div v-else-if="error" class="tutorial-state tutorial-state--error"><strong>教程暂时没有打开</strong><p>{{ error }}</p><button @click="loadCatalog">重试</button></div>
          <div v-else class="tutorial-layout">
            <nav class="tutorial-categories" aria-label="教程分类">
              <button v-for="category in catalog?.categories" :key="category.id" :class="{active:selectedCategory===category.id}" @click="selectedCategory=category.id">
                <span>{{ categoryIcon(category.id) }}</span><strong>{{ category.title }}</strong><small>{{ category.description }}</small>
              </button>
            </nav>
            <main>
              <div class="tutorial-section-title"><div><small>{{ currentCategory?.title }}</small><h3>{{ currentCategory?.description }}</h3></div><span>{{ filteredTutorials.length }} 个短教程</span></div>
              <div class="tutorial-grid">
                <article v-for="(tutorial,index) in filteredTutorials" :key="tutorial.id">
                  <div class="tutorial-card__index">{{ String(index + 1).padStart(2,"0") }}</div>
                  <div class="tutorial-card__body"><div class="tutorial-card__meta"><span>{{ tutorial.level }}</span><small>{{ tutorial.duration }}</small></div><h3>{{ tutorial.title }}</h3><p>{{ tutorial.summary }}</p><div class="tutorial-points"><span v-for="point in tutorial.points" :key="point">{{ point }}</span></div><div class="tutorial-challenge"><b>课后小任务</b><span>{{ tutorial.challenge }}</span></div></div>
                  <button class="tutorial-start" type="button" :disabled="opening===tutorial.id" @click="openTutorial(tutorial)"><svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5z"/></svg>{{ opening===tutorial.id?'正在打开':'开始教程' }}</button>
                </article>
              </div>
            </main>
          </div>
          <footer><span>教程是仓库内置 SSP，不会改动或保存到你当前的故事。</span><a href="/play" target="_blank">打开 SSP 播放器</a></footer>
        </section>
      </div>
    </Transition>
  </Teleport>
  <StoryPlayer v-if="activeArchive" :show="playerOpen" :archive="activeArchive" :asset-url="tutorialAssetUrl" playback-only @change="activeArchive=$event" @close="closePlayer" />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { readStoryPackage } from "~/story/package";
import type { StoryArchive, StoryAssetRef } from "~/story/types";
import StoryPlayer from "./StoryPlayer.vue";

interface TutorialCategory { id:string; title:string; description:string }
interface TutorialItem { id:string; category:string; title:string; summary:string; duration:string; level:string; points:string[]; challenge:string; file:string }
interface TutorialCatalog { version:number; categories:TutorialCategory[]; tutorials:TutorialItem[] }

const props=defineProps<{show:boolean}>();
defineEmits<{close:[]}>();
const catalog=ref<TutorialCatalog>();const loading=ref(false);const error=ref("");const selectedCategory=ref("start");const opening=ref("");
const activeArchive=ref<StoryArchive>();const playerOpen=ref(false);
const objectUrls=new Map<string,string>();
const currentCategory=computed(()=>catalog.value?.categories.find(item=>item.id===selectedCategory.value));
const filteredTutorials=computed(()=>catalog.value?.tutorials.filter(item=>item.category===selectedCategory.value)||[]);
const categoryIcons:Record<string,string>={start:"✦",edit:"✎",performance:"▶",effects:"✺"};
const categoryIcon=(id:string)=>categoryIcons[id]||"•";

async function loadCatalog(){loading.value=true;error.value="";try{const response=await fetch("/tutorials/catalog.json",{cache:"no-store"});if(!response.ok)throw new Error(`目录请求失败（${response.status}）`);catalog.value=await response.json();if(!catalog.value?.categories.length||!catalog.value.tutorials.length)throw new Error("教程目录为空");if(!catalog.value.categories.some(item=>item.id===selectedCategory.value))selectedCategory.value=catalog.value.categories[0].id}catch(exception){error.value=exception instanceof Error?exception.message:"无法读取教程目录"}finally{loading.value=false}}
async function openTutorial(tutorial:TutorialItem){opening.value=tutorial.id;error.value="";try{const response=await fetch(`/tutorials/${encodeURIComponent(tutorial.file)}`,{cache:"no-store"});if(!response.ok)throw new Error(`教程文件请求失败（${response.status}）`);activeArchive.value=await readStoryPackage(await response.blob());playerOpen.value=true}catch(exception){error.value=exception instanceof Error?exception.message:"无法打开教程"}finally{opening.value=""}}
function clearObjectUrls(){for(const url of objectUrls.values())URL.revokeObjectURL(url);objectUrls.clear()}
function closePlayer(){playerOpen.value=false;activeArchive.value=undefined;clearObjectUrls()}
function tutorialAssetUrl(id:string){
  const existing=objectUrls.get(id);if(existing)return existing;
  const archive=activeArchive.value;const bytes=archive?.assets.get(id);if(!archive||!bytes)return id;
  const refs:StoryAssetRef[]=[
    ...(archive.document.characters.map(item=>item.avatar).filter(Boolean) as StoryAssetRef[]),
    ...archive.document.messages.flatMap(item=>item.kind==="text"?[]:[item.asset]),
  ];
  const url=URL.createObjectURL(new Blob([bytes],{type:refs.find(item=>item.id===id)?.mime||"application/octet-stream"}));
  objectUrls.set(id,url);return url;
}
onMounted(()=>{if(props.show)void loadCatalog()});
onBeforeUnmount(clearObjectUrls);
watch(()=>props.show,value=>{if(value&&!catalog.value&&!loading.value)void loadCatalog();if(!value)closePlayer()});
</script>

<style scoped>
.tutorial-overlay{position:fixed;inset:0;z-index:18000;display:grid;place-items:center;padding:1rem;background:#000a;backdrop-filter:blur(5px)}.tutorial-center{display:grid;box-sizing:border-box;width:min(1080px,100%);height:min(820px,calc(100dvh - 2rem));grid-template-rows:auto minmax(0,1fr) auto;overflow:hidden;border:1px solid var(--control-border);border-radius:22px;background:var(--app-bg);color:var(--control-text);box-shadow:0 28px 100px #0009}.tutorial-center>header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding:1.2rem 1.35rem;border-bottom:1px solid var(--control-border);background:linear-gradient(135deg,color-mix(in srgb,var(--selected-bg) 78%,var(--panel-surface)),var(--panel-surface))}.tutorial-center h2,.tutorial-center h3,.tutorial-center p{margin:0}.tutorial-center>header h2{margin:.15rem 0 .25rem;font-size:1.35rem}.tutorial-center>header small{color:var(--focus-color);font-weight:700;letter-spacing:.08em}.tutorial-center>header p,.tutorial-section-title h3{color:var(--muted-text);font-size:.86rem;font-weight:400}.tutorial-close{display:grid;width:38px;height:38px;flex:0 0 38px;border:0;border-radius:11px;place-items:center;background:var(--control-surface);color:var(--control-text);cursor:pointer}.tutorial-close svg,.tutorial-start svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.tutorial-layout{display:grid;min-height:0;grid-template-columns:230px minmax(0,1fr)}.tutorial-categories{display:grid;align-content:start;gap:.5rem;overflow:auto;padding:1rem;border-right:1px solid var(--control-border);background:var(--panel-surface)}.tutorial-categories button{display:grid;grid-template-columns:32px minmax(0,1fr);gap:.1rem .55rem;border:1px solid transparent;border-radius:13px;padding:.72rem;text-align:left;background:transparent;color:var(--control-text);cursor:pointer}.tutorial-categories button>span{display:grid;width:30px;height:30px;grid-row:1/3;place-items:center;border-radius:9px;background:var(--control-surface);color:var(--focus-color);font-size:1rem}.tutorial-categories button small{color:var(--muted-text);font-size:.68rem;line-height:1.35}.tutorial-categories button.active{border-color:var(--focus-color);background:var(--selected-bg)}.tutorial-layout>main{min-width:0;overflow:auto;padding:1.1rem 1.2rem 1.5rem}.tutorial-section-title{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;margin-bottom:.85rem}.tutorial-section-title small{color:var(--focus-color);font-weight:700}.tutorial-section-title>span{color:var(--muted-text);font-size:.75rem}.tutorial-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem}.tutorial-grid article{display:grid;grid-template-columns:38px minmax(0,1fr);gap:.7rem;border:1px solid var(--control-border);border-radius:16px;padding:.9rem;background:var(--panel-surface);transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}.tutorial-grid article:hover{border-color:color-mix(in srgb,var(--focus-color) 60%,var(--control-border));transform:translateY(-2px);box-shadow:0 10px 28px #0002}.tutorial-card__index{display:grid;width:34px;height:34px;place-items:center;border-radius:10px;background:var(--selected-bg);color:var(--focus-color);font-size:.72rem;font-weight:800}.tutorial-card__body{min-width:0}.tutorial-card__meta{display:flex;align-items:center;gap:.45rem}.tutorial-card__meta span{border-radius:99px;padding:.12rem .42rem;background:var(--control-surface);color:var(--focus-color);font-size:.65rem}.tutorial-card__meta small{color:var(--muted-text)}.tutorial-card__body h3{margin:.4rem 0 .25rem;font-size:1rem}.tutorial-card__body p{min-height:2.6em;color:var(--muted-text);font-size:.78rem;line-height:1.45}.tutorial-points{display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.55rem}.tutorial-points span{border:1px solid var(--control-border);border-radius:6px;padding:.14rem .35rem;color:var(--muted-text);font-size:.64rem}.tutorial-start{display:flex;grid-column:1/-1;align-items:center;justify-content:center;gap:.35rem;min-height:36px;border:0;border-radius:10px;background:var(--primary-bg);color:var(--primary-text);font:inherit;font-size:.78rem;cursor:pointer}.tutorial-start:disabled{opacity:.6;cursor:wait}.tutorial-center>footer{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.7rem 1.2rem;border-top:1px solid var(--control-border);background:var(--panel-surface);color:var(--muted-text);font-size:.72rem}.tutorial-center>footer a{color:var(--focus-color);text-decoration:none}.tutorial-state{display:grid;place-content:center;justify-items:center;gap:.65rem;min-height:0;color:var(--muted-text)}.tutorial-state>span{width:28px;height:28px;border:3px solid var(--control-border);border-top-color:var(--focus-color);border-radius:50%;animation:tutorial-spin .8s linear infinite}.tutorial-state--error button{border:0;border-radius:9px;padding:.5rem .8rem;background:var(--control-surface);color:var(--control-text)}.tutorial-window-enter-active,.tutorial-window-leave-active{transition:opacity .2s ease}.tutorial-window-enter-active .tutorial-center,.tutorial-window-leave-active .tutorial-center{transition:transform .24s cubic-bezier(.2,.78,.2,1),opacity .2s}.tutorial-window-enter-from,.tutorial-window-leave-to{opacity:0}.tutorial-window-enter-from .tutorial-center,.tutorial-window-leave-to .tutorial-center{opacity:0;transform:translateY(14px) scale(.985)}@keyframes tutorial-spin{to{transform:rotate(360deg)}}
.tutorial-challenge{display:grid;gap:.18rem;margin-top:.65rem;border-left:3px solid var(--focus-color);border-radius:0 8px 8px 0;padding:.42rem .55rem;background:var(--selected-bg);font-size:.68rem}.tutorial-challenge b{color:var(--focus-color)}.tutorial-challenge span{color:var(--control-text);line-height:1.4}
@media(max-width:760px){.tutorial-overlay{display:block;padding:0;background:var(--app-bg);backdrop-filter:none}.tutorial-center{width:100%;max-width:100vw;height:var(--app-visual-height,100dvh);border:0;border-radius:0}.tutorial-center>header{min-width:0;overflow:hidden;padding:max(.85rem,env(safe-area-inset-top)) .85rem .8rem}.tutorial-center>header>div{min-width:0}.tutorial-center>header h2{font-size:1.12rem}.tutorial-center>header p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.75rem}.tutorial-layout{display:flex;width:100%;max-width:100%;min-height:0;overflow:hidden;flex-direction:column}.tutorial-categories{display:flex;width:100%;max-width:100%;box-sizing:border-box;flex:0 0 auto;overflow-x:auto;border-right:0;border-bottom:1px solid var(--control-border);padding:.55rem .7rem;scrollbar-width:none}.tutorial-categories button{min-width:145px;padding:.52rem}.tutorial-categories button small{display:none}.tutorial-layout>main{width:100%;max-width:100%;box-sizing:border-box;overflow-x:hidden;padding:.8rem .75rem 1.2rem}.tutorial-grid{width:100%;max-width:100%;min-width:0;grid-template-columns:minmax(0,1fr)}.tutorial-grid article{width:100%;max-width:100%;min-width:0;box-sizing:border-box;padding:.75rem}.tutorial-start{width:100%;max-width:100%}.tutorial-card__body p{min-height:0}.tutorial-center>footer{min-width:0;padding:.55rem .75rem max(.55rem,env(safe-area-inset-bottom))}.tutorial-center>footer span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
</style>

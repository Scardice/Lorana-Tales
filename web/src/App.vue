<script setup lang="ts">
import { darkTheme, lightTheme } from "naive-ui";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Main from "./Main.vue";
import StoryPage from "./pages/StoryPage.vue";
import SspPlaybackPage from "./pages/SspPlaybackPage.vue";
import AccountPanel from "./components/story/AccountPanel.vue";
import TutorialCenter from "./components/story/TutorialCenter.vue";
import { useThemeDark } from "./composables/useTheme";
import { markOnboardingSeen, onboardingSeen } from "./story/onboarding";

type EditorMode = "story" | "legacy";
type EditorShellConfig = {
	defaultMode: EditorMode;
	storyModeEnabled: boolean;
	siteTitle: string;
	showSiteTitle: boolean;
	logoUrl: string;
	faviconUrl: string;
	communityNotice: string;
};

const isDark = useThemeDark();
const ready = ref(false);
const tutorialOpen = ref(false);
const firstTutorialPromptOpen = ref(false);
const firstTutorialPromptNeverShow = ref(false);
const legacyLinkHintOpen = ref(false);
const legacyLinkHintNeverShow = ref(false);
const tutorialRestore = ref<null | (() => void)>(null);
const playbackRoute = computed(() => /^\/play\/?$/.test(location.pathname));
const legacyCompatible = ref(true);
const legacyWarningOpen = ref(false);
const legacyDiscardStep = ref(0);
const legacyDiscarding = ref(false);
const upperBarCollapsed = ref(localStorage.getItem("scardice.upper-toolbar.collapsed") === "1");
const config = ref<EditorShellConfig>({
	defaultMode: "story",
	storyModeEnabled: true,
	siteTitle: "Lorana Tales",
	showSiteTitle: true,
	logoUrl: "",
	faviconUrl: "",
	communityNotice: "GitHub: https://github.com/Scardice/Lorana-Tales · QQ群：1080498667",
});
const requestedMode = computed<EditorMode>(() => {
	if (!config.value.storyModeEnabled) return "legacy";
	if (/^\/legacy\/?$/.test(location.pathname)) return "legacy";
	if (/^\/story\/?$/.test(location.pathname)) return "story";
	return config.value.defaultMode;
});

function switchMode(mode: EditorMode) {
	if (mode === "story" && !config.value.storyModeEnabled) return;
	if (mode === "legacy" && requestedMode.value === "story" && !legacyCompatible.value) {
		legacyDiscardStep.value = 0;
		legacyWarningOpen.value = true;
		return;
	}
	location.assign(`${mode === "story" ? "/story" : "/legacy"}${location.search}${location.hash}`);
}

function closeLegacyWarning() {
	if (legacyDiscarding.value) return;
	legacyWarningOpen.value = false;
	legacyDiscardStep.value = 0;
}

async function discardAndSwitchToLegacy() {
	if (legacyDiscardStep.value === 0) {
		legacyDiscardStep.value = 1;
		return;
	}
	legacyDiscarding.value = true;
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = window.setTimeout(() => reject(new Error("编辑器未能及时清除本地草稿")), 4000);
			window.dispatchEvent(new CustomEvent("lorana-story-discard-for-legacy", { detail: {
				resolve: () => { window.clearTimeout(timer); resolve(); },
				reject: (error: unknown) => { window.clearTimeout(timer); reject(error); },
			} }));
		});
		legacyCompatible.value = true;
		location.assign(`/legacy${location.search}${location.hash}`);
	} catch (error) {
		alert(error instanceof Error ? error.message : "无法清除当前日志的本地修改");
		legacyDiscarding.value = false;
	}
}

function setUpperBarCollapsed(value: boolean) {
	upperBarCollapsed.value = value;
	localStorage.setItem("scardice.upper-toolbar.collapsed", value ? "1" : "0");
}

function applyBranding() {
	document.title = config.value.siteTitle;
	if (!config.value.faviconUrl) return;
	let favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
	if (!favicon) {
		favicon = document.createElement("link");
		favicon.rel = "icon";
		document.head.append(favicon);
	}
	favicon.href = config.value.faviconUrl;
}

function syncVisualViewport() {
	const viewport = window.visualViewport;
	const keyboardOpen = !!viewport && window.innerHeight - viewport.height > 120;
	const height = keyboardOpen ? viewport!.height : window.innerHeight;
	document.documentElement.style.setProperty("--app-visual-height", `${Math.round(height)}px`);
}

function openTutorials(event?: Event) {
	const detail = (event as CustomEvent<{ restore?: () => void }> | undefined)?.detail;
	tutorialRestore.value = typeof detail?.restore === "function" ? detail.restore : null;
	tutorialOpen.value = true;
}

function closeTutorials() {
	tutorialOpen.value = false;
	const restore = tutorialRestore.value;
	tutorialRestore.value = null;
	if (restore) nextTick(restore);
}

async function maybePromptFirstTutorial() {
	if (playbackRoute.value || requestedMode.value !== "story" || await onboardingSeen("tutorialPromptSeen")) return;
	firstTutorialPromptNeverShow.value = false;
	firstTutorialPromptOpen.value = true;
}

async function answerFirstTutorial(open: boolean) {
	if (firstTutorialPromptNeverShow.value) await markOnboardingSeen("tutorialPromptSeen");
	firstTutorialPromptOpen.value = false;
	if (open) openTutorials();
}

async function closeLegacyLinkHint() {
	if (legacyLinkHintNeverShow.value) await markOnboardingSeen("legacyLinkHintSeen");
	legacyLinkHintOpen.value = false;
	void maybePromptFirstTutorial();
}

onMounted(async () => {
	syncVisualViewport();
	window.addEventListener("resize", syncVisualViewport);
	window.visualViewport?.addEventListener("resize", syncVisualViewport);
	window.visualViewport?.addEventListener("scroll", syncVisualViewport);
	window.addEventListener("lorana-story-compatibility", ((event: CustomEvent<{ legacyCompatible?: boolean }>) => { legacyCompatible.value = event.detail?.legacyCompatible !== false; }) as EventListener);
	window.addEventListener("lorana-open-tutorials", openTutorials);
	try {
		const response = await fetch("/api/editor/config", { cache: "no-store" });
		if (response.ok) config.value = { ...config.value, ...(await response.json()) };
	} catch (error) {
		console.warn("无法读取编辑器入口配置，使用新版默认值", error);
	} finally {
		applyBranding();
		ready.value = true;
		const linkedStory = requestedMode.value === "story" && new URLSearchParams(location.search).has("key");
		if (linkedStory && !(await onboardingSeen("legacyLinkHintSeen"))) {
			legacyLinkHintNeverShow.value = false;
			legacyLinkHintOpen.value = true;
		} else void maybePromptFirstTutorial();
	}
});

onBeforeUnmount(() => {
	window.removeEventListener("resize", syncVisualViewport);
	window.visualViewport?.removeEventListener("resize", syncVisualViewport);
	window.visualViewport?.removeEventListener("scroll", syncVisualViewport);
	window.removeEventListener("lorana-open-tutorials", openTutorials);
});
</script>

<template>
	<n-config-provider :theme="isDark ? darkTheme : lightTheme">
		<n-message-provider>
			<n-modal-provider>
				<n-notification-provider>
					<div v-if="ready" class="editor-router" :class="[playbackRoute ? 'editor-router--playback' : `editor-router--${requestedMode}`, isDark ? 'theme-dark' : 'theme-light', { 'editor-router--upper-collapsed': upperBarCollapsed }]">
						<nav v-if="!playbackRoute" v-show="!upperBarCollapsed" class="global-upperbar" aria-label="站点工具栏">
							<div id="global-account-slot" class="global-account-slot"><AccountPanel v-if="requestedMode === 'legacy'" /></div>
							<div class="global-brand-area">
								<div class="mode-toggle-wrap"><button v-if="config.storyModeEnabled" class="mode-toggle" :class="{ active: requestedMode === 'story' }" :title="requestedMode === 'story' ? '切换到经典编辑' : '切换到沉浸编辑'" @click="switchMode(requestedMode === 'story' ? 'legacy' : 'story')">
									<i><span></span></i><b>{{ requestedMode === "story" ? "沉浸" : "经典" }}</b>
								</button><Transition name="mode-warning"><aside v-if="legacyLinkHintOpen" class="anchored-hint anchored-hint--mode" role="dialog" aria-label="经典染色器提示"><p>你可以点这里回到经典染色器，但它不支持沉浸式染色器的新增功能。</p><label><input v-model="legacyLinkHintNeverShow" type="checkbox" />以后不再显示</label><button type="button" class="primary" @click="closeLegacyLinkHint">知道了</button></aside></Transition></div>
								<div class="site-brand" :title="config.siteTitle">
									<img v-if="config.logoUrl" :src="config.logoUrl" alt="" />
									<svg v-else class="site-brand__fallback" viewBox="0 0 32 32" aria-hidden="true"><path d="M7 23.5V8.8c0-1 .8-1.8 1.8-1.8h14.4c1 0 1.8.8 1.8 1.8v14.7l-4.5-3-4.5 3-4.5-3-4.5 3Z" /><path d="M11 12h10M11 16h7" /></svg>
									<strong v-if="config.showSiteTitle">{{ config.siteTitle }}</strong>
								</div>
								<button class="toolbar-fold" title="收起站点工具栏" aria-label="收起站点工具栏" @click="setUpperBarCollapsed(true)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 12 5-5 5 5" /></svg></button>
							</div>
						</nav>

						<nav v-if="!playbackRoute" class="global-workbar" aria-label="作品工具栏">
							<div id="global-title-slot" class="global-title-slot"><strong v-if="requestedMode === 'legacy'">经典染色器</strong></div>
							<div class="workbar-edge workbar-edge--right">
								<div id="global-actions-slot"></div>
								<button v-if="upperBarCollapsed" class="toolbar-expand" title="展开站点工具栏" aria-label="展开站点工具栏" @click="setUpperBarCollapsed(false)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 13 5-5 5 5" /></svg></button>
							</div>
						</nav>

						<SspPlaybackPage v-if="playbackRoute" />
						<StoryPage v-else-if="requestedMode === 'story'" :community-notice="config.communityNotice" />
						<Main v-else legacy-only :community-notice="config.communityNotice" />
						<TutorialCenter :show="tutorialOpen" @close="closeTutorials" />
						<Teleport to="body"><Transition name="mode-warning"><div v-if="firstTutorialPromptOpen" class="anchored-hint-layer first-tutorial-prompt"><section role="dialog" aria-labelledby="first-tutorial-title"><header><div><strong id="first-tutorial-title">第一次使用 Lorana Tales 吗？</strong><small>两分钟认识编辑器</small></div></header><p>要不要先看“基本使用教程”？以后也可以随时点击“更多”打开教程。</p><label><input v-model="firstTutorialPromptNeverShow" type="checkbox" />以后不再显示</label><footer><button type="button" @click="answerFirstTutorial(false)">暂时不用</button><button class="primary" type="button" @click="answerFirstTutorial(true)">看看教程</button></footer></section></div></Transition></Teleport>
						<Teleport to="body"><Transition name="mode-warning"><div v-if="legacyWarningOpen" class="mode-warning" @click.self="closeLegacyWarning"><section role="alertdialog" aria-modal="true" aria-labelledby="legacy-warning-title"><header><div><strong id="legacy-warning-title">经典模式无法读取新版编辑</strong><small>当前故事包含 Lorana Tales 新版内容</small></div><button class="mode-warning__close" type="button" aria-label="关闭" @click="closeLegacyWarning"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button></header><p>建议先从下载菜单导出“传统日志 TXT”，再到经典染色器中导入。</p><div v-if="legacyDiscardStep" class="mode-warning__danger"><strong>再次确认丢弃？</strong><span>只会删除当前日志在这个浏览器里的新版草稿；服务端原日志、已下载文件和其他工程不受影响。未导出的新版编辑无法恢复。</span></div><footer><button type="button" @click="closeLegacyWarning">返回编辑</button><button class="danger" type="button" :disabled="legacyDiscarding" @click="discardAndSwitchToLegacy">{{ legacyDiscarding ? "正在清除…" : legacyDiscardStep ? "确认丢弃并进入经典" : "丢弃新版修改" }}</button></footer></section></div></Transition></Teleport>
					</div>
				</n-notification-provider>
			</n-modal-provider>
		</n-message-provider>
	</n-config-provider>
</template>

<style scoped>
.editor-router{min-height:var(--app-visual-height,100dvh);color:var(--control-text);background:var(--app-bg)}.editor-router--story{display:grid;grid-template-rows:auto auto minmax(0,1fr);height:var(--app-visual-height,100dvh);overflow:hidden}.editor-router--story.editor-router--upper-collapsed{grid-template-rows:auto minmax(0,1fr)}.editor-router--story :deep(.story-page),.editor-router--story :deep(.story-editor){height:100%;min-height:0;overflow:hidden}.editor-router--playback{height:var(--app-visual-height,100dvh);overflow:hidden}
.global-upperbar,.global-workbar{position:relative;box-sizing:border-box;border-bottom:1px solid var(--control-border);background:var(--soft-surface);color:var(--control-text)}.global-upperbar{z-index:9100;display:grid;grid-template-columns:minmax(8rem,1fr) auto minmax(8rem,1fr);align-items:center;gap:.55rem;min-height:48px;padding:.35rem .65rem}.global-workbar{z-index:9000;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:.75rem;min-height:50px;padding:.36rem .65rem;background:var(--panel-surface)}.global-account-slot,.global-utilities,.global-brand-area,.workbar-edge{display:flex;align-items:center;min-width:0}.global-utilities{justify-content:center;gap:.4rem}.global-brand-area,.workbar-edge--right{justify-content:flex-end;gap:.35rem}.workbar-edge--right{grid-column:2}.global-title-slot{grid-column:1;display:flex;min-width:0;max-width:100%;justify-content:flex-start;text-align:left}.workbar-edge{position:relative;z-index:1}
.global-upperbar button,.global-workbar button{border:0;border-radius:9px;padding:.46rem .65rem;background:transparent;color:var(--muted-text);font:inherit;text-decoration:none;cursor:pointer}.mode-toggle{display:flex;align-items:center;gap:.42rem}.mode-toggle i{position:relative;width:34px;height:19px;border-radius:999px;background:var(--control-border);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--control-text) 8%,transparent);transition:.2s}.mode-toggle i span{position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:var(--muted-text);transition:.2s}.mode-toggle.active i{background:#167d83}.mode-toggle.active i span{left:18px;background:#fff}.mode-toggle b{color:var(--muted-text);font-size:.75rem}.mode-toggle.active b{color:var(--control-text)}.toolbar-fold svg,.toolbar-expand svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.toolbar-fold,.toolbar-expand{display:grid!important;width:36px;height:36px;padding:0!important;place-items:center;background:var(--control-surface)!important}.site-brand{display:flex;align-items:center;min-width:0;gap:.48rem}.site-brand img,.site-brand__fallback{box-sizing:border-box;width:30px;height:30px;flex:0 0 30px;border-radius:8px;object-fit:contain}.site-brand img{background:color-mix(in srgb,var(--control-text) 4%,transparent)}.site-brand__fallback{fill:none;stroke:var(--muted-text);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.site-brand strong{max-width:min(20vw,18rem);overflow:hidden;color:var(--control-text);text-overflow:ellipsis;white-space:nowrap;font-size:.84rem}
.theme-toggle{display:grid!important;width:36px;height:36px;padding:0!important;place-items:center}.theme-toggle svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.global-title-slot :deep(.story-title){display:grid;min-width:0;max-width:100%;justify-items:start;text-align:left}.global-title-slot :deep(.story-title small){color:#97a5a2;font-size:.68rem}.global-title-slot :deep(.story-title>div){display:flex;align-items:center;max-width:100%;min-width:0;gap:.2rem}.global-title-slot :deep(.story-title strong){max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workbar-edge--right #global-actions-slot,.workbar-edge--right :deep(.story-editor__header-actions){display:flex;min-width:0;gap:.3rem}
@media(max-width:650px){.global-upperbar{grid-template-columns:42px auto minmax(0,1fr);gap:.25rem;padding:.3rem .42rem}.global-account-slot :deep(.account-trigger){width:42px;padding:.3rem!important}.global-account-slot :deep(.account-trigger)>span:last-child{display:none}.global-utilities{gap:.18rem}.mode-toggle{width:36px;padding:.25rem!important}.mode-toggle i{width:30px;height:18px}.mode-toggle i span{width:12px;height:12px}.mode-toggle.active i span{left:15px}.mode-toggle b{display:none}.global-brand-area{min-width:0;gap:.18rem}.toolbar-fold{width:32px;height:32px}.site-brand{min-width:0;flex:0 1 auto;margin-left:auto;gap:.3rem}.site-brand img,.site-brand__fallback{width:27px;height:27px;flex-basis:27px;border-radius:7px}.site-brand strong{max-width:min(42vw,15rem);min-width:0;flex:0 1 auto;font-size:.7rem}.global-workbar{grid-template-columns:minmax(5.5rem,1fr) auto;gap:.25rem;min-height:48px;padding:.32rem .42rem}.global-title-slot{grid-column:1;justify-self:stretch;max-width:none;justify-content:flex-start}.global-title-slot :deep(.story-title strong){max-width:32vw}.global-title-slot :deep(.story-title small){display:block;max-width:32vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.58rem}.workbar-edge--right{grid-column:2}.workbar-edge--right :deep(.story-editor__header-actions){gap:.32rem}}
.global-upperbar{grid-template-columns:minmax(8rem,1fr) auto}.site-brand img{display:block;width:30px;height:30px;max-width:30px;max-height:30px;flex:0 0 30px;border-radius:7px;background:transparent;object-fit:contain;image-rendering:pixelated}.site-brand strong{font-weight:650;letter-spacing:.01em}@media(max-width:650px){.global-upperbar{grid-template-columns:42px minmax(0,1fr)}.site-brand img{width:27px;height:27px;max-width:27px;max-height:27px;flex-basis:27px;border-radius:6px}}
.global-upperbar{min-height:44px;padding:.25rem .55rem}.global-workbar{min-height:44px;padding:.25rem .55rem}.theme-toggle,.toolbar-fold,.toolbar-expand{width:34px;height:34px}.global-upperbar button,.global-workbar button{padding:.38rem .55rem}@media(max-width:650px){.global-upperbar{padding:.22rem .38rem}.global-workbar{min-height:42px;padding:.22rem .38rem}.theme-toggle,.toolbar-fold,.toolbar-expand{width:32px;height:32px}}
.mode-warning{position:fixed;inset:0;z-index:20000;display:grid;place-items:center;padding:1rem;background:#0009}.mode-warning section{box-sizing:border-box;width:min(470px,100%);max-height:calc(100dvh - 2rem);overflow:auto;border:1px solid var(--control-border);border-radius:16px;padding:1rem;background:var(--panel-surface);box-shadow:0 20px 60px #0007;color:var(--control-text)}.mode-warning header,.mode-warning footer{display:flex;align-items:center;gap:.65rem}.mode-warning header{justify-content:space-between}.mode-warning header>div{display:grid;gap:.12rem}.mode-warning header small,.mode-warning p,.mode-warning__danger span{color:var(--muted-text)}.mode-warning p{margin:.85rem 0;line-height:1.55}.mode-warning footer{justify-content:flex-end;margin-top:1rem}.mode-warning button{min-height:36px;border:1px solid var(--control-border);border-radius:9px;padding:.45rem .75rem;background:var(--control-surface);color:var(--control-text);font:inherit;cursor:pointer}.mode-warning button:hover{background:var(--control-hover)}.mode-warning button:disabled{opacity:.55;cursor:wait}.mode-warning button.danger{border-color:color-mix(in srgb,var(--danger-bg) 58%,var(--control-border));background:var(--danger-bg);color:var(--danger-text)}.mode-warning__close{display:grid;width:34px;min-width:34px;padding:0!important;place-items:center}.mode-warning__close svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}.mode-warning__danger{display:grid;gap:.22rem;border:1px solid color-mix(in srgb,var(--danger-bg) 45%,var(--control-border));border-radius:11px;padding:.75rem;background:color-mix(in srgb,var(--danger-bg) 11%,var(--panel-surface))}.mode-warning__danger strong{color:var(--danger-ink)}.mode-warning-enter-active,.mode-warning-leave-active{transition:opacity .18s ease}.mode-warning-enter-active section,.mode-warning-leave-active section{transition:transform .22s cubic-bezier(.2,.75,.2,1),opacity .18s ease}.mode-warning-enter-from,.mode-warning-leave-to{opacity:0}.mode-warning-enter-from section,.mode-warning-leave-to section{opacity:0;transform:translateY(12px) scale(.98)}@media(max-width:650px){.mode-warning{place-items:stretch;padding:0}.mode-warning section{width:100%;height:100%;max-height:none;border:0;border-radius:0;padding:max(1rem,env(safe-area-inset-top)) .85rem max(1rem,env(safe-area-inset-bottom));box-shadow:none}.mode-warning footer{position:sticky;bottom:0;margin:1rem -.85rem 0;padding:.8rem .85rem;background:var(--panel-surface)}.mode-warning footer button{flex:1}}
.mode-warning button.primary{border-color:var(--primary-bg);background:var(--primary-bg);color:var(--primary-text)}
.mode-toggle-wrap{position:relative}.anchored-hint{position:absolute;z-index:22000;display:grid;width:min(340px,calc(100vw - 1.5rem));gap:.65rem;border:1px solid var(--control-border);border-radius:13px;padding:.8rem;background:var(--panel-surface);box-shadow:0 16px 48px #0008;color:var(--control-text)}.anchored-hint::before{position:absolute;width:12px;height:12px;border-top:1px solid var(--control-border);border-left:1px solid var(--control-border);background:var(--panel-surface);box-shadow:-3px -3px 7px #0002;content:"";transform:rotate(45deg)}.anchored-hint--mode{top:calc(100% + .7rem);right:0;left:auto}.anchored-hint--mode::before{top:-7px;right:18px;left:auto}.anchored-hint p{margin:0;color:var(--muted-text);line-height:1.55}.anchored-hint label,.anchored-hint-layer label{display:flex;align-items:center;gap:.4rem;color:var(--muted-text);font-size:.82rem}.anchored-hint button{justify-self:end;min-height:34px;border:1px solid var(--primary-bg);border-radius:8px;padding:.35rem .7rem;background:var(--primary-bg);color:var(--primary-text)}.anchored-hint-layer{position:fixed;z-index:22000;right:12px;bottom:82px;width:min(420px,calc(100vw - 24px));pointer-events:none}.anchored-hint-layer section{position:relative;box-sizing:border-box;display:grid;gap:.65rem;border:1px solid var(--control-border);border-radius:14px;padding:.9rem;background:var(--panel-surface);box-shadow:0 18px 55px #0008;color:var(--control-text);pointer-events:auto}.anchored-hint-layer section::after{position:absolute;z-index:1;right:18px;bottom:-8px;width:14px;height:14px;border-right:1px solid var(--control-border);border-bottom:1px solid var(--control-border);background:var(--panel-surface);box-shadow:4px 4px 8px #0003;content:"";transform:rotate(45deg)}.anchored-hint-layer header>div{display:grid}.anchored-hint-layer header small,.anchored-hint-layer p{color:var(--muted-text)}.anchored-hint-layer p{margin:0;line-height:1.5}.anchored-hint-layer footer{display:flex;justify-content:flex-end;gap:.5rem}.anchored-hint-layer button{min-height:35px;border:1px solid var(--control-border);border-radius:8px;padding:.4rem .7rem;background:var(--control-surface);color:var(--control-text)}.anchored-hint-layer button.primary{border-color:var(--primary-bg);background:var(--primary-bg);color:var(--primary-text)}@media(max-width:650px){.anchored-hint--mode{position:fixed;top:52px;right:8px;left:8px;width:auto}.anchored-hint--mode::before{right:18px}.anchored-hint-layer{right:8px;bottom:76px;width:calc(100vw - 16px)}}
</style>

<style>
:root{color-scheme:light;--app-bg:#eef2f3;--panel-surface:#fff;--soft-surface:#f2f5f5;--control-bg:#fff;--control-surface:#e4e9e8;--control-hover:#d8dfde;--control-text:#172220;--muted-text:#52615e;--placeholder-text:#76827f;--control-border:#aebbb8;--focus-color:#0e747b;--selected-bg:#d6e9e7;--primary-bg:#0e747b;--primary-hover:#0b646a;--primary-text:#fff;--danger-bg:#a13f46;--danger-ink:#76252d;--danger-text:#fff;--danger-soft:#f3e1e2}
html.dark{color-scheme:dark;--app-bg:#0d1514;--panel-surface:#17201f;--soft-surface:#111817;--control-bg:#0f1615;--control-surface:#293634;--control-hover:#344340;--control-text:#edf3f2;--muted-text:#a7b4b1;--placeholder-text:#8e9b98;--control-border:#465553;--focus-color:#4bcbd2;--selected-bg:#24403d;--primary-bg:#0e747b;--primary-hover:#11828a;--primary-text:#fff;--danger-bg:#a63b43;--danger-ink:#ffb7bc;--danger-text:#fff;--danger-soft:#3a2627}
html,body,#app{font-family:Inter,"Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--app-bg);color:var(--control-text)}
body:has(.editor-router--story),body:has(.editor-router--story) #app,body:has(.editor-router--playback),body:has(.editor-router--playback) #app{height:var(--app-visual-height,100dvh);overflow:hidden}
button,input,textarea,select{font-family:inherit}
input,textarea,select{box-sizing:border-box;border-color:var(--control-border);background-color:var(--control-bg);color:var(--control-text)}
input::placeholder,textarea::placeholder{color:var(--placeholder-text);opacity:1}
input:focus-visible,textarea:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid var(--focus-color);outline-offset:2px}
input[type="number"]{appearance:textfield;-moz-appearance:textfield}
input[type="number"]::-webkit-inner-spin-button,input[type="number"]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.n-input-number .n-input__suffix,.n-input-number .n-input-number-suffix{display:none!important}
.n-input-number,.n-input{--n-color:var(--control-bg)!important;--n-color-focus:var(--control-bg)!important;--n-text-color:var(--control-text)!important;--n-border:1px solid var(--control-border)!important;--n-border-hover:1px solid var(--focus-color)!important;--n-border-focus:1px solid var(--focus-color)!important;--n-border-radius:10px!important}
.editor-router--legacy.theme-light .n-button--secondary.n-button--primary-type{--n-color:#d8ebe8!important;--n-color-hover:#c8e1dd!important;--n-color-pressed:#bad8d3!important;--n-color-focus:#d8ebe8!important;--n-text-color:#15585b!important;--n-text-color-hover:#0d4b4e!important;--n-text-color-pressed:#093f42!important;--n-text-color-focus:#0d4b4e!important;--n-border:1px solid #76a9a4!important;--n-border-hover:1px solid #397e7c!important;--n-border-pressed:1px solid #286d6c!important;--n-border-focus:1px solid #397e7c!important}
.editor-router--legacy.theme-light .n-checkbox .n-checkbox__label,.editor-router--legacy.theme-light .n-text{color:var(--home-ink,#17202a)}
</style>

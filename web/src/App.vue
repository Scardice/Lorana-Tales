<script setup lang="ts">
import { darkTheme, lightTheme } from "naive-ui";
import { computed, onMounted, ref } from "vue";
import Main from "./Main.vue";
import StoryPage from "./pages/StoryPage.vue";
import { useThemeDark } from "./composables/useTheme";

type EditorMode = "story" | "legacy";
type EditorShellConfig = {
	defaultMode: EditorMode;
	storyModeEnabled: boolean;
	siteTitle: string;
	logoUrl: string;
	faviconUrl: string;
};

const isDark = useThemeDark();
const ready = ref(false);
const legacyCompatible = ref(true);
const upperBarCollapsed = ref(localStorage.getItem("scardice.upper-toolbar.collapsed") === "1");
const config = ref<EditorShellConfig>({
	defaultMode: "story",
	storyModeEnabled: true,
	siteTitle: "Lorana Tales",
	logoUrl: "",
	faviconUrl: "",
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
		alert("这个故事已经包含 Lorana Tales 新版编辑内容，经典染色器无法无损读取。请先在下载菜单导出“传统日志 TXT”，再到经典染色器中导入。");
		return;
	}
	location.assign(`${mode === "story" ? "/story" : "/legacy"}${location.search}${location.hash}`);
}

function toggleTheme() {
	isDark.value = !isDark.value;
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

onMounted(async () => {
	window.addEventListener("lorana-story-compatibility", ((event: CustomEvent<{ legacyCompatible?: boolean }>) => { legacyCompatible.value = event.detail?.legacyCompatible !== false; }) as EventListener);
	try {
		const response = await fetch("/api/editor/config", { cache: "no-store" });
		if (response.ok) config.value = { ...config.value, ...(await response.json()) };
	} catch (error) {
		console.warn("无法读取编辑器入口配置，使用新版默认值", error);
	} finally {
		applyBranding();
		ready.value = true;
	}
});
</script>

<template>
	<n-config-provider :theme="isDark ? darkTheme : lightTheme">
		<n-message-provider>
			<n-modal-provider>
				<n-notification-provider>
					<div v-if="ready" class="editor-router" :class="[`editor-router--${requestedMode}`, isDark ? 'theme-dark' : 'theme-light', { 'editor-router--upper-collapsed': upperBarCollapsed }]">
						<nav v-show="!upperBarCollapsed" class="global-upperbar" aria-label="站点工具栏">
							<div id="global-account-slot" class="global-account-slot"></div>
							<div class="global-brand-area">
								<button class="theme-toggle" :title="isDark ? '切换到日间模式' : '切换到夜间模式'" :aria-label="isDark ? '切换到日间模式' : '切换到夜间模式'" @click="toggleTheme"><svg v-if="isDark" viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 12.8A6.2 6.2 0 0 1 7.2 4.5 6.2 6.2 0 1 0 15.5 12.8Z"/></svg><svg v-else viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.2"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4"/></svg></button>
								<button v-if="config.storyModeEnabled" class="mode-toggle" :class="{ active: requestedMode === 'story' }" :title="requestedMode === 'story' ? '切换到经典编辑' : '切换到沉浸编辑'" @click="switchMode(requestedMode === 'story' ? 'legacy' : 'story')">
									<i><span></span></i><b>{{ requestedMode === "story" ? "沉浸" : "经典" }}</b>
								</button>
								<div class="site-brand" :title="config.siteTitle">
									<img v-if="config.logoUrl" :src="config.logoUrl" alt="" />
									<svg v-else class="site-brand__fallback" viewBox="0 0 32 32" aria-hidden="true"><path d="M7 23.5V8.8c0-1 .8-1.8 1.8-1.8h14.4c1 0 1.8.8 1.8 1.8v14.7l-4.5-3-4.5 3-4.5-3-4.5 3Z" /><path d="M11 12h10M11 16h7" /></svg>
									<strong>{{ config.siteTitle }}</strong>
								</div>
								<button class="toolbar-fold" title="收起站点工具栏" aria-label="收起站点工具栏" @click="setUpperBarCollapsed(true)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 12 5-5 5 5" /></svg></button>
							</div>
						</nav>

						<nav class="global-workbar" aria-label="作品工具栏">
							<div class="workbar-edge workbar-edge--left"></div>
							<div id="global-title-slot" class="global-title-slot"><strong v-if="requestedMode === 'legacy'">经典染色器</strong></div>
							<div class="workbar-edge workbar-edge--right">
								<div id="global-actions-slot"></div>
								<button v-if="upperBarCollapsed" class="toolbar-expand" title="展开站点工具栏" aria-label="展开站点工具栏" @click="setUpperBarCollapsed(false)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 13 5-5 5 5" /></svg></button>
							</div>
						</nav>

						<StoryPage v-if="requestedMode === 'story'" />
						<Main v-else legacy-only />
					</div>
				</n-notification-provider>
			</n-modal-provider>
		</n-message-provider>
	</n-config-provider>
</template>

<style scoped>
.editor-router{min-height:100dvh;color:var(--control-text);background:var(--app-bg)}.editor-router--story{display:grid;grid-template-rows:auto auto minmax(0,1fr);height:100dvh;overflow:hidden}.editor-router--story.editor-router--upper-collapsed{grid-template-rows:auto minmax(0,1fr)}.editor-router--story :deep(.story-page),.editor-router--story :deep(.story-editor){height:100%;min-height:0;overflow:hidden}
.global-upperbar,.global-workbar{position:relative;box-sizing:border-box;border-bottom:1px solid #ffffff10;background:#111817}.global-upperbar{z-index:9100;display:grid;grid-template-columns:minmax(8rem,1fr) auto minmax(8rem,1fr);align-items:center;gap:.55rem;min-height:48px;padding:.35rem .65rem}.global-workbar{z-index:9000;display:grid;grid-template-columns:minmax(7.5rem,1fr) minmax(0,2fr) minmax(7.5rem,1fr);align-items:center;gap:.45rem;min-height:50px;padding:.36rem .65rem;background:#17201f}.global-account-slot,.global-utilities,.global-brand-area,.workbar-edge{display:flex;align-items:center;min-width:0}.global-utilities{justify-content:center;gap:.4rem}.global-brand-area,.workbar-edge--right{justify-content:flex-end;gap:.35rem}.workbar-edge--left{grid-column:1;justify-content:flex-start}.workbar-edge--right{grid-column:3}.global-title-slot{position:absolute;left:50%;z-index:0;display:flex;min-width:0;max-width:42vw;justify-content:center;transform:translateX(-50%);text-align:center}.workbar-edge{position:relative;z-index:1}
.global-upperbar button,.global-workbar button{border:0;border-radius:9px;padding:.46rem .65rem;background:transparent;color:#aeb9b7;font:inherit;text-decoration:none;cursor:pointer}.mode-toggle{display:flex;align-items:center;gap:.42rem}.mode-toggle i{position:relative;width:34px;height:19px;border-radius:999px;background:#3a4543;box-shadow:inset 0 0 0 1px #ffffff14;transition:.2s}.mode-toggle i span{position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:#aeb9b7;transition:.2s}.mode-toggle.active i{background:#167d83}.mode-toggle.active i span{left:18px;background:#fff}.mode-toggle b{color:#aeb9b7;font-size:.75rem}.mode-toggle.active b{color:#d9f7f4}.toolbar-fold svg,.toolbar-expand svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.toolbar-fold,.toolbar-expand{display:grid!important;width:36px;height:36px;padding:0!important;place-items:center;background:#202a29!important}.site-brand{display:flex;align-items:center;min-width:0;gap:.48rem}.site-brand img,.site-brand__fallback{box-sizing:border-box;width:30px;height:30px;flex:0 0 30px;border-radius:8px;object-fit:contain}.site-brand img{background:#ffffff08}.site-brand__fallback{fill:none;stroke:#8fa09d;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.site-brand strong{max-width:min(20vw,18rem);overflow:hidden;color:#dce5e3;text-overflow:ellipsis;white-space:nowrap;font-size:.84rem}
.theme-toggle{display:grid!important;width:36px;height:36px;padding:0!important;place-items:center}.theme-toggle svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.global-title-slot :deep(.story-title){display:grid;min-width:0;justify-items:center}.global-title-slot :deep(.story-title small){color:#97a5a2;font-size:.68rem}.global-title-slot :deep(.story-title>div){display:flex;align-items:center;gap:.2rem;min-width:0}.workbar-edge--right #global-actions-slot,.workbar-edge--right :deep(.story-editor__header-actions){display:flex;min-width:0;gap:.3rem}
@media(max-width:650px){.global-upperbar{grid-template-columns:42px minmax(48px,1fr) minmax(0,1.35fr);gap:.25rem;padding:.3rem .42rem}.global-account-slot :deep(.account-trigger){width:42px;padding:.3rem!important}.global-account-slot :deep(.account-trigger)>span:last-child{display:none}.global-utilities{gap:.18rem}.mode-toggle{width:36px;padding:.25rem!important}.mode-toggle i{width:30px;height:18px}.mode-toggle i span{width:12px;height:12px}.mode-toggle.active i span{left:15px}.mode-toggle b{display:none}.global-brand-area{gap:.18rem}.toolbar-fold{width:32px;height:32px}.site-brand{gap:.3rem}.site-brand img,.site-brand__fallback{width:27px;height:27px;flex-basis:27px;border-radius:7px}.site-brand strong{max-width:18vw;font-size:.7rem}.global-workbar{grid-template-columns:minmax(5.5rem,1fr) auto;gap:.25rem;min-height:48px;padding:.32rem .42rem}.workbar-edge--left{display:none}.global-title-slot{position:static;grid-column:1;justify-self:stretch;max-width:none;justify-content:center;transform:none}.global-title-slot :deep(.story-title strong){max-width:32vw}.global-title-slot :deep(.story-title small){display:none}.workbar-edge--right{grid-column:2}.workbar-edge--right :deep(.story-editor__header-actions){gap:.32rem}}
.global-upperbar{grid-template-columns:minmax(8rem,1fr) auto}.site-brand img{display:block;width:auto;max-width:min(22vw,180px);height:auto;max-height:30px;flex:0 1 auto;border-radius:0;background:transparent;object-fit:contain}@media(max-width:650px){.global-upperbar{grid-template-columns:42px minmax(0,1fr)}.site-brand img{width:auto;max-width:24vw;height:auto;max-height:27px;flex-basis:auto;border-radius:0}}
</style>

<style>
:root{color-scheme:light;--app-bg:#eef2f3;--panel-surface:#fff;--soft-surface:#f2f5f5;--control-bg:#fff;--control-surface:#e4e9e8;--control-hover:#d8dfde;--control-text:#172220;--muted-text:#667572;--placeholder-text:#87938f;--control-border:#b8c4c1;--focus-color:#168a92}
html.dark{color-scheme:dark;--app-bg:#0d1514;--panel-surface:#17201f;--soft-surface:#111817;--control-bg:#0f1615;--control-surface:#293634;--control-hover:#344340;--control-text:#edf3f2;--muted-text:#97a5a2;--placeholder-text:#7e8c89;--control-border:#465553;--focus-color:#38bfc8}
html,body,#app{font-family:Inter,"Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--app-bg);color:var(--control-text)}
button,input,textarea,select{font-family:inherit}
input,textarea,select{box-sizing:border-box;border-color:var(--control-border);background-color:var(--control-bg);color:var(--control-text)}
input::placeholder,textarea::placeholder{color:var(--placeholder-text);opacity:1}
input:focus-visible,textarea:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid var(--focus-color);outline-offset:2px}
input[type="number"]{appearance:textfield;-moz-appearance:textfield}
input[type="number"]::-webkit-inner-spin-button,input[type="number"]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.n-input-number .n-input__suffix,.n-input-number .n-input-number-suffix{display:none!important}
.n-input-number,.n-input{--n-color:var(--control-bg)!important;--n-color-focus:var(--control-bg)!important;--n-text-color:var(--control-text)!important;--n-border:1px solid var(--control-border)!important;--n-border-hover:1px solid var(--focus-color)!important;--n-border-focus:1px solid var(--focus-color)!important;--n-border-radius:10px!important}
</style>

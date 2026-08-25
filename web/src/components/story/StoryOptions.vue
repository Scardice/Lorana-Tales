<template>
  <section class="story-options">
    <header>
      <div><strong>沉浸式高级编辑</strong><p>聊天式编辑、角色头像、演出预览与可继续编辑的 SSP 工程包。</p></div>
      <n-switch :value="model.enabled" @update:value="set('enabled', $event)" />
    </header>
    <div v-if="model.enabled" class="story-options__grid">
      <label><n-switch :value="model.mergeMessages" @update:value="set('mergeMessages', $event)" />融合连续消息</label>
      <label><n-switch :value="model.mergeNarration" @update:value="set('mergeNarration', $event)" />融合旁白</label>
      <label><n-switch :value="model.showAvatars" @update:value="set('showAvatars', $event)" />显示头像</label>
      <label><n-switch :value="model.showNarratorAvatar" @update:value="set('showNarratorAvatar', $event)" />旁白小头像</label>
      <label><n-switch :value="model.showNames" @update:value="set('showNames', $event)" />显示角色名</label>
      <label><n-switch :value="model.showTime" @update:value="set('showTime', $event)" />显示时间</label>
      <label><n-switch :value="model.showQqInEditor" @update:value="set('showQqInEditor', $event)" />编辑时显示 QQ 号</label>
      <label><n-switch :value="model.showQqInPreview" @update:value="set('showQqInPreview', $event)" />预览时显示 QQ 号</label>
      <label><n-switch :value="model.previewOnly" @update:value="set('previewOnly', $event)" />隐藏编辑按钮</label>
      <label>头像位置<n-select :value="model.avatarAlignment" :options="avatarOptions" @update:value="set('avatarAlignment', $event)" /></label>
      <label>主题<n-select :value="model.theme" :options="themeOptions" @update:value="set('theme', $event)" /></label>
      <label>显示密度<n-select :value="model.density" :options="densityOptions" @update:value="set('density', $event)" /></label>
      <label>字号 <n-input-number :value="model.fontSize" :min="12" :max="28" @update:value="set('fontSize', $event || 16)" /></label>
      <label>气泡宽度 <n-slider :value="model.bubbleMaxWidth" :min="48" :max="96" @update:value="set('bubbleMaxWidth', $event)" /></label>
      <label>画布宽度 <n-slider :value="model.canvasWidth" :min="360" :max="1200" :step="20" @update:value="set('canvasWidth', $event)" /></label>
      <label>动画<n-select :value="model.animation" :options="animationOptions" @update:value="set('animation', $event)" /></label>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { StorySettings } from "~/story/types";
const props = defineProps<{ model: StorySettings }>();
const emit = defineEmits<{ change: [StorySettings] }>();
const avatarOptions = [{ label: "靠上", value: "top" }, { label: "靠下", value: "bottom" }];
const themeOptions = [{ label: "跟随系统", value: "auto" }, { label: "浅色", value: "light" }, { label: "深色", value: "dark" }];
const densityOptions = [{ label: "紧凑", value: "compact" }, { label: "舒适", value: "comfortable" }, { label: "宽松", value: "spacious" }];
const animationOptions = [{ label: "滑入淡入", value: "slide-fade" }, { label: "淡入", value: "fade" }, { label: "无动画", value: "none" }];
function set<K extends keyof StorySettings>(key: K, value: StorySettings[K]) { emit("change", { ...props.model, [key]: value }); }
</script>

<style scoped>
.story-options{margin:1rem 0;padding:1rem;border:1px solid rgba(100,116,139,.22);border-radius:18px;background:linear-gradient(135deg,rgba(59,130,246,.08),rgba(168,85,247,.06))}.story-options header{display:flex;align-items:center;justify-content:space-between;gap:1rem}.story-options h3,.story-options p{margin:0}.story-options p{font-size:.82rem;opacity:.65;margin-top:.2rem}.story-options__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.8rem;margin-top:1rem}.story-options__grid label{display:flex;align-items:center;gap:.55rem;min-height:34px;font-size:.88rem}.story-options__grid :deep(.n-select),.story-options__grid :deep(.n-input-number),.story-options__grid :deep(.n-slider){flex:1;min-width:0}@media(max-width:560px){.story-options{border-radius:14px}.story-options__grid{grid-template-columns:1fr}}
</style>

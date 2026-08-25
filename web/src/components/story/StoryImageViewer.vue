<template>
  <Teleport to="body">
    <Transition name="viewer">
    <div
      v-if="show"
      class="image-viewer"
      :class="{ 'image-viewer--bar-hidden': barHidden }"
      role="dialog"
      aria-modal="true"
      :aria-label="alt || '图片预览'"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
    >
      <header>
        <button type="button" aria-label="关闭图片预览" @click="$emit('close')">✕</button>
        <strong>{{ alt || '图片预览' }}</strong>
        <span>{{ Math.round(scale * 100) }}%</span>
      </header>
      <main @click.self="$emit('close')">
        <img
          :src="src"
          :alt="alt || '图片预览'"
          :style="imageStyle"
          draggable="false"
          @dblclick="toggleZoom"
        />
      </main>
      <nav aria-label="图片缩放">
        <button type="button" aria-label="缩小" @click="zoom(-0.25)">−</button>
        <button type="button" @click="reset">适应</button>
        <button type="button" aria-label="放大" @click="zoom(0.25)">＋</button>
      </nav>
    </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  show: boolean;
  src: string;
  alt?: string;
  canvasWidth: number;
  autoCloseMs?: number;
}>();
const emit = defineEmits<{ close: [] }>();

const scale = ref(1);
const barHidden = ref(false);
let pointerStartY = 0;
let timer = 0;

const imageStyle = computed(() => ({
  "--viewer-canvas-width": `${props.canvasWidth}px`,
  transform: `scale(${scale.value})`,
}));

function zoom(delta: number) {
  scale.value = Math.min(4, Math.max(0.5, Number((scale.value + delta).toFixed(2))));
}

function reset() {
  scale.value = 1;
}

function toggleZoom() {
  scale.value = scale.value > 1 ? 1 : 2;
}

function onWheel(event: WheelEvent) {
  zoom(event.deltaY < 0 ? 0.15 : -0.15);
}

function onPointerDown(event: PointerEvent) {
  pointerStartY = event.clientY;
}

function onPointerUp(event: PointerEvent) {
  const distance = event.clientY - pointerStartY;
  if (distance < -40) barHidden.value = true;
  if (distance > 40) barHidden.value = false;
}

function stopTimer() {
  window.clearTimeout(timer);
}

watch(
  () => [props.show, props.src, props.autoCloseMs] as const,
  ([show]) => {
    stopTimer();
    reset();
    barHidden.value = false;
    if (show && props.autoCloseMs && props.autoCloseMs > 0) {
      timer = window.setTimeout(() => emit("close"), props.autoCloseMs);
    }
  },
  { immediate: true },
);

onBeforeUnmount(stopTimer);
</script>

<style scoped>
.image-viewer {
  position: fixed;
  inset: 0;
  z-index: 10100;
  display: grid;
  grid-template-rows: auto 1fr auto;
  background: rgb(5 9 9 / 96%);
  color: #eef2f1;
}

.viewer-enter-active,
.viewer-leave-active {
  transition: opacity 180ms ease;
}

.viewer-enter-active img,
.viewer-leave-active img {
  transition: transform 220ms cubic-bezier(.2,.8,.2,1), opacity 180ms ease;
}

.viewer-enter-from,
.viewer-leave-to {
  opacity: 0;
}

.viewer-enter-from img {
  opacity: 0;
  transform: translateY(18px) scale(.96) !important;
}

.viewer-leave-to img {
  opacity: 0;
  transform: translateY(10px) scale(.98) !important;
}

.image-viewer header,
.image-viewer nav {
  z-index: 1;
  display: grid;
  align-items: center;
  gap: 0.75rem;
  padding: max(0.65rem, env(safe-area-inset-top)) 1rem 0.65rem;
  background: #17201f;
  transition: transform 180ms ease;
}

.image-viewer header {
  grid-template-columns: auto 1fr auto;
}

.image-viewer nav {
  grid-template-columns: repeat(3, auto);
  justify-content: center;
  padding: 0.55rem 1rem max(0.55rem, env(safe-area-inset-bottom));
}

.image-viewer button {
  border: 1px solid #43514f;
  border-radius: 10px;
  padding: 0.5rem 0.75rem;
  background: #293432;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.image-viewer main {
  display: grid;
  place-items: center;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 1rem;
}

.image-viewer img {
  display: block;
  width: auto;
  height: auto;
  max-width: min(var(--viewer-canvas-width), calc(100vw - 2rem));
  max-height: calc(100vh - 9rem);
  object-fit: contain;
  transform-origin: center;
  transition: transform 120ms ease;
  user-select: none;
}

@media (max-width: 650px) {
  .image-viewer {
    grid-template-rows: auto 1fr;
  }

  .image-viewer nav {
    display: none;
  }

  .image-viewer main {
    padding: 0;
  }

  .image-viewer img {
    max-width: 100vw;
    max-height: 100vh;
  }

  .image-viewer--bar-hidden {
    grid-template-rows: 0 1fr;
  }

  .image-viewer--bar-hidden header {
    transform: translateY(-100%);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .viewer-enter-active,
  .viewer-leave-active,
  .viewer-enter-active img,
  .viewer-leave-active img {
    transition-duration: 1ms;
  }
}
</style>

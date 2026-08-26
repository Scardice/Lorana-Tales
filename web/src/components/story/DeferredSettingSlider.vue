<template>
	<label class="deferred-setting-slider">
		<span>{{ label }}</span>
		<n-slider
			v-model:value="localValue"
			:min="min"
			:max="max"
			:step="step"
			@dragstart="beginDrag"
			@dragend="finishDrag"
			@update:value="previewValue"
		/>
		<span>{{ localValue }}{{ unit }}</span>
	</label>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";

const props = withDefaults(defineProps<{
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	unit?: string;
}>(), { step: 1, unit: "" });

const emit = defineEmits<{
	preview: [value: number];
	commit: [value: number];
}>();

const localValue = ref(props.value);
let dragging = false;
let previewFrame = 0;
let commitTimer = 0;
let ignoreCommitUntil = 0;

function clampedValue(value: number) {
	return Math.min(props.max, Math.max(props.min, value));
}

watch(() => [props.value, props.min, props.max] as const, ([value]) => {
	if (!dragging) localValue.value = clampedValue(value);
}, { immediate: true });

function flushPreview() {
	if (previewFrame) cancelAnimationFrame(previewFrame);
	previewFrame = 0;
	emit("preview", localValue.value);
}

function previewValue() {
	if (!previewFrame) {
		previewFrame = requestAnimationFrame(() => {
			previewFrame = 0;
			emit("preview", localValue.value);
		});
	}
	if (!dragging && performance.now() >= ignoreCommitUntil) {
		clearTimeout(commitTimer);
		commitTimer = window.setTimeout(() => emit("commit", localValue.value), 220);
	}
}

function beginDrag() {
	dragging = true;
	clearTimeout(commitTimer);
}

function finishDrag() {
	dragging = false;
	ignoreCommitUntil = performance.now() + 320;
	clearTimeout(commitTimer);
	flushPreview();
	emit("commit", localValue.value);
}

onBeforeUnmount(() => {
	clearTimeout(commitTimer);
	if (previewFrame) cancelAnimationFrame(previewFrame);
});
</script>

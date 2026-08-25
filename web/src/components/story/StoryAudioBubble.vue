<template>
  <button class="audio-bubble" type="button" :aria-label="playing?'暂停语音':'播放语音'" @click.stop="toggle">
    <span class="audio-play">{{ playing ? 'Ⅱ' : '▶' }}</span>
    <span class="audio-wave" aria-hidden="true"><i v-for="(height,index) in bars" :key="index" :style="{height:`${height}%`}"></i></span>
    <span class="audio-duration">{{ durationText }}</span>
	<audio ref="audio" :src="src" preload="metadata" @loadedmetadata="metadata" @error="$emit('error')" @play="playing=true" @pause="playing=false" @ended="playing=false"></audio>
  </button>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
const props=defineProps<{src:string;durationMs?:number;seed?:string}>();const audio=ref<HTMLAudioElement>();const playing=ref(false);const measuredDuration=ref(0);
defineEmits<{error:[]}>();
const bars=computed(()=>{let hash=2166136261;for(const value of props.seed||props.src){hash^=value.charCodeAt(0);hash=Math.imul(hash,16777619)}return Array.from({length:18},(_,index)=>28+Math.abs(Math.sin((hash%97+index*17)*.17))*68)});
const durationText=computed(()=>{const seconds=Math.max(0,Math.round((props.durationMs||measuredDuration.value)/1000));return `${seconds||1}″`});
function metadata(){if(audio.value&&Number.isFinite(audio.value.duration))measuredDuration.value=audio.value.duration*1000}
async function toggle(){if(!audio.value)return;if(playing.value){audio.value.pause();return}document.querySelectorAll<HTMLAudioElement>('audio').forEach(item=>{if(item!==audio.value)item.pause()});try{await audio.value.play()}catch{playing.value=false}}
onBeforeUnmount(()=>audio.value?.pause());
</script>

<style scoped>
.audio-bubble{display:flex!important;align-items:center;gap:.55rem;min-width:190px;padding:.55rem .7rem!important;border:0!important;border-radius:14px!important;background:color-mix(in srgb,currentColor,transparent 91%)!important;color:inherit!important}.audio-play{display:grid;width:30px;height:30px;place-items:center;border-radius:50%;background:color-mix(in srgb,currentColor,transparent 84%);font-size:.72rem}.audio-wave{display:flex;align-items:center;gap:2px;width:82px;height:24px}.audio-wave i{width:2px;min-height:3px;border-radius:999px;background:currentColor;opacity:.9}.audio-duration{font-size:.78rem;font-variant-numeric:tabular-nums}.audio-bubble audio{display:none}
</style>

<template><div ref="root" class="interaction-stage" :data-paused="paused" v-html="markup"></div></template>
<script setup lang="ts">
import { computed, onMounted, ref, watch, nextTick } from 'vue';
import { interactionMarkup, type InteractionVisual } from '~/story/interaction-stage';
import { INTERACTION_CSS } from '~/story/interaction-style';
const props=defineProps<{visual:InteractionVisual;paused?:boolean;rate?:number}>();
const root=ref<HTMLElement>();
const markup=computed(()=>interactionMarkup(props.visual));
onMounted(()=>{if(!document.getElementById('lorana-interaction-style')){const style=document.createElement('style');style.id='lorana-interaction-style';style.textContent=INTERACTION_CSS;document.head.append(style);}});
function syncRate(){for(const animation of root.value?.getAnimations({subtree:true})||[])animation.playbackRate=props.rate||1;}
onMounted(()=>nextTick(syncRate));watch(()=>[props.rate,markup.value],()=>nextTick(syncRate));
</script>
<style scoped>
.interaction-stage{position:absolute;inset:0;pointer-events:none}
.interaction-stage[data-paused=true] :deep(*){animation-play-state:paused!important}
</style>

<template>
  <div ref="editor" class="story-composer-input" contenteditable="true" role="textbox" aria-multiline="true"
    :aria-label="placeholder" :data-placeholder="placeholder" spellcheck="true"
    @beforeinput="rememberSelection" @input="handleInput" @keydown="emit('keydown', $event)"
    @keyup="emit('keyup', $event)" @mouseup="rememberSelection" @touchend="rememberSelection"
    @blur="rememberSelection" @paste.prevent="pastePlainText" />
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";

const props = withDefaults(defineProps<{ modelValue: string; placeholder?: string }>(), { placeholder: "请输入文本" });
const emit = defineEmits<{ "update:modelValue": [value: string]; input: [event: Event]; keydown: [event: KeyboardEvent]; keyup: [event: KeyboardEvent] }>();
const editor = ref<HTMLElement>();
let savedRange: Range | null = null;
let syncing = false;
const facePattern = /\[CQ:face\s*,\s*id=(\d+)[^\]]*\]/gi;
const faceToken = (id: string) => `[CQ:face,id=${id}]`;

function nodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (!(node instanceof HTMLElement)) return "";
  if (node.matches("img[data-cq-face]")) return faceToken(node.dataset.cqFace || "0");
  if (node.tagName === "BR") return "\n";
  const value = Array.from(node.childNodes, nodeText).join("");
  return /^(DIV|P)$/.test(node.tagName) ? `${value}\n` : value;
}
function serialize() {
  const value = editor.value ? Array.from(editor.value.childNodes, nodeText).join("") : "";
  return value.replace(/\n$/, "");
}
function appendModelFragment(target: DocumentFragment, value: string) {
  let cursor = 0;
  facePattern.lastIndex = 0;
  for (let match = facePattern.exec(value); match; match = facePattern.exec(value)) {
    if (match.index > cursor) target.append(document.createTextNode(value.slice(cursor, match.index)));
    const image = document.createElement("img");
    image.dataset.cqFace = match[1]; image.src = `/api/editor/cq-face/${match[1]}`; image.alt = `QQ 表情 ${match[1]}`;
    image.draggable = false; image.contentEditable = "false"; target.append(image);
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) target.append(document.createTextNode(value.slice(cursor)));
}
function render(value: string) {
  const root = editor.value;
  if (!root || serialize() === value) return;
  const fragment = document.createDocumentFragment(); appendModelFragment(fragment, value);
  syncing = true; root.replaceChildren(fragment); syncing = false; resize();
}
function selectionInsideEditor(range: Range | null) {
  const root = editor.value; return !!(root && range && root.contains(range.commonAncestorContainer));
}
function rememberSelection() {
  const selection = getSelection();
  if (selection?.rangeCount) { const range = selection.getRangeAt(0); if (selectionInsideEditor(range)) savedRange = range.cloneRange(); }
}
function insertionRange() {
  const root = editor.value; if (!root) return null;
  const selection = getSelection(); let range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!selectionInsideEditor(range)) range = selectionInsideEditor(savedRange) ? savedRange : null;
  if (!range) { range = document.createRange(); range.selectNodeContents(root); range.collapse(false); }
  return range;
}
function commitDomChange(event = new Event("input")) {
  rememberSelection(); emit("update:modelValue", serialize()); emit("input", event); resize();
}
function insertNode(node: Node) {
  const range = insertionRange(); if (!editor.value || !range) return;
  range.deleteContents(); range.insertNode(node); range.setStartAfter(node); range.collapse(true);
  const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range); savedRange = range.cloneRange(); commitDomChange();
}
function insertText(value: string) { insertNode(document.createTextNode(value)); }
function insertToken(token: string) {
  const match = token.match(/\[CQ:face\s*,\s*id=(\d+)/i); if (!match) return insertText(token);
  const image = document.createElement("img"); image.dataset.cqFace = match[1]; image.src = `/api/editor/cq-face/${match[1]}`;
  image.alt = `QQ 表情 ${match[1]}`; image.draggable = false; image.contentEditable = "false"; insertNode(image);
}
function insertNewline() { insertText("\n"); }
function pastePlainText(event: ClipboardEvent) { insertText(event.clipboardData?.getData("text/plain") || ""); }
function handleInput(event: Event) { if (!syncing) commitDomChange(event); }
function resize() {
  const root = editor.value; if (!root) return;
  const style = getComputedStyle(root); const fontSize = Number.parseFloat(style.fontSize) || 16;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.4;
  const chrome = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0) + (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
  const maximum = Math.ceil(lineHeight * 5 + chrome); root.style.height = "0px"; root.style.overflowY = "hidden";
  const natural = Math.max(40, root.scrollHeight); root.style.maxHeight = `${maximum}px`; root.style.height = `${Math.min(natural, maximum)}px`;
  root.style.overflowY = natural > maximum ? "auto" : "hidden"; if (!serialize()) root.scrollTop = 0;
}
function focus() { editor.value?.focus(); }
function blur() { editor.value?.blur(); }
watch(() => props.modelValue, value => nextTick(() => render(value)));
onMounted(() => render(props.modelValue));
defineExpose({ focus, blur, insertText, insertToken, insertNewline, resize });
</script>

<style scoped>
.story-composer-input{box-sizing:border-box;width:100%;min-width:0;min-height:40px;padding:.5rem .72rem;overflow-x:hidden;overflow-y:hidden;border:1px solid var(--control-border);border-radius:12px;outline:0;background:var(--control-bg);color:var(--control-text);font:inherit;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
.story-composer-input:focus{border-color:var(--focus-color);box-shadow:0 0 0 2px color-mix(in srgb,var(--focus-color) 20%,transparent)}
.story-composer-input:empty::before{content:attr(data-placeholder);color:var(--placeholder-text);pointer-events:none}
.story-composer-input :deep(img[data-cq-face]){display:inline-block;width:1.35em;height:1.35em;margin:0 .08em;vertical-align:-.28em;object-fit:contain}
.story-composer-input::-webkit-scrollbar{width:8px}.story-composer-input::-webkit-scrollbar-track{background:transparent}.story-composer-input::-webkit-scrollbar-thumb{border:2px solid transparent;border-radius:999px;background:var(--muted-text);background-clip:padding-box}
</style>

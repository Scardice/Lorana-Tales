<template>
	<section class="story-script-editor" :class="{ 'story-script-editor--error': error }">
		<nav class="story-script-editor__mobile-tools" aria-label="故事语言快捷输入">
			<button type="button" class="completion-trigger" @click="triggerCompletion">补全</button>
			<button v-for="snippet in mobileSnippets" :key="snippet.label" type="button" @click="insertSnippet(snippet.apply, snippet.cursor)">{{ snippet.label }}</button>
		</nav>
		<div ref="host" class="story-script-editor__host"></div>
	</section>
</template>

<script setup lang="ts">
import { acceptCompletion, autocompletion, completionKeymap, type CompletionContext, type CompletionResult, startCompletion } from "@codemirror/autocomplete";
import { history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ modelValue: string; error?: string; focusRequest?: { position: number; nonce: number } }>();
const emit = defineEmits<{ "update:modelValue": [string] }>();
const host = ref<HTMLElement>();
let view: EditorView | undefined;

const mobileSnippets = [
	{ label: "<msg>", apply: '<msg by="">\n  \n</msg>', cursor: 11 },
	{ label: "<role>", apply: '<role id="" name="" side="left" palette="neutral" bubble="" />', cursor: 10 },
	{ label: "<time>", apply: '<time duration="2000ms" />', cursor: 16 },
	{ label: "<wt>", apply: "<wt:100ms><wt/>", cursor: 4 },
	{ label: "<set>", apply: '<set name="" value="" />', cursor: 11 },
	{ label: "叠加", apply: '<effects>\n  <effect id="" delay="0ms" screen="damage" screen-color="red" />\n  <msg by="">\n    \n  </msg>\n</effects>', cursor: 28 },
	{ label: "区间始", apply: '<effect-start id="" type="rain-glass" color="cyan" intensity="100%" opacity="70%" speed="100%" />', cursor: 18 },
	{ label: "区间终", apply: '<effect-end id="" />', cursor: 16 },
];

function roleIds(source: string) {
	return [...source.matchAll(/<role\s+[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
}

function storyCompletions(context: CompletionContext): CompletionResult | null {
	const prefix = context.matchBefore(/(?:<\/?[\w-]*|[\w-]*)/);
	if (!context.explicit && (!prefix || prefix.from === prefix.to)) return null;
	const options = [
		{ label: "<story>", type: "keyword", detail: "故事标题", apply: '<story title="">', boost: 99 },
		{ label: "<role>", type: "keyword", detail: "定义角色", apply: '<role id="" name="" side="left" palette="neutral" bubble="" />', boost: 98 },
		{ label: "<msg>", type: "keyword", detail: "消息块", apply: '<msg by="">\n  \n</msg>', boost: 100 },
		{ label: "<effects>", type: "keyword", detail: "包裹一条消息的叠加特效", apply: '<effects>\n  <effect id="" delay="0ms" screen="damage" screen-color="red" />\n  <msg by="">\n    \n  </msg>\n</effects>', boost: 99 },
		{ label: "<set>", type: "keyword", detail: "全局配置", apply: '<set name="" value="" />' },
		{ label: "<time>", type: "keyword", detail: "完整显示后停留", apply: '<time duration="2000ms" />' },
		{ label: "<wt>", type: "keyword", detail: "逐词延迟偏移，可为负数", apply: "<wt:100ms>文本<wt/>" },
		{ label: "</msg>", type: "keyword", detail: "结束消息", apply: "</msg>" },
		{ label: "<effect-start>", type: "keyword", detail: "从下一条消息开始区间屏幕特效", apply: '<effect-start id="" type="rain-glass" color="cyan" intensity="100%" opacity="70%" speed="100%" />' },
		{ label: "<effect-end>", type: "keyword", detail: "在上一条消息结束区间特效", apply: '<effect-end id="" />' },
		...roleIds(context.state.doc.toString()).map((id) => ({ label: id, type: "variable", detail: "角色 id", apply: id })),
	];
	return { from: prefix?.from ?? context.pos, options, validFor: /<?\/?[\w-]*/ };
}

function triggerCompletion() { const current = view; if (current) { current.focus(); startCompletion(current); } }
function insertSnippet(text: string, cursor = text.length) {
	if (!view) return;
	const selection = view.state.selection.main;
	view.dispatch({ changes: { from: selection.from, to: selection.to, insert: text }, selection: { anchor: selection.from + Math.min(cursor, text.length) } });
	view.focus();
}

class FoldedUrlWidget extends WidgetType {
	constructor(readonly fullUrl:string){super()}
	eq(other:FoldedUrlWidget){return other.fullUrl===this.fullUrl}
	toDOM(){const element=document.createElement("span");element.className="cm-folded-url";element.textContent="…";element.title=this.fullUrl;return element}
	ignoreEvent(){return false}
}

function syntaxDecorations(editor: EditorView): DecorationSet {
	const ranges: Array<{ from: number; to: number; value: Decoration }> = [];
	for (const visible of editor.visibleRanges) {
		const text = editor.state.sliceDoc(visible.from, visible.to);
		const comments: Array<[number, number]> = [];
		for (const match of text.matchAll(/<!--[\s\S]*?-->/g)) {
			const from = visible.from + (match.index || 0); const to = from + match[0].length;
			comments.push([from, to]); ranges.push({ from, to, value: Decoration.mark({ class: "tok-comment" }) });
		}
		const inComment = (from: number, to: number) => comments.some(([start, end]) => from >= start && to <= end);
		for (const match of text.matchAll(/<\/?([A-Za-z][\w-]*)(?=[\s>:/>])/g)) {
			const from = visible.from + (match.index || 0) + match[0].indexOf(match[1]); const to = from + match[1].length;
			if (!inComment(from, to)) ranges.push({ from, to, value: Decoration.mark({ class: "tok-tag" }) });
		}
		for (const match of text.matchAll(/\b([\w-]+)(?=\s*=\s*")/g)) {
			const from = visible.from + (match.index || 0); const to = from + match[1].length;
			if (!inComment(from, to)) ranges.push({ from, to, value: Decoration.mark({ class: "tok-attribute" }) });
		}
		for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/g)) {
			const from = visible.from + (match.index || 0); const to = from + match[0].length;
			if (!inComment(from, to)) ranges.push({ from, to, value: Decoration.mark({ class: "tok-string" }) });
		}
		for (const match of text.matchAll(/\b(?:on|off|true|false|left|right|narrator)\b|\b\d+(?:\.\d+)?(?:ms)?\b/g)) {
			const from = visible.from + (match.index || 0); const to = from + match[0].length;
			if (!inComment(from, to)) ranges.push({ from, to, value: Decoration.mark({ class: "tok-value" }) });
		}
		for(const pattern of [/\b(?:url|asset|source-url|file|source-part)="(https?:\/\/[^"\s]{72,})"/g,/\b(?:url|asset|source-url|file)=(https?:\/\/[^,\]\s]{72,})/g])for(const match of text.matchAll(pattern)){const url=match[1];const offset=(match.index||0)+match[0].indexOf(url);const keep=Math.min(52,url.length-8);const from=visible.from+offset+keep,to=visible.from+offset+url.length;const cursor=editor.state.selection.main.head;if(cursor>=from-1&&cursor<=to+1)continue;ranges.push({from,to,value:Decoration.replace({widget:new FoldedUrlWidget(url)})})}
	}
	ranges.sort((left, right) => left.from - right.from || right.to - left.to);
	return Decoration.set(ranges, true);
}

const storyHighlight = ViewPlugin.fromClass(class {
	decorations: DecorationSet;
	constructor(editor: EditorView) { this.decorations = syntaxDecorations(editor); }
	update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged || update.selectionSet) this.decorations = syntaxDecorations(update.view); }
}, { decorations: (plugin) => plugin.decorations });

onMounted(() => {
	if (!host.value) return;
	view = new EditorView({
		parent: host.value,
		state: EditorState.create({
			doc: props.modelValue,
			extensions: [
				basicSetup,
				history(),
				autocompletion({ override: [storyCompletions], activateOnTyping: true }),
				keymap.of([{ key: "Tab", run: acceptCompletion }, indentWithTab, ...completionKeymap, ...historyKeymap]),
				EditorView.lineWrapping,
				storyHighlight,
				EditorView.updateListener.of((update) => { if (update.docChanged) emit("update:modelValue", update.state.doc.toString()); }),
				EditorView.theme({
					"&": { height: "100%", backgroundColor: "#1e1e1e", color: "#d4d4d4", fontSize: "14px" },
					".cm-content": { padding: "14px 0", caretColor: "#aeafad", fontFamily: "'Maple Mono NF CN','Maple Mono SC NF','Sarasa Mono SC','Noto Sans Mono CJK SC','Microsoft YaHei UI','Cascadia Mono',Consolas,monospace", lineHeight: "1.72", letterSpacing: ".01em" },
					".cm-line": { padding: "0 16px 0 8px" },
					".cm-gutters": { backgroundColor: "#181818", color: "#858585", borderRight: "1px solid #2a2a2a" },
					".cm-activeLine,.cm-activeLineGutter": { backgroundColor: "#ffffff0a" },
					".cm-selectionBackground,.cm-content ::selection": { backgroundColor: "#264f78 !important" },
					".cm-cursor": { borderLeftColor: "#aeafad" },
					".cm-scroller": { overflow: "auto" },
					".tok-comment": { color: "#6a9955", fontStyle: "italic" },
					".tok-tag": { color: "#569cd6" },
					".tok-attribute": { color: "#9cdcfe" },
					".tok-string": { color: "#ce9178" },
					".tok-value": { color: "#b5cea8" },
					".cm-folded-url": { display:"inline-grid", placeItems:"center", minWidth:"1.4em", margin:"0 .08em", border:"1px solid #60706d", borderRadius:"5px", backgroundColor:"#2b3533", color:"#9fd8d1", cursor:"text", fontWeight:"700" },
				}),
			],
		}),
	});
});

watch(() => props.modelValue, (value) => {
	if (!view || value === view.state.doc.toString()) return;
	view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
});
watch(() => props.focusRequest?.nonce, () => {
	if (!view || !props.focusRequest) return;
	const position = Math.max(0, Math.min(props.focusRequest.position, view.state.doc.length));
	view.dispatch({
		selection: { anchor: position },
		effects: EditorView.scrollIntoView(position, { y: "center" }),
	});
	view.focus();
}, { flush: "post" });
onBeforeUnmount(() => view?.destroy());
</script>

<style scoped>
.story-script-editor{display:grid;grid-template-rows:minmax(0,1fr);min-width:0;min-height:0;overflow:hidden;background:#1e1e1e}.story-script-editor--error{box-shadow:inset 3px 0 #f14c4c}.story-script-editor__host{min-width:0;min-height:0}.story-script-editor :deep(.cm-editor),.story-script-editor :deep(.cm-scroller){height:100%}.story-script-editor :deep(.cm-focused){outline:0}.story-script-editor :deep(.cm-tooltip-autocomplete){border:1px solid #3d4a48;background:#252526;color:#d4d4d4;box-shadow:0 10px 34px #000a}.story-script-editor :deep(.cm-tooltip-autocomplete>ul>li[aria-selected]){background:#094771;color:#fff}.story-script-editor__mobile-tools{display:none}
@media(max-width:650px){.story-script-editor{grid-template-rows:auto minmax(0,1fr)}.story-script-editor__mobile-tools{display:flex;gap:.35rem;overflow-x:auto;padding:.4rem .5rem;border-bottom:1px solid #333;background:#181818;scrollbar-width:none}.story-script-editor__mobile-tools::-webkit-scrollbar{display:none}.story-script-editor__mobile-tools button{flex:0 0 auto;border:1px solid #3d4645;border-radius:7px;padding:.38rem .55rem;background:#2d2d30;color:#d4d4d4;font:600 .72rem/1.2 "Cascadia Code",Consolas,monospace}.story-script-editor__mobile-tools .completion-trigger{border-color:#397b8a;background:#174b56;color:#d7f5f7}}
</style>

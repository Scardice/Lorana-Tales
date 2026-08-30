<template>
  <div id="e" ref="editor" class="codemirror relative border dark:border-0">
    <slot></slot>
  </div>
</template>

<script setup lang="ts">
import {
	history,
	historyKeymap,
	insertTab,
	standardKeymap,
} from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorState, type Range, StateEffect } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	keymap,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { materialDark, materialLight } from "@uiw/codemirror-theme-material";
import { basicSetup } from "codemirror";
import { onMounted, ref } from "vue";
import { useThemeDark } from "~/composables/useTheme";
import { useStore } from "~/store";
import { base64ImageSrc } from "~/utils";
import { generateLang } from "~/utils/highlight";

const editor = ref<HTMLDivElement>();
const store = useStore();
const isDark = useThemeDark();

const emit = defineEmits<(e: "change", v: ViewUpdate) => void>();

const reloadEditor = (highlight = false) => {
	store.editor.dispatch({
		effects: StateEffect.reconfigure.of(getExts(highlight)),
	});
};

store._reloadEditor = reloadEditor;

function getExts(highlight = false) {
	return [
		basicSetup,
		EditorView.lineWrapping,
		history(),
		keymap.of([
			...standardKeymap,
			...historyKeymap,
			// Tab Keymap
			{
				key: "Tab",
				run: insertTab,
			},
		]),
		imagePreviewPlugin,
		...(highlight ? generateLang(store.pcList, store.exportOptions) : []),
		EditorView.updateListener.of((v: ViewUpdate) => {
			if (v.docChanged) {
				emit("change", v);
				// temp1.view.state.doc.toString()
			}
		}),
		isDark.value ? materialDark : materialLight,
	];
}

class ImagePreviewWidget extends WidgetType {
	constructor(readonly url: string,readonly loaded=false) {
		super();
	}

	eq(other: ImagePreviewWidget) {
		return other.url === this.url&&other.loaded===this.loaded;
	}

	toDOM() {
		let wrap = document.createElement("span");
		wrap.setAttribute("aria-hidden", "true");
		wrap.className = `cm-my-image${this.loaded?" is-loaded":" is-placeholder"}`; // edit-image
		if(this.loaded){
			let box = wrap.appendChild(document.createElement("img"));
			box.src = this.url;
			box.setAttribute("data-original", this.url);
		}
		return wrap;
	}

	ignoreEvent() {
		return false;
	}
}

class FoldedBase64ImageWidget extends WidgetType {
	constructor(readonly url: string,readonly loaded=false) {
		super();
	}

	eq(other: FoldedBase64ImageWidget) {
		return other.url === this.url&&other.loaded===this.loaded;
	}

	toDOM() {
		const wrap = document.createElement("span");
		wrap.className = `cm-base64-image-fold${this.loaded?" is-loaded":" is-placeholder"}`;

		const label = wrap.appendChild(document.createElement("span"));
		label.className = "cm-base64-image-fold__label";
		label.textContent = "[base64 image]";

		if(this.loaded){
			const image = wrap.appendChild(document.createElement("img"));
			image.src = this.url;
			image.setAttribute("data-original", this.url);
		}

		return wrap;
	}

	ignoreEvent() {
		return false;
	}
}

function base64ImageDecoration(text: string, from: number, to: number,loadImages=false) {
	if(!text.includes("base64://"))return undefined;
	if(!loadImages)return Decoration.replace({widget:new FoldedBase64ImageWidget("",false)}).range(from,to);
	// Keep a hard per-image safety ceiling against malformed or hostile payloads;
	// ordinary embedded images remain available after the viewport settles.
	if (text.length > 8_000_000) return Decoration.replace({widget:new FoldedBase64ImageWidget("",false)}).range(from,to);
	const cqMatch = /file=base64:\/\/([A-Za-z0-9+/=\s]+)\]/.exec(text);
	const bracketMatch = /\[(?:image|图):base64:\/\/([A-Za-z0-9+/=\s]+)\]/.exec(
		text,
	);
	const base64 = cqMatch?.[1] ?? bracketMatch?.[1];
	if (!base64) return undefined;

	return Decoration.replace({
		widget: new FoldedBase64ImageWidget(loadImages?base64ImageSrc(base64):"",loadImages),
	}).range(from, to);
}

function imagePreviews(view: EditorView,loadImages=false): DecorationSet {
	const widgets: Array<Range<Decoration>> = [];
	for (let { from, to } of view.visibleRanges) {
		syntaxTree(view.state).iterate({
			from,
			to,
			enter: (node) => {
				let { from, to } = node;
				if (node.name.startsWith("image-")) {
					if(!loadImages&&to-from>64_000){
						widgets.push(Decoration.replace({widget:new FoldedBase64ImageWidget("",false)}).range(from,to));
						return;
					}
					const text = view.state.doc.sliceString(from, to);
					const base64Decoration = base64ImageDecoration(text, from, to,loadImages);
					if (base64Decoration) {
						widgets.push(base64Decoration);
						return;
					}

					let m =
						/url=\[(https?:\/\/gchat\.qpic\.cn[^\]]+)\]\(https?:\/\/[^)]+\)/.exec(
							text,
						) as RegExpExecArray;
					if (m) {
						let deco = Decoration.widget({
							widget: new ImagePreviewWidget(m[1],loadImages),
							side: 0,
						});
						widgets.push(deco.range(to));
					}

					// ob11 - gocq
					// 因为与新napcat的格式冲突，所以加了一点匹配内容
					m = /url=(https?:\/\/gchat\.qpic\.cn[^\]]+)]/.exec(
						text,
					) as RegExpExecArray;
					if (m && !text.includes("file_unique")) {
						let deco = Decoration.widget({
							widget: new ImagePreviewWidget(m[1],loadImages),
							side: 0,
						});
						widgets.push(deco.range(to));
					}

					m = /\[(?:image|图):([^\]]+)?([^\]]+)\]/.exec(
						text,
					) as RegExpExecArray;
					if (m) {
						let deco = Decoration.widget({
							widget: new ImagePreviewWidget(m[1],loadImages),
							side: 0,
						});
						widgets.push(deco.range(to));
					}

					// ob11 - napcat 20250317
					if (!m) {
						m = /file_unique=([a-zA-Z0-9]{32})\]/.exec(text) as RegExpExecArray;
						if (m) {
							// 注: 观察到与ob11冲突情况
							let deco = Decoration.widget({
								widget: new ImagePreviewWidget(
									`https://gchat.qpic.cn/gchatpic_new/0/0-0-${m[1]}/0?term=2,subType=1`,
									loadImages,
								),
								side: 0,
							});
							widgets.push(deco.range(to));
						}
					}

					// ob11 - lagrange
					m = /file=(https?:\/\/[^\]]+)\]/.exec(text) as RegExpExecArray;
					if (m) {
						let deco = Decoration.widget({
							widget: new ImagePreviewWidget(m[1],loadImages),
							side: 0,
						});
						widgets.push(deco.range(to));
					}

					// ob11 - llob(new2)
					m =
						/file=\{([A-Z0-9]+)-([A-Z0-9]+)-([A-Z0-9]+)-([A-Z0-9]+)-([A-Z0-9]+)}([^\]]+?)\]/.exec(
							text,
						) as RegExpExecArray;
					if (m) {
						const url = `https://gchat.qpic.cn/gchatpic_new/0/0-0-${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}/0?term=2,subType=1`;
						let deco = Decoration.widget({
							widget: new ImagePreviewWidget(url,loadImages),
							side: 0,
						});
						widgets.push(deco.range(to));
					}

					// ob11 - llob(new)
					m = /file=([A-Za-z0-9]{32,64})(\.[a-zA-Z]+?)\]/.exec(
						text,
					) as RegExpExecArray;
					if (m) {
						let deco = Decoration.widget({
							widget: new ImagePreviewWidget(
								`https://gchat.qpic.cn/gchatpic_new/0/0-0-${m[1]}/0?term=2,subType=1`,
								loadImages,
							),
							side: 0,
						});
						widgets.push(deco.range(to));
					}

					// ob11 - llob(old)
					m = /file=file:\/\/[^\]]+([A-Za-z0-9]{32})(\.[a-zA-Z]+?)\]/.exec(
						text,
					) as RegExpExecArray;
					if (m) {
						let deco = Decoration.widget({
							widget: new ImagePreviewWidget(
								`https://gchat.qpic.cn/gchatpic_new/0/0-0-${m[1].toUpperCase()}/0?term=2,subType=1`,
								loadImages,
							),
							side: 0,
						});
						widgets.push(deco.range(to));
					}

					m =
						/\[mirai:image:\{([A-Z0-9]+)-([A-Z0-9]+)-([A-Z0-9]+)-([A-Z0-9]+)-([A-Z0-9]+)}([^\]]+?)\]/.exec(
							text,
						) as RegExpExecArray;
					if (m) {
						const url = `https://gchat.qpic.cn/gchatpic_new/0/0-0-${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}/0?term=2`;
						let deco = Decoration.widget({
							widget: new ImagePreviewWidget(url,loadImages),
							side: 0,
						});
						widgets.push(deco.range(to));
					}
				}
			},
		});
	}
	return Decoration.set(widgets);
}

const refreshImagePreviews = StateEffect.define<void>();
const imagePreviewPlugin = ViewPlugin.fromClass(
	class {
		decorations = Decoration.none;
		private timer = 0;

		constructor(view: EditorView) {
			this.decorations=imagePreviews(view,false);
			this.schedule(view);
		}

		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = imagePreviews(update.view,false);
				this.schedule(update.view);
				return;
			}
			if(update.transactions.some(transaction=>transaction.effects.some(effect=>effect.is(refreshImagePreviews))))this.decorations=imagePreviews(update.view,true);
		}

		private schedule(view:EditorView){
			window.clearTimeout(this.timer);
			const delay=view.state.doc.length>600_000?320:140;
			this.timer=window.setTimeout(()=>{
				if(view.dom.isConnected)view.dispatch({effects:refreshImagePreviews.of()});
			},delay);
		}

		destroy(){
			window.clearTimeout(this.timer);
		}
	},
	{
		decorations: (v) => v.decorations,

		eventHandlers: {
			mousedown: (_e, _view) => {},
		},
	},
);

const createEditor = (editorContainer: HTMLDivElement | undefined) => {
	if (!editorContainer) return;
	if (store.editor) {
		store.editor.destroy();
	}

	const startState = EditorState.create({
		//doc为编辑器默认内容
		doc: `田村棉花糖(3850986821) 2026/07/07 19:05:05
新的故事开始了，祝旅途愉快！
记录已经开启。

某人(2863075269) 2026/07/07 19:06:01
（好的测试开始了）

某人(2863075269) 2026/07/07 19:06:21
[mirai:image:{829E3684-0489-D929-ABCE-674F2992FDC4}.jpg]

某人(2863075269) 2026/07/07 19:06:47
从前有一座房子 [CQ:image,file=ee9f302089511a1a096a69d19985c35c.image,url=[https://gchat.qpic.cn/gchatpic_new/303451945/2074687852-2830743842-EE9F302089511A1A096A69D19985C35C/0?term=2,subType=1](https://gchat.qpic.cn/gchatpic_new/303451945/2074687852-2830743842-EE9F302089511A1A096A69D19985C35C/0?term=2,subType=1)]

某人(2863075269) 2026/07/07 19:06:53
房前有两棵树

某人(2863075269) 2026/07/07 19:07:06
一棵是函树，另一颗是反函树

某人(2863075269) 2026/07/07 19:07:10
.ra 灵感

田村棉花糖(3850986821) 2026/07/07 19:07:10
由于a 灵感，<某人>掷出了 D20=5

某人(2863075269) 2026/07/07 19:07:20
啊没开扩展

某人(2863075269) 2026/07/07 19:07:37
.ext coc7 on

田村棉花糖(3850986821) 2026/07/07 19:07:37
打开扩展 coc7
检测到可能冲突的扩展，建议关闭: dnd5e

某人(2863075269) 2026/07/07 19:07:55
.ra 灵感60

田村棉花糖(3850986821) 2026/07/07 19:07:55
<某人>的灵感60检定结果为: d100=1/60, ([1d100=1]) 大成功！

某人(2863075269) 2026/07/07 19:08:21
（？？？？？）

某人(2863075269) 2026/07/07 19:08:23
.setcoc

田村棉花糖(3850986821) 2026/07/07 19:08:23
当前房规: 0

某人(2863075269) 2026/07/07 19:13:44
.r

田村棉花糖(3850986821) 2026/07/07 19:13:44
<某人>掷出了 D20=7

某人(2863075269) 2026/07/07 19:14:02
.nn 创世余火

田村棉花糖(3850986821) 2026/07/07 19:14:02
<某人>(2863075269)的昵称被设定为<创世余火>

创世余火(2863075269) 2026/07/07 19:14:05
,r

创世余火(2863075269) 2026/07/07 19:14:12
.r

田村棉花糖(3850986821) 2026/07/07 19:14:12
<创世余火>掷出了 D20=15

创世余火(2863075269) 2026/07/07 19:14:24
就这样吧

创世余火(2863075269) 2026/07/07 19:14:35
.log end

田村棉花糖(3850986821) 2026/07/07 19:14:35
故事落下了帷幕。
记录已经关闭。
`,
		// Start in the low-memory configuration. Main.vue enables wrapping,
		// thumbnails and optional highlighting after the real document size is known.
		extensions: getExts(false),
	});

	store.editor = new EditorView({
		state: startState,
		parent: editorContainer,
	});
};

onMounted(() => {
	createEditor(editor.value);
});
</script>

<style>
/* 这个$props没有写错,不要改 */
.cm-editor {
  /* height: v-bind("$props.initHeight"); */
  height: 50rem;
  font-size: 18px;

  outline: 0 !important;
  /* height: 50rem; */
  box-shadow:
    0 2px 4px rgba(0, 0, 0, 0.12),
    0 0 6px rgba(0, 0, 0, 0.04);
}

.codemirror {
  height: 50rem;
}

@media (max-width: 860px) {
  .cm-editor,
  .codemirror {
    height: clamp(22rem, 70dvh, 50rem);
  }

  .cm-editor {
    font-size: clamp(0.875rem, 1.8vw, 1.125rem);
  }
}

.test {
  font-size: 2rem;
}

.cm-my-image {
  display: inline-grid;
  width: 8rem;
  height: 6rem;
  overflow: hidden;
  place-items: center;
  vertical-align: middle;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 6px;
  background: linear-gradient(110deg, rgba(148,163,184,.12) 30%, rgba(148,163,184,.24) 45%, rgba(148,163,184,.12) 60%);
  background-size: 220% 100%;
}
.cm-my-image.is-placeholder,.cm-base64-image-fold.is-placeholder{animation:cm-image-placeholder 1.2s linear infinite}
.cm-my-image > img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.cm-base64-image-fold {
  position: relative;
  display: inline-grid;
  width: 8rem;
  height: 6rem;
  overflow: hidden;
  align-items: center;
  justify-items: center;
  vertical-align: middle;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 6px;
  background: linear-gradient(110deg, rgba(148,163,184,.12) 30%, rgba(148,163,184,.24) 45%, rgba(148,163,184,.12) 60%);
  background-size: 220% 100%;
}

.cm-base64-image-fold__label {
  position: absolute;
  z-index: 1;
  border: 1px solid rgba(148, 163, 184, 0.5);
  border-radius: 3px;
  padding: 0 0.35rem;
  color: #64748b;
  font-size: 0.85em;
  line-height: 1.5;
}

.cm-base64-image-fold > img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
@keyframes cm-image-placeholder{to{background-position:-220% 0}}
</style>

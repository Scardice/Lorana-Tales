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
	constructor(readonly url: string) {
		super();
	}

	eq(other: ImagePreviewWidget) {
		return other.url === this.url;
	}

	toDOM() {
		let wrap = document.createElement("span");
		wrap.setAttribute("aria-hidden", "true");
		wrap.className = "cm-my-image"; // edit-image
		let box = wrap.appendChild(document.createElement("img"));
		box.src = this.url;
		// box.setAttribute('crossOrigin', 'anonymous')
		box.setAttribute("data-original", this.url);
		return wrap;
	}

	ignoreEvent() {
		return false;
	}
}

class FoldedBase64ImageWidget extends WidgetType {
	constructor(readonly url: string) {
		super();
	}

	eq(other: FoldedBase64ImageWidget) {
		return other.url === this.url;
	}

	toDOM() {
		const wrap = document.createElement("span");
		wrap.className = "cm-base64-image-fold";

		const label = wrap.appendChild(document.createElement("span"));
		label.className = "cm-base64-image-fold__label";
		label.textContent = "[base64 image]";

		const image = wrap.appendChild(document.createElement("img"));
		image.src = this.url;
		image.setAttribute("data-original", this.url);

		return wrap;
	}

	ignoreEvent() {
		return false;
	}
}

function base64ImageDecoration(text: string, from: number, to: number) {
	const cqMatch = /file=base64:\/\/([A-Za-z0-9+/=\s]+)\]/.exec(text);
	const bracketMatch = /\[(?:image|图):base64:\/\/([A-Za-z0-9+/=\s]+)\]/.exec(
		text,
	);
	const base64 = cqMatch?.[1] ?? bracketMatch?.[1];
	if (!base64) return undefined;

	return Decoration.replace({
		widget: new FoldedBase64ImageWidget(base64ImageSrc(base64)),
	}).range(from, to);
}

function imagePreviews(view: EditorView): DecorationSet {
	const widgets: Array<Range<Decoration>> = [];
	for (let { from, to } of view.visibleRanges) {
		syntaxTree(view.state).iterate({
			from,
			to,
			enter: (node) => {
				let { from, to } = node;
				if (node.name.startsWith("image-")) {
					const text = view.state.doc.sliceString(from, to);
					const base64Decoration = base64ImageDecoration(text, from, to);
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
							widget: new ImagePreviewWidget(m[1]),
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
							widget: new ImagePreviewWidget(m[1]),
							side: 0,
						});
						widgets.push(deco.range(to));
					}

					m = /\[(?:image|图):([^\]]+)?([^\]]+)\]/.exec(
						text,
					) as RegExpExecArray;
					if (m) {
						let deco = Decoration.widget({
							widget: new ImagePreviewWidget(m[1]),
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
							widget: new ImagePreviewWidget(m[1]),
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
							widget: new ImagePreviewWidget(url),
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
							widget: new ImagePreviewWidget(url),
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

const imagePreviewPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = imagePreviews(view);
		}

		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = imagePreviews(update.view);
			}
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

某人(2863075269) 2026/07/07 19:06:25
[CQ:image,file=base64://iVBORw0KGgoAAAANSUhEUgAAABkAAAAZCAYAAADE6YVjAAAAJklEQVR42u3NIQEAAAgDsPdPQ8OTAtTE9NJJr0UikUgkEolE8pIsTbqLKR00etoAAAAASUVORK5CYII=]

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
		extensions: getExts(),
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

.test {
  font-size: 2rem;
}

.cm-my-image > img {
  max-width: 8rem;
  max-height: 6rem;
}

.cm-base64-image-fold {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  vertical-align: middle;
}

.cm-base64-image-fold__label {
  border: 1px solid rgba(148, 163, 184, 0.5);
  border-radius: 3px;
  padding: 0 0.35rem;
  color: #64748b;
  font-size: 0.85em;
  line-height: 1.5;
}

.cm-base64-image-fold > img {
  max-width: 8rem;
  max-height: 6rem;
}
</style>

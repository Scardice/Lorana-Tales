<template>
  <n-layout class="painter-home">
    <n-layout-header class="painter-header">
      <n-flex
        class="py-3 text-2xl"
        size="large"
        align="center"
        justify="center"
        wrap
      >
        <n-flex align="center" justify="center">
          <strong>余烬TRPG跑团Log着色器</strong>
          <n-tag type="success" size="small" :bordered="false">v1.0.0</n-tag>
        </n-flex>
        <n-flex align="center" justify="center">
          <account-panel :archive="storyArchive" @load="onStoryChange" @sync="syncStorySource" />
          <n-button
            tag="a"
            href="/api-docs"
            secondary
            type="primary"
            size="small"
          >
            <template #icon>
              <n-icon>
                <icon-api />
              </n-icon>
            </template>
            API
          </n-button>
          <n-button tag="a" href="/admin" secondary type="primary" size="small">
            <template #icon>
              <n-icon>
                <icon-user-admin />
              </n-icon>
            </template>
            管理
          </n-button>
        </n-flex>
      </n-flex>
    </n-layout-header>
    <n-layout-content class="painter-content">
      <div class="painter-workspace">
        <n-text type="info" italic class="block text-center my-1"
          >Scardice官方QQ一群 1084726031</n-text
        >
        <option-view></option-view>
        <div class="remote-load-frame">
          <div
            v-if="loading"
            class="remote-load-overlay"
            role="status"
            aria-live="polite"
          >
            <div class="remote-load-spinner" aria-hidden="true"></div>
            <span>正在尝试加载远程记录……</span>
          </div>
          <div class="pc-list">
            <div
              v-for="(i, index) in store.pcList"
              :key="`${i.name}-${index}`"
              class="pc-row"
            >
              <n-button
                type="error"
                size="small"
                quaternary
                circle
                class="pc-row__delete"
                @click="deletePc(index, i)"
                :aria-label="`删除角色 ${i.name || index + 1}`"
                :disabled="
                  isShowPreview ||
                  isShowPreviewBBS ||
                  isShowPreviewBBSPineapple ||
                  isShowPreviewTRG
                "
              >
                <template #icon>
                  <n-icon :component="IconTrashCan" />
                </template>
              </n-button>

              <n-input
                :disabled="
                  isShowPreview ||
                  isShowPreviewBBS ||
                  isShowPreviewBBSPineapple ||
                  isShowPreviewTRG
                "
                v-model:value="i.name"
                class="pc-row__name"
                :prefix-icon="User"
                @focus="nameFocus(i)"
                @change="nameChanged(i)"
              />

              <n-input
                :disabled="true"
                v-model:value="i.IMUserId"
                class="pc-row__im"
              />

              <n-select
                v-model:value="i.role"
                class="pc-row__role"
                :options="[
                  { value: '主持人', label: '主持人' },
                  { value: '角色', label: '角色' },
                  { value: '骰子', label: '骰子' },
                  { value: '隐藏', label: '隐藏' },
                ]"
              />

              <n-select
                v-if="storyArchive?.document.settings.enabled"
                class="pc-row__position"
                :value="storyPositionFor(i)"
                :options="[
                  { value: 'left', label: '左侧' },
                  { value: 'right', label: '右侧' },
                  { value: 'narrator', label: '旁白位' },
                ]"
                @update:value="setStoryPosition(i, $event)"
              />

              <n-color-picker
                v-if="!isCompactViewport"
                v-model:value="i.color"
                placement="bottom-end"
                :show-alpha="false"
                show-preview
                :modes="['hex', 'rgb', 'hsl', 'hsv']"
                :swatches="colors"
                :disabled="
                  isShowPreview ||
                  isShowPreviewBBS ||
                  isShowPreviewBBSPineapple ||
                  isShowPreviewTRG
                "
                @update:value="colorChanged($event, i)"
              >
                <template #trigger="{ onClick, ref: setTriggerRef }">
                  <button
                    :ref="setTriggerRef"
                    class="pc-row__color"
                    type="button"
                    :style="{ '--pc-row-color': i.color }"
                    :aria-label="`设置 ${i.name || '角色'} 颜色`"
                    @click="onClick"
                    :disabled="
                      isShowPreview ||
                      isShowPreviewBBS ||
                      isShowPreviewBBSPineapple ||
                      isShowPreviewTRG
                    "
                  >
                    <span></span>
                  </button>
                </template>
              </n-color-picker>

              <button
                v-else
                class="pc-row__color"
                type="button"
                :style="{ '--pc-row-color': i.color }"
                :aria-label="`设置 ${i.name || '角色'} 颜色`"
                @click="openMobileColorPicker(i)"
                :disabled="
                  isShowPreview ||
                  isShowPreviewBBS ||
                  isShowPreviewBBSPineapple ||
                  isShowPreviewTRG
                "
              >
                <span></span>
              </button>
            </div>
          </div>

          <story-options
            v-if="storyArchive"
            :model="storyArchive.document.settings"
            @change="updateStorySettings"
          />

          <section class="workbench-actions" aria-label="导出和预览控制">
            <div class="action-card action-card--export">
              <div class="action-card__title">
                <n-icon :component="IconDownload" />
                <strong>导出记录</strong>
              </div>
              <div
                class="action-card__controls action-card__controls--downloads"
              >
                <n-button secondary type="primary" @click="exportRecordRaw"
                  >下载原始文件</n-button
                >
                <n-button
                  v-if="storyArchive?.document.settings.enabled"
                  secondary
                  type="success"
                  @click="downloadStoryPackage"
                  >下载可编辑 SSP</n-button
                >
                <n-button secondary type="primary" @click="triggerFileUpload">导入日志 / SSP</n-button>
                <!-- <n-button secondary type="primary" v-show="false" @click="exportRecordQQ">下载QQ风格记录</n-button>-->
                <!-- <n-button secondary type="primary" v-show="false" @click="exportRecordIRC">下载IRC风格记录</n-button>-->
                <n-button secondary type="primary" @click="exportRecordDOC"
                  >下载带图 Word</n-button
                >
                <n-button secondary type="primary" @click="exportRecordTalkDOC"
                  >下载对话 Word</n-button
                >
                <n-button secondary type="primary" @click="exportRecordDocx"
                  >下载文本 Word</n-button
                >
              </div>
            </div>

            <div class="action-card action-card--preview">
              <div class="action-card__title">
                <n-icon :component="IconView" />
                <strong>预览模式</strong>
              </div>
              <div class="action-card__controls action-card__controls--preview">
                <n-checkbox
                  label="预览"
                  v-model:checked="isShowPreview"
                  :border="true"
                  @click="previewClick('preview')"
                />
                <n-button
                  v-if="storyArchive?.document.settings.enabled"
                  secondary
                  type="success"
                  @click="isStoryPlayerVisible = true"
                >沉浸预览</n-button>
                <n-button
                  v-if="storyArchive?.document.settings.enabled"
                  secondary
                  type="warning"
                  @click="clearStoryDraft"
                >删除本地修改</n-button>
                <n-checkbox
                  label="论坛代码"
                  v-model:checked="isShowPreviewBBS"
                  :border="true"
                  @click="previewClick('bbs')"
                />
                <n-checkbox
                  label="论坛代码(内容多行)"
                  v-model:checked="isShowPreviewBBSPineapple"
                  :border="true"
                  @click="previewClick('bbspineapple')"
                />
                <n-checkbox
                  label="回声工坊"
                  v-model:checked="isShowPreviewTRG"
                  :border="true"
                  @click="previewClick('trg')"
                />
              </div>
            </div>
          </section>

          <story-editor
            v-if="storyArchive?.document.settings.enabled"
            :archive="storyArchive"
            :asset-url="storyAssetUrl"
            @change="onStoryChange"
            @download="downloadStoryPackage"
            @preview="isStoryPlayerVisible = true"
          />

          <div
            v-show="
              !storyArchive?.document.settings.enabled &&
              !(
                isShowPreview ||
                isShowPreviewBBS ||
                isShowPreviewBBSPineapple ||
                isShowPreviewTRG
              )
            "
            class="editor-panel"
          >
            <div class="editor-toolbar" aria-label="编辑器工具栏">
              <n-button
                secondary
                @click="clearText"
                id="btnClearEditor"
                type="primary"
              >
                <template #icon>
                  <n-icon :component="IconReset" />
                </template>
                清空内容
              </n-button>
              <n-button secondary @click="doFlush" type="primary">
                <template #icon>
                  <n-icon :component="IconRenew" />
                </template>
                强制刷新
              </n-button>
              <n-button secondary type="primary" @click="refreshColors">
                <template #icon>
                  <n-icon :component="IconColorPalette" />
                </template>
                刷新色板
              </n-button>
              <n-checkbox
                label="编辑器染色"
                v-model:checked="store.doEditorHighlight"
                :border="false"
                @click.native="doEditorHighlightClick($event)"
              />
              <span class="editor-toolbar__spacer"></span>
              <n-button
                secondary
                type="primary"
                :loading="isUploadingFile"
                :disabled="isUploadingFile"
                @click="triggerFileUpload"
              >
                <template #icon>
                  <n-icon :component="IconUpload" />
                </template>
                从文件上传
              </n-button>
              <input
                ref="fileInputRef"
                type="file"
                accept=".ssp,.json,.txt,.log,.trpglog,.olivadicelog"
                style="display: none"
                @change="onFileChange"
              />
            </div>

            <code-mirror
              ref="editor"
              class="editor-codemirror"
              @change="onChange"
            />
          </div>

          <n-message-provider>
            <preview-main
              :is-show="isShowPreview"
              :preview-items="previewItems"
            ></preview-main>
            <preview-bbs
              :is-show="isShowPreviewBBS"
              :preview-items="previewItems"
            ></preview-bbs>
            <preview-bbs-pineapple
              :is-show="isShowPreviewBBSPineapple"
              :preview-items="previewItems"
            ></preview-bbs-pineapple>
            <preview-trg
              :is-show="isShowPreviewTRG"
              :preview-items="previewItems"
            ></preview-trg>
          </n-message-provider>
        </div>
      </div>

      <n-modal
        v-model:show="isMobileColorPickerVisible"
        preset="card"
        class="mobile-color-modal"
        :title="`设置${mobileColorTarget?.name || '角色'}颜色`"
        :style="{ width: 'min(22rem, calc(100vw - 2rem))' }"
      >
        <div v-if="mobileColorTarget" class="mobile-color-picker">
          <n-text depth="3" class="mobile-color-picker__hint">
            选择颜色后会自动保存。
          </n-text>
          <n-color-picker
            :value="mobileColorTarget.color"
            :show-alpha="false"
            show-preview
            :modes="['hex', 'rgb', 'hsl', 'hsv']"
            :swatches="colors"
            placement="bottom-start"
            @update:value="updateMobileColor"
          >
            <template #trigger="{ onClick, ref: setTriggerRef }">
              <button
                :ref="setTriggerRef"
                class="mobile-color-picker__trigger"
                type="button"
                :style="{ '--pc-row-color': mobileColorTarget.color }"
                aria-label="打开颜色选择器"
                @click="onClick"
              >
                <span></span>
                <span>{{ mobileColorTarget.color }}</span>
              </button>
            </template>
          </n-color-picker>
        </div>

        <template #footer>
          <n-button type="primary" @click="isMobileColorPickerVisible = false">
            完成
          </n-button>
        </template>
      </n-modal>
      <story-player
        v-if="storyArchive"
        :show="isStoryPlayerVisible"
        :archive="storyArchive"
        :asset-url="storyAssetUrl"
        @close="isStoryPlayerVisible = false"
      />
    </n-layout-content>
  </n-layout>
</template>

<script setup lang="ts">
import type { ViewUpdate } from "@codemirror/view";
import {
  Api as IconApi,
  ColorPalette as IconColorPalette,
  Download as IconDownload,
  Renew as IconRenew,
  Reset as IconReset,
  TrashCan as IconTrashCan,
  Upload as IconUpload,
  UserAdmin as IconUserAdmin,
  View as IconView,
  User,
} from "@vicons/carbon";
import { useToggle } from "@vueuse/core";
import { strFromU8, strToU8, unzlibSync, zlibSync } from "fflate";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { asyncBufferFrom } from "hyperparam";
import { debounce } from "lodash-es";
import {
  NButton,
  NText,
  useMessage,
  useModal,
  useNotification,
} from "naive-ui";
import randomColor from "randomcolor";
import uaParser from "ua-parser-js";
import {
  computed,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  render,
  toRaw,
  type Component,
  watch,
} from "vue";
import PreviewItem from "./components/previews/preview-main-item.vue";
import PreviewTableTR from "./components/previews/preview-table-tr.vue";
import AccountPanel from "./components/story/AccountPanel.vue";
import StoryEditor from "./components/story/StoryEditor.vue";
import StoryOptions from "./components/story/StoryOptions.vue";
import StoryPlayer from "./components/story/StoryPlayer.vue";
import { useThemeDark } from "./composables/useTheme";
import { setCharInfo, type TextInfo } from "./logManager/importers/_logImpoter";
import { logMan } from "./logManager/logManager";
import type { CharItem, LogItem } from "./logManager/types";
import { deleteLocalStoryDraft, loadLocalStoryDraft, saveLocalStoryDraft } from "./story/local-storage";
import { storyFromLogItems, storyToLogItems } from "./story/model";
import { createStoryPackage, readStoryPackage } from "./story/package";
import { mergeStorySource } from "./story/sync";
import type { StoryArchive, StoryPosition, StorySettings } from "./story/types";
import { UploadBlockedBySecurityError, useStore } from "./store";
import {
  applyQQImageRKeyReplacement,
  msgAtFormat,
  msgCommandFormat,
  msgIMUseridFormat,
  msgImageFormat,
  msgOffTopicFormat,
  shouldApplyQQImageRKeyReplacement,
} from "./utils";
import {
  exportFileDocx,
  exportFileIRC,
  exportFileQQ,
  exportFileRaw,
} from "./utils/exporter";

const isDark = useThemeDark();
const _toggleDark = useToggle(isDark);

// 不用他了 虽然很不错，但是没有屏幕取色
// import { ColorPicker } from 'vue-color-kit'
// import 'vue-color-kit/dist/vue-color-kit.css'

const message = useMessage();
const modal = useModal();
const notification = useNotification();

const loading = ref<boolean>(false);

const isMobile = ref(false);
const isCompactViewport = ref(false);
const downloadUsableRank = ref(0);

const isShowPreview = ref(false);
const isShowPreviewBBS = ref(false);
const isShowPreviewBBSPineapple = ref(false);
const isShowPreviewTRG = ref(false);
const isStoryPlayerVisible = ref(false);
const storyArchive = ref<StoryArchive>();
const storyObjectUrls = new Map<string, string>();
const storyDraftKey = `story:${location.origin}${location.pathname}?key=${new URLSearchParams(location.search).get("key") || "local"}`;
let applyingStoryChange = false;

const storyAssetUrl = (id: string) => {
  const existing = storyObjectUrls.get(id);
  if (existing) return existing;
  const bytes = storyArchive.value?.assets.get(id);
  if (!bytes) return id;
  const refs = [
    ...storyArchive.value!.document.characters.map((item) => item.avatar),
    ...storyArchive.value!.document.messages.map((item) => item.kind === "image" ? item.asset : undefined),
  ];
  const mime = refs.find((item) => item?.id === id)?.mime || "application/octet-stream";
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  storyObjectUrls.set(id, url);
  return url;
};

const saveStoryDraft = debounce((archive: StoryArchive) => {
  saveLocalStoryDraft(storyDraftKey, archive).catch((error) => console.error("保存沉浸编辑草稿失败", error));
}, 500);

function ensureStoryArchive() {
  if (storyArchive.value) return;
  const params = new URLSearchParams(location.search);
  const assets = new Map<string, Uint8Array>();
  storyArchive.value = {
    document: storyFromLogItems(logMan.curItems, store.pcList, {
      title: document.title || "跑团记录",
      sourceKey: params.get("key") || undefined,
      assets,
    }),
    assets,
  };
}

function onStoryChange(archive: StoryArchive) {
  storyArchive.value = archive;
  applyingStoryChange = true;
  try {
    logMan.curItems = storyToLogItems(archive.document);
    logMan.flush();
    showPreview();
  } finally {
    applyingStoryChange = false;
  }
  saveStoryDraft(archive);
}

function updateStorySettings(settings: StorySettings) {
  if (!storyArchive.value) return;
  onStoryChange({ ...storyArchive.value, document: { ...storyArchive.value.document, settings } });
}

function storyCharacterFor(pc: CharItem) {
  return storyArchive.value?.document.characters.find((item) => item.name === pc.name && item.imUserId === pc.IMUserId);
}

function storyPositionFor(pc: CharItem): StoryPosition {
  return storyCharacterFor(pc)?.position || (pc.role === "主持人" ? "right" : pc.role === "骰子" ? "narrator" : "left");
}

function setStoryPosition(pc: CharItem, position: StoryPosition) {
  if (!storyArchive.value) return;
  const archive = { document: structuredClone(toRaw(storyArchive.value.document)), assets: new Map(toRaw(storyArchive.value.assets)) };
  const target = archive.document.characters.find((item) => item.name === pc.name && item.imUserId === pc.IMUserId);
  if (target) target.position = position;
  onStoryChange(archive);
}

async function downloadStoryPackage() {
  ensureStoryArchive();
  if (!storyArchive.value) return;
  const { archive, failed } = await hydrateStoryAssets(storyArchive.value);
  storyArchive.value = archive;
  const blob = await createStoryPackage(archive);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${storyArchive.value.document.title.replace(/[\\/:*?\"<>|]/g, "_") || "跑团记录"}.ssp`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  message.success("SSP 工程包已生成");
  if (failed) message.warning(`${failed} 个失效或超时的远程资源无法内嵌，SSP 中已保留原链接`);
}

async function hydrateStoryAssets(source: StoryArchive): Promise<{ archive: StoryArchive; failed: number }> {
  const archive = { document: structuredClone(toRaw(source.document)), assets: new Map(toRaw(source.assets)) };
  let failed = 0;
  const refs = [
    ...archive.document.characters.map((item) => item.avatar),
    ...archive.document.messages.map((item) => item.kind === "image" ? item.asset : undefined),
  ].filter((item): item is NonNullable<typeof item> => !!item);
  for (const asset of refs) {
    if (archive.assets.has(asset.id)) continue;
    const sourceUrl = asset.sourceUrl || (/^https?:\/\//i.test(asset.id) ? asset.id : "");
    if (!sourceUrl) continue;
    try {
      let localUrl = sourceUrl;
      if (new URL(sourceUrl, location.href).origin !== location.origin) {
        const cached = await fetch("/api/editor/assets/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: sourceUrl }), signal: AbortSignal.timeout(8000) });
        if (!cached.ok) throw new Error("资源归档失败");
        localUrl = (await cached.json()).url;
      }
      const response = await fetch(localUrl, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("资源下载失败");
      const id = `asset-${crypto.randomUUID()}`;
      archive.assets.set(id, new Uint8Array(await response.arrayBuffer()));
      asset.id = id;
      asset.sourceUrl = undefined;
      asset.mime = response.headers.get("content-type") || asset.mime;
    } catch (error) {
      failed += 1;
      console.warn(`SSP 资源暂时无法内嵌：${asset.name || sourceUrl}`, error);
    }
  }
  return { archive, failed };
}

async function syncStorySource(payload: { record: { client: string; data: string; name?: string; updated_at?: string }; sourceKey: string; sourceRevision?: string }) {
  if (!storyArchive.value) return;
  try {
    let rawText = "";
    if (payload.record.client === "Parquet") {
      const bytes = Uint8Array.from(atob(payload.record.data), (char) => char.charCodeAt(0));
      const file = await asyncBufferFrom({ file: new File([bytes], "source.parquet"), byteLength: bytes.byteLength });
      const rows = await parquetReadObjects({ file, compressors });
      rawText = JSON.stringify({ items: rows.map((row) => ({ ...row, id: Number(row.id), time: Number(row.time), commandId: Number(row.commandId) })), version: 105 });
    } else {
      rawText = strFromU8(unzlibSync(Uint8Array.from(atob(payload.record.data), (char) => char.charCodeAt(0))));
    }
    rawText = await applyQQImageRKey(rawText);
    const parsed = logMan.parse(rawText);
    if (!parsed) throw new Error("源日志格式无法解析");
    const incomingAssets = new Map<string, Uint8Array>();
    const incoming = storyFromLogItems(parsed.items, [...parsed.charInfo.values()], { title: payload.record.name, sourceKey: payload.sourceKey, sourceRevision: payload.record.updated_at || payload.sourceRevision, assets: incomingAssets });
    const result = mergeStorySource(storyArchive.value.document, incoming);
    onStoryChange({ document: result.document, assets: new Map([...storyArchive.value.assets, ...incomingAssets]) });
    message.success(`同步完成：新增 ${result.added}、更新 ${result.updated}、移除 ${result.removed}${result.conflicts ? `，保留 ${result.conflicts} 个冲突` : ""}`);
  } catch (error) {
    console.error("同步源日志失败", error);
    message.error(error instanceof Error ? error.message : "同步源日志失败");
  }
}

async function clearStoryDraft() {
  if (!confirm("确定删除这个日志在本浏览器保存的全部高级编辑修改吗？此操作需要再次确认。")) return;
  if (!confirm("再次确认：删除后无法从本浏览器恢复，已下载的 SSP 不受影响。")) return;
  await deleteLocalStoryDraft(storyDraftKey);
  storyArchive.value = undefined;
  ensureStoryArchive();
  message.success("本地编辑修改已删除");
}

function onStorySaveShortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && storyArchive.value?.document.settings.enabled) {
    event.preventDefault();
    downloadStoryPackage().catch((error) => { console.error(error); message.error("SSP 下载失败"); });
  }
}

const colors = ref<string[]>([]);
const mobileColorTarget = ref<CharItem>();
const isMobileColorPickerVisible = ref(false);

const updateCompactViewport = () => {
  isCompactViewport.value = window.matchMedia("(max-width: 520px)").matches;
};

const openMobileColorPicker = (target: CharItem) => {
  mobileColorTarget.value = target;
  isMobileColorPickerVisible.value = true;
};

const updateMobileColor = (value: string) => {
  const target = mobileColorTarget.value;
  if (!target) return;
  target.color = value;
  colorChanged(value, target);
};

const refreshColors = () => {
  colors.value = randomColor({ count: 16 });
  message.success("色板刷新成功！", { duration: 800 });
};

const colorChanged = debounce((v: string, i: CharItem) => {
  i.color = v;
  store.pcNameColorMap.set(i.name, v);
  store.colorMapSave();
}, 300);

// 清空文本
const clearText = () => {
  store.editor.dispatch({
    changes: { from: 0, to: store.editor.state.doc.length, insert: "" },
  });
};

const doFlush = () => {
  console.log("flush");
  logMan.flush();
};

const fileInputRef = ref<HTMLInputElement>();
const isUploadingFile = ref(false);

const triggerFileUpload = () => {
  if (isUploadingFile.value) return;
  fileInputRef.value?.click();
};

const buildUploadFile = async (file: File): Promise<File | undefined> => {
  const text = await file.text();
  const parsed = logMan.parse(text);
  if (!parsed || parsed.items.length === 0) {
    return undefined;
  }

  const payload = JSON.stringify({
    items: parsed.items.map((item, index) => ({
      ...item,
      id: item.id ?? index + 1,
      isDice: item.isDice ?? false,
      commandId: item.commandId ?? 0,
    })),
    version: parsed.version ?? 105,
  });
  const compressed = zlibSync(strToU8(payload));
  return new File([compressed], `${file.name || "log"}.scardice.json`, {
    type: "application/octet-stream",
  });
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const accountCsrf = () => decodeURIComponent(
  document.cookie.split("; ").find((value) => value.startsWith("scardice_account_csrf="))?.split("=").slice(1).join("=") || "",
);

async function claimWebUpload(file: File, uploadedUrl: string) {
  const accountResponse = await fetch("/api/account/me", { credentials: "same-origin" });
  if (!accountResponse.ok) return;
  const account = await accountResponse.json();
  if (!account.authenticated) return;

  const parsed = logMan.parse(await file.text());
  if (!parsed?.items.length) return;
  const target = new URL(uploadedUrl, location.href);
  const assets = new Map<string, Uint8Array>();
  const document = storyFromLogItems(parsed.items, [...parsed.charInfo.values()], {
    title: file.name.replace(/\.[^.]+$/, "") || "跑团记录",
    sourceKey: target.searchParams.get("key") || undefined,
    sourceRevision: new Date().toISOString(),
    assets,
  });
  const csrf = accountCsrf();
  const response = await fetch("/api/account/projects", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: JSON.stringify({
      title: document.title,
      document: {
        story: document,
        assets: [...assets].map(([id, bytes]) => [id, bytesToBase64(bytes)]),
      },
      sourceKey: document.source.key || "",
      sourceRevision: document.source.revision || "",
      sourceSecret: target.hash.slice(1),
    }),
  });
  if (!response.ok) throw new Error("上传成功，但自动保存到账号失败");
}

const onFileChange = async (event: Event) => {
  if (!(event.target instanceof HTMLInputElement)) return;

  const input = event.target;
  const file = input.files?.[0];
  if (!file) return;

  isUploadingFile.value = true;
  try {
    if (file.name.toLowerCase().endsWith(".ssp")) {
      const archive = await readStoryPackage(file);
      onStoryChange(archive);
      message.success("SSP 工程包已载入，可继续编辑");
      return;
    }
    const uploadFile = await buildUploadFile(file);
    if (!uploadFile) {
      message.error("文件解析失败，请确认日志格式受支持");
      return;
    }

    const url = await store.uploadLogFile(uploadFile);
    try {
      await claimWebUpload(file, url);
    } catch (error) {
      console.warn("自动保存上传日志到账号失败", error);
      message.warning("日志已上传，但未能自动保存到账号；打开后可在账号面板手动保存");
    }
    message.success("上传成功，正在打开新的染色器链接");
    window.location.assign(url);
  } catch (e) {
    if (e instanceof UploadBlockedBySecurityError) {
      sessionStorage.setItem("scardiceSecurityWarning", e.warningText);
      window.location.assign("/security-warning.html");
      return;
    }
    console.error("文件上传失败", e);
    message.error("文件上传失败，请稍后重试");
  } finally {
    isUploadingFile.value = false;
    input.value = "";
  }
};

const previewClick = (mode: "preview" | "bbs" | "bbspineapple" | "trg") => {
  switch (mode) {
    case "preview":
      isShowPreviewBBS.value = false;
      isShowPreviewBBSPineapple.value = false;
      isShowPreviewTRG.value = false;
      break;
    case "bbs":
      isShowPreview.value = false;
      isShowPreviewBBSPineapple.value = false;
      isShowPreviewTRG.value = false;
      store.exportOptions.imageHide = true;
      break;
    case "bbspineapple":
      isShowPreview.value = false;
      isShowPreviewBBS.value = false;
      isShowPreviewTRG.value = false;
      store.exportOptions.imageHide = true;
      break;
    case "trg":
      isShowPreview.value = false;
      isShowPreviewBBS.value = false;
      isShowPreviewBBSPineapple.value = false;
      store.exportOptions.imageHide = true;
      break;
  }
  showPreview();
};

function setupUA() {
  const parser = new uaParser.UAParser();
  parser.setUA(navigator.userAgent);
  const deviceType = parser.getDevice();

  const browser = parser.getBrowser().name;
  downloadUsableRank.value = 1;

  isMobile.value = deviceType.type === "mobile";
  if (deviceType.type === "mobile") {
    // 经测可以使用的
    switch (browser) {
      // case '360 Browser': // 手机360 但是手机360无特征，自己是Chrome WebView
      // 手机:X浏览器 Chrome WebView无特征
      case "Edge":
      case "Chrome":
      case "Chromium":
      case "Firefox":
      case "MIUI Browser":
      case "Opera":
        downloadUsableRank.value = 2;
    }

    // 经测无法使用的
    switch (browser) {
      case "baiduboxapp": // 手机:百度浏览器
      case "QQBrowser": // 手机:搜狗浏览器极速版，手机:QQ浏览器
      // 手机:万能浏览器，Chrome WebView无特征，会直接崩溃
      case "UCBrowser": // 手机:UC浏览器
      case "Quark": // 手机:夸克
      // 手机:Via浏览器，Chrome WebView无特征，会直接崩溃
      case "QQ": // 手机:QQ
      case "WeChat":
        downloadUsableRank.value = 0;
    }
  }
}

setupUA();
updateCompactViewport();

const applyQQImageRKey = async (text: string) => {
  if (!shouldApplyQQImageRKeyReplacement(text)) {
    return text;
  }

  try {
    const payload = await store.tryFetchRKey();
    return applyQQImageRKeyReplacement(text, payload);
  } catch (e) {
    console.log(e);
    return text;
  }
};

const browserAlert = () => {
  if (downloadUsableRank.value === 0) {
    message.warning(
      "你目前所使用的浏览器无法下载文件，请更换对标准支持较好的浏览器。建议使用Chrome/Firefox/Edge",
    );
  }
  if (downloadUsableRank.value === 1) {
    if (isMobile.value) {
      message.warning(
        "你目前所使用的浏览器可能在下载文件时遇到乱码，或无法下载文件，最好更换对标准支持较好的浏览器。建议使用Chrome/Firefox/Edge",
      );
    }
  }
  // 2 不做提示 因为兼容良好
};

onMounted(async () => {
  window.addEventListener("resize", updateCompactViewport, { passive: true });
  window.addEventListener("keydown", onStorySaveShortcut);
  const searchParams = new URLSearchParams(window.location.search);
  const key = searchParams.get("key");
  const password = location.hash.slice(1);

  const showHl = () => {
    setTimeout(() => {
      if (!isMobile.value) {
        store.doEditorHighlight = true;
        store.reloadEditor();
      }
    }, 1000);
  };

  if (key && password) {
    loading.value = true;
    try {
      const record = (await store.tryFetchLog(key, password)) as {
        client: "Scardice" | "Parquet";
        created_at: string;
        data: string;
        name: string;
        note: string;
        updated_at: string;
      };

      switch (record.client) {
        case "Parquet":
          {
            const uint8 = Uint8Array.from(atob(record.data), (c) =>
              c.charCodeAt(0),
            );
            const asyncBuffer = await asyncBufferFrom({
              file: new File([uint8], "default"),
              byteLength: uint8.byteLength,
            });
            const res = await parquetReadObjects({
              file: asyncBuffer,
              compressors,
            });
            const items = res.map((v) => {
              v.id = Number(v.id);
              v.time = Number(v.time);
              v.commandId = Number(v.commandId);
              return v;
            });
            const rawText = JSON.stringify({
              items,
              version: 105,
            });
            const text = await applyQQImageRKey(rawText);
            await nextTick();
            store.pcList.length = 0;

            logMan.lastText = "";
            logMan.syncChange(
              text,
              [0, store.editor.state.doc.length],
              [0, text.length],
            );
          }
          break;
        default:
          {
            const log = unzlibSync(
              Uint8Array.from(atob(record.data), (c) => c.charCodeAt(0)),
            );

            const rawText = strFromU8(log);
            const text = await applyQQImageRKey(rawText);
            await nextTick();
            store.pcList.length = 0;

            logMan.lastText = "";
            logMan.syncChange(
              text,
              [0, store.editor.state.doc.length],
              [0, text.length],
            );
          }
          break;
      }
      showHl();
    } catch (e) {
      console.log(e);
      notification.error({
        content: "错误",
        meta: "加载日志失败，可能是序号或密码不正确",
        duration: 5000,
      });
      browserAlert();
      return true;
    } finally {
      loading.value = false;
    }
  } else {
    store.editor.dispatch({
      changes: {
        from: 0,
        to: store.editor.state.doc.length,
        insert: store.editor.state.doc.toString(),
      },
    });
    showHl();
  }

  ensureStoryArchive();
  try {
    const draft = await loadLocalStoryDraft(storyDraftKey);
    if (draft && confirm("检测到这个日志在当前浏览器保存的高级编辑修改，是否恢复？")) {
      onStoryChange(draft);
      message.success("已恢复本地编辑修改");
    }
  } catch (error) {
    console.error("读取沉浸编辑草稿失败", error);
  }

  // cminstance.value = cmRefDom.value?.cminstance;
  // cminstance.value?.focus();
  // console.log(cminstance.value)
  colors.value = randomColor({ count: 16 });
  browserAlert();
  await nextTick(() => {
    setTimeout(() => {
      doFlush();
    }, 3000);
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", updateCompactViewport);
  window.removeEventListener("keydown", onStorySaveShortcut);
  saveStoryDraft.cancel();
  for (const url of storyObjectUrls.values()) URL.revokeObjectURL(url);
  storyObjectUrls.clear();
});

function exportRecordRaw() {
  browserAlert();
  exportFileRaw(store.editor.state.doc.toString());
}

function exportRecordQQ() {
  browserAlert();
  showPreview();
  exportFileQQ(previewItems.value, store.exportOptions);
}

function exportRecordIRC() {
  browserAlert();
  showPreview();
  exportFileIRC(previewItems.value, store.exportOptions);
}

const renderWordHtml = (component: Component, asTable = false) => {
  const fragments: string[] = [];

  for (const item of previewItems.value) {
    if (item.isRaw || store.isHiddenLogItem(item)) continue;

    const mountPoint = document.createElement(asTable ? "tbody" : "div");
    render(h(component, { source: item }), mountPoint);
    fragments.push(mountPoint.innerHTML);
    render(null, mountPoint);
  }

  if (fragments.length === 0) return "";
  return asTable
    ? `<table><tbody>${fragments.join("\n")}</tbody></table>`
    : fragments.join("\n");
};

const removeExportImages = (html: string) => {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("img").forEach((image) => {
    const alt = image.getAttribute("alt")?.trim();
    image.replaceWith(document.createTextNode(alt ? `[图:${alt}]` : "[图]"));
  });
  return template.innerHTML;
};

const exportWordDocument = async (
  filename: string,
  component: Component,
  options: { asTable?: boolean; includeImages?: boolean } = {},
) => {
  browserAlert();
  showPreview();

  let html = renderWordHtml(component, options.asTable);
  if (!html) {
    message.warning("没有可导出的内容");
    return;
  }
  if (!options.includeImages) {
    html = removeExportImages(html);
  }

  try {
    await exportFileDocx(html, filename);
    message.success("已生成标准 DOCX 文档");
  } catch (error) {
    console.error(error);
    message.error("Word 导出失败，请稍后重试");
  }
};

function exportRecordDOC() {
  return exportWordDocument("跑团记录(带图).docx", PreviewItem, {
    includeImages: true,
  });
}

function exportRecordTalkDOC() {
  return exportWordDocument("跑团记录(对话).docx", PreviewTableTR, {
    asTable: true,
    includeImages: true,
  });
}

function exportRecordDocx() {
  return exportWordDocument("跑团记录(文本).docx", PreviewItem, {
    includeImages: false,
  });
}

const previewItems = ref<LogItem[]>([]);

function showPreview() {
  const tmp: LogItem[] = [];
  let index = 0;
  const _offTopicHide = store.exportOptions.offTopicHide;
  console.log("当前日志条目数量: ", logMan.curItems.length);

  for (let i of logMan.curItems) {
    if (i.isRaw) continue;
    if (store.isHiddenLogItem(i)) continue;

    // // 处理ot
    // if (offTopicHide && !i.isDice) {
    //   const msg = i.message.replaceAll(/^[(（].+?$/gm, '') // 【
    //   if (msg.trim() === '') continue;
    // }
    let msg = msgImageFormat(i.message, store.exportOptions);
    msg = msgAtFormat(msg, store.pcList);
    msg = msgOffTopicFormat(msg, store.exportOptions, i.isDice);
    msg = msgCommandFormat(msg, store.exportOptions);
    msg = msgIMUseridFormat(msg, store.exportOptions, i.isDice);
    msg = msgOffTopicFormat(msg, store.exportOptions, i.isDice); // 再过滤一次
    if (msg.trim() === "") continue;

    i.index = index;
    tmp.push(i);
    index += 1;
  }
  previewItems.value = tmp;
}

const store = useStore();
store.colorMapLoad();

// 修改ot选项后重建items
watch(() => store.exportOptions.offTopicHide, showPreview);
watch(
  () => store.pcList.map((pc) => `${pc.IMUserId}-${pc.role}-${pc.name}`),
  () => showPreview(),
  { deep: false },
);

const editor = ref();
watch(isDark, () => {
  console.log("dark watch");
  store.reloadEditor();
});

const deletePc = (index: number, i: CharItem) => {
  const now = Date.now();
  if (now - lastNameChange < 100) return;
  lastNameChange = now;

  const m = modal.create({
    title: "删除角色",
    preset: "card",
    style: {
      width: "30rem",
    },
    content: `即将删除角色「${i.name}」及其全部发言，确定吗？`,
    footer: () => [
      h(
        NButton,
        {
          type: "default",
          onClick: () => m.destroy(),
          style: { marginRight: "1rem" },
        },
        () => "取消",
      ),
      h(
        NButton,
        {
          type: "primary",
          onClick: () => {
            try {
              store.pcList.splice(index, 1);
              logMan.deleteByCharItem(i);
            } finally {
              m.destroy();
            }
          },
        },
        () => "确定",
      ),
    ],
  });
};

let lastPCName = "";

const nameFocus = (i: CharItem) => {
  lastPCName = i.name;
};

let lastNameChange = 0;
const nameChanged = (i: CharItem) => {
  const now = Date.now();
  if (now - lastNameChange < 100) return;
  lastNameChange = now;

  const oldName = lastPCName; // 这样做的原因是，如果按回车确认，那么 nameFocus 会在promise触发前触发一遍导致无效
  const newName = i.name;
  if (oldName && newName) {
    const el = document.createElement("span");

    render(h("span", `${oldName}`), el);
    const name1 = el.innerHTML;

    render(h("span", `${newName}`), el);
    const name2 = el.innerHTML;

    render(h("span", `<${oldName}>`), el);
    const name1w = el.innerHTML;

    render(h("span", `<${newName}>`), el);
    const name2w = el.innerHTML;

    const m = modal.create({
      title: "名字变更",
      preset: "card",
      style: {
        width: "30rem",
      },
      content: () => [
        h(NText, {
          innerHTML: `即将进行名字变更 <b>${name1} -> ${name2}</b><br />将修改信息行，并在文本中进行批量替换（${name1w} 替换为 ${name2w}），确定吗？`,
        }),
      ],
      footer: () => [
        h(
          NButton,
          {
            type: "default",
            onClick: () => m.destroy(),
            style: { marginRight: "1rem" },
          },
          () => "取消",
        ),
        h(
          NButton,
          {
            type: "primary",
            onClick: () => {
              try {
                logMan.rename(i, oldName, newName);
              } catch (_e) {
                i.name = oldName;
              } finally {
                m.destroy();
              }
            },
          },
          () => "确定",
        ),
      ],
    });
  }
};

logMan.ev.on("textSet", (text) => {
  store.editor.dispatch({
    changes: { from: 0, to: store.editor.state.doc.length, insert: text },
  });

  let m = new Map<string, CharItem>();
  for (let i of logMan.curItems) {
    if (i.isRaw) continue;
    setCharInfo(m, i);
  }
  store.updatePcList(m);
});

logMan.ev.on("parsed", (ti: TextInfo) => {
  store.updatePcList(ti.charInfo);
  if (!applyingStoryChange && storyArchive.value && !storyArchive.value.document.settings.enabled) {
    const settings = storyArchive.value.document.settings;
    const assets = new Map(storyArchive.value.assets);
    storyArchive.value = {
      document: { ...storyFromLogItems(ti.items, [...ti.charInfo.values()], { assets }), settings },
      assets,
    };
    saveStoryDraft(storyArchive.value);
  }
});

const onChange = (v: ViewUpdate) => {
  let _payloadText = "";
  if (v) {
    if (v.docChanged) {
      const updateWithFlags = v as ViewUpdate & { readonly flags?: number };
      // 有一种我不太清楚的特殊情况会导致二次调用，从而使得pclist清零
      // 看不出明显变化，只是一个隐藏参数flags为0
      // 破案了，是flush
      if (!v.viewportChanged && updateWithFlags.flags === 0) {
        return;
      }

      const ranges: Array<{
        readonly fromA: number;
        readonly toA: number;
        readonly fromB: number;
        readonly toB: number;
      }> = [];
      v.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        ranges.push({ fromA, toA, fromB, toB });
      });
      if (ranges.length) {
        for (let i = ranges.length - 1; i >= 0; i--) {
          const payloadText = store.editor.state.doc.toString();

          const r1 = [ranges[i].fromA, ranges[i].toA];
          const r2 = [ranges[i].fromB, ranges[i].toB];

          console.log("XXX", v, r1, r2);
          if (r1[0] === 0 && r1[1] === logMan.lastText.length) {
            console.log("全部文本被删除，清除pc列表");
            store.pcList = [];
          }
          logMan.syncChange(payloadText, r1, r2);
        }
      }
    }
  }

  // payloadText = store.editor.state.doc.toString()
  // let isLog = false
};

const doEditorHighlightClick = (e: MouseEvent) => {
  // 因为原生click事件会执行两次，第一次在label标签上，第二次在input标签上，故此处理
  if (e.target instanceof HTMLInputElement) return;

  const doHl = () => {
    // 编辑器染色
    setTimeout(() => {
      store.reloadEditor();
    }, 500);
  };

  if (store.doEditorHighlight) {
    // 如果要开启
    if (isMobile.value) {
      const m = modal.create({
        title: "开启编辑器染色？",
        preset: "card",
        style: {
          width: "30rem",
        },
        content:
          "部分移动设备上的特定浏览器可能会因为兼容性问题而卡死，继续吗？",
        footer: () => [
          h(
            NButton,
            {
              type: "default",
              onClick: () => {
                store.doEditorHighlight = false;
                m.destroy();
                setTimeout(() => {
                  doFlush();
                }, 3000);
              },
              style: { marginRight: "1rem" },
            },
            () => "取消",
          ),
          h(
            NButton,
            {
              type: "primary",
              onClick: () => {
                try {
                  doHl();
                } catch (_e) {
                  // 重新关闭
                  setTimeout(() => {
                    store.doEditorHighlight = false;
                    store.reloadEditor();
                  }, 500);
                } finally {
                  m.destroy();
                }
              },
            },
            () => "确定",
          ),
        ],
      });

      return;
    }
  }

  doHl();
};

const reloadFunc = () => {
  store.reloadEditor();
};
const pcList = computed(() => store.pcList);
watch(pcList, reloadFunc, { deep: true });

const exportOptions = computed(() => store.exportOptions);
watch(exportOptions, reloadFunc, { deep: true });

const _code = ref("");
</script>

<style lang="scss">
#app {
  --home-ink: #17202a;
  --home-muted: #66717f;
  --home-line: #d8dde5;
  --home-paper: #f7f7f3;
  --home-panel: rgba(255, 255, 255, 0.88);
  --home-panel-solid: #ffffff;
  --home-soft: #eef2f5;
  --home-blue: #225da8;
  --home-green: #147157;
  --home-grid-blue: rgba(34, 93, 168, 0.055);
  --home-grid-green: rgba(20, 113, 87, 0.055);
  --home-shadow: 0 18px 42px rgba(31, 39, 53, 0.08);
  --home-radius: 8px;
  --home-radius-sm: 6px;
  min-height: 100vh;
  min-height: 100dvh;
  color: var(--home-ink);
  background:
    linear-gradient(90deg, var(--home-grid-blue) 1px, transparent 1px),
    linear-gradient(var(--home-grid-green) 1px, transparent 1px),
    var(--home-paper);
  background-size: 44px 44px;
  overflow-y: auto;
}

.dark #app {
  --home-ink: #e6edf3;
  --home-muted: #9aa8b7;
  --home-line: #2c3846;
  --home-paper: #0e1215;
  --home-panel: rgba(21, 27, 32, 0.88);
  --home-panel-solid: #151b20;
  --home-soft: #1d252b;
  --home-blue: #2f6fcb;
  --home-green: #22845f;
  --home-grid-blue: rgba(47, 111, 203, 0.1);
  --home-grid-green: rgba(34, 132, 95, 0.08);
  --home-shadow: 0 18px 42px rgba(0, 0, 0, 0.34);
}

.painter-home,
.painter-content {
  min-height: 100vh;
  color: var(--home-ink);
  background: transparent;
}

.painter-header {
  border-bottom: 1px solid var(--home-line);
  color: var(--home-ink);
  background: color-mix(in srgb, var(--home-panel-solid) 84%, transparent);
  backdrop-filter: blur(10px);
}

.painter-workspace {
  width: min(1000px, calc(100% - 28px));
  margin: 0 auto;
  padding-bottom: 3rem;
}

.painter-content .n-text {
  color: var(--home-muted);
}

.element-plus-logo {
  width: 50%;
}

.options > div {
  width: 30rem;
  max-width: 30rem;
  margin-bottom: 2rem;
}

.options > div > .switch {
  display: flex;
  align-items: center;
  justify-content: center;

  & > h4 {
    margin-top: 0rem;
    margin-bottom: 0rem;
    margin-left: 1rem;
  }
}

.myLineDecoration {
  // background: lightblue;
  margin-bottom: 20px;
  font-size: large;
}

.pc-list {
  display: grid;
  gap: 0;
  border: 1px solid var(--home-line);
  border-radius: var(--home-radius);
  margin: 0.75rem 0 1rem;
  box-shadow: var(--home-shadow);
  overflow: hidden;
}

.pc-row {
  display: grid;
  grid-template-columns:
    2.25rem minmax(9rem, 1.1fr) minmax(8rem, 1fr) minmax(7rem, 0.75fr)
    2.75rem;
  gap: 0.5rem;
  align-items: center;
  border-bottom: 1px solid var(--home-line);
  background: var(--home-panel);
  padding: 0.625rem;
}

.pc-row:last-child {
  border-bottom: 0;
}

.pc-row:nth-child(even) {
  background: color-mix(in srgb, var(--home-panel-solid) 72%, var(--home-soft));
}

.dark .pc-row {
  border-color: var(--home-line);
  background: var(--home-panel);
}

.dark .pc-row:nth-child(even) {
  background: color-mix(in srgb, var(--home-panel-solid) 78%, #080d12);
}

.pc-row__delete {
  justify-self: center;
}

.pc-row__color {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  border: 1px solid var(--home-line);
  border-radius: var(--home-radius-sm);
  background: var(--home-panel-solid);
  cursor: pointer;
  padding: 0.2rem;
}

.pc-row__color:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.pc-row__color span {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: calc(var(--home-radius-sm) - 2px);
  background: var(--pc-row-color, #64748b);
}

.workbench-actions {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
  gap: 0.75rem;
  margin: 1rem 0;
}

.action-card {
  border: 1px solid var(--home-line);
  border-radius: var(--home-radius);
  background: var(--home-panel);
  box-shadow: var(--home-shadow);
  overflow: hidden;
  padding: 0;
}

.dark .action-card {
  border-color: var(--home-line);
  background: var(--home-panel);
}

.action-card__title {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  border-bottom: 1px solid var(--home-line);
  margin: 0;
  padding: 0.625rem 0.75rem;
  color: var(--home-ink);
}

.dark .action-card__title {
  color: var(--home-ink);
}

.action-card__controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.75rem;
}

.action-card__controls--preview {
  align-items: center;
}

.editor-panel {
  margin-top: 1rem;
}

.editor-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--home-line);
  border-bottom: 0;
  border-radius: var(--home-radius) var(--home-radius) 0 0;
  background: var(--home-soft);
  padding: 0.625rem;
}

.dark .editor-toolbar {
  border-color: var(--home-line);
  background: #10161b;
}

.editor-toolbar__spacer {
  flex: 1;
}

.editor-codemirror {
  margin-top: 0;
}

.remote-load-frame {
  position: relative;
}

.remote-load-overlay {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 20;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--n-text-color);
  transform: translate(-50%, -50%);
}

.remote-load-spinner {
  width: 34px;
  height: 34px;
  border: 3px solid rgba(99, 226, 183, 0.24);
  border-top-color: #63e2b7;
  border-radius: 999px;
  animation: remote-load-rotate 0.8s linear infinite;
}

@keyframes remote-load-rotate {
  to {
    transform: rotate(360deg);
  }
}

.editor-codemirror .cm-editor {
  border: 1px solid var(--home-line);
  border-top: 0;
  box-shadow: none;
  line-height: 1.6;
  border-radius: 0 0 var(--home-radius) var(--home-radius);
}

.editor-codemirror .cm-line {
  line-height: 1.6;
  padding: 0 1rem;
}

.editor-codemirror .cm-gutters {
  padding-right: 0.35rem;
}

@media (max-width: 860px) {
  .pc-row {
    grid-template-columns: 2.25rem minmax(0, 1fr) 2.75rem;
  }

  .pc-row__im,
  .pc-row__role {
    grid-column: 2 / -1;
  }

  .workbench-actions {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 520px) {
  .pc-row {
    grid-template-areas:
      "name color delete"
      "im im im"
      "role role role";
    grid-template-columns: minmax(0, 1fr) 2.75rem 2.25rem;
    padding: 0.5rem;
  }

  .pc-row__name { grid-area: name; }
  .pc-row__im { grid-area: im; }
  .pc-row__role { grid-area: role; }
  .pc-row__delete { grid-area: delete; }

  .pc-row__color {
    grid-area: color;
  }

  .editor-toolbar {
    align-items: center;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .action-card__controls--downloads {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .editor-toolbar .n-button,
  .action-card__controls--downloads .n-button {
    width: 100%;
  }

  .editor-toolbar .n-checkbox {
    grid-column: 1 / -1;
  }

  .editor-toolbar__spacer {
    display: none;
  }
}

.preview {
  word-break: break-all;
  border: 1px solid var(--home-line);
  border-radius: var(--home-radius);
  background: var(--home-panel);
  box-shadow: var(--home-shadow);
  padding: 0.75rem;
  position: relative;
}

.list-dynamic {
  width: 100%;
  height: min(75dvh, 50rem);
  max-height: 50rem;
  overflow-y: auto;
}

.list-item-dynamic {
  // display: flex;
  // align-items: center;
  padding: 0.5em 0;
  border-color: var(--home-line);
}

.scroller {
  height: min(75dvh, 50rem);
}

.preview-copy-tools {
  align-items: flex-end;
  color: var(--home-muted);
  display: flex;
  flex-direction: column;
  font-size: 0.75rem;
  gap: 0.25rem;
  margin-bottom: 0.75rem;
}

.mobile-color-picker {
  display: grid;
  gap: 0.75rem;
}

.mobile-color-picker__hint {
  margin: 0;
}

.mobile-color-picker__trigger {
  align-items: center;
  background: var(--home-panel-solid);
  border: 1px solid var(--home-line);
  border-radius: var(--home-radius-sm);
  color: var(--home-ink);
  cursor: pointer;
  display: flex;
  font: inherit;
  gap: 0.75rem;
  min-height: 2.75rem;
  padding: 0.5rem 0.625rem;
  width: 100%;
}

.mobile-color-picker__trigger > span:first-child {
  background: var(--pc-row-color, #64748b);
  border-radius: calc(var(--home-radius-sm) - 2px);
  display: block;
  height: 1.75rem;
  width: 1.75rem;
}

.mobile-color-modal {
  align-self: flex-start;
  margin-top: 1rem;
  max-height: calc(100dvh - 2rem);
}

.mobile-color-modal .n-card__content {
  overflow: visible;
}
</style>

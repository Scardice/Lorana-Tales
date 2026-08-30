import type { EditorView } from "@codemirror/view";
import axios from "axios";
import { random } from "lodash-es";
import { defineStore } from "pinia";
import * as twColors from "tailwindcss/colors";
import { type CharItem, type LogItem, packNameId } from "./logManager/types";

const diceAPIBase = (import.meta.env.VITE_DICE_API_BASE || "/api/dice").replace(
  /\/+$/,
  "",
);

type UploadLogResponse = {
  readonly url: string;
};

class UploadLogResponseError extends Error {
  constructor() {
    super("上传接口没有返回可跳转链接");
    this.name = "UploadLogResponseError";
  }
}

export class UploadBlockedBySecurityError extends Error {
  readonly warningText: string;

  constructor(warningText: string) {
    super("上传内容已被安全系统拦截");
    this.name = "UploadBlockedBySecurityError";
    this.warningText = warningText;
  }
}

export const useStore = defineStore("main", {
  state: () => {
    return {
      index: 0,
      editor: undefined as unknown as EditorView,
      pcList: [] as CharItem[],
      pcNameColorMap: new Map<string, string>(), // 只以名字记录
      palette: [
        twColors.pink["600"],
        twColors.orange["600"],
        twColors.pink["400"],
        twColors.purple["400"],
        twColors.sky["600"],
        twColors.slate["400"],
        twColors.gray["600"],
      ],
      paletteStack: [] as string[],
      items: [] as LogItem[],
      doEditorHighlight: false,

      // 仅用于论坛代码
      randomBBSColorNames: [
        "skyblue",
        "royalblue",
        "darkblue",
        "orangered",
        "red",
        "firebrick",
        "darkred",
        "green",
        "limegreen",
        "seagreen",
        "tomato",
        "coral",
        "indigo",
        "burlywood",
        "sandybrown",
        "chocolate",
      ],
      randomBBSColorNamesMap: new Map<string, string>(),

      bbsUseSpaceWithMultiLine: false,
      bbsUseColorName: false,

      trgIsAddVoiceMark: false,

      previewElement: HTMLElement,
      _reloadEditor: (_highlight: boolean) => {},

      exportOptions: {
        commandHide: false,
        imageHide: false,
        offTopicHide: false,
        timeHide: false,
        userIdHide: true,
        yearHide: true,
        textIndentAll: false,
        textIndentFirst: true,
      },
    };
  },
  getters: {
    pcMap() {
      const m = new Map<string, CharItem>();
      for (const i of this.pcList) {
        m.set(packNameId(i), i);
      }
      return m;
    },
    hiddenIdSet(state): Set<string> {
      const set = new Set<string>();
      for (const pc of state.pcList) {
        if (pc.role === "隐藏" && pc.IMUserId && pc.name) {
          set.add(`${pc.IMUserId}-${pc.name}`);
        }
      }
      return set;
    },
  },
  actions: {
    async uploadLogFile(file: File): Promise<string> {
      const formData = new FormData();
      formData.append("name", file.name || "log.txt");
      formData.append("uniform_id", "scardice:web-upload");
      formData.append("file", file);

      let resp;
      try {
        resp = await axios.put<UploadLogResponse>(
          `${diceAPIBase}/log`,
          formData,
        );
      } catch (error) {
        if (
          axios.isAxiosError(error) &&
          error.response?.status === 422 &&
          typeof error.response.data === "string"
        ) {
          throw new UploadBlockedBySecurityError(error.response.data);
        }
        throw error;
      }
      const url = resp.data.url.trim();
      if (!url) {
        throw new UploadLogResponseError();
      }
      return url;
    },

    isHiddenLogItem(item: LogItem): boolean {
      if (item.role === "隐藏") return true;
      const id = packNameId(item);
      const pc = this.pcMap.get(id);
      if (pc?.role === "隐藏") return true;
      if (
        item.IMUserId &&
        this.hiddenIdSet.has(`${item.IMUserId}-${item.nickname}`)
      )
        return true;
      return false;
    },
    colorHexToName(color: string) {
      // nga全部可用颜色
      // "skyblue", "royalblue", "blue", "darkblue", "orange", "orangered", "crimson", "red", "firebrick", "darkred", "green", "limegreen", "seagreen", "teal", "deeppink", "tomato", "coral", "purple", "indigo", "burlywood", "sandybrown", "sienna", "chocolate", "silver"
      switch (color) {
        case twColors.amber["600"]:
          // 深棕色
          return "sienna";
        case twColors.pink["600"]:
          // 深粉色，没有类似的，用深红色替代了
          return "crimson";
        case twColors.orange["600"]:
          // 棕色 / 橙色
          return "orange";
        case twColors.pink["400"]:
          // 淡粉色
          return "deeppink";
        case twColors.purple["400"]:
          // 紫色
          return "purple";
        case twColors.sky["600"]:
          // 靛蓝色
          return "blue";
        case twColors.slate["400"]:
          // 青绿色
          return "teal";
        case twColors.gray["600"]:
        case twColors.gray["400"]:
          // 深灰色
          return "silver";
      }

      if (this.randomBBSColorNamesMap.get(color)) {
        return this.randomBBSColorNamesMap.get(color);
      }

      if (this.randomBBSColorNames.length === 0) {
        return "red";
      }

      const randomIndex = random(0, this.randomBBSColorNames.length - 1);
      const colorName = this.randomBBSColorNames.splice(randomIndex, 1)[0];

      this.randomBBSColorNamesMap.set(color, colorName);
      return colorName;
    },

    reloadEditor() {
      this._reloadEditor(this.doEditorHighlight);
    },

    colorMapSave() {
      localStorage.setItem(
        "pcNameColorMap",
        JSON.stringify([...this.pcNameColorMap]),
      );
    },

    colorMapLoad() {
      const lst = JSON.parse(localStorage.getItem("pcNameColorMap") || "[]");
      this.pcNameColorMap = new Map(lst);
    },

    getColor(): string {
      if (this.paletteStack.length === 0) {
        this.paletteStack = [...this.palette];
      }
      return this.paletteStack.shift() as string;
    },

    async tryFetchLog(key: string, password: string) {
      // Keep the decryption secret out of URLs, browser history and proxy logs.
      const resp = await axios.post(`${diceAPIBase}/load_data`, { key, password });
      return resp.data;
    },

    async tryFetchRKey() {
      const resp = await axios.get("https://dice-api.weizaima.com/api/v1/rkey");
      return resp.data as {
        private_rkey?: string;
        group_rkey?: string;
        expired_time?: number;
      };
    },

    /** 移除不使用的pc名字 */
    async pcNameRefresh() {
      const names = new Set<string>();
      const namesAll = new Set<string>();
      const namesToDelete = new Set<string>();

      for (const i of this.pcList) {
        namesAll.add(i.name);
      }

      for (const i of this.items) {
        names.add(i.nickname);
      }

      for (const i of namesAll) {
        if (!names.has(i)) {
          namesToDelete.add(i);
        }
      }

      for (const i of namesToDelete) {
        this.tryRemovePC(i);
      }
    },

    /** 更新pc列表 */
    async updatePcList(charInfo: Map<string, CharItem>) {
      const exists = new Set();
      let colorMapChanged = false;
      for (const i of this.pcList) {
        exists.add(packNameId(i));
      }

      for (const [_k, v] of charInfo) {
        const id = packNameId(v);
        if (!exists.has(id)) {
          let c = this.pcNameColorMap.get(v.name);
          if (!c) {
            c = this.getColor();
            this.pcNameColorMap.set(v.name, c);
            colorMapChanged = true;
          }
          v.color = c;
          this.pcList.push(v);
          exists.add(id);
        }
      }
      if (colorMapChanged) this.colorMapSave();
    },

    async tryRemovePC(name: string) {
      let index = 0;
      for (const i of this.pcList) {
        if (i.name === name) {
          this.pcList.splice(index, 1);
          break;
        }
        index += 1;
      }
    },
  },
});

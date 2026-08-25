export interface StoryPalette {
  id: string;
  label: string;
  nameDark: string;
  nameLight: string;
  bubbleDark: string;
  bubbleLight: string;
  textDark: "#ffffff";
  textLight: "#111111";
}

/** Curated pairs only: every dark bubble uses white text and every light bubble uses black text. */
export const storyPalettes: StoryPalette[] = [
  { id: "neutral", label: "中性灰", nameDark: "#b9c3c1", nameLight: "#34413f", bubbleDark: "#27302f", bubbleLight: "#e3e8e7", textDark: "#ffffff", textLight: "#111111" },
  { id: "ocean", label: "深海青", nameDark: "#6dd4d4", nameLight: "#155f64", bubbleDark: "#174b50", bubbleLight: "#cdebed", textDark: "#ffffff", textLight: "#111111" },
  { id: "forest", label: "森林绿", nameDark: "#72d6a2", nameLight: "#276044", bubbleDark: "#244437", bubbleLight: "#d7eadf", textDark: "#ffffff", textLight: "#111111" },
  { id: "amber", label: "琥珀棕", nameDark: "#e8bd68", nameLight: "#6c501d", bubbleDark: "#4b3a20", bubbleLight: "#f4e5c5", textDark: "#ffffff", textLight: "#111111" },
  { id: "rose", label: "雾玫瑰", nameDark: "#ee91ad", nameLight: "#7b3049", bubbleDark: "#562f3b", bubbleLight: "#f2dbe2", textDark: "#ffffff", textLight: "#111111" },
  { id: "plum", label: "梅子紫", nameDark: "#d9a0df", nameLight: "#68366d", bubbleDark: "#4a294c", bubbleLight: "#edd9ef", textDark: "#ffffff", textLight: "#111111" },
  { id: "indigo", label: "靛青蓝", nameDark: "#9ba9ef", nameLight: "#3d477e", bubbleDark: "#30365a", bubbleLight: "#dfe2f3", textDark: "#ffffff", textLight: "#111111" },
  { id: "brick", label: "砖红", nameDark: "#ef9a83", nameLight: "#7a3b2e", bubbleDark: "#57342d", bubbleLight: "#f2ddd7", textDark: "#ffffff", textLight: "#111111" },
];

export function storyPalette(id?: string) {
  return storyPalettes.find((item) => item.id === id);
}

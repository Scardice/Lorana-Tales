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

function parseHexColor(value?: string) {
  const match = value?.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map((part) => part + part).join("") : match[1];
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function luminance(rgb: number[]) {
  const channels = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: number[], b: number[]) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Keeps imported role hues while guaranteeing readable names in either theme. */
export function readableRoleColor(value: string | undefined, mode: "dark" | "light") {
  const fallback = mode === "dark" ? "#a7dad5" : "#315f64";
  const source = parseHexColor(value) || parseHexColor(fallback)!;
  const background = parseHexColor(mode === "dark" ? "#0d1514" : "#eef2f3")!;
  const target = parseHexColor(mode === "dark" ? "#edf3f2" : "#172220")!;
  if (contrast(source, background) >= 4.5) return `#${source.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  for (let step = 1; step <= 20; step += 1) {
    const ratio = step / 20;
    const mixed = source.map((channel, index) => Math.round(channel * (1 - ratio) + target[index] * ratio));
    if (contrast(mixed, background) >= 4.5) return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  }
  return fallback;
}

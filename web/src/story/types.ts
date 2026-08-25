import type { LogItem } from "~/logManager/types";

export const STORY_SCHEMA_VERSION = 4;

export type StoryPosition = "left" | "right" | "narrator";
export type StoryTheme = "auto" | "light" | "dark";
export type AvatarAlignment = "top" | "bottom";
export type PlaybackTimingMode = "fixed" | "dynamic";

export interface StoryAssetRef {
  id: string;
  mime: string;
  name?: string;
  width?: number;
  height?: number;
  sourceUrl?: string;
}

export interface StoryCharacter {
  id: string;
  name: string;
  imUserId: string;
  position: StoryPosition;
  color: string;
  avatar?: StoryAssetRef;
  avatarSource?: "qq" | "upload" | "package";
  /** Show this character's avatar inside narration bubbles when positioned as narrator. */
  narratorAvatar: boolean;
  isNarrator: boolean;
  isDice: boolean;
  hidden: boolean;
}

export interface StoryMessageBase {
  id: string;
  characterId: string;
  time: number;
  timeText?: string;
  sourceFingerprint?: string;
  sourceItem?: LogItem;
  sourcePartText?: string;
  locallyInserted?: boolean;
  conflict?: "source-changed" | "source-deleted";
  performance?: StoryMessagePerformance;
}

export interface StoryMessagePerformance {
  /** How long autoplay waits after this message has fully appeared. */
  durationMs?: number;
  /** Override global streaming for this message. */
  stream?: boolean;
  /** Extra delay after an individual segmented token, keyed by token index. */
  tokenDelays?: Record<number, number>;
  /** Automatically open an image after it appears, then close it after the configured time. */
  imagePreview?: {
    openAfterMs: number;
    durationMs: number;
  };
}

export interface StoryTextMessage extends StoryMessageBase {
  kind: "text";
  text: string;
}

export interface StoryImageMessage extends StoryMessageBase {
  kind: "image";
  asset: StoryAssetRef;
  alt?: string;
}

export type StoryMessage = StoryTextMessage | StoryImageMessage;

export interface StorySettings {
  enabled: boolean;
  mergeMessages: boolean;
  mergeNarration: boolean;
  showAvatars: boolean;
  avatarAlignment: AvatarAlignment;
  showNarratorAvatar: boolean;
  previewOnly: boolean;
  showQqInEditor: boolean;
  showQqInPreview: boolean;
  showNames: boolean;
  showNarratorNames: boolean;
  showTime: boolean;
  preserveLineBreaks: boolean;
  theme: StoryTheme;
  density: "compact" | "comfortable" | "spacious";
  fontSize: number;
  /** Avatar size for ordinary left/right speakers. */
  avatarSize: number;
  /** Smaller independent avatar size for narrator identity rows. */
  narratorAvatarSize: number;
  bubbleMaxWidth: number;
  canvasWidth: number;
  centerGutterPercent: number;
  /** Inline images are never enlarged; this only caps their rendered width against the canvas. */
  imageMaxWidthPercent: number;
  imageMaxHeightVh: number;
  animation: "none" | "fade" | "slide-fade";
  animationDurationMs: number;
  autoplay: boolean;
  playbackTiming: PlaybackTimingMode;
  fixedDelayMs: number;
  chineseCharsPerMinute: number;
  englishWordsPerMinute: number;
  streamEnabled: boolean;
  streamTokensPerSecond: number;
  streamPauseMinMs: number;
  streamPauseMaxMs: number;
  typingIndicatorEnabled: boolean;
  typingIndicatorText: string;
  typingIndicatorEffect: "dots" | "pulse" | "wave";
  typingIndicatorMs: number;
}

export interface StorySourceBinding {
  kind: "remote-log" | "file" | "none";
  key?: string;
  revision?: string;
  syncedAt?: string;
  name?: string;
}

export interface StoryDocument {
  format: "scardice-story-document";
  schemaVersion: number;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  characters: StoryCharacter[];
  messages: StoryMessage[];
  settings: StorySettings;
  source: StorySourceBinding;
}

export interface StoryArchive {
  document: StoryDocument;
  assets: Map<string, Uint8Array>;
}

export interface StoryPackageManifest {
  format: "scardice-story-package";
  version: 1;
  createdAt: string;
  document: string;
  files: Array<{
    path: string;
    sha256: string;
    size: number;
    mime: string;
  }>;
}

export const defaultStorySettings = (): StorySettings => ({
  enabled: true,
  mergeMessages: true,
  mergeNarration: false,
  showAvatars: true,
  avatarAlignment: "top",
  showNarratorAvatar: false,
  previewOnly: false,
  showQqInEditor: true,
  showQqInPreview: false,
  showNames: true,
  showNarratorNames: true,
  showTime: false,
  preserveLineBreaks: false,
  theme: "auto",
  density: "comfortable",
  fontSize: 16,
  avatarSize: 42,
  narratorAvatarSize: 28,
  bubbleMaxWidth: 78,
  canvasWidth: 1600,
  centerGutterPercent: 8,
  imageMaxWidthPercent: 72,
  imageMaxHeightVh: 65,
  animation: "slide-fade",
  animationDurationMs: 220,
  autoplay: false,
  playbackTiming: "dynamic",
  fixedDelayMs: 2500,
  chineseCharsPerMinute: 280,
  englishWordsPerMinute: 200,
  streamEnabled: false,
  streamTokensPerSecond: 8,
  streamPauseMinMs: 40,
  streamPauseMaxMs: 180,
  typingIndicatorEnabled: false,
  typingIndicatorText: "正在输入",
  typingIndicatorEffect: "dots",
  typingIndicatorMs: 700,
});

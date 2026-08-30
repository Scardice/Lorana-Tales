import type { LogItem } from "~/logManager/types";

export const STORY_SCHEMA_VERSION = 9;

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
	/** User-verified direct URL. It is intentionally not copied into server storage. */
	external?: boolean;
}

export interface StoryCharacter {
  id: string;
  name: string;
  imUserId: string;
  position: StoryPosition;
  color: string;
  /** Curated accessible identity palette. Arbitrary legacy colors remain import-only. */
  paletteId?: string;
  /** Curated default bubble palette for this character. */
  bubblePaletteId?: string;
  avatar?: StoryAssetRef;
  avatarSource?: "qq" | "discord" | "kook" | "upload" | "package";
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
  /** Stable story message id quoted by this message. CQ reply ids are resolved during import. */
  replyToId?: string;
  /** Deprecated import-only field; the editor only writes character-level palettes. */
  bubblePaletteId?: string;
  performance?: StoryMessagePerformance;
}

export interface StoryMessagePerformance {
  /** How long autoplay waits after this message has fully appeared. */
  durationMs?: number;
  /** Recorded duration of the typing indicator before the full message appears. */
  typingDurationMs?: number;
  /** Override global streaming for this message. */
  stream?: boolean;
  /** Extra delay after an individual segmented token, keyed by token index. */
  tokenDelays?: Record<number, number>;
  /** User-defined ranges that replace automatic word segmentation. */
  tokenGroups?: Array<{ start: number; end: number }>;
  /** Override the global per-token entrance animation for this message. */
  tokenAnimation?: StoryStreamTokenAnimation;
  /** Ordered, independently delayed visual effect segments. At most five are played. */
  effects?: StoryMessageEffectSegment[];
  /** One-shot screen effect fired when this message appears. */
  screenEffect?: StoryScreenEffect;
  /** Safe preset colour applied independently from the effect motion. */
  screenEffectColor?: StoryEffectColor;
  /** Base duration of one screen-effect cycle. */
  screenEffectDurationMs?: number;
  /** Playback speed applied to the base duration; 100 is normal speed. */
  screenEffectSpeedPercent?: number;
  /** Number of times the screen-effect cycle repeats. */
  screenEffectRepeat?: number;
  /** Choreographed interaction between the speaking character and another character. */
  interaction?: {
    effect: StoryInteractionEffect;
    targetCharacterId?: string;
    /** Optional user glyph override. Built-in resources are used when omitted. */
    emoji?: string;
    /** Independent response animation for the target; none supports deliberate non-response. */
    reaction?: StoryInteractionReaction;
    /** Tint for built-in interaction resources and the magic array. */
    color?: StoryEffectColor;
    /** Playback speed percentage for charge, travel and target reaction. */
    speedPercent?: number;
  };
  /** Automatically open an image after it appears, then close it after the configured time. */
  imagePreview?: {
    openAfterMs: number;
    durationMs: number;
  };
  /** Autoplay an audio message and block progression until it ends or reaches the limit. */
  audioPlayback?: { maxDurationMs: number };
  /** Visit the quoted message, then return to this message before progression continues. */
  replyPreview?: { durationMs: number };
}

export interface StoryMessageEffectSegment {
  id: string;
  /** Delay from the moment the message becomes visible. */
  delayMs: number;
  /** Optional animation applied to the message text/bubble at this point. */
  textAnimation?: StoryStreamTokenAnimation;
  screen?: {
    effect: Exclude<StoryScreenEffect, "none">;
    color?: StoryEffectColor;
    durationMs?: number;
    speedPercent?: number;
    repeat?: number;
  };
  interaction?: {
    effect: StoryInteractionEffect;
    targetCharacterId?: string;
    emoji?: string;
    reaction?: StoryInteractionReaction;
    color?: StoryEffectColor;
    speedPercent?: number;
  };
}

export type StoryStreamTokenAnimation = "none" | "fade" | "rise" | "blur" | "impact" | "shake" | "ghost";
export type StoryScreenEffect = "none" | "shake-light" | "shake-heavy" | "glow" | "warm-glow" | "cold-flash" | "flash" | "flicker" | "damage" | "heartbeat" | "blackout" | "dream" | "vignette" | "ripple" | "curtain" | "chromatic" | "zoom-focus";
export type StoryEffectColor = "auto" | "neutral" | "red" | "orange" | "gold" | "green" | "cyan" | "blue" | "purple" | "pink";
export type StoryInteractionEffect = "throw" | "heart" | "magic" | "magic-circle" | "surprise" | "impact" | "bullet" | "blade";
export type StoryInteractionReaction = "none" | "bounce" | "stagger" | "faint" | "shatter" | "gray" | "affection";
export type StoryCharacterState = "normal" | "gray" | "injured" | "frozen" | "cursed" | "out" | "dead" | "wasted";
export type StoryPersistentEffect = "low-health" | "curse" | "dream-haze" | "storm" | "magic-aura" | "rain-glass" | "blood-stain" | "snowfall" | "underwater" | "film-grain";

export interface StoryEffectTrack {
  id: string;
  effect: StoryPersistentEffect;
  color?: StoryEffectColor;
  /** Visual strength of the persistent effect. */
  intensityPercent?: number;
  /** Opacity of the persistent overlay. */
  opacityPercent?: number;
  /** Motion speed; 100 is the preset's natural speed. */
  speedPercent?: number;
  startMessageId: string;
  endMessageId: string;
}

export interface StoryCharacterStateEvent {
  id: string;
  characterId: string;
  state: StoryCharacterState;
  /** The state starts after this message and remains until another event for the character. */
  afterMessageId: string;
  /** Optional short badge, otherwise the state's localized default is used. */
  label?: string;
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

export interface StoryAudioMessage extends StoryMessageBase {
  kind: "audio";
  asset: StoryAssetRef;
  alt?: string;
  durationMs?: number;
	/** Optional transcript or sound description rendered inside the same bubble. */
	caption?: string;
}

export type StoryMessage = StoryTextMessage | StoryImageMessage | StoryAudioMessage;

export interface StorySettings {
  enabled: boolean;
  mergeMessages: boolean;
  mergeNarration: boolean;
	showAvatars: boolean;
	stickyGroupAvatar: boolean;
  avatarAlignment: AvatarAlignment;
  showNarratorAvatar: boolean;
  previewOnly: boolean;
  showQqInEditor: boolean;
  showQqInPreview: boolean;
  showNames: boolean;
  showNarratorNames: boolean;
  showTime: boolean;
  /** Hide text messages that start with ( or （ after optional mentions/whitespace. */
  hideOffTopic: boolean;
  /** Hide player dice commands such as .ra or /roll while keeping dice results. */
  hideDiceCommands: boolean;
  /** Enter key behavior in the editor composer. */
  enterKeyBehavior: "auto" | "send" | "newline";
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
  streamSpeedJitterPercent: number;
  streamPauseMinMs: number;
  streamPauseMaxMs: number;
  streamTokenAnimation: StoryStreamTokenAnimation;
  streamCursor: "none" | "bar" | "block" | "dot";
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
  format: "lorana-tales-document";
  schemaVersion: number;
  id: string;
  title: string;
  /** Human-facing signature embedded into SSP and standalone HTML exports. */
  author: string;
  createdAt: string;
  updatedAt: string;
  characters: StoryCharacter[];
  messages: StoryMessage[];
  /** Story-level persistent effects spanning an inclusive message range. */
  effectTracks: StoryEffectTrack[];
  /** Persistent per-character state changes ordered on the story timeline. */
  characterStateEvents: StoryCharacterStateEvent[];
  settings: StorySettings;
  source: StorySourceBinding;
}

export interface StoryArchive {
  document: StoryDocument;
  assets: Map<string, Uint8Array>;
}

export const defaultStorySettings = (): StorySettings => ({
  enabled: true,
  mergeMessages: true,
  mergeNarration: false,
	showAvatars: true,
	stickyGroupAvatar: true,
  avatarAlignment: "top",
  showNarratorAvatar: false,
  previewOnly: false,
  showQqInEditor: true,
  showQqInPreview: false,
  showNames: true,
  showNarratorNames: true,
  showTime: false,
  hideOffTopic: false,
  hideDiceCommands: false,
  enterKeyBehavior: "auto",
  preserveLineBreaks: true,
  theme: "auto",
  density: "comfortable",
  fontSize: 16,
  avatarSize: 42,
  narratorAvatarSize: 28,
  bubbleMaxWidth: 78,
  canvasWidth: 4096,
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
  streamTokensPerSecond: 12,
  streamSpeedJitterPercent: 25,
  streamPauseMinMs: 25,
  streamPauseMaxMs: 120,
  streamTokenAnimation: "rise",
  streamCursor: "bar",
  typingIndicatorEnabled: false,
  typingIndicatorText: "正在输入",
  typingIndicatorEffect: "dots",
  typingIndicatorMs: 700,
});

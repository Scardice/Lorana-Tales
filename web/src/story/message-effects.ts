import { createStoryId } from "./model";
import type { StoryInteractionEffect, StoryInteractionReaction, StoryMessageEffectSegment, StoryMessagePerformance } from "./types";

export const MAX_MESSAGE_EFFECT_SEGMENTS = 5;
export const INTERACTION_BASE_DURATION_MS = {throw:1900,heart:2200,magic:2600,"magic-circle":2300,surprise:1900,impact:1900,bullet:1750,blade:2100} as const;
export const INTERACTION_DEFAULT_REACTION: Record<StoryInteractionEffect, StoryInteractionReaction> = {
  throw: "stagger",
  heart: "affection",
  magic: "stagger",
  "magic-circle": "none",
  surprise: "bounce",
  impact: "stagger",
  bullet: "faint",
  blade: "faint",
};

function fromLegacy(performance?: StoryMessagePerformance): StoryMessageEffectSegment[] {
  if (!performance) return [];
  const hasScreen = !!performance.screenEffect && performance.screenEffect !== "none";
  if (!performance.tokenAnimation && !hasScreen && !performance.interaction) return [];
  return [{
    id: createStoryId("message-effect"),
    delayMs: 0,
    textAnimation: performance.tokenAnimation,
    ...(hasScreen ? { screen: {
      effect: performance.screenEffect as NonNullable<StoryMessageEffectSegment["screen"]>["effect"],
      color: performance.screenEffectColor,
      durationMs: performance.screenEffectDurationMs,
      speedPercent: performance.screenEffectSpeedPercent,
      repeat: performance.screenEffectRepeat,
    } } : {}),
    ...(performance.interaction ? { interaction: { ...performance.interaction } } : {}),
  }];
}

export function messageEffectSegments(performance?: StoryMessagePerformance): StoryMessageEffectSegment[] {
  const source = performance?.effects?.length ? performance.effects : fromLegacy(performance);
  return source.slice(0, MAX_MESSAGE_EFFECT_SEGMENTS).map((segment) => ({
    ...segment,
		...(segment.screen ? { screen: { ...segment.screen } } : {}),
		...(segment.interaction ? { interaction: { ...segment.interaction } } : {}),
    id: segment.id || createStoryId("message-effect"),
    delayMs: Math.max(0, Math.min(120_000, Math.round(segment.delayMs || 0))),
  }));
}

export function effectSegmentDuration(segment: StoryMessageEffectSegment): number {
  const screen = segment.screen
    ? Math.round(Math.max(120, segment.screen.durationMs || 900) * 100 / Math.max(25, segment.screen.speedPercent || 100)) * Math.max(1, Math.min(12, segment.screen.repeat || 1))
    : 0;
  const interaction = segment.interaction ? Math.round(INTERACTION_BASE_DURATION_MS[segment.interaction.effect] * 100 / Math.max(25, segment.interaction.speedPercent || 100)) : 0;
  const text = segment.textAnimation && segment.textAnimation !== "none" ? 650 : 0;
  return Math.max(screen, interaction, text);
}

export function clearLegacyMessageEffects(performance: StoryMessagePerformance) {
  delete performance.tokenAnimation;
  delete performance.screenEffect;
  delete performance.screenEffectColor;
  delete performance.screenEffectDurationMs;
  delete performance.screenEffectSpeedPercent;
  delete performance.screenEffectRepeat;
  delete performance.interaction;
}

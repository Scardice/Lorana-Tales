import type { StoryMessage } from "./types";

// CQ metadata may precede the visible bracket without whitespace. Mentions and
// multiple CQ codes can be mixed before the actual off-topic text.
const OFF_TOPIC_PREFIX = /^\s*(?:(?:\[CQ:[^\]\r\n]*\])\s*|(?:@\S+\s+))*[（(]/i;
const CQ_PREFIX = /\[CQ:[A-Za-z0-9_-]+(?:,|\])/i;
const CQ_IMAGE_PREFIX = /\[CQ:image(?:,|\])/i;
const CQ_AUDIO_PREFIX = /\[CQ:(?:record|voice|audio)(?:,|\])/i;

export function isStoryOffTopicText(text: string) {
	return OFF_TOPIC_PREFIX.test(text);
}

export function isStoryOffTopicMessage(message: StoryMessage) {
	return message.kind === "text" && isStoryOffTopicText(message.text);
}

export function isStoryDiceCommandMessage(message: StoryMessage) {
	return message.kind === "text" && /^\s*[.。/](?![.。/])/.test(message.text);
}

export function isStoryImageMessage(message: StoryMessage) {
	return message.kind === "image" || (message.kind === "text" && CQ_IMAGE_PREFIX.test(message.text));
}

export function isStoryAudioMessage(message: StoryMessage) {
	return message.kind === "audio" || (message.kind === "text" && CQ_AUDIO_PREFIX.test(message.text));
}

/**
 * Imported single image/audio CQ messages are normalized into typed messages,
 * so the broad CQ category deliberately includes both typed media and CQ text.
 */
export function isStoryCqMessage(message: StoryMessage) {
	return message.kind === "image" || message.kind === "audio" || CQ_PREFIX.test(message.text);
}

/**
 * Remove raw CQ tokens while preserving the surrounding text and editor-only
 * metadata such as replyToId. CQ attributes can themselves contain bracketed
 * summaries or Markdown URLs, so a flat `[^]]+` expression is not sufficient.
 * Typed image/audio messages represent a CQ resource with no remaining text
 * body and therefore become empty.
 */
export function withoutStoryCqCodes(message: StoryMessage): StoryMessage | null {
	if (message.kind !== "text") return null;
	const source = message.text;
	const marker = /\[CQ:[A-Za-z0-9_-]+(?:,|\])/gi;
	let cursor = 0;
	let output = "";
	let match: RegExpExecArray | null;
	while ((match = marker.exec(source))) {
		let end = marker.lastIndex;
		if (!match[0].endsWith("]")) {
			let depth = 0;
			end = -1;
			for (let index = match.index; index < source.length; index += 1) {
				if (source[index] === "[") depth += 1;
				else if (source[index] === "]" && --depth === 0) { end = index + 1; break; }
			}
			if (end < 0) break;
		}
		output += source.slice(cursor, match.index);
		cursor = end;
		marker.lastIndex = end;
	}
	output += source.slice(cursor);
	const text = output.trim();
	return text ? { ...message, text } : null;
}

export function isStoryMessageFiltered(message: StoryMessage, settings: {
	hideOffTopic?: boolean;
	hideDiceCommands?: boolean;
	hideImages?: boolean;
	hideAudio?: boolean;
	hideCqCodes?: boolean;
}) {
	return !!(
		(settings.hideOffTopic && isStoryOffTopicMessage(message)) ||
		(settings.hideDiceCommands && isStoryDiceCommandMessage(message)) ||
		(settings.hideImages && isStoryImageMessage(message)) ||
		(settings.hideAudio && isStoryAudioMessage(message)) ||
		(settings.hideCqCodes && isStoryCqMessage(message) && !withoutStoryCqCodes(message))
	);
}

/** A display-only copy. Never use this value as the source for editing/saving. */
export function storyMessageForDisplay(message: StoryMessage, settings: Parameters<typeof isStoryMessageFiltered>[1]): StoryMessage | null {
	if (isStoryMessageFiltered(message, settings)) return null;
	return settings.hideCqCodes && isStoryCqMessage(message) ? withoutStoryCqCodes(message) : message;
}

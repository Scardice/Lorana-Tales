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
		(settings.hideCqCodes && isStoryCqMessage(message))
	);
}

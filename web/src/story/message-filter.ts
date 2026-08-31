import type { StoryMessage } from "./types";

// CQ metadata may precede the visible bracket without whitespace. Mentions and
// multiple CQ codes can be mixed before the actual off-topic text.
const OFF_TOPIC_PREFIX = /^\s*(?:(?:\[CQ:[^\]\r\n]*\])\s*|(?:@\S+\s+))*[（(]/i;

export function isStoryOffTopicText(text: string) {
	return OFF_TOPIC_PREFIX.test(text);
}

export function isStoryOffTopicMessage(message: StoryMessage) {
	return message.kind === "text" && isStoryOffTopicText(message.text);
}

export function isStoryDiceCommandMessage(message: StoryMessage) {
	return message.kind === "text" && /^\s*[.。/](?![.。/])/.test(message.text);
}

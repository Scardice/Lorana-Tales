import type { StoryDocument, StoryMessagePerformance } from './types';

/** Repair references after structural edits, without dropping valid effects or messages.
 * A removed/self interaction target becomes the supported sender-only interaction.
 * Call inside the editor's copy-on-write transaction, not on the source archive.
 */
export function repairStoryReferences(document: StoryDocument) {
  const characters = new Set(document.characters.map(character => character.id));
  const messages = new Set(document.messages.map(message => message.id));
  for (const message of document.messages) {
    if (message.replyToId && !messages.has(message.replyToId)) {
      delete message.replyToId;
      if (message.performance) delete message.performance.replyPreview;
    }
    const repairTarget = (interaction: StoryMessagePerformance['interaction']) => {
      const target = interaction?.targetCharacterId;
      if (interaction && target && (target === message.characterId || !characters.has(target))) delete interaction.targetCharacterId;
    };
    repairTarget(message.performance?.interaction);
    for (const segment of message.performance?.effects || []) repairTarget(segment.interaction);
  }
  document.effectTracks = document.effectTracks.filter(track => messages.has(track.startMessageId) && messages.has(track.endMessageId));
  document.characterStateEvents = document.characterStateEvents.filter(event => characters.has(event.characterId) && messages.has(event.afterMessageId));
}

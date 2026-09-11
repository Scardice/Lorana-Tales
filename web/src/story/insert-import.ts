import { createStoryId } from "./model";
import type { StoryArchive, StoryAssetRef, StoryCharacter, StoryMessage, StoryMessageEffectSegment } from "./types";

export type StoryCharacterImportChoice =
  | { sourceCharacterId: string; action: "new"; character?: Partial<Omit<StoryCharacter, "id">> }
  | { sourceCharacterId: string; action: "ignore" }
  | { sourceCharacterId: string; action: "merge"; targetCharacterId: string };

export interface StoryInsertionResult {
  archive: StoryArchive;
  insertedMessageIds: string[];
  createdCharacterIds: string[];
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

export function suggestedCharacterImportChoices(current: StoryArchive, incoming: StoryArchive): StoryCharacterImportChoice[] {
  const narrator = current.document.characters.find((character) => character.isNarrator);
  return incoming.document.characters.map((source) => {
    if (source.isNarrator && narrator) return { sourceCharacterId: source.id, action: "merge", targetCharacterId: narrator.id };
    const qq = source.imUserId.trim();
    const sameIdentity = qq ? current.document.characters.find((character) => character.imUserId.trim() === qq) : undefined;
    return sameIdentity
      ? { sourceCharacterId: source.id, action: "merge", targetCharacterId: sameIdentity.id }
      : { sourceCharacterId: source.id, action: "new" };
  });
}

function remapInteraction(segment: StoryMessageEffectSegment, characterIds: Map<string, string | null>): StoryMessageEffectSegment {
  const copy = structuredClone(segment);
  copy.id = createStoryId("message-effect");
  if (copy.interaction?.targetCharacterId) {
    const target = characterIds.get(copy.interaction.targetCharacterId);
    if (target) copy.interaction.targetCharacterId = target;
    else delete copy.interaction.targetCharacterId;
  }
  return copy;
}

/** Insert an imported story fragment without replacing the current document identity, settings or source binding. */
export function insertStoryArchive(
  current: StoryArchive,
  incoming: StoryArchive,
  choices: readonly StoryCharacterImportChoice[],
  insertionIndex: number,
): StoryInsertionResult {
  const archive: StoryArchive = { document: structuredClone(current.document), assets: new Map(current.assets) };
  const choiceMap = new Map(choices.map((choice) => [choice.sourceCharacterId, choice]));
  const characterIds = new Map<string, string | null>();
  const createdCharacterIds: string[] = [];
  const assetIds = new Map<string, string>();

  const remapAsset = (reference?: StoryAssetRef): StoryAssetRef | undefined => {
    if (!reference) return undefined;
    const existingMapping = assetIds.get(reference.id);
    if (existingMapping) return { ...reference, id: existingMapping };
    const incomingBytes = incoming.assets.get(reference.id);
    let nextId = reference.id;
    const currentBytes = archive.assets.get(nextId);
    if (incomingBytes && currentBytes && !equalBytes(incomingBytes, currentBytes)) nextId = createStoryId("asset");
    if (incomingBytes && !archive.assets.has(nextId)) archive.assets.set(nextId, incomingBytes.slice());
    assetIds.set(reference.id, nextId);
    return { ...reference, id: nextId };
  };

  for (const source of incoming.document.characters) {
    const choice = choiceMap.get(source.id) || { sourceCharacterId: source.id, action: "new" as const };
    if (choice.action === "ignore") { characterIds.set(source.id, null); continue; }
    if (choice.action === "merge") {
      const target = archive.document.characters.find((character) => character.id === choice.targetCharacterId);
      characterIds.set(source.id, target?.id || null);
      continue;
    }
    const id = createStoryId("character");
    const customized = { ...structuredClone(source), ...structuredClone(choice.character || {}) };
    const character: StoryCharacter = { ...customized, id, avatar: remapAsset(customized.avatar) };
    archive.document.characters.push(character);
    characterIds.set(source.id, id);
    createdCharacterIds.push(id);
  }

  const messageIds = new Map<string, string>();
  const retainedMessages = incoming.document.messages.filter((message) => !!characterIds.get(message.characterId));
  for (const message of retainedMessages) messageIds.set(message.id, createStoryId("message"));
  const insertedMessages: StoryMessage[] = retainedMessages.map((source) => {
    const message = structuredClone(source) as StoryMessage;
    message.id = messageIds.get(source.id)!;
    message.characterId = characterIds.get(source.characterId)!;
    message.locallyInserted = true;
    message.sourceFingerprint = "";
    delete message.conflict;
    if (message.replyToId) message.replyToId = messageIds.get(message.replyToId);
    if (message.performance?.interaction?.targetCharacterId) {
      const target = characterIds.get(message.performance.interaction.targetCharacterId);
      if (target && target !== message.characterId) message.performance.interaction.targetCharacterId = target;
      else delete message.performance.interaction.targetCharacterId;
    }
    if (message.performance?.effects) {
      message.performance.effects = message.performance.effects.map((segment) => {
        const copy = remapInteraction(segment, characterIds);
        if (copy.interaction?.targetCharacterId === message.characterId) delete copy.interaction.targetCharacterId;
        return copy;
      });
    }
    if (message.kind !== "text") message.asset = remapAsset(message.asset)!;
    return message;
  });

  const safeIndex = Math.max(0, Math.min(archive.document.messages.length, Math.trunc(insertionIndex)));
  archive.document.messages.splice(safeIndex, 0, ...insertedMessages);
  for (const track of incoming.document.effectTracks) {
    const startMessageId = messageIds.get(track.startMessageId), endMessageId = messageIds.get(track.endMessageId);
    if (startMessageId && endMessageId) archive.document.effectTracks.push({ ...structuredClone(track), id: createStoryId("effect"), startMessageId, endMessageId });
  }
  for (const event of incoming.document.characterStateEvents) {
    const characterId = characterIds.get(event.characterId), afterMessageId = messageIds.get(event.afterMessageId);
    if (characterId && afterMessageId) archive.document.characterStateEvents.push({ ...structuredClone(event), id: createStoryId("state"), characterId, afterMessageId });
  }
  archive.document.updatedAt = new Date().toISOString();
  return { archive, insertedMessageIds: insertedMessages.map((message) => message.id), createdCharacterIds };
}

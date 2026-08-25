import { createStoryId } from "./model";
import type { StoryCharacter, StoryDocument, StoryMessage } from "./types";

export interface StorySyncResult {
  document: StoryDocument;
  added: number;
  updated: number;
  removed: number;
  conflicts: number;
}

function sourceText(message: StoryMessage): string {
  if (message.kind !== "text") return message.asset.sourceUrl || message.asset.id;
  return message.text;
}

function originalText(message: StoryMessage): string {
  return message.sourcePartText || message.sourceItem?.message || sourceText(message);
}

function locallyChanged(message: StoryMessage): boolean {
  if (message.locallyInserted) return true;
  return sourceText(message).trimEnd() !== originalText(message).trimEnd();
}

function charIdentity(character: StoryCharacter): string {
  return `${character.imUserId}\u0000${character.name}`;
}

export function mergeStorySource(local: StoryDocument, incoming: StoryDocument): StorySyncResult {
  const mergedCharacters = local.characters.map((character) => ({ ...character }));
  const localCharByIdentity = new Map(mergedCharacters.map((character) => [charIdentity(character), character]));
  const incomingCharMap = new Map<string, string>();
  for (const character of incoming.characters) {
    if (character.isNarrator) {
      incomingCharMap.set(character.id, "character-narrator");
      continue;
    }
    const identity = charIdentity(character);
    let target = localCharByIdentity.get(identity);
    if (!target) {
      target = { ...character, id: createStoryId("character") };
      mergedCharacters.push(target);
      localCharByIdentity.set(identity, target);
    }
    incomingCharMap.set(character.id, target.id);
  }

  const sourceMessages = new Map(
    local.messages
      .filter((message) => message.sourceFingerprint)
      .map((message) => [message.sourceFingerprint as string, message]),
  );
  const incomingFingerprints = new Set<string>();
  const replacementByFingerprint = new Map<string, StoryMessage>();
  let added = 0;
  let updated = 0;
  let removed = 0;
  let conflicts = 0;

  for (const incomingMessage of incoming.messages) {
    const fingerprint = incomingMessage.sourceFingerprint;
    if (!fingerprint) continue;
    incomingFingerprints.add(fingerprint);
    const existing = sourceMessages.get(fingerprint);
    const remapped = {
      ...incomingMessage,
      characterId: incomingCharMap.get(incomingMessage.characterId) || incomingMessage.characterId,
    } as StoryMessage;
    if (!existing) {
      replacementByFingerprint.set(fingerprint, remapped);
      added += 1;
      continue;
    }
    const sourceChanged = sourceText(remapped).trimEnd() !== originalText(existing).trimEnd();
    if (sourceChanged && locallyChanged(existing)) {
      replacementByFingerprint.set(fingerprint, { ...existing, conflict: "source-changed" });
      conflicts += 1;
    } else if (sourceChanged) {
      replacementByFingerprint.set(fingerprint, { ...remapped, id: existing.id });
      updated += 1;
    } else {
      replacementByFingerprint.set(fingerprint, existing);
    }
  }

  const emitted = new Set<string>();
  const mergedMessages: StoryMessage[] = [];
  for (const message of local.messages) {
    if (!message.sourceFingerprint) {
      mergedMessages.push(message);
      continue;
    }
    const replacement = replacementByFingerprint.get(message.sourceFingerprint);
    if (replacement) {
      mergedMessages.push(replacement);
      emitted.add(message.sourceFingerprint);
    } else if (locallyChanged(message)) {
      mergedMessages.push({ ...message, conflict: "source-deleted" });
      conflicts += 1;
    } else {
      removed += 1;
    }
  }

  for (const message of incoming.messages) {
    const fingerprint = message.sourceFingerprint;
    if (!fingerprint || emitted.has(fingerprint) || !incomingFingerprints.has(fingerprint)) continue;
    const replacement = replacementByFingerprint.get(fingerprint);
    if (replacement) mergedMessages.push(replacement);
  }

  return {
    document: {
      ...local,
      characters: mergedCharacters,
      messages: mergedMessages,
      updatedAt: new Date().toISOString(),
      source: {
        ...local.source,
        revision: incoming.source.revision,
        syncedAt: new Date().toISOString(),
      },
    },
    added,
    updated,
    removed,
    conflicts,
  };
}

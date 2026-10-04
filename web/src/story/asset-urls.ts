import type { StoryArchive, StoryAssetRef } from './types';

/** Resource IDs are scoped to an archive, not globally unique across SSPs. */
export function createStoryAssetUrls(current: () => StoryArchive | undefined) {
  const urls = new Map<string, { bytes: Uint8Array; url: string }>();
  let indexed: StoryArchive['document'] | undefined;
  let mimeById = new Map<string, string>();
  function resolve(id: string) {
    const archive = current(), bytes = archive?.assets.get(id), cached = urls.get(id);
    if (cached && cached.bytes === bytes) return cached.url;
    if (cached) { URL.revokeObjectURL(cached.url); urls.delete(id); }
    if (!archive || !bytes) return id;
    if (indexed !== archive.document) {
      indexed = archive.document;
      const refs = [...indexed.characters.map(c => c.avatar), ...indexed.messages.map(m => m.kind === 'text' ? undefined : m.asset)];
      mimeById = new Map(refs.filter((r): r is StoryAssetRef => !!r).map(r => [r.id, r.mime]));
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeById.get(id) || 'application/octet-stream' }));
    urls.set(id, { bytes, url });
    return url;
  }
  function prune() { for (const [id, cached] of urls) if (current()?.assets.get(id) !== cached.bytes) { URL.revokeObjectURL(cached.url); urls.delete(id); } }
  function dispose() { for (const { url } of urls.values()) URL.revokeObjectURL(url); urls.clear(); mimeById.clear(); indexed = undefined; }
  return { resolve, prune, dispose };
}

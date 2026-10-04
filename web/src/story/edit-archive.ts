import { toRaw } from 'vue';
import type { StoryArchive } from './types';

type State = { base: any; copy?: any; children: Map<PropertyKey, State>; assigned: Set<PropertyKey>; proxy: any };
const draftable = (value: any) => value && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);

/** Copy only changed paths in our JSON document. Media buffers stay immutable and shared.
 * Drafts are transaction-local: none may escape into the returned archive or Vue state.
 */
export function editStoryArchive(source: StoryArchive, mutate: (draft: StoryArchive) => void): StoryArchive {
  const states = new WeakMap<object, State>();
  const copy = (s: State) => s.copy ||= Array.isArray(s.base) ? s.base.slice() : { ...s.base };
  function draft(value: any): State {
    const base = toRaw(value);
    const s: State = { base, children: new Map(), assigned: new Set(), proxy: null };
    s.proxy = new Proxy(base, {
      get(_target, key) {
        const current = (s.copy || s.base)[key];
        if (!draftable(current)) return current;
        if (states.has(current)) return current;
        let child = s.children.get(key);
        if (!child || child.base !== toRaw(current)) { child = draft(current); s.children.set(key, child); }
        return child.proxy;
      },
      set(_target, key, value) { if ((s.copy || s.base)[key] !== value) { copy(s)[key] = value; s.assigned.add(key); s.children.delete(key); } return true; },
      deleteProperty(_target, key) { delete copy(s)[key]; s.children.delete(key); s.assigned.add(key); return true; },
      has(_target, key) { return key in (s.copy || s.base); },
      ownKeys() { return Reflect.ownKeys(s.copy || s.base); },
      getOwnPropertyDescriptor(_target, key) { return Object.getOwnPropertyDescriptor(s.copy || s.base, key); },
    });
    states.set(s.proxy, s);
    return s;
  }
  function finishAssigned(value: any): any {
    const raw = toRaw(value); if (raw !== value && !states.has(value)) return finishAssigned(raw);
    if (!draftable(value)) return value;
    const state = states.get(value);
    if (state) return finish(state);
    // New arrays/objects may contain drafts (filter/map/spread). Unwrap only those paths.
    let result = value;
    for (const key of Object.keys(value)) {
      const next = finishAssigned(value[key]);
      if (next !== value[key]) { if (result === value) result = Array.isArray(value) ? value.slice() : { ...value }; result[key] = next; }
    }
    return result;
  }
  function finish(s: State): any {
    for (const [key, child] of s.children) {
      const next = finish(child);
      if (next !== child.base) copy(s)[key] = next;
    }
    for (const key of s.assigned) if (key in (s.copy || s.base)) copy(s)[key] = finishAssigned(s.copy[key]);
    return s.copy || s.base;
  }
  const document = draft(source.document);
  const archive: StoryArchive = { document: document.proxy, assets: new Map(toRaw(source.assets)) };
  mutate(archive);
  archive.document.updatedAt = new Date().toISOString();
  return { document: archive.document === document.proxy ? finish(document) : finishAssigned(archive.document), assets: archive.assets };
}

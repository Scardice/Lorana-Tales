// Each tab/document owns a writer. Recovery is a pointer, never a shared writer.
export function createDraftWorkspace(sourceKey: string) {
  const legacyKey = `story:${location.origin}/story?key=${sourceKey}`;
  const pointer = `${legacyKey}::active`;
  const prefix = `${legacyKey}::workspace:`;
  const read = (storage: Storage) => {
    try { const key = storage.getItem(pointer); return key?.startsWith(prefix) ? key : null; } catch { return null; }
  };
  const write = (storage: Storage, key: string) => { try { storage.setItem(pointer, key); } catch { /* IndexedDB still works without a pointer. */ } };
  const fresh = () => prefix + Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');
  const sessionKey = read(sessionStorage);
  const restoreKey = sessionKey || read(localStorage) || legacyKey;
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  // A duplicated tab may inherit sessionStorage: normal navigation must fork it.
  let key = sessionKey && (navigation?.type === 'reload' || navigation?.type === 'back_forward') ? sessionKey : fresh();
  write(sessionStorage, key);
  return {
    restoreKey,
    get key() { return key; },
    fork() { key = fresh(); write(sessionStorage, key); },
    saved(savedKey: string) { if (savedKey === key) write(localStorage, key); },
    cleared() { key = fresh(); write(sessionStorage, key); write(localStorage, key); },
  };
}

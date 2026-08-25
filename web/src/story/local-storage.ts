import type { StoryArchive } from "./types";

const DATABASE = "scardice-story-editor";
const STORE = "drafts";
const VERSION = 1;

type StoredDraft = {
  key: string;
  document: StoryArchive["document"];
  assets: Array<[string, ArrayBuffer]>;
  savedAt: string;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadLocalStoryDraft(key: string): Promise<StoryArchive | null> {
  const db = await openDatabase();
  try {
    const value = await new Promise<StoredDraft | undefined>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result as StoredDraft | undefined);
      request.onerror = () => reject(request.error);
    });
    if (!value) return null;
    return {
      document: value.document,
      assets: new Map(value.assets.map(([id, bytes]) => [id, new Uint8Array(bytes)])),
    };
  } finally {
    db.close();
  }
}

export async function saveLocalStoryDraft(key: string, archive: StoryArchive): Promise<void> {
  const db = await openDatabase();
  try {
    const value: StoredDraft = {
      key,
      // IndexedDB cannot clone Vue proxies. The persistence boundary always
      // receives plain JSON and independent buffers, regardless of caller.
      document: JSON.parse(JSON.stringify(archive.document)) as StoryArchive["document"],
      assets: [...archive.assets].map(([id, bytes]) => [id, Uint8Array.from(bytes).buffer]),
      savedAt: new Date().toISOString(),
    };
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteLocalStoryDraft(key: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

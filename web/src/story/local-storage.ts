import { toRaw } from 'vue';
import type { StoryArchive } from './types';

const DATABASE = 'scardice-story-editor';
const STORE = 'drafts';
const ASSETS = 'draft-assets';
type StoredDraft = { key: string; document: StoryArchive['document']; assets?: Array<[string, ArrayBuffer]>; assetIds?: string[]; savedAt: string };
const savedAssets = new Map<string, Map<string, WeakRef<Uint8Array>>>();
function rememberAssets(key:string,assets:Map<string,Uint8Array>){savedAssets.delete(key);savedAssets.set(key,new Map([...assets].map(([id,bytes])=>[id,new WeakRef(bytes)])));if(savedAssets.size>8)savedAssets.delete(savedAssets.keys().next().value!);}
const queues = new Map<string, Promise<unknown>>();

function queued<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(operation);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS);
    };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
  });
}
function completed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('草稿写入未完成'));
  });
}
function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export async function loadLocalStoryDraft(key: string): Promise<StoryArchive | null> {
  const db = await openDatabase();
  try {
    const value = await requested<StoredDraft | undefined>(db.transaction(STORE).objectStore(STORE).get(key));
    if (!value) return null;
    let assets: Map<string, Uint8Array>;
    if (value.assetIds) {
      const transaction = db.transaction(ASSETS), store = transaction.objectStore(ASSETS);
      const pairs = await Promise.all(value.assetIds.map(async id => [id, await requested<ArrayBuffer | Uint8Array | undefined>(store.get([key, id]))] as const));
      assets = new Map(pairs.filter((pair): pair is readonly [string, ArrayBuffer | Uint8Array] => !!pair[1]).map(([id, bytes]) => [id, new Uint8Array(bytes)]));
      rememberAssets(key,assets);
    } else assets = new Map((value.assets || []).map(([id, bytes]) => [id, new Uint8Array(bytes)]));
    return { document: value.document, assets };
  } finally { db.close(); }
}
export function saveLocalStoryDraft(key: string, archive: StoryArchive): Promise<void> {
  return queued(key, async () => {
    const db = await openDatabase();
    try {
      const previous = await requested<StoredDraft | undefined>(db.transaction(STORE).objectStore(STORE).get(key));
      const known = savedAssets.get(key), assets = toRaw(archive.assets);
      const transaction = db.transaction([STORE, ASSETS], 'readwrite'), done = completed(transaction), assetStore = transaction.objectStore(ASSETS);
      // Resources are separate: a text edit does not copy or rewrite the media pack.
      for (const [id, bytes] of assets) if (known?.get(id)?.deref() !== bytes) assetStore.put(bytes, [key, id]);
      for (const id of previous?.assetIds || []) if (!assets.has(id)) assetStore.delete([key, id]);
      transaction.objectStore(STORE).put({ key, document: toRaw(archive.document), assetIds: [...assets.keys()], savedAt: new Date().toISOString() } satisfies StoredDraft);
      await done;
      rememberAssets(key,assets);
    } finally { db.close(); }
  });
}
export function deleteLocalStoryDraft(key: string): Promise<void> {
  return queued(key, async () => {
    const db = await openDatabase();
    try {
      const previous = await requested<StoredDraft | undefined>(db.transaction(STORE).objectStore(STORE).get(key));
      const transaction = db.transaction([STORE, ASSETS], 'readwrite'), done = completed(transaction);
      for (const id of previous?.assetIds || []) transaction.objectStore(ASSETS).delete([key, id]);
      transaction.objectStore(STORE).delete(key);
      await done; savedAssets.delete(key);
    } finally { db.close(); }
  });
}

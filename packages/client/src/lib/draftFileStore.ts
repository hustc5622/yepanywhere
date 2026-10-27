/**
 * Local files attached to a draft that has no session yet (new-session form).
 * The text draft lives in localStorage; the bytes live here so a refresh or
 * navigation does not silently turn `@[name]` tokens into missing files.
 *
 * Layout: one manifest per draft (`drafts`, ordered ids + timestamp) and one
 * record per file (`files`). Saves are incremental, so unchanged files are
 * not read again. Unavailable IndexedDB (private modes, old WebViews, tests)
 * degrades to a no-op store.
 */

export const DRAFT_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const DRAFT_FILES_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const DRAFT_FILES_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DB_NAME = "yep-draft-files";
const DB_VERSION = 1;
const DRAFTS = "drafts";
const FILES = "files";

export interface DraftFileEntry {
  id: string;
  file: File;
}

export interface DraftFileSaveResult {
  /** Files kept only in memory (over the size limits). */
  skippedNames: string[];
}

export interface DraftFileStore {
  /** False when IndexedDB is unavailable and the store does nothing. */
  readonly available: boolean;
  load(key: string): Promise<DraftFileEntry[]>;
  save(key: string, entries: DraftFileEntry[]): Promise<DraftFileSaveResult>;
  remove(key: string): Promise<void>;
}

interface DraftManifest {
  key: string;
  savedAt: number;
  ids: string[];
}

interface DraftFileRecord {
  key: string;
  draftKey: string;
  id: string;
  name: string;
  type: string;
  lastModified: number;
  bytes: ArrayBuffer;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

function fileKey(draftKey: string, id: string): string {
  return `${draftKey}\u0000${id}`;
}

async function readBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

const noopStore: DraftFileStore = {
  available: false,
  load: async () => [],
  save: async () => ({ skippedNames: [] }),
  remove: async () => {},
};

export function createDraftFileStore(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined"
    ? undefined
    : indexedDB,
  now: () => number = Date.now,
): DraftFileStore {
  if (!factory) return noopStore;
  let dbPromise: Promise<IDBDatabase> | null = null;

  const open = () => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DRAFTS))
          db.createObjectStore(DRAFTS, { keyPath: "key" });
        if (!db.objectStoreNames.contains(FILES)) {
          const files = db.createObjectStore(FILES, { keyPath: "key" });
          files.createIndex("draftKey", "draftKey");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).then(async (db) => {
      await purgeExpired(db).catch(() => {});
      return db;
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
    return dbPromise;
  };

  const deleteDraft = async (db: IDBDatabase, key: string) => {
    const tx = db.transaction([DRAFTS, FILES], "readwrite");
    tx.objectStore(DRAFTS).delete(key);
    const index = tx.objectStore(FILES).index("draftKey");
    const keys = await request(index.getAllKeys(key));
    for (const fileRecordKey of keys)
      tx.objectStore(FILES).delete(fileRecordKey);
    await done(tx);
  };

  async function purgeExpired(db: IDBDatabase) {
    const tx = db.transaction(DRAFTS, "readonly");
    const manifests = (await request(
      tx.objectStore(DRAFTS).getAll(),
    )) as DraftManifest[];
    for (const manifest of manifests) {
      if (now() - manifest.savedAt > DRAFT_FILES_TTL_MS)
        await deleteDraft(db, manifest.key);
    }
  }

  return {
    available: true,
    async load(key) {
      try {
        const db = await open();
        const tx = db.transaction([DRAFTS, FILES], "readonly");
        const manifest = (await request(tx.objectStore(DRAFTS).get(key))) as
          | DraftManifest
          | undefined;
        if (!manifest) return [];
        if (now() - manifest.savedAt > DRAFT_FILES_TTL_MS) {
          await deleteDraft(db, key);
          return [];
        }
        const records = await Promise.all(
          manifest.ids.map(
            (id) =>
              request(
                db
                  .transaction(FILES, "readonly")
                  .objectStore(FILES)
                  .get(fileKey(key, id)),
              ) as Promise<DraftFileRecord | undefined>,
          ),
        );
        return records.flatMap((record) =>
          record
            ? [
                {
                  id: record.id,
                  file: new File([record.bytes], record.name, {
                    type: record.type,
                    lastModified: record.lastModified,
                  }),
                },
              ]
            : [],
        );
      } catch {
        return [];
      }
    },

    async save(key, entries) {
      if (entries.length === 0) {
        await this.remove(key);
        return { skippedNames: [] };
      }
      try {
        const db = await open();
        const existing = (await request(
          db.transaction(DRAFTS, "readonly").objectStore(DRAFTS).get(key),
        )) as DraftManifest | undefined;
        const stored = new Set(existing?.ids ?? []);
        const keep: string[] = [];
        const skippedNames: string[] = [];
        let total = 0;
        const additions: DraftFileRecord[] = [];
        for (const { id, file } of entries) {
          if (
            file.size > DRAFT_FILE_MAX_BYTES ||
            total + file.size > DRAFT_FILES_MAX_TOTAL_BYTES
          ) {
            skippedNames.push(file.name);
            continue;
          }
          total += file.size;
          keep.push(id);
          if (!stored.has(id)) {
            additions.push({
              key: fileKey(key, id),
              draftKey: key,
              id,
              name: file.name,
              type: file.type,
              lastModified: file.lastModified,
              bytes: await readBytes(file),
            });
          }
        }
        const tx = db.transaction([DRAFTS, FILES], "readwrite");
        const files = tx.objectStore(FILES);
        for (const record of additions) files.put(record);
        for (const id of stored) {
          if (!keep.includes(id)) files.delete(fileKey(key, id));
        }
        tx.objectStore(DRAFTS).put({
          key,
          savedAt: now(),
          ids: keep,
        } satisfies DraftManifest);
        await done(tx);
        return { skippedNames };
      } catch {
        return { skippedNames: entries.map((entry) => entry.file.name) };
      }
    },

    async remove(key) {
      try {
        await deleteDraft(await open(), key);
      } catch {
        /* Nothing to clean up when storage is unavailable. */
      }
    },
  };
}

export const draftFileStore = createDraftFileStore();

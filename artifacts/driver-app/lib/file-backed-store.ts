export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
export interface FileStore {
  write(value: string): Promise<string>;
  read(reference: string): Promise<string>;
  remove(reference: string): Promise<void>;
}
const POINTER = "@traivo-file:";

/** Keep large media out of Android SQLite rows; commit a small pointer last. */
export function fileBackedStore(metadata: KeyValueStore, files: FileStore, threshold = 512_000): KeyValueStore {
  const operations = new Map<string, Promise<unknown>>();
  function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (operations.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    operations.set(key, run);
    void run.finally(() => { if (operations.get(key) === run) operations.delete(key); }).catch(() => {});
    return run;
  }
  const reference = (value: string | null) => value?.startsWith(POINTER) ? value.slice(POINTER.length) : null;
  return {
    getItem: key => serialized(key, async () => {
      const value = await metadata.getItem(key);
      const ref = reference(value);
      return ref ? files.read(ref) : value;
    }),
    setItem: (key, value) => serialized(key, async () => {
      const old = reference(await metadata.getItem(key));
      let created: string | null = null;
      try {
        if (value.length > threshold) created = await files.write(value);
        await metadata.setItem(key, created ? POINTER + created : value);
      } catch (err) {
        if (created) {
          // A lost acknowledgement must not delete a possibly committed body.
          const committed = await metadata.getItem(key).catch(() => undefined);
          if (committed !== undefined && committed !== POINTER + created) {
            await files.remove(created).catch(() => {});
          }
        }
        throw err;
      }
      if (old) await files.remove(old).catch(() => {});
    }),
    removeItem: key => serialized(key, async () => {
      const old = reference(await metadata.getItem(key));
      await metadata.removeItem(key);
      if (old) await files.remove(old).catch(() => {});
    }),
  };
}

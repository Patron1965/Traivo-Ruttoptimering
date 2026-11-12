import AsyncStorage from "@react-native-async-storage/async-storage";

let opening: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("OFFLINE_STORAGE_UNAVAILABLE")); return; }
      const request = indexedDB.open("traivo-driver-private", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); opening = null; };
        resolve(request.result);
      };
      request.onerror = () => { opening = null; reject(request.error); };
      request.onblocked = () => { opening = null; reject(new Error("OFFLINE_STORAGE_BLOCKED")); };
    });
  }
  return opening;
}
async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", mode);
    const request = operation(tx.objectStore("kv"));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? request.error);
    tx.onabort = () => reject(tx.error ?? new Error("OFFLINE_STORAGE_WRITE_FAILED"));
  });
}
const storage = {
  async getItem(key: string): Promise<string | null> {
    const value = await transact<string | undefined>("readonly", (store) => store.get(key));
    if (value !== undefined) return value;
    // Upgrade existing web queues, preserving old bytes until a committed write.
    const legacy = await AsyncStorage.getItem(key);
    if (legacy !== null) {
      await storage.setItem(key, legacy);
      await AsyncStorage.removeItem(key);
    }
    return legacy;
  },
  async setItem(key: string, value: string): Promise<void> {
    await transact("readwrite", (store) => store.put(value, key));
  },
  async removeItem(key: string): Promise<void> {
    // Remove legacy first: a crash may retain current bytes, never revive old ones.
    await AsyncStorage.removeItem(key);
    await transact("readwrite", (store) => store.delete(key));
  },
};
export default storage;

import test from "node:test";
import assert from "node:assert/strict";
import { fileBackedStore, type KeyValueStore, type FileStore } from "./file-backed-store.ts";

function fixture() {
  const values = new Map<string, string>();
  const bodies = new Map<string, string>();
  let sequence = 0;
  const metadata: KeyValueStore = {
    getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async key => { values.delete(key); },
  };
  const files: FileStore = {
    write: async value => { const id = String(++sequence); bodies.set(id, value); return id; },
    read: async id => { if (!bodies.has(id)) throw new Error("Missing evidence"); return bodies.get(id)!; },
    remove: async id => { bodies.delete(id); },
  };
  return { values, bodies, metadata, files };
}
test("large report media survives reconstruction with only a small SQLite pointer", async () => {
  const fixtureData = fixture();
  const content = "large-image".repeat(1000);
  const storage = fileBackedStore(fixtureData.metadata, fixtureData.files, 100);
  await storage.setItem("owner-a:report", content);
  assert.ok(fixtureData.values.get("owner-a:report")!.length < 100);
  assert.equal(await fileBackedStore(fixtureData.metadata, fixtureData.files, 100).getItem("owner-a:report"), content);
  assert.equal(await storage.getItem("owner-b:report"), null);
});
test("metadata failure retains old bytes and removes only the uncommitted new file", async () => {
  const data = fixture();
  const old = "old".repeat(100);
  await fileBackedStore(data.metadata, data.files, 10).setItem("report", old);
  const failing = fileBackedStore({ ...data.metadata, setItem: async () => { throw new Error("quota"); } }, data.files, 10);
  await assert.rejects(failing.setItem("report", "new".repeat(100)), /quota/);
  assert.equal(await failing.getItem("report"), old);
  assert.equal(data.bodies.size, 1);
});
test("file write failure never commits a new pointer", async () => {
  const data = fixture();
  const storage = fileBackedStore(data.metadata, { ...data.files, write: async () => { throw new Error("disk full"); } }, 10);
  await assert.rejects(storage.setItem("report", "photo".repeat(100)), /disk full/);
  assert.equal(await storage.getItem("report"), null);
});
test("replacement and deletion reclaim old acknowledged files", async () => {
  const data = fixture();
  const storage = fileBackedStore(data.metadata, data.files, 10);
  await storage.setItem("report", "photo".repeat(100));
  await storage.setItem("report", "small");
  assert.equal(await storage.getItem("report"), "small");
  assert.equal(data.bodies.size, 0);
  await storage.removeItem("report");
  assert.equal(await storage.getItem("report"), null);
});
test("lost metadata acknowledgement never removes a committed media body", async () => {
  const data = fixture();
  const metadata = { ...data.metadata, setItem: async (key: string, value: string) => {
    await data.metadata.setItem(key, value);
    throw new Error("lost acknowledgement");
  } };
  const storage = fileBackedStore(metadata, data.files, 10);
  const content = "photo".repeat(100);
  await assert.rejects(storage.setItem("report", content));
  assert.equal(await storage.getItem("report"), content);
});

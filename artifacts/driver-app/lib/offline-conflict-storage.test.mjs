import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function harness(store = new Map()) {
  const modules = new Map();
  let failWrite = false;
  const storage = {
    getItem: async key => store.get(key) ?? null,
    setItem: async (key, value) => { if (failWrite) throw new Error("quota"); store.set(key, value); },
    removeItem: async key => { store.delete(key); },
  };
  function load(name) {
    if (name === "./durable-storage") return { __esModule: true, default: storage };
    if (name === "./api") return {};
    if (modules.has(name)) return modules.get(name).exports;
    const module = { exports: {} };
    modules.set(name, module);
    const source = fs.readFileSync(new URL(`${name}.ts`, import.meta.url), "utf8");
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInThisContext(`(function(require,module,exports){${output}\n})`)(load, module, module.exports);
    return module.exports;
  }
  const queue = load("./offline-queue");
  const owner = { userId: "test-user", organizationId: "test-org" };
  queue.setOfflineQueueScope(owner);
  return { queue, owner, store, failWrites: value => { failWrite = value; } };
}
const report = (id, stopId = "stop-one") => ({
  id, stopId, routeId: "route-one", planVersion: 7, occurredAt: "2026-11-05T10:00:00Z",
  outcome: "completed", stage: "delivery", comment: "original",
  proofs: [{ type: "photo", data: "retained-original" }],
});
async function seed(h) {
  await h.queue.enqueueStopReport(report("conflict"));
  await h.queue.markQueueItemStatus("stopReport", "conflict", "conflict", "conflict");
  await h.queue.enqueueStopReport(report("dependent"));
  await h.queue.enqueueStopReport(report("other", "stop-two"));
  return (await h.queue.getOfflineQueueItems()).filter(item => item.stopId === "stop-one");
}

test("archive is durable, preserves evidence and unblocks only explicitly selected stop", async () => {
  const h = harness();
  const selection = await seed(h);
  await h.queue.archiveStopConflicts(selection, h.owner);
  assert.deepEqual((await h.queue.getOrderedExecutionQueue()).map(item => item.id), ["other"]);
  let archive = await h.queue.getConflictArchive();
  assert.equal(archive.length, 2);
  assert.equal(archive[0].item.proofs[0].data, "retained-original");
  assert.equal(archive[0].item.planVersion, 7);
  assert.equal(archive[0].item.syncStatus, "conflict");
  // A later queue write must not destroy the retained originals.
  await h.queue.enqueueStopReport(report("later", "stop-three"));
  const reopened = harness(h.store);
  assert.equal((await reopened.queue.getConflictArchive()).length, 2);
  assert.deepEqual((await reopened.queue.getOrderedExecutionQueue()).map(item => item.id), ["later", "other"]);
  reopened.queue.setOfflineQueueScope({ userId: "another", organizationId: "test-org" });
  assert.equal((await reopened.queue.getConflictArchive()).length, 0);
});

test("whole-queue archive retains all original evidence and allows a fresh report", async () => {
  const h = harness();
  await seed(h);
  const selected = await h.queue.getOfflineQueueItems();
  await h.queue.archivePendingQueue(selected, h.owner);
  assert.equal((await h.queue.getOrderedExecutionQueue()).length, 0);
  assert.equal((await h.queue.getConflictArchive()).length, 3);
  await h.queue.enqueueStopReport(report("fresh", "fresh-stop"));
  assert.deepEqual((await h.queue.getOrderedExecutionQueue()).map(item => item.id), ["fresh"]);
  assert.equal((await harness(h.store).queue.getConflictArchive())[0].item.proofs[0].data, "retained-original");
});

test("whole-queue archive rejects changed selection, wrong owner, active sync and failed storage", async () => {
  const h = harness();
  await seed(h);
  const selected = await h.queue.getOfflineQueueItems();
  await assert.rejects(h.queue.archivePendingQueue(selected.slice(1), h.owner));
  await assert.rejects(h.queue.archivePendingQueue(selected, { ...h.owner, userId: "wrong" }));
  const release = await h.queue.acquireOfflineSyncLease();
  await assert.rejects(h.queue.archivePendingQueue(selected, h.owner));
  release();
  h.failWrites(true);
  await assert.rejects(h.queue.archivePendingQueue(selected, h.owner));
  h.failWrites(false);
  assert.equal((await h.queue.getOfflineQueueItems()).length, 3);
  assert.equal((await h.queue.getConflictArchive()).length, 0);
  await h.queue.enqueueStopReport(report("new", "other-stop"));
  await assert.rejects(h.queue.archivePendingQueue(selected, h.owner));
});

test("quota failure, stale selection, wrong owner and active sync all fail without dropping work", async () => {
  const h = harness();
  const selection = await seed(h);
  h.failWrites(true);
  await assert.rejects(h.queue.archiveStopConflicts(selection, h.owner));
  h.failWrites(false);
  assert.equal((await h.queue.getOfflineQueueItems()).length, 3);
  assert.equal((await h.queue.getConflictArchive()).length, 0);
  await assert.rejects(h.queue.archiveStopConflicts(selection.slice(0, 1), h.owner));
  await assert.rejects(h.queue.archiveStopConflicts(selection, { ...h.owner, userId: "wrong" }));
  const release = await h.queue.acquireOfflineSyncLease();
  await assert.rejects(h.queue.archiveStopConflicts(selection, h.owner));
  release();
  assert.equal((await h.queue.getOfflineQueueItems()).length, 3);
});

test("retry keeps original identity, version, timestamp, evidence and outcome", async () => {
  const h = harness();
  const selection = await seed(h);
  const original = selection.find(item => item.id === "conflict");
  await h.queue.retryQueueConflict(original, h.owner);
  const retried = (await h.queue.getOfflineQueueItems()).find(item => item.id === original.id);
  assert.equal(retried.syncStatus, "pending");
  for (const key of ["id", "stopId", "routeId", "planVersion", "occurredAt", "outcome", "proofs", "comment"]) {
    assert.deepEqual(retried[key], original[key]);
  }
  await assert.rejects(h.queue.retryQueueConflict(original, h.owner));
});

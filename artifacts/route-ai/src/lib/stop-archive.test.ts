import assert from "node:assert/strict";
import test from "node:test";
import {
  assertArchiveSnapshotUnchanged,
  compareArchiveSnapshot,
  createArchiveSnapshot,
  isArchivedStop,
} from "./stop-archive.ts";

test("creates a stable deduplicated archive snapshot", () => {
  const source = ["stop-a", "stop-b", "stop-a"];
  const snapshot = createArchiveSnapshot(source);
  source.push("stop-c");

  assert.deepEqual(snapshot, ["stop-a", "stop-b"]);
});

test("detects additions and removals instead of changing the confirmed IDs", () => {
  assert.deepEqual(
    compareArchiveSnapshot(["stop-a", "stop-b"], ["stop-b", "stop-c"]),
    { missingIds: ["stop-a"], unexpectedIds: ["stop-c"] },
  );
});

test("throws when the authoritative refresh does not match the snapshot", () => {
  assert.throws(
    () => assertArchiveSnapshotUnchanged(["stop-a"], []),
    (error: unknown) =>
      error instanceof Error
      && error.name === "ArchiveSnapshotChangedError"
      && (error as Error & { mismatch: { missingIds: string[] } }).mismatch.missingIds[0] === "stop-a",
  );
});

test("treats archivedAt as the authoritative archived marker", () => {
  assert.equal(isArchivedStop({ archivedAt: null }), false);
  assert.equal(isArchivedStop({ archivedAt: "2026-01-01T00:00:00.000Z" }), true);
});
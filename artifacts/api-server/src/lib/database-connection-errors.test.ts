import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { installDatabaseConnectionErrorHandlers } from "./database-connection-errors";

test("pool and checked-out client errors are observed without crashing or leaking error contents", () => {
  const pool = new EventEmitter();
  const client = new EventEmitter();
  const reports: unknown[][] = [];
  installDatabaseConnectionErrorHandlers(pool, (...args) => reports.push(args));
  pool.emit("connect", client);
  assert.doesNotThrow(() => client.emit("error", new Error("Private connection details")));
  assert.doesNotThrow(() => pool.emit("error", new Error("Private pool details")));
  assert.deepEqual(reports, [[], []]);
});

test("one idle connection failure is reported once even when pg forwards it to the pool", () => {
  const pool = new EventEmitter();
  const client = new EventEmitter();
  let reports = 0;
  installDatabaseConnectionErrorHandlers(pool, () => reports++);
  pool.emit("connect", client);
  const failure = new Error("Connection terminated unexpectedly");
  client.emit("error", failure);
  pool.emit("error", failure, client);
  assert.equal(reports, 1);
  pool.emit("error", new Error("Another connection failed"));
  assert.equal(reports, 2);
});

test("installing twice keeps one listener and does not replace query error handling", () => {
  const pool = new EventEmitter();
  const client = new EventEmitter();
  let reports = 0;
  let queryErrors = 0;
  client.on("error", () => queryErrors++);
  installDatabaseConnectionErrorHandlers(pool, () => reports++);
  installDatabaseConnectionErrorHandlers(pool, () => { throw new Error("Duplicate installation"); });
  pool.emit("connect", client);
  client.emit("error", new Error("Failed query still has its own handling"));
  assert.equal(reports, 1);
  assert.equal(queryErrors, 1);
  assert.equal(pool.listenerCount("error"), 1);
});

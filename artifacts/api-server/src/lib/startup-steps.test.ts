import test from "node:test";
import assert from "node:assert/strict";
import { runStartupSteps } from "./startup-steps";

test("startup executes required checks in order", async () => {
  const completed: string[] = [];
  await runStartupSteps(["database", "schema", "bootstrap"].map(name => ({
    name,
    run: async () => { completed.push(name); },
  })));
  assert.deepEqual(completed, ["database", "schema", "bootstrap"]);
});

test("failed check does not run later initialization", async () => {
  let continued = false;
  await assert.rejects(runStartupSteps([
    { name: "schema", run: async () => { throw new Error("missing guard"); } },
    { name: "bootstrap", run: async () => { continued = true; } },
  ]), /missing guard/);
  assert.equal(continued, false);
});

test("hung startup names the blocked stage and cannot continue after timeout", async () => {
  let release!: () => void;
  let continued = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await assert.rejects(runStartupSteps([
    { name: "database connection", run: () => pending },
    { name: "schema", run: async () => { continued = true; } },
  ], 10), /Timed out.*database connection/);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(continued, false);
});
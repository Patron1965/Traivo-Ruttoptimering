import assert from "node:assert/strict";
import test from "node:test";
import { errorMessages } from "./error-localizer.ts";

function leafKeys(value, prefix = "") {
  return Object.entries(value).flatMap(([key, child]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object" ? leafKeys(child, next) : [next];
  });
}

test("error catalog has matching Swedish and English keys", () => {
  assert.deepEqual(leafKeys(errorMessages.sv).sort(), leafKeys(errorMessages.en).sort());
});
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getStopStatusTranslationKey } from "./stop-status";

describe("getStopStatusTranslationKey", () => {
  it("maps the supported stop statuses to translation keys", () => {
    assert.equal(getStopStatusTranslationKey("pending"), "pending");
    assert.equal(getStopStatusTranslationKey("in_progress"), "inProgress");
    assert.equal(getStopStatusTranslationKey("completed"), "completed");
    assert.equal(getStopStatusTranslationKey("failed"), "failed");
    assert.equal(getStopStatusTranslationKey("skipped"), "skipped");
    assert.equal(getStopStatusTranslationKey("delivered"), "delivered");
  });

  it("normalizes the cancelled status aliases", () => {
    assert.equal(getStopStatusTranslationKey("cancelled"), "cancelled");
    assert.equal(getStopStatusTranslationKey("canceled"), "cancelled");
  });

  it("uses the unknown fallback for unexpected values", () => {
    assert.equal(getStopStatusTranslationKey("awaiting_review"), "unknown");
    assert.equal(getStopStatusTranslationKey(""), "unknown");
    assert.equal(getStopStatusTranslationKey(null), "unknown");
  });
});
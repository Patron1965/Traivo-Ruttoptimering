import test from "node:test";
import assert from "node:assert/strict";
import { formatPortalDate, formatPortalDateTime, formatPortalTime, formatWindow, isPortalAuthStatus, passwordProblem, portalStatus, portalDeliveryStage, telHref, tokenFromFragment, trackingText } from "./portal-format.ts";

test("delivery overview highlights only known current stages and formats recorded completion", () => {
  assert.equal(portalDeliveryStage("scheduled"), 0);
  assert.equal(portalDeliveryStage("started"), 0);
  assert.equal(portalDeliveryStage("on_the_way"), 1);
  assert.equal(portalDeliveryStage("completed"), 2);
  for (const status of ["failed", "skipped", "cancelled", "paused", "unavailable", "unknown"]) {
    assert.equal(portalDeliveryStage(status), null);
  }
  assert.equal(formatPortalDateTime(null), null);
  assert.equal(formatPortalDateTime("invalid"), null);
  assert.match(formatPortalDateTime("2026-11-04T11:25:00Z")!, /12:25/);
});

test("all portal statuses are Swedish", () => {
  for (const s of ["scheduled", "started", "on_the_way", "completed", "failed", "skipped", "cancelled", "paused", "unavailable"]) {
    assert.ok(portalStatus(s).label.length > 0);
  }
  assert.equal(portalStatus("on_the_way").label, "På väg");
  assert.equal(portalStatus("bogus").label, "Status saknas");
});

test("times use Europe/Stockholm", () => {
  assert.equal(formatPortalTime("2025-01-15T07:30:00Z"), "08:30");
  assert.equal(formatPortalTime("2025-07-15T07:30:00Z"), "09:30");
  assert.equal(formatPortalTime("13:05"), "13:05");
  assert.equal(formatPortalTime(null), null);
  assert.equal(formatWindow("08:00", "10:00"), "08:00–10:00");
  assert.equal(formatWindow(null, null), null);
  assert.match(formatPortalDate("2025-03-04") ?? "", /4 mars/);
});

test("fragment token parsing", () => {
  const t = "a".repeat(40);
  assert.equal(tokenFromFragment(`#token=${t}`), t);
  assert.equal(tokenFromFragment("#token=short"), null);
  assert.equal(tokenFromFragment(""), null);
});

test("tel links and auth statuses", () => {
  assert.equal(telHref("+46 70-123 45 67"), "tel:+46701234567");
  assert.equal(telHref("12"), null);
  assert.ok(isPortalAuthStatus(401) && isPortalAuthStatus(403) && !isPortalAuthStatus(500));
  assert.equal(passwordProblem("kort", "kort"), "Lösenordet behöver minst 12 tecken.");
  assert.equal(passwordProblem("abcdefghijkl", "abcdefghijkl"), null);
  assert.ok(trackingText("live").length > 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STOP_LIFECYCLE_LOCKED_CODE,
  formatLockedStopError,
  isLockedStopError,
} from "./locked-stop-error.ts";

const lockedResponse = {
  error: "Completed, active, failed, and skipped stops are locked and must keep their route position",
  conflicts: [],
  code: STOP_LIFECYCLE_LOCKED_CODE,
  details: {
    stopId: "locked-stop-id",
    routeId: "route-id",
    sequenceOrder: 4,
    status: "in_progress",
    address: "Sankt Eriksgatan 10",
  },
};

test("formats a locked-stop move explanation in English", () => {
  const message = formatLockedStopError(lockedResponse, "en");

  assert.ok(message);
  assert.match(message, /Sankt Eriksgatan 10/);
  assert.match(message, /position 4/);
  assert.match(message, /in progress/);
  assert.match(message, /change this stop's route or position/);
  assert.match(message, /Only pending stops can be moved without shifting locked stops/);
  assert.doesNotMatch(message, /locked-stop-id/);
});

test("formats a locked-stop move explanation in Swedish", () => {
  const message = formatLockedStopError(lockedResponse, "sv-SE");

  assert.ok(message);
  assert.match(message, /Sankt Eriksgatan 10/);
  assert.match(message, /position 4/);
  assert.match(message, /pågår/);
  assert.match(message, /ändra det här stoppets rutt eller position/);
  assert.match(message, /Endast väntande stopp kan flyttas utan att förskjuta låsta stopp/);
});

test("formats a selected unplanned locked stop without exposing its UUID", () => {
  const message = formatLockedStopError({
    ...lockedResponse,
    details: {
      ...lockedResponse.details,
      routeId: null,
      sequenceOrder: null,
      status: "active",
      address: "Klarabergsviadukten 1",
    },
  }, "sv");

  assert.ok(message);
  assert.match(message, /Klarabergsviadukten 1/);
  assert.match(message, /utan positionsnummer/);
  assert.match(message, /pågår/);
  assert.doesNotMatch(message, /locked-stop-id/);
});

test("localizes recognized aliases and hides unknown raw statuses", () => {
  const aliasMessage = formatLockedStopError({
    ...lockedResponse,
    details: { ...lockedResponse.details, status: "in-progress" },
  }, "en");
  assert.ok(aliasMessage);
  assert.match(aliasMessage, /in progress/);

  const unknownMessage = formatLockedStopError({
    ...lockedResponse,
    details: { ...lockedResponse.details, status: "future_lifecycle_state" },
  }, "sv");
  assert.ok(unknownMessage);
  assert.match(unknownMessage, /okänd status/);
  assert.doesNotMatch(unknownMessage, /future_lifecycle_state/);
});

test("only formats responses with the locked-stop code and safe details", () => {
  assert.equal(
    isLockedStopError({
      ...lockedResponse,
      details: { ...lockedResponse.details, notes: "must never be shown" },
    }),
    true,
  );
  assert.equal(formatLockedStopError({ error: lockedResponse.error }, "sv"), null);
  assert.equal(
    formatLockedStopError({
      ...lockedResponse,
      details: { ...lockedResponse.details, sequenceOrder: "4" },
    }, "en"),
    null,
  );
});
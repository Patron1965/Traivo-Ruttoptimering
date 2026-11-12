import assert from "node:assert/strict";
import test from "node:test";
import {
  errorCategory,
  localizeError,
  parsePersistedGpsError,
  toPersistedGpsError,
} from "./error-localizer.ts";

test("persisted GPS errors replay as language-neutral descriptors", () => {
  const persisted = JSON.stringify({ code: "gpsPermission", status: 403 });
  const replayed = parsePersistedGpsError(persisted);

  assert.deepEqual(replayed, { code: "gpsPermission", status: 403 });
  assert.match(localizeError(replayed, "sv"), /Platsbehörighet/);
  assert.match(localizeError(replayed, "en"), /Location permission/);
});

test("live GPS events preserve typed API guidance until the UI localizes them", () => {
  const typedApiError = Object.assign(new Error("backend body is not user-facing"), {
    status: 403,
    requestId: "gps-42",
  });
  const liveEvent = {
    type: "error",
    error: toPersistedGpsError(typedApiError),
  };

  assert.equal(liveEvent.error.code, "forbidden");
  assert.match(localizeError(liveEvent.error, "sv"), /behörighet/);
  assert.match(localizeError(liveEvent.error, "en"), /not allowed/);
  assert.doesNotMatch(localizeError(liveEvent.error, "sv"), /backend body/);
});

test("typed API statuses survive descriptor conversion", () => {
  const descriptor = toPersistedGpsError({ status: 401 });
  assert.equal(descriptor.code, "unauthorized");
  assert.equal(errorCategory(descriptor), "unauthorized");
  assert.match(localizeError(descriptor, "sv"), /Logga in igen/);
});

test("legacy translated GPS strings keep known permission and session guidance", () => {
  const permission = parsePersistedGpsError("Platsbehörighet krävs för att starta ruttspårning.");
  const session = parsePersistedGpsError("GPS session is not authenticated");
  const translatedUnauthorized = parsePersistedGpsError("Din inloggning har gått ut. Logga in igen.");

  assert.equal(errorCategory(permission), "gpsPermission");
  assert.equal(errorCategory(session), "unauthorized");
  assert.equal(errorCategory(translatedUnauthorized), "unauthorized");
  assert.match(localizeError(permission, "en"), /Location permission/);
  assert.match(localizeError(session, "sv"), /Logga in igen/);
});

test("unknown legacy GPS strings never leak raw internals", () => {
  const legacy = parsePersistedGpsError("private backend response");
  assert.equal(localizeError(legacy, "sv"), "Något gick fel. Försök igen.");
  assert.doesNotMatch(localizeError(legacy, "sv"), /private backend/);
});
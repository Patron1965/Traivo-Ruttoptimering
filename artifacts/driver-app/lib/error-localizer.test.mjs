import assert from "node:assert/strict";
import test from "node:test";
import {
  errorCategory,
  localizeError,
  setCurrentLanguage,
} from "./error-localizer.ts";

test("localizes structured HTTP errors without exposing backend response text", () => {
  const error = Object.assign(new Error("ignored backend details"), {
    status: 409,
    body: '{"error":"STALE_PLAN","internal":"do not show this"}',
    code: "STALE_PLAN",
  });

  assert.equal(errorCategory(error), "conflict");
  assert.match(localizeError(error, "sv"), /uppgifterna har ändrats/);
  assert.doesNotMatch(localizeError(error, "sv"), /STALE_PLAN|internal|backend/);
});

test("uses network and status fallbacks in the selected language", () => {
  assert.equal(errorCategory({ status: 0, code: "NETWORK_ERROR" }), "network");
  assert.match(localizeError({ status: 0, code: "NETWORK_ERROR" }, "sv"), /Ingen anslutning/);
  assert.match(localizeError({ status: 503 }, "en"), /service could not complete/);
});

test("rejected login and locked account are not presented as expired sessions", () => {
  assert.equal(errorCategory({ status: 401, code: "INVALID_CREDENTIALS" }), "invalidCredentials");
  assert.match(localizeError({ status: 401, code: "INVALID_CREDENTIALS" }, "sv"), /Felaktig e-post eller lösenord/);
  assert.match(localizeError({ status: 401, code: "INVALID_CREDENTIALS" }, "en"), /Incorrect email or password/);
  assert.match(localizeError({ status: 423, code: "ACCOUNT_LOCKED" }, "sv"), /tillfälligt låst/);
  assert.match(localizeError({ status: 423, code: "ACCOUNT_LOCKED" }, "en"), /temporarily locked/);
  assert.equal(errorCategory({ status: 401 }), "unauthorized");
});

test("supports a translated screen-specific fallback for unknown errors", () => {
  assert.equal(
    localizeError(new Error("private implementation detail"), "sv", {
      fallback: "Kunde inte spara bevis.",
    }),
    "Kunde inte spara bevis.",
  );
  assert.doesNotMatch(
    localizeError(new Error("private implementation detail"), "en"),
    /private implementation detail/,
  );
});

test("the module language follows language changes for background callers", () => {
  setCurrentLanguage("sv");
  assert.match(localizeError({ code: "GPS_UNAVAILABLE" }), /GPS-position/);
  setCurrentLanguage("en");
  assert.match(localizeError({ code: "GPS_UNAVAILABLE" }), /No GPS position/);
  setCurrentLanguage("sv");
});
import assert from "node:assert/strict";
import test from "node:test";
import {
  getErrorStatus,
  isStopMessageAwaitingDispatch,
  localizeError,
  TrustedLocalizedError,
  type ErrorTranslator,
} from "./localize-error.ts";

const catalog: Record<string, Record<string, string>> = {
  en: {
    "stopMessages.awaitingDispatch": "Send the route to the driver to start messaging.",
    "common.errorUnknown": "Something went wrong. Try again.",
    "common.errorNetwork": "Network connection failed. Check your connection and try again.",
    "common.errorUnauthorized": "Your session has expired. Sign in again to continue.",
    "common.errorForbidden": "You do not have permission to do that.",
    "common.errorNotFound": "The requested item could not be found.",
    "common.errorBadRequest": "The request could not be completed. Check the information and try again.",
    "common.errorConflict": "The request conflicts with a newer change. Refresh and try again.",
    "common.errorTimeout": "The request took too long. Check your connection and try again.",
    "common.errorServer": "The service is temporarily unavailable. Try again later.",
    "common.errorReasons.capacity": "The vehicle capacity would be exceeded.",
    "common.errorReasons.workingHours": "The driver's working hours may be exceeded.",
    "common.errorReasons.missingDriver": "No active driver is assigned.",
    "common.errorReasons.invalidCoordinates": "One or more stops have invalid coordinates.",
    "common.errorReasons.lockedFirstStopConflict": "The locked first stop must remain first. Keep it as the first stop or remove the lock before optimizing or moving stops.",
    "planner.alternativesFailed": "Could not generate alternative plans. Try again.",
    "import.parseFailed": "Could not read the file. Check the format.",
    "import.importFailed": "Import failed. Please try again.",
    "common.errorRequestFailed": "The request could not be completed. Try again.",
    "auth.signInFailed": "Sign-in failed",
    "orders.loadFailed": "Orders could not be loaded.",
  },
  sv: {
    "stopMessages.awaitingDispatch": "Skicka rutten till chauffören för att kunna skriva meddelanden.",
    "common.errorUnknown": "Något gick fel. Försök igen.",
    "common.errorNetwork": "Nätverksanslutningen misslyckades. Kontrollera anslutningen och försök igen.",
    "common.errorUnauthorized": "Din session har gått ut. Logga in igen för att fortsätta.",
    "common.errorForbidden": "Du saknar behörighet att göra detta.",
    "common.errorNotFound": "Det begärda objektet kunde inte hittas.",
    "common.errorBadRequest": "Begäran kunde inte slutföras. Kontrollera uppgifterna och försök igen.",
    "common.errorConflict": "Begäran krockar med en nyare ändring. Uppdatera och försök igen.",
    "common.errorTimeout": "Begäran tog för lång tid. Kontrollera anslutningen och försök igen.",
    "common.errorServer": "Tjänsten är tillfälligt otillgänglig. Försök igen senare.",
    "common.errorReasons.capacity": "Fordonets kapacitet skulle överskridas.",
    "common.errorReasons.workingHours": "Förarens arbetstid riskerar att överskridas.",
    "common.errorReasons.missingDriver": "Ingen aktiv chaufför är tilldelad.",
    "common.errorReasons.invalidCoordinates": "Ett eller flera stopp har ogiltiga koordinater.",
    "common.errorReasons.lockedFirstStopConflict": "Det låsta första stoppet måste behållas först. Behåll det som första stopp eller ta bort låsningen innan du optimerar eller flyttar stopp.",
    "planner.alternativesFailed": "Kunde inte skapa alternativa planer. Försök igen.",
    "import.parseFailed": "Kunde inte läsa filen. Kontrollera formatet.",
    "import.importFailed": "Importen misslyckades. Försök igen.",
    "common.errorRequestFailed": "Begäran kunde inte slutföras. Försök igen.",
    "auth.signInFailed": "Inloggningen misslyckades",
    "orders.loadFailed": "Ordrarna kunde inte laddas.",
  },
};

test("approval input conflicts explain reoptimization rather than a generic version conflict", () => {
  const keyTranslator: ErrorTranslator = (key) => key;
  assert.equal(localizeError({ status: 409, data: { code: "STALE_RESOURCE_SNAPSHOT" } }, keyTranslator),
    "dispatch.approvalInputsChanged");
  assert.equal(localizeError({ status: 409, data: { code: "STALE_PLAN_REVISION" } }, keyTranslator),
    "dispatch.approvalRevisionChanged");
});

test("stop deletion policy errors take precedence over generic HTTP 409 conflicts", () => {
  const reasonKey: ErrorTranslator = (key) => key;
  assert.equal(
    localizeError({ status: 409, data: { error: "Only pending stops can be deleted. No stops were deleted." } }, reasonKey),
    "common.errorReasons.stopDeleteStatus",
  );
  assert.equal(
    localizeError({ status: 409, data: { error: "Deletion would reorder active or terminal stops. No stops were deleted." } }, reasonKey),
    "common.errorReasons.stopDeleteSequence",
  );
  assert.equal(
    localizeError({ status: 409, data: { error: "One or more stops changed while deletion was being prepared. Reload and try again." } }, reasonKey),
    "common.errorConflict",
  );
});

test("an oversized draft body gives actionable import feedback instead of a generic error", () => {
  assert.equal(
    localizeError({ status: 413, code: "DRAFT_BODY_TOO_LARGE" }, (key) => key),
    "import.requestTooLarge",
  );
});

test("driver save errors identify the failing address or assignment", () => {
  const reasonKey: ErrorTranslator = (key) => key;
  for (const [error, key, status] of [
    ["Chaufförens startplats kunde inte verifieras", "drivers.startAddressNotVerified", 400],
    ["Chaufförens slutplats kunde inte verifieras", "drivers.endAddressNotVerified", 400],
    ["Vehicle is already assigned to driver Example", "drivers.vehicleAlreadyAssigned", 409],
  ] as const) {
    assert.equal(localizeError({ status, data: { error } }, reasonKey), key);
  }
});

let language: "en" | "sv" = "sv";
const t: ErrorTranslator = (key, options) => (
  catalog[language][key] ?? String(options?.defaultValue ?? key)
);

test("switches the same network error with the selected language", () => {
  language = "sv";
  assert.equal(
    localizeError(new TypeError("Failed to fetch"), t),
    "Nätverksanslutningen misslyckades. Kontrollera anslutningen och försök igen.",
  );
  language = "en";
  assert.equal(
    localizeError(new TypeError("Failed to fetch"), t),
    "Network connection failed. Check your connection and try again.",
  );
});

test("localizes authentication and HTTP errors without exposing response internals", () => {
  language = "sv";
  const error = Object.assign(new Error("Internal database host: db-01"), {
    status: 401,
    data: { error: "Internal database host: db-01" },
  });
  assert.equal(localizeError(error, t), "Din session har gått ut. Logga in igen för att fortsätta.");
  assert.equal(getErrorStatus(error), 401);
});

test("keeps known business reasons actionable", () => {
  language = "sv";
  assert.equal(
    localizeError({ status: 409, data: { code: "capacity_exceeded" } }, t),
    "Fordonets kapacitet skulle överskridas.",
  );
  language = "en";
  assert.equal(
    localizeError({ data: { error: "The driver's working hours may be exceeded" } }, t),
    "The driver's working hours may be exceeded.",
  );
});

test("localizes the stable dispatch revision conflict code", () => {
  language = "sv";
  assert.equal(
    localizeError(
      { status: 409, data: { code: "DISPATCH_REVISION_CONFLICT" } },
      t,
    ),
    "Begäran krockar med en nyare ändring. Uppdatera och försök igen.",
  );
});

test("localizes locked first-stop conflicts with preserve-first or unlock guidance", () => {
  language = "sv";
  assert.equal(
    localizeError(
      { status: 409, data: { code: "LOCKED_FIRST_STOP_CONFLICT" } },
      t,
    ),
    "Det låsta första stoppet måste behållas först. Behåll det som första stopp eller ta bort låsningen innan du optimerar eller flyttar stopp.",
  );
  language = "en";
  assert.equal(
    localizeError(
      { status: 409, data: { code: "LOCKED_FIRST_STOP_CONFLICT" } },
      t,
    ),
    "The locked first stop must remain first. Keep it as the first stop or remove the lock before optimizing or moving stops.",
  );
});

test("localizes dispatch safety rejection codes without server prose", () => {
  language = "sv";
  assert.equal(
    localizeError(
      { status: 409, data: { code: "DISPATCH_DRIVER_UNRESOLVED" } },
      t,
    ),
    "Ingen aktiv chaufför är tilldelad.",
  );
  assert.equal(
    localizeError(
      { status: 409, data: { code: "DISPATCH_PICKUP_COORDINATES_REQUIRED" } },
      t,
    ),
    "Ett eller flera stopp har ogiltiga koordinater.",
  );
});

test("localizes route preflight reason codes without exposing server prose", () => {
  language = "sv";
  assert.equal(
    localizeError({ code: "missing_driver", message: "Aktiv chaufför saknas." }, t),
    "Ingen aktiv chaufför är tilldelad.",
  );
  language = "en";
  assert.equal(
    localizeError({ code: "missing_driver", message: "Aktiv chaufför saknas." }, t),
    "No active driver is assigned.",
  );
});

test("localizes route delete conflict details by stable reason without exposing server prose", () => {
  const reasonKey: ErrorTranslator = (key) => key;
  const error = {
    status: 409,
    code: "ROUTE_DELETE_CONFLICT",
    data: {
      code: "ROUTE_DELETE_CONFLICT",
      error: "A route with an active or terminal stop cannot be deleted.",
      details: {
        conflicts: [
          {
            routeId: "route-1",
            reason: "stop_status",
            message: "server-only stop details",
          },
        ],
      },
    },
  };
  assert.equal(
    localizeError(error, reasonKey, { fallbackKey: "routes.bulkDeleteError" }),
    "routes.deleteConflictReasons.stopStatus",
  );
  assert.equal(
    localizeError({
      ...error,
      data: {
        ...error.data,
        error: "Conflict",
      },
    }, reasonKey, { fallbackKey: "routes.bulkDeleteError" }),
    "routes.deleteConflictReasons.stopStatus",
  );
  assert.equal(
    localizeError({
      ...error,
      data: {
        ...error.data,
        details: {
          conflicts: [{ routeId: "route-1", reason: "unknown_future_reason", message: "raw server text" }],
        },
      },
    }, reasonKey, { fallbackKey: "routes.bulkDeleteError" }),
    "routes.bulkDeleteError",
  );
});

test("preserves trusted app-authored guidance without double-localizing it", () => {
  language = "sv";
  const guidance = "Den sparade planen kunde inte hittas.";
  assert.equal(
    localizeError(new TrustedLocalizedError(guidance), t, { fallbackKey: "common.errorRequestFailed" }),
    guidance,
  );
});

test("does not expose unknown API prose and uses component fallbacks", () => {
  language = "sv";
  const serverError = Object.assign(new Error("SQL host db-01 leaked"), {
    status: 418,
    data: { error: "SQL host db-01 leaked" },
  });
  assert.equal(
    localizeError(serverError, t, { fallbackKey: "planner.alternativesFailed" }),
    "Kunde inte skapa alternativa planer. Försök igen.",
  );
  assert.equal(
    localizeError(new Error("CSV parser implementation detail"), t, { fallbackKey: "import.parseFailed" }),
    "Kunde inte läsa filen. Kontrollera formatet.",
  );
  assert.equal(
    localizeError(new Error("Import failed"), t, { fallbackKey: "import.importFailed" }),
    "Importen misslyckades. Försök igen.",
  );
});

test("uses a component fallback for an unknown non-HTTP error", () => {
  language = "sv";
  assert.equal(
    localizeError(new Error("implementation detail: stack trace"), t, { fallbackKey: "orders.loadFailed" }),
    "Ordrarna kunde inte laddas.",
  );
});

test("preserves the existing Swedish branding/auth guidance", () => {
  language = "sv";
  const message = "Du behöver vara administratör för att ändra kundanpassningen.";
  assert.equal(localizeError(new Error(message), t), message);
});

test("unsent stop messaging is distinguished from real conflicts and access errors", () => {
  language = "sv";
  const error = { status: 409, data: { error: "The stop has no dispatched driver" } };
  assert.equal(isStopMessageAwaitingDispatch(error), true);
  assert.equal(localizeError(error, t),
    "Skicka rutten till chauffören för att kunna skriva meddelanden.");
  for (const other of [
    { status: 409, data: { error: "Stop message thread changed; reload and retry" } },
    { status: 409, data: { error: "clientMessageId was already used for a different message" } },
    { status: 403, data: { error: "Forbidden: messaging is not available for this role" } },
    { status: 404, data: { error: "Stop not found" } },
    null,
  ]) {
    assert.equal(isStopMessageAwaitingDispatch(other), false);
  }
  assert.equal(localizeError({
    status: 409, data: { error: "Stop message thread changed; reload and retry" },
  }, t), "Begäran krockar med en nyare ändring. Uppdatera och försök igen.");
});

test("planning preview keeps explicitly classified validation guidance instead of a generic 400", () => {
  const error = "Alla befintliga stopp måste finnas med exakt en gång i den justerade planen.";
  assert.equal(localizeError({
    status: 400, data: { code: "IMPORT_PLAN_REVIEW_FAILED", error },
  }, t), error);
  assert.equal(localizeError({
    status: 409, data: { code: "IMPORT_PLAN_REVIEW_FAILED", error: "Planen har ändrats. Ladda om." },
  }, t), "Planen har ändrats. Ladda om.");
  assert.notEqual(localizeError({ status: 400, data: { error: "private provider details" } }, t),
    "private provider details");
});

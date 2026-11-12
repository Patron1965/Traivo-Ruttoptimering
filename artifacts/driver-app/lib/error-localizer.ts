export type AppLanguage = "sv" | "en";

export type AppErrorCode =
  | "network"
  | "unauthorized"
  | "invalidCredentials"
  | "accountLocked"
  | "forbidden"
  | "notFound"
  | "validation"
  | "conflict"
  | "rateLimited"
  | "server"
  | "gpsPermission"
  | "gpsBackgroundPermission"
  | "gpsUnavailable"
  | "routeStopsRemain"
  | "cameraPermission"
  | "offlineQueue"
  | "sessionScope"
  | "generic";

export const errorMessages = {
  sv: {
    network: "Ingen anslutning till tjänsten. Kontrollera internetanslutningen och försök igen.",
    unauthorized: "Din inloggning har gått ut. Logga in igen.",
    invalidCredentials: "Felaktig e-post eller lösenord. Kontrollera uppgifterna och försök igen.",
    accountLocked: "Kontot är tillfälligt låst efter för många inloggningsförsök. Vänta en stund och försök igen.",
    forbidden: "Du saknar behörighet för den här åtgärden.",
    notFound: "Det du försökte öppna finns inte längre.",
    validation: "Kontrollera uppgifterna och försök igen.",
    conflict: "Ändringen kunde inte sparas eftersom uppgifterna har ändrats. Uppdatera och försök igen.",
    rateLimited: "För många försök just nu. Vänta en stund och försök igen.",
    server: "Tjänsten kunde inte slutföra åtgärden just nu. Försök igen senare.",
    gpsPermission: "Platsbehörighet krävs för att starta ruttspårning.",
    gpsBackgroundPermission: "Bakgrundsbehörighet för plats krävs när telefonen är låst.",
    gpsUnavailable: "Ingen GPS-position har mottagits ännu. Kontrollera platsbehörighet och GPS.",
    routeStopsRemain: "Körningen kan inte avslutas medan stopp återstår. Slutför eller rapportera återstående stopp och synkronisera ändringarna. Körningen fortsätter.",
    cameraPermission: "Kamerabehörighet saknas. Tillåt kamera för att fortsätta.",
    offlineQueue: "Kunde inte spara ändringen lokalt. Kontrollera lagringsutrymmet och försök igen.",
    sessionScope: "Förarsessionen kunde inte bekräftas. Logga in igen.",
    generic: "Något gick fel. Försök igen.",
  },
  en: {
    invalidCredentials: "Incorrect email or password. Check your details and try again.",
    accountLocked: "The account is temporarily locked after too many sign-in attempts. Wait a while and try again.",
    network: "The service is unavailable offline. Check your internet connection and try again.",
    unauthorized: "Your sign-in has expired. Sign in again.",
    forbidden: "You are not allowed to perform this action.",
    notFound: "The item you tried to open is no longer available.",
    validation: "Check the details and try again.",
    conflict: "The change could not be saved because the data changed. Refresh and try again.",
    rateLimited: "There are too many attempts right now. Wait a moment and try again.",
    server: "The service could not complete the action right now. Try again later.",
    gpsPermission: "Location permission is required to start route tracking.",
    gpsBackgroundPermission: "Background location permission is required while the phone is locked.",
    gpsUnavailable: "No GPS position has been received yet. Check location permission and GPS.",
    routeStopsRemain: "The drive cannot end while stops remain. Complete or report the remaining stops and sync the changes. The drive stays active.",
    cameraPermission: "Camera permission is missing. Allow camera access to continue.",
    offlineQueue: "The change could not be saved locally. Check available storage and try again.",
    sessionScope: "The driver session could not be confirmed. Sign in again.",
    generic: "Something went wrong. Please try again.",
  },
} as const satisfies Record<AppLanguage, Record<AppErrorCode, string>>;

export type ErrorLocalizerOptions = {
  /** A translated, screen-specific fallback for errors without a known category. */
  fallback?: string;
  /** Include a safe request reference when the server supplied one. */
  includeReference?: boolean;
};

export interface PersistedGpsError {
  code: AppErrorCode;
  status?: number;
  requestId?: string;
}

export type GpsErrorValue = PersistedGpsError | string;

let currentLanguage: AppLanguage = "sv";

export function setCurrentLanguage(language: AppLanguage) {
  currentLanguage = language;
}

export function getCurrentLanguage(): AppLanguage {
  return currentLanguage;
}

export function createAppError(code: AppErrorCode): Error & { code: AppErrorCode } {
  const error = new Error(code);
  error.name = "AppError";
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error as Error & { code: AppErrorCode };
}

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === "string" && value in errorMessages.sv;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readErrorField(error: unknown, field: string): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  return readString((error as Record<string, unknown>)[field]);
}

function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as Record<string, unknown>).status;
  return typeof status === "number" ? status : undefined;
}

function categoryFromCode(code: string | undefined): AppErrorCode | undefined {
  if (!code) return undefined;
  if (isAppErrorCode(code.trim())) return code.trim() as AppErrorCode;
  const normalized = code.trim().toUpperCase();
  if (normalized === "NETWORK_ERROR" || normalized === "OFFLINE") return "network";
  if (normalized === "INVALID_CREDENTIALS") return "invalidCredentials";
  if (normalized === "ACCOUNT_LOCKED") return "accountLocked";
  if (normalized === "SESSION_CHANGED") return "conflict";
  if (normalized === "UNAUTHORIZED" || normalized === "AUTH_REQUIRED" || normalized === "SESSION_EXPIRED") return "unauthorized";
  if (normalized === "FORBIDDEN") return "forbidden";
  if (normalized === "NOT_FOUND") return "notFound";
  if (normalized === "VALIDATION_ERROR" || normalized === "INVALID_INPUT") return "validation";
  if (
    normalized === "STALE_PLAN" ||
    normalized === "STALE_PLAN_VERSION" ||
    normalized === "CONFLICT" ||
    normalized === "PLAN_VERSION_CONFLICT"
  ) return "conflict";
  if (normalized === "RATE_LIMITED" || normalized === "TOO_MANY_REQUESTS") return "rateLimited";
  if (normalized === "GPS_PERMISSION_REQUIRED") return "gpsPermission";
  if (normalized === "GPS_BACKGROUND_PERMISSION_REQUIRED") return "gpsBackgroundPermission";
  if (normalized === "GPS_UNAVAILABLE") return "gpsUnavailable";
  if (normalized === "ROUTE_STOPS_REMAIN") return "routeStopsRemain";
  if (normalized === "CAMERA_PERMISSION_REQUIRED") return "cameraPermission";
  if (normalized === "OFFLINE_QUEUE_ERROR") return "offlineQueue";
  if (normalized === "SESSION_SCOPE_UNAVAILABLE") return "sessionScope";
  if (normalized === "GENERIC" || normalized === "UNKNOWN") return "generic";
  return undefined;
}

function categoryFromLegacyMessage(message: string): AppErrorCode | undefined {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return undefined;
  const fromCode = categoryFromCode(message);
  if (fromCode) return fromCode;
  const translatedCategory = (Object.keys(errorMessages.sv) as AppErrorCode[]).find(
    (code) =>
      errorMessages.sv[code].toLowerCase() === normalized ||
      errorMessages.en[code].toLowerCase() === normalized,
  );
  if (translatedCategory) return translatedCategory;
  if (normalized.includes("offline queue") || normalized.includes("offlinekö")) return "offlineQueue";
  if (
    normalized.includes("network request failed") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("ingen anslutning") ||
    normalized.includes("offline")
  ) return "network";
  if (
    normalized.includes("background") && normalized.includes("permission") ||
    normalized.includes("bakgrundsbehörighet")
  ) return "gpsBackgroundPermission";
  if (
    normalized.includes("gps permission") ||
    normalized.includes("location permission") ||
    normalized.includes("platsbehörighet") ||
    normalized.includes("kamerabehörighet")
  ) {
    return normalized.includes("kamera") || normalized.includes("camera")
      ? "cameraPermission"
      : "gpsPermission";
  }
  if (
    normalized.includes("gps position") ||
    normalized.includes("gps-position") ||
    normalized.includes("no gps") ||
    normalized.includes("ingen gps")
  ) return "gpsUnavailable";
  if (
    normalized.includes("session") &&
    (normalized.includes("auth") || normalized.includes("confirm") || normalized.includes("bekräft"))
  ) return normalized.includes("not authenticated") || normalized.includes("unauthenticated")
    ? "unauthorized"
    : "sessionScope";
  return undefined;
}

function categoryFor(error: unknown): AppErrorCode {
  if (typeof error === "string") {
    return categoryFromLegacyMessage(error) ?? "generic";
  }
  const explicitCode = categoryFromCode(readErrorField(error, "code"));
  if (explicitCode) return explicitCode;

  const status = readStatus(error);
  if (status === 0) return "network";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status === 422 || status === 400) return "validation";
  if (status === 429) return "rateLimited";
  if (status !== undefined && status >= 500) return "server";

  const name = readErrorField(error, "name")?.toLowerCase();
  const message = readErrorField(error, "message")?.toLowerCase() ?? "";
  if (name === "typeerror" && (message.includes("fetch") || message.includes("network"))) return "network";
  if (message.includes("network request failed") || message.includes("failed to fetch")) return "network";
  if (message === "gps_permission_required") return "gpsPermission";
  if (message === "gps_background_permission_required") return "gpsBackgroundPermission";
  if (message === "gps_unavailable") return "gpsUnavailable";
  if (message === "camera_permission_required") return "cameraPermission";
  if (message === "offline_queue_error") return "offlineQueue";
  if (message === "session_scope_unavailable") return "sessionScope";
  return "generic";
}

function requestReference(error: unknown): string | undefined {
  const reference = readErrorField(error, "requestId") ?? readErrorField(error, "requestReference");
  return reference && /^[A-Za-z0-9._:-]{1,80}$/.test(reference) ? reference : undefined;
}

export function errorCategory(error: unknown): AppErrorCode {
  return categoryFor(error);
}

export function localizeError(
  error: unknown,
  language: AppLanguage = currentLanguage,
  options: ErrorLocalizerOptions = {},
): string {
  const category = categoryFor(error);
  const message = category === "generic"
    ? options.fallback ?? errorMessages[language].generic
    : errorMessages[language][category];
  const reference = options.includeReference === false ? undefined : requestReference(error);
  if (!reference) return message;
  return `${message} (${language === "sv" ? "Referens" : "Reference"}: ${reference})`;
}

function persistedGpsRequestId(error: unknown) {
  const requestId = readErrorField(error, "requestId");
  return requestId && /^[A-Za-z0-9._:-]{1,80}$/.test(requestId) ? requestId : undefined;
}

function persistedGpsStatus(error: unknown) {
  const status = readStatus(error);
  return status !== undefined && Number.isInteger(status) ? status : undefined;
}

/**
 * Background tasks persist this language-neutral descriptor and let the UI
 * localize it at render time. No backend response body or translated string
 * crosses the background/UI boundary.
 */
export function toPersistedGpsError(
  error: unknown,
  fallback: AppErrorCode = "generic",
): PersistedGpsError {
  const code = errorCategory(error);
  const status = persistedGpsStatus(error);
  const requestId = persistedGpsRequestId(error);
  return {
    code: code === "generic" ? fallback : code,
    ...(status === undefined ? {} : { status }),
    ...(requestId ? { requestId } : {}),
  };
}

export function parsePersistedGpsError(raw: string): GpsErrorValue | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && isAppErrorCode(parsed.code)) {
      return {
        code: parsed.code,
        ...(typeof parsed.status === "number" ? { status: parsed.status } : {}),
        ...(typeof parsed.requestId === "string" ? { requestId: parsed.requestId } : {}),
      };
    }
  } catch {
    // Older clients stored a translated string. Known messages are mapped by
    // categoryFor; unknown strings are replaced by the generic safe message.
  }
  return raw.trim() || null;
}
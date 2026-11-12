import * as Sentry from "@sentry/node";

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log("[SENTRY] No DSN configured, error tracking disabled");
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeSendTransaction(event) {
      const content = JSON.stringify(event);
      if (/\/track\//.test(content) || /\/customer-link/.test(content)) return null;
      return event;
    },
    beforeBreadcrumb(breadcrumb) {
      const value = JSON.stringify(breadcrumb);
      return /\/track\//.test(value) || /\/customer-link/.test(value) ? null : breadcrumb;
    },
    beforeSend(event) {
      // Also covers nested spans, headers (Referer), and exception context.
      const content = JSON.stringify(event);
      if (/\/track\//.test(content) || /\/customer-link/.test(content)) return null;
      return event;
    },
  });
  initialized = true;
  console.log("[SENTRY] Initialized for", process.env.NODE_ENV || "development");
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) {
    const name = err instanceof Error ? err.name : "UnknownError";
    const message = err instanceof Error ? err.message : String(err);
    // Avoid passing complex validation-error objects to util.inspect. Logging
    // itself must never throw and replace the API's intended JSON response.
    console.error(`[ERROR] ${name}: ${message}`, context ? JSON.stringify(context) : "");
    return;
  }
  Sentry.captureException(err, { extra: context });
}

export function captureMessage(message: string, level: "info" | "warning" | "error" = "info"): void {
  if (!initialized) {
    console.log(`[${level.toUpperCase()}]`, message);
    return;
  }
  Sentry.captureMessage(message, level);
}

export { Sentry };

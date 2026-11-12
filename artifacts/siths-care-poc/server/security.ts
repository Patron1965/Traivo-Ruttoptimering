import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { JsonLogger, logger } from "./logger.ts";

export class SecurityError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    code: string,
    message = "Authentication could not be verified",
    status = 401,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function setSecurityHeaders(
  response: ServerResponse,
  development: boolean,
) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'self'${development ? " 'unsafe-inline'" : ""}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      `connect-src 'self'${development ? " ws: wss:" : ""}`,
      "img-src 'self' data:",
      `worker-src 'self'${development ? " blob:" : ""}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
  );
  if (!development) {
    response.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
) {
  const serialized = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", Buffer.byteLength(serialized));
  response.end(serialized);
}

export function sendError(
  response: ServerResponse,
  error: unknown,
  correlationId = randomUUID(),
) {
  emitSecurityError(error, correlationId);
  if (error instanceof SecurityError) {
    sendJson(response, error.status, {
      error: error.message,
      code: error.code,
      correlationId,
    });
    return;
  }
  sendJson(response, 500, {
    error: "Ett oväntat fel inträffade.",
    code: "INTERNAL_ERROR",
    correlationId,
  });
}

export function emitSecurityError(
  error: unknown,
  correlationId: string,
  target: JsonLogger = logger,
): void {
  const code = error instanceof SecurityError ? error.code : "INTERNAL_ERROR";
  const status = error instanceof SecurityError ? error.status : 500;
  target.emit({
    category: "siths_security_error",
    code,
    status,
    correlationId,
  });
}

export async function readJson<T>(
  request: IncomingMessage,
  maxBytes = 16_384,
): Promise<T> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new SecurityError(
      "CONTENT_TYPE_REQUIRED",
      "Begäran måste vara JSON.",
      415,
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new SecurityError("BODY_TOO_LARGE", "Begäran är för stor.", 413);
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new SecurityError("INVALID_JSON", "Ogiltig JSON.", 400);
  }
}

export function parseCookies(request: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  const header = request.headers.cookie;
  if (!header) return cookies;
  for (const item of header.split(";")) {
    const index = item.indexOf("=");
    if (index <= 0) continue;
    const name = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      continue;
    }
  }
  return cookies;
}

export function serializeCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
  options?: {
    path?: string;
    sameSite?: "Strict" | "Lax";
  },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options?.path ?? "/api/siths"}`,
    "HttpOnly",
    `SameSite=${options?.sameSite ?? "Strict"}`,
    secure ? "Secure" : "",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function hashBrowserBinding(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function appendSetCookie(response: ServerResponse, cookie: string) {
  const existing = response.getHeader("Set-Cookie");
  const values = Array.isArray(existing)
    ? existing
    : typeof existing === "string"
      ? [existing]
      : [];
  response.setHeader("Set-Cookie", [...values, cookie]);
}

export function assertSameOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (!origin) return;
  const host =
    request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost";
  const proto = request.headers["x-forwarded-proto"] ?? "http";
  if (origin !== `${proto}://${host}`) {
    throw new SecurityError("ORIGIN_REJECTED", "Otillåtet ursprung.", 403);
  }
}

export class SlidingWindowRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  assertAllowed(key: string, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (recent.length >= this.limit) {
      throw new SecurityError(
        "RATE_LIMITED",
        "För många inloggningsförsök. Försök igen senare.",
        429,
      );
    }
    recent.push(now);
    this.attempts.set(key, recent);
  }
}

export function clientAddress(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0]!.trim();
  return request.socket.remoteAddress ?? "unknown";
}
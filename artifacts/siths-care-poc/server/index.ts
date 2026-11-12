import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { apiPrefixForBasePath, isApiPrefixPath, loadConfig } from "./config.ts";
import { DevIdentityHarness, parseDevScenario } from "./dev-harness.ts";
import { IdTokenVerifier, OidcClient } from "./oidc.ts";
import {
  appendSetCookie,
  assertSameOrigin,
  clientAddress,
  hashBrowserBinding,
  parseCookies,
  readJson,
  SecurityError,
  sendError,
  sendJson,
  serializeCookie,
  setSecurityHeaders,
  SlidingWindowRateLimiter,
} from "./security.ts";
import { createAuthStore, opaqueId } from "./store.ts";
import {
  assessHealth,
  assessPilotRouteAccess,
  assessReadiness,
} from "./readiness.ts";
import type {
  AuthenticatedSession,
  HealthcareIdentity,
  PendingIdentity,
  SessionView,
} from "./types.ts";

const config = loadConfig();
const { store: stores, initialProbe } = await createAuthStore(config);
if (config.isProduction && !initialProbe.ok) {
  throw new Error("Production storage startup probe failed");
}
const verifier = new IdTokenVerifier(stores);
const oidc = new OidcClient(config, verifier);
const harness = new DevIdentityHarness(verifier);
const loginLimiter = new SlidingWindowRateLimiter(20, 15 * 60_000);
const apiPrefix = apiPrefixForBasePath(config.basePath);
const sessionCookie = config.isProduction
  ? "__Secure-siths_session"
  : "siths_poc_session";
const pendingCookie = config.isProduction
  ? "__Secure-siths_pending"
  : "siths_poc_pending";
const transactionCookie = config.isProduction
  ? "__Secure-siths_transaction"
  : "siths_poc_transaction";
const pilotRouteSuffixes = new Set([
  "/session",
  "/login/start",
  "/callback",
  "/assignment",
  "/logout",
  "/dev/login",
  "/audit/events",
]);

function identityView(identity: HealthcareIdentity) {
  const { assignments: _assignments, ...view } = identity;
  return view;
}

function anonymousSession(): SessionView {
  return {
    state: "anonymous",
    identity: null,
    activeAssignment: null,
    availableAssignments: [],
    expiresAt: null,
    devHarnessEnabled: config.devHarnessEnabled,
  };
}

function pendingSession(pending: PendingIdentity): SessionView {
  return {
    state: "assignment_required",
    identity: identityView(pending.identity),
    activeAssignment: null,
    availableAssignments: pending.identity.assignments,
    expiresAt: new Date(pending.expiresAt).toISOString(),
    devHarnessEnabled: config.devHarnessEnabled,
  };
}

function authenticatedSession(session: AuthenticatedSession): SessionView {
  return {
    state: "authenticated",
    identity: identityView(session.identity),
    activeAssignment: session.activeAssignment,
    availableAssignments: session.identity.assignments,
    expiresAt: new Date(session.expiresAt).toISOString(),
    devHarnessEnabled: config.devHarnessEnabled,
  };
}

function requestCookies(request: IncomingMessage) {
  const cookies = parseCookies(request);
  return {
    sessionId: cookies.get(sessionCookie),
    pendingId: cookies.get(pendingCookie),
  };
}

function setOpaqueCookie(
  response: ServerResponse,
  name: string,
  value: string,
  expiresAt: number,
) {
  appendSetCookie(
    response,
    serializeCookie(
      name,
      value,
      Math.ceil((expiresAt - Date.now()) / 1000),
      config.isProduction,
      { path: apiPrefix },
    ),
  );
}

function clearCookie(response: ServerResponse, name: string) {
  appendSetCookie(
    response,
    serializeCookie(name, "", 0, config.isProduction, { path: apiPrefix }),
  );
}

function setTransactionCookie(
  response: ServerResponse,
  value: string,
  maxAgeSeconds: number,
) {
  appendSetCookie(
    response,
    serializeCookie(
      transactionCookie,
      value,
      maxAgeSeconds,
      config.isProduction,
      { path: `${apiPrefix}/callback`, sameSite: "Lax" },
    ),
  );
}

function clearTransactionCookie(response: ServerResponse) {
  setTransactionCookie(response, "", 0);
}

async function currentContext(request: IncomingMessage) {
  const cookies = requestCookies(request);
  const session = await stores.getSession(cookies.sessionId);
  const pending = session ? null : await stores.getPending(cookies.pendingId);
  return { cookies, session, pending };
}

function sanitizeReturnPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith(config.basePath) ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.length > 512
  ) {
    return config.basePath;
  }
  return value;
}

async function finalizeIdentity(
  response: ServerResponse,
  identity: HealthcareIdentity,
  correlationId: string,
): Promise<SessionView> {
  await stores.appendAudit(
    "identity_verified",
    "success",
    null,
    correlationId,
  );
  if (identity.assignments.length === 1) {
    const session = await stores.createSession(
      identity,
      identity.assignments[0]!,
      correlationId,
    );
    await stores.appendAudit("session_created", "success", null, correlationId);
    setOpaqueCookie(
      response,
      sessionCookie,
      session.id,
      session.expiresAt,
    );
    clearCookie(response, pendingCookie);
    return authenticatedSession(session);
  }
  const pending = await stores.createPending(identity, correlationId);
  setOpaqueCookie(response, pendingCookie, pending.id, pending.expiresAt);
  clearCookie(response, sessionCookie);
  return pendingSession(pending);
}

function redirect(response: ServerResponse, location: string) {
  response.statusCode = 303;
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

function methodNotAllowed(response: ServerResponse, allow: string) {
  response.setHeader("Allow", allow);
  sendJson(response, 405, {
    error: "Metoden stöds inte.",
    code: "METHOD_NOT_ALLOWED",
    correlationId: randomUUID(),
  });
}

function isPilotFacingRoute(pathname: string): boolean {
  return pilotRouteSuffixes.has(pathname.slice(apiPrefix.length));
}

async function rejectPilotRouteWhenNotReady(
  response: ServerResponse,
  correlationId: string,
): Promise<boolean> {
  const access = assessPilotRouteAccess(config, await stores.probe());
  if (access.ready) return false;
  sendJson(response, 503, {
    error: "Pilotdriften är inte godkänd för identitetshantering.",
    code: "PILOT_NOT_READY",
    correlationId,
  });
  return true;
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!isApiPrefixPath(url.pathname, apiPrefix)) return false;
  const correlationId = randomUUID();

  try {
    if (url.pathname === `${apiPrefix}/health`) {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      const storageProbe = await stores.probe();
      const healthy = assessHealth(config, storageProbe);
      sendJson(response, healthy ? 200 : 503, {
        status: healthy ? "ok" : "unavailable",
        storage: {
          backend: stores.backend,
          region: stores.region,
        },
      });
      return true;
    }

    if (url.pathname === `${apiPrefix}/readiness`) {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      const storageProbe = await stores.probe();
      const readiness = assessReadiness(config, storageProbe);
      sendJson(response, readiness.ready ? 200 : 503, {
        mode: config.oidcConfigured
          ? "oidc"
          : config.devHarnessEnabled
            ? "dev_harness"
            : "unconfigured",
        oidcConfigured: config.oidcConfigured,
        devHarnessEnabled: config.devHarnessEnabled,
        minimumLoa: config.minimumLoa,
        sessionTtlMinutes: Math.round(config.sessionTtlMs / 60_000),
        storage: {
          backend: stores.backend,
          region: stores.region,
          probeOk: storageProbe.ok,
          startupProbeOk: initialProbe.ok,
          error: storageProbe.error ?? null,
        },
        blockers: readiness.blockers,
      });
      return true;
    }

    if (
      config.isProduction &&
      isPilotFacingRoute(url.pathname) &&
      (await rejectPilotRouteWhenNotReady(response, correlationId))
    ) {
      return true;
    }

    if (url.pathname === `${apiPrefix}/session`) {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      const { session, pending } = await currentContext(request);
      sendJson(
        response,
        200,
        session
          ? authenticatedSession(session)
          : pending
            ? pendingSession(pending)
            : anonymousSession(),
      );
      return true;
    }

    if (url.pathname === `${apiPrefix}/login/start`) {
      if (request.method !== "POST") {
        methodNotAllowed(response, "POST");
        return true;
      }
      assertSameOrigin(request);
      loginLimiter.assertAllowed(clientAddress(request));
      const body = await readJson<{ returnPath?: unknown }>(request);
      const returnPath = sanitizeReturnPath(body.returnPath);
      const loginCorrelationId = randomUUID();
      const browserBinding = opaqueId();
      await stores.appendAudit(
        "login_started",
        "informational",
        null,
        loginCorrelationId,
      );
      const started = await oidc.begin(
        returnPath,
        loginCorrelationId,
        hashBrowserBinding(browserBinding),
      );
      await stores.putTransaction(started.transaction);
      setTransactionCookie(
        response,
        browserBinding,
        Math.ceil(config.transactionTtlMs / 1000),
      );
      sendJson(response, 200, {
        authorizationUrl: started.authorizationUrl,
        expiresAt: new Date(started.transaction.expiresAt).toISOString(),
      });
      return true;
    }

    if (url.pathname === `${apiPrefix}/callback`) {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      const browserBinding = parseCookies(request).get(transactionCookie);
      clearTransactionCookie(response);
      const state = url.searchParams.get("state");
      const transaction =
        state && browserBinding
          ? await stores.consumeTransaction(
              state,
              hashBrowserBinding(browserBinding),
            )
          : null;
      if (!transaction) {
        await stores.appendAudit(
          "token_rejected",
          "rejected",
          browserBinding
            ? "OIDC_STATE_OR_BROWSER_BINDING_INVALID"
            : "OIDC_BROWSER_BINDING_MISSING",
          correlationId,
        );
        redirect(response, `${config.basePath}?auth_error=STATE_INVALID`);
        return true;
      }
      if (url.searchParams.has("error")) {
        await stores.appendAudit(
          "token_rejected",
          "rejected",
          "OIDC_AUTHORIZATION_REJECTED",
          transaction.correlationId,
        );
        redirect(
          response,
          `${transaction.returnPath}?auth_error=AUTHORIZATION_REJECTED`,
        );
        return true;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        await stores.appendAudit(
          "token_rejected",
          "rejected",
          "AUTHORIZATION_CODE_MISSING",
          transaction.correlationId,
        );
        redirect(
          response,
          `${transaction.returnPath}?auth_error=CODE_MISSING`,
        );
        return true;
      }
      try {
        const identity = await oidc.complete(code, transaction);
        await finalizeIdentity(response, identity, transaction.correlationId);
        redirect(response, transaction.returnPath);
      } catch (error) {
        const reason =
          error instanceof SecurityError ? error.code : "TOKEN_VALIDATION_FAILED";
        await stores.appendAudit(
          "token_rejected",
          "rejected",
          reason,
          transaction.correlationId,
        );
        redirect(
          response,
          `${transaction.returnPath}?auth_error=TOKEN_REJECTED`,
        );
      }
      return true;
    }

    if (url.pathname === `${apiPrefix}/assignment`) {
      if (request.method !== "POST") {
        methodNotAllowed(response, "POST");
        return true;
      }
      assertSameOrigin(request);
      const body = await readJson<{ assignmentId?: unknown }>(request);
      if (
        typeof body.assignmentId !== "string" ||
        body.assignmentId.length > 128
      ) {
        throw new SecurityError(
          "ASSIGNMENT_SELECTION_INVALID",
          "Ogiltigt medarbetaruppdrag.",
          400,
        );
      }
      const { pendingId } = requestCookies(request);
      const pending = await stores.consumePending(pendingId);
      if (!pending) {
        throw new SecurityError(
          "PENDING_IDENTITY_REQUIRED",
          "Identitetsverifieringen har löpt ut. Logga in igen.",
        );
      }
      const assignment = pending.identity.assignments.find(
        (candidate) => candidate.id === body.assignmentId,
      );
      if (!assignment) {
        throw new SecurityError(
          "ASSIGNMENT_NOT_VERIFIED",
          "Uppdraget ingick inte i den verifierade identiteten.",
          403,
        );
      }
      const session = await stores.createSession(
        pending.identity,
        assignment,
        pending.correlationId,
      );
      await stores.appendAudit(
        "assignment_selected",
        "success",
        null,
        pending.correlationId,
      );
      await stores.appendAudit(
        "session_created",
        "success",
        null,
        pending.correlationId,
      );
      setOpaqueCookie(
        response,
        sessionCookie,
        session.id,
        session.expiresAt,
      );
      clearCookie(response, pendingCookie);
      sendJson(response, 200, authenticatedSession(session));
      return true;
    }

    if (url.pathname === `${apiPrefix}/logout`) {
      if (request.method !== "POST") {
        methodNotAllowed(response, "POST");
        return true;
      }
      assertSameOrigin(request);
      const { cookies, session, pending } = await currentContext(request);
      const eventCorrelationId =
        session?.correlationId ?? pending?.correlationId ?? correlationId;
      await stores.deleteSession(cookies.sessionId);
      await stores.consumePending(cookies.pendingId);
      await stores.appendAudit("logout", "success", null, eventCorrelationId);
      clearCookie(response, sessionCookie);
      clearCookie(response, pendingCookie);
      sendJson(response, 200, anonymousSession());
      return true;
    }

    if (url.pathname === `${apiPrefix}/dev/login`) {
      if (request.method !== "POST") {
        methodNotAllowed(response, "POST");
        return true;
      }
      if (!config.devHarnessEnabled) {
        sendJson(response, 404, {
          error: "Hittades inte.",
          code: "NOT_FOUND",
          correlationId,
        });
        return true;
      }
      assertSameOrigin(request);
      loginLimiter.assertAllowed(clientAddress(request));
      const body = await readJson<{ scenario?: unknown }>(request);
      const scenario = parseDevScenario(body.scenario);
      const scenarioCorrelationId = randomUUID();
      await stores.appendAudit(
        "login_started",
        "informational",
        "SYNTHETIC_IDENTITY",
        scenarioCorrelationId,
      );
      try {
        const identity = await harness.run(scenario);
        const sessionView = await finalizeIdentity(
          response,
          identity,
          scenarioCorrelationId,
        );
        sendJson(response, 200, sessionView);
      } catch (error) {
        const reason =
          error instanceof SecurityError ? error.code : "DEV_SCENARIO_REJECTED";
        await stores.appendAudit(
          "token_rejected",
          "rejected",
          reason,
          scenarioCorrelationId,
        );
        throw error;
      }
      return true;
    }

    if (url.pathname === `${apiPrefix}/audit/events`) {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      const { session, pending } = await currentContext(request);
      const auditCorrelationId =
        session?.correlationId ?? pending?.correlationId;
      if (!auditCorrelationId) {
        throw new SecurityError(
          "AUTHENTICATION_REQUIRED",
          "Autentisering krävs.",
        );
      }
      sendJson(
        response,
        200,
        await stores.listAuditForCorrelation(auditCorrelationId),
      );
      return true;
    }

    sendJson(response, 404, {
      error: "Hittades inte.",
      code: "NOT_FOUND",
      correlationId,
    });
    return true;
  } catch (error) {
    sendError(response, error, correlationId);
    return true;
  }
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const artifactDirectory = path.resolve(moduleDirectory, "..");
const publicDirectory = path.join(artifactDirectory, "dist", "public");

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

async function serveProduction(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  if (!["GET", "HEAD"].includes(request.method ?? "")) {
    methodNotAllowed(response, "GET, HEAD");
    return;
  }
  const relativeUrl = url.pathname.startsWith(config.basePath)
    ? url.pathname.slice(config.basePath.length)
    : "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(relativeUrl);
  } catch {
    response.statusCode = 400;
    response.end("Bad request");
    return;
  }
  const candidate = path.resolve(publicDirectory, decoded || "index.html");
  let filePath = candidate.startsWith(`${publicDirectory}${path.sep}`)
    ? candidate
    : path.join(publicDirectory, "index.html");
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not a file");
  } catch {
    filePath = path.join(publicDirectory, "index.html");
  }
  const fileStat = await stat(filePath);
  const isIndex = filePath === path.join(publicDirectory, "index.html");
  // The pilot's configured OIDC callback is the trusted public origin. Never
  // derive a shareable URL from the request Host header.
  const indexHtml = isIndex && config.oidcRedirectUri
    ? (await readFile(filePath, "utf8")).replace(
        /(<meta (?:property="og:image"|name="twitter:image") content=")[^"]+(")/g,
        (_, start: string, end: string) =>
          `${start}${new URL(`${config.basePath}social-card.png`, config.oidcRedirectUri!).href}${end}`,
      )
    : null;
  response.statusCode = 200;
  response.setHeader(
    "Content-Type",
    contentTypes[path.extname(filePath)] ?? "application/octet-stream",
  );
  response.setHeader("Content-Length", indexHtml ? Buffer.byteLength(indexHtml) : fileStat.size);
  response.setHeader(
    "Cache-Control",
    filePath.endsWith("index.html")
      ? "no-store"
      : "public, max-age=3600, immutable",
  );
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  if (indexHtml !== null) {
    response.end(indexHtml);
    return;
  }
  createReadStream(filePath).pipe(response);
}

let vite:
  | Awaited<ReturnType<(typeof import("vite"))["createServer"]>>
  | undefined;

export const server = createServer(async (request, response) => {
  setSecurityHeaders(response, !config.isProduction);
  const host = request.headers.host ?? "localhost";
  const url = new URL(request.url ?? "/", `http://${host}`);
  if (await handleApi(request, response, url)) return;

  if (vite) {
    vite.middlewares(request, response, (error: unknown) => {
      if (error) sendError(response, error);
      else {
        response.statusCode = 404;
        response.end("Not found");
      }
    });
    return;
  }
  try {
    await serveProduction(request, response, url);
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
});

if (!config.isProduction) {
  const { createServer: createViteServer } = await import("vite");
  vite = await createViteServer({
    configFile: path.join(artifactDirectory, "vite.config.ts"),
    server: {
      middlewareMode: true,
      hmr: { server },
    },
    appType: "spa",
  });
}

const cleanupTimer = setInterval(() => {
  void stores.cleanup().catch(() => {
    console.error("SITHS_STORE_CLEANUP_FAILED");
  });
}, 60_000);
cleanupTimer.unref();
server.on("close", () => {
  clearInterval(cleanupTimer);
  void stores.close?.().catch(() => {
    console.error("SITHS_STORE_CLOSE_FAILED");
  });
});

server.listen(config.port, "0.0.0.0");
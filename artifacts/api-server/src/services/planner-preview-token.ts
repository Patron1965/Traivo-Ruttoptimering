import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const key = randomBytes(32);
const TTL_MS = 10 * 60_000;

export class PlannerCorrectionError extends Error {
  constructor(message: string, public statusCode = 409, public code = "PLANNER_PREVIEW_STALE") {
    super(message);
  }
}

/** Process-local signing key deliberately invalidates previews after a restart. */
export function issuePlannerToken<T>(organizationId: string, userId: string, value: T, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ organizationId, userId, expiresAt: now + TTL_MS, value })).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

export function readPlannerToken<T>(token: string, organizationId: string, userId: string, now = Date.now()): T {
  const [payload, signature, extra] = token.split(".");
  const fail = () => new PlannerCorrectionError("Förhandsgranskningen har ändrats eller gått ut. Beräkna ett nytt förslag.");
  if (!payload || !signature || extra || token.length > 100_000) throw fail();
  const expected = createHmac("sha256", key).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw fail();
  let decoded;
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw fail(); }
  if (decoded.organizationId !== organizationId || decoded.userId !== userId || decoded.expiresAt <= now) throw fail();
  return decoded.value as T;
}

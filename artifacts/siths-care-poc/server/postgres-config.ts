export interface PostgresSettings {
  databaseUrl: string;
  sessionKeys: string[];
  auditKeys: string[];
}

function keyRing(current: string | undefined, previous: string | undefined, name: string): string[] {
  const keys = [...new Set([current?.trim() ?? "", ...(previous ?? "").split(",").map((key) => key.trim()).filter(Boolean)])];
  for (const key of keys) {
    const bytes = Buffer.from(key, "base64");
    if (bytes.length !== 32 || bytes.toString("base64") !== key) {
      throw new Error(`${name} requires canonical base64-encoded 32-byte keys`);
    }
  }
  return keys;
}

export function loadPostgresSettings(
  env: NodeJS.ProcessEnv,
  sourceProjectId: string | null,
): PostgresSettings {
  const target = env.SITHS_EXPECTED_REPLIT_PROJECT_ID?.trim();
  if (!sourceProjectId || !target || target === sourceProjectId || env.REPL_ID !== target) {
    throw new Error("PostgreSQL storage requires the exported app in its explicitly approved separate Replit project");
  }
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(env.DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !databaseUrl.hostname) throw new Error();
  } catch {
    throw new Error("The separate project's managed DATABASE_URL is required");
  }
  // Do not inherit sslmode=require's permissive certificate semantics.
  databaseUrl.searchParams.set("sslmode", "verify-full");
  const sessionKeys = keyRing(env.SITHS_SESSION_KEY, env.SITHS_SESSION_PREVIOUS_KEYS, "SITHS_SESSION_KEY");
  const auditKeys = keyRing(env.SITHS_AUDIT_KEY, env.SITHS_AUDIT_PREVIOUS_KEYS, "SITHS_AUDIT_KEY");
  if (sessionKeys.some((key) => auditKeys.includes(key))) {
    throw new Error("Session encryption and audit authentication require independent keys");
  }
  return { databaseUrl: databaseUrl.toString(), sessionKeys, auditKeys };
}

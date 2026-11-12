import { loadPostgresSettings, type PostgresSettings } from "./postgres-config.ts";
import { SOURCE_PROJECT_ID } from "./standalone-isolation.ts";

export const PILOT_CONTROL_IDS = [
  "aws-account-region-verified",
  "inera-test-agreement-approved",
  "siths-profile-claims-verified",
  "real-negative-tests-passed",
  "dpia-approved",
  "retention-approved",
  "pentest-approved",
  "alerting-drill-passed",
  "restore-rto-rpo-tested",
  "incident-response-approved",
  "legal-approval",
] as const;

export const REPLIT_PILOT_CONTROL_IDS = [
  "isolated-replit-project-geography-verified",
  "region-service-agreement-approved",
  ...PILOT_CONTROL_IDS.filter((id) =>
    id !== "aws-account-region-verified" && id !== "inera-test-agreement-approved"),
] as const;

export type PilotControlId = (typeof PILOT_CONTROL_IDS)[number] | (typeof REPLIT_PILOT_CONTROL_IDS)[number];

export interface ReadinessEvidenceApproval {
  controlId: string;
  status: "approved";
  evidenceId: string;
  owner: string;
  verifiedAt: string;
}

export interface ReadinessEvidenceManifest {
  version: 1;
  approvals: ReadinessEvidenceApproval[];
}

export interface BrokerConfig {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  basePath: string;
  devHarnessEnabled: boolean;
  oidcConfigured: boolean;
  oidcProfile: "generic" | "region-stockholm-test";
  oidcScopes: string[];
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcClientSecret: string | null;
  oidcRedirectUri: string | null;
  allowedMetadataOrigins: string[];
  minimumLoa: string;
  acceptedLoaValues: string[];
  hsaIdClaim: string;
  loaClaim: string;
  assignmentsClaim: string;
  sessionTtlMs: number;
  transactionTtlMs: number;
  storeBackend: "memory" | "dynamodb" | "postgres";
  postgres: PostgresSettings | null;
  bootstrapOnly: boolean;
  awsRegion: string | null;
  authTable: string | null;
  auditTable: string | null;
  authKmsKeyArn: string | null;
  auditHmacKeyArn: string | null;
  auditHmacVerifyKeyArns: string[];
  auditRetentionDays: number;
  readinessEvidenceManifest: ReadinessEvidenceManifest | null;
  missingPilotControlIds: PilotControlId[];
}

export function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    /%(?:2f|5c)/i.test(trimmed)
  ) {
    throw new Error("BASE_PATH must be a safe absolute pathname");
  }
  const segments = trimmed.split("/");
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("BASE_PATH contains invalid encoding");
    }
    if (decoded === "." || decoded === ".." || decoded.includes("\0")) {
      throw new Error("BASE_PATH must be a safe absolute pathname");
    }
  }
  const normalized = `/${segments.filter(Boolean).join("/")}`;
  return normalized === "/" ? "/" : `${normalized}/`;
}

export function apiPrefixForBasePath(basePath: string): string {
  return `${basePath === "/" ? "" : basePath.slice(0, -1)}/api/siths`;
}

export function isApiPrefixPath(pathname: string, apiPrefix: string): boolean {
  return pathname === apiPrefix || pathname.startsWith(`${apiPrefix}/`);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validateHttpsUrl(name: string, value: string | null, production: boolean) {
  if (!value) return;
  const parsed = new URL(value);
  const localhost =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && (production || !localhost)) {
    throw new Error(`${name} must use HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials`);
  }
}

function validateKmsKeyArn(name: string, value: string): void {
  if (!/^arn:[^:]+:kms:[^:]+:\d{12}:key\/[^\s,]+$/.test(value)) {
    throw new Error(`${name} must contain KMS key ARNs`);
  }
}

function parseAuditRetentionDays(
  value: string | undefined,
  production: boolean,
): number {
  if (value === undefined || value.trim() === "") {
    if (production) {
      throw new Error(
        "SITHS_AUDIT_RETENTION_DAYS is required in production",
      );
    }
    return 90;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
    throw new Error(
      "SITHS_AUDIT_RETENTION_DAYS must be an integer from 1 through 3650",
    );
  }
  return parsed;
}

function requiredManifestString(
  approval: Record<string, unknown>,
  field: "controlId" | "evidenceId" | "owner",
): string {
  const value = approval[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Readiness evidence approval ${field} must be non-empty`);
  }
  return value.trim();
}

function isValidIsoDate(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseReadinessEvidenceManifest(
  raw: string | undefined,
): ReadinessEvidenceManifest | null {
  if (raw === undefined || raw.trim() === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("SITHS_READINESS_EVIDENCE_MANIFEST must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Readiness evidence manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1 || !Array.isArray(manifest.approvals)) {
    throw new Error(
      "Readiness evidence manifest must be version 1 with approvals",
    );
  }
  const seen = new Set<string>();
  const approvals = manifest.approvals.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Readiness evidence approval must be an object");
    }
    const approval = candidate as Record<string, unknown>;
    const controlId = requiredManifestString(approval, "controlId");
    if (seen.has(controlId)) {
      throw new Error(`Duplicate readiness evidence controlId: ${controlId}`);
    }
    seen.add(controlId);
    if (approval.status !== "approved") {
      throw new Error("Readiness evidence approval status must be approved");
    }
    const verifiedAt = approval.verifiedAt;
    if (
      typeof verifiedAt !== "string" ||
      !isValidIsoDate(verifiedAt)
    ) {
      throw new Error(
        "Readiness evidence approval verifiedAt must be a valid ISO date",
      );
    }
    return {
      controlId,
      status: "approved" as const,
      evidenceId: requiredManifestString(approval, "evidenceId"),
      owner: requiredManifestString(approval, "owner"),
      verifiedAt,
    };
  });
  return { version: 1, approvals };
}

export function missingPilotControls(
  manifest: ReadinessEvidenceManifest | null,
  requiredControls: readonly PilotControlId[] = PILOT_CONTROL_IDS,
): PilotControlId[] {
  const approved = new Set(
    manifest?.approvals.map((approval) => approval.controlId) ?? [],
  );
  return requiredControls.filter((controlId) => !approved.has(controlId));
}

export function loadConfig(env = process.env, sourceProjectId = SOURCE_PROJECT_ID): BrokerConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";
  const rawStoreBackend =
    env.SITHS_STORE_BACKEND?.trim() || (isProduction ? "" : "memory");
  if (rawStoreBackend && !["memory", "dynamodb", "postgres"].includes(rawStoreBackend)) {
    throw new Error("SITHS_STORE_BACKEND must be memory, dynamodb or postgres");
  }
  const storeBackend = rawStoreBackend as BrokerConfig["storeBackend"];
  const postgres = storeBackend === "postgres" ? loadPostgresSettings(env, sourceProjectId) : null;
  const bootstrapOnly = env.SITHS_BOOTSTRAP_ONLY === "true";
  if (bootstrapOnly && (!isProduction || storeBackend !== "postgres")) {
    throw new Error("Bootstrap-only mode is restricted to the separate Replit production environment");
  }
  const awsRegion = env.SITHS_AWS_REGION?.trim() || null;
  const authTable = env.SITHS_AUTH_TABLE?.trim() || null;
  const auditTable = env.SITHS_AUDIT_TABLE?.trim() || null;
  const authKmsKeyArn = env.SITHS_AUTH_KMS_KEY_ARN?.trim() || null;
  const auditHmacKeyArn = env.SITHS_AUDIT_HMAC_KEY_ARN?.trim() || null;
  const auditHmacVerifyKeyArns = [
    ...new Set([
      ...(auditHmacKeyArn ? [auditHmacKeyArn] : []),
      ...(env.SITHS_AUDIT_HMAC_VERIFY_KEY_ARNS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ]),
  ];
  if (authKmsKeyArn) validateKmsKeyArn("SITHS_AUTH_KMS_KEY_ARN", authKmsKeyArn);
  if (auditHmacKeyArn) {
    validateKmsKeyArn("SITHS_AUDIT_HMAC_KEY_ARN", auditHmacKeyArn);
  }
  for (const keyArn of auditHmacVerifyKeyArns) {
    validateKmsKeyArn("SITHS_AUDIT_HMAC_VERIFY_KEY_ARNS", keyArn);
  }
  if (
    isProduction && storeBackend !== "postgres" &&
    (storeBackend !== "dynamodb" ||
      awsRegion !== "eu-north-1" ||
      !authTable ||
      !auditTable ||
      !authKmsKeyArn ||
      !auditHmacKeyArn)
  ) {
    throw new Error(
      "Production storage is fail-closed: DynamoDB in eu-north-1 and all SITHS table/KMS settings are required",
    );
  }
  if (
    storeBackend === "dynamodb" &&
    (!awsRegion ||
      !authTable ||
      !auditTable ||
      !authKmsKeyArn ||
      !auditHmacKeyArn)
  ) {
    throw new Error("DynamoDB storage configuration is incomplete");
  }
  const rawPort = env.PORT;
  if (!rawPort) throw new Error("PORT is required");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }
  const basePath = normalizeBasePath(
    env.BASE_PATH || "/siths-care-poc/",
  );
  const apiPrefix = apiPrefixForBasePath(basePath);

  const oidcIssuer = env.SITHS_OIDC_ISSUER?.trim() || null;
  const oidcClientId = env.SITHS_OIDC_CLIENT_ID?.trim() || null;
  const oidcRedirectUri = env.SITHS_OIDC_REDIRECT_URI?.trim() || null;
  const oidcClientSecret = env.SITHS_OIDC_CLIENT_SECRET?.trim() || null;
  const oidcProfile = env.SITHS_OIDC_PROFILE?.trim() || "generic";
  if (oidcProfile !== "generic" && oidcProfile !== "region-stockholm-test") {
    throw new Error("Unknown SITHS_OIDC_PROFILE");
  }
  const oidcScopes = [...new Set(
    (env.SITHS_OIDC_SCOPES ?? "openid").trim().split(/\s+/).filter(Boolean),
  )];
  if (
    !oidcScopes.includes("openid") ||
    oidcScopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))
  ) {
    throw new Error("SITHS_OIDC_SCOPES must include openid and contain valid scope tokens");
  }
  const requiredOidcValues = [oidcIssuer, oidcClientId, oidcRedirectUri];
  const oidcConfigured = requiredOidcValues.every(Boolean);
  const partiallyConfigured = requiredOidcValues.some(Boolean) && !oidcConfigured;

  if (partiallyConfigured) {
    throw new Error(
      "SITHS OIDC configuration is incomplete: issuer, client ID and redirect URI are all required",
    );
  }
  if (bootstrapOnly && [oidcIssuer, oidcClientId, oidcRedirectUri, oidcClientSecret].some(Boolean)) {
    throw new Error("Bootstrap-only mode must not contain OIDC registration settings");
  }
  if (isProduction && !oidcConfigured && !bootstrapOnly) {
    throw new Error(
      "Production is fail-closed until SITHS OIDC issuer, client ID and redirect URI are configured",
    );
  }

  validateHttpsUrl("SITHS_OIDC_ISSUER", oidcIssuer, isProduction);
  validateHttpsUrl("SITHS_OIDC_REDIRECT_URI", oidcRedirectUri, isProduction);
  if (isProduction && oidcRedirectUri) {
    const redirect = new URL(oidcRedirectUri);
    if (
      redirect.pathname !== `${apiPrefix}/callback` ||
      oidcRedirectUri.includes("?") ||
      oidcRedirectUri.includes("#")
    ) {
      throw new Error(
        "SITHS_OIDC_REDIRECT_URI must exactly match the artifact callback path without query or fragment",
      );
    }
  }
  const issuerOrigin = oidcIssuer ? new URL(oidcIssuer).origin : null;
  const allowedMetadataOrigins = (
    env.SITHS_OIDC_ALLOWED_METADATA_ORIGINS ?? issuerOrigin ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:") {
        throw new Error("OIDC metadata origins must use HTTPS");
      }
      return parsed.origin;
    });

  if (oidcProfile === "region-stockholm-test" && !bootstrapOnly) {
    if (oidcIssuer !== "https://federation-acc.sll.se/adfs") {
      throw new Error("Region Stockholm test profile requires its exact test issuer");
    }
    if (
      allowedMetadataOrigins.length === 0 ||
      allowedMetadataOrigins.some((origin) => origin !== "https://federation-acc.sll.se")
    ) {
      throw new Error("Region Stockholm test metadata must remain on its approved IdP origin");
    }
    for (const name of [
      "SITHS_OIDC_HSA_ID_CLAIM",
      "SITHS_OIDC_LOA_CLAIM",
      "SITHS_OIDC_ACCEPTED_LOA_VALUES",
      "SITHS_OIDC_ASSIGNMENTS_CLAIM",
    ]) {
      if (!env[name]?.trim()) {
        throw new Error(`Region Stockholm test requires an explicitly agreed ${name}`);
      }
    }
  }

  const minimumLoa = env.SITHS_OIDC_MIN_LOA?.trim() || "loa3";
  const acceptedLoaValues = (
    env.SITHS_OIDC_ACCEPTED_LOA_VALUES ?? minimumLoa
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (acceptedLoaValues.length === 0) {
    throw new Error("At least one accepted LoA value is required");
  }

  const sessionTtlMinutes = Math.min(
    positiveInteger(env.SITHS_SESSION_TTL_MINUTES, 15),
    30,
  );
  const readinessEvidenceManifest = parseReadinessEvidenceManifest(
    env.SITHS_READINESS_EVIDENCE_MANIFEST,
  );

  return {
    nodeEnv,
    isProduction,
    port,
    basePath,
    devHarnessEnabled:
      !isProduction && oidcProfile === "generic"
        && env.SITHS_DEV_HARNESS?.toLowerCase() !== "false",
    oidcConfigured,
    oidcProfile,
    oidcScopes,
    oidcIssuer,
    oidcClientId,
    oidcClientSecret,
    oidcRedirectUri,
    allowedMetadataOrigins,
    minimumLoa,
    acceptedLoaValues,
    hsaIdClaim: env.SITHS_OIDC_HSA_ID_CLAIM?.trim() || "hsa_id",
    loaClaim: env.SITHS_OIDC_LOA_CLAIM?.trim() || "acr",
    assignmentsClaim:
      env.SITHS_OIDC_ASSIGNMENTS_CLAIM?.trim() || "employee_assignments",
    sessionTtlMs: sessionTtlMinutes * 60_000,
    transactionTtlMs: 5 * 60_000,
    storeBackend,
    postgres,
    bootstrapOnly,
    awsRegion,
    authTable,
    auditTable,
    authKmsKeyArn,
    auditHmacKeyArn,
    auditHmacVerifyKeyArns,
    auditRetentionDays: parseAuditRetentionDays(
      env.SITHS_AUDIT_RETENTION_DAYS,
      isProduction,
    ),
    readinessEvidenceManifest,
    missingPilotControlIds: missingPilotControls(
      readinessEvidenceManifest,
      storeBackend === "postgres" ? REPLIT_PILOT_CONTROL_IDS : PILOT_CONTROL_IDS,
    ),
  };
}
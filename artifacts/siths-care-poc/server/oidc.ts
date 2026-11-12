import {
  constants,
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import type { BrokerConfig } from "./config.ts";
import { SecurityError } from "./security.ts";
import type { AuthStore } from "./store.ts";
import type {
  AuthTransaction,
  HealthcareAssignment,
  HealthcareIdentity,
  IdTokenVerificationContext,
  JwkSet,
  JsonValue,
  OidcDiscoveryDocument,
} from "./types.ts";

function base64UrlJson(value: string): Record<string, JsonValue> {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, JsonValue>;
  } catch {
    throw new SecurityError("TOKEN_MALFORMED");
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function requiredString(
  value: JsonValue | undefined,
  code: string,
  maxLength = 256,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new SecurityError(code);
  }
  return value.trim();
}

function optionalIsoDate(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new SecurityError("ASSIGNMENT_DATE_INVALID");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new SecurityError("ASSIGNMENT_DATE_INVALID");
  }
  return new Date(timestamp).toISOString();
}

function normalizeAssignments(
  value: JsonValue | undefined,
  now: number,
): HealthcareAssignment[] {
  if (!Array.isArray(value)) {
    throw new SecurityError("ASSIGNMENT_CLAIM_MISSING");
  }

  const assignments = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new SecurityError("ASSIGNMENT_CLAIM_INVALID");
    }
    const object = candidate as Record<string, JsonValue>;
    const assignment: HealthcareAssignment = {
      id: requiredString(object.id, "ASSIGNMENT_ID_MISSING", 128),
      careProviderId: requiredString(
        object.careProviderId,
        "CARE_PROVIDER_ID_MISSING",
        128,
      ),
      careProviderName: requiredString(
        object.careProviderName,
        "CARE_PROVIDER_NAME_MISSING",
        256,
      ),
      organizationalUnitId: requiredString(
        object.organizationalUnitId,
        "ORG_UNIT_ID_MISSING",
        128,
      ),
      organizationalUnitName: requiredString(
        object.organizationalUnitName,
        "ORG_UNIT_NAME_MISSING",
        256,
      ),
      purpose: requiredString(
        object.purpose,
        "ASSIGNMENT_PURPOSE_MISSING",
        256,
      ),
      startsAt: optionalIsoDate(object.startsAt),
      endsAt: optionalIsoDate(object.endsAt),
    };
    return assignment;
  });

  const active = assignments.filter((assignment) => {
    const startsAt = assignment.startsAt
      ? Date.parse(assignment.startsAt)
      : Number.NEGATIVE_INFINITY;
    const endsAt = assignment.endsAt
      ? Date.parse(assignment.endsAt)
      : Number.POSITIVE_INFINITY;
    return startsAt <= now && endsAt > now;
  });

  const unique = new Map<string, HealthcareAssignment>();
  for (const assignment of active) {
    if (unique.has(assignment.id)) {
      throw new SecurityError("ASSIGNMENT_ID_DUPLICATE");
    }
    unique.set(assignment.id, assignment);
  }
  if (unique.size === 0) {
    throw new SecurityError("ASSIGNMENT_REQUIRED");
  }
  return [...unique.values()];
}

function verifyJwtSignature(
  algorithm: string,
  key: KeyObject,
  signingInput: Buffer,
  signature: Buffer,
): boolean {
  if (algorithm === "RS256") {
    return verifySignature("sha256", signingInput, key, signature);
  }
  if (algorithm === "PS256") {
    return verifySignature(
      "sha256",
      signingInput,
      {
        key,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      signature,
    );
  }
  if (algorithm === "ES256") {
    return verifySignature(
      "sha256",
      signingInput,
      { key, dsaEncoding: "ieee-p1363" },
      signature,
    );
  }
  throw new SecurityError("TOKEN_ALGORITHM_REJECTED");
}

export class IdTokenVerifier {
  private readonly store: AuthStore;

  constructor(store: AuthStore) {
    this.store = store;
  }

  async verify(
    token: string,
    context: IdTokenVerificationContext,
  ): Promise<HealthcareIdentity> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new SecurityError("TOKEN_MALFORMED");
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [
      string,
      string,
      string,
    ];
    const header = base64UrlJson(encodedHeader);
    const claims = base64UrlJson(encodedPayload);
    const algorithm = requiredString(
      header.alg,
      "TOKEN_ALGORITHM_MISSING",
      16,
    );
    const keyId = requiredString(header.kid, "TOKEN_KEY_ID_MISSING", 256);
    if (!["RS256", "PS256", "ES256"].includes(algorithm)) {
      throw new SecurityError("TOKEN_ALGORITHM_REJECTED");
    }
    const jwk = context.jwks.keys.find(
      (candidate) =>
        candidate.kid === keyId &&
        (candidate.alg === undefined || candidate.alg === algorithm) &&
        (candidate.use === undefined || candidate.use === "sig"),
    );
    if (!jwk) throw new SecurityError("TOKEN_SIGNING_KEY_NOT_FOUND");

    let key: KeyObject;
    try {
      key = createPublicKey({
        key: jwk as JsonWebKey,
        format: "jwk",
      });
    } catch {
      throw new SecurityError("TOKEN_SIGNING_KEY_INVALID");
    }

    const validSignature = verifyJwtSignature(
      algorithm,
      key,
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      Buffer.from(encodedSignature, "base64url"),
    );
    if (!validSignature) throw new SecurityError("TOKEN_SIGNATURE_INVALID");

    const now = context.now ?? Date.now();
    const nowSeconds = Math.floor(now / 1000);
    const issuer = requiredString(claims.iss, "TOKEN_ISSUER_MISSING", 512);
    if (!safeEqual(issuer, context.issuer)) {
      throw new SecurityError("TOKEN_ISSUER_INVALID");
    }

    const audiences =
      typeof claims.aud === "string"
        ? [claims.aud]
        : Array.isArray(claims.aud) &&
            claims.aud.every((value) => typeof value === "string")
          ? (claims.aud as string[])
          : [];
    if (!audiences.some((audience) => safeEqual(audience, context.audience))) {
      throw new SecurityError("TOKEN_AUDIENCE_INVALID");
    }
    if (audiences.length > 1 && claims.azp !== context.audience) {
      throw new SecurityError("TOKEN_AUTHORIZED_PARTY_INVALID");
    }

    if (typeof claims.exp !== "number" || claims.exp < nowSeconds - 30) {
      throw new SecurityError("TOKEN_EXPIRED");
    }
    if (typeof claims.iat !== "number" || claims.iat > nowSeconds + 30) {
      throw new SecurityError("TOKEN_ISSUED_AT_INVALID");
    }
    if (nowSeconds - claims.iat > 10 * 60) {
      throw new SecurityError("TOKEN_TOO_OLD");
    }
    const nonce = requiredString(claims.nonce, "TOKEN_NONCE_MISSING", 256);
    if (!safeEqual(nonce, context.expectedNonce)) {
      throw new SecurityError("TOKEN_NONCE_INVALID");
    }

    const tokenHash = createHash("sha256").update(token).digest("base64url");
    const hsaId = requiredString(
      claims[context.hsaIdClaim],
      "HSA_ID_REQUIRED",
      128,
    );
    if (!/^[A-Za-z0-9._:-]{3,128}$/.test(hsaId)) {
      throw new SecurityError("HSA_ID_INVALID");
    }
    const loa = requiredString(
      claims[context.loaClaim],
      "LOA_REQUIRED",
      256,
    );
    if (
      !context.acceptedLoaValues.some((accepted) => safeEqual(loa, accepted))
    ) {
      throw new SecurityError("LOA_TOO_LOW");
    }

    const assignments = normalizeAssignments(
      claims[context.assignmentsClaim],
      now,
    );
    if (!(await this.store.claimTokenReplay(tokenHash, claims.exp, nowSeconds))) {
      throw new SecurityError("TOKEN_REPLAYED");
    }

    return {
      hsaId,
      loa,
      issuer,
      authenticatedAt: new Date(now).toISOString(),
      assignments,
    };
  }

}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) {
    throw new SecurityError(
      "OIDC_UPSTREAM_ERROR",
      "Identitetsutfärdaren svarade inte som förväntat.",
      502,
    );
  }
  return (await response.json()) as T;
}

function assertMetadataUrl(
  url: string,
  allowedOrigins: string[],
  name: string,
) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new SecurityError("OIDC_METADATA_INVALID");
  }
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new SecurityError(
      "OIDC_METADATA_ORIGIN_INVALID",
      `${name} has an unexpected origin`,
    );
  }
}

export class OidcClient {
  private discoveryCache:
    | { document: OidcDiscoveryDocument; expiresAt: number }
    | undefined;
  private jwksCache: { jwks: JwkSet; expiresAt: number } | undefined;
  private readonly config: BrokerConfig;
  private readonly verifier: IdTokenVerifier;

  constructor(config: BrokerConfig, verifier: IdTokenVerifier) {
    this.config = config;
    this.verifier = verifier;
  }

  async begin(
    returnPath: string,
    correlationId: string,
    browserBindingHash: string,
    now = Date.now(),
  ): Promise<{ transaction: AuthTransaction; authorizationUrl: string }> {
    this.assertConfigured();
    const discovery = await this.discovery();
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const pkceVerifier = randomBytes(48).toString("base64url");
    const pkceChallenge = createHash("sha256")
      .update(pkceVerifier)
      .digest("base64url");
    const transaction: AuthTransaction = {
      state,
      nonce,
      pkceVerifier,
      browserBindingHash,
      redirectUri: this.config.oidcRedirectUri!,
      returnPath,
      correlationId,
      expiresAt: now + this.config.transactionTtlMs,
    };
    const authorizationUrl = new URL(discovery.authorization_endpoint);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.oidcClientId!,
      redirect_uri: transaction.redirectUri,
      scope: this.config.oidcScopes.join(" "),
      state,
      nonce,
      code_challenge: pkceChallenge,
      code_challenge_method: "S256",
    }).toString();
    return { transaction, authorizationUrl: authorizationUrl.toString() };
  }

  async complete(
    code: string,
    transaction: AuthTransaction,
  ): Promise<HealthcareIdentity> {
    this.assertConfigured();
    const discovery = await this.discovery();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: transaction.redirectUri,
      client_id: this.config.oidcClientId!,
      code_verifier: transaction.pkceVerifier,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (this.config.oidcClientSecret) {
      const credentials = Buffer.from(
        `${this.config.oidcClientId}:${this.config.oidcClientSecret}`,
      ).toString("base64");
      headers.Authorization = `Basic ${credentials}`;
      body.delete("client_id");
    }
    const tokenResponse = await fetchJson<Record<string, JsonValue>>(
      discovery.token_endpoint,
      { method: "POST", headers, body },
    );
    if (typeof tokenResponse.id_token !== "string") {
      throw new SecurityError("ID_TOKEN_MISSING");
    }
    const jwks = await this.jwks(discovery);
    return await this.verifier.verify(tokenResponse.id_token, {
      issuer: this.config.oidcIssuer!,
      audience: this.config.oidcClientId!,
      expectedNonce: transaction.nonce,
      jwks,
      acceptedLoaValues: this.config.acceptedLoaValues,
      hsaIdClaim: this.config.hsaIdClaim,
      loaClaim: this.config.loaClaim,
      assignmentsClaim: this.config.assignmentsClaim,
    });
  }

  private assertConfigured() {
    if (!this.config.oidcConfigured) {
      throw new SecurityError(
        "OIDC_NOT_CONFIGURED",
        "SITHS-brokern är inte konfigurerad.",
        503,
      );
    }
  }

  private async discovery(): Promise<OidcDiscoveryDocument> {
    if (this.discoveryCache && this.discoveryCache.expiresAt > Date.now()) {
      return this.discoveryCache.document;
    }
    const issuer = this.config.oidcIssuer!;
    const url = new URL(
      `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    );
    const document = await fetchJson<OidcDiscoveryDocument>(url.toString());
    if (document.issuer !== issuer) {
      throw new SecurityError("OIDC_DISCOVERY_ISSUER_INVALID");
    }
    assertMetadataUrl(
      document.authorization_endpoint,
      this.config.allowedMetadataOrigins,
      "authorization",
    );
    assertMetadataUrl(
      document.token_endpoint,
      this.config.allowedMetadataOrigins,
      "token",
    );
    assertMetadataUrl(
      document.jwks_uri,
      this.config.allowedMetadataOrigins,
      "jwks",
    );
    this.discoveryCache = {
      document,
      expiresAt: Date.now() + 5 * 60_000,
    };
    return document;
  }

  private async jwks(discovery: OidcDiscoveryDocument): Promise<JwkSet> {
    if (this.jwksCache && this.jwksCache.expiresAt > Date.now()) {
      return this.jwksCache.jwks;
    }
    const jwks = await fetchJson<JwkSet>(discovery.jwks_uri);
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      throw new SecurityError("OIDC_JWKS_INVALID");
    }
    this.jwksCache = { jwks, expiresAt: Date.now() + 5 * 60_000 };
    return jwks;
  }
}
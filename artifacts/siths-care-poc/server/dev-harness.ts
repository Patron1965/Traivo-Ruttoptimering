import {
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { SecurityError } from "./security.ts";
import { IdTokenVerifier } from "./oidc.ts";
import type {
  DevScenario,
  HealthcareIdentity,
  JwkSet,
  JsonValue,
} from "./types.ts";

const SYNTHETIC_ISSUER = "https://synthetic-idp.invalid";
const SYNTHETIC_AUDIENCE = "siths-care-poc";
const KEY_ID = "synthetic-poc-key";

function encodeJson(value: Record<string, JsonValue>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export class DevIdentityHarness {
  private readonly privateKey;
  private readonly jwks: JwkSet;
  private readonly verifier: IdTokenVerifier;

  constructor(verifier: IdTokenVerifier) {
    this.verifier = verifier;
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    const publicJwk = pair.publicKey.export({ format: "jwk" });
    this.jwks = {
      keys: [
        {
          ...(publicJwk as Record<string, JsonValue>),
          kid: KEY_ID,
          alg: "RS256",
          use: "sig",
        },
      ],
    };
  }

  async run(
    scenario: DevScenario,
    now = Date.now(),
  ): Promise<HealthcareIdentity> {
    const expectedNonce = randomBytes(24).toString("base64url");
    const token = this.tokenForScenario(scenario, expectedNonce, now);
    const context = {
      issuer: SYNTHETIC_ISSUER,
      audience: SYNTHETIC_AUDIENCE,
      expectedNonce,
      jwks: this.jwks,
      acceptedLoaValues: ["loa3"],
      hsaIdClaim: "hsa_id",
      loaClaim: "acr",
      assignmentsClaim: "employee_assignments",
      now,
    };
    if (scenario === "replay") {
      await this.verifier.verify(token, context);
      return await this.verifier.verify(token, context);
    }
    return await this.verifier.verify(token, context);
  }

  private tokenForScenario(
    scenario: DevScenario,
    expectedNonce: string,
    now: number,
  ): string {
    const nowSeconds = Math.floor(now / 1000);
    const assignment = {
      id: "assignment-home-care",
      careProviderId: "SE-SYNTHETIC-CARE-01",
      careProviderName: "Syntetisk vårdgivare",
      organizationalUnitId: "SE-SYNTHETIC-UNIT-01",
      organizationalUnitName: "Testenhet hemsjukvård",
      purpose: "Vård och behandling – syntetiskt test",
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
    };
    const secondAssignment = {
      ...assignment,
      id: "assignment-evening-team",
      organizationalUnitId: "SE-SYNTHETIC-UNIT-02",
      organizationalUnitName: "Testenhet kvällsteam",
    };
    const claims: Record<string, JsonValue> = {
      iss:
        scenario === "wrong_issuer"
          ? "https://attacker.invalid"
          : SYNTHETIC_ISSUER,
      aud:
        scenario === "wrong_audience"
          ? "different-client"
          : SYNTHETIC_AUDIENCE,
      sub: "synthetic-subject",
      exp: scenario === "expired" ? nowSeconds - 300 : nowSeconds + 300,
      iat: nowSeconds,
      nonce:
        scenario === "wrong_nonce"
          ? "unexpected-nonce"
          : expectedNonce,
      jti: randomUUID(),
      acr: scenario === "low_loa" ? "loa2" : "loa3",
      hsa_id:
        scenario === "missing_hsa_id"
          ? null
          : "SE-SYNTHETIC-HSA-0001",
      employee_assignments:
        scenario === "missing_assignment"
          ? []
          : scenario === "valid_multiple_assignments"
            ? [assignment, secondAssignment]
            : [assignment],
    };
    const header = encodeJson({ alg: "RS256", typ: "JWT", kid: KEY_ID });
    const payload = encodeJson(claims);
    const signingInput = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput)
      .sign(this.privateKey)
      .toString("base64url");
    const token = `${signingInput}.${signature}`;
    if (scenario !== "tampered_signature") return token;
    const tamperedSignature = Buffer.from(signature, "base64url");
    tamperedSignature[0] = tamperedSignature[0]! ^ 1;
    return `${signingInput}.${tamperedSignature.toString("base64url")}`;
  }
}

export const DEV_SCENARIOS: readonly DevScenario[] = [
  "valid",
  "valid_multiple_assignments",
  "tampered_signature",
  "wrong_issuer",
  "wrong_audience",
  "wrong_nonce",
  "replay",
  "expired",
  "low_loa",
  "missing_hsa_id",
  "missing_assignment",
];

export function parseDevScenario(value: unknown): DevScenario {
  if (
    typeof value !== "string" ||
    !DEV_SCENARIOS.includes(value as DevScenario)
  ) {
    throw new SecurityError("DEV_SCENARIO_INVALID", "Ogiltigt testscenario.", 400);
  }
  return value as DevScenario;
}
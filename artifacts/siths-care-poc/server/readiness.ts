import type { BrokerConfig } from "./config.ts";
import type { StoreProbe } from "./store.ts";

export interface ReadinessAssessment {
  ready: boolean;
  blockers: string[];
}

export function assessHealth(
  config: Pick<
    BrokerConfig,
    | "isProduction"
    | "oidcConfigured"
    | "storeBackend"
    | "awsRegion"
    | "authTable"
    | "auditTable"
    | "authKmsKeyArn"
    | "auditHmacKeyArn"
    | "postgres"
    | "bootstrapOnly"
  >,
  storageProbe: StoreProbe,
): boolean {
  if (!storageProbe.ok) return false;
  if (!config.isProduction) return true;
  if (config.storeBackend === "postgres") {
    return (
      (config.oidcConfigured || config.bootstrapOnly) &&
      Boolean(config.postgres) &&
      storageProbe.backend === "postgres"
    );
  }
  return (
    config.oidcConfigured &&
    config.storeBackend === "dynamodb" &&
    config.awsRegion === "eu-north-1" &&
    storageProbe.backend === "dynamodb" &&
    storageProbe.region === "eu-north-1" &&
    Boolean(
      config.authTable &&
        config.auditTable &&
        config.authKmsKeyArn &&
        config.auditHmacKeyArn,
    )
  );
}

export function assessReadiness(
  config: Pick<
    BrokerConfig,
    | "isProduction"
    | "storeBackend"
    | "oidcConfigured"
    | "missingPilotControlIds"
  >,
  storageProbe: StoreProbe,
): ReadinessAssessment {
  if (config.isProduction) {
    return {
      ready:
        storageProbe.ok &&
        config.oidcConfigured &&
        config.missingPilotControlIds.length === 0,
      // Production responses intentionally expose only machine-readable IDs.
      blockers: [...config.missingPilotControlIds],
    };
  }

  const blockers: string[] = [];
  if (!storageProbe.ok) {
    blockers.push("Den tekniska lagringsproben misslyckades.");
  }
  if (config.storeBackend === "memory") {
    blockers.push(
      "In-memory-lagring är endast avsedd för utveckling och test.",
    );
  }
  if (!config.oidcConfigured) {
    blockers.push(
      "Extern OIDC-konfiguration saknas; endast syntetisk utvecklingsharness är tillgänglig.",
    );
  }
  blockers.push(
    "Inera-testavtal, verifierade claims och godkänd driftmiljö krävs före pilot.",
  );
  return { ready: storageProbe.ok, blockers };
}

/**
 * Production pilots may only process healthcare identity data once the
 * evidence-backed readiness gate is green. Development remains usable for the
 * synthetic harness while still exposing its readiness blockers separately.
 */
export function assessPilotRouteAccess(
  config: Pick<
    BrokerConfig,
    | "isProduction"
    | "storeBackend"
    | "oidcConfigured"
    | "missingPilotControlIds"
  >,
  storageProbe: StoreProbe,
): ReadinessAssessment {
  if (!config.isProduction) {
    return { ready: true, blockers: [] };
  }
  return assessReadiness(config, storageProbe);
}
import { AsyncLocalStorage } from "node:async_hooks";
import { operationalProviderConfigured, operationalProviderKind } from "./operational-provider-config";
import { OrganizationServicePolicyError } from "./organization-service-policy";

const policy = new AsyncLocalStorage<boolean>();

export class RoadDataUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "ROAD_DATA_UNAVAILABLE";
  constructor() {
    super("Verifierade vägdata saknas för hela resan. Planen har inte ändrats. Försök igen när vägdatatjänsten fungerar.");
    this.name = "RoadDataUnavailableError";
  }
}

export function withRequiredRoadData<T>(operation: () => T): T {
  return policy.run(true, operation);
}

export function requiresRoadData(): boolean {
  return policy.getStore() === true;
}

export function assertOperationalRoadProvider(): void {
  if (operationalProviderKind() === "disabled") throw new OrganizationServicePolicyError();
  if ((process.env.NODE_ENV === "production" || operationalProviderKind() !== "osrm") &&
      !operationalProviderConfigured()) {
    throw new RoadDataUnavailableError();
  }
}

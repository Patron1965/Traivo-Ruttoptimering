import { eq } from "drizzle-orm";
import { db, organizationServicePoliciesTable } from "@workspace/db";
import { getUsageContext, runWithUsageContext } from "./usage-context";

export interface OrganizationServicePolicy {
  roadProvider: "inherit" | "disabled" | "osrm" | "geoapify";
  geocodingProvider: "inherit" | "disabled" | "google" | "nominatim";
  smsProvider: "inherit" | "disabled" | "linkmobility" | "twilio" | "46elks";
  emailEnabled: boolean;
  aiEnabled: boolean;
  cuoptEnabled: boolean;
  districtEnabled: boolean;
}

export const DEFAULT_ORGANIZATION_SERVICE_POLICY: Readonly<OrganizationServicePolicy> = Object.freeze({
  roadProvider: "inherit", geocodingProvider: "inherit", smsProvider: "inherit",
  emailEnabled: true, aiEnabled: true, cuoptEnabled: true, districtEnabled: false,
});

export class OrganizationServicePolicyError extends Error {
  constructor(
    message = "Tjänsten är avstängd för organisationen.",
    readonly code = "ORGANIZATION_SERVICE_DISABLED",
    readonly statusCode = 403,
  ) { super(message); this.name = "OrganizationServicePolicyError"; }
}

/** No process/global cache: a new request or outbound send sees current policy.
 * Missing rows preserve other services; districts require explicit opt-in.
 * Failed reads NEVER mean inherit.
 */
export async function loadOrganizationServicePolicy(
  organizationId: string,
  database: Pick<typeof db, "select"> = db,
): Promise<Readonly<OrganizationServicePolicy>> {
  try {
    if (!organizationId) throw new Error("Missing organization");
    const [row] = await database.select({ policy: organizationServicePoliciesTable.policy })
      .from(organizationServicePoliciesTable)
      .where(eq(organizationServicePoliciesTable.organizationId, organizationId)).limit(1);
    if (!row) return DEFAULT_ORGANIZATION_SERVICE_POLICY;
    const policy = row.policy;
    if (!policy ||
        !["inherit", "disabled", "osrm", "geoapify"].includes(policy.roadProvider) ||
        !["inherit", "disabled", "google", "nominatim"].includes(policy.geocodingProvider) ||
        !["inherit", "disabled", "linkmobility", "twilio", "46elks"].includes(policy.smsProvider) ||
        !["emailEnabled", "aiEnabled", "cuoptEnabled", "districtEnabled"].every(key =>
          typeof policy[key as keyof OrganizationServicePolicy] === "boolean")) {
      throw new Error("Invalid policy");
    }
    return Object.freeze({ ...policy });
  } catch {
    throw new OrganizationServicePolicyError(
      "Organisationens tjänstepolicy kunde inte läsas. Inga externa tjänster har anropats.",
      "ORGANIZATION_SERVICE_POLICY_UNAVAILABLE", 503,
    );
  }
}

/** Synchronous consumers may only use an already-authorized snapshot. */
export function currentOrganizationServicePolicy(): Readonly<OrganizationServicePolicy> {
  const context = getUsageContext();
  if (!context) return DEFAULT_ORGANIZATION_SERVICE_POLICY;
  if (!context.servicePolicy) {
    throw new OrganizationServicePolicyError(
      "Organisationens tjänstepolicy har inte lästs.",
      "ORGANIZATION_SERVICE_POLICY_UNAVAILABLE", 503,
    );
  }
  return context.servicePolicy;
}

/** Background callers with an explicit tenant must not inherit another tenant. */
export async function withOrganizationServicePolicy<T>(organizationId: string, operation: () => T): Promise<Awaited<T>> {
  const servicePolicy = await loadOrganizationServicePolicy(organizationId);
  const existing = getUsageContext();
  return await runWithUsageContext({
    organizationId, servicePolicy,
    ...(existing?.organizationId === organizationId ? { jobId: existing.jobId } : {}),
  }, operation);
}

export async function ensureOrganizationServicePolicy(): Promise<Readonly<OrganizationServicePolicy>> {
  const context = getUsageContext();
  if (context && !context.servicePolicy) {
    context.servicePolicy = await loadOrganizationServicePolicy(context.organizationId);
  }
  return currentOrganizationServicePolicy();
}

export function servicePolicyCachePartition(): string {
  const context = getUsageContext();
  return context ? `${context.organizationId}:${JSON.stringify(currentOrganizationServicePolicy())}` : "unscoped";
}

export async function assertOrganizationServiceEnabled(
  service: "emailEnabled" | "aiEnabled" | "cuoptEnabled" | "districtEnabled",
  organizationId?: string,
): Promise<void> {
  const policy = organizationId
    ? await loadOrganizationServicePolicy(organizationId)
    : await ensureOrganizationServicePolicy();
  if (!policy[service]) throw new OrganizationServicePolicyError();
}

export async function assertOrganizationDistrictAllowed(organizationId: string, database: Pick<typeof db, "select"> = db): Promise<void> {
  const policy = await loadOrganizationServicePolicy(organizationId, database);
  // Districts have a separate provider assignment; operational road selection
  // is deliberately independent of district permission.
  if (!policy.districtEnabled) throw new OrganizationServicePolicyError();
}

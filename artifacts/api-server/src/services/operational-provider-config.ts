import { createHash } from "node:crypto";
import { currentOrganizationServicePolicy, servicePolicyCachePartition, type OrganizationServicePolicy } from "./organization-service-policy";

/** Explicit selection: adding a credential must never silently switch providers. */
export function operationalProviderKind(selected: OrganizationServicePolicy["roadProvider"] = currentOrganizationServicePolicy().roadProvider): string {
  return selected === "inherit" ? process.env.OPERATIONAL_ROAD_PROVIDER ?? "osrm" : selected;
}

export function operationalProviderConfigured(selected: OrganizationServicePolicy["roadProvider"] = currentOrganizationServicePolicy().roadProvider): boolean {
  if (operationalProviderKind(selected) === "geoapify") return !!process.env.GEOAPIFY_API_KEY?.trim();
  if (operationalProviderKind(selected) !== "osrm" || !process.env.OSRM_BASE_URL?.trim()) return false;
  try {
    const url = new URL(process.env.OSRM_BASE_URL);
    return !url.username && !url.password && !url.search && !url.hash &&
      ["https:", ...(process.env.NODE_ENV === "production" ? [] : ["http:"])].includes(url.protocol) &&
      !/(^|\.)router\.project-osrm\.org$/i.test(url.hostname);
  } catch { return false; }
}

let previousIdentity = "", previousHash = "";
export function operationalProviderCacheKey(): string {
  const identity = JSON.stringify([
    servicePolicyCachePartition(),
    operationalProviderKind(),
    operationalProviderKind() === "geoapify" ? "geoapify:v1:drive:free_flow:metric" : process.env.OSRM_BASE_URL ?? "development-demo",
  ]);
  if (identity !== previousIdentity) {
    previousHash = createHash("sha256").update(identity).digest("hex");
    previousIdentity = identity;
  }
  return previousHash;
}

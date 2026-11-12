/** The pilot's Region Stockholm tenant. Names/domains are not identity boundaries. */
export const REGION_STOCKHOLM_TENANT_ID = "63e7175d-af1d-4dc3-be62-842a8b3dc9f8";

export function customerLoginSettings(organizationId: string, preferred?: "password" | "siths") {
  return {
    sithsEligible: organizationId === REGION_STOCKHOLM_TENANT_ID,
    activeLoginService: "password" as const,
    loginConnectionStatus: preferred === "siths" ? "not_configured" as const : "active" as const,
  };
}

export function validateLoginPreference(organizationId: string, preferred?: "password" | "siths"): string | null {
  return preferred === "siths" && !customerLoginSettings(organizationId).sithsEligible
    ? "SITHS-kopplingen är endast tillgänglig för Region Stockholm."
    : null;
}

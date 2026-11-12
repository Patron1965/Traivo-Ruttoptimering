import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, organizationsTable, organizationServicePoliciesTable, auditLogTable, type OrganizationServicePolicy } from "@workspace/db";
import { requirePlatformAdmin } from "../middleware/auth";
import { DEFAULT_ORGANIZATION_SERVICE_POLICY } from "../services/organization-service-policy";
import { isAutomaticLinkSmsConfigured } from "../services/link-sms";
import { customerLoginSettings, validateLoginPreference } from "../services/organization-login-preference";

const router: IRouter = Router();
const defaults = DEFAULT_ORGANIZATION_SERVICE_POLICY;
const policySchema = z.object({
  preferredLoginService: z.enum(["password", "siths"]).optional(),
  roadProvider: z.enum(["inherit", "disabled", "osrm", "geoapify"]),
  geocodingProvider: z.enum(["inherit", "disabled", "google", "nominatim"]),
  smsProvider: z.enum(["inherit", "disabled", "linkmobility", "twilio", "46elks"]),
  emailEnabled: z.boolean(), aiEnabled: z.boolean(), cuoptEnabled: z.boolean(), districtEnabled: z.boolean(),
}).strict();
const inputSchema = z.object({ revision: z.number().int().min(0), policy: policySchema }).strict();

export function validateCustomerServiceProviders(policy: OrganizationServicePolicy): string | null {
  const has = (...keys: string[]) => keys.every(key => !!process.env[key]?.trim());
  if (policy.roadProvider === "geoapify" && !has("GEOAPIFY_API_KEY")) return "Geoapify saknar API-nyckel.";
  if (policy.roadProvider === "osrm") {
    try {
      const url = new URL(process.env.OSRM_BASE_URL ?? "");
      if (url.username || url.password || url.search || url.hash ||
          !["https:", ...(process.env.NODE_ENV === "production" ? [] : ["http:"])].includes(url.protocol) ||
          /(^|\.)router\.project-osrm\.org$/i.test(url.hostname)) throw new Error();
    } catch { return "En godkänd OSRM-server måste konfigureras först."; }
  }
  if (policy.geocodingProvider === "google" && !has("GOOGLE_MAPS_API_KEY")) return "Google Maps saknar API-nyckel.";
  const smsKeys = {
    twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
    "46elks": ["ELKS_API_USERNAME", "ELKS_API_PASSWORD"],
  };
  if (policy.smsProvider === "linkmobility" && !isAutomaticLinkSmsConfigured()) {
    return "LINK Mobility saknar Common API-uppgifter eller giltigt avsändarnamn.";
  }
  if (policy.smsProvider in smsKeys && !has(...smsKeys[policy.smsProvider as keyof typeof smsKeys])) {
    return "Vald SMS-leverantör saknar nödvändig åtkomst eller avsändare.";
  }
  return null;
}

router.use("/platform/organizations/:organizationId/services", requirePlatformAdmin());
router.get("/platform/organizations/:organizationId/services", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = z.guid().safeParse(req.params.organizationId);
  if (!parsed.success) { res.status(400).json({ error: "Ogiltigt företags-ID." }); return; }
  const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable).where(eq(organizationsTable.id, parsed.data));
  if (!org) { res.status(404).json({ error: "Företaget finns inte." }); return; }
  const [stored] = await db.select().from(organizationServicePoliciesTable).where(eq(organizationServicePoliciesTable.organizationId, org.id));
  const policy = { preferredLoginService: "password" as const, ...(stored?.policy ?? defaults) };
  res.json({ organizationId: org.id, revision: stored?.revision ?? 0, policy,
    ...customerLoginSettings(org.id, policy.preferredLoginService) });
});

router.put("/platform/organizations/:organizationId/services", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const id = z.guid().safeParse(req.params.organizationId);
  const input = inputSchema.safeParse(req.body);
  if (!id.success || !input.success) { res.status(400).json({ error: "Ogiltiga tjänsteinställningar." }); return; }
  const loginError = validateLoginPreference(id.data, input.data.policy.preferredLoginService);
  if (loginError) { res.status(400).json({ error: loginError }); return; }
  const configurationError = validateCustomerServiceProviders(input.data.policy);
  if (configurationError) { res.status(400).json({ error: configurationError }); return; }
  const result = await db.transaction(async tx => {
    // Lock the organization as well: concurrent first-time saves have no policy row to lock.
    const [org] = await tx.select({ id: organizationsTable.id }).from(organizationsTable)
      .where(eq(organizationsTable.id, id.data)).for("update");
    if (!org) return { status: 404 as const };
    const [old] = await tx.select().from(organizationServicePoliciesTable)
      .where(eq(organizationServicePoliciesTable.organizationId, org.id));
    if ((old?.revision ?? 0) !== input.data.revision) return { status: 409 as const };
    // Older clients omit the preference. A service edit must not reset it.
    const policy = { ...input.data.policy,
      preferredLoginService: input.data.policy.preferredLoginService ?? old?.policy.preferredLoginService ?? "password" as const };
    const revision = input.data.revision + 1;
    await tx.insert(organizationServicePoliciesTable).values({ organizationId: org.id, policy, revision })
      .onConflictDoUpdate({ target: organizationServicePoliciesTable.organizationId,
        set: { policy, revision, updatedAt: new Date() } });
    await tx.insert(auditLogTable).values({
      organizationId: org.id, userId: req.user!.id, action: "platform.organization.services.update",
      resourceType: "organization", resourceId: org.id, method: "PUT", path: req.path, statusCode: "200",
      diff: { servicePolicy: { from: old?.policy ?? defaults, to: policy } },
      metadata: { revision },
    });
    return { status: 200 as const, body: { organizationId: org.id, revision, policy,
      ...customerLoginSettings(org.id, policy.preferredLoginService) } };
  });
  if (result.status === 404) { res.status(404).json({ error: "Företaget finns inte." }); return; }
  if (result.status === 409) { res.status(409).json({ error: "Inställningarna har ändrats. Läs in aktuella inställningar före nytt sparande." }); return; }
  res.json(result.body);
});

export default router;

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, organizationRoutingProvidersTable, organizationsTable } from "@workspace/db";
import { createDistrictOsrmProvider, type DistrictRoadProvider } from "./district-solver";
import { selectDistrictProviderEnvironment } from "./district-provider-environment";
import { assertOrganizationDistrictAllowed } from "./organization-service-policy";

const SHARED_SERVER_ID = "shared";
const ENV_ERROR = "Traivos gemensamma vägdatatjänst är inte konfigurerad";

export interface RoutingProviderBinding {
  serverId: string;
  configurationVersion: string;
}

export interface RoutingCatalogServer {
  id: string;
  name: string;
  baseUrl: string;
  authTokenEnv?: string;
}

export interface RoutingServerStatus {
  id: string;
  name: string;
  configured: boolean;
  error?: string;
}

export interface RoutingConfigurationStatus {
  shared: RoutingServerStatus;
  dedicated: RoutingServerStatus[];
  catalogError?: string;
}

interface ResolvedServer extends RoutingCatalogServer {
  configurationVersion: string;
  headers?: Record<string, string>;
}

function isPublicDemo(url: URL): boolean {
  return url.hostname.toLowerCase() === "router.project-osrm.org" ||
    url.hostname.toLowerCase().endsWith(".router.project-osrm.org");
}

/** Validate operator-owned endpoints; never include the endpoint in validation errors. */
export function validateRoutingBaseUrl(raw: string, production = process.env.NODE_ENV === "production"): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Ogiltig serveradress.");
  }
  if (url.username || url.password || url.hash || url.search ||
      !["http:", "https:"].includes(url.protocol) ||
      (production && url.protocol !== "https:")) {
    throw new Error("Serveradressen måste vara giltig, utan inloggningsuppgifter eller fragment och använda HTTPS i produktion.");
  }
  if (isPublicDemo(url)) throw new Error("Den publika OSRM-demonstrationen får inte användas.");
  return url.toString().replace(/\/+$/, "");
}

function parseCatalog(): { servers: RoutingCatalogServer[]; error?: string } {
  const raw = process.env.ROUTING_SERVER_CATALOG_JSON;
  if (!raw) return { servers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { servers: [], error: "Operatörens routing-serverkatalog är ogiltig JSON." };
  }
  if (!Array.isArray(parsed)) return { servers: [], error: "Routing-serverkatalogen måste vara en lista." };
  const servers: RoutingCatalogServer[] = [];
  const seen = new Set<string>([SHARED_SERVER_ID]);
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { servers: [], error: "Routing-serverkatalogen innehåller en ogiltig post." };
    }
    const { id, name, baseUrl, authTokenEnv, ...extra } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) ||
        typeof name !== "string" || !name.trim() || name.length > 100 ||
        typeof baseUrl !== "string" || seen.has(id) || Object.keys(extra).length > 0 ||
        (authTokenEnv !== undefined && (typeof authTokenEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(authTokenEnv)))) {
      return { servers: [], error: "Routing-serverkatalogen innehåller en ogiltig eller duplicerad server." };
    }
    seen.add(id);
    try {
      servers.push({
        id, name: name.trim(), baseUrl: validateRoutingBaseUrl(baseUrl),
        ...(authTokenEnv === undefined ? {} : { authTokenEnv }),
      });
    } catch (error) {
      return { servers: [], error: error instanceof Error ? error.message : "Serverkonfigurationen är ogiltig." };
    }
  }
  return { servers };
}

function configurationVersion(organizationId: string, server: RoutingCatalogServer): string {
  // Bind versions to the tenant scope as well as stable endpoint/profile config,
  // so a binding copied from another organization cannot select its provider.
  return createHash("sha256")
    .update(JSON.stringify({
      organizationId, id: server.id, baseUrl: server.baseUrl,
      authTokenEnv: server.authTokenEnv ?? (server.id === SHARED_SERVER_ID ? "OSRM_AUTH_TOKEN" : null),
      profile: "driving",
    }))
    .digest("hex");
}

function bearerHeaders(token: string | undefined, required: boolean): Record<string, string> | undefined {
  if (!token && required) throw new Error("En routing-server kräver en token som inte är konfigurerad.");
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

function resolveShared(organizationId: string): ResolvedServer {
  const selected = selectDistrictProviderEnvironment();
  if (!selected) throw new Error(ENV_ERROR);
  let baseUrl: string;
  try {
    baseUrl = validateRoutingBaseUrl(selected.baseUrl);
  } catch {
    throw new Error("Traivos gemensamma vägdatatjänst har en ogiltig konfiguration.");
  }
  const server = {
    id: SHARED_SERVER_ID, name: "Traivos gemensamma vägdatatjänst", baseUrl,
    authTokenEnv: selected.authTokenEnv,
  };
  return {
    ...server,
    headers: bearerHeaders(selected.token, selected.requiresAuth),
    configurationVersion: configurationVersion(organizationId, server),
  };
}

function resolveDedicated(organizationId: string, serverId: string): ResolvedServer {
  const catalog = parseCatalog();
  if (catalog.error) throw new Error(catalog.error);
  const server = catalog.servers.find((candidate) => candidate.id === serverId);
  if (!server) throw new Error("Den valda routing-servern är inte konfigurerad av operatören.");
  const token = server.authTokenEnv ? process.env[server.authTokenEnv] : undefined;
  return {
    ...server,
    headers: bearerHeaders(token, !!server.authTokenEnv),
    configurationVersion: configurationVersion(organizationId, server),
  };
}

export function getRoutingConfigurationStatus(): RoutingConfigurationStatus {
  let shared: RoutingServerStatus;
  try {
    const configured = !!selectDistrictProviderEnvironment();
    if (configured) resolveShared("");
    shared = { id: SHARED_SERVER_ID, name: "Traivos gemensamma vägdatatjänst", configured,
      ...(!configured ? { error: ENV_ERROR } : {}) };
  } catch (error) {
    shared = { id: SHARED_SERVER_ID, name: "Traivos gemensamma vägdatatjänst", configured: false,
      error: error instanceof Error ? error.message : "Konfigurationen är ogiltig." };
  }
  const catalog = parseCatalog();
  const dedicated: RoutingServerStatus[] = catalog.servers.map((server) => {
    const missingAuth = !!server.authTokenEnv && !process.env[server.authTokenEnv];
    return {
      id: server.id,
      name: server.name,
      configured: !missingAuth,
      ...(missingAuth ? { error: "En routing-server kräver en token som inte är konfigurerad." } : {}),
    };
  });
  if (catalog.error) {
    dedicated.push({ id: "catalog", name: "Operatörens serverkatalog", configured: false, error: catalog.error });
  }
  return { shared, dedicated, ...(catalog.error ? { catalogError: catalog.error } : {}) };
}

function makeProvider(server: ResolvedServer): DistrictRoadProvider {
  return createDistrictOsrmProvider(
    server.baseUrl,
    `osrm:${server.id}:${server.configurationVersion}`,
    server.headers,
  );
}

/** Select and snapshot the organization’s current provider preference. */
export async function resolveOrganizationRoutingProvider(
  organizationId: string,
  database: Pick<typeof db, "select"> = db,
): Promise<{ binding: RoutingProviderBinding; provider: DistrictRoadProvider }> {
  await assertOrganizationDistrictAllowed(organizationId, database);
  const [organization] = await database.select({ id: organizationsTable.id })
    .from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
  if (!organization) throw new Error("Organisationen finns inte.");
  const [assignment] = await database.select({ serverId: organizationRoutingProvidersTable.serverId })
    .from(organizationRoutingProvidersTable)
    .where(eq(organizationRoutingProvidersTable.organizationId, organizationId)).limit(1);
  const server = !assignment?.serverId || assignment.serverId === SHARED_SERVER_ID
    ? resolveShared(organizationId)
    : resolveDedicated(organizationId, assignment.serverId);
  return {
    binding: { serverId: server.id, configurationVersion: server.configurationVersion },
    provider: makeProvider(server),
  };
}

/**
 * Rebuild a job-snapshotted provider. Preference changes do not invalidate an
 * already selected server, but tenant scope and operator endpoint version do.
 */
export async function resolveBoundRoutingProvider(
  organizationId: string,
  binding: RoutingProviderBinding,
): Promise<DistrictRoadProvider> {
  await assertOrganizationDistrictAllowed(organizationId);
  const [organization] = await db.select({ id: organizationsTable.id })
    .from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
  if (!organization) throw new Error("Organisationen finns inte.");
  const server = binding.serverId === SHARED_SERVER_ID
    ? resolveShared(organizationId)
    : resolveDedicated(organizationId, binding.serverId);
  if (binding.configurationVersion !== server.configurationVersion) {
    throw new Error("Routing-serverns konfiguration har ändrats sedan jobbet startades.");
  }
  return makeProvider(server);
}

/** Operator approval is separate from the ordinary routing catalog. Never enable in production. */
export async function resolveDistrictBulkProvider(organizationId: string, binding: RoutingProviderBinding,
  datasetIdentity?: string, snapLimits?: ReadonlyMap<string, number>) {
  if (!["development","test"].includes(process.env.NODE_ENV ?? "") ||
      process.env.REPLIT_DEPLOYMENT === "1")
    throw new Error("Stora distriktsjobb är endast tillåtna i utvecklingsmiljön.");
  // Revalidate tenant-bound config, not the organization's potentially changed preference.
  await resolveBoundRoutingProvider(organizationId,binding);
  let approvals: unknown;
  // Only the existing explicitly selected native development service may use
  // the supervisor's local attestation. Remote servers always need operator approval.
  let localApproval:string|undefined;
  if(!process.env.DISTRICT_BULK_PROVIDERS_JSON && process.env.NODE_ENV==="development" &&
      process.env.DISTRICT_LOCAL_OSRM_BASE_URL==="http://127.0.0.1:5001" && binding.serverId===SHARED_SERVER_ID) {
    try {
      const manifest=JSON.parse(await readFile(new URL("../../../../.cache/district-road/bulk-provider-identity.json",import.meta.url),"utf8"));
      if(manifest.bulkApproved===true && manifest.algorithm==="CH" && manifest.profile==="car")
        localApproval=JSON.stringify([manifest]);
    } catch { /* Missing/unavailable attestation must fail closed below. */ }
  }
  try { approvals=JSON.parse(process.env.DISTRICT_BULK_PROVIDERS_JSON ?? localApproval ?? "[]"); }
  catch { throw new Error("Operatörens godkännanden för bulkleverantörer är ogiltiga."); }
  if (!Array.isArray(approvals)) throw new Error("Operatörens bulkgodkännanden måste vara en lista.");
  const approval=approvals.find(a=>a?.serverId===binding.serverId);
  if (!approval || typeof approval.datasetIdentity!=="string" ||
      !/^[a-zA-Z0-9._:-]{1,160}$/.test(approval.datasetIdentity) ||
      approval.maxTableCoordinates!==500)
    throw new Error("Vald vägdatatjänst saknar uttryckligt bulkgodkännande, låst dataset och verifierad Table-kapacitet 500.");
  if (datasetIdentity!==undefined && datasetIdentity!==approval.datasetIdentity)
    throw new Error("Bulkleverantörens godkända dataset har ändrats. Skapa ett nytt jobb.");
  const server=binding.serverId===SHARED_SERVER_ID ? resolveShared(organizationId) : resolveDedicated(organizationId,binding.serverId);
  return { datasetIdentity:approval.datasetIdentity as string,
    provider:createDistrictOsrmProvider(server.baseUrl,`bulk:${binding.configurationVersion}:${approval.datasetIdentity}`,server.headers,
      {datasetIdentity:approval.datasetIdentity,snapLimits}) };
}

export function getRoutingServerForAssignment(serverId: string): { id: string; name: string } | null {
  if (serverId === SHARED_SERVER_ID) {
    const status = getRoutingConfigurationStatus();
    return status.shared.configured ? { id: status.shared.id, name: status.shared.name } : null;
  }
  const catalog = parseCatalog();
  if (catalog.error) return null;
  const server = catalog.servers.find((item) => item.id === serverId);
  if (!server || (server.authTokenEnv && !process.env[server.authTokenEnv])) return null;
  return { id: server.id, name: server.name };
}
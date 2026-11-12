export interface DistrictProviderEnvironment {
  baseUrl: string;
  authTokenEnv: "OSRM_AUTH_TOKEN" | "DISTRICT_OSRM_AUTH_TOKEN" | "DISTRICT_PRODUCTION_OSRM_AUTH_TOKEN";
  token?: string;
  requiresAuth: boolean;
}

/**
 * Pilot overrides remain development-only. Production has a separate, explicit
 * activation gate. Never write or redirect the ordinary routing environment.
 */
export function selectDistrictProviderEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DistrictProviderEnvironment | undefined {
  const productionEnabled = environment.DISTRICT_PRODUCTION_OSRM_ENABLED;
  if (environment.NODE_ENV === "production" &&
      productionEnabled !== undefined && productionEnabled !== "false") {
    if (productionEnabled !== "true") {
      throw new Error("Distriktets produktionsanslutning kräver ett uttryckligt giltigt aktiveringsval.");
    }
    let url: URL;
    try {
      url = new URL(environment.DISTRICT_PRODUCTION_OSRM_BASE_URL ?? "");
    } catch {
      throw new Error("Distriktets produktionsanslutning saknar en giltig serveradress.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        /(^|\.)router\.project-osrm\.org$/i.test(url.hostname)) {
      throw new Error("Distriktets produktionsanslutning kräver en egen HTTPS-server utan inloggningsuppgifter i adressen.");
    }
    const token = environment.DISTRICT_PRODUCTION_OSRM_AUTH_TOKEN;
    if (!token || !/^[0-9a-f]{64}$/.test(token)) {
      throw new Error("Distriktets produktionsanslutning saknar en giltig skyddad åtkomstnyckel.");
    }
    return {
      baseUrl: url.toString().replace(/\/+$/, ""),
      authTokenEnv: "DISTRICT_PRODUCTION_OSRM_AUTH_TOKEN",
      token,
      requiresAuth: true,
    };
  }
  if (environment.NODE_ENV === "development" && environment.DISTRICT_OSRM_BASE_URL !== undefined) {
    let url: URL;
    try {
      url = new URL(environment.DISTRICT_OSRM_BASE_URL);
    } catch {
      throw new Error("Distriktets utvecklingsanslutning har en ogiltig serveradress.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        /(^|\.)router\.project-osrm\.org$/i.test(url.hostname)) {
      throw new Error("Distriktets utvecklingsanslutning kräver en egen HTTPS-server utan inloggningsuppgifter i adressen.");
    }
    const token = environment.DISTRICT_OSRM_AUTH_TOKEN;
    if (!token || !/^[0-9a-f]{64}$/.test(token)) {
      throw new Error("Distriktets utvecklingsanslutning saknar en giltig skyddad åtkomstnyckel.");
    }
    return {
      baseUrl: url.toString().replace(/\/+$/, ""),
      authTokenEnv: "DISTRICT_OSRM_AUTH_TOKEN",
      token,
      requiresAuth: true,
    };
  }
  // Native acceptance server is private to this host, not a remotely reachable
  // exception to the authenticated HTTPS pilot. Never redirect ordinary routing.
  if (environment.NODE_ENV === "development" && environment.DISTRICT_LOCAL_OSRM_BASE_URL !== undefined) {
    let url: URL;
    try { url = new URL(environment.DISTRICT_LOCAL_OSRM_BASE_URL); }
    catch { throw new Error("Distriktets lokala utvecklingsserver har en ogiltig adress."); }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== "5001" ||
        url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
      throw new Error("Distriktets lokala utvecklingsserver måste använda http://127.0.0.1:5001 utan andra adressdelar.");
    }
    return {
      baseUrl: url.toString().replace(/\/+$/, ""),
      authTokenEnv: "OSRM_AUTH_TOKEN",
      requiresAuth: false,
    };
  }
  if (!environment.OSRM_BASE_URL) return undefined;
  return {
    baseUrl: environment.OSRM_BASE_URL,
    authTokenEnv: "OSRM_AUTH_TOKEN",
    token: environment.OSRM_AUTH_TOKEN,
    requiresAuth: false,
  };
}
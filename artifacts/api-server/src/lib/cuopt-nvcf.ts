/**
 * Read-only metadata check against NVIDIA Cloud Functions.
 * This NEVER invokes a function and cannot establish that the function implements cuOpt.
 * https://api.nvcf.nvidia.com/v3/openapi (Function Management)
 */
import { GetPlatformCuoptStatusResponse } from "@workspace/api-zod";
import type { z } from "zod";

type PlatformCuoptStatus = z.infer<typeof GetPlatformCuoptStatusResponse>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOST = "https://api.nvcf.nvidia.com";
const LIMIT = 64 * 1024;

type Config = {
  NVIDIA_CUOPT_API_KEY?: string;
  CUOPT_FUNCTION_ID?: string;
  CUOPT_FUNCTION_VERSION_ID?: string;
};
type State = PlatformCuoptStatus["state"];

const messages: Record<State, string> = {
  not_checked: "Endast konfiguration kontrollerad. Ingen kontakt med NVIDIA har gjorts.",
  missing_config: "NVIDIA-nyckel eller funktions-ID saknas på servern.",
  invalid_config: "Funktions-ID eller versions-ID är inte ett giltigt UUID.",
  metadata_active: "NVIDIA bekräftade åtkomst till en aktiv funktionsversion. Detta bevisar inte att funktionen är cuOpt eller att optimering fungerar.",
  metadata_inactive: "NVIDIA returnerade ingen aktiv version för konfigurerad funktion.",
  auth_failed: "NVIDIA avvisade åtkomst till funktionsmetadata (401/403). Kontrollera nyckel och behörighet för list_functions.",
  not_found: "NVIDIA hittade inte konfigurerad funktion/version, eller gav inte åtkomst till den.",
  timeout: "NVIDIA svarade inte inom tidsgränsen.",
  unavailable: "NVIDIA kunde inte nås eller returnerade ett tjänstefel.",
  invalid_response: "NVIDIA returnerade oväntad metadata; ingen aktiv version kunde verifieras.",
};

export function cuoptConfiguration(config: Config = process.env): PlatformCuoptStatus {
  const keyPresent = Boolean(config.NVIDIA_CUOPT_API_KEY?.trim());
  const functionIdConfigured = Boolean(config.CUOPT_FUNCTION_ID?.trim());
  const versionIdConfigured = Boolean(config.CUOPT_FUNCTION_VERSION_ID?.trim());
  const state: State = !keyPresent || !functionIdConfigured ? "missing_config"
    : !UUID.test(config.CUOPT_FUNCTION_ID!.trim()) ||
      (versionIdConfigured && !UUID.test(config.CUOPT_FUNCTION_VERSION_ID!.trim()))
      ? "invalid_config" : "not_checked";
  return { keyPresent, functionIdConfigured, versionIdConfigured, state, message: messages[state] };
}

async function limitedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("empty");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) throw new Error("oversized");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export async function testCuoptConnection(
  config: Config = process.env,
  request: typeof fetch = fetch,
): Promise<PlatformCuoptStatus> {
  const base = cuoptConfiguration(config);
  if (base.state !== "not_checked") return base;
  const result = (state: State): PlatformCuoptStatus => ({ ...base, state, message: messages[state] });
  const id = config.CUOPT_FUNCTION_ID!.trim();
  const version = config.CUOPT_FUNCTION_VERSION_ID?.trim();
  const path = `/v2/nvcf/functions/${id}/versions${version ? `/${version}` : ""}`;

  try {
    const response = await request(`${HOST}${path}${version ? "?includeSecrets=false" : ""}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.NVIDIA_CUOPT_API_KEY!.trim()}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401 || response.status === 403) return result("auth_failed");
    if (response.status === 404) return result("not_found");
    if (!response.ok) return result("unavailable");
    const payload = await limitedJson(response);
    // NVCF FunctionResponse wraps one FunctionDto in `function`;
    // ListFunctionsResponse wraps version DTOs in `functions`.
    const versions: unknown[] = version
      ? (isRecord(payload) ? [payload.function] : [])
      : (isRecord(payload) && Array.isArray(payload.functions) ? payload.functions : []);
    if (!versions.length) return result(version ? "invalid_response" : "metadata_inactive");
    if (!versions.every(isRecord)) return result("invalid_response");
    if (!versions.every((v) => typeof v.id === "string" && typeof v.versionId === "string" && typeof v.status === "string"))
      return result("invalid_response");
    if (!versions.every((v) => (v.id as string).toLowerCase() === id.toLowerCase())) return result("invalid_response");
    if (version && (versions[0].versionId as string).toLowerCase() !== version.toLowerCase()) return result("invalid_response");
    return result(versions.some((v) => v.status === "ACTIVE") ? "metadata_active" : "metadata_inactive");
  } catch (error) {
    // Never include upstream error text, response body, headers, URL, or credentials in output or logs.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return result("timeout");
    if (error instanceof SyntaxError || (error instanceof Error && ["empty", "oversized"].includes(error.message)))
      return result("invalid_response");
    return result("unavailable");
  }
}
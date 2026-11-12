import dns from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 8_000;
const ABSOLUTE_RESOURCE_TIMEOUT_MS = 8_000;
const EXTRACTION_TIMEOUT_MS = 30_000;
const LOGO_CANDIDATE_TIMEOUT_MS = 4_000;
const MAX_LOGO_CANDIDATE_ATTEMPTS = 12;
const USER_AGENT = "TraivoBrandingFetcher/1.0";
type PinnedLookup = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | Array<{ address: string; family: number }>,
    family?: number,
  ) => void,
) => void;

export const MAX_BRANDING_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_BRANDING_CSS_BYTES = 512 * 1024;
export const MAX_BRANDING_IMAGE_BYTES = 5 * 1024 * 1024;

export class BrandingFetchError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 422) {
    super(message);
    this.name = "BrandingFetchError";
    this.statusCode = statusCode;
  }
}

export interface PublicResource {
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  body: Buffer;
}

interface FetchOptions {
  maxBytes: number;
  acceptedContentTypes?: readonly string[];
  signal?: AbortSignal;
}

export interface ResolvedPublicAddress {
  address: string;
  family: 4 | 6;
}

export interface RawBrandingResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * Optional transport seams make redirect/size tests deterministic without
 * weakening production DNS validation. Normal application calls use the
 * pinned resolver and Node HTTP(S) transport below.
 */
export interface BrandingFetchDependencies {
  resolveAddresses?: (
    url: URL,
    signal?: AbortSignal,
  ) => Promise<ResolvedPublicAddress[]>;
  request?: (
    url: URL,
    addresses: ResolvedPublicAddress[],
    maxBytes: number,
    signal?: AbortSignal,
  ) => Promise<RawBrandingResponse>;
  /** Test-only shorter deadlines; production uses the bounded constants above. */
  timeoutMs?: number;
  overallTimeoutMs?: number;
}

function normalizeContentType(value: string | undefined): string {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function isBlockedHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/\.$/, "");
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    value.endsWith(".home.arpa")
  );
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const octets = parts.map(Number);
  return octets.every((part) => part >= 0 && part <= 255) ? octets : null;
}

function isPrivateIpv4(value: string): boolean {
  const parts = parseIpv4(value);
  if (!parts) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 2 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function parseIpv6Words(value: string): number[] | null {
  const normalized = value.toLowerCase().split("%", 1)[0];
  if (!normalized || normalized.includes(":::") || normalized.split("::").length > 2) {
    return null;
  }

  // Normalize dotted IPv4 tails before expanding the IPv6 compression. This
  // handles compatible (::192.0.2.1), mapped (::ffff:192.0.2.1), and
  // translated forms without relying on parseInt's permissive behavior.
  let ipv6 = normalized;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
    if (!ipv4) return null;
    const [a, b, c, d] = ipv4;
    const prefix = normalized.slice(0, lastColon);
    const separator = normalized.includes("::") ? ":" : "";
    ipv6 = `${prefix}${separator}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = ipv6.split("::");
  const parseHextets = (part: string): number[] | null => {
    if (!part) return [];
    const hextets = part.split(":");
    if (hextets.some((hextet) => !/^[0-9a-f]{1,4}$/.test(hextet))) return null;
    return hextets.map((hextet) => Number.parseInt(hextet, 16));
  };
  const left = parseHextets(halves[0]);
  const right = parseHextets(halves[1] ?? "");
  if (!left || !right) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  return [...left, ...Array(omitted).fill(0), ...right];
}

function isPrivateIpv6(value: string): boolean {
  const words = parseIpv6Words(value);
  if (!words || words.length !== 8) return true;

  // Only global-unicast space is eligible for server-side fetching. This
  // rejects unspecified, loopback, IPv4-compatible/mapped, ULA, link-local,
  // multicast, and all other non-global IPv6 ranges by construction.
  const firstHextet = words[0];
  if ((firstHextet & 0xe000) !== 0x2000) return true; // 2000::/3

  // Transition and translation prefixes can encode a private IPv4 address or
  // route traffic through a non-public translator, so do not treat them as
  // ordinary global unicast. This includes 6to4 and the standard NAT64
  // well-known prefixes.
  if (firstHextet === 0x2002) return true; // 6to4
  if (
    (words[0] === 0x0064 && words[1] === 0xff9b) || // 64:ff9b::/96
    (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001) // 64:ff9b:1::/48
  ) {
    return true;
  }

  // IANA special-use and documentation ranges inside 2000::/3.
  if (firstHextet === 0x3ffe) return true; // 6bone
  if (
    words[0] === 0x2001 &&
    (
      words[1] === 0x0000 || // Teredo
      (words[1] === 0x0002 && words[2] === 0x0000) || // benchmarking
      (words[1] & 0xfff0) === 0x0010 || // ORCHID
      (words[1] & 0xfff0) === 0x0020 || // ORCHIDv2
      words[1] === 0x0db8 // documentation
    )
  ) {
    return true;
  }

  return false;
}

function deadlineError(): BrandingFetchError {
  return new BrandingFetchError("The source request exceeded its overall deadline", 504);
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(deadlineError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function isPublicAddress(value: string): boolean {
  const normalized = value.replace(/^\[|\]$/g, "");
  const family = net.isIP(normalized);
  if (family === 4) return !isPrivateIpv4(normalized);
  if (family === 6) return !isPrivateIpv6(normalized);
  return false;
}

async function resolvePublicAddresses(
  url: URL,
  signal?: AbortSignal,
): Promise<ResolvedPublicAddress[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(hostname)) {
    throw new BrandingFetchError("The source host is not publicly reachable", 400);
  }

  const directFamily = net.isIP(hostname);
  if (directFamily) {
    if (!isPublicAddress(hostname)) {
      throw new BrandingFetchError("The source host is not publicly reachable", 400);
    }
    return [{ address: hostname, family: directFamily as 4 | 6 }];
  }

  let addresses: Array<{ address: string; family: number }>;
  let dnsTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      raceWithAbort(dns.lookup(hostname, { all: true, verbatim: true }), signal),
      new Promise<never>((_, reject) => {
        dnsTimeout = setTimeout(
          () => reject(new BrandingFetchError("DNS lookup timed out")),
          3_000,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof BrandingFetchError && error.statusCode === 504) throw error;
    throw new BrandingFetchError("The source host could not be resolved");
  } finally {
    if (dnsTimeout) clearTimeout(dnsTimeout);
  }

  if (
    addresses.length === 0 ||
    addresses.some((entry) => !isPublicAddress(entry.address))
  ) {
    throw new BrandingFetchError("The source host is not publicly reachable", 400);
  }

  return addresses.map((entry) => ({
    address: entry.address,
    family: entry.family as 4 | 6,
  }));
}

export async function assertPublicUrl(
  input: string,
  resolveAddresses: (
    url: URL,
    signal?: AbortSignal,
  ) => Promise<ResolvedPublicAddress[]> = resolvePublicAddresses,
  signal?: AbortSignal,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BrandingFetchError("A valid source URL is required", 400);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new BrandingFetchError("Only HTTP and HTTPS source URLs are allowed", 400);
  }
  if (url.username || url.password) {
    throw new BrandingFetchError("Source URLs may not contain credentials", 400);
  }
  if (url.port && !["80", "443"].includes(url.port)) {
    throw new BrandingFetchError("Source URL ports must be 80 or 443", 400);
  }
  await raceWithAbort(resolveAddresses(url, signal), signal);
  return url;
}

function contentTypeAllowed(
  contentType: string,
  acceptedContentTypes: readonly string[] | undefined,
): boolean {
  return !acceptedContentTypes || acceptedContentTypes.includes(contentType);
}

async function requestOnce(
  url: URL,
  addresses: ResolvedPublicAddress[],
  maxBytes: number,
  signal?: AbortSignal,
): Promise<RawBrandingResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const pinnedLookup: PinnedLookup = (_hostname, options, callback) => {
      const selected = addresses[0];
      if (options.all) {
        callback(null, [{ address: selected.address, family: selected.family }]);
      } else {
        callback(null, selected.address, selected.family);
      }
    };
    const requestOptions = {
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname || "/"}${url.search}`,
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,text/css,image/jpeg,image/png,image/webp,image/gif",
        "Accept-Encoding": "identity",
      },
      lookup: pinnedLookup,
      ...(url.protocol === "https:" ? { servername: url.hostname.replace(/^\[|\]$/g, "") } : {}),
    };
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requestFn(requestOptions, (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400) {
        response.resume();
        settled = true;
        resolve({ statusCode, headers: response.headers, body: Buffer.alloc(0) });
        return;
      }
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy();
          if (!settled) {
            settled = true;
            reject(new BrandingFetchError("The source response is too large", 413));
          }
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("end", () => {
        if (!settled) {
          settled = true;
          resolve({ statusCode, headers: response.headers, body: Buffer.concat(chunks) });
        }
      });
      response.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new BrandingFetchError("The source request timed out", 504));
    });
    const abortRequest = () => {
      request.destroy(deadlineError());
    };
    if (signal?.aborted) {
      abortRequest();
    } else {
      signal?.addEventListener("abort", abortRequest, { once: true });
    }
    request.once("error", (error) => {
      if (!settled) {
        settled = true;
        signal?.removeEventListener("abort", abortRequest);
        reject(
          error instanceof BrandingFetchError
            ? error
            : new BrandingFetchError("The source could not be fetched"),
        );
      }
    });
    request.end();
  });
}

/** Test-only access to the real pinned HTTP transport. */
export const requestOnceForTests = requestOnce;

export async function fetchPublicResource(
  input: string,
  options: FetchOptions,
  dependencies: BrandingFetchDependencies = {},
): Promise<PublicResource> {
  const resolveAddresses = dependencies.resolveAddresses ?? resolvePublicAddresses;
  const request = dependencies.request ?? requestOnce;
  const controller = new AbortController();
  const timeoutMs = dependencies.timeoutMs ?? ABSOLUTE_RESOURCE_TIMEOUT_MS;
  const deadlineTimer = setTimeout(() => controller.abort(), timeoutMs);
  const parentAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", parentAbort, { once: true });

  try {
    const requestedUrl = (await assertPublicUrl(input, resolveAddresses, controller.signal)).toString();
    let currentUrl = requestedUrl;

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const url = await assertPublicUrl(currentUrl, resolveAddresses, controller.signal);
      const addresses = await raceWithAbort(
        resolveAddresses(url, controller.signal),
        controller.signal,
      );
      let response;
      try {
        response = await raceWithAbort(
          request(url, addresses, options.maxBytes, controller.signal),
          controller.signal,
        );
      } catch (error) {
        if (error instanceof BrandingFetchError) throw error;
        throw new BrandingFetchError("The source could not be fetched");
      }

      if (isRedirect(response.statusCode)) {
        const location = response.headers.location;
        const redirectTarget = Array.isArray(location) ? location[0] : location;
        if (!redirectTarget) {
          throw new BrandingFetchError("The source returned an invalid redirect");
        }
        if (redirect === MAX_REDIRECTS) {
          throw new BrandingFetchError("The source returned too many redirects");
        }
        currentUrl = new URL(redirectTarget, url).toString();
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new BrandingFetchError(`The source returned HTTP ${response.statusCode}`);
      }

      const contentType = normalizeContentType(
        typeof response.headers["content-type"] === "string"
          ? response.headers["content-type"]
          : undefined,
      );
      if (!contentTypeAllowed(contentType, options.acceptedContentTypes)) {
        throw new BrandingFetchError("The source response has an unsupported content type");
      }
      return {
        requestedUrl,
        finalUrl: url.toString(),
        contentType,
        body: response.body,
      };
    }

    throw new BrandingFetchError("The source returned too many redirects");
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", parentAbort);
    controller.abort();
  }
}

function readAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function resolveCandidate(value: string | null, baseUrl: string): string | null {
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return null;
  try {
    const url = new URL(value.trim().split(/\s+/)[0], baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function clampColor(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

const CSS_NUMBER_PATTERN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;

function parseCssNumber(value: string): number | null {
  const normalized = value.trim();
  if (!CSS_NUMBER_PATTERN.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAlpha(value: string): number | null {
  const normalized = value.trim();
  const parsed = normalized.endsWith("%")
    ? parseCssNumber(normalized.slice(0, -1))
    : parseCssNumber(normalized);
  return parsed === null ? null : Math.max(0, Math.min(1, normalized.endsWith("%") ? parsed / 100 : parsed));
}

function compositeColor(channels: [number, number, number], alpha: number): string {
  const composited = channels.map((channel) => clampColor(channel * alpha + 255 * (1 - alpha)));
  return `#${composited.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function parseRgbColor(body: string): string | null {
  const parts = body.trim().replace(/\s*\/\s*/g, " ").split(/[\s,]+/);
  if (parts.length < 3 || parts.length > 4) return null;
  const channels = parts.slice(0, 3).map((part) => {
    const value = part.endsWith("%")
      ? parseCssNumber(part.slice(0, -1))
      : parseCssNumber(part);
    return value === null ? Number.NaN : part.endsWith("%") ? value * 2.55 : value;
  });
  if (channels.some((channel) => !Number.isFinite(channel))) return null;
  const alpha = parts.length === 4 ? parseAlpha(parts[3]) : 1;
  return alpha === null ? null : compositeColor(channels as [number, number, number], alpha);
}

function parseHue(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  const unit = normalized.match(/(deg|turn|rad|grad)$/)?.[1] ?? "";
  const number = parseCssNumber(unit ? normalized.slice(0, -unit.length) : normalized);
  if (number === null) return null;
  if (unit === "turn") return number * 360;
  if (unit === "rad") return number * (180 / Math.PI);
  if (unit === "grad") return number * 0.9;
  return number;
}

function parseHslColor(body: string): string | null {
  const parts = body.trim().replace(/\s*\/\s*/g, " ").split(/[\s,]+/);
  if (parts.length < 3 || parts.length > 4 || !parts[1].endsWith("%") || !parts[2].endsWith("%")) {
    return null;
  }
  const hue = parseHue(parts[0]);
  const saturation = parseCssNumber(parts[1].slice(0, -1));
  const lightness = parseCssNumber(parts[2].slice(0, -1));
  const alpha = parts.length === 4 ? parseAlpha(parts[3]) : 1;
  if (
    hue === null ||
    saturation === null ||
    lightness === null ||
    alpha === null
  ) {
    return null;
  }
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const l = Math.max(0, Math.min(100, lightness)) / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const huePrime = ((hue % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1));
  const [red, green, blue] =
    huePrime < 1 ? [chroma, x, 0] :
    huePrime < 2 ? [x, chroma, 0] :
    huePrime < 3 ? [0, chroma, x] :
    huePrime < 4 ? [0, x, chroma] :
    huePrime < 5 ? [x, 0, chroma] :
    [chroma, 0, x];
  const match = (channel: number) => (channel + (l - chroma / 2)) * 255;
  return compositeColor([match(red), match(green), match(blue)], alpha);
}

export function normalizeBrandingColor(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const hex = normalized.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    const digits = hex[1].length <= 4
      ? hex[1].split("").map((digit) => `${digit}${digit}`).join("")
      : hex[1];
    const channels: [number, number, number] = [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
    ];
    const alpha = digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1;
    return compositeColor(channels, alpha);
  }
  const functional = normalized.match(/^(rgba?|hsla?)\((.*)\)$/);
  if (!functional) return null;
  return functional[1].startsWith("rgb")
    ? parseRgbColor(functional[2])
    : parseHslColor(functional[2]);
}

function extractColorValues(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /#[0-9a-f]{3,4}\b/gi,
    /#[0-9a-f]{6}(?:[0-9a-f]{2})?\b/gi,
    /\b(?:rgb|rgba|hsl|hsla)\(\s*[^()]{1,80}\)/gi,
  ];
  for (const pattern of patterns) {
    for (const value of source.match(pattern) ?? []) {
      const normalized = normalizeBrandingColor(value);
      if (!normalized) continue;
      found.add(normalized);
      if (found.size >= 24) return [...found];
    }
  }
  return [...found];
}

async function extractLogoCandidates(
  html: string,
  baseUrl: string,
  warnings: string[],
  resolveAddresses: BrandingFetchDependencies["resolveAddresses"] = resolvePublicAddresses,
  signal?: AbortSignal,
): Promise<Array<{ url: string; label: string }>> {
  const candidates: Array<{ url: string; label: string }> = [];
  const seen = new Set<string>();
  let attempts = 0;
  let timeoutWarningAdded = false;
  const add = async (raw: string | null, label: string) => {
    const resolved = resolveCandidate(raw, baseUrl);
    if (!resolved || seen.has(resolved) || attempts >= MAX_LOGO_CANDIDATE_ATTEMPTS || signal?.aborted) return;
    attempts += 1;
    try {
      await assertPublicUrl(resolved, resolveAddresses, signal);
      seen.add(resolved);
      candidates.push({ url: resolved, label: label.trim() || "Logo candidate" });
    } catch {
      if (signal?.aborted) {
        if (!timeoutWarningAdded) {
          warnings.push("Logo candidate validation exceeded its time budget.");
          timeoutWarningAdded = true;
        }
      } else {
        warnings.push(`Skipped a non-public logo candidate: ${resolved}`);
      }
    }
  };

  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = readAttribute(tag, "src") ?? readAttribute(tag, "srcset");
    await add(src, readAttribute(tag, "alt") ?? "Image logo candidate");
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = readAttribute(tag, "rel")?.toLowerCase() ?? "";
    if (/\b(icon|apple-touch-icon|mask-icon)\b/.test(rel)) {
      await add(readAttribute(tag, "href"), rel.includes("icon") ? "Site icon" : "Logo candidate");
    }
  }
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const property = (readAttribute(tag, "property") ?? readAttribute(tag, "name") ?? "").toLowerCase();
    if (property === "og:image" || property === "twitter:image") {
      await add(readAttribute(tag, "content"), "Social image logo candidate");
    }
  }
  return candidates;
}

export interface BrandingExtraction {
  sourceUrl: string;
  colors: string[];
  logos: Array<{ url: string; label: string }>;
  warnings: string[];
}

export async function extractBranding(
  input: string,
  dependencies: BrandingFetchDependencies = {},
): Promise<BrandingExtraction> {
  const resolveAddresses = dependencies.resolveAddresses ?? resolvePublicAddresses;
  const extractionController = new AbortController();
  const extractionTimer = setTimeout(
    () => extractionController.abort(),
    dependencies.overallTimeoutMs ?? EXTRACTION_TIMEOUT_MS,
  );
  try {
    const sourceUrl = (await assertPublicUrl(input, resolveAddresses, extractionController.signal)).toString();
    const page = await fetchPublicResource(sourceUrl, {
      maxBytes: MAX_BRANDING_HTML_BYTES,
      acceptedContentTypes: ["text/html", "application/xhtml+xml", "text/css"],
      signal: extractionController.signal,
    }, dependencies);
    const warnings: string[] = [];

    if (page.contentType === "text/css") {
      const colors = extractColorValues(page.body.toString("utf8"));
      if (colors.length === 0) warnings.push("No usable colors were found.");
      return { sourceUrl, colors, logos: [], warnings: ["The source is CSS; no HTML logo candidates were found.", ...warnings] };
    }

  // Scripts are data, not markup. Remove them before looking for URLs/colors so
  // untrusted JavaScript cannot manufacture suggestions.
  const html = page.body.toString("utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const inlineStyles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1])
    .join("\n");
  let colors = extractColorValues(`${html}\n${inlineStyles}`);

  const cssLinks: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = readAttribute(tag, "rel")?.toLowerCase() ?? "";
    if (rel.split(/\s+/).includes("stylesheet")) {
      const href = resolveCandidate(readAttribute(tag, "href"), page.finalUrl);
      if (href && !cssLinks.includes(href)) cssLinks.push(href);
    }
  }
    for (const cssUrl of cssLinks.slice(0, 3)) {
      try {
        const css = await fetchPublicResource(cssUrl, {
          maxBytes: MAX_BRANDING_CSS_BYTES,
          acceptedContentTypes: ["text/css"],
          signal: extractionController.signal,
        }, dependencies);
        colors = [...new Set([...colors, ...extractColorValues(css.body.toString("utf8"))])].slice(0, 24);
      } catch {
        warnings.push(`Could not read stylesheet ${cssUrl}.`);
      }
    }

    const logoController = new AbortController();
    const logoTimer = setTimeout(() => logoController.abort(), LOGO_CANDIDATE_TIMEOUT_MS);
    const stopLogoOnExtractionTimeout = () => logoController.abort();
    extractionController.signal.addEventListener("abort", stopLogoOnExtractionTimeout, { once: true });
    try {
      const logos = await extractLogoCandidates(
        html,
        page.finalUrl,
        warnings,
        resolveAddresses,
        logoController.signal,
      );
      if (colors.length === 0) warnings.push("No usable colors were found.");
      if (logos.length === 0) warnings.push("No public logo candidates were found.");
      return { sourceUrl, colors, logos, warnings };
    } finally {
      clearTimeout(logoTimer);
      extractionController.signal.removeEventListener("abort", stopLogoOnExtractionTimeout);
      logoController.abort();
    }
  } finally {
    clearTimeout(extractionTimer);
    extractionController.abort();
  }
}

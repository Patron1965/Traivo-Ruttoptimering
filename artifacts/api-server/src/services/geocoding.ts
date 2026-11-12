import { logger } from "../lib/logger";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { recordUsage } from "./usage";
import { getUsageContext, type UsageContext } from "./usage-context";
import { ensureOrganizationServicePolicy, currentOrganizationServicePolicy, servicePolicyCachePartition, OrganizationServicePolicyError } from "./organization-service-policy";

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  displayName: string;
  source: "google" | "nominatim" | "cache";
  provider: "google" | "nominatim";
}

export interface GeocodeCandidate {
  id: string;
  latitude: number;
  longitude: number;
  displayName: string;
  source: "google" | "nominatim";
  partial: boolean;
}

export interface GeocodeInput {
  address: string;
  postalCode?: string;
  city?: string;
  /**
   * An optional apartment/unit value from a structured import. Unit values
   * are retained as input metadata, but are deliberately not used as the
   * provider's street house number.
   */
  unit?: string;
}

export interface DetailedGeocodeResult {
  query: string;
  status: "matched" | "candidates" | "not_found" | "provider_unavailable" | "invalid_input";
  result: GeocodeResult | null;
  candidates: GeocodeCandidate[];
}

interface ProviderResponse {
  state: "available" | "unavailable" | "invalid";
  exact: GeocodeResult | null;
  candidates: GeocodeCandidate[];
  /**
   * Address-level results that match the requested road, number and postcode
   * but differ only in locality. These are deliberately kept separate from
   * ordinary candidates until a bounded locality-area proof is available.
   */
  localityAliasCandidates: LocalityAliasCandidate[];
}

const cache = new Map<string, { result: GeocodeResult; expiresAt: number }>();
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 5_000;
const RATE_LIMIT_MS = 1100;
const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const MAX_FETCH_TIMEOUT_MS = 10000;
let lastRequest = 0;
let nominatimQueue: Promise<void> = Promise.resolve();
const inFlight = new Map<string, Promise<DetailedGeocodeResult>>();
const broadProviderInFlight = new Map<string, Promise<ProviderResponse>>();
const localityAreaCache = new Map<string, { areas: GoogleAreaEvidence[]; expiresAt: number }>();
const localityAreaInFlight = new Map<string, Promise<GoogleAreaEvidence[]>>();
const MAX_LOCALITY_AREA_ENTRIES = 1024;
/** Area points/bounds may be approximate; never bridge more than 5 km. */
const MAX_LOCALITY_AREA_PROXIMITY_METERS = 5_000;

const metrics = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  inFlightHits: 0,
  googleRequests: 0,
  nominatimRequests: 0,
  statusCounts: {
    matched: 0,
    candidates: 0,
    not_found: 0,
    provider_unavailable: 0,
    invalid_input: 0,
  } satisfies Record<DetailedGeocodeResult["status"], number>,
};

export interface GeocodingMetrics {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  inFlightHits: number;
  googleRequests: number;
  nominatimRequests: number;
  statusCounts: Record<DetailedGeocodeResult["status"], number>;
  cacheSize: number;
  inFlightRequests: number;
}

export function getGeocodingMetrics(): GeocodingMetrics {
  return {
    ...metrics,
    statusCounts: { ...metrics.statusCounts },
    cacheSize: cache.size,
    inFlightRequests: inFlight.size,
  };
}

const NOMINATIM_BASE = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org";
const USER_AGENT = process.env.NOMINATIM_USER_AGENT || "Traivo-Route/1.0 (contact@traivo.se)";
const GOOGLE_GEOCODING_BASE = "https://maps.googleapis.com/maps/api/geocode/json";
const LOG_FINGERPRINT_KEY = process.env.SESSION_SECRET || randomBytes(32).toString("hex");

async function recordGeocodingUsage(
  context: UsageContext | undefined,
  provider: "google" | "nominatim",
  operation: string,
  outcome: string,
  options: { units: number; durationMs?: number; cacheStatus?: string; retry?: boolean },
): Promise<void> {
  if (!context) return;
  try {
    await recordUsage({
      organizationId: context.organizationId,
      jobId: context.jobId,
      eventKey: randomUUID(),
      category: "geocoding",
      provider,
      operation,
      outcome,
      units: options.units,
      durationMs: options.durationMs,
      cacheStatus: options.cacheStatus,
      retry: options.retry,
    });
  } catch {
    // Ledger failures must be visible without changing provider fallback or
    // routing behavior. Never include provider input or coordinates in logs.
    logger.error({ event: "usage_ledger_write_failed", provider, operation }, "Could not persist provider usage event");
  }
}

function cleanSegment(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/[,;\s]+/g, " ") : "";
}

function cleanAddress(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .trim()
    .replace(/[;\n]+/g, ",")
    .replace(/\s*,\s*/g, ", ")
    .replace(/,{2,}/g, ",")
    .replace(/\s+/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "");
}

function normalizePostalCode(value: unknown): string {
  const compact = cleanSegment(value).replace(/\s/g, "");
  return /^\d{5}$/.test(compact) ? `${compact.slice(0, 3)} ${compact.slice(3)}` : cleanSegment(value);
}

/*
 * Swedish import files often omit separators in otherwise valid addresses:
 * `Bergtallsvägen6,12559Älvsjö,Sweden`.  Word boundaries cannot detect the
 * postcode in front of an attached locality, so use digit lookarounds
 * instead.  This still prevents matching a five-digit slice of a longer
 * number.
 */
const POSTAL_CODE_PATTERN = /(?<!\d)(\d{3})\s?(\d{2})(?!\d)/;

const HOUSE_NUMBER_TOKEN = "\\d+[a-zA-Z]?(?:[-/]\\d+[a-zA-Z]?)?";
const HOUSE_NUMBER_PATTERN = new RegExp(`(?:^|[\\s,])${HOUSE_NUMBER_TOKEN}\\s*$`, "u");

const UNIT_PATTERN = /(?:^|[,\s])(?:lgh|lägenhet|apartment)\s*[:#-]?\s*([a-z]?\d[a-z0-9]*(?:[-/][a-z0-9]+)?)(?=$|[,\s])/giu;
const COUNTRY_SUFFIX_PATTERN = /(?:,?\s+)(sweden|sverige)$/iu;

interface HouseParts {
  street: string;
  houseNumber: string;
}

interface AddressParts {
  address: string;
  unit: string | null;
}

/**
 * Remove an apartment qualifier before looking for a street house number.
 * For example, `AKTERGATAN 12 LGH 1002` must be treated as house 12 with
 * unit 1002, never as house 1002.  The source address itself is never
 * mutated; this value is only used to build a provider query/evidence.
 */
function stripUnitQualifier(value: string, explicitUnit?: unknown): AddressParts {
  let unit: string | null = typeof explicitUnit === "string" && explicitUnit.trim()
    ? explicitUnit.trim()
    : null;
  const address = value.replace(UNIT_PATTERN, (_match, captured: string) => {
    if (!unit) unit = captured;
    return " ";
  });
  return { address: cleanAddress(address), unit };
}

function stripCountrySuffix(value: string): string {
  const cleaned = cleanAddress(value);
  return cleaned.replace(COUNTRY_SUFFIX_PATTERN, "").trim();
}

/**
 * Extract a house number at the end of a street.  Besides the usual
 * `Street 6`, accept compact imported forms such as `Street6`; the latter is
 * intentionally attempted only after the separated form.
 */
function houseParts(value: string): HouseParts | null {
  const cleaned = cleanAddress(value);
  if (!cleaned) return null;

  const separated = cleaned.match(new RegExp(`^(.*?)\\s+(${HOUSE_NUMBER_TOKEN})\\s*$`, "u"));
  if (separated?.[1] && separated[2]) {
    return { street: separated[1].trim(), houseNumber: separated[2] };
  }

  const attached = cleaned.match(new RegExp(`^(.+?[^\\d])(${HOUSE_NUMBER_TOKEN})\\s*$`, "u"));
  if (attached?.[1] && attached[2]) {
    return { street: attached[1].trim(), houseNumber: attached[2] };
  }
  return null;
}

function hasHouseNumber(value: string): boolean {
  return HOUSE_NUMBER_PATTERN.test(cleanAddress(value)) || houseParts(value) !== null;
}

function normalizeStreetHouseSpacing(value: string): string {
  const cleaned = cleanAddress(value);
  const house = houseParts(cleaned);
  return house ? `${house.street} ${house.houseNumber}` : cleaned;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes a known locality only at the beginning or end of a segment. This is
 * deliberately conservative: a city name in the middle of a street name is
 * not treated as a locality.
 */
function stripLocality(segment: string, locality: string, allowPrefix = true): { value: string; found: boolean } {
  const cleaned = cleanAddress(segment);
  const city = cleanSegment(locality);
  if (!cleaned || !city) return { value: cleaned, found: false };

  const normalizedSegment = comparable(cleaned);
  const normalizedCity = comparable(city);
  if (normalizedSegment === normalizedCity) return { value: "", found: true };

  const cityPattern = city.split(/\s+/).filter(Boolean).map(escapeRegex).join("\\s+");
  const withoutPrefix = allowPrefix
    ? cleaned.replace(new RegExp(`^${cityPattern}(?:\\s+|,\\s*)`, "iu"), "")
    : cleaned;
  if (withoutPrefix !== cleaned) return { value: cleanAddress(withoutPrefix), found: true };
  const withoutSuffix = cleaned.replace(new RegExp(`(?:,\\s*|\\s+)${cityPattern}$`, "iu"), "");
  if (withoutSuffix !== cleaned) return { value: cleanAddress(withoutSuffix), found: true };

  // Provider/import data can differ in case or punctuation. Use normalized
  // boundary checks as a fallback, while still requiring a whole-word match.
  if (allowPrefix && normalizedSegment.startsWith(`${normalizedCity} `)) {
    return { value: normalizedSegment.slice(normalizedCity.length).trim(), found: true };
  }
  if (normalizedSegment.endsWith(` ${normalizedCity}`)) {
    return { value: normalizedSegment.slice(0, -normalizedCity.length).trim(), found: true };
  }
  return { value: cleaned, found: false };
}

interface ParsedAddress {
  street: string;
  postalCode: string | null;
  locality: string | null;
  /** A trailing country marker is context, not part of the locality. */
  country: string | null;
  /** The unit qualifier parsed from the source address, if one was supplied. */
  unit: string | null;
  /** True when the locality was present in the original address text. */
  localityFromAddress: boolean;
  /** True when a postcode was present in the original address text. */
  postalCodeFromAddress: boolean;
}

/**
 * Parse both common Swedish layouts:
 *   "Bastugatan 48, 118 25 Stockholm"
 *   "Stockholm 11825 Bastugatan 48"
 *
 * Explicit city/postcode fields are authoritative. The raw address is still
 * used for the street, but conflicting embedded locality data is not allowed
 * to override structured import columns.
 */
function parseAddressInput(input: string | GeocodeInput): ParsedAddress {
  const raw = typeof input === "string"
    ? { address: input }
    : input && typeof input === "object"
      ? input
      : { address: "" };
  // Keep `raw.address` untouched for callers/import rows.  Unit qualifiers are
  // removed only from the provider-facing parsing representation.
  const sourceAddress = cleanAddress(raw?.address);
  const unitAddress = stripUnitQualifier(sourceAddress, raw?.unit);
  const country = unitAddress.address.match(COUNTRY_SUFFIX_PATTERN)?.[1] ?? null;
  const address = stripCountrySuffix(unitAddress.address).replace(POSTAL_CODE_PATTERN, "$1 $2 ");
  const explicitPostalCode = normalizePostalCode(raw?.postalCode);
  const explicitLocality = cleanSegment(raw?.city);
  const embeddedPostalMatch = address.match(POSTAL_CODE_PATTERN);
  const postalCodeFromAddress = Boolean(embeddedPostalMatch);
  const requestedPostalCode = explicitPostalCode || (
    embeddedPostalMatch ? `${embeddedPostalMatch[1]} ${embeddedPostalMatch[2]}` : null
  );

  if (!address) {
    return {
      street: "",
      postalCode: requestedPostalCode,
      locality: explicitLocality || null,
      country,
      unit: unitAddress.unit,
      localityFromAddress: false,
      postalCodeFromAddress,
    };
  }

  let street = address;
  let locality = explicitLocality || null;
  let localityFromAddress = false;

  if (embeddedPostalMatch?.index != null) {
    const beforePostal = cleanAddress(address.slice(0, embeddedPostalMatch.index));
    const afterPostal = cleanAddress(address.slice(embeddedPostalMatch.index + embeddedPostalMatch[0].length));
    const beforeWithoutLocality = explicitLocality
      ? stripLocality(beforePostal, explicitLocality)
      : { value: beforePostal, found: false };
    const afterWithoutLocality = explicitLocality
      ? stripLocality(afterPostal, explicitLocality)
      : { value: afterPostal, found: false };
    const beforeHasHouse = hasHouseNumber(beforeWithoutLocality.value);
    const afterHasHouse = hasHouseNumber(afterWithoutLocality.value);

    // A house-bearing side is the street. This is what distinguishes
    // "Stockholm 11825 Bastugatan 48" from the usual street-first layout.
    if (afterHasHouse && !beforeHasHouse) {
      street = afterWithoutLocality.value;
      if (!locality) locality = beforePostal || null;
      localityFromAddress = Boolean(beforePostal) || afterWithoutLocality.found;
    } else if (beforeHasHouse && !afterHasHouse) {
      street = beforeWithoutLocality.value;
      if (!locality) locality = afterPostal || null;
      localityFromAddress = Boolean(afterPostal) || beforeWithoutLocality.found;
    } else if (beforeHasHouse) {
      // If both sides look address-like, retain the deterministic
      // street-first interpretation rather than guessing a city.
      street = beforeWithoutLocality.value;
      localityFromAddress = afterWithoutLocality.found;
    } else if (afterHasHouse) {
      street = afterWithoutLocality.value;
      localityFromAddress = beforeWithoutLocality.found;
    } else {
      // A postcode-only address has no reliable street/locality ordering.
      // Keep the text intact and let provider evidence decide.
      street = cleanAddress([beforePostal, afterPostal].filter(Boolean).join(" "));
      localityFromAddress = beforeWithoutLocality.found || afterWithoutLocality.found;
    }
    if (explicitLocality && (beforeWithoutLocality.found || afterWithoutLocality.found)) {
      localityFromAddress = true;
    }
  } else if (explicitLocality) {
    // Without a postcode, a city-looking prefix can legitimately be part of
    // a street name (for example "Spånga Stationsplan"). Only strip a
    // structured locality suffix in this layout.
    const stripped = stripLocality(address, explicitLocality, false);
    if (stripped.found) {
      street = stripped.value || address;
    } else if (address.includes(",")) {
      // Structured import columns win when the address cell also contains a
      // conflicting locality, e.g. "Bastugatan 48, Kiruna" + city Stockholm.
      // Remove only a trailing non-house segment; never guess from a radius.
      const segments = address.split(",").map(cleanSegment).filter(Boolean);
      const first = segments[0] ?? "";
      const last = segments.at(-1) ?? "";
      if (segments.length > 1 && hasHouseNumber(first) && !hasHouseNumber(last)) {
        street = first;
        localityFromAddress = true;
      } else {
        street = address;
      }
    } else {
      street = address;
    }
  } else if (address.includes(",")) {
    const segments = address.split(",").map(cleanSegment).filter(Boolean);
    if (segments.length > 1) {
      street = segments[0];
      locality = segments.at(-1) ?? null;
      localityFromAddress = Boolean(locality);
    }
  }

  // A common manually typed form has neither postcode nor comma:
  // "Högsätravägen 4D Lidingö". The suffix is still a requested locality,
  // which must match provider evidence; it is not part of the street.
  if (!embeddedPostalMatch && !explicitLocality && !address.includes(",")) {
    const streetAndCity = address.match(new RegExp(
      `^([^\\d,]+?\\s+${HOUSE_NUMBER_TOKEN})\\s+([\\p{L}][\\p{L}\\s.'’()-]*)$`, "u",
    ));
    if (streetAndCity) {
      street = streetAndCity[1];
      locality = streetAndCity[2];
      localityFromAddress = true;
    }
  }

  return {
    street: normalizeStreetHouseSpacing(street),
    postalCode: requestedPostalCode,
    locality: locality ? cleanSegment(locality) : null,
    country,
    unit: unitAddress.unit,
    localityFromAddress,
    postalCodeFromAddress,
  };
}

/** Produces the canonical, human-readable provider query without duplicated locality parts. */
export function normalizeGeocodeInput(input: string | GeocodeInput): string {
  const parsed = parseAddressInput(input);
  if (!parsed.street) return "";
  const parts = [parsed.street];
  if (parsed.postalCode && parsed.locality && parsed.localityFromAddress && parsed.postalCodeFromAddress) {
    // Preserve the normal Swedish display form when the source already had
    // "postcode locality", while still canonicalizing a city-first address.
    parts.push(`${parsed.postalCode} ${parsed.locality}`);
  } else {
    if (parsed.postalCode) parts.push(parsed.postalCode);
    if (parsed.locality) parts.push(parsed.locality);
  }
  if (parsed.country) parts.push(parsed.country);
  return parts.join(", ");
}

function variants(input: string | GeocodeInput): string[] {
  const parsed = parseAddressInput(input);
  const full = normalizeGeocodeInput(input);
  const street = parsed.street || full;
  const city = parsed.locality || "";
  const streetWithoutHouseNumber = houseParts(street)?.street
    ?? street.replace(/\s+\d+[a-zA-Z]?(?:[-/]\d+[a-zA-Z]?)?\s*$/, "").trim();
  const broader = [
    [street, city].filter(Boolean).join(", "),
    [streetWithoutHouseNumber, city].filter(Boolean).join(", "),
    street,
  ];

  const unique = new Map<string, string>();
  for (const query of [full, ...broader]) {
    const cleaned = cleanAddress(query);
    if (cleaned) unique.set(cleaned.toLocaleLowerCase("sv-SE"), cleaned);
  }
  return [...unique.values()].slice(0, 3);
}

function normalizeKey(query: string, countryCode: string): string {
  return `${query.trim().toLowerCase().replace(/\s+/g, " ")}|${countryCode}`;
}

function geocodingFetchTimeoutMs(): number {
  const configured = Number(process.env.GEOCODING_FETCH_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_FETCH_TIMEOUT_MS;
  return Math.min(MAX_FETCH_TIMEOUT_MS, Math.max(1, configured));
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit = {},
): Promise<{ response: Response; data: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), geocodingFetchTimeoutMs());
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const data = await response.json() as T;
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function rateLimit(): Promise<void> {
  // Batch requests may resolve their Google calls concurrently. Keep all
  // Nominatim calls on one queue so the public-service rate limit is honored
  // even when several addresses fall back at the same time.
  const turn = nominatimQueue.then(async () => {
    const wait = lastRequest + RATE_LIMIT_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequest = Date.now();
  });
  nominatimQueue = turn.catch(() => undefined);
  await turn;
}

function cacheGet(key: string): GeocodeResult | undefined {
  const value = cache.get(key);
  if (!value) return undefined;
  if (value.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // Map insertion order gives us a small, allocation-free LRU.
  cache.delete(key);
  cache.set(key, value);
  return value.result;
}

function cacheSet(key: string, result: GeocodeResult): void {
  cache.delete(key);
  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function validCoordinates(latitude: unknown, longitude: unknown): latitude is number {
  return typeof latitude === "number" && typeof longitude === "number"
    && Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

interface AddressEvidence {
  street: string;
  houseNumber: string | null;
  postalCode: string | null;
  locality: string | null;
}

interface GoogleAreaPoint {
  latitude: number;
  longitude: number;
}

interface GoogleAreaBounds {
  northeast: GoogleAreaPoint;
  southwest: GoogleAreaPoint;
}

interface GoogleAreaEvidence {
  location?: GoogleAreaPoint;
  bounds?: GoogleAreaBounds;
  /** All locality/sublocality names supplied by the area result. */
  localities: string[];
}

interface LocalityAliasCandidate {
  candidate: GeocodeCandidate;
  /** Locality names on the address result, used to recognize provider aliases. */
  providerLocalities: string[];
}

function comparable(value: string): string {
  return value
    .toLocaleLowerCase("sv-SE")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function addressEvidence(query: string): AddressEvidence {
  const parsed = parseAddressInput(query);
  const postalCode = parsed.postalCode?.replace(/\D/g, "") ?? null;
  const house = houseParts(parsed.street);
  const houseNumber = house?.houseNumber.toLocaleLowerCase("sv-SE") ?? null;
  const street = comparable(house?.street ?? parsed.street);
  const locality = parsed.locality ? comparable(parsed.locality) : null;
  return { street, houseNumber, postalCode, locality };
}

function isFullPostalCode(postalCode: string | null): boolean {
  return Boolean(postalCode && /^\d{5}$/.test(postalCode));
}

function isStreetHouseMatch(
  query: string,
  addressLevel: boolean,
  resultStreet: string | null,
  resultHouseNumber: string | null,
): boolean {
  if (!addressLevel) return false;
  const requested = addressEvidence(query);
  if (!requested.street || !resultStreet || comparable(resultStreet) !== requested.street) return false;
  if (!requested.houseNumber || requested.houseNumber !== resultHouseNumber?.toLocaleLowerCase("sv-SE")) return false;
  return true;
}

function isStreetHousePostcodeMatch(
  query: string,
  addressLevel: boolean,
  resultStreet: string | null,
  resultHouseNumber: string | null,
  resultPostalCode: string | null,
): boolean {
  if (!isStreetHouseMatch(query, addressLevel, resultStreet, resultHouseNumber)) return false;
  const requested = addressEvidence(query);
  if (requested.postalCode && requested.postalCode !== resultPostalCode?.replace(/\D/g, "")) return false;
  return true;
}

function isVerifiedAddressMatch(
  query: string,
  addressLevel: boolean,
  resultStreet: string | null,
  resultHouseNumber: string | null,
  resultPostalCode: string | null,
  resultLocalities: string[],
): boolean {
  const requested = addressEvidence(query);
  if (!isStreetHouseMatch(query, addressLevel, resultStreet, resultHouseNumber)) return false;
  const localityMatches = Boolean(requested.locality
    && resultLocalities.some((value) => comparable(value) === requested.locality));
  if (requested.locality && !localityMatches) return false;
  const providerPostalCode = resultPostalCode?.replace(/\D/g, "") ?? null;
  if (requested.postalCode && requested.postalCode !== providerPostalCode) {
    // A postcode conflict is not a destination conflict when the provider
    // proves the same street, house and explicitly supplied locality.
    // Missing locality/postcode evidence stays manual. Each provider still
    // requires exactly one qualifying destination before returning a match.
    return localityMatches
      && isFullPostalCode(requested.postalCode)
      && isFullPostalCode(providerPostalCode);
  }
  return true;
}

function candidate(
  provider: "google" | "nominatim",
  providerId: string,
  latitude: number,
  longitude: number,
  displayName: string,
  partial: boolean,
): GeocodeCandidate {
  return { id: `${provider}:${providerId}`, latitude, longitude, displayName, source: provider, partial };
}

function logAttempt(query: string, fields: Record<string, unknown>): void {
  const queryFingerprint = createHmac("sha256", LOG_FINGERPRINT_KEY).update(query).digest("hex").slice(0, 16);
  logger.info({ event: "geocode_provider_attempt", queryFingerprint, ...fields }, "Geocoding provider attempt");
}

function googlePoint(value: unknown): GoogleAreaPoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const point = value as { lat?: unknown; lng?: unknown };
  return validCoordinates(point.lat, point.lng) && typeof point.lng === "number"
    ? { latitude: point.lat, longitude: point.lng }
    : undefined;
}

function googleBounds(value: unknown): GoogleAreaBounds | undefined {
  if (!value || typeof value !== "object") return undefined;
  const bounds = value as { northeast?: unknown; southwest?: unknown };
  const northeast = googlePoint(bounds.northeast);
  const southwest = googlePoint(bounds.southwest);
  return northeast && southwest ? { northeast, southwest } : undefined;
}

function localityComponentType(type: string): boolean {
  return type === "locality"
    || type === "postal_town"
    || type === "sublocality"
    || /^sublocality_level_[1-5]$/.test(type);
}

function isGoogleAreaResult(types: string[]): boolean {
  const disallowed = new Set([
    "street_address",
    "premise",
    "subpremise",
    "route",
    "establishment",
    "point_of_interest",
  ]);
  return types.some(localityComponentType) && !types.some((type) => disallowed.has(type));
}

function haversineMeters(first: GoogleAreaPoint, second: GoogleAreaPoint): number {
  const earthRadiusMeters = 6_371_000;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const latitude1 = radians(first.latitude);
  const latitude2 = radians(second.latitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function areaContainsCoordinate(area: GoogleAreaEvidence, latitude: number, longitude: number): boolean {
  const candidate = { latitude, longitude };
  if (area.bounds) {
    const minLatitude = Math.min(area.bounds.southwest.latitude, area.bounds.northeast.latitude);
    const maxLatitude = Math.max(area.bounds.southwest.latitude, area.bounds.northeast.latitude);
    const minLongitude = Math.min(area.bounds.southwest.longitude, area.bounds.northeast.longitude);
    const maxLongitude = Math.max(area.bounds.southwest.longitude, area.bounds.northeast.longitude);
    if (
      latitude >= minLatitude
      && latitude <= maxLatitude
      && longitude >= minLongitude
      && longitude <= maxLongitude
    ) {
      return true;
    }

    // Bounds can stop just short of a geocoder's address point at an area
    // border. A small, explicit margin is safer than treating locality names
    // as interchangeable across an entire postcode.
    const nearest = {
      latitude: Math.min(maxLatitude, Math.max(minLatitude, latitude)),
      longitude: Math.min(maxLongitude, Math.max(minLongitude, longitude)),
    };
    return haversineMeters(candidate, nearest) <= MAX_LOCALITY_AREA_PROXIMITY_METERS;
  }
  return area.location
    ? haversineMeters(candidate, area.location) <= MAX_LOCALITY_AREA_PROXIMITY_METERS
    : false;
}

function localityAreaCacheKey(locality: string, countryCode: string): string {
  return `${comparable(locality)}|${countryCode.trim().toLowerCase()}`;
}

function localityAreaCacheGet(key: string): GoogleAreaEvidence[] | undefined {
  const value = localityAreaCache.get(key);
  if (!value) return undefined;
  if (value.expiresAt <= Date.now()) {
    localityAreaCache.delete(key);
    return undefined;
  }
  localityAreaCache.delete(key);
  localityAreaCache.set(key, value);
  return value.areas;
}

function localityAreaCacheSet(key: string, areas: GoogleAreaEvidence[]): void {
  localityAreaCache.delete(key);
  localityAreaCache.set(key, { areas, expiresAt: Date.now() + CACHE_TTL_MS });
  while (localityAreaCache.size > MAX_LOCALITY_AREA_ENTRIES) {
    const oldestKey = localityAreaCache.keys().next().value;
    if (oldestKey === undefined) break;
    localityAreaCache.delete(oldestKey);
  }
}

async function googleLocalityArea(locality: string, countryCode: string): Promise<GoogleAreaEvidence[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return [];
  metrics.googleRequests++;
  const usageContext = getUsageContext();
  const started = Date.now();
  let usageOutcome = "failure";
  let httpStatus: number | undefined;
  let apiStatus: string | undefined;
  try {
    const params = new URLSearchParams({
      address: cleanSegment(locality),
      components: `country:${countryCode}`,
      key,
    });
    const { response, data } = await fetchJsonWithTimeout<{
      status?: string;
      results?: Array<{
        partial_match?: boolean;
        types?: string[];
        address_components?: Array<{ long_name?: string; types?: string[] }>;
        geometry?: {
          location?: unknown;
          bounds?: unknown;
          viewport?: unknown;
        };
      }>;
    }>(`${GOOGLE_GEOCODING_BASE}?${params}`);
    httpStatus = response.status;
    apiStatus = data.status;
    const unavailable = response.status === 429 || response.status >= 500
      || apiStatus === "OVER_QUERY_LIMIT" || apiStatus === "REQUEST_DENIED" || apiStatus === "UNKNOWN_ERROR";
    if (unavailable || !response.ok || apiStatus === "INVALID_REQUEST") {
      logAttempt(locality, {
        provider: "google",
        requestKind: "locality_area",
        httpStatus,
        apiStatus,
        durationMs: Date.now() - started,
        candidateCount: 0,
        outcome: unavailable ? "unavailable" : "invalid",
      });
      return [];
    }
    usageOutcome = "success";

    const areas = (data.results ?? []).flatMap((item) => {
      const types = item.types ?? [];
      // Keep every non-partial area result. Google may canonicalize a
      // requested locality (Hallunda -> Norsborg), so filtering by the
      // requested name here would discard the useful canonical area.
      if (item.partial_match === true || !isGoogleAreaResult(types)) return [];
      const localities = (item.address_components ?? [])
        .filter((component) =>
          (component.types ?? []).some(localityComponentType)
          && typeof component.long_name === "string")
        .flatMap((component) => component.long_name ? [component.long_name] : []);
      if (localities.length === 0) return [];
      const location = googlePoint(item.geometry?.location);
      const bounds = googleBounds(item.geometry?.bounds ?? item.geometry?.viewport);
      if (!location && !bounds) return [];
      return [{ localities, ...(location ? { location } : {}), ...(bounds ? { bounds } : {}) }];
    });
    // A provider may return the same area under multiple area-level types.
    // Keep geometrically distinct results so multiple genuine proofs remain
    // explicitly ambiguous instead of being silently selected.
    const uniqueAreas = [...new Map(areas.map((area) => [
      JSON.stringify(area),
      area,
    ])).values()];
    logAttempt(locality, {
      provider: "google",
      requestKind: "locality_area",
      httpStatus,
      apiStatus,
      durationMs: Date.now() - started,
      candidateCount: uniqueAreas.length,
      outcome: uniqueAreas.length === 1 ? "area_proof_available" : "area_proof_ambiguous_or_missing",
    });
    return uniqueAreas;
  } catch {
    logAttempt(locality, {
      provider: "google",
      requestKind: "locality_area",
      httpStatus,
      apiStatus,
      durationMs: Date.now() - started,
      candidateCount: 0,
      outcome: "unavailable",
    });
    return [];
  } finally {
    await recordGeocodingUsage(usageContext, "google", "google/locality_area", usageOutcome, {
      units: 1,
      durationMs: Date.now() - started,
    });
  }
}

async function localityAreas(locality: string, countryCode: string): Promise<GoogleAreaEvidence[]> {
  const key = `${servicePolicyCachePartition()}:${localityAreaCacheKey(locality, countryCode)}`;
  const cached = localityAreaCacheGet(key);
  if (cached) {
    await recordGeocodingUsage(getUsageContext(), "google", "google/locality_area", "cache_hit", {
      units: 0,
      cacheStatus: "cache",
    });
    return cached;
  }
  const existing = localityAreaInFlight.get(key);
  if (existing) {
    await recordGeocodingUsage(getUsageContext(), "google", "google/locality_area", "cache_hit", {
      units: 0,
      cacheStatus: "in_flight",
    });
    return existing;
  }

  let pending!: Promise<GoogleAreaEvidence[]>;
  pending = (async () => {
    try {
      const areas = await googleLocalityArea(locality, countryCode);
      localityAreaCacheSet(key, areas);
      return areas;
    } finally {
      if (localityAreaInFlight.get(key) === pending) {
        localityAreaInFlight.delete(key);
      }
    }
  })();
  localityAreaInFlight.set(key, pending);
  return pending;
}

async function provesLocalityAlias(
  query: string,
  alias: LocalityAliasCandidate,
  countryCode: string,
): Promise<boolean> {
  const requestedLocality = addressEvidence(query).locality;
  if (!requestedLocality) return false;
  const areas = await localityAreas(requestedLocality, countryCode);
  const candidate = alias.candidate;
  const acceptedNames = new Set([
    requestedLocality,
    ...alias.providerLocalities.map(comparable),
  ]);
  const nearbyMatchingAreas = areas.filter((area) =>
    areaContainsCoordinate(area, candidate.latitude, candidate.longitude)
    && area.localities.some((locality) => acceptedNames.has(comparable(locality))));
  // More than one nearby matching area is not a safe proof for an address.
  return nearbyMatchingAreas.length === 1;
}

async function google(query: string, countryCode: string, isBroad: boolean, retry = false): Promise<ProviderResponse> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return { state: "unavailable", exact: null, candidates: [], localityAliasCandidates: [] };
  metrics.googleRequests++;
  const usageContext = getUsageContext();
  const started = Date.now();
  let usageOutcome = "failure";
  let httpStatus: number | undefined;
  let apiStatus: string | undefined;
  try {
    const params = new URLSearchParams({ address: query, components: `country:${countryCode}`, key });
    const { response, data } = await fetchJsonWithTimeout<{
      status?: string;
      results?: Array<{
        place_id?: string;
        formatted_address?: string;
        partial_match?: boolean;
        types?: string[];
        address_components?: Array<{
          long_name?: string;
          short_name?: string;
          types?: string[];
        }>;
        geometry?: { location?: { lat?: unknown; lng?: unknown } };
      }>;
    }>(`${GOOGLE_GEOCODING_BASE}?${params}`);
    httpStatus = response.status;
    apiStatus = data.status;
    const unavailable = response.status === 429 || response.status >= 500
      || apiStatus === "OVER_QUERY_LIMIT" || apiStatus === "REQUEST_DENIED" || apiStatus === "UNKNOWN_ERROR";
    if (unavailable) {
      logAttempt(query, { provider: "google", httpStatus, apiStatus, durationMs: Date.now() - started, candidateCount: 0, outcome: "unavailable" });
      return { state: "unavailable", exact: null, candidates: [], localityAliasCandidates: [] };
    }
    if (!response.ok || apiStatus === "INVALID_REQUEST") {
      logAttempt(query, { provider: "google", httpStatus, apiStatus, durationMs: Date.now() - started, candidateCount: 0, outcome: "invalid" });
      return { state: "invalid", exact: null, candidates: [], localityAliasCandidates: [] };
    }
    usageOutcome = "success";
    const localityAliasCandidates: LocalityAliasCandidate[] = [];
    const candidates = (data.results ?? []).flatMap((item, index) => {
      const location = item.geometry?.location;
      const latitude = location?.lat;
      const longitude = location?.lng;
      if (typeof latitude !== "number" || typeof longitude !== "number" || !validCoordinates(latitude, longitude) || !item.formatted_address) return [];
      const component = (type: string) => item.address_components
        ?.find((part) => part.types?.includes(type));
      const components = (type: string) => (item.address_components ?? [])
        .filter((part) => part.types?.includes(type))
        .flatMap((part) => part.long_name ? [part.long_name] : []);
      const resultLocalities = [
        ...components("postal_town"),
        ...components("locality"),
        ...components("sublocality"),
        ...components("sublocality_level_1"),
      ];
      const addressLevel = (item.types ?? []).some((type) =>
        ["street_address", "premise", "subpremise", "establishment", "point_of_interest"].includes(type));
      // Google can flag a query as partial when its input ordering is unusual
      // (for example city-postcode-street). Ignore that flag only after local
      // evidence independently proves the exact street, house and locality
      // on an address-level result (a conflicting postcode may be tolerated).
      // A centroid or house mismatch
      // therefore remains a selectable partial candidate.
      const verified = !isBroad
        && isVerifiedAddressMatch(
          query,
          addressLevel,
          component("route")?.long_name ?? null,
          component("street_number")?.long_name ?? null,
          component("postal_code")?.long_name ?? null,
           resultLocalities,
        );
      const resultCandidate = candidate(
        "google",
        item.place_id ?? `${index}:${latitude}:${longitude}`,
        latitude,
        longitude,
        item.formatted_address,
        !verified,
      );
      const requested = addressEvidence(query);
      const addressLevelForAlias = (item.types ?? []).some((type) =>
        ["street_address", "premise", "subpremise"].includes(type));
      const localityMatches = Boolean(
        requested.locality
        && resultLocalities.some((value) => comparable(value) === requested.locality),
      );
      // Alias promotion is intentionally narrower than ordinary exact
      // matching: the provider must have supplied an independent, non-partial
      // address-level road/number/full-postcode result, with locality as the
      // sole mismatch. The area lookup below supplies the missing geography.
      if (
        !isBroad
        && item.partial_match !== true
        && addressLevelForAlias
        && isFullPostalCode(requested.postalCode)
        && isStreetHousePostcodeMatch(
          query,
          addressLevelForAlias,
          component("route")?.long_name ?? null,
          component("street_number")?.long_name ?? null,
          component("postal_code")?.long_name ?? null,
        )
        && Boolean(requested.locality)
        && resultLocalities.length > 0
        && !localityMatches
      ) {
        localityAliasCandidates.push({ candidate: resultCandidate, providerLocalities: resultLocalities });
      }
      return [resultCandidate];
    });
    const exactCandidates = uniqueCandidates(candidates.filter((item) => !item.partial));
    const exactCandidate = exactCandidates.length === 1 ? exactCandidates[0] : undefined;
    const exact = exactCandidate
      ? { latitude: exactCandidate.latitude, longitude: exactCandidate.longitude, displayName: exactCandidate.displayName, source: "google" as const, provider: "google" as const }
      : null;
    logAttempt(query, { provider: "google", httpStatus, apiStatus, durationMs: Date.now() - started, candidateCount: candidates.length, outcome: exact ? "matched" : "no_exact_match" });
    const uniqueAliasCandidates = [...new Map(localityAliasCandidates.map((item) => [
      `${item.candidate.latitude.toFixed(6)}:${item.candidate.longitude.toFixed(6)}`,
      item,
    ])).values()].slice(0, 5);
    return { state: "available", exact, candidates, localityAliasCandidates: uniqueAliasCandidates };
  } catch {
    logAttempt(query, { provider: "google", httpStatus, apiStatus, durationMs: Date.now() - started, candidateCount: 0, outcome: "unavailable" });
    return { state: "unavailable", exact: null, candidates: [], localityAliasCandidates: [] };
  } finally {
    await recordGeocodingUsage(usageContext, "google", "google/geocode", usageOutcome, {
      units: 1,
      durationMs: Date.now() - started,
      retry,
    });
  }
}

async function nominatim(query: string, countryCode: string, isBroad: boolean, retry = false): Promise<ProviderResponse> {
  metrics.nominatimRequests++;
  const usageContext = getUsageContext();
  let started = Date.now();
  let usageOutcome = "failure";
  let httpStatus: number | undefined;
  try {
    await rateLimit();
    started = Date.now();
    const url = `${NOMINATIM_BASE}/search?format=json&addressdetails=1&limit=5&countrycodes=${encodeURIComponent(countryCode)}&q=${encodeURIComponent(query)}`;
    const { response, data } = await fetchJsonWithTimeout<Array<{
      place_id?: number;
      osm_type?: string;
      osm_id?: number;
      lat?: string;
      lon?: string;
      display_name?: string;
      addresstype?: string;
      type?: string;
      address?: {
        house_number?: string;
        postcode?: string;
        road?: string;
        pedestrian?: string;
        path?: string;
        square?: string;
        city?: string;
        town?: string;
        village?: string;
        municipality?: string;
        suburb?: string;
        city_district?: string;
      };
    }>>(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "sv,en" } });
    httpStatus = response.status;
    if (!response.ok) {
      const state = response.status === 429 || response.status >= 500 ? "unavailable" : "invalid";
      logAttempt(query, { provider: "nominatim", httpStatus, durationMs: Date.now() - started, candidateCount: 0, outcome: state });
      return { state, exact: null, candidates: [], localityAliasCandidates: [] };
    }
    usageOutcome = "success";
    const candidates = (Array.isArray(data) ? data : []).flatMap((item, index) => {
      const latitude = Number(item.lat);
      const longitude = Number(item.lon);
      if (!validCoordinates(latitude, longitude) || !item.display_name) return [];
      const providerId = item.place_id?.toString() ?? `${item.osm_type ?? "place"}:${item.osm_id ?? index}:${latitude}:${longitude}`;
      const addressType = item.addresstype ?? item.type ?? "";
      const addressLevel = [
        "house",
        "building",
        "residential",
        "commercial",
        "industrial",
        "retail",
        "office",
        "shop",
        "amenity",
        "tourism",
        "healthcare",
      ].includes(addressType);
      const verified = !isBroad && isVerifiedAddressMatch(
        query,
        addressLevel,
        item.address?.road
          ?? item.address?.pedestrian
          ?? item.address?.path
          ?? item.address?.square
          ?? null,
        item.address?.house_number ?? null,
        item.address?.postcode ?? null,
        [
          item.address?.city,
          item.address?.town,
          item.address?.village,
          item.address?.municipality,
          item.address?.suburb,
          item.address?.city_district,
        ].filter((value): value is string => Boolean(value)),
      );
      return [candidate("nominatim", providerId, latitude, longitude, item.display_name, !verified)];
    });
    const exactCandidates = uniqueCandidates(candidates.filter((item) => !item.partial));
    const exactCandidate = exactCandidates.length === 1 ? exactCandidates[0] : undefined;
    const exact = exactCandidate
      ? { latitude: exactCandidate.latitude, longitude: exactCandidate.longitude, displayName: exactCandidate.displayName, source: "nominatim" as const, provider: "nominatim" as const }
      : null;
    logAttempt(query, { provider: "nominatim", httpStatus, durationMs: Date.now() - started, candidateCount: candidates.length, outcome: exact ? "matched" : "no_exact_match" });
    return { state: "available", exact, candidates, localityAliasCandidates: [] };
  } catch {
    logAttempt(query, { provider: "nominatim", httpStatus, durationMs: Date.now() - started, candidateCount: 0, outcome: "unavailable" });
    return { state: "unavailable", exact: null, candidates: [], localityAliasCandidates: [] };
  } finally {
    await recordGeocodingUsage(usageContext, "nominatim", "nominatim/search", usageOutcome, {
      units: 1,
      durationMs: Date.now() - started,
      retry,
    });
  }
}

async function providerQuery(
  provider: "google" | "nominatim",
  query: string,
  countryCode: string,
  isBroad: boolean,
  retry = false,
): Promise<ProviderResponse> {
  const selected = currentOrganizationServicePolicy().geocodingProvider;
  if (selected !== "inherit" && selected !== provider) throw new OrganizationServicePolicyError();
  // Broad queries are safe to share because they can only produce partial
  // candidates. Original-address verification remains local to each request.
  if (!isBroad) {
    return provider === "google"
      ? google(query, countryCode, false, retry)
      : nominatim(query, countryCode, false, retry);
  }

  const key = `${servicePolicyCachePartition()}:${provider}|${normalizeKey(query, countryCode)}`;
  const existing = broadProviderInFlight.get(key);
  if (existing) {
    await recordGeocodingUsage(getUsageContext(), provider, `${provider}/${provider === "google" ? "geocode" : "search"}`, "cache_hit", {
      units: 0,
      cacheStatus: "in_flight",
      retry,
    });
    return existing;
  }

  let pending!: Promise<ProviderResponse>;
  pending = (async () => {
    try {
      return provider === "google"
        ? await google(query, countryCode, true, retry)
        : await nominatim(query, countryCode, true, retry);
    } finally {
      if (broadProviderInFlight.get(key) === pending) {
        broadProviderInFlight.delete(key);
      }
    }
  })();
  broadProviderInFlight.set(key, pending);
  return pending;
}

function uniqueCandidates(candidates: GeocodeCandidate[]): GeocodeCandidate[] {
  return [...new Map(candidates.map((item) => [
    `${item.latitude.toFixed(6)}:${item.longitude.toFixed(6)}`,
    item,
  ])).values()].slice(0, 5);
}

async function geocodeDetailedUncached(
  queries: string[],
  query: string,
  country: string,
  cacheKey: string,
): Promise<DetailedGeocodeResult> {
  let providerAvailable = false;
  let invalidInput = false;
  const candidates: GeocodeCandidate[] = [];

  const selected = currentOrganizationServicePolicy().geocodingProvider;
  for (let index = 0; selected !== "nominatim" && index < queries.length; index++) {
    const providerResult = await providerQuery("google", queries[index], country, index > 0, index > 0);
    if (providerResult.state === "available") providerAvailable = true;
    if (providerResult.state === "invalid") invalidInput = true;
    candidates.push(...providerResult.candidates);
    if (providerResult.exact) {
      cacheSet(cacheKey, providerResult.exact);
      return { query, status: "matched", result: providerResult.exact, candidates: [] };
    }
    if (providerResult.localityAliasCandidates.length === 1) {
      const alias = providerResult.localityAliasCandidates[0];
      if (await provesLocalityAlias(query, alias, country)) {
        const aliasCandidate = alias.candidate;
        const promoted = {
          latitude: aliasCandidate.latitude,
          longitude: aliasCandidate.longitude,
          displayName: aliasCandidate.displayName,
          source: "google" as const,
          provider: "google" as const,
        };
        // This cache write is reached only after independent exact address
        // components and the bounded locality-area proof both succeeded.
        cacheSet(cacheKey, promoted);
        return { query, status: "matched", result: promoted, candidates: [] };
      }
    }
    // A partial result is already a safe, dispatcher-selectable candidate.
    // Do not spend time on a rate-limited fallback provider for it.
    if (providerResult.candidates.length > 0) {
      return { query, status: "candidates", result: null, candidates: uniqueCandidates(candidates) };
    }
    if (providerResult.state === "unavailable") break;
  }

  for (let index = 0; selected !== "google" && index < queries.length; index++) {
    const fallback = await providerQuery("nominatim", queries[index], country, index > 0, true);
    if (fallback.state === "available") providerAvailable = true;
    if (fallback.state === "invalid") invalidInput = true;
    candidates.push(...fallback.candidates);
    if (fallback.exact) {
      cacheSet(cacheKey, fallback.exact);
      return { query, status: "matched", result: fallback.exact, candidates: [] };
    }
    if (fallback.candidates.length > 0) {
      return { query, status: "candidates", result: null, candidates: uniqueCandidates(candidates) };
    }
    if (fallback.state === "unavailable") break;
  }

  const unique = uniqueCandidates(candidates);
  const status = unique.length
    ? "candidates"
    : providerAvailable
      ? "not_found"
      : invalidInput
        ? "invalid_input"
        : "provider_unavailable";
  return { query, status, result: null, candidates: unique };
}

/** Reuse only existing provider-verified evidence; never trigger a lookup or
 * replace a dispatcher-selected import position just to enable navigation. */
export async function getCachedVerifiedGeocode(input: string | GeocodeInput, countryCode = "se"): Promise<GeocodeResult | null> {
  const policy = await ensureOrganizationServicePolicy();
  if (policy.geocodingProvider === "disabled") return null;
  const query = variants(input)[0] ?? "";
  const country = countryCode.trim().toLowerCase();
  if (!query || !country) return null;
  return cacheGet(`${servicePolicyCachePartition()}:${normalizeKey(query, country)}`) ?? null;
}

export async function geocodeDetailed(input: string | GeocodeInput, countryCode = "se"): Promise<DetailedGeocodeResult> {
  const policy = await ensureOrganizationServicePolicy();
  if (policy.geocodingProvider === "disabled") throw new OrganizationServicePolicyError();
  const usageContext = getUsageContext();
  const country = countryCode.trim().toLowerCase();
  const queries = variants(input);
  const query = queries[0] ?? "";
  metrics.requests++;
  if (!query || !country) {
    const invalid = { query, status: "invalid_input" as const, result: null, candidates: [] };
    metrics.statusCounts[invalid.status]++;
    return invalid;
  }
  const cacheKey = `${servicePolicyCachePartition()}:${normalizeKey(query, country)}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    metrics.cacheHits++;
    await recordGeocodingUsage(usageContext, cached.provider, `${cached.provider}/${cached.provider === "google" ? "geocode" : "search"}`, "cache_hit", {
      units: 0,
      cacheStatus: "cache",
    });
    const result = { query, status: "matched" as const, result: { ...cached, source: "cache" as const }, candidates: [] };
    metrics.statusCounts[result.status]++;
    return result;
  }
  metrics.cacheMisses++;

  const existing = inFlight.get(cacheKey);
  if (existing) {
    metrics.inFlightHits++;
    await recordGeocodingUsage(usageContext, "google", "google/geocode", "cache_hit", {
      units: 0,
      cacheStatus: "in_flight",
    });
    const result = await existing;
    metrics.statusCounts[result.status]++;
    return result;
  }

  const pending = geocodeDetailedUncached(queries, query, country, cacheKey);
  inFlight.set(cacheKey, pending);
  try {
    const result = await pending;
    metrics.statusCounts[result.status]++;
    return result;
  } finally {
    if (inFlight.get(cacheKey) === pending) {
      inFlight.delete(cacheKey);
    }
  }
}

/** Backward-compatible exact-match-only API for existing callers. */
export async function geocodeAddress(address: string, countryCode = "se"): Promise<GeocodeResult | null> {
  return (await geocodeDetailed(address, countryCode)).result;
}

export async function reverseGeocode(latitude: number, longitude: number): Promise<string | null> {
  const policy = await ensureOrganizationServicePolicy();
  if (!["inherit", "nominatim"].includes(policy.geocodingProvider)) throw new OrganizationServicePolicyError();
  await rateLimit();
  const usageContext = getUsageContext();
  const started = Date.now();
  let usageOutcome = "failure";
  try {
    const url = `${NOMINATIM_BASE}/reverse?format=json&lat=${latitude}&lon=${longitude}`;
    const { response: res, data } = await fetchJsonWithTimeout<{ display_name?: string }>(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "sv,en" },
    });
    if (!res.ok) return null;
    usageOutcome = "success";
    return data.display_name ?? null;
  } catch {
    return null;
  } finally {
    await recordGeocodingUsage(usageContext, "nominatim", "nominatim/reverse", usageOutcome, {
      units: 1,
      durationMs: Date.now() - started,
    });
  }
}
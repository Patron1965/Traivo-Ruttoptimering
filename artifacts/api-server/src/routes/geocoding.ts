import { Router, type IRouter } from "express";
import { geocodeDetailed, getGeocodingMetrics, normalizeGeocodeInput, reverseGeocode, type GeocodeInput } from "../services/geocoding";
import { handleError } from "../lib/errors";
import { logger } from "../lib/logger";
import { requireRole } from "../middleware/auth";

const router: IRouter = Router();
// This router is mounted at the API root. Scope the role guard to geocoding
// paths so it cannot block unrelated driver writes mounted after this router.
router.use("/geocode", requireRole("admin", "dispatcher"));

function nonMatchStatus(status: string): number {
  return status === "provider_unavailable" ? 503 : status === "invalid_input" ? 400 : 404;
}

router.get("/geocode", async (req, res): Promise<void> => {
  try {
    const address = req.query.address;
    const country = typeof req.query.country === "string" ? req.query.country : "se";
    if (typeof address !== "string") {
      res.status(400).json({ error: "address parameter required", code: "invalid_input", status: "invalid_input", query: "", candidates: [] });
      return;
    }
    const detailed = await geocodeDetailed(address, country);
    if (detailed.status !== "matched") {
      res.status(nonMatchStatus(detailed.status)).json({ error: "Address not found", code: detailed.status, status: detailed.status, query: detailed.query, candidates: detailed.candidates });
      return;
    }
    res.json(detailed.result);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/geocode/reverse", async (req, res): Promise<void> => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      res.status(400).json({ error: "lat and lon required" });
      return;
    }
    const displayName = await reverseGeocode(lat, lon);
    if (!displayName) {
      res.status(404).json({ error: "Location not found" });
      return;
    }
    res.json({ latitude: lat, longitude: lon, displayName });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/geocode/metrics", async (_req, res): Promise<void> => {
  res.json(getGeocodingMetrics());
});

router.post("/geocode/batch", async (req, res): Promise<void> => {
  try {
    const addresses = req.body?.addresses as unknown;
    const country = typeof req.body?.country === "string" ? req.body.country : "se";
    if (!Array.isArray(addresses) || addresses.length === 0) {
      res.status(400).json({ error: "addresses array required" });
      return;
    }
    if (addresses.length > 50) {
      res.status(400).json({ error: "Maximum 50 addresses per batch" });
      return;
    }
    const structuredIds = addresses.flatMap((item) =>
      item && typeof item === "object" && "id" in item && typeof item.id === "string"
        ? [item.id.trim()]
        : []);
    const duplicateIds = new Set(structuredIds.filter((id, index) =>
      id.length > 0 && structuredIds.indexOf(id) !== index));

    const uniqueRequests = new Map<string, Promise<Awaited<ReturnType<typeof geocodeDetailed>>>>();
    const startedAt = Date.now();
    const metricsBefore = getGeocodingMetrics();
    let validRequestCount = 0;
    const results = await Promise.all(addresses.map(async (item) => {
      const legacy = typeof item === "string";
      const objectItem = !legacy && item && typeof item === "object"
        ? item as Record<string, unknown>
        : null;
      const id = typeof objectItem?.id === "string" ? objectItem.id.trim() : undefined;
      const address = legacy ? item : objectItem?.address;
      const postalCode = objectItem?.postalCode;
      const city = objectItem?.city;
      const validStructuredId = legacy || Boolean(id && !duplicateIds.has(id));
      const validInput = validStructuredId
        && typeof address === "string"
        && address.trim().length > 0
        && (postalCode === undefined || typeof postalCode === "string")
        && (city === undefined || typeof city === "string");
      if (validInput) validRequestCount++;
      const structured: GeocodeInput = {
        address: typeof address === "string" ? address : "",
        ...(typeof postalCode === "string" ? { postalCode } : {}),
        ...(typeof city === "string" ? { city } : {}),
      };
      const detailed = validInput
        ? await (async () => {
          const key = `${normalizeGeocodeInput(structured).toLocaleLowerCase("sv-SE")}|${country.toLowerCase()}`;
          const existing = uniqueRequests.get(key);
          if (existing) return existing;
          const pending = geocodeDetailed(structured, country);
          uniqueRequests.set(key, pending);
          return pending;
        })()
        : { query: "", status: "invalid_input" as const, result: null, candidates: [] };
      return {
        ...(id ? { id } : {}),
        address: structured.address,
        query: detailed.query,
        status: detailed.status,
        result: detailed.result,
        candidates: detailed.candidates,
      };
    }));
    const metrics = getGeocodingMetrics();
    const statusCounts = Object.fromEntries(
      Object.entries(metrics.statusCounts).map(([status, count]) => [
        status,
        count - metricsBefore.statusCounts[status as keyof typeof metricsBefore.statusCounts],
      ]),
    ) as typeof metrics.statusCounts;
    const batchMetrics = {
      requested: addresses.length,
      valid: validRequestCount,
      unique: uniqueRequests.size,
      deduplicated: Math.max(0, validRequestCount - uniqueRequests.size),
      durationMs: Date.now() - startedAt,
      cacheHits: metrics.cacheHits - metricsBefore.cacheHits,
      providerRequests: {
        google: metrics.googleRequests - metricsBefore.googleRequests,
        nominatim: metrics.nominatimRequests - metricsBefore.nominatimRequests,
      },
      statusCounts,
    };
    logger.info({ event: "geocode_batch_complete", ...batchMetrics }, "Geocoding batch complete");
    res.json({
      results,
      metrics: batchMetrics,
    });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
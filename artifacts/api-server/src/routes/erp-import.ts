import { Router, type IRouter } from "express";
import { db, customersTable, stopsTable } from "@workspace/db";
import { handleError } from "../lib/errors";
import { geocodeAddress } from "../services/geocoding";
import { enqueue, getJob, registerHandler, listJobs } from "../services/job-queue";
import { assertOrgScope, getOrgId } from "../middleware/auth";
import { applyVerifiedNavigationDestination } from "../services/stop-service";

const router: IRouter = Router();

interface OrderImportRow {
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  address: string;
  latitude?: number;
  longitude?: number;
  pickupAddress?: string;
  pickupLatitude?: number;
  pickupLongitude?: number;
  weightKg?: number;
  volumeM3?: number;
  serviceMin?: number;
  timeWindowStart?: string;
  timeWindowEnd?: string;
  notes?: string;
  externalRef?: string;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else { cur += ch; }
    } else {
      if (ch === ',') { out.push(cur); cur = ""; }
      else if (ch === '"' && cur === "") { inQuotes = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text: string): OrderImportRow[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const allLines: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of normalized) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === '\n' && !inQuotes) { allLines.push(cur); cur = ""; }
    else { cur += ch; }
  }
  if (cur.trim()) allLines.push(cur);
  const lines = allLines.filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: OrderImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = cells[idx] ?? ""; });
    if (!obj.address) continue;
    rows.push({
      customerName: obj.customerName || obj.customer_name,
      customerEmail: obj.customerEmail || obj.customer_email,
      customerPhone: obj.customerPhone || obj.customer_phone,
      address: obj.address,
      latitude: obj.latitude ? parseFloat(obj.latitude) : undefined,
      longitude: obj.longitude ? parseFloat(obj.longitude) : undefined,
      pickupAddress: obj.pickupAddress || obj.pickup_address || undefined,
      pickupLatitude: obj.pickupLatitude || obj.pickup_latitude ? parseFloat(obj.pickupLatitude || obj.pickup_latitude) : undefined,
      pickupLongitude: obj.pickupLongitude || obj.pickup_longitude ? parseFloat(obj.pickupLongitude || obj.pickup_longitude) : undefined,
      weightKg: obj.weightKg || obj.weight_kg ? parseFloat(obj.weightKg || obj.weight_kg) : undefined,
      volumeM3: obj.volumeM3 || obj.volume_m3 ? parseFloat(obj.volumeM3 || obj.volume_m3) : undefined,
      serviceMin: obj.serviceMin || obj.service_min ? parseInt(obj.serviceMin || obj.service_min) : undefined,
      timeWindowStart: obj.timeWindowStart || obj.time_window_start,
      timeWindowEnd: obj.timeWindowEnd || obj.time_window_end,
      notes: obj.notes,
      externalRef: obj.externalRef || obj.external_ref,
    });
  }
  return rows;
}

interface ImportPayload {
  organizationId: string;
  rows: OrderImportRow[];
}

interface ImportResult {
  total: number;
  created: number;
  geocoded: number;
  failed: number;
  errors: Array<{ row: number; address: string; error: string }>;
}

registerHandler<ImportPayload, ImportResult>("erp-import", async (payload, job) => {
  const result: ImportResult = { total: payload.rows.length, created: 0, geocoded: 0, failed: 0, errors: [] };

  for (let i = 0; i < payload.rows.length; i++) {
    const row = payload.rows[i];
    try {
      const geo = row.address ? await geocodeAddress(row.address) : null;
      let lat = geo?.latitude ?? row.latitude;
      let lon = geo?.longitude ?? row.longitude;
      if (geo) {
        result.geocoded++;
      }
      if (lat == null || lon == null) {
        result.failed++;
        result.errors.push({ row: i + 1, address: row.address, error: "Could not geocode" });
        continue;
      }

      let customerId: string | null = null;
      if (row.customerEmail || row.customerName) {
        const [cust] = await db
          .insert(customersTable)
          .values({
            organizationId: payload.organizationId,
            name: row.customerName || row.customerEmail || "Unknown",
            email: row.customerEmail || null,
            phone: row.customerPhone || null,
            address: row.address,
          })
          .returning({ id: customersTable.id });
        customerId = cust?.id ?? null;
      }

      let pickupLat = row.pickupLatitude;
      let pickupLon = row.pickupLongitude;
      if (row.pickupAddress && (pickupLat == null || pickupLon == null)) {
        const pickupGeo = await geocodeAddress(row.pickupAddress);
        if (pickupGeo) {
          pickupLat = pickupGeo.latitude;
          pickupLon = pickupGeo.longitude;
          result.geocoded++;
        }
      }

      const stopToInsert: Record<string, unknown> = {
        organizationId: payload.organizationId,
        customerId,
        address: row.address,
        latitude: lat,
        longitude: lon,
        pickupAddress: row.pickupAddress ?? null,
        pickupLatitude: pickupLat ?? null,
        pickupLongitude: pickupLon ?? null,
        weightKg: row.weightKg ?? null,
        volumeM3: row.volumeM3 ?? null,
        serviceDurationMin: row.serviceMin ?? null,
        timeWindowStart: row.timeWindowStart ? new Date(row.timeWindowStart) : null,
        timeWindowEnd: row.timeWindowEnd ? new Date(row.timeWindowEnd) : null,
        notes: row.notes ?? null,
        contactName: row.customerName ?? null,
        contactEmail: row.customerEmail ?? null,
        contactPhone: row.customerPhone ?? null,
        externalRef: row.externalRef ?? null,
        status: "pending",
        sequenceOrder: 0,
      };
      if (geo) applyVerifiedNavigationDestination(stopToInsert, geo);
      await db.insert(stopsTable).values(stopToInsert as typeof stopsTable.$inferInsert);
      result.created++;
    } catch (err: unknown) {
      result.failed++;
      result.errors.push({
        row: i + 1,
        address: row.address,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (i % 10 === 0 && job.id) {
      // small breath to avoid blocking
      await new Promise((r) => setImmediate(r));
    }
  }

  console.log(`[ERP] Import job ${job.id} complete:`, result);
  return result;
});

router.post("/import/orders", async (req, res) => {
  try {
    const { organizationId: requestedOrganizationId, format, content, rows } = req.body ?? {};
    const organizationId = assertOrgScope(req, requestedOrganizationId);
    let importRows: OrderImportRow[] = [];
    if (format === "csv" && typeof content === "string") {
      importRows = parseCsv(content);
    } else if (Array.isArray(rows)) {
      importRows = rows as OrderImportRow[];
    } else {
      res.status(400).json({ error: "Provide either { format: 'csv', content } or { rows: [...] }" });
      return;
    }
    if (importRows.length === 0) {
      res.status(400).json({ error: "No rows to import" });
      return;
    }
    if (importRows.length > 1000) {
      res.status(400).json({ error: "Maximum 1000 rows per import" });
      return;
    }

    const job = enqueue<ImportPayload>("erp-import", { organizationId, rows: importRows }, { organizationId });
    res.status(202).json({ jobId: job.id, status: job.status, total: importRows.length });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/import/jobs/:id", async (req, res) => {
  try {
    const job = getJob(req.params.id);
    if (!job || job.organizationId !== getOrgId(req)) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(job);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/import/jobs", async (req, res) => {
  try {
    const organizationId = getOrgId(req);
    const status = req.query.status as ("queued" | "running" | "completed" | "failed") | undefined;
    const jobs = listJobs({ organizationId, status, type: "erp-import" });
    res.json(jobs.slice(0, 50));
  } catch (err) {
    handleError(res, err);
  }
});

export default router;

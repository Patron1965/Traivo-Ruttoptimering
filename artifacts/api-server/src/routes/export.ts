import { Router, type IRouter, type Request, type Response } from "express";
import JSZip from "jszip";
import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  db,
  deliveryProofsTable,
  driversTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import { assertOrgScope, requireAuth } from "../middleware/auth";
import { handleError } from "../lib/errors";
import { collectOrgData, TABLE_DESCRIPTIONS } from "../lib/export-service";
import { toCsv } from "../lib/csv";
import { logExportEvent } from "../lib/security-log";
import { ObjectStorageService } from "../lib/objectStorage";
import * as fieldService from "../services/field-service";
import { calculateSustainabilityStats } from "../services/sustainability";
import { buildEnvironmentReportPdf } from "../lib/environment-report-pdf";
import {
  buildRoutePlanWorkbook,
  ROUTE_PLAN_XLSX_CONTENT_TYPE,
  type WorkbookRow,
} from "../lib/route-plan-xlsx";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();
const MAX_REPORT_ROWS = 50_000;
const MAX_PROOF_ARCHIVE_FILES = 100;
const MAX_PROOF_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ENVIRONMENT_REPORT_ROUTES = 10_000;
const MAX_ENVIRONMENT_REPORT_STOPS = 100_000;
const STOP_STATUSES = ["pending", "in_progress", "completed", "failed", "skipped"] as const;
type ExportType = "stops" | "routes" | "routePlan" | "proofs" | "billing" | "environment";

class ProofArchiveError extends Error {
  constructor(
    message: string,
    readonly statusCode: 413 | 422,
  ) {
    super(message);
    this.name = "ProofArchiveError";
  }
}

class RoutePlanExportSizeError extends Error {
  readonly statusCode = 413;

  constructor(message: string) {
    super(message);
    this.name = "RoutePlanExportSizeError";
  }
}

function buildReadme(data: Awaited<ReturnType<typeof collectOrgData>>): string {
  const lines = [
    "Traivo Route — Organisationsexport",
    `Genererad: ${data.generatedAt}`,
    `Organisations-ID: ${data.organizationId}`,
    "",
    "Denna export innehåller en CSV-fil per datatabell. Varje fil har en",
    "rubrikrad med kolumnnamn. JSON-kolumner är JSON-kodade i cellerna.",
    "Lösenord och åtkomsttoken är medvetet exkluderade.",
    "",
    "Filer:",
  ];
  for (const [name, rows] of Object.entries(data.tables)) {
    const desc = TABLE_DESCRIPTIONS[name] ?? "";
    lines.push(`  ${name}.csv (${rows.length} rader) — ${desc}`);
  }
  return lines.join("\n");
}

function firstQueryValue(value: unknown): string | undefined {
  return Array.isArray(value) ? value[0] : typeof value === "string" ? value : undefined;
}

function parseOptionalDate(value: unknown, inclusiveEndOfDay = false): Date | undefined {
  const raw = firstQueryValue(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date filter");
  if (inclusiveEndOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}

function getSelectedStatuses(value: unknown): (typeof STOP_STATUSES)[number][] {
  const raw = firstQueryValue(value);
  if (!raw) return [];
  const statuses = raw.split(",").filter(Boolean);
  if (!statuses.every((status) => STOP_STATUSES.includes(status as (typeof STOP_STATUSES)[number]))) {
    throw new Error("Invalid stop status filter");
  }
  return statuses as (typeof STOP_STATUSES)[number][];
}

function setDownloadHeaders(
  res: Response,
  filename: string,
  contentType: string,
) {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
}

function fileExtension(contentType: unknown): string {
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
  };
  return typeof contentType === "string" ? (extensions[contentType] ?? "bin") : "bin";
}

async function logReportExport(
  req: Request,
  organizationId: string,
  type: ExportType,
  format: "json" | "csv" | "pdf" | "xlsx",
  resultCount: number,
  from: Date | undefined,
  to: Date | undefined,
  statuses: (typeof STOP_STATUSES)[number][],
) {
  await logExportEvent({
    req,
    action: `org.${type}_export`,
    resourceType: "organization",
    resourceId: organizationId,
    statusCode: 200,
    diff: {
      exportType: { to: type },
      format: { to: format },
      filters: {
        to: {
          from: from?.toISOString() ?? null,
          to: to?.toISOString() ?? null,
          statuses,
        },
      },
      resultCount: { to: resultCount },
    },
  });
}

async function exportStops(
  organizationId: string,
  from: Date | undefined,
  to: Date | undefined,
  statuses: (typeof STOP_STATUSES)[number][],
) {
  const conditions = [eq(stopsTable.organizationId, organizationId)];
  if (from) conditions.push(gte(stopsTable.createdAt, from));
  if (to) conditions.push(lte(stopsTable.createdAt, to));
  if (statuses.length) conditions.push(inArray(stopsTable.status, statuses));

  const stops = await db
    .select()
    .from(stopsTable)
    .where(and(...conditions))
    .orderBy(desc(stopsTable.createdAt))
    .limit(MAX_REPORT_ROWS);

  return stops.map((stop) => ({
    stopId: stop.id,
    externalReference: stop.externalRef,
    trackingCode: stop.trackingCode,
    status: stop.status,
    jobType: stop.jobType,
    address: stop.address,
    pickupAddress: stop.pickupAddress,
    routeId: stop.routeId,
    sequence: stop.sequenceOrder,
    timeWindowStart: stop.timeWindowStart,
    timeWindowEnd: stop.timeWindowEnd,
    serviceDurationMin: stop.serviceDurationMin,
    weightKg: stop.weightKg,
    volumeM3: stop.volumeM3,
    contactName: stop.contactName,
    contactEmail: stop.contactEmail,
    contactPhone: stop.contactPhone,
    serviceCategory: stop.serviceCategory,
    slaDeadline: stop.slaDeadline,
    terminalAt: stop.terminalAt,
    createdAt: stop.createdAt,
  }));
}

async function exportRoutes(organizationId: string, from?: Date, to?: Date) {
  const conditions = [eq(routesTable.organizationId, organizationId)];
  if (from) conditions.push(gte(routesTable.date, from));
  if (to) conditions.push(lte(routesTable.date, to));

  const [routes, vehicles, drivers] = await Promise.all([
    db.select().from(routesTable).where(and(...conditions)).orderBy(desc(routesTable.date)).limit(MAX_REPORT_ROWS),
    db.select().from(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId)),
    db.select().from(driversTable).where(eq(driversTable.organizationId, organizationId)),
  ]);
  const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const driverByVehicleId = new Map(
    drivers.filter((driver) => driver.vehicleId).map((driver) => [driver.vehicleId!, driver.name]),
  );

  return routes.map((route) => {
    const vehicle = route.vehicleId ? vehicleById.get(route.vehicleId) : undefined;
    return {
      routeId: route.id,
      routeName: route.name,
      date: route.date,
      status: route.status,
      vehicle: vehicle?.name ?? "",
      licensePlate: vehicle?.licensePlate ?? "",
      driver: route.vehicleId ? (driverByVehicleId.get(route.vehicleId) ?? "") : "",
      stopCount: route.totalStops,
      distanceKm: route.totalDistanceKm,
      durationMin: route.totalDurationMin,
      co2EmissionsKg: route.co2EmissionsKg,
      manualReviewRequired: route.manualReviewRequired,
      planRevision: route.planRevision,
    };
  });
}

const ROUTE_COLUMNS = [
  "Plan-ID", "Rutt-ID", "Rutt", "Datum", "Status", "Fordon", "Registreringsnummer",
  "Förare", "Antal stopp", "Sträcka (km)", "Varaktighet (min)", "CO₂ (kg)",
];
const STOP_COLUMNS = [
  "Plan-ID", "Rutt-ID", "Rutt", "Datum", "Förare", "Fordon", "Registreringsnummer",
  "Stoppordning", "Orderreferens", "Spårningskod", "Shopify order-ID", "Shopify ordernamn",
  "Källrad i importfil",
  "Typ", "Adress", "Upphämtningsadress", "Tidsfönster från",
  "Tidsfönster till", "Planerad ankomst", "Planerad avgång", "Servicetid (min)",
  "Vikt (kg)", "Volym (m³)", "Mottagare", "Telefon", "E-post", "Anteckningar",
  "Servicekategori", "Serviceinstruktioner", "Prioritet", "SLA-senast",
  "Krav på kompetenser", "Krav på certifieringar", "Krav på utrustning", "Status",
];
const UNPLANNED_COLUMNS = [
  "Orderreferens", "Spårningskod", "Shopify order-ID", "Shopify ordernamn", "Typ",
  "Källrad i importfil",
  "Adress", "Upphämtningsadress", "Tidsfönster från",
  "Tidsfönster till", "Servicetid (min)", "Vikt (kg)", "Volym (m³)", "Mottagare",
  "Telefon", "E-post", "Anteckningar", "Servicekategori", "Serviceinstruktioner",
  "Prioritet", "SLA-senast", "Krav på kompetenser", "Krav på certifieringar",
  "Krav på utrustning", "Status", "Orsak",
];

function svDateTime(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function svDate(value: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(value);
}

function stopType(value: string): string {
  if (value === "pickup_delivery") return "Hämtning och leverans";
  if (value === "field_service") return "Fältservice";
  return "Leverans";
}

function customFields(
  row: typeof stopsTable.$inferSelect,
  reservedColumns: readonly string[],
): WorkbookRow {
  return Object.fromEntries(
    Object.entries(row.customFields ?? {}).map(([key, value]) => [
      reservedColumns.includes(key) ? `Kundfält: ${key}` : key,
      value,
    ]),
  );
}

async function exportRoutePlanXlsx(
  organizationId: string,
  filters: { planId?: string; routeId?: string; from?: Date; to?: Date },
): Promise<{ buffer: Buffer; rowCount: number; filenameDate: string }> {
  const routeConditions = [eq(routesTable.organizationId, organizationId)];
  if (filters.planId) routeConditions.push(eq(routesTable.planId, filters.planId));
  if (filters.routeId) routeConditions.push(eq(routesTable.id, filters.routeId));
  if (filters.from) routeConditions.push(gte(routesTable.date, filters.from));
  if (filters.to) routeConditions.push(lte(routesTable.date, filters.to));
  const routes = await db.select().from(routesTable)
    .where(and(...routeConditions)).orderBy(asc(routesTable.date), asc(routesTable.name))
    .limit(MAX_REPORT_ROWS + 1);
  if (routes.length > MAX_REPORT_ROWS) {
    throw new RoutePlanExportSizeError(
      `Exporten innehåller fler än ${MAX_REPORT_ROWS} rutter. Välj en kortare period.`,
    );
  }

  const [vehicles, drivers, plannedStops] = await Promise.all([
    db.select().from(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId)),
    db.select().from(driversTable).where(eq(driversTable.organizationId, organizationId)),
    routes.length > 0
      ? db.select().from(stopsTable).where(and(
        eq(stopsTable.organizationId, organizationId),
        inArray(stopsTable.routeId, routes.map((route) => route.id)),
      )).orderBy(asc(stopsTable.sequenceOrder)).limit(MAX_REPORT_ROWS + 1)
      : Promise.resolve([]),
  ]);
  if (plannedStops.length > MAX_REPORT_ROWS) {
    throw new RoutePlanExportSizeError(
      `Exporten innehåller fler än ${MAX_REPORT_ROWS} planerade stopp. Välj en enskild rutt eller kortare period.`,
    );
  }
  const includeUnplanned = Boolean(filters.planId || (!filters.routeId && filters.from));
  const unplannedConditions = [
    eq(stopsTable.organizationId, organizationId),
    isNull(stopsTable.routeId),
  ];
  if (filters.planId) {
    unplannedConditions.push(eq(stopsTable.planningPlanId, filters.planId));
  } else if (filters.from) {
    unplannedConditions.push(gte(stopsTable.planningDate, filters.from));
    if (filters.to) unplannedConditions.push(lte(stopsTable.planningDate, filters.to));
  }
  const unplannedStops = includeUnplanned
    ? await db.select().from(stopsTable).where(and(...unplannedConditions))
      .orderBy(asc(stopsTable.createdAt)).limit(MAX_REPORT_ROWS + 1)
    : [];
  if (unplannedStops.length > MAX_REPORT_ROWS) {
    throw new RoutePlanExportSizeError(
      `Exporten innehåller fler än ${MAX_REPORT_ROWS} ej planerade stopp. Välj en kortare period.`,
    );
  }
  if (routes.length === 0 && unplannedStops.length === 0) {
    throw new Error("No routes or unplanned stops matched the selected plan or date.");
  }
  const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const driverById = new Map(drivers.map((driver) => [driver.id, driver]));
  const driverByVehicleId = new Map(
    drivers.filter((driver) => driver.vehicleId).map((driver) => [driver.vehicleId!, driver]),
  );
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const itineraryByRoute = new Map(routes.map((route) => [
    route.id,
    new Map((route.plannerItinerary ?? []).map((item) => [item.stopId, item])),
  ]));

  const routeRows: WorkbookRow[] = routes.map((route) => {
    const vehicle = route.vehicleId ? vehicleById.get(route.vehicleId) : undefined;
    const driver = (route.handoffDriverId ? driverById.get(route.handoffDriverId) : undefined)
      ?? (route.vehicleId ? driverByVehicleId.get(route.vehicleId) : undefined);
    return {
      "Plan-ID": route.planId,
      "Rutt-ID": route.id,
      "Rutt": route.name,
      "Datum": svDate(route.date),
      "Status": route.status,
      "Fordon": vehicle?.name ?? "",
      "Registreringsnummer": vehicle?.licensePlate ?? "",
      "Förare": driver?.name ?? "",
      "Antal stopp": route.totalStops,
      "Sträcka (km)": route.totalDistanceKm,
      "Varaktighet (min)": route.totalDurationMin,
      "CO₂ (kg)": route.co2EmissionsKg,
    };
  });
  const plannedRows: WorkbookRow[] = plannedStops.map((stop) => {
    const route = stop.routeId ? routeById.get(stop.routeId) : undefined;
    const vehicle = route?.vehicleId ? vehicleById.get(route.vehicleId) : undefined;
    const driver = (route?.handoffDriverId ? driverById.get(route.handoffDriverId) : undefined)
      ?? (route?.vehicleId ? driverByVehicleId.get(route.vehicleId) : undefined);
    const itinerary = route ? itineraryByRoute.get(route.id)?.get(stop.id) : undefined;
    const arrival = itinerary?.estimatedArrival ? new Date(itinerary.estimatedArrival) : undefined;
    const departure = arrival && !Number.isNaN(arrival.getTime())
      ? new Date(arrival.getTime() + stop.serviceDurationMin * 60_000)
      : undefined;
    return {
      "Plan-ID": route?.planId ?? "",
      "Rutt-ID": route?.id ?? "",
      "Rutt": route?.name ?? "",
      "Datum": route ? svDate(route.date) : "",
      "Förare": driver?.name ?? "",
      "Fordon": vehicle?.name ?? "",
      "Registreringsnummer": vehicle?.licensePlate ?? "",
      "Stoppordning": itinerary?.sequenceOrder ?? stop.sequenceOrder,
      "Orderreferens": stop.externalRef ?? "",
      "Spårningskod": stop.trackingCode ?? "",
      "Shopify order-ID": stop.shopifyOrderId ?? "",
      "Shopify ordernamn": stop.shopifyOrderName ?? "",
      "Källrad i importfil": stop.sourceRowNumber,
      "Typ": stopType(stop.jobType),
      "Adress": stop.address,
      "Upphämtningsadress": stop.pickupAddress ?? "",
      "Tidsfönster från": svDateTime(stop.timeWindowStart),
      "Tidsfönster till": svDateTime(stop.timeWindowEnd),
      "Planerad ankomst": svDateTime(arrival),
      "Planerad avgång": svDateTime(departure),
      "Servicetid (min)": stop.serviceDurationMin,
      "Vikt (kg)": stop.weightKg,
      "Volym (m³)": stop.volumeM3,
      "Mottagare": stop.contactName ?? "",
      "Telefon": stop.contactPhone ?? "",
      "E-post": stop.contactEmail ?? "",
      "Anteckningar": stop.notes ?? "",
      "Servicekategori": stop.serviceCategory ?? "",
      "Serviceinstruktioner": stop.serviceInstructions ?? "",
      "Prioritet": stop.priority,
      "SLA-senast": svDateTime(stop.slaDeadline),
      "Krav på kompetenser": stop.requiredSkills?.join(", ") ?? "",
      "Krav på certifieringar": stop.requiredCertifications?.join(", ") ?? "",
      "Krav på utrustning": stop.requiredEquipment?.join(", ") ?? "",
      "Status": stop.status,
      ...customFields(stop, STOP_COLUMNS),
    };
  });
  const unplannedRows: WorkbookRow[] = unplannedStops.map((stop) => ({
    "Orderreferens": stop.externalRef ?? "",
    "Spårningskod": stop.trackingCode ?? "",
    "Shopify order-ID": stop.shopifyOrderId ?? "",
    "Shopify ordernamn": stop.shopifyOrderName ?? "",
    "Källrad i importfil": stop.sourceRowNumber,
    "Typ": stopType(stop.jobType),
    "Adress": stop.address,
    "Upphämtningsadress": stop.pickupAddress ?? "",
    "Tidsfönster från": svDateTime(stop.timeWindowStart),
    "Tidsfönster till": svDateTime(stop.timeWindowEnd),
    "Servicetid (min)": stop.serviceDurationMin,
    "Vikt (kg)": stop.weightKg,
    "Volym (m³)": stop.volumeM3,
    "Mottagare": stop.contactName ?? "",
    "Telefon": stop.contactPhone ?? "",
    "E-post": stop.contactEmail ?? "",
    "Anteckningar": stop.notes ?? "",
    "Servicekategori": stop.serviceCategory ?? "",
    "Serviceinstruktioner": stop.serviceInstructions ?? "",
    "Prioritet": stop.priority,
    "SLA-senast": svDateTime(stop.slaDeadline),
    "Krav på kompetenser": stop.requiredSkills?.join(", ") ?? "",
    "Krav på certifieringar": stop.requiredCertifications?.join(", ") ?? "",
    "Krav på utrustning": stop.requiredEquipment?.join(", ") ?? "",
    "Status": stop.status,
    "Orsak": stop.unplannedReason
      ?? "Ingen ruttilldelning finns. Kontrollera kapacitet, tidsfönster och valda resurser.",
    ...customFields(stop, UNPLANNED_COLUMNS),
  }));
  const buffer = await buildRoutePlanWorkbook([
    { name: "Rutter", rows: routeRows, preferredColumns: ROUTE_COLUMNS },
    { name: "Planerade stopp", rows: plannedRows, preferredColumns: STOP_COLUMNS },
    { name: "Ej planerade stopp", rows: unplannedRows, preferredColumns: UNPLANNED_COLUMNS },
  ]);
  return {
    buffer,
    rowCount: plannedRows.length + unplannedRows.length,
    filenameDate: svDate(
      routes[0]?.date
        ?? unplannedStops[0]?.planningDate
        ?? filters.from
        ?? new Date(),
    ),
  };
}

async function exportProofPackage(
  organizationId: string,
  from: Date | undefined,
  to: Date | undefined,
  statuses: (typeof STOP_STATUSES)[number][],
  includeFiles: boolean,
) {
  const conditions = [eq(stopsTable.organizationId, organizationId)];
  if (from) conditions.push(gte(stopsTable.createdAt, from));
  if (to) conditions.push(lte(stopsTable.createdAt, to));
  if (statuses.length) conditions.push(inArray(stopsTable.status, statuses));

  const proofs = await db
    .select({
      proofId: deliveryProofsTable.id,
      proofType: deliveryProofsTable.proofType,
      proofStage: deliveryProofsTable.proofStage,
      fileUrl: deliveryProofsTable.fileUrl,
      data: deliveryProofsTable.data,
      proofNotes: deliveryProofsTable.notes,
      capturedAt: deliveryProofsTable.capturedAt,
      stopId: stopsTable.id,
      address: stopsTable.address,
      trackingCode: stopsTable.trackingCode,
      externalReference: stopsTable.externalRef,
      status: stopsTable.status,
    })
    .from(deliveryProofsTable)
    .innerJoin(stopsTable, eq(deliveryProofsTable.stopId, stopsTable.id))
    .where(and(...conditions))
    .orderBy(desc(deliveryProofsTable.capturedAt))
    .limit(includeFiles ? MAX_PROOF_ARCHIVE_FILES + 1 : MAX_REPORT_ROWS);

  if (includeFiles && proofs.length > MAX_PROOF_ARCHIVE_FILES) {
    throw new ProofArchiveError(
      `Delivery proof export is limited to ${MAX_PROOF_ARCHIVE_FILES} records. Narrow the date or status filter and try again.`,
      413,
    );
  }

  const zip = includeFiles ? new JSZip() : undefined;
  const archiveFiles = new Map<string, { file: Awaited<ReturnType<typeof objectStorageService.getObjectEntityFile>>; contentType: unknown }>();
  if (includeFiles) {
    let totalBytes = 0;
    for (const proof of proofs) {
      if (!proof.fileUrl) continue;
      try {
        const objectPath = objectStorageService.normalizeObjectEntityPath(proof.fileUrl);
        const file = await objectStorageService.getObjectEntityFile(objectPath);
        const [metadata] = await file.getMetadata();
        const size = Number(metadata.size);
        if (!Number.isFinite(size) || size < 0) {
          throw new ProofArchiveError("A delivery proof file has an invalid stored size.", 422);
        }
        totalBytes += size;
        if (totalBytes > MAX_PROOF_ARCHIVE_BYTES) {
          throw new ProofArchiveError(
            `Delivery proof export is limited to ${MAX_PROOF_ARCHIVE_BYTES / (1024 * 1024)} MB. Narrow the date or status filter and try again.`,
            413,
          );
        }
        archiveFiles.set(proof.proofId, { file, contentType: metadata.contentType });
      } catch (error) {
        if (error instanceof ProofArchiveError) throw error;
        throw new ProofArchiveError(
          "One or more delivery proof files are unavailable. No archive was created.",
          422,
        );
      }
    }
  }

  const manifest: Record<string, unknown>[] = [];
  for (const proof of proofs) {
    let exportedFile = "";
    let fileStatus = proof.fileUrl
      ? (includeFiles ? "not available" : "available in ZIP export")
      : "included as metadata";
    if (proof.fileUrl && zip) {
      const archiveFile = archiveFiles.get(proof.proofId);
      if (!archiveFile) {
        throw new ProofArchiveError("A delivery proof file is unavailable. No archive was created.", 422);
      }
      try {
        const [content] = await archiveFile.file.download();
        exportedFile = `proofs/${proof.stopId}/${proof.proofId}.${fileExtension(archiveFile.contentType)}`;
        zip.file(exportedFile, content);
        fileStatus = "included";
      } catch (error) {
        if (error instanceof ProofArchiveError) throw error;
        throw new ProofArchiveError(
          "One or more delivery proof files could not be downloaded. No archive was created.",
          422,
        );
      }
    }
    manifest.push({
      proofId: proof.proofId,
      stopId: proof.stopId,
      address: proof.address,
      trackingCode: proof.trackingCode,
      externalReference: proof.externalReference,
      stopStatus: proof.status,
      proofType: proof.proofType,
      proofStage: proof.proofStage,
      notes: proof.proofNotes,
      capturedAt: proof.capturedAt,
      barcodeValue: proof.proofType === "barcode" ? proof.data : null,
      exportedFile,
      fileStatus,
    });
  }
  if (zip) {
    zip.file("delivery-proofs.csv", toCsv(manifest));
    zip.file(
      "README.txt",
      "Traivo Route — Leveransbevis\n\nFilen delivery-proofs.csv beskriver bevisen. " +
        "Tillgängliga foto-, signatur- och PDF-filer ligger under mappen proofs/.\n",
    );
  }
  return {
    buffer: zip ? await zip.generateAsync({ type: "nodebuffer" }) : undefined,
    manifest,
    rowCount: manifest.length,
  };
}

/**
 * GET /export?format=json|csv — admin-only full export of the organization's
 * data. JSON returns a single structured document; CSV returns a ZIP with one
 * CSV per table plus a README documenting the contents. The action is recorded
 * in the audit log.
 */
router.get("/export", requireAuth(), async (req, res) => {
  try {
    const orgId = assertOrgScope(req, req.query.organizationId);
    const type = firstQueryValue(req.query.type) as ExportType | undefined;
    const requestedFormat = firstQueryValue(req.query.format);
    if (requestedFormat && !["json", "csv", "pdf", "xlsx"].includes(requestedFormat)) {
      res.status(400).json({ error: "Unsupported export format" });
      return;
    }
    const format = requestedFormat === "csv"
      ? "csv"
      : requestedFormat === "pdf"
        ? "pdf"
        : requestedFormat === "xlsx"
          ? "xlsx"
          : "json";
    const from = parseOptionalDate(req.query.from);
    const to = parseOptionalDate(req.query.to, true);
    if (from && to && from > to) {
      res.status(400).json({ error: "The from date must be before the to date" });
      return;
    }
    const statuses = getSelectedStatuses(req.query.status);
    const stamp = new Date().toISOString().slice(0, 10);

    if (type && !["stops", "routes", "routePlan", "proofs", "billing", "environment"].includes(type)) {
      res.status(400).json({ error: "Unknown export type" });
      return;
    }
    if (format === "pdf" && type !== "environment") {
      res.status(400).json({ error: "PDF format is only available for environment reports" });
      return;
    }
    if (type === "environment" && format !== "pdf") {
      res.status(400).json({ error: "Environment reports must be exported as PDF" });
      return;
    }
    if (format === "xlsx" && type !== "routePlan") {
      res.status(400).json({ error: "XLSX format is only available for route plan exports" });
      return;
    }
    if (!type && req.user!.role !== "admin") {
      res.status(403).json({ error: "Forbidden: full data export requires admin role" });
      return;
    }
    if (type && !["admin", "dispatcher"].includes(req.user!.role)) {
      res.status(403).json({ error: "Forbidden: export requires admin or dispatcher role" });
      return;
    }

    if (type === "stops") {
      const rows = await exportStops(orgId, from, to, statuses);
      await logReportExport(req, orgId, type, format, rows.length, from, to, statuses);
      if (format === "json") {
        setDownloadHeaders(res, `traivo-stops-${stamp}.json`, "application/json; charset=utf-8");
        res.json({ exportType: type, rows });
        return;
      }
      setDownloadHeaders(res, `traivo-stops-${stamp}.csv`, "text/csv; charset=utf-8");
      res.send(toCsv(rows));
      return;
    }
    if (type === "routes") {
      const rows = await exportRoutes(orgId, from, to);
      await logReportExport(req, orgId, type, format, rows.length, from, to, statuses);
      if (format === "json") {
        setDownloadHeaders(res, `traivo-routes-${stamp}.json`, "application/json; charset=utf-8");
        res.json({ exportType: type, rows });
        return;
      }
      setDownloadHeaders(res, `traivo-routes-${stamp}.csv`, "text/csv; charset=utf-8");
      res.send(toCsv(rows));
      return;
    }
    if (type === "routePlan") {
      const planId = firstQueryValue(req.query.planId);
      const routeId = firstQueryValue(req.query.routeId);
      if (!planId && !routeId && !from) {
        res.status(400).json({ error: "Select a plan, route, or date range for the XLSX export" });
        return;
      }
      const result = await exportRoutePlanXlsx(orgId, { planId, routeId, from, to });
      await logReportExport(req, orgId, type, "xlsx", result.rowCount, from, to, statuses);
      setDownloadHeaders(
        res,
        `traivo-ruttplan-${result.filenameDate.replace(/\D/g, "-")}.xlsx`,
        ROUTE_PLAN_XLSX_CONTENT_TYPE,
      );
      res.send(result.buffer);
      return;
    }
    if (type === "proofs") {
      const result = await exportProofPackage(orgId, from, to, statuses, format === "csv");
      await logReportExport(req, orgId, type, format, result.rowCount, from, to, statuses);
      if (format === "json") {
        setDownloadHeaders(res, `traivo-delivery-proofs-${stamp}.json`, "application/json; charset=utf-8");
        res.json({ exportType: type, rows: result.manifest });
        return;
      }
      setDownloadHeaders(res, `traivo-delivery-proofs-${stamp}.zip`, "application/zip");
      res.send(result.buffer!);
      return;
    }
    if (type === "billing") {
      const reports = await fieldService.listBillingReadyReports(orgId, from, to);
      const rows = reports.map((report) => ({
        reportId: report.reportId,
        stopId: report.stopId,
        stopAddress: report.stopAddress,
        serviceCategory: report.serviceCategory,
        driverId: report.driverId,
        completedAt: report.completedAt,
        actualDurationMin: report.actualDurationMin,
        customerSignatoryName: report.customerSignatoryName,
        billingReadyAt: report.billingReadyAt,
        notes: report.notes,
        materials: report.materials,
      }));
      await logReportExport(req, orgId, type, format, rows.length, from, to, statuses);
      if (format === "json") {
        setDownloadHeaders(res, `traivo-billing-ready-${stamp}.json`, "application/json; charset=utf-8");
        res.json({ exportType: type, rows });
        return;
      }
      setDownloadHeaders(res, `traivo-billing-ready-${stamp}.csv`, "text/csv; charset=utf-8");
      res.send(toCsv(rows));
      return;
    }
    if (type === "environment") {
      const stats = await calculateSustainabilityStats(orgId, from, to, {
        maxRoutes: MAX_ENVIRONMENT_REPORT_ROUTES,
        maxStops: MAX_ENVIRONMENT_REPORT_STOPS,
        includeEtaMetrics: false,
      });
      const buffer = buildEnvironmentReportPdf(stats, from, to);
      await logReportExport(req, orgId, type, format, stats.routeBreakdown.length, from, to, statuses);
      setDownloadHeaders(res, `traivo-environment-report-${stamp}.pdf`, "application/pdf");
      res.send(buffer);
      return;
    }

    const data = await collectOrgData(orgId);
    await logExportEvent({
      req,
      action: "org.data_export",
      resourceType: "organization",
      resourceId: orgId,
      statusCode: 200,
      diff: { format: { to: format } },
    });

    if (format === "json") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="traivo-export-${stamp}.json"`);
      res.send(JSON.stringify(data, null, 2));
      return;
    }

    const zip = new JSZip();
    zip.file("README.txt", buildReadme(data));
    for (const [name, rows] of Object.entries(data.tables)) {
      zip.file(`${name}.csv`, toCsv(rows));
    }
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="traivo-export-${stamp}.zip"`);
    res.send(buffer);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;

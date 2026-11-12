import { outgoingRoute, outgoingStopContext } from "./outgoing-route-service";
import { eq, and, desc, gte, inArray, lte } from "drizzle-orm";
import {
  db,
  driversTable,
  driverCertificationsTable,
  vehiclesTable,
  stopsTable,
  routesTable,
  serviceReportsTable,
  serviceReportMaterialsTable,
} from "@workspace/db";
import { assertCurrentDriverAssistance } from "../lib/driver-assistance";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type FieldServiceExecutor = typeof db | DbTransaction;

// ── Custom errors ─────────────────────────────────────────────────────────────

export class ServiceReportValidationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ServiceReportValidationError";
  }
}

export class FieldServiceAssignmentError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "FieldServiceAssignmentError";
  }
}

export const FIELD_SERVICE_ASSIGNMENT_ERROR =
  "Field service requirements are not met for the assigned vehicle and technician";

// ── Certification helpers ─────────────────────────────────────────────────────

export async function listDriverCertifications(driverId: string, organizationId: string) {
  return db
    .select()
    .from(driverCertificationsTable)
    .where(
      and(
        eq(driverCertificationsTable.driverId, driverId),
        eq(driverCertificationsTable.organizationId, organizationId),
      ),
    );
}

export async function createDriverCertification(
  driverId: string,
  organizationId: string,
  data: {
    certificationCode: string;
    certificationName: string;
    issuedAt: Date;
    expiresAt?: Date | null;
  },
) {
  const [cert] = await db
    .insert(driverCertificationsTable)
    .values({
      driverId,
      organizationId,
      certificationCode: data.certificationCode,
      certificationName: data.certificationName,
      issuedAt: data.issuedAt,
      expiresAt: data.expiresAt ?? null,
    })
    .returning();
  await db
    .update(routesTable)
    .set({ geographicOverlapExplanation: null })
    .where(eq(routesTable.organizationId, organizationId));
  return cert;
}

export async function deleteDriverCertification(certId: string, organizationId: string) {
  const [deleted] = await db
    .delete(driverCertificationsTable)
    .where(
      and(
        eq(driverCertificationsTable.id, certId),
        eq(driverCertificationsTable.organizationId, organizationId),
      ),
    )
    .returning();
  if (deleted) {
    await db
      .update(routesTable)
      .set({ geographicOverlapExplanation: null })
      .where(eq(routesTable.organizationId, organizationId));
  }
  return deleted ?? null;
}

// ── Service report helpers ────────────────────────────────────────────────────

/**
 * Check that a driver profile is allowed to write the service report for a
 * given stop.  The driver must:
 *   1. Exist in the organization.
 *   2. Have driverProfileId matching the authenticated user's driverProfileId.
 *   3. The stop must belong to a route whose vehicleId equals the driver's vehicleId.
 *
 * Returns null on success, or an error object with `statusCode` + `message`.
 */
export async function verifyDriverStopOwnership(
  stopId: string,
  organizationId: string,
  driverProfileId: string,
): Promise<{ statusCode: 403 | 404; message: string } | null> {
  try {
    const { route } = await outgoingStopContext(organizationId, stopId, driverProfileId);
    return route.handoffStatus === "accepted" ? null
      : { statusCode: 403, message: "The outgoing route must be accepted before execution" };
  } catch (error) {
    return { statusCode: 403, message: error instanceof Error ? error.message : "Outgoing route unavailable" };
  }
}

export function isAcceptedRouteRecipient(
  route: {
    handoffDriverId: string | null;
    handoffStatus: string;
    handoffVersion: number | null;
    planRevision: number;
  },
  driverProfileId: string,
): boolean {
  return (
    route.handoffDriverId === driverProfileId
    && route.handoffStatus === "accepted"
    && route.handoffVersion === route.planRevision
  );
}

export async function verifyDriverRouteOwnership(
  routeId: string,
  organizationId: string,
  driverProfileId: string,
): Promise<{ statusCode: 403 | 404; message: string } | null> {
  const [driverResult, routeResult] = await Promise.all([
    db
      .select({ vehicleId: driversTable.vehicleId })
      .from(driversTable)
      .where(and(eq(driversTable.id, driverProfileId), eq(driversTable.organizationId, organizationId)))
      .limit(1),
    db
      .select({ vehicleId: routesTable.vehicleId, handoffDriverId: routesTable.handoffDriverId, handoffStatus: routesTable.handoffStatus, handoffVersion: routesTable.handoffVersion, planRevision: routesTable.planRevision })
      .from(routesTable)
      .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)))
      .limit(1),
  ]);

  const driver = driverResult[0];
  const route = routeResult[0];
  if (!driver) {
    return { statusCode: 403, message: "Driver profile not found in organization" };
  }
  if (!route) {
    return { statusCode: 404, message: "Route not found" };
  }
  if (route.handoffDriverId !== driverProfileId) {
    return {
      statusCode: 403,
      message: "Driver is not the dispatched recipient for this route",
    };
  }
  return null;
}

export async function getServiceReportByStop(stopId: string, organizationId: string) {
  const [report] = await db
    .select()
    .from(serviceReportsTable)
    .where(
      and(
        eq(serviceReportsTable.stopId, stopId),
        eq(serviceReportsTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!report) return null;
  const materials = await db
    .select()
    .from(serviceReportMaterialsTable)
    .where(eq(serviceReportMaterialsTable.serviceReportId, report.id));
  return { report, materials };
}

export async function upsertServiceReport(
  stopId: string,
  organizationId: string,
  data: {
    driverId: string;
    status?: "draft" | "submitted" | "billing_ready";
    startedAt?: Date | null;
    completedAt?: Date | null;
    actualDurationMin?: number | null;
    notes?: string | null;
    customerSignatoryName?: string | null;
    signatureEvidenceRef?: string | null;
    materials?: Array<{
      itemCode?: string | null;
      description: string;
      quantity: number;
      unit?: string | null;
      unitCost?: number | null;
    }>;
    assistedRouteId?: string | null;
    executionRouteId?: string | null;
    outgoingPlanVersion?: number;
  },
) {
  const now = new Date();

  // ── Pre-flight validation (outside transaction — fast path) ─────────────────

  // 1. Stop must exist in this org and be a field_service job
  let [stop] = await db
    .select({ id: stopsTable.id, jobType: stopsTable.jobType, routeId: stopsTable.routeId })
    .from(stopsTable)
    .where(and(eq(stopsTable.id, stopId), eq(stopsTable.organizationId, organizationId)))
    .limit(1);

  if (!stop) {
    throw new ServiceReportValidationError("Stop not found", 404);
  }
  if (data.executionRouteId) {
    const context = await outgoingStopContext(organizationId, stopId, data.driverId, db, data.executionRouteId);
    stop = { id: stopId, routeId: context.route.id, jobType: context.stop.jobType };
    if (context.route.planRevision !== data.outgoingPlanVersion) {
      throw new ServiceReportValidationError("Utskicksplatsens version har ändrats.", 409);
    }
  }
  if (stop.jobType !== "field_service") {
    throw new ServiceReportValidationError(
      `Stop jobType is "${stop.jobType}"; service reports are only valid for field_service stops`,
      400,
    );
  }

  // 2. Driver must belong to this org
  const [driver] = await db
    .select({ id: driversTable.id, organizationId: driversTable.organizationId })
    .from(driversTable)
    .where(and(eq(driversTable.id, data.driverId), eq(driversTable.organizationId, organizationId)))
    .limit(1);

  if (!driver) {
    throw new ServiceReportValidationError("Driver not found in organization", 404);
  }

  // ── Billing state derivation ─────────────────────────────────────────────────
  // Promoting to billing_ready: set flag + timestamp.
  // Demoting away from billing_ready: clear flag + timestamp.
  // If status is not being changed, preserve the existing billing flags.
  const promotingToBillingReady = data.status === "billing_ready";
  const demotingFromBillingReady =
    data.status !== undefined && data.status !== "billing_ready";

  // ── Atomic transaction: report upsert + material replacement ────────────────
  const reportId = await db.transaction(async (tx) => {
    if (data.executionRouteId || data.assistedRouteId) {
      const [lockedRoute] = await tx.select().from(routesTable).where(and(
        eq(routesTable.id, (data.executionRouteId ?? data.assistedRouteId)!),
        eq(routesTable.organizationId, organizationId),
      )).limit(1).for("update");
      if (!lockedRoute || lockedRoute.handoffStatus !== "accepted") {
        throw new ServiceReportValidationError("The selected route is not accepted for execution", 409);
      }
      const context = await outgoingStopContext(organizationId, stopId, data.driverId, tx, lockedRoute.id);
      if (data.outgoingPlanVersion !== undefined && context.route.planRevision !== data.outgoingPlanVersion) {
        throw new ServiceReportValidationError("Utskicksplatsens version har ändrats.", 409);
      }
      if (context.stop.jobType !== "field_service") throw new ServiceReportValidationError("Utskicksplatsen är inte ett serviceuppdrag.", 409);
      await tx.select({ id: stopsTable.id }).from(stopsTable).where(and(
        eq(stopsTable.id, stopId), eq(stopsTable.organizationId, organizationId),
      )).for("update");
    }
    const [existing] = await tx
      .select({ id: serviceReportsTable.id })
      .from(serviceReportsTable)
      .where(
        and(
          eq(serviceReportsTable.stopId, stopId),
          eq(serviceReportsTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    let id: string;

    if (existing) {
      const updateValues: Record<string, unknown> = {
        driverId: data.driverId,
        updatedAt: now,
      };
      if (data.status !== undefined) updateValues.status = data.status;
      if (data.startedAt !== undefined) updateValues.startedAt = data.startedAt;
      if (data.completedAt !== undefined) updateValues.completedAt = data.completedAt;
      if (data.actualDurationMin !== undefined) updateValues.actualDurationMin = data.actualDurationMin;
      if (data.notes !== undefined) updateValues.notes = data.notes;
      if (data.customerSignatoryName !== undefined) updateValues.customerSignatoryName = data.customerSignatoryName;
      if (data.signatureEvidenceRef !== undefined) updateValues.signatureEvidenceRef = data.signatureEvidenceRef;

      if (promotingToBillingReady) {
        updateValues.billingReady = true;
        updateValues.billingReadyAt = now;
      } else if (demotingFromBillingReady) {
        // status moved away from billing_ready — clear the flags for consistency
        updateValues.billingReady = false;
        updateValues.billingReadyAt = null;
      }

      await tx
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update(serviceReportsTable)
        .set(updateValues as any)
        .where(eq(serviceReportsTable.id, existing.id));
      id = existing.id;
    } else {
      const [created] = await tx
        .insert(serviceReportsTable)
        .values({
          stopId,
          organizationId,
          driverId: data.driverId,
          status: data.status ?? "draft",
          startedAt: data.startedAt ?? null,
          completedAt: data.completedAt ?? null,
          actualDurationMin: data.actualDurationMin ?? null,
          notes: data.notes ?? null,
          customerSignatoryName: data.customerSignatoryName ?? null,
          signatureEvidenceRef: data.signatureEvidenceRef ?? null,
          billingReady: promotingToBillingReady,
          billingReadyAt: promotingToBillingReady ? now : null,
        })
        .returning();
      id = created.id;
    }

    // Replace materials atomically within the same transaction
    if (data.materials !== undefined) {
      await tx
        .delete(serviceReportMaterialsTable)
        .where(eq(serviceReportMaterialsTable.serviceReportId, id));

      if (data.materials.length > 0) {
        await tx.insert(serviceReportMaterialsTable).values(
          data.materials.map((m) => ({
            serviceReportId: id,
            organizationId,
            itemCode: m.itemCode ?? null,
            description: m.description,
            quantity: m.quantity,
            unit: m.unit ?? null,
            unitCost: m.unitCost ?? null,
          })),
        );
      }
    }

    return id;
  });

  return getServiceReportByStop(stopId, organizationId);
}

// ── Billing-ready export ──────────────────────────────────────────────────────

export async function listBillingReadyReports(
  organizationId: string,
  from?: Date,
  to?: Date,
  limit = 50_000,
) {
  const conditions = [
    eq(serviceReportsTable.organizationId, organizationId),
    eq(serviceReportsTable.billingReady, true),
  ];
  if (from) conditions.push(gte(serviceReportsTable.billingReadyAt, from));
  if (to) conditions.push(lte(serviceReportsTable.billingReadyAt, to));

  const reports = await db
    .select()
    .from(serviceReportsTable)
    .where(and(...conditions))
    .orderBy(desc(serviceReportsTable.billingReadyAt))
    .limit(limit);
  const reportIds = reports.map((report) => report.id);
  const stopIds = reports.map((report) => report.stopId);
  const [stops, materials] = await Promise.all([
    stopIds.length
      ? db
        .select({ id: stopsTable.id, address: stopsTable.address, serviceCategory: stopsTable.serviceCategory })
        .from(stopsTable)
        .where(and(eq(stopsTable.organizationId, organizationId), inArray(stopsTable.id, stopIds)))
      : Promise.resolve([]),
    reportIds.length
      ? db
        .select()
        .from(serviceReportMaterialsTable)
        .where(inArray(serviceReportMaterialsTable.serviceReportId, reportIds))
      : Promise.resolve([]),
  ]);
  const stopById = new Map(stops.map((stop) => [stop.id, stop]));
  const materialsByReportId = new Map<string, typeof materials>();
  for (const material of materials) {
    const items = materialsByReportId.get(material.serviceReportId) ?? [];
    items.push(material);
    materialsByReportId.set(material.serviceReportId, items);
  }

  return reports.map((report) => {
    const stop = stopById.get(report.stopId);
    return {
      reportId: report.id,
      stopId: report.stopId,
      organizationId: report.organizationId,
      driverId: report.driverId,
      stopAddress: stop?.address ?? "",
      serviceCategory: stop?.serviceCategory ?? null,
      completedAt: report.completedAt,
      actualDurationMin: report.actualDurationMin,
      customerSignatoryName: report.customerSignatoryName,
      signatureEvidenceRef: report.signatureEvidenceRef,
      billingReadyAt: report.billingReadyAt,
      notes: report.notes,
      materials: materialsByReportId.get(report.id) ?? [],
    };
  });
}

// ── Optimizer compatibility check ─────────────────────────────────────────────

export interface FieldServiceRequirement {
  requiredSkills: string[];
  requiredCertifications: string[];
  requiredEquipment: string[];
}

export interface FieldServiceCheckResult {
  eligible: boolean;
  reasonCodes: string[];
  details: string[];
}

export function fieldServiceRequirementsFromStop(stop: {
  requiredSkills?: string[] | null;
  requiredCertifications?: string[] | null;
  requiredEquipment?: string[] | null;
}): FieldServiceRequirement {
  return {
    requiredSkills: stop.requiredSkills ?? [],
    requiredCertifications: stop.requiredCertifications ?? [],
    requiredEquipment: stop.requiredEquipment ?? [],
  };
}

export function isEligibleFieldServiceResource(
  driver: { driverRole: string; isActive: boolean } | null | undefined,
): boolean {
  return Boolean(driver?.isActive && ["technician", "both"].includes(driver.driverRole));
}

/**
 * Check whether a driver+vehicle combination satisfies the hard requirements
 * of a field service stop. Returns reason codes and human-readable details
 * for every constraint violation so the optimizer can surface them.
 */
export async function checkFieldServiceEligibility(
  driverId: string,
  vehicleId: string,
  requirements: FieldServiceRequirement,
  now: Date = new Date(),
  executor: FieldServiceExecutor = db,
): Promise<FieldServiceCheckResult> {
  const reasonCodes: string[] = [];
  const details: string[] = [];

  const [driver] = await executor
    .select({
      skills: driversTable.skills,
      driverRole: driversTable.driverRole,
      isActive: driversTable.isActive,
    })
    .from(driversTable)
    .where(eq(driversTable.id, driverId))
    .limit(1);

  if (!isEligibleFieldServiceResource(driver)) {
    reasonCodes.push("INCOMPATIBLE_ROLE");
    details.push("Vehicle does not have an active technician assigned");
  }

  // Check driver skills
  if (requirements.requiredSkills.length > 0) {
    const driverSkills = driver?.skills ?? [];
    const missingSkills = requirements.requiredSkills.filter(
      (s) => !driverSkills.includes(s),
    );
    if (missingSkills.length > 0) {
      reasonCodes.push("MISSING_SKILL");
      details.push(`Driver lacks required skills: ${missingSkills.join(", ")}`);
    }
  }

  // Check driver certifications (must be current = not expired)
  if (requirements.requiredCertifications.length > 0) {
    const certs = await executor
      .select({
        certificationCode: driverCertificationsTable.certificationCode,
        expiresAt: driverCertificationsTable.expiresAt,
      })
      .from(driverCertificationsTable)
      .where(eq(driverCertificationsTable.driverId, driverId));

    const activeCertCodes = new Set(
      certs
        .filter((c) => !c.expiresAt || c.expiresAt > now)
        .map((c) => c.certificationCode),
    );
    const expiredCertCodes = new Set(
      certs
        .filter((c) => c.expiresAt && c.expiresAt <= now)
        .map((c) => c.certificationCode),
    );

    const missingCerts = requirements.requiredCertifications.filter(
      (code) => !activeCertCodes.has(code),
    );
    if (missingCerts.length > 0) {
      const expired = missingCerts.filter((c) => expiredCertCodes.has(c));
      const absent = missingCerts.filter((c) => !expiredCertCodes.has(c));
      if (expired.length > 0) {
        reasonCodes.push("EXPIRED_CERTIFICATION");
        details.push(`Driver has expired certifications: ${expired.join(", ")}`);
      }
      if (absent.length > 0) {
        reasonCodes.push("MISSING_CERTIFICATION");
        details.push(`Driver lacks certifications: ${absent.join(", ")}`);
      }
    }
  }

  // Check vehicle equipment inventory
  if (requirements.requiredEquipment.length > 0) {
    const [vehicle] = await executor
      .select({ equipmentInventory: vehiclesTable.equipmentInventory })
      .from(vehiclesTable)
      .where(eq(vehiclesTable.id, vehicleId))
      .limit(1);

    const vehicleEquipment = vehicle?.equipmentInventory ?? [];
    const missingEquipment = requirements.requiredEquipment.filter(
      (e) => !vehicleEquipment.includes(e),
    );
    if (missingEquipment.length > 0) {
      reasonCodes.push("MISSING_EQUIPMENT");
      details.push(`Vehicle lacks required equipment: ${missingEquipment.join(", ")}`);
    }
  }

  return {
    eligible: reasonCodes.length === 0,
    reasonCodes,
    details,
  };
}

export async function assertVehicleEligibleForFieldService(
  organizationId: string,
  vehicleId: string | null | undefined,
  requirements: FieldServiceRequirement,
  now: Date = new Date(),
): Promise<void> {
  if (!vehicleId) {
    throw new FieldServiceAssignmentError(
      "Field service work requires a route with an assigned vehicle and active technician",
    );
  }

  const drivers = await db
    .select({ id: driversTable.id })
    .from(driversTable)
    .where(
      and(
        eq(driversTable.organizationId, organizationId),
        eq(driversTable.vehicleId, vehicleId),
        eq(driversTable.isActive, true),
      ),
    );

  for (const driver of drivers) {
    const result = await checkFieldServiceEligibility(driver.id, vehicleId, requirements, now);
    if (result.eligible) return;
  }

  throw new FieldServiceAssignmentError(FIELD_SERVICE_ASSIGNMENT_ERROR);
}

export async function assertRouteEligibleForFieldService(
  organizationId: string,
  routeId: string,
  requirements: FieldServiceRequirement,
  now: Date = new Date(),
): Promise<void> {
  const [route] = await db
    .select({ vehicleId: routesTable.vehicleId })
    .from(routesTable)
    .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)))
    .limit(1);

  if (!route) {
    throw new FieldServiceAssignmentError("Route not found in organization");
  }
  await assertVehicleEligibleForFieldService(
    organizationId,
    route.vehicleId,
    requirements,
    now,
  );
}

export async function assertDriverEligibleForFieldServiceStops(
  organizationId: string,
  routeId: string,
  driverId: string,
  vehicleId: string,
  now: Date = new Date(),
  executor: FieldServiceExecutor = db,
): Promise<void> {
  const fieldServiceStops = await executor
    .select({
      requiredSkills: stopsTable.requiredSkills,
      requiredCertifications: stopsTable.requiredCertifications,
      requiredEquipment: stopsTable.requiredEquipment,
    })
    .from(stopsTable)
    .where(
      and(
        eq(stopsTable.organizationId, organizationId),
        eq(stopsTable.routeId, routeId),
        eq(stopsTable.jobType, "field_service"),
      ),
    );

  for (const stop of fieldServiceStops) {
    await assertDriverEligibleForFieldService(
      driverId,
      vehicleId,
      fieldServiceRequirementsFromStop(stop),
      now,
      executor,
    );
  }
}

export async function assertDriverEligibleForFieldService(
  driverId: string,
  vehicleId: string,
  requirements: FieldServiceRequirement,
  now: Date = new Date(),
  executor: FieldServiceExecutor = db,
): Promise<void> {
  const result = await checkFieldServiceEligibility(
    driverId,
    vehicleId,
    requirements,
    now,
    executor,
  );
  if (!result.eligible) {
    throw new FieldServiceAssignmentError(FIELD_SERVICE_ASSIGNMENT_ERROR);
  }
}

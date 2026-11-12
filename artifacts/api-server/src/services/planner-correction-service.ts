import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, stopsTable, routesTable, vehiclesTable, driversTable } from "@workspace/db";
import { geocodeDetailed } from "./geocoding";
import { moveStopsForDispatch, updateStop } from "./stop-service";
import { plannerStopDigest, plannerFactsDigest } from "./planner-stop-facts";
import { isProtectedImportRoute, optimizationDriverIdForRoute } from "./route-plan-approval-service";
import { planningConflictSeverity } from "./planning-conflict-policy";
import { issuePlannerToken, readPlannerToken, PlannerCorrectionError } from "./planner-preview-token";

type MoveInput = Parameters<typeof moveStopsForDispatch>[1];
export type PlannerActor = { userId: string; userEmail?: string | null };
type MoveBinding = { kind: "move"; input: MoveInput; previewDigest: string };
type AddressBinding = {
  kind: "address"; stopId: string; expectedStopDigest: string;
  expectedRouteDigest: string | null;
  data: { address: string; latitude: number; longitude: number };
  verification: "exact_match" | "manual"; manualConfirmed: boolean;
};

export async function recommendPlannerResources(
  organizationId: string, actor: PlannerActor, stopId: string, routeIds: string[],
) {
  const [stop] = await db.select().from(stopsTable).where(and(
    eq(stopsTable.organizationId, organizationId), eq(stopsTable.id, stopId), isNull(stopsTable.archivedAt),
  ));
  if (!stop) throw new PlannerCorrectionError("Uppdraget hittades inte.", 404, "NOT_FOUND");
  if (stop.status !== "pending") throw new PlannerCorrectionError("Endast väntande uppdrag kan flyttas.");
  const scope = [...new Set([...routeIds, ...(stop.routeId ? [stop.routeId] : [])])];
  const routes = await db.select().from(routesTable).where(and(
    eq(routesTable.organizationId, organizationId), inArray(routesTable.id, scope),
  )).orderBy(routesTable.id);
  const source = routes.find((route) => route.id === stop.routeId);
  const recommendations = [];
  const unavailable = [];
  // Deliberately sequential and bounded by the visible plan, not a parallel scheduler.
  for (const route of routes.filter((route) => routeIds.includes(route.id) && route.id !== stop.routeId)) {
    if (!route.vehicleId || ["completed", "cancelled"].includes(route.status)) continue;
    if (stop.planningPlanId && stop.planningPlanId !== route.planId) continue;
    if (source && source.planId !== route.planId) continue;
    const [vehicle] = await db.select().from(vehiclesTable).where(and(
      eq(vehiclesTable.id, route.vehicleId), eq(vehiclesTable.organizationId, organizationId),
    ));
    const drivers = await db.select().from(driversTable).where(and(
      eq(driversTable.vehicleId, route.vehicleId), eq(driversTable.organizationId, organizationId),
      eq(driversTable.isActive, true),
    ));
    const exactDriverId = isProtectedImportRoute(route) ? optimizationDriverIdForRoute(route)
      : route.handoffDriverId ?? optimizationDriverIdForRoute(route);
    const driver = exactDriverId ? drivers.find((item) => item.id === exactDriverId)
      : !isProtectedImportRoute(route) && drivers.length === 1 ? drivers[0] : undefined;
    if (!vehicle?.isActive || !driver) continue;
    const routeStops = await db.select({ id: stopsTable.id }).from(stopsTable).where(and(
      eq(stopsTable.routeId, route.id), eq(stopsTable.organizationId, organizationId), isNull(stopsTable.archivedAt),
    ));
    const input: MoveInput = {
      stopIds: [stop.id], routeId: route.id, targetIndex: routeStops.length,
      routeRevisions: [route, ...(source ? [source] : [])].map((item) => ({
        routeId: item.id, planRevision: item.planRevision,
      })),
    };
    try {
      const preview = await moveStopsForDispatch(organizationId, input, { previewOnly: true });
      if (preview.kind !== "preview" || !preview.canMove) {
        unavailable.push({
          routeId: route.id,
          routeName: route.name,
          reason: preview.kind === "ineligible" ? preview.error : "Förslaget bryter en planeringsregel.",
          conflicts: "conflicts" in preview ? preview.conflicts.map((code) => ({
            code, severity: planningConflictSeverity(code),
          })) : [],
        });
        continue;
      }
      recommendations.push({
        routeId: route.id, routeName: route.name, driverId: driver.id,
        driverName: driver.name, vehicleId: vehicle.id, vehicleName: vehicle.name,
        targetIndex: input.targetIndex, preview,
        // Only canonical facts, never a client-selected digest, are signed.
        token: issuePlannerToken(organizationId, actor.userId, {
          kind: "move", input, previewDigest: preview.previewDigest,
        } satisfies MoveBinding),
        consequences: preview.consequences,
      });
      if (recommendations.length === 3) break;
    } catch (error) {
      if (error instanceof Error && "statusCode" in error && error.statusCode === 409) {
        unavailable.push({ routeId: route.id, routeName: route.name, reason: error.message, conflicts: [] });
      } else throw error;
    }
  }
  return { recommendations, unavailable, ordering: "route_id_not_score", insertion: "end_of_route" };
}

export async function previewPlannerAddress(
  organizationId: string, actor: PlannerActor,
  input: { stopId: string; address: string; position?: { latitude: number; longitude: number; confirmed: true } },
) {
  const [stop] = await db.select().from(stopsTable).where(and(
    eq(stopsTable.id, input.stopId), eq(stopsTable.organizationId, organizationId), isNull(stopsTable.archivedAt),
  ));
  if (!stop) throw new PlannerCorrectionError("Uppdraget hittades inte.", 404, "NOT_FOUND");
  if (stop.status !== "pending") throw new PlannerCorrectionError("Utförd historik kan inte adressrättas.");
  const result = input.position ? null : await geocodeDetailed(input.address, "se");
  if (!input.position && (result?.status !== "matched" || !result.result)) {
    return { kind: "unresolved" as const, status: result?.status, candidates: result?.candidates ?? [],
      message: "Adressen kunde inte verifieras exakt. Välj och bekräfta en manuell position eller rätta sökningen." };
  }
  const position = input.position ?? result!.result!;
  const data = { address: input.address, latitude: position.latitude, longitude: position.longitude };
  const [route] = stop.routeId ? await db.select().from(routesTable).where(and(
    eq(routesTable.id, stop.routeId), eq(routesTable.organizationId, organizationId),
  )) : [];
  const binding: AddressBinding = {
    kind: "address", stopId: stop.id, data, expectedStopDigest: plannerStopDigest(stop),
    expectedRouteDigest: route ? plannerFactsDigest(route) : null,
    verification: input.position ? "manual" : "exact_match", manualConfirmed: Boolean(input.position?.confirmed),
  };
  return { kind: "preview" as const, original: { address: stop.address, latitude: stop.latitude, longitude: stop.longitude,
    sourceRowNumber: stop.sourceRowNumber }, proposed: data, verification: binding.verification,
    consequences: { status: "unknown", reason: "Ruttens körtid och tidsfönster måste beräknas om efter adressrättning." },
    token: issuePlannerToken(organizationId, actor.userId, binding) };
}

export function decodePlannerConfirmation(token: string, organizationId: string, actor: PlannerActor) {
  return readPlannerToken<MoveBinding | AddressBinding>(token, organizationId, actor.userId);
}

export async function confirmPlannerCorrection(organizationId: string, actor: PlannerActor, token: string) {
  const binding = decodePlannerConfirmation(token, organizationId, actor);
  if (binding.kind === "move" && binding.previewDigest) {
    const input = { ...binding.input, expectedPreviewDigest: binding.previewDigest };
    const result = await moveStopsForDispatch(organizationId, input);
    if (result.kind === "moved") return result;
    throw new PlannerCorrectionError("Förslaget kan inte längre genomföras. Förhandsgranska igen.");
  }
  if (binding.kind === "address") {
    const stop = await updateStop(binding.stopId, organizationId, binding.data, {}, null, null, {
      plannerCorrection: {
        expectedStopDigest: binding.expectedStopDigest, expectedRouteDigest: binding.expectedRouteDigest,
        actor, verification: binding.verification, manualConfirmed: binding.manualConfirmed,
      },
    });
    if (!stop) throw new PlannerCorrectionError("Uppdraget hittades inte.", 404, "NOT_FOUND");
    return { kind: "corrected", stop };
  }
  throw new PlannerCorrectionError("Förhandsgranskningen är inte giltig. Beräkna igen.");
}

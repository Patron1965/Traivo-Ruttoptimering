import type { RouteWorkdaySummary, RouteWorkdayTimelineItem } from "@workspace/api-client-react";
type DriverArrivalInfo = {
  plannedAt?: string | null; estimatedAt?: string | null; calculatedAt?: string | null;
  positionAt?: string | null; source?: "road" | "plan_shift" | null;
};

export interface ScheduledStop {
  stopId: string;
  lockedVehicleId?: string | null;
  lockedDriverId?: string | null;
  lockedServiceStartAt?: string | null;
  address: string;
  customerName?: string;
  latitude: number;
  longitude: number;
  sequenceOrder: number;
  weightKg: number;
  volumeM3: number;
  serviceDurationMin: number;
  timeWindowStart?: string | null;
  timeWindowEnd?: string | null;
  status: string;
  terminalAt?: string | null;
  trackingCode?: string | null;
  notes?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  arrival?: DriverArrivalInfo | null;
  externalRef?: string | null;
  shopifyOrderName?: string | null;
  priority?: number | null;
  assignmentOverrideAt?: string | null;
  assignmentOverrideReasonCodes?: string[] | null;
  /** Uploaded proof kinds from the batch route-stops payload. */
  proofTypes?: string[] | null;
  /**
   * These values are present only after the server's workday timeline has
   * been attached. They must never be populated by a browser estimate.
   */
  arrivalTime?: Date;
  departureTime?: Date;
  travelTimeMin?: number;
  distanceFromPrevKm?: number;
  isEstimated?: boolean;
}

export type WorkdayEvidenceStatus = "authoritative" | "needs_recalculation";

export type DispatchWorkdaySummary = RouteWorkdaySummary & {
  allowedOvertimeMin?: number;
  allowLateStopsMin?: number;
  warningCodes?: string[];
  lateStopIds?: string[];
};

export interface ScheduledRow {
  routeId: string;
  optimizationFrozen?: boolean;
  routeName: string;
  routeDate?: string | null;
  driverId?: string | null;
  driverName: string;
  planRevision?: number;
  handoffStatus?: "pending" | "sent" | "received" | "opened" | "accepted" | "rejected";
  handoffVersion?: number | null;
  handoffDriverId?: string | null;
  sentAt?: string | null;
  vehicleId: string;
  vehicleName: string;
  vehicleType: string;
  capacityKg: number;
  capacityVolume: number;
  totalWeightKg: number;
  totalVolumeM3: number;
  capacityPercent: number;
  color: string;
  stops: ScheduledStop[];
  timeline?: RouteWorkdayTimelineItem[];
  summary?: DispatchWorkdaySummary;
  workdayStatus: WorkdayEvidenceStatus;
}

export type WorkdayUtilizationUnavailableReason =
  | "missing_or_invalid_evidence"
  | "missing_or_invalid_shift";

export interface WorkdayUtilization {
  /**
   * The authoritative depot-to-depot workday divided by the driver's
   * persisted available shift. This intentionally is not a stop count,
   * driving duration, or remaining-margin calculation.
   */
  percent: number | null;
  plannedMin: number | null;
  availableShiftMin: number | null;
  unavailableReason?: WorkdayUtilizationUnavailableReason;
}

/**
 * Derive the compact dispatch-row utilization badge from persisted workday
 * evidence. `shiftMin` is the driver's evaluated available shift for that
 * day; it includes the break contract inside the shift boundary, while
 * `totalMin` is the complete depot-to-depot plan (including breaks, reserves,
 * and the return leg).
 *
 * The browser must not fill in a default shift or estimate either side of the
 * ratio. Unknown or invalid evidence therefore returns an unavailable result.
 */
export function getWorkdayUtilization(
  evidence: Pick<ScheduledRow, "driverId" | "workdayStatus" | "timeline" | "summary">,
): WorkdayUtilization {
  if (!evidence.driverId) {
    return {
      percent: null,
      plannedMin: null,
      availableShiftMin: null,
      unavailableReason: "missing_or_invalid_shift",
    };
  }
  if (
    evidence.workdayStatus !== "authoritative" ||
    !evidence.timeline?.length ||
    !evidence.summary
  ) {
    return {
      percent: null,
      plannedMin: null,
      availableShiftMin: null,
      unavailableReason: "missing_or_invalid_evidence",
    };
  }

  const plannedMin = evidence.summary.totalMin;
  const availableShiftMin = evidence.summary.shiftMin;
  if (
    !isFiniteNonNegative(plannedMin) ||
    !isFiniteNonNegative(availableShiftMin) ||
    availableShiftMin <= 0
  ) {
    return {
      percent: null,
      plannedMin: isFiniteNonNegative(plannedMin) ? plannedMin : null,
      availableShiftMin: isFiniteNonNegative(availableShiftMin) ? availableShiftMin : null,
      unavailableReason: "missing_or_invalid_shift",
    };
  }

  return {
    percent: (plannedMin / availableShiftMin) * 100,
    plannedMin,
    availableShiftMin,
  };
}

export function calculateWorkdayUtilizationPercent(
  evidence: Pick<ScheduledRow, "driverId" | "workdayStatus" | "timeline" | "summary">,
): number | null {
  return getWorkdayUtilization(evidence).percent;
}

type ScheduleStopInput = {
  id: string;
  address: string;
  latitude: number;
  longitude: number;
  sequenceOrder?: number | null;
  weightKg?: number | null;
  volumeM3?: number | null;
  serviceDurationMin?: number | null;
  timeWindowStart?: string | null;
  timeWindowEnd?: string | null;
  status: string;
  terminalAt?: string | null;
  trackingCode?: string | null;
  notes?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  arrival?: DriverArrivalInfo | null;
  externalRef?: string | null;
  shopifyOrderName?: string | null;
  priority?: number | null;
  assignmentOverrideAt?: string | null;
  assignmentOverrideReasonCodes?: string[] | null;
  /** Uploaded proof kinds from the batch route-stops payload. */
  proofTypes?: string[] | null;
  customerId?: string | null;
  lockedVehicleId?: string | null;
  lockedDriverId?: string | null;
  lockedServiceStartAt?: string | null;
};

function toDate(value: Date | string | null | undefined): Date | null {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? "");
  return Number.isFinite(date.getTime()) ? date : null;
}
function copyStop(stop: ScheduleStopInput, index: number): ScheduledStop {
  return {
    stopId: stop.id,
    lockedVehicleId: stop.lockedVehicleId,
    lockedDriverId: stop.lockedDriverId,
    lockedServiceStartAt: stop.lockedServiceStartAt,
    address: stop.address,
    customerName: stop.contactName || undefined,
    latitude: stop.latitude,
    longitude: stop.longitude,
    sequenceOrder: index + 1,
    weightKg: stop.weightKg ?? 0,
    volumeM3: stop.volumeM3 ?? 0,
    serviceDurationMin: stop.serviceDurationMin ?? 5,
    timeWindowStart: stop.timeWindowStart,
    timeWindowEnd: stop.timeWindowEnd,
    status: stop.status,
    terminalAt: stop.terminalAt,
    trackingCode: stop.trackingCode,
    notes: stop.notes,
    contactName: stop.contactName,
    contactEmail: stop.contactEmail,
    contactPhone: stop.contactPhone,
    arrival: stop.arrival,
    externalRef: stop.externalRef,
    shopifyOrderName: stop.shopifyOrderName,
    priority: stop.priority,
    assignmentOverrideAt: stop.assignmentOverrideAt,
    assignmentOverrideReasonCodes: stop.assignmentOverrideReasonCodes,
    proofTypes: stop.proofTypes,
  };
}

/**
 * Builds the non-temporal stop metadata used by Dispatch.
 *
 * Deliberately does not estimate driving time, arrival, departure, reserves,
 * breaks, or the return to the depot. The server workday evaluation is the
 * only source that can make those values authoritative.
 */
export function computeSchedule(
  stops: ScheduleStopInput[],
  _routeDate?: string,
): ScheduledStop[] {
  const sorted = [...stops].sort(
    (a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0),
  );
  return sorted.map(copyStop);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const WORKDAY_EVENT_TYPES = new Set([
  "depot_start",
  "driving",
  "travel_reserve",
  "waiting",
  "service",
  "stop_reserve",
  "break",
  "charging",
  "return",
  "depot_end",
]);

function isTimelineEvent(value: unknown): value is RouteWorkdayTimelineItem {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RouteWorkdayTimelineItem>;
  const startAt = toDate(event.startAt);
  const endAt = toDate(event.endAt);
  return Boolean(
    typeof event.type === "string" &&
      WORKDAY_EVENT_TYPES.has(event.type) &&
      startAt &&
      endAt &&
      endAt.getTime() >= startAt.getTime() &&
      isFiniteNonNegative(event.durationMin) &&
      Math.abs((endAt.getTime() - startAt.getTime()) / 60000 - event.durationMin) < 0.01 &&
      (event.distanceKm === undefined || isFiniteNonNegative(event.distanceKm)) &&
      (event.rawDurationMin === undefined || isFiniteNonNegative(event.rawDurationMin)),
  );
}

function isWorkdaySummary(value: RouteWorkdaySummary | null | undefined): value is RouteWorkdaySummary {
  if (!value) return false;
  const summary = value as RouteWorkdaySummary;
  // Reserve values are required here even though the generated contract keeps
  // them optional for legacy reads. Without them, a route cannot prove that
  // its visible finish includes the configured reserves.
  return Boolean(
    isFiniteNonNegative(summary.shiftMin) &&
      isFiniteNonNegative(summary.nonReturnDrivingMin) &&
      isFiniteNonNegative(summary.serviceMin) &&
      isFiniteNonNegative(summary.waitingMin) &&
      isFiniteNonNegative(summary.breakMin) &&
      isFiniteNonNegative(summary.returnMin) &&
      isFiniteNonNegative(summary.travelReserveMin) &&
      isFiniteNonNegative(summary.stopReserveMin) &&
      isFiniteNonNegative(summary.totalMin) &&
      Number.isFinite(summary.marginMin) &&
      isFiniteNonNegative(summary.overtimeMin) &&
      toDate(summary.shiftEndAt),
  );
}

export interface WorkdayEvidence {
  status: WorkdayEvidenceStatus;
  timeline: RouteWorkdayTimelineItem[] | null;
  summary: RouteWorkdaySummary | null;
}

/**
 * Validates the pair persisted by the server. A timeline without a summary
 * (or vice versa), malformed dates, missing depot boundaries, missing service
 * events, and legacy summaries without reserve totals all require a fresh
 * server calculation.
 */
export function getWorkdayEvidence(
  timeline: RouteWorkdayTimelineItem[] | null | undefined,
  summary: RouteWorkdaySummary | null | undefined,
  expectedStopIds: string[] = [],
): WorkdayEvidence {
  const events = Array.isArray(timeline) ? timeline : [];
  const validEvents = events.length > 0 && events.every(isTimelineEvent);
  const first = events[0];
  const last = events.at(-1);
  const ordered = validEvents && events.every((event, index) => {
    if (index === 0) return true;
    const previous = toDate(events[index - 1].endAt);
    const current = toDate(event.startAt);
    return Boolean(previous && current && current.getTime() >= previous.getTime());
  });
  const hasDepotBoundaries =
    first?.type === "depot_start" && last?.type === "depot_end";
  const shiftEnd = toDate(summary?.shiftEndAt);
  const shiftStart = first ? toDate(first.startAt) : null;
  const hasCoherentShiftBoundary = Boolean(
    shiftEnd && shiftStart && shiftEnd.getTime() >= shiftStart.getTime(),
  );
  const serviceStopIds = new Set(
    events
      .filter((event) => event.type === "service" && typeof event.stopId === "string")
      .map((event) => event.stopId as string),
  );
  const hasAllServices = expectedStopIds.every((stopId) => serviceStopIds.has(stopId));
  const authoritative = Boolean(
    validEvents &&
      ordered &&
      hasDepotBoundaries &&
      hasCoherentShiftBoundary &&
      hasAllServices &&
      isWorkdaySummary(summary),
  );
  return authoritative
    ? {
        status: "authoritative",
        timeline: events,
        summary: summary as RouteWorkdaySummary,
      }
    : { status: "needs_recalculation", timeline: null, summary: null };
}

/**
 * Attach server events to stops for detail panels and SLA checks. This does
 * not calculate anything; it only projects persisted event boundaries.
 */
export function attachWorkdayEvidence(
  stops: ScheduledStop[],
  timeline: RouteWorkdayTimelineItem[],
): ScheduledStop[] {
  const serviceByStop = new Map<string, RouteWorkdayTimelineItem[]>();
  const serviceVisitsByStop = new Map<string, RouteWorkdayTimelineItem[][]>();
  const drivingSeenByStop = new Set<string>();
  const drivingByStop = new Map<string, RouteWorkdayTimelineItem[]>();
  for (const event of timeline) {
    if (event.stopId && event.type === "driving") {
      // The evaluator uses the same stop id for pickup and delivery. A
      // driving leg between service events is therefore the visit boundary;
      // breaks and reserves must not split a visit.
      drivingSeenByStop.add(event.stopId);
    }
    if (event.stopId && event.type === "service") {
      const items = serviceByStop.get(event.stopId) ?? [];
      items.push(event);
      serviceByStop.set(event.stopId, items);
      const visits = serviceVisitsByStop.get(event.stopId) ?? [];
      if (drivingSeenByStop.has(event.stopId) || visits.length === 0) {
        visits.push([]);
        drivingSeenByStop.delete(event.stopId);
      }
      visits.at(-1)!.push(event);
      serviceVisitsByStop.set(event.stopId, visits);
    }
    if (event.stopId && (event.type === "driving" || event.type === "travel_reserve")) {
      const items = drivingByStop.get(event.stopId) ?? [];
      items.push(event);
      drivingByStop.set(event.stopId, items);
    }
  }
  return stops.map((stop) => {
    const services = serviceByStop.get(stop.stopId) ?? [];
    const visits = serviceVisitsByStop.get(stop.stopId) ?? [];
    // A fixed break can split one service into several timeline fragments,
    // while pickup/delivery visits share the stop id but have a driving leg
    // between them. Show the final (delivery) visit, not pickup timing.
    const finalVisit = visits.at(-1) ?? services;
    const firstService = finalVisit[0];
    const lastService = finalVisit.at(-1);
    const driving = drivingByStop.get(stop.stopId) ?? [];
    const arrivalTime = firstService ? toDate(firstService.startAt) ?? undefined : undefined;
    const departureTime = lastService ? toDate(lastService.endAt) ?? undefined : undefined;
    return {
      ...stop,
      arrivalTime,
      departureTime,
      travelTimeMin: driving.reduce((total, event) => total + event.durationMin, 0),
      distanceFromPrevKm: driving.reduce((total, event) => total + (event.distanceKm ?? 0), 0),
    };
  });
}

export interface DispatchFinishEvidence {
  allRoutesAuthoritative: boolean;
  lastEndTime: Date | null;
  overtimeEndTime: Date | null;
  lastEndOverLimit: boolean;
}

/**
 * Selects dispatch finish indicators only from a complete set of current
 * server workday evidence. The overall finish and overtime finish remain
 * separate so a late-finish badge never borrows a time from another route.
 */
export function getDispatchFinishEvidence(
  rows: Pick<ScheduledRow, "routeId" | "workdayStatus" | "timeline" | "summary">[],
): DispatchFinishEvidence {
  const displayedRoutes = rows.filter((row) => row.routeId !== "unplanned");
  const allRoutesAuthoritative =
    displayedRoutes.length > 0 &&
    displayedRoutes.every((row) =>
      row.workdayStatus === "authoritative" &&
      Boolean(row.timeline?.length) &&
      Boolean(row.summary),
    );
  if (!allRoutesAuthoritative) {
    return {
      allRoutesAuthoritative,
      lastEndTime: null,
      overtimeEndTime: null,
      lastEndOverLimit: false,
    };
  }

  const latestEnd = (
    routeRows: typeof displayedRoutes,
  ): Date | null => {
    let latest: Date | null = null;
    for (const row of routeRows) {
      const endAt = row.timeline?.at(-1)?.endAt;
      const end = toDate(endAt);
      if (end && (!latest || end > latest)) latest = end;
    }
    return latest;
  };
  const overtimeRoutes = displayedRoutes.filter(
    (row) => (row.summary?.overtimeMin ?? 0) > 0,
  );
  const overtimeEndTime = latestEnd(overtimeRoutes);
  return {
    allRoutesAuthoritative,
    lastEndTime: latestEnd(displayedRoutes),
    overtimeEndTime,
    lastEndOverLimit: overtimeEndTime !== null,
  };
}

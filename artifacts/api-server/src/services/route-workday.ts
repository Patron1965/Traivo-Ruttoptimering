import { cachedDistance, estimateDuration } from "./alns/distance-cache";
import type { ALNSDriverConstraints, ALNSNode, ALNSVehicle } from "./alns/types";

export type WorkdayReasonCode = "TIME_WINDOW" | "UNAVAILABLE_PERIOD" | "BREAK_WINDOW" | "SHIFT_END" | "OVERTIME" | "EV_RETURN_RANGE" | "PLANNING_LOCK";
export type WorkdayWarningCode = "OVERTIME_WITHIN_TOLERANCE" | "LATE_STOP_WITHIN_TOLERANCE";
export type WorkdayEventType = "depot_start" | "driving" | "travel_reserve" | "waiting" | "service" | "stop_reserve" | "break" | "charging" | "return" | "depot_end";
export type WorkdayEvent = { type: WorkdayEventType; startAt: string; endAt: string; durationMin: number; stopId?: string; distanceKm?: number; rawDurationMin?: number };
export type WorkdaySummary = {
  shiftMin: number; nonReturnDrivingMin: number; serviceMin: number; waitingMin: number; breakMin: number;
  returnMin: number; travelReserveMin: number; stopReserveMin: number; totalMin: number; marginMin: number; overtimeMin: number; shiftEndAt: string;
  allowedOvertimeMin?: number; allowLateStopsMin?: number; warningCodes?: WorkdayWarningCode[]; lateStopIds?: string[];
};
export type WorkdayEvaluation = {
  events: WorkdayEvent[]; summary: WorkdaySummary; endTime: Date; totalDistanceKm: number;
  rangeUsedKm: number; feasible: boolean; reasonCode?: WorkdayReasonCode;
  unavailableWaitMin: number;
  warnings: Array<{ code: WorkdayWarningCode; stopId?: string; minutes: number; allowedMinutes: number }>;
};

export type UnavailablePeriod = { start: string; end: string };
/** Public lock target: first service for this stop ID (pickup for composite P&D).
 * Never use plannerItinerary.estimatedArrival / UI scheduledStop.arrivalTime. */
export function plannedServiceStartForStop(
  events: readonly Pick<WorkdayEvent, "type" | "stopId" | "startAt">[] | null | undefined,
  stopId: string,
): string | null {
  return events?.find(event => event.type === "service" && event.stopId === stopId)?.startAt ?? null;
}
type ParsedUnavailablePeriod = { start: Date; end: Date };
export type UnavailableServiceSegment = { start: Date; end: Date };
export type UnavailableServiceSchedule = {
  valid: boolean;
  segments: UnavailableServiceSegment[];
  waiting: UnavailableServiceSegment[];
  end: Date;
};

/**
 * Parse and merge the absolute stop-level closures.  Invalid snapshots are
 * deliberately reported to the caller instead of being silently discarded:
 * a malformed closure must never become an accidentally serviceable stop.
 */
export function parseUnavailablePeriods(value: unknown): {
  valid: boolean;
  periods: ParsedUnavailablePeriod[];
} {
  if (value == null) return { valid: true, periods: [] };
  if (!Array.isArray(value)) return { valid: false, periods: [] };
  const parsed: ParsedUnavailablePeriod[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") {
      return { valid: false, periods: [] };
    }
    const raw = candidate as { start?: unknown; end?: unknown };
    if (typeof raw.start !== "string" || typeof raw.end !== "string") {
      return { valid: false, periods: [] };
    }
    const start = new Date(raw.start);
    const end = new Date(raw.end);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      return { valid: false, periods: [] };
    }
    parsed.push({ start, end });
  }
  parsed.sort((left, right) => left.start.getTime() - right.start.getTime());
  const merged: ParsedUnavailablePeriod[] = [];
  for (const period of parsed) {
    const previous = merged[merged.length - 1];
    if (previous && period.start <= previous.end) {
      if (period.end > previous.end) previous.end = period.end;
    } else {
      merged.push({ start: new Date(period.start), end: new Date(period.end) });
    }
  }
  return { valid: true, periods: merged };
}

/**
 * Build a contiguous service-only schedule around hard closures. The returned
 * interval is never split across a customer closure: if the full visit would
 * overlap one, the entire visit waits until that closure ends.
 */
export function scheduleServiceAroundUnavailable(
  start: Date,
  durationMin: number,
  unavailablePeriods: unknown,
): UnavailableServiceSchedule {
  const parsed = parseUnavailablePeriods(unavailablePeriods);
  const initial = new Date(start);
  if (!parsed.valid || !Number.isFinite(initial.getTime())) {
    return { valid: false, segments: [], waiting: [], end: initial };
  }
  let current = new Date(initial);
  const duration = Math.max(0, durationMin);
  const waiting: UnavailableServiceSegment[] = [];
  if (duration <= 0) {
    return { valid: true, segments: [], waiting, end: current };
  }
  for (const period of parsed.periods) {
    const end = new Date(current.getTime() + duration * 60_000);
    const overlaps = current < period.end && end > period.start;
    if (!overlaps) {
      if (end <= period.start) break;
      continue;
    }
    waiting.push({ start: new Date(current), end: new Date(period.end) });
    current = new Date(period.end);
  }
  const end = new Date(current.getTime() + duration * 60_000);
  return {
    valid: true,
    segments: [{ start: new Date(current), end }],
    waiting,
    end,
  };
}

const stockholmPartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Stockholm",
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function stockholmLocalEpoch(instant: Date): number {
  const parts = Object.fromEntries(
    stockholmPartsFormatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

const stockholmOffsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Stockholm",
  timeZoneName: "longOffset",
});
const stockholmClockCache = new Map<number, number>();

function stockholmOffsetMinutes(instant: number): number {
  const name = stockholmOffsetFormatter.formatToParts(new Date(instant))
    .find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
  const match = name.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  return match
    ? (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3]))
    : 0;
}

/** Converts a planning calendar date and Stockholm wall clock to an instant. */
export function stockholmClock(date: Date, clock: string): Date {
  const [hour, minute] = clock.split(":").map(Number);
  // Planning dates are date-only API values. Use their UTC components so a
  // server running outside Sweden cannot change the selected calendar day.
  const requestedLocal = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    hour,
    minute,
  );
  const cached = stockholmClockCache.get(requestedLocal);
  if (cached !== undefined) return new Date(cached);
  const remember = (instant: Date) => {
    if (stockholmClockCache.size >= 4096) stockholmClockCache.clear();
    stockholmClockCache.set(requestedLocal, instant.getTime());
    return instant;
  };
  const offsets = new Set([
    stockholmOffsetMinutes(requestedLocal - 36 * 60 * 60_000),
    stockholmOffsetMinutes(requestedLocal),
    stockholmOffsetMinutes(requestedLocal + 36 * 60 * 60_000),
  ]);
  const candidates = [...offsets].map((offset) => {
    const instant = new Date(requestedLocal - offset * 60_000);
    return { instant, local: stockholmLocalEpoch(instant) };
  });
  const exact = candidates
    .filter((candidate) => candidate.local === requestedLocal)
    .sort((a, b) => a.instant.getTime() - b.instant.getTime());
  if (exact[0]) {
    // During the repeated autumn hour, use the earlier occurrence.
    return remember(exact[0].instant);
  }
  const shiftedForward = candidates
    .filter((candidate) => candidate.local > requestedLocal)
    .sort((a, b) =>
      a.local - b.local || a.instant.getTime() - b.instant.getTime());
  if (shiftedForward[0]) {
    // During the missing spring hour, preserve minutes by shifting forward
    // through the DST gap (Temporal's "compatible" disambiguation).
    return remember(shiftedForward[0].instant);
  }
  throw new Error(`Klockslaget ${clock} kunde inte tolkas i Europe/Stockholm.`);
}

export function workdayInfeasibilityMessage(
  evaluation: WorkdayEvaluation,
  context: {
    vehicleName: string;
    breakStartTime?: string | null;
    breakEndTime?: string | null;
  },
): string {
  const breakWindow = context.breakStartTime && context.breakEndTime
    ? `${context.breakStartTime}–${context.breakEndTime}`
    : "det sparade rastfönstret";
  const shiftEnd = new Date(evaluation.summary.shiftEndAt).toLocaleTimeString("sv-SE", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit",
  });
  const messages: Record<WorkdayReasonCode, string> = {
    PLANNING_LOCK: `Rutten för ${context.vehicleName} bryter mot ett låst resurspar eller en exakt servicestart. Lås upp eller välj en genomförbar plan.`,
    BREAK_WINDOW: `Rutten för ${context.vehicleName} gör att rasten ${breakWindow} inte kan hållas. Flytta ett stopp före eller efter rasten, eller minska rutten.`,
    SHIFT_END: `Rutten för ${context.vehicleName}, inklusive återresan, går ${Math.ceil(evaluation.summary.overtimeMin)} minuter över passet som slutar ${shiftEnd}. Flytta ett stopp eller förläng chaufförens arbetstid.`,
    OVERTIME: `Rutten för ${context.vehicleName}, inklusive återresan, överskrider arbetstiden med ${Math.ceil(evaluation.summary.overtimeMin)} minuter. Minska rutten eller välj en chaufför med längre pass.`,
    TIME_WINDOW: `Rutten för ${context.vehicleName} bryter mot ett kundtidsfönster. Flytta stoppet närmare sitt tidsfönster eller välj en annan rutt.`,
    UNAVAILABLE_PERIOD: `Rutten för ${context.vehicleName} försöker serva en kund under ett stängt leveransintervall. Vänta tills intervallet slutar eller välj en annan rutt.`,
    EV_RETURN_RANGE: `${context.vehicleName} kan inte nå slutdepån med den planerade laddningen. Lägg till eller flytta ett laddstopp.`,
  };
  return evaluation.reasonCode
    ? messages[evaluation.reasonCode]
    : `Rutten för ${context.vehicleName} ryms inte inom chaufförens arbetsdag.`;
}

/** The one persisted/evaluated route clock. A fixed break is an actual event, not a hidden duration adjustment. */
export function evaluateRouteWorkday(
  nodes: ALNSNode[], vehicle: ALNSVehicle, depotLat: number, depotLon: number, date: Date,
  constraints?: ALNSDriverConstraints,
): WorkdayEvaluation {
  constraints = vehicle.canonicalDriverConstraints ?? constraints;
  const start = constraints?.preferredStartTime ? stockholmClock(date, constraints.preferredStartTime) : new Date(date);
  const shiftEnd = constraints?.preferredEndTime ? stockholmClock(date, constraints.preferredEndTime) : new Date(start.getTime() + 8 * 60 * 60_000);
  const events: WorkdayEvent[] = [];
  const add = (type: WorkdayEventType, minutes: number, extra: Partial<WorkdayEvent> = {}) => {
    const begin = new Date(current);
    current = new Date(current.getTime() + Math.max(0, minutes) * 60_000);
    events.push({ type, startAt: begin.toISOString(), endAt: current.toISOString(), durationMin: Math.max(0, minutes), ...extra });
  };
  let current = new Date(start);
  let lat = vehicle.startLatitude ?? depotLat, lon = vehicle.startLongitude ?? depotLon;
  let distance = 0, range = 0, nonReturnDriving = 0, service = 0, waiting = 0, unavailableWait = 0, breaks = 0, returnMin = 0, travelReserve = 0, stopReserve = 0;
  let breakTaken = false;
  let reasonCode: WorkdayReasonCode | undefined;
  const warnings: WorkdayEvaluation["warnings"] = [];
  const lateStopIds: string[] = [];
  const maxDriverOvertimeMin = Math.max(0, Math.floor(vehicle.maxDriverOvertimeMin ?? 0));
  const allowLateStopsMin = Math.max(0, Math.floor(vehicle.allowLateStopsMin ?? 0));
  const breakStart = constraints?.breakStartTime ? stockholmClock(date, constraints.breakStartTime) : undefined;
  const breakEnd = constraints?.breakEndTime ? stockholmClock(date, constraints.breakEndTime) : undefined;
  const takeBreakIfDue = (activityMinutes: number) => {
    if (!breakStart || !breakEnd || breakTaken) return;
    const activityEnd = new Date(current.getTime() + activityMinutes * 60_000);
    if (current < breakEnd && (activityEnd > breakStart || current >= breakStart)) {
      const scheduledStart = current > breakStart ? current : breakStart;
      if (scheduledStart >= breakEnd) { reasonCode ??= "BREAK_WINDOW"; return; }
      // Interruptible activities split at the break below. Customer service
      // instead waits until it can fit contiguously on one side of lunch.
      const duration = (breakEnd.getTime() - scheduledStart.getTime()) / 60_000;
      add("break", duration); breaks += duration; breakTaken = true;
    } else if (current >= breakEnd && start < breakStart) reasonCode ??= "BREAK_WINDOW";
  };
  const activity = (type: "driving" | "travel_reserve" | "return" | "service" | "stop_reserve" | "charging", minutes: number, extra: Partial<WorkdayEvent>) => {
    if (breakStart && breakEnd && !breakTaken && current < breakStart && new Date(current.getTime() + minutes * 60_000) > breakStart) {
      const before = (breakStart.getTime() - current.getTime()) / 60_000;
      if (type === "service") {
        // A customer visit cannot be paused for the driver's lunch. Pickup
        // service also uses this path; exact-start locks are checked afterward.
        add("waiting", before, extra);
        waiting += before;
        takeBreakIfDue(0);
        add(type, minutes, extra);
        return;
      }
      if (before > 0) add(type, before, extra);
      takeBreakIfDue(0);
      add(type, minutes - before, extra);
    } else {
      takeBreakIfDue(minutes); add(type, minutes, extra);
    }
  };
  const waitUntil = (target: Date, stopId?: string) => {
    while (current < target) {
      if (
        breakStart &&
        breakEnd &&
        !breakTaken &&
        breakStart >= current &&
        breakStart < target
      ) {
        const beforeBreak = (breakStart.getTime() - current.getTime()) / 60_000;
        if (beforeBreak > 0) {
          add("waiting", beforeBreak, stopId ? { stopId } : {});
          waiting += beforeBreak;
        }
        takeBreakIfDue(0);
        continue;
      }
      if (
        breakStart &&
        breakEnd &&
        !breakTaken &&
        current >= breakStart &&
        current < breakEnd
      ) {
        takeBreakIfDue(0);
        continue;
      }
      const minutes = (target.getTime() - current.getTime()) / 60_000;
      add("waiting", minutes, stopId ? { stopId } : {});
      waiting += minutes;
    }
  };
  /**
   * Schedule one contiguous delivery visit around both hard customer closures
   * and the fixed driver break. Recheck closures after waiting through lunch.
   */
  const deliveryService = (
    node: ALNSNode,
    minutes: number,
    extra: Partial<WorkdayEvent>,
  ): Date => {
    const parsed = parseUnavailablePeriods(node.unavailablePeriods);
    if (!parsed.valid) {
      reasonCode ??= "UNAVAILABLE_PERIOD";
      activity("service", minutes, extra);
      service += minutes;
      return new Date(current.getTime() - Math.max(0, minutes) * 60_000);
    }
    const duration = Math.max(0, minutes);
    if (duration <= 0) {
      activity("service", 0, extra);
      return new Date(current);
    }
    while (true) {
      if (
        breakStart &&
        breakEnd &&
        !breakTaken &&
        current >= breakStart &&
        current < breakEnd
      ) {
        takeBreakIfDue(0);
        continue;
      }
      const schedule = scheduleServiceAroundUnavailable(
        current,
        duration,
        node.unavailablePeriods,
      );
      if (!schedule.valid) {
        reasonCode ??= "UNAVAILABLE_PERIOD";
        const serviceStart = new Date(current);
        activity("service", duration, extra);
        service += duration;
        return serviceStart;
      }
      const serviceStart = schedule.segments[0]?.start ?? new Date(current);
      if (serviceStart > current) {
        const waitStartedAt = new Date(current);
        waitUntil(serviceStart, node.id);
        unavailableWait += (current.getTime() - waitStartedAt.getTime()) / 60_000;
        continue;
      }
      const serviceEnd = schedule.end;
      const breakInterruptsVisit =
        breakStart &&
        breakEnd &&
        !breakTaken &&
        breakStart > current &&
        breakStart < serviceEnd;
      if (breakInterruptsVisit) {
        waitUntil(breakEnd, node.id);
        continue;
      }
      const actualServiceStart = new Date(current);
      activity("service", duration, extra);
      service += duration;
      return actualServiceStart;
    }
  };
  const travel = (targetLat: number, targetLon: number, type: "driving" | "return", stopId?: string) => {
    const km = cachedDistance(lat, lon, targetLat, targetLon);
    const minutes = estimateDuration(km, current, lat, lon, targetLat, targetLon) * (vehicle.tempoMultiplier ?? 1);
    // Split distance proportionally when the fixed break cuts a travel leg.
    if (breakStart && !breakTaken && current < breakStart && new Date(current.getTime() + minutes * 60_000) > breakStart) {
      const before = (breakStart.getTime() - current.getTime()) / 60_000;
      add(type, before, { stopId, distanceKm: km * before / minutes }); takeBreakIfDue(0);
      add(type, minutes - before, { stopId, distanceKm: km * (minutes - before) / minutes });
    } else { takeBreakIfDue(minutes); add(type, minutes, { stopId, distanceKm: km, rawDurationMin: minutes }); }
    const reserveMinutes = minutes * Math.max(0, vehicle.travelReservePercent ?? 0) / 100;
    if (reserveMinutes > 0) {
      activity("travel_reserve", reserveMinutes, { stopId, rawDurationMin: 0 });
      travelReserve += reserveMinutes;
    }
    distance += km; range += km;
    if (type === "return") returnMin += minutes; else nonReturnDriving += minutes;
    lat = targetLat; lon = targetLon;
  };
  const waitForLockedStart = (node: ALNSNode) => {
    if (!node.lockedServiceStartAt) return;
    const instant = node.lockedServiceStartAt.getTime();
    if (!Number.isFinite(instant) || instant % 60_000 !== 0) {
      reasonCode = "PLANNING_LOCK";
      return;
    }
    waitUntil(node.lockedServiceStartAt, node.id);
  };
  const checkLockedStart = (node: ALNSNode, fromIndex: number) => {
    if (!node.lockedServiceStartAt) return;
    const actual = events.slice(fromIndex).find(
      (event) => event.type === "service" && event.stopId === node.id,
    );
    if (!actual || new Date(actual.startAt).getTime() !== node.lockedServiceStartAt.getTime()) {
      reasonCode = "PLANNING_LOCK";
    }
  };
  events.push({ type: "depot_start", startAt: start.toISOString(), endAt: start.toISOString(), durationMin: 0 });
  for (const node of nodes) {
    if (node.mustBeFirstCustomer && nodes.find(item => !item.isChargingStation)?.id !== node.id) {
      reasonCode = "PLANNING_LOCK";
    }
    if ((node.lockedVehicleId && node.lockedVehicleId !== vehicle.id)
      || (node.lockedDriverId && node.lockedDriverId !== vehicle.driverId)) {
      reasonCode = "PLANNING_LOCK";
    }
    const parsedUnavailable = parseUnavailablePeriods(node.unavailablePeriods);
    if (!parsedUnavailable.valid) reasonCode ??= "UNAVAILABLE_PERIOD";
    if (node.pickupLat != null && node.pickupLon != null) {
      travel(node.pickupLat, node.pickupLon, "driving", node.id);
       // Existing persisted lock guards identify the first service event for
       // the stop: for a composite job this is pickup, not delivery.
       waitForLockedStart(node);
       const firstPickupEvent = events.length;
       const minutes = node.pickupServiceMin ?? node.serviceDurationMin; activity("service", minutes, { stopId: node.id, rawDurationMin: minutes }); service += minutes;
       checkLockedStart(node, firstPickupEvent);
       if (!node.isChargingStation && (node.stopReserveMin ?? 0) > 0) { activity("stop_reserve", node.stopReserveMin!, { stopId: node.id, rawDurationMin: 0 }); stopReserve += node.stopReserveMin!; }
    }
    travel(node.latitude, node.longitude, "driving", node.id);
    if (node.isChargingStation) {
      const minutes = node.chargingDurationMin ?? 30; activity("charging", minutes, { stopId: node.id }); range = 0;
      continue;
    }
    const arrivalWasLate = Boolean(node.timeWindowEnd && current > node.timeWindowEnd);
    if (node.timeWindowEnd && arrivalWasLate) {
      const lateMinutes = (current.getTime() - node.timeWindowEnd.getTime()) / 60_000;
      lateStopIds.push(node.id);
      if (lateMinutes <= allowLateStopsMin) {
        warnings.push({
          code: "LATE_STOP_WITHIN_TOLERANCE",
          stopId: node.id,
          minutes: lateMinutes,
          allowedMinutes: allowLateStopsMin,
        });
      } else {
        reasonCode ??= "TIME_WINDOW";
      }
    }
    if (node.timeWindowStart && current < node.timeWindowStart) {
      waitUntil(node.timeWindowStart, node.id);
    }
    const hasPickup = node.pickupLat != null && node.pickupLon != null;
    // Waiting consumes real time and takes any due break. Never shorten visits.
    if (!hasPickup) waitForLockedStart(node);
    const firstServiceEvent = events.length;
    const deliveryStart = deliveryService(
      node,
      node.serviceDurationMin,
      { stopId: node.id, rawDurationMin: node.serviceDurationMin },
    );
    if (!hasPickup) checkLockedStart(node, firstServiceEvent);
    if (node.timeWindowEnd && deliveryStart > node.timeWindowEnd) {
      const lateMinutes = (deliveryStart.getTime() - node.timeWindowEnd.getTime()) / 60_000;
      if (lateMinutes <= allowLateStopsMin) {
        if (!lateStopIds.includes(node.id)) lateStopIds.push(node.id);
        const existingWarning = warnings.find(
          (warning) => warning.code === "LATE_STOP_WITHIN_TOLERANCE" && warning.stopId === node.id,
        );
        if (existingWarning) {
          existingWarning.minutes = Math.max(existingWarning.minutes, lateMinutes);
        } else {
          warnings.push({
            code: "LATE_STOP_WITHIN_TOLERANCE",
            stopId: node.id,
            minutes: lateMinutes,
            allowedMinutes: allowLateStopsMin,
          });
        }
      } else {
        reasonCode ??= "TIME_WINDOW";
      }
    }
    if ((node.stopReserveMin ?? 0) > 0) { activity("stop_reserve", node.stopReserveMin!, { stopId: node.id, rawDurationMin: 0 }); stopReserve += node.stopReserveMin!; }
  }
  const endLat = vehicle.endLatitude ?? vehicle.startLatitude ?? depotLat, endLon = vehicle.endLongitude ?? vehicle.startLongitude ?? depotLon;
  travel(endLat, endLon, "return");
  const effectiveRange = vehicle.rangeKm;
  if (effectiveRange && range > effectiveRange * .95) reasonCode ??= "EV_RETURN_RANGE";
  if (breakStart && !breakTaken && current >= breakEnd!) reasonCode ??= "BREAK_WINDOW";
  const total = (current.getTime() - start.getTime()) / 60_000;
  const margin = (shiftEnd.getTime() - current.getTime()) / 60_000;
  const overtime = Math.max(0, -margin);
  if (overtime > 0) {
    if (overtime <= maxDriverOvertimeMin) {
      warnings.push({
        code: "OVERTIME_WITHIN_TOLERANCE",
        minutes: overtime,
        allowedMinutes: maxDriverOvertimeMin,
      });
    } else {
      reasonCode ??= overtime > 120 ? "OVERTIME" : "SHIFT_END";
    }
  }
  events.push({ type: "depot_end", startAt: current.toISOString(), endAt: current.toISOString(), durationMin: 0 });
  return {
    events,
    summary: {
      shiftMin: Math.max(0, (shiftEnd.getTime() - start.getTime()) / 60_000),
      nonReturnDrivingMin: nonReturnDriving,
      serviceMin: service,
      waitingMin: waiting,
      breakMin: breaks,
      returnMin,
      travelReserveMin: travelReserve,
      stopReserveMin: stopReserve,
      totalMin: total,
      marginMin: margin,
      overtimeMin: overtime,
      shiftEndAt: shiftEnd.toISOString(),
      allowedOvertimeMin: maxDriverOvertimeMin,
      allowLateStopsMin,
      warningCodes: warnings.map((warning) => warning.code),
      lateStopIds,
    },
    endTime: current,
    totalDistanceKm: distance,
    rangeUsedKm: range,
    feasible: !reasonCode,
    reasonCode,
    unavailableWaitMin: unavailableWait,
    warnings,
  };
}
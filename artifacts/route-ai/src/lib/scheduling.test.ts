import assert from "node:assert/strict";
import test from "node:test";
import {
  attachWorkdayEvidence,
  computeSchedule,
  calculateWorkdayUtilizationPercent,
  getDispatchFinishEvidence,
  getWorkdayEvidence,
  getWorkdayUtilization,
} from "./scheduling.ts";

const stop = {
  id: "stop-1",
  address: "Main street 1",
  latitude: 59.3,
  longitude: 18.1,
  sequenceOrder: 1,
  serviceDurationMin: 15,
  status: "pending",
};

test("does not invent client arrival/departure timing when workday evidence is null", () => {
  const metadata = computeSchedule([stop]);
  assert.equal(metadata[0]?.arrivalTime, undefined);
  assert.equal(metadata[0]?.departureTime, undefined);
  assert.equal(metadata[0]?.travelTimeMin, undefined);

  const evidence = getWorkdayEvidence(null, null, [stop.id]);
  assert.equal(evidence.status, "needs_recalculation");
  assert.equal(evidence.timeline, null);
  assert.equal(evidence.summary, null);
});

test("actual completion survives scheduling without replacing planned times", () => {
  const terminalAt = "2026-11-05T10:16:00Z";
  const [scheduled] = computeSchedule([{ ...stop, status: "completed", terminalAt }]);
  assert.equal(scheduled.status, "completed");
  assert.equal(scheduled.terminalAt, terminalAt);
  assert.equal(scheduled.arrivalTime, undefined);
  assert.equal(scheduled.departureTime, undefined);
});

const utilizationTimeline = [{
  type: "depot_start" as const,
  startAt: "2026-05-04T07:00:00Z",
  endAt: "2026-05-04T07:00:00Z",
  durationMin: 0,
}, {
  type: "depot_end" as const,
  startAt: "2026-05-04T15:00:00Z",
  endAt: "2026-05-04T15:00:00Z",
  durationMin: 0,
}];

function utilizationEvidence(totalMin: number, shiftMin: number) {
  return {
    driverId: "driver-1",
    workdayStatus: "authoritative" as const,
    timeline: utilizationTimeline,
    summary: { totalMin, shiftMin },
  } as Parameters<typeof getWorkdayUtilization>[0];
}

test("workday utilization is unavailable when evidence or denominator is missing/zero", () => {
  const missingDriver = {
    driverId: null,
    workdayStatus: "needs_recalculation",
    timeline: undefined,
    summary: undefined,
  } as Parameters<typeof getWorkdayUtilization>[0];
  assert.equal(calculateWorkdayUtilizationPercent(missingDriver), null);
  assert.equal(getWorkdayUtilization(missingDriver).unavailableReason, "missing_or_invalid_shift");
  assert.equal(calculateWorkdayUtilizationPercent({
    driverId: "driver-1",
    workdayStatus: "authoritative",
    timeline: utilizationTimeline,
    summary: undefined,
  }), null);
  assert.equal(calculateWorkdayUtilizationPercent(utilizationEvidence(60, 0)), null);
  assert.equal(getWorkdayUtilization(utilizationEvidence(60, 0)).unavailableReason, "missing_or_invalid_shift");
});

test("workday utilization uses the complete depot-to-depot plan and preserves 0, half, full, and over-shift values", () => {
  assert.equal(calculateWorkdayUtilizationPercent(utilizationEvidence(0, 480)), 0);
  assert.equal(calculateWorkdayUtilizationPercent(utilizationEvidence(240, 480)), 50);
  assert.equal(calculateWorkdayUtilizationPercent(utilizationEvidence(480, 480)), 100);
  assert.equal(calculateWorkdayUtilizationPercent(utilizationEvidence(600, 480)), 125);
});

test("workday utilization uses the driver's actual shift length, including its fixed break window", () => {
  // 09:30–16:00 is a 390-minute available shift. The 30-minute break is
  // part of that shift boundary, while the plan consumes half the workday.
  const result = getWorkdayUtilization(utilizationEvidence(195, 390));
  assert.equal(result.availableShiftMin, 390);
  assert.equal(result.percent, 50);
});

test("rejects invalidated evidence instead of falling back to estimates", () => {
  const evidence = getWorkdayEvidence(
    [
      {
        type: "depot_start",
        startAt: new Date("2026-05-04T07:00:00Z"),
        endAt: new Date("2026-05-04T07:00:00Z"),
        durationMin: 0,
      },
    ],
    null,
    [stop.id],
  );
  assert.equal(evidence.status, "needs_recalculation");
});

test("treats a missing timeline as invalid even when a summary remains", () => {
  const evidence = getWorkdayEvidence(null, {
    shiftMin: 480,
    nonReturnDrivingMin: 0,
    serviceMin: 0,
    waitingMin: 0,
    breakMin: 0,
    returnMin: 0,
    travelReserveMin: 0,
    stopReserveMin: 0,
    totalMin: 0,
    marginMin: 480,
    overtimeMin: 0,
    shiftEndAt: new Date("2026-05-04T15:00:00Z"),
  }, []);
  assert.equal(evidence.status, "needs_recalculation");
});

test("uses the complete authoritative workday including reserves, break, return, and shift end", () => {
  const timeline = [
    ["depot_start", "07:00", "07:00", 0],
    ["driving", "07:00", "07:10", 10],
    ["travel_reserve", "07:10", "07:30", 20],
    ["service", "07:30", "07:45", 15],
    ["stop_reserve", "07:45", "08:05", 20],
    ["break", "12:00", "12:30", 30],
    ["return", "15:50", "16:00", 10],
    ["depot_end", "16:00", "16:00", 0],
  ].map(([type, start, end, durationMin]) => ({
    type,
    startAt: new Date(`2026-05-04T${start}:00Z`),
    endAt: new Date(`2026-05-04T${end}:00Z`),
    durationMin: Number(durationMin),
    ...(type === "service" || type === "driving" ? { stopId: stop.id } : {}),
  }));
  const summary = {
    shiftMin: 540,
    nonReturnDrivingMin: 10,
    serviceMin: 15,
    waitingMin: 0,
    breakMin: 30,
    returnMin: 10,
    travelReserveMin: 20,
    stopReserveMin: 20,
    totalMin: 540,
    marginMin: 0,
    overtimeMin: 0,
    shiftEndAt: new Date("2026-05-04T16:00:00Z"),
  };

  const evidence = getWorkdayEvidence(timeline, summary, [stop.id]);
  assert.equal(evidence.status, "authoritative");
  assert.equal(evidence.summary?.travelReserveMin, 20);
  assert.equal(evidence.summary?.stopReserveMin, 20);
  assert.equal(
    evidence.summary?.shiftEndAt.getTime(),
    new Date("2026-05-04T16:00:00Z").getTime(),
  );

  const [scheduled] = attachWorkdayEvidence(
    computeSchedule([stop]),
    evidence.timeline!,
  );
  assert.equal(
    scheduled.arrivalTime?.getTime(),
    new Date("2026-05-04T07:30:00Z").getTime(),
  );
  assert.equal(
    scheduled.departureTime?.getTime(),
    new Date("2026-05-04T07:45:00Z").getTime(),
  );
});

test("spans split service fragments without treating a break as a new visit", () => {
  const timeline = [
    {
      type: "service",
      startAt: "2026-05-04T07:30:00Z",
      endAt: "2026-05-04T07:45:00Z",
      durationMin: 15,
      stopId: stop.id,
    },
    {
      type: "break",
      startAt: "2026-05-04T07:45:00Z",
      endAt: "2026-05-04T08:15:00Z",
      durationMin: 30,
    },
    {
      type: "service",
      startAt: "2026-05-04T08:15:00Z",
      endAt: "2026-05-04T08:30:00Z",
      durationMin: 15,
      stopId: stop.id,
    },
  ];
  const [scheduled] = attachWorkdayEvidence(computeSchedule([stop]), timeline);
  assert.equal(
    scheduled.arrivalTime?.getTime(),
    new Date("2026-05-04T07:30:00Z").getTime(),
  );
  assert.equal(
    scheduled.departureTime?.getTime(),
    new Date("2026-05-04T08:30:00Z").getTime(),
  );
});

test("uses the final delivery visit after pickup and delivery share a stop id", () => {
  const timeline = [
    {
      type: "service",
      startAt: "2026-05-04T07:30:00Z",
      endAt: "2026-05-04T07:45:00Z",
      durationMin: 15,
      stopId: stop.id,
    },
    {
      type: "break",
      startAt: "2026-05-04T07:45:00Z",
      endAt: "2026-05-04T08:00:00Z",
      durationMin: 15,
    },
    {
      type: "service",
      startAt: "2026-05-04T08:00:00Z",
      endAt: "2026-05-04T08:10:00Z",
      durationMin: 10,
      stopId: stop.id,
    },
    {
      type: "driving",
      startAt: "2026-05-04T08:10:00Z",
      endAt: "2026-05-04T08:30:00Z",
      durationMin: 20,
      stopId: stop.id,
    },
    {
      type: "service",
      startAt: "2026-05-04T08:30:00Z",
      endAt: "2026-05-04T08:40:00Z",
      durationMin: 10,
      stopId: stop.id,
    },
    {
      type: "break",
      startAt: "2026-05-04T08:40:00Z",
      endAt: "2026-05-04T09:00:00Z",
      durationMin: 20,
    },
    {
      type: "service",
      startAt: "2026-05-04T09:00:00Z",
      endAt: "2026-05-04T09:10:00Z",
      durationMin: 10,
      stopId: stop.id,
    },
  ];
  const [scheduled] = attachWorkdayEvidence(computeSchedule([stop]), timeline);
  assert.equal(
    scheduled.arrivalTime?.getTime(),
    new Date("2026-05-04T08:30:00Z").getTime(),
  );
  assert.equal(
    scheduled.departureTime?.getTime(),
    new Date("2026-05-04T09:10:00Z").getTime(),
  );
});

test("does not aggregate an exact finish across a manually invalidated route", () => {
  const validRoute = {
    routeId: "route-valid",
    workdayStatus: "authoritative" as const,
    timeline: [
      {
        type: "depot_end" as const,
        startAt: "2026-05-04T18:00:00Z",
        endAt: "2026-05-04T18:00:00Z",
        durationMin: 0,
      },
    ],
    summary: { overtimeMin: 0 },
  };
  const overtimeRoute = {
    ...validRoute,
    routeId: "route-overtime",
    timeline: [{
      ...validRoute.timeline[0],
      startAt: "2026-05-04T17:30:00Z",
      endAt: "2026-05-04T17:30:00Z",
    }],
    summary: { overtimeMin: 15 },
  };
  const invalidRoute = {
    ...validRoute,
    routeId: "route-manually-invalidated",
    workdayStatus: "needs_recalculation" as const,
    timeline: undefined,
    summary: undefined,
  };

  const mixed = getDispatchFinishEvidence([validRoute, invalidRoute]);
  assert.equal(mixed.allRoutesAuthoritative, false);
  assert.equal(mixed.lastEndTime, null);
  assert.equal(mixed.overtimeEndTime, null);
  assert.equal(mixed.lastEndOverLimit, false);

  const overtime = getDispatchFinishEvidence([validRoute, overtimeRoute]);
  assert.equal(overtime.allRoutesAuthoritative, true);
  assert.equal(
    overtime.lastEndTime?.getTime(),
    new Date("2026-05-04T18:00:00Z").getTime(),
  );
  assert.equal(
    overtime.overtimeEndTime?.getTime(),
    new Date("2026-05-04T17:30:00Z").getTime(),
  );
  assert.equal(overtime.lastEndOverLimit, true);
});
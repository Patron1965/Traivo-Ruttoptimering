import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRouteWorkday, stockholmClock } from "./route-workday";
import type { ALNSNode, ALNSVehicle } from "./alns/types";

const vehicle: ALNSVehicle = {
  id: "v",
  vehicleType: "fossil",
  capacityKg: 1000,
  capacityVolume: 10,
  rangeKm: null,
};
const node = (latitude = 59.33, longitude = 18.07): ALNSNode => ({
  id: "s",
  latitude,
  longitude,
  timeWindowStart: null,
  timeWindowEnd: null,
  serviceDurationMin: 10,
  weightKg: 0,
  volumeM3: 0,
});
const constraints = (end: string, breakStartTime?: string, breakEndTime?: string) => ({
  vehicleId: "v",
  driverName: "D",
  preferredStartTime: "08:00",
  preferredEndTime: end,
  maxDrivingHoursPerDay: 8,
  avoidNightDriving: false,
  breakFrequencyMinutes: 120,
  preferredBreakDurationMin: 15,
  breakStartTime,
  breakEndTime,
});

test("workday includes an explicit return leg and shift margin", () => {
  const result = evaluateRouteWorkday(
    [node(59.43, 18.07)],
    vehicle,
    59.33,
    18.07,
    new Date("2025-01-15T00:00:00Z"),
    constraints("16:00"),
  );
  assert.ok(result.events.some((event) => event.type === "depot_start"));
  assert.ok(result.events.some((event) => event.type === "return" && (event.distanceKm ?? 0) > 0));
  assert.ok(result.events.some((event) => event.type === "depot_end"));
  assert.ok(result.summary.returnMin > 0);
  assert.ok(result.summary.marginMin > 0);
});

test("travel and per-visit reserves are separate, include return and pickup, and do not alter raw service", () => {
  const reservedVehicle = { ...vehicle, travelReservePercent: 10 };
  const pickupDelivery: ALNSNode = {
    ...node(59.43, 18.07),
    pickupLat: 59.38,
    pickupLon: 18.03,
    pickupServiceMin: 10,
    stopReserveMin: 3,
  };
  const result = evaluateRouteWorkday(
    [pickupDelivery],
    reservedVehicle,
    59.33,
    18.07,
    new Date("2025-01-15T00:00:00Z"),
    constraints("16:00"),
  );
  assert.equal(
    result.events.filter((event) => event.type === "service")
      .reduce((sum, event) => sum + event.durationMin, 0),
    20,
  );
  assert.equal(
    result.events.filter((event) => event.type === "stop_reserve")
      .reduce((sum, event) => sum + event.durationMin, 0),
    6,
  );
  assert.ok(result.events.filter((event) => event.type === "travel_reserve").length >= 3);
  assert.equal(result.summary.stopReserveMin, 6);
  assert.ok(result.summary.travelReserveMin > 0);
  assert.ok(result.summary.totalMin >= result.summary.serviceMin
    + result.summary.stopReserveMin + result.summary.travelReserveMin);
});

test("a 20-minute stop reserve and 20% travel reserve are in the authoritative workday", () => {
  const reservedVehicle = { ...vehicle, travelReservePercent: 20 };
  const reservedNode = { ...node(59.43, 18.07), stopReserveMin: 20 };
  const result = evaluateRouteWorkday(
    [reservedNode],
    reservedVehicle,
    59.33,
    18.07,
    new Date("2025-01-15T00:00:00Z"),
    constraints("16:00"),
  );
  assert.equal(result.summary.stopReserveMin, 20);
  assert.ok(result.summary.travelReserveMin > 0);
  assert.ok(result.events.some((event) => event.type === "travel_reserve"));
  assert.ok(result.events.some((event) => event.type === "return"));
  assert.ok(result.summary.totalMin >= result.summary.serviceMin
    + result.summary.stopReserveMin + result.summary.travelReserveMin);
});

test("short shifts report a structured shift-end failure", () => {
  const result = evaluateRouteWorkday(
    [node(59.331, 18.07)],
    vehicle,
    59.33,
    18.07,
    new Date("2025-01-15T00:00:00Z"),
    constraints("08:05"),
  );
  assert.equal(result.feasible, false);
  assert.equal(result.reasonCode, "SHIFT_END");
  assert.ok(result.summary.overtimeMin > 0);
});

test("overtime allowance is strict at zero, exact limit, and limit plus one", () => {
  const exactShift = evaluateRouteWorkday(
    [{ ...node(), serviceDurationMin: 480 }],
    vehicle,
    59.33,
    18.07,
    new Date("2025-01-15T00:00:00Z"),
    constraints("16:00"),
  );
  assert.equal(exactShift.feasible, true);
  assert.equal(exactShift.summary.overtimeMin, 0);

  const withTenMinutes = { ...vehicle, maxDriverOvertimeMin: 10 };
  const exactAllowance = evaluateRouteWorkday(
    [{ ...node(), serviceDurationMin: 490 }],
    withTenMinutes,
    59.33,
    18.07,
    new Date("2025-01-15T00:00:00Z"),
    constraints("16:00"),
  );
  assert.equal(exactAllowance.feasible, true);
  assert.equal(exactAllowance.summary.overtimeMin, 10);
  assert.equal(exactAllowance.summary.allowedOvertimeMin, 10);
  assert.ok(exactAllowance.warnings.some((warning) => warning.code === "OVERTIME_WITHIN_TOLERANCE"));

  const beyondAllowance = evaluateRouteWorkday(
    [{ ...node(), serviceDurationMin: 491 }],
    withTenMinutes,
    59.33,
    18.07,
    new Date("2025-01-15T00:00:00Z"),
    constraints("16:00"),
  );
  assert.equal(beyondAllowance.feasible, false);
  assert.equal(beyondAllowance.summary.overtimeMin, 11);
  assert.equal(beyondAllowance.reasonCode, "SHIFT_END");
});

test("late arrival allowance is strict at exact limit and limit plus one", () => {
  const day = new Date("2025-01-15T00:00:00Z");
  const lateByFive = {
    ...node(),
    pickupLat: 59.33,
    pickupLon: 18.07,
    pickupServiceMin: 5,
    timeWindowEnd: stockholmClock(day, "08:00"),
  };
  const exactAllowance = evaluateRouteWorkday(
    [lateByFive],
    { ...vehicle, allowLateStopsMin: 5 },
    59.33,
    18.07,
    day,
    constraints("16:00"),
  );
  assert.equal(exactAllowance.feasible, true);
  assert.equal(exactAllowance.summary.allowLateStopsMin, 5);
  assert.deepEqual(exactAllowance.summary.lateStopIds, ["s"]);
  assert.ok(exactAllowance.warnings.some((warning) =>
    warning.code === "LATE_STOP_WITHIN_TOLERANCE" && warning.minutes === 5));

  const beyondAllowance = evaluateRouteWorkday(
    [lateByFive],
    { ...vehicle, allowLateStopsMin: 4 },
    59.33,
    18.07,
    day,
    constraints("16:00"),
  );
  assert.equal(beyondAllowance.feasible, false);
  assert.equal(beyondAllowance.reasonCode, "TIME_WINDOW");
});

test("date-only planning uses each resource shift and preserves customer windows", () => {
  const day = new Date("2026-09-13T00:00:00Z");
  const stop = { ...node(), timeWindowStart: stockholmClock(day, "10:00") };
  for (const start of ["08:00", "09:00"]) {
    const result = evaluateRouteWorkday(
      [stop],
      vehicle,
      59.33,
      18.07,
      day,
      { ...constraints("16:00"), preferredStartTime: start },
    );
    assert.equal(result.feasible, true);
    assert.equal(
      result.events.find((event) => event.type === "depot_start")?.startAt,
      stockholmClock(day, start).toISOString(),
    );
    assert.equal(
      result.events.find((event) => event.type === "service")?.startAt,
      stop.timeWindowStart.toISOString(),
    );
    assert.equal(stockholmClock(day, start).toISOString().slice(0, 10), "2026-09-13");
  }
});

test("fixed break windows become timeline events and timezone date is retained", () => {
  const dated = new Date("2025-06-15T00:00:00Z");
  const result = evaluateRouteWorkday(
    [{ ...node(), serviceDurationMin: 90 }],
    vehicle,
    59.33,
    18.07,
    dated,
    constraints("16:00", "08:15", "08:30"),
  );
  const pause = result.events.find((event) => event.type === "break");
  assert.ok(pause);
  assert.equal(pause!.durationMin, 15);
  assert.equal(
    result.events.filter((event) => event.type === "service")
      .reduce((sum, event) => sum + event.durationMin, 0),
    90,
  );
  assert.equal(
    result.events.filter((event) => event.type === "waiting")
      .reduce((sum, event) => sum + event.durationMin, 0),
    15,
  );
  assert.equal(result.events[0].startAt.slice(0, 10), "2025-06-15");
});

test("a break contained in time-window waiting does not delay the absolute window", () => {
  const planned = node();
  planned.timeWindowStart = stockholmClock(new Date("2025-01-15T00:00:00Z"), "09:00");
  const result = evaluateRouteWorkday(
    [planned],
    vehicle,
    59.33,
    18.07,
    new Date("2025-01-15T00:00:00Z"),
    constraints("16:00", "08:15", "08:30"),
  );
  const service = result.events.find((event) => event.type === "service");
  assert.equal(service!.startAt, planned.timeWindowStart.toISOString());
  assert.equal(result.events.filter((event) => event.type === "break")
    .reduce((sum, event) => sum + event.durationMin, 0), 15);
});

test("delivery waits until the full service fits around multiple hard closures", () => {
  const result = evaluateRouteWorkday(
    [{
      ...node(),
      serviceDurationMin: 20,
      unavailablePeriods: [
        { start: "2025-01-15T07:05:00.000Z", end: "2025-01-15T07:10:00.000Z" },
        { start: "2025-01-15T07:15:00.000Z", end: "2025-01-15T07:20:00.000Z" },
      ],
    }],
    vehicle,
    59.33,
    18.07,
    new Date("2025-01-15T00:00:00Z"),
    constraints("16:00"),
  );
  assert.equal(result.feasible, true);
  assert.deepEqual(
    result.events
      .filter((event) => event.type === "service")
      .map((event) => [event.startAt, event.endAt, event.durationMin]),
    [["2025-01-15T07:20:00.000Z", "2025-01-15T07:40:00.000Z", 20]],
  );
  assert.equal(
    result.events.filter((event) => event.type === "waiting")
      .reduce((sum, event) => sum + event.durationMin, 0),
    20,
  );

  const exactEnd = evaluateRouteWorkday(
    [{
      ...node(),
      serviceDurationMin: 10,
      unavailablePeriods: [{
        start: "2025-01-15T07:10:00.000Z",
        end: "2025-01-15T07:20:00.000Z",
      }],
    }],
    vehicle,
    59.33,
    18.07,
    new Date("2025-01-15T00:00:00Z"),
    constraints("16:00"),
  );
  assert.equal(exactEnd.feasible, true);
  assert.equal(exactEnd.events.find((event) => event.type === "service")?.endAt, "2025-01-15T07:10:00.000Z");
});

test("pickup/delivery closures apply only to delivery service", () => {
  const result = evaluateRouteWorkday(
    [{
      ...node(),
      pickupLat: 59.33,
      pickupLon: 18.07,
      pickupServiceMin: 5,
      serviceDurationMin: 10,
      unavailablePeriods: [{
        start: "2025-01-15T07:00:00.000Z",
        end: "2025-01-15T08:00:00.000Z",
      }],
    }],
    vehicle,
    59.33,
    18.07,
    new Date("2025-01-15T00:00:00Z"),
    constraints("16:00"),
  );
  assert.equal(result.feasible, true);
  const services = result.events.filter((event) => event.type === "service");
  assert.equal(services[0]?.startAt, "2025-01-15T07:00:00.000Z");
  assert.equal(services[0]?.endAt, "2025-01-15T07:05:00.000Z");
  assert.equal(services[1]?.startAt, "2025-01-15T08:00:00.000Z");
});

test("a closure that cannot fit before the shift ends is infeasible", () => {
  const result = evaluateRouteWorkday(
    [{
      ...node(),
      serviceDurationMin: 10,
      unavailablePeriods: [{
        start: "2025-01-15T07:00:00.000Z",
        end: "2025-01-15T08:00:00.000Z",
      }],
    }],
    vehicle,
    59.33,
    18.07,
    new Date("2025-01-15T00:00:00Z"),
    constraints("08:30"),
  );
  assert.equal(result.feasible, false);
  assert.equal(result.reasonCode, "SHIFT_END");
});

test("pickup service crossing a break waits and remains contiguous after it", () => {
  const day = new Date("2025-01-15T00:00:00Z");
  const result = evaluateRouteWorkday(
    [{
      ...node(),
      pickupLat: 59.33,
      pickupLon: 18.07,
      pickupServiceMin: 60,
      serviceDurationMin: 10,
    }],
    vehicle,
    59.33,
    18.07,
    day,
    constraints("16:00", "08:30", "08:45"),
  );
  const services = result.events.filter((event) => event.type === "service");
  assert.equal(services[0]?.startAt, stockholmClock(day, "08:45").toISOString());
  assert.equal(services[0]?.durationMin, 60);
  assert.equal(result.events.find((event) => event.type === "break")?.startAt,
    stockholmClock(day, "08:30").toISOString());
  assert.equal(services[1]?.startAt, stockholmClock(day, "09:45").toISOString());
  assert.equal(services[1]?.durationMin, 10);
});

test("Stockholm clock uses CET winter and CEST summer offsets", () => {
  assert.equal(
    stockholmClock(new Date("2025-01-15T00:00:00Z"), "08:00").toISOString(),
    "2025-01-15T07:00:00.000Z",
  );
  assert.equal(
    stockholmClock(new Date("2025-06-15T00:00:00Z"), "08:00").toISOString(),
    "2025-06-15T06:00:00.000Z",
  );
});

test("lunch deferral rechecks closures and rejects late service or overtime", () => {
  const day = new Date("2025-01-15T00:00:00Z");
  const visit: ALNSNode = {
    ...node(),
    serviceDurationMin: 60,
    unavailablePeriods: [{
      start: stockholmClock(day, "09:00").toISOString(),
      end: stockholmClock(day, "09:15").toISOString(),
    }],
  };
  const evaluate = (stop: ALNSNode, end = "16:00") => evaluateRouteWorkday(
    [stop], vehicle, 59.33, 18.07, day, constraints(end, "08:30", "08:45"),
  );
  const result = evaluate(visit);
  const services = result.events.filter(event => event.type === "service");
  assert.equal(result.feasible, true);
  assert.equal(services.length, 1);
  assert.equal(services[0].startAt, stockholmClock(day, "09:15").toISOString());
  assert.equal(services[0].durationMin, 60);
  assert.equal(result.summary.totalMin, 135);
  assert.equal(result.events.reduce((sum, event) => sum + event.durationMin, 0), 135);
  assert.equal(evaluate({ ...visit, timeWindowEnd: stockholmClock(day, "09:00") }).reasonCode, "TIME_WINDOW");
  const overfull = evaluate(visit, "10:00");
  assert.equal(overfull.feasible, false);
  assert.equal(overfull.summary.overtimeMin, 15);
  assert.equal(overfull.reasonCode, "SHIFT_END");
});

test("contiguous lunch scheduling preserves exact locks for pickup and delivery", () => {
  const day = new Date("2025-01-15T00:00:00Z");
  for (const pickup of [false, true]) {
    for (const clock of ["08:00", "08:45"]) {
      const visit: ALNSNode = {
        ...node(),
        serviceDurationMin: 60,
        lockedServiceStartAt: stockholmClock(day, clock),
        ...(pickup ? { pickupLat: 59.33, pickupLon: 18.07, pickupServiceMin: 60 } : {}),
      };
      const result = evaluateRouteWorkday(
        [visit], vehicle, 59.33, 18.07, day, constraints("16:00", "08:30", "08:45"),
      );
      assert.equal(result.feasible, clock === "08:45");
      assert.equal(result.reasonCode, clock === "08:00" ? "PLANNING_LOCK" : undefined);
      assert.ok(result.events.filter(event => event.type === "service")
        .every(event => event.durationMin === 60));
    }
  }
});

test("service ending exactly at lunch remains before the break", () => {
  const day = new Date("2025-01-15T00:00:00Z");
  const result = evaluateRouteWorkday(
    [{ ...node(), serviceDurationMin: 30, lockedServiceStartAt: stockholmClock(day, "08:00") }],
    vehicle, 59.33, 18.07, day, constraints("16:00", "08:30", "08:45"),
  );
  assert.equal(result.feasible, true);
  const services = result.events.filter(event => event.type === "service");
  assert.equal(services.length, 1);
  assert.equal(services[0].endAt, stockholmClock(day, "08:30").toISOString());
});

test("Stockholm clock resolves spring DST transition deterministically", () => {
  const date = new Date("2026-03-29T00:00:00Z");
  assert.equal(stockholmClock(date, "01:00").toISOString(), "2026-03-29T00:00:00.000Z");
  assert.equal(stockholmClock(date, "03:00").toISOString(), "2026-03-29T01:00:00.000Z");
  assert.equal(stockholmClock(date, "02:30").toISOString(), "2026-03-29T01:30:00.000Z");
});

test("Stockholm clock chooses the earlier repeated autumn hour", () => {
  const date = new Date("2026-10-25T00:00:00Z");
  assert.equal(stockholmClock(date, "01:00").toISOString(), "2026-10-24T23:00:00.000Z");
  assert.equal(stockholmClock(date, "02:30").toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(stockholmClock(date, "03:00").toISOString(), "2026-10-25T02:00:00.000Z");
});
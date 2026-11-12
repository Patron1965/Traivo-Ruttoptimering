import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialSolutionFromCW,
  buildInitialSolutionFromCWAsync,
  type ALNSNode,
  type ALNSVehicle,
} from "./index";

const DEPOT = { lat: 59.3293, lon: 18.0686 };

function fixtureStops(count: number): ALNSNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `cooperative-stop-${index}`,
    latitude: DEPOT.lat + (index % 19) * 0.002,
    longitude: DEPOT.lon + Math.floor(index / 19) * 0.002,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 4 + (index % 7),
    weightKg: 1 + (index % 3),
    volumeM3: 0.01,
  }));
}

function fixtureVehicles(): ALNSVehicle[] {
  return Array.from({ length: 4 }, (_, index) => ({
    id: `cooperative-vehicle-${index}`,
    vehicleType: "fossil" as const,
    capacityKg: 1_000,
    capacityVolume: 100,
    rangeKm: null,
  }));
}

test("cooperative CW construction keeps deterministic assignments and services timers", async () => {
  const stops = fixtureStops(228);
  const vehicles = fixtureVehicles();
  const startTime = new Date("2026-08-19T07:00:00.000Z");

  // The synchronous API remains the reference implementation for callers
  // that do not expose progress.
  const sync = buildInitialSolutionFromCW(stops, vehicles, DEPOT.lat, DEPOT.lon, startTime);
  let ticks = 0;
  let maxGapMs = 0;
  let lastTickAt = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    maxGapMs = Math.max(maxGapMs, now - lastTickAt);
    lastTickAt = now;
    ticks++;
  }, 5);

  let cooperative: ReturnType<typeof buildInitialSolutionFromCW>;
  try {
    cooperative = await buildInitialSolutionFromCWAsync(
      stops, vehicles, DEPOT.lat, DEPOT.lon, startTime,
    );
  } finally {
    clearInterval(timer);
  }

  assert.deepEqual(cooperative, sync);
  assert.ok(ticks >= 2, `expected timers during construction, got ${ticks}`);
  assert.ok(maxGapMs < 100, `event-loop gap was ${maxGapMs}ms`);
});
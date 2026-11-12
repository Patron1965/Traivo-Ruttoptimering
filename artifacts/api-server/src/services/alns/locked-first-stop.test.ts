import assert from "node:assert/strict";
import { test } from "node:test";
import { reoptimizeAffectedRoutes } from "./runner";
import type { ALNSNode, ALNSVehicle } from "./types";
import { clearOsrmCache } from "../osrm";

const DEPOT = { latitude: 59.3293, longitude: 18.0686 };

function node(id: string, offset: number): ALNSNode {
  return {
    id,
    latitude: DEPOT.latitude + offset,
    longitude: DEPOT.longitude + offset,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 5,
    weightKg: 10,
    volumeM3: 0.1,
  };
}

test("reoptimization keeps the pinned customer first on its vehicle", async () => {
  const lockedId = "locked-customer";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const coordinates = new URL(String(input)).pathname.split("/").pop() ?? "";
    const count = coordinates.split(";").filter(Boolean).length;
    const distances = Array.from({ length: count }, (_, row) =>
      Array.from({ length: count }, (_, column) => row === column ? 0 : 1_000),
    );
    const durations = Array.from({ length: count }, (_, row) =>
      Array.from({ length: count }, (_, column) => row === column ? 0 : 120),
    );
    return new Response(JSON.stringify({ code: "Ok", distances, durations }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const vehicle: ALNSVehicle = {
    id: "pinned-vehicle",
    vehicleType: "van",
    capacityKg: 1_000,
    capacityVolume: 10,
    rangeKm: null,
  };
  try {
    clearOsrmCache();
    const result = await reoptimizeAffectedRoutes(
      [{
        vehicleId: vehicle.id,
        nodes: [node(lockedId, 0.005), node("movable-customer", 0.01)],
        totalWeight: 20,
        totalVolume: 0.2,
        lockedFirstStopId: lockedId,
      }],
      [vehicle.id],
      [vehicle],
      DEPOT.latitude,
      DEPOT.longitude,
      new Date("2026-08-26T07:00:00.000Z"),
      { timeLimitMs: 100 },
    );
    const route = result.routes.find((candidate) => candidate.vehicleId === vehicle.id);
    assert.ok(route);
    assert.equal(route.lockedFirstStopId, lockedId);
    assert.equal(
      route.nodes.find((candidate) => !candidate.isChargingStation)?.id,
      lockedId,
    );
    assert.equal(result.unassigned.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
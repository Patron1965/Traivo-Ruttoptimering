import assert from "node:assert/strict";
import test from "node:test";
import type { ALNSNode, ALNSVehicle } from "./alns/types";
import {
  classifyUnplannedNodes,
  type StopRow,
} from "./import-route-workflow";

const DEPOT = { latitude: 59.33, longitude: 18.07 };
const PLAN_DATE = new Date("2026-04-06T00:00:00.000Z");

function makeNode(id: string, overrides: Partial<ALNSNode> = {}): ALNSNode {
  return {
    id,
    ...DEPOT,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 10,
    weightKg: 5,
    volumeM3: 0.5,
    ...overrides,
  };
}

function makeResource(
  id: string,
  overrides: Partial<ALNSVehicle> = {},
): Parameters<typeof classifyUnplannedNodes>[2][number] {
  const routingVehicle: ALNSVehicle = {
    id,
    vehicleType: "fossil",
    capacityKg: 100,
    capacityVolume: 10,
    rangeKm: null,
    ...overrides,
  };
  return {
    vehicle: { id, name: id } as any,
    driver: { id: `driver-${id}` } as any,
    routingVehicle,
  };
}

function makeStop(id: string, jobType: string = "delivery"): StopRow {
  return {
    id,
    address: `Address ${id}`,
    jobType,
  } as StopRow;
}

function classify(
  node: ALNSNode,
  stop: StopRow,
  resources: Parameters<typeof classifyUnplannedNodes>[2],
) {
  return classifyUnplannedNodes(
    [node],
    new Map([[node.id, stop]]),
    resources,
    DEPOT.latitude,
    DEPOT.longitude,
    PLAN_DATE,
  );
}

test("capacity diagnostic is emitted only when every eligible pair fails capacity", () => {
  const node = makeNode("capacity-stop", { weightKg: 50, volumeM3: 2 });
  const diagnostics = classify(node, makeStop(node.id), [
    makeResource("limited-weight", { capacityKg: 40, capacityVolume: 10 }),
    makeResource("limited-volume", { capacityKg: 100, capacityVolume: 1 }),
  ]);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "CAPACITY_EXCEEDED");
  assert.match(diagnostics[0]?.detail ?? "", /50 kg och 2\.0 m³/);
  assert.match(diagnostics[0]?.detail ?? "", /samtliga behöriga/);
});

test("field-service diagnostic describes eligibility without inventing a missing requirement", () => {
  const node = makeNode("field-stop");
  const diagnostics = classify(node, makeStop(node.id, "field_service"), [
    makeResource("ineligible-pair", {
      ineligibleStopIds: new Set([node.id]),
    }),
  ]);

  assert.equal(diagnostics[0]?.code, "FIELD_SERVICE_INELIGIBLE");
  assert.match(diagnostics[0]?.detail ?? "", /klarade behörighetskontrollen/);
  assert.doesNotMatch(diagnostics[0]?.detail ?? "", /saknar certifiering/i);
});

test("no exact single-stop cause yields no diagnostic instead of asserting a constraint", () => {
  const node = makeNode("unclassified-stop");
  const diagnostics = classify(node, makeStop(node.id), []);

  assert.deepEqual(diagnostics, []);
});

test("range diagnosis follows the workday evaluator's range reason", () => {
  const node = makeNode("range-stop", {
    latitude: 60,
    longitude: 18,
  });
  const diagnostics = classify(node, makeStop(node.id), [
    makeResource("ev-one", {
      vehicleType: "electric",
      rangeKm: 10,
    }),
  ]);

  assert.equal(diagnostics[0]?.code, "RANGE_EXCEEDED");
  assert.match(diagnostics[0]?.detail ?? "", /räckviddskontrollen/);
});
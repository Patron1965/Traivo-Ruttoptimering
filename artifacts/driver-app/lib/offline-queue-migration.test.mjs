import assert from "node:assert/strict";
import test from "node:test";
import {
  executionEventTypeForStatus,
  migrateLegacyExecutionQueues,
} from "./offline-queue-migration.ts";
import {
  collectLegacyQueueItems,
  safeLegacyRecoveryMetadata,
} from "./offline-quarantine.ts";

test("legacy failed status and proof queues migrate without changing replay order", async () => {
  const seeded = {
    statuses: JSON.parse(`[
      {"id":"legacy-failed","type":"updateStopStatus","stopId":"stop-failed","status":"failed","timestamp":1000},
      {"id":"legacy-completed","type":"updateStopStatus","stopId":"stop-completed","status":"completed","timestamp":2000}
    ]`),
    proofs: JSON.parse(`[
      {"id":"legacy-proof","stopId":"stop-proof","proofType":"photo","proofStage":"delivery","data":"base64","timestamp":3000},
      {"id":"current-proof","stopId":"stop-current","proofType":"barcode","proofStage":"delivery","data":"code","timestamp":4000,"clientEventId":"keep-me","planVersion":9,"occurredAt":"2026-01-01T09:00:00.000Z"}
    ]`),
    serviceReports: JSON.parse(`[
      {"id":"legacy-report","stopId":"stop-report","report":{},"timestamp":5000,"proofs":[{"type":"signature","data":"signature"}]}
    ]`),
  };
  const resolvedStops = [];
  const migrated = await migrateLegacyExecutionQueues(seeded, async (stopId) => {
    resolvedStops.push(stopId);
    return 7;
  });

  assert.deepEqual(
    [
      ...migrated.statuses.map((item) => ({
        timestamp: item.timestamp,
        type: executionEventTypeForStatus(item.status),
      })),
      ...migrated.proofs.map((item) => ({ timestamp: item.timestamp, type: "proof" })),
    ].sort((a, b) => a.timestamp - b.timestamp).map((item) => item.type),
    ["failed", "completed", "proof", "proof"],
  );
  assert.deepEqual(migrated.statuses.map((item) => item.planVersion), [7, 7]);
  assert.equal(migrated.proofs[0].clientEventId, "legacy-proof");
  assert.equal(migrated.proofs[0].planVersion, 7);
  assert.equal(migrated.proofs[0].occurredAt, "1970-01-01T00:00:03.000Z");
  assert.equal(migrated.proofs[1].clientEventId, "keep-me");
  assert.equal(migrated.proofs[1].planVersion, 9);
  assert.equal(migrated.proofs[1].occurredAt, "2026-01-01T09:00:00.000Z");
  assert.equal(migrated.serviceReports[0].proofs?.[0].clientEventId, "legacy-report_proof_0");
  assert.equal(migrated.serviceReports[0].proofs?.[0].planVersion, 7);
  assert.deepEqual(resolvedStops, [
    "stop-failed",
    "stop-completed",
    "stop-proof",
    "stop-report",
  ]);
});

test("legacy quarantine preserves every old queue family and photo payload", () => {
  const sources = [
    {
      queueType: "status",
      sourceKey: "routeai_offline_queue",
      items: [{ id: "status-1", stopId: "stop-1", status: "completed", planVersion: 3 }],
    },
    {
      queueType: "proof",
      sourceKey: "routeai_pod_queue",
      items: [{ id: "proof-1", stopId: "stop-1", proofType: "photo", data: "data:image/jpeg;base64,proof" }],
    },
    {
      queueType: "serviceReport",
      sourceKey: "routeai_sr_queue",
      items: [{
        id: "report-1",
        stopId: "stop-2",
        report: { status: "submitted" },
        proofs: [{ type: "photo", data: "data:image/jpeg;base64,report" }],
      }],
    },
    {
      queueType: "exception",
      sourceKey: "routeai_exception_queue",
      items: [{
        id: "exception-1",
        stopId: "stop-3",
        photoData: "data:image/jpeg;base64,exception",
        clientEventId: "exception-event-1",
        planVersion: 4,
      }],
    },
    {
      queueType: "routeMessage",
      sourceKey: "routeai_message_queue",
      items: [{
        id: "message-1",
        routeId: "route-1",
        stopId: "stop-4",
        body: "old message",
        clientMessageId: "message-client-1",
      }],
    },
  ];
  const quarantined = collectLegacyQueueItems(sources, "2026-01-01T00:00:00.000Z");
  assert.equal(quarantined.length, 5);
  assert.equal(quarantined.find((item) => item.quarantineId === "proof:proof-1").item.data, "data:image/jpeg;base64,proof");
  assert.equal(quarantined.find((item) => item.quarantineId === "serviceReport:report-1").item.proofs[0].data, "data:image/jpeg;base64,report");
  assert.equal(quarantined.find((item) => item.quarantineId === "exception:exception-1").item.photoData, "data:image/jpeg;base64,exception");
  assert.equal(quarantined.every((item) => item.state === "unresolved"), true);
  const safe = safeLegacyRecoveryMetadata(quarantined[2]);
  assert.equal("item" in safe, false);
  assert.equal("photoData" in safe, false);
});
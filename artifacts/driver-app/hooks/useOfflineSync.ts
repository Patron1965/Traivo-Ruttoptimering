import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, ensureRouteExecutionForWork, isStalePlanError, isServerSessionVerified } from "@/lib/api";
import {
  removeFromQueue,
  removeProofFromQueue,
  removeExceptionFromQueue,
  getExceptionQueue,
  getRouteMessageQueue,
  removeRouteMessageFromQueue,
  markQueueItemStatus,
  recoverStuckSyncingItems,
  getServiceReportQueue,
  removeServiceReportFromQueue,
  updateQueuedServiceReport,
  getOrderedExecutionQueue,
  migrateOfflineQueues,
  acquireOfflineSyncLease,
  getStopReportQueue,
  getOfflineQueueItems,
} from "@/lib/offline-queue";
import { sendStopReport } from "@/lib/stop-report";
import { stopReportPort } from "@/lib/report-port";
import { executionEventTypeForStatus } from "@/lib/offline-queue-migration";
import { useNetworkStatus } from "./useNetworkStatus";
import { errorCategory, localizeError } from "@/lib/error-localizer";
import { useT } from "@/lib/i18n";
import { queueFailureStatus } from "@/lib/queue-conflict-policy";

export function useOfflineSync(enabled: boolean, driverId?: string, verifySession?: () => Promise<boolean>) {
  const { isOnline } = useNetworkStatus(true);
  const { lang } = useT();
  const queryClient = useQueryClient();
  const prevOnline = useRef(false);
  const syncInFlight = useRef<Promise<void> | null>(null);
  const lastAttemptAt = useRef(0);

  useEffect(() => {
    if (!enabled) {
      prevOnline.current = false;
      return;
    }
    if (isOnline && !prevOnline.current) {
      void syncAll().catch((err) => {
        console.warn("[OFFLINE] Sync failed; queued items were preserved:", localizeError(err, lang));
      });
    }
    prevOnline.current = isOnline;
  }, [enabled, isOnline, driverId, lang]);

  useEffect(() => {
    if (!enabled || !isOnline) return;
    const timer = setInterval(() => {
      if (Date.now() - lastAttemptAt.current < 15_000) return;
      void getOfflineQueueItems().then((items) => {
        const first = items.find(item => item.syncStatus !== "synced");
        if (first && first.syncStatus !== "conflict") {
          return syncAll();
        }
      }).catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [enabled, isOnline, driverId]);

  function syncAll() {
    if (syncInFlight.current) return syncInFlight.current;
    lastAttemptAt.current = Date.now();
    const run = (async () => {
      // A connectivity signal is not authentication. Verify before even reading
      // or migrating queues, and keep rejected work under its original owner.
      if (!verifySession || !await verifySession()) return;
      const releaseSyncLease = await acquireOfflineSyncLease();
      try {
        if (!isServerSessionVerified()) return;
        try {
          await recoverStuckSyncingItems();
        } catch (err) {
          console.warn("[OFFLINE] Queue recovery failed; queued media was preserved:", localizeError(err, lang));
          return;
        }
        try {
          await migrateOfflineQueues(createLegacyPlanVersionResolver());
        } catch (err) {
          console.warn("[OFFLINE] Queue migration paused:", localizeError(err, lang));
          return;
        }
        const serviceReportsSynced = await syncServiceReportQueue();
        if (!serviceReportsSynced) return;
        if (!await syncExecutionQueue()) return;
        await syncExceptionQueue();
        await syncRouteMessageQueue();
      } finally {
        releaseSyncLease();
      }
    })();
    syncInFlight.current = run.finally(() => {
      syncInFlight.current = null;
    });
    return syncInFlight.current;
  }

  function createLegacyPlanVersionResolver() {
    let planVersions: Promise<Map<string, number>> | null = null;
    return async (stopId: string): Promise<number | null> => {
      if (!driverId) return null;
      if (!planVersions) {
        // Released clients queued no plan version. Snapshot the current
        // driver-visible revision once, persist it in the migration, and let
        // the server reject the replay if the plan changes again afterwards.
        planVersions = (async () => {
          const routes = await api.getRoutes(driverId);
          const routeStops = await Promise.all(
            routes.map(async (route) => ({
              route,
              stops: await api.getRouteStops(route.id),
            })),
          );
          const versions = new Map<string, number>();
          for (const { route, stops } of routeStops) {
            const version = route.planRevision ?? route.handoffVersion;
            if (!Number.isInteger(version) || version < 0) continue;
            for (const stop of stops) versions.set(stop.id, version);
          }
          return versions;
        })();
      }
      return (await planVersions).get(stopId) ?? null;
    };
  }

  async function syncExecutionQueue() {
    const queue = await getOrderedExecutionQueue();
    let synced = 0;
    for (const item of queue) {
      if (item.syncStatus === "conflict" || item.syncStatus === "syncing") {
        if (synced > 0) await queryClient.invalidateQueries();
        return false;
      }
      await markQueueItemStatus(item.queueType, item.id, "syncing");
      try {
        if (item.queueType === "stopReport") {
          await sendStopReport(item, stopReportPort);
          await markQueueItemStatus("stopReport", item.id, "synced");
        } else if (item.queueType === "proof") {
          await api.submitProof(item.stopId, {
            proofType: item.proofType,
            proofStage: item.proofStage,
            data: item.data,
            notes: item.notes,
            clientEventId: item.clientEventId,
            planVersion: item.planVersion,
            occurredAt: item.occurredAt,
          });
          await removeProofFromQueue(item.id);
        } else if (item.queueType === "exception") {
          await api.createStopException(item.stopId, {
            category: item.category,
            comment: item.comment,
            photoData: item.photoData,
            proofStage: item.proofStage,
            clientEventId: item.clientEventId,
            planVersion: item.planVersion,
            occurredAt: item.occurredAt,
          });
          await removeExceptionFromQueue(item.id);
        } else {
          if (item.status === "in_progress") {
            const stop = await api.getStop(item.stopId);
            if (!item.routeId || stop.routeId !== item.routeId) throw new ApiError(409, "STALE_PLAN", "STALE_PLAN");
            await ensureRouteExecutionForWork(stop.routeId, item.planVersion, new Date(item.timestamp).toISOString());
            await api.updateStop(item.stopId, { status: "in_progress" });
          } else {
            await api.createStopExecutionEvent(item.stopId, {
              clientEventId: item.id,
              type: executionEventTypeForStatus(item.status),
              planVersion: item.planVersion,
              occurredAt: new Date(item.timestamp).toISOString(),
              skipReason: item.skipReason,
              comment: item.comment,
              actualDurationMin: item.actualDurationMin,
            });
          }
          await removeFromQueue(item.id);
        }
        synced++;
      } catch (err: any) {
        // Preserve strict ordering: later events must wait behind the first
        // failed or stale event so reconnect cannot reorder driver actions.
        await markQueueItemStatus(
          item.queueType,
          item.id,
          queueFailureStatus(err instanceof ApiError ? err.status : undefined, errorCategory(err)),
          errorCategory(err),
        );
        console.warn("[OFFLINE] Execution sync paused:", item.id, localizeError(err, lang));
        if (synced > 0) queryClient.invalidateQueries();
        return false;
      }
    }
    if (synced > 0) queryClient.invalidateQueries();
    return true;
  }

  async function syncServiceReportQueue(): Promise<boolean> {
    const queue = (await getServiceReportQueue()).filter(
      (item) => item.syncStatus !== "synced",
    );
    if (queue.length === 0) return true;
    console.log(`[OFFLINE] Syncing ${queue.length} queued service reports...`);
    let synced = 0;
    for (const item of queue) {
      if (item.syncStatus === "conflict" || item.syncStatus === "syncing") {
        if (synced > 0) await queryClient.invalidateQueries();
        return false;
      }
      await markQueueItemStatus("serviceReport", item.id, "syncing");
      try {
        const report = { ...item.report };
        const remainingProofs = [...(item.proofs ?? [])];
        while (remainingProofs.length > 0) {
          const proof = remainingProofs[0];
            const res = await api.submitProof(item.stopId, {
              proofType: proof.type,
              proofStage: "delivery", // service evidence is attached as delivery stage
              data: proof.data,
              notes: proof.notes,
              clientEventId: proof.clientEventId,
              planVersion: proof.planVersion,
              occurredAt: proof.occurredAt,
            });
            if (proof.type === "signature" && res?.id) {
              report.signatureEvidenceRef = res.id;
            }
          remainingProofs.shift();
          await updateQueuedServiceReport(
            item.id,
            report,
            remainingProofs.length > 0 ? remainingProofs : undefined,
          );
        }

        await api.putServiceReport(item.stopId, report);
        await removeServiceReportFromQueue(item.id);
        synced++;
      } catch (err) {
        await markQueueItemStatus(
          "serviceReport",
          item.id,
          queueFailureStatus(err instanceof ApiError ? err.status : undefined, errorCategory(err)),
          errorCategory(err),
        );
        console.warn("[OFFLINE] Failed to sync service report:", item.id, localizeError(err, lang));
        if (synced > 0) queryClient.invalidateQueries();
        return false;
      }
    }
    if (synced > 0) {
      console.log(`[OFFLINE] Synced ${synced} service reports`);
      queryClient.invalidateQueries();
    }
    return true;
  }

  async function syncExceptionQueue() {
    const queue = (await getExceptionQueue()).filter(
      (item) => item.syncStatus !== "synced" && item.syncStatus !== "conflict" && item.syncStatus !== "syncing",
    );
    for (const item of queue) {
      await markQueueItemStatus("exception", item.id, "syncing");
      try {
        await api.createStopException(item.stopId, {
          category: item.category,
          comment: item.comment,
          photoData: item.photoData,
          proofStage: item.proofStage,
          clientEventId: item.clientEventId,
          planVersion: item.planVersion,
          occurredAt: item.occurredAt,
        });
        await removeExceptionFromQueue(item.id);
      } catch (err) {
        await markQueueItemStatus(
          "exception",
          item.id,
          isStalePlanError(err) ? "conflict" : "failed",
          errorCategory(err),
        );
        break;
      }
    }
  }

  async function syncRouteMessageQueue() {
    const queue = (await getRouteMessageQueue()).filter(
      (item) => item.syncStatus !== "synced" && item.syncStatus !== "conflict" && item.syncStatus !== "syncing",
    );
    for (const item of queue) {
      await markQueueItemStatus("routeMessage", item.id, "syncing");
      try {
        if (item.stopId) {
          await api.createStopMessage(item.stopId, {
            body: item.body,
            clientMessageId: item.clientMessageId,
          });
        } else {
          await api.createRouteMessage(item.routeId, {
            body: item.body,
            clientMessageId: item.clientMessageId,
          });
        }
        await removeRouteMessageFromQueue(item.id);
        queryClient.invalidateQueries({ queryKey: ["route-messages", item.routeId] });
      } catch (err) {
        await markQueueItemStatus(
          "routeMessage",
          item.id,
          isStalePlanError(err) ? "conflict" : "failed",
          errorCategory(err),
        );
        break;
      }
    }
  }
}

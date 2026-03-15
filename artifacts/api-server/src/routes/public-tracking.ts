import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { db, stopsTable, routesTable, vehiclesTable, deliveryProofsTable, deliveryNotificationsTable } from "@workspace/db";
import { handleError } from "../lib/errors";

const router: IRouter = Router();

function computeEta(stop: typeof stopsTable.$inferSelect, allStops: (typeof stopsTable.$inferSelect)[], routeStatus: string | null): string | null {
  if (stop.status === "completed" || stop.status === "failed") return null;
  if (routeStatus !== "in_progress" && routeStatus !== "optimized") return null;

  if (stop.timeWindowStart) {
    const now = new Date();
    const eta = new Date(stop.timeWindowStart);
    if (eta > now) return eta.toISOString();
  }

  const completedStops = allStops.filter((s) => s.status === "completed").length;
  const totalStops = allStops.length;
  if (totalStops === 0) return null;

  const stopIdx = allStops.findIndex((s) => s.id === stop.id);
  const remainingStops = stopIdx - completedStops;
  if (remainingStops <= 0) {
    const eta = new Date(Date.now() + 5 * 60 * 1000);
    return eta.toISOString();
  }

  const avgServiceMin = 15;
  const avgTravelMin = 10;
  const etaMin = remainingStops * (avgServiceMin + avgTravelMin);
  const eta = new Date(Date.now() + etaMin * 60 * 1000);
  return eta.toISOString();
}

router.get("/track/:code", async (req, res) => {
  try {
    const code = req.params.code;
    if (!code) {
      res.status(400).json({ error: "Tracking code is required" });
      return;
    }

    const [stop] = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.trackingCode, code));

    if (!stop) {
      res.status(404).json({ error: "Tracking code not found" });
      return;
    }

    let vehicleType: string | null = null;
    let vehicleName: string | null = null;
    let routeStatus: string | null = null;
    let allStops: (typeof stopsTable.$inferSelect)[] = [];

    if (stop.routeId) {
      const [route] = await db
        .select()
        .from(routesTable)
        .where(eq(routesTable.id, stop.routeId));

      if (route) {
        routeStatus = route.status;
        if (route.vehicleId) {
          const [vehicle] = await db
            .select()
            .from(vehiclesTable)
            .where(eq(vehiclesTable.id, route.vehicleId));
          if (vehicle) {
            vehicleType = vehicle.vehicleType;
            vehicleName = vehicle.name;
          }
        }

        allStops = await db
          .select()
          .from(stopsTable)
          .where(eq(stopsTable.routeId, stop.routeId))
          .orderBy(asc(stopsTable.sequenceOrder));
      }
    }

    let deliveryStatus: "scheduled" | "on_the_way" | "arriving_soon" | "delivered" | "failed" = "scheduled";
    if (stop.status === "completed") {
      deliveryStatus = "delivered";
    } else if (stop.status === "failed") {
      deliveryStatus = "failed";
    } else if (stop.status === "in_progress") {
      deliveryStatus = "arriving_soon";
    } else if (routeStatus === "in_progress" || routeStatus === "optimized") {
      deliveryStatus = "on_the_way";
    }

    let proofs: { id: string; proofType: string; fileUrl: string | null; data: string | null; capturedAt: Date | null }[] = [];
    if (deliveryStatus === "delivered") {
      proofs = await db
        .select()
        .from(deliveryProofsTable)
        .where(eq(deliveryProofsTable.stopId, stop.id));
    }

    const notifications = await db
      .select()
      .from(deliveryNotificationsTable)
      .where(eq(deliveryNotificationsTable.stopId, stop.id))
      .orderBy(asc(deliveryNotificationsTable.sentAt));

    const estimatedArrival = computeEta(stop, allStops, routeStatus);

    const stopsProgress = allStops.length > 0
      ? { completed: allStops.filter((s) => s.status === "completed").length, total: allStops.length }
      : null;

    res.json({
      trackingCode: code,
      status: deliveryStatus,
      address: stop.address,
      latitude: stop.latitude,
      longitude: stop.longitude,
      timeWindowStart: stop.timeWindowStart?.toISOString() ?? null,
      timeWindowEnd: stop.timeWindowEnd?.toISOString() ?? null,
      vehicleType,
      vehicleName,
      estimatedArrival,
      stopsProgress,
      timeline: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        message: n.message,
        sentAt: n.sentAt.toISOString(),
      })),
      proofs: proofs.map((p) => ({
        id: p.id,
        proofType: p.proofType,
        fileUrl: p.fileUrl,
        data: p.proofType === "barcode" ? p.data : null,
        capturedAt: p.capturedAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;

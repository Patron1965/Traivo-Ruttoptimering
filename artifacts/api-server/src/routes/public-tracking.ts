import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, stopsTable, routesTable, vehiclesTable, deliveryProofsTable } from "@workspace/db";
import { handleError } from "../lib/errors";

const router: IRouter = Router();

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

    let proofs: any[] = [];
    if (deliveryStatus === "delivered") {
      proofs = await db
        .select()
        .from(deliveryProofsTable)
        .where(eq(deliveryProofsTable.stopId, stop.id));
    }

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

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";
import { handleError } from "../lib/errors";
import { getOrgId } from "../middleware/auth";

const router: IRouter = Router();

router.get("/organizations/:id/settings", async (req, res) => {
  try {
    const orgId = req.user?.organizationId ?? req.params.id;
    const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, orgId));
    if (!org) { res.status(404).json({ error: "Organization not found" }); return; }
    res.json({
      autoBalance: org.autoBalance,
      snapToRoad: org.snapToRoad,
      defaultRouteType: org.defaultRouteType,
      maxDriverOvertimeMin: org.maxDriverOvertimeMin,
      allowLateStopsMin: org.allowLateStopsMin,
      defaultServiceDurationMin: org.defaultServiceDurationMin,
      customerSupportType: org.customerSupportType,
      notifyOrderCreated: org.notifyOrderCreated,
      notifyDriverEnRoute: org.notifyDriverEnRoute,
      notifyDelivered: org.notifyDelivered,
      notifyFailed: org.notifyFailed,
      notificationSenderType: org.notificationSenderType,
      notificationTemplate: org.notificationTemplate,
    });
  } catch (err) { handleError(res, err); }
});

router.put("/organizations/:id/settings", async (req, res) => {
  try {
    const orgId = req.user?.organizationId ?? req.params.id;
    const updates: Record<string, unknown> = {};
    const fields = [
      "autoBalance", "snapToRoad", "defaultRouteType",
      "maxDriverOvertimeMin", "allowLateStopsMin", "defaultServiceDurationMin",
      "customerSupportType",
      "notifyOrderCreated", "notifyDriverEnRoute", "notifyDelivered", "notifyFailed",
      "notificationSenderType", "notificationTemplate",
    ];
    for (const f of fields) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    const [org] = await db.update(organizationsTable).set(updates).where(eq(organizationsTable.id, orgId)).returning();
    if (!org) { res.status(404).json({ error: "Organization not found" }); return; }
    res.json(org);
  } catch (err) { handleError(res, err); }
});

export default router;

import { Router, type IRouter } from "express";
import { eq, and, gte, lte, or, ilike, sql, inArray } from "drizzle-orm";
import { db, stopsTable, routesTable } from "@workspace/db";
import { handleError } from "../lib/errors";
import { getOrgId } from "../middleware/auth";

const router: IRouter = Router();

router.get("/reports/dispatched", async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { dateFrom, dateTo, status, search, page = "1", pageSize = "50" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limit = Math.min(100, Math.max(1, parseInt(pageSize)));
    const offset = (pageNum - 1) * limit;

    const conditions = [eq(stopsTable.organizationId, orgId)];

    if (dateFrom) conditions.push(gte(stopsTable.createdAt, new Date(dateFrom)));
    if (dateTo) conditions.push(lte(stopsTable.createdAt, new Date(dateTo)));
    if (status && status !== "all") {
      const validStatuses = ["completed", "failed", "skipped", "in_progress", "pending"] as const;
      if (validStatuses.includes(status as any)) {
        conditions.push(eq(stopsTable.status, status as any));
      }
    }
    if (search) {
      conditions.push(or(
        ilike(stopsTable.address, `%${search}%`),
        ilike(stopsTable.contactName, `%${search}%`),
        ilike(stopsTable.trackingCode, `%${search}%`),
      )!);
    }

    const stops = await db.select({
      id: stopsTable.id,
      address: stopsTable.address,
      contactName: stopsTable.contactName,
      contactEmail: stopsTable.contactEmail,
      status: stopsTable.status,
      trackingCode: stopsTable.trackingCode,
      timeWindowStart: stopsTable.timeWindowStart,
      timeWindowEnd: stopsTable.timeWindowEnd,
      sequenceOrder: stopsTable.sequenceOrder,
      createdAt: stopsTable.createdAt,
      routeId: stopsTable.routeId,
      routeName: routesTable.name,
      routeDate: routesTable.date,
    })
    .from(stopsTable)
    .leftJoin(routesTable, eq(stopsTable.routeId, routesTable.id))
    .where(and(...conditions))
    .orderBy(sql`${stopsTable.createdAt} DESC`)
    .limit(limit)
    .offset(offset);

    const [countResult] = await db.select({ count: sql<number>`count(*)::int` })
      .from(stopsTable)
      .where(and(...conditions));

    res.json({
      items: stops,
      total: countResult?.count ?? 0,
      page: pageNum,
      pageSize: limit,
      totalPages: Math.ceil((countResult?.count ?? 0) / limit),
    });
  } catch (err) { handleError(res, err); }
});

export default router;

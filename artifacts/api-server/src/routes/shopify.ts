import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, shopifyIntegrationsTable, shopifyImportLogsTable, stopsTable } from "@workspace/db";
import { handleError } from "../lib/errors";
import { z } from "zod";
import { importShopifyOrders, verifyShopifyConnection, createShopifyFulfillment } from "../services/shopify";

const router: IRouter = Router();

const ConnectBody = z.object({
  organizationId: z.string().uuid(),
  shopDomain: z.string().min(3),
  accessToken: z.string().min(10),
});

router.post("/integrations/shopify/connect", async (req, res) => {
  try {
    const { organizationId, shopDomain, accessToken } = ConnectBody.parse(req.body);

    const cleanDomain = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");

    if (!cleanDomain.endsWith(".myshopify.com") && !cleanDomain.match(/^[a-zA-Z0-9-]+\.myshopify\.com$/)) {
      res.status(400).json({ error: "Invalid Shopify domain. Must be yourstore.myshopify.com" });
      return;
    }

    const { shopName } = await verifyShopifyConnection(cleanDomain, accessToken);

    const [existing] = await db
      .select()
      .from(shopifyIntegrationsTable)
      .where(eq(shopifyIntegrationsTable.organizationId, organizationId));

    if (existing) {
      await db.update(shopifyIntegrationsTable).set({
        shopDomain: cleanDomain,
        accessToken,
        isActive: true,
        updatedAt: new Date(),
      }).where(eq(shopifyIntegrationsTable.id, existing.id));
    } else {
      await db.insert(shopifyIntegrationsTable).values({
        organizationId,
        shopDomain: cleanDomain,
        accessToken,
      });
    }

    res.json({
      connected: true,
      shopName,
      shopDomain: cleanDomain,
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/integrations/shopify/status/:organizationId", async (req, res) => {
  try {
    const { organizationId } = req.params;

    const [integration] = await db
      .select()
      .from(shopifyIntegrationsTable)
      .where(eq(shopifyIntegrationsTable.organizationId, organizationId));

    if (!integration || !integration.isActive) {
      res.json({ connected: false });
      return;
    }

    const recentLogs = await db
      .select()
      .from(shopifyImportLogsTable)
      .where(eq(shopifyImportLogsTable.organizationId, organizationId))
      .orderBy(desc(shopifyImportLogsTable.importedAt))
      .limit(10);

    res.json({
      connected: true,
      shopDomain: integration.shopDomain,
      lastSyncAt: integration.lastSyncAt,
      totalOrdersImported: integration.totalOrdersImported,
      createdAt: integration.createdAt,
      importHistory: recentLogs.map(log => ({
        id: log.id,
        ordersFound: log.ordersFound,
        ordersImported: log.ordersImported,
        ordersSkipped: log.ordersSkipped,
        errors: log.errors ? JSON.parse(log.errors) : [],
        importedAt: log.importedAt,
      })),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/integrations/shopify/import", async (req, res) => {
  try {
    const { organizationId } = z.object({
      organizationId: z.string().uuid(),
    }).parse(req.body);

    const result = await importShopifyOrders(organizationId);

    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/integrations/shopify/disconnect", async (req, res) => {
  try {
    const { organizationId } = z.object({
      organizationId: z.string().uuid(),
    }).parse(req.body);

    await db.update(shopifyIntegrationsTable).set({
      isActive: false,
      updatedAt: new Date(),
    }).where(eq(shopifyIntegrationsTable.organizationId, organizationId));

    res.json({ disconnected: true });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/integrations/shopify/fulfill", async (req, res) => {
  try {
    const { organizationId, stopId } = z.object({
      organizationId: z.string().uuid(),
      stopId: z.string().uuid(),
    }).parse(req.body);

    const [stop] = await db
      .select()
      .from(stopsTable)
      .where(
        and(
          eq(stopsTable.id, stopId),
          eq(stopsTable.organizationId, organizationId)
        )
      );

    if (!stop || !stop.shopifyOrderId) {
      res.status(404).json({ error: "Stop not found or not a Shopify order" });
      return;
    }

    const [integration] = await db
      .select()
      .from(shopifyIntegrationsTable)
      .where(
        and(
          eq(shopifyIntegrationsTable.organizationId, organizationId),
          eq(shopifyIntegrationsTable.isActive, true)
        )
      );

    if (!integration) {
      res.status(400).json({ error: "No active Shopify integration" });
      return;
    }

    const fulfillResult = await createShopifyFulfillment(
      integration.shopDomain,
      integration.accessToken,
      stop.shopifyOrderId,
      stop.trackingCode || ""
    );

    if (!fulfillResult.success) {
      res.status(502).json({
        fulfilled: false,
        orderId: stop.shopifyOrderId,
        orderName: stop.shopifyOrderName,
        error: fulfillResult.error,
      });
      return;
    }

    res.json({ fulfilled: true, orderId: stop.shopifyOrderId, orderName: stop.shopifyOrderName });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;

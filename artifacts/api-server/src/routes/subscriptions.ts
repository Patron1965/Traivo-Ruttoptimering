import { Router } from "express";
import { db } from "@workspace/db";
import { subscriptionsTable, subscriptionPlansTable, vehiclesTable, stopsTable, driversTable } from "@workspace/db";
import { eq, and, count, gte } from "drizzle-orm";

const router = Router();

router.get("/plans", async (_req, res) => {
  const plans = await db
    .select()
    .from(subscriptionPlansTable)
    .where(eq(subscriptionPlansTable.isActive, true))
    .orderBy(subscriptionPlansTable.monthlyPriceOre);

  const mapped = plans.map((p) => ({
    ...p,
    features: JSON.parse(p.featuresJson),
    monthlyPriceSek: p.monthlyPriceOre / 100,
  }));

  res.json(mapped);
});

router.get("/subscription", async (req, res) => {
  const organizationId = req.query.organizationId as string;
  if (!organizationId) return res.status(400).json({ error: "organizationId required" });

  const rows = await db
    .select({
      subscription: subscriptionsTable,
      plan: subscriptionPlansTable,
    })
    .from(subscriptionsTable)
    .innerJoin(subscriptionPlansTable, eq(subscriptionsTable.planId, subscriptionPlansTable.id))
    .where(eq(subscriptionsTable.organizationId, organizationId));

  if (rows.length === 0) {
    return res.json({ subscription: null });
  }

  const { subscription, plan } = rows[0];

  const [vehicleCount] = await db
    .select({ count: count() })
    .from(vehiclesTable)
    .where(eq(vehiclesTable.organizationId, organizationId));

  const [driverCount] = await db
    .select({ count: count() })
    .from(driversTable)
    .where(eq(driversTable.organizationId, organizationId));

  const [stopCount] = await db
    .select({ count: count() })
    .from(stopsTable)
    .where(
      and(
        eq(stopsTable.organizationId, organizationId),
        subscription.stopsResetAt
          ? gte(stopsTable.createdAt, subscription.stopsResetAt)
          : undefined
      )
    );

  res.json({
    subscription: {
      ...subscription,
      plan: {
        ...plan,
        features: JSON.parse(plan.featuresJson),
        monthlyPriceSek: plan.monthlyPriceOre / 100,
      },
    },
    usage: {
      vehicles: vehicleCount.count,
      drivers: driverCount.count,
      stopsThisMonth: stopCount.count,
    },
  });
});

router.post("/subscription/upgrade", async (req, res) => {
  const { organizationId, planTier } = req.body;
  if (!organizationId || !planTier) {
    return res.status(400).json({ error: "organizationId and planTier required" });
  }

  const [plan] = await db
    .select()
    .from(subscriptionPlansTable)
    .where(eq(subscriptionPlansTable.tier, planTier));

  if (!plan) return res.status(404).json({ error: "Plan not found" });

  const existing = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.organizationId, organizationId));

  if (existing.length > 0) {
    const [updated] = await db
      .update(subscriptionsTable)
      .set({
        planId: plan.id,
        status: "active",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      })
      .where(eq(subscriptionsTable.organizationId, organizationId))
      .returning();

    return res.json({ subscription: updated, plan });
  }

  const [created] = await db
    .insert(subscriptionsTable)
    .values({
      organizationId,
      planId: plan.id,
      status: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      stopsResetAt: new Date(),
    })
    .returning();

  res.json({ subscription: created, plan });
});

router.post("/subscription/cancel", async (req, res) => {
  const { organizationId } = req.body;
  if (!organizationId) return res.status(400).json({ error: "organizationId required" });

  const [updated] = await db
    .update(subscriptionsTable)
    .set({
      cancelAtPeriodEnd: true,
      updatedAt: new Date(),
    })
    .where(eq(subscriptionsTable.organizationId, organizationId))
    .returning();

  if (!updated) return res.status(404).json({ error: "No subscription found" });

  res.json({ subscription: updated });
});

router.post("/signup", async (req, res) => {
  const { organizationName, email, userName } = req.body;
  if (!organizationName || !email || !userName) {
    return res.status(400).json({ error: "organizationName, email, and userName required" });
  }

  const { organizationsTable, usersTable } = await import("@workspace/db");

  const [org] = await db
    .insert(organizationsTable)
    .values({ name: organizationName, email })
    .returning();

  const [user] = await db
    .insert(usersTable)
    .values({
      organizationId: org.id,
      name: userName,
      email,
      role: "admin",
    })
    .returning();

  const [starterPlan] = await db
    .select()
    .from(subscriptionPlansTable)
    .where(eq(subscriptionPlansTable.tier, "starter"));

  const now = new Date();
  const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const [subscription] = await db
    .insert(subscriptionsTable)
    .values({
      organizationId: org.id,
      planId: starterPlan.id,
      status: "trialing",
      trialStartDate: now,
      trialEndDate: trialEnd,
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd,
      stopsResetAt: now,
    })
    .returning();

  res.status(201).json({ organization: org, user, subscription });
});

export default router;

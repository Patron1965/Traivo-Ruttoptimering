import { Router } from "express";
import { db } from "@workspace/db";
import { subscriptionsTable, subscriptionPlansTable, vehiclesTable, stopsTable, driversTable } from "@workspace/db";
import { eq, and, count, gte } from "drizzle-orm";
import { assertOrgScope } from "../middleware/auth";
import { handleError } from "../lib/errors";
import { duplicateLoginEmailError, normalizeLoginEmail, reserveLoginEmail } from "../lib/login-email";

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

router.get("/subscription", async (req, res): Promise<void> => {
  try {
    const organizationId = assertOrgScope(req, req.query.organizationId);

    const rows = await db
      .select({
        subscription: subscriptionsTable,
        plan: subscriptionPlansTable,
      })
      .from(subscriptionsTable)
      .innerJoin(subscriptionPlansTable, eq(subscriptionsTable.planId, subscriptionPlansTable.id))
      .where(eq(subscriptionsTable.organizationId, organizationId));

    if (rows.length === 0) {
      res.json({ subscription: null });
      return;
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
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/subscription/upgrade", async (req, res): Promise<void> => {
  const { organizationId: requestedOrganizationId, planTier } = req.body;
  const organizationId = assertOrgScope(req, requestedOrganizationId);
  if (!planTier) {
    res.status(400).json({ error: "planTier required" });
    return;
  }

  const [plan] = await db
    .select()
    .from(subscriptionPlansTable)
    .where(eq(subscriptionPlansTable.tier, planTier));

  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

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

    res.json({ subscription: updated, plan });
    return;
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

router.post("/subscription/cancel", async (req, res): Promise<void> => {
  const organizationId = assertOrgScope(req, req.body?.organizationId);

  const [updated] = await db
    .update(subscriptionsTable)
    .set({
      cancelAtPeriodEnd: true,
      updatedAt: new Date(),
    })
    .where(eq(subscriptionsTable.organizationId, organizationId))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "No subscription found" });
    return;
  }

  res.json({ subscription: updated });
});

router.post("/signup", async (req, res): Promise<void> => {
  const { organizationName, email, userName } = req.body;
  if (!organizationName || typeof email !== "string" || !email.trim() || !userName) {
    res.status(400).json({ error: "organizationName, email, and userName required" });
    return;
  }

  const { organizationsTable, usersTable } = await import("@workspace/db");

  try {
    const result = await db.transaction(async (tx) => {
      if (!await reserveLoginEmail(tx, email)) throw duplicateLoginEmailError();
      const normalized = normalizeLoginEmail(email);
      const [org] = await tx
        .insert(organizationsTable)
        .values({ name: organizationName, email: normalized })
        .returning();

      const [user] = await tx
        .insert(usersTable)
        .values({
          organizationId: org.id,
          name: userName,
          email: normalized,
          role: "admin",
        })
        .returning();

      const [starterPlan] = await tx
        .select()
        .from(subscriptionPlansTable)
        .where(eq(subscriptionPlansTable.tier, "starter"));

      const now = new Date();
      const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

      const [subscription] = await tx
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

      return { organization: org, user, subscription };
    });
    const { user, ...rest } = result;
    res.status(201).json({ ...rest, user: {
      id: user.id, organizationId: user.organizationId, name: user.name, email: user.email,
      role: user.role, isPlatformAdmin: user.isPlatformAdmin, createdAt: user.createdAt,
    } });
  } catch (error) { handleError(res, error); }
});

export default router;

import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, driverAccessLinksTable, driversTable, routesTable, sessionsTable, usersTable, vehiclesTable } from "@workspace/db";
import { hashToken, notifySessionRevoked, sessionMeta } from "../lib/session";
import { DRIVER_DEVICE_DAYS, driverPhoneHash, driverSessionUser } from "../lib/driver-device-policy";
import { outgoingRoute } from "./outgoing-route-service";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class DriverAccessError extends Error {
  readonly statusCode = 401;
  readonly code = "DRIVER_LINK_INVALID";
  constructor() { super("Länken har gått ut, återkallats eller saknar giltig åtkomst på den här telefonen."); }
}

/** Caller holds the route and driver locks. Plain tokens never enter storage. */
export async function issueDriverAccessLink(tx: Transaction, input: {
  routeId: string; driverId: string; organizationId: string; appUrl: string;
}) {
  const [stored] = await tx.select().from(routesTable).where(and(
    eq(routesTable.id, input.routeId), eq(routesTable.organizationId, input.organizationId),
  ));
  if (!stored) throw new DriverAccessError();
  const route = await outgoingRoute(stored, tx);
  const [driver] = await tx.select().from(driversTable).where(and(
    eq(driversTable.id, input.driverId), eq(driversTable.organizationId, input.organizationId),
  ));
  if (!driver?.isActive || !driver.phone || !driver.vehicleId || route.vehicleId !== driver.vehicleId ||
      route.handoffDriverId !== driver.id || route.handoffStatus === "pending" ||
      route.handoffVersion == null || route.status !== "in_progress") throw new DriverAccessError();
  const token = randomBytes(32).toString("base64url");
  await tx.insert(driverAccessLinksTable).values({
    organizationId: input.organizationId, driverId: driver.id, routeId: route.id,
    tokenHash: hashToken(token), vehicleId: driver.vehicleId,
    phoneHash: driverPhoneHash(driver.phone), accessVersion: driver.accessVersion,
    routeVersion: route.handoffVersion,
    expiresAt: new Date(Date.now() + 48 * 3600_000),
  });
  const url = new URL(input.appUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/activate`;
  url.search = "";
  // Fragment is not sent to servers, access logs, or Referer headers.
  url.hash = `access=${token}`;
  return url.toString();
}

export async function redeemDriverAccessLink(token: string, deviceToken?: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new DriverAccessError();
  return db.transaction(async tx => {
    const [candidate] = await tx.select().from(driverAccessLinksTable)
      .where(eq(driverAccessLinksTable.tokenHash, hashToken(token)));
    if (!candidate) throw new DriverAccessError();
    // Match route mutation lock order. Recheck all authority under locks.
    const [stored] = await tx.select().from(routesTable).where(and(
      eq(routesTable.id, candidate.routeId), eq(routesTable.organizationId, candidate.organizationId),
    )).for("update");
    const [driver] = await tx.select().from(driversTable).where(and(
      eq(driversTable.id, candidate.driverId), eq(driversTable.organizationId, candidate.organizationId),
    )).for("update");
    const [link] = await tx.select().from(driverAccessLinksTable)
      .where(eq(driverAccessLinksTable.id, candidate.id)).for("update");
    if (!stored || !driver?.isActive || !driver.phone || !link ||
        link.expiresAt.getTime() <= Date.now() || driver.accessVersion !== link.accessVersion ||
        driver.vehicleId !== link.vehicleId || driverPhoneHash(driver.phone) !== link.phoneHash) throw new DriverAccessError();
    let route;
    try { route = await outgoingRoute(stored, tx); } catch { throw new DriverAccessError(); }
    if ((route.status !== "in_progress" && !(link.consumedAt && route.status === "completed")) || route.handoffStatus === "pending" ||
        route.handoffDriverId !== driver.id || route.vehicleId !== link.vehicleId ||
        route.handoffVersion !== link.routeVersion) throw new DriverAccessError();
    const [vehicle] = await tx.select({ id: vehiclesTable.id }).from(vehiclesTable).where(and(
      eq(vehiclesTable.id, link.vehicleId), eq(vehiclesTable.organizationId, link.organizationId),
      eq(vehiclesTable.isActive, true),
    ));
    if (!vehicle) throw new DriverAccessError();

    // A consumed SMS remains a bookmark on the already-authorized personal
    // device, never a reusable bearer login on a second device.
    if (link.consumedAt) {
      if (!deviceToken) throw new DriverAccessError();
      const [session] = await tx.select().from(sessionsTable).where(and(
        eq(sessionsTable.tokenHash, hashToken(deviceToken)),
        eq(sessionsTable.organizationId, link.organizationId),
      )).for("update");
      const scope = session?.driverAccess;
      if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now() ||
          Date.now() - session.lastActivityAt.getTime() > DRIVER_DEVICE_DAYS * 86400_000 ||
          !scope || scope.driverId !== driver.id || scope.vehicleId !== link.vehicleId ||
          scope.version !== link.accessVersion || scope.phoneHash !== link.phoneHash) {
        throw new DriverAccessError();
      }
      const [owner] = await tx.select().from(usersTable).where(and(
        eq(usersTable.id, session.userId), eq(usersTable.organizationId, link.organizationId),
        eq(usersTable.driverProfileId, driver.id), eq(usersTable.isActive, true),
      ));
      if (!owner) throw new DriverAccessError();
      return {
        token: deviceToken, routeId: route.id, session: sessionMeta(session), resumed: true,
        user: driverSessionUser({
          id: owner.id, name: driver.name, email: owner.email, role: owner.role,
          organizationId: owner.organizationId, driverProfileId: owner.driverProfileId,
          isPlatformAdmin: owner.isPlatformAdmin,
        }, session),
      };
    }

    let [owner] = await tx.select().from(usersTable).where(and(
      eq(usersTable.driverProfileId, driver.id), eq(usersTable.organizationId, driver.organizationId),
    ));
    if (!owner) {
      // A passwordless, driver-only account is created only where no linked
      // account exists. Existing admin accounts are never edited or elevated.
      [owner] = await tx.insert(usersTable).values({
        organizationId: driver.organizationId, driverProfileId: driver.id,
        name: driver.name, email: `driver-${driver.id}@sms.traivo.invalid`,
        role: "driver", passwordHash: null,
      }).returning();
    }
    if (!owner.isActive) throw new DriverAccessError();
    const sessionToken = randomBytes(32).toString("hex");
    const [session] = await tx.insert(sessionsTable).values({
      userId: owner.id, organizationId: driver.organizationId, tokenHash: hashToken(sessionToken),
      expiresAt: new Date(Date.now() + DRIVER_DEVICE_DAYS * 86400_000),
      driverAccess: { driverId: driver.id, vehicleId: link.vehicleId, phoneHash: link.phoneHash, version: link.accessVersion },
    }).returning();
    await tx.update(driverAccessLinksTable).set({ consumedAt: new Date() }).where(eq(driverAccessLinksTable.id, link.id));
    return {
      token: sessionToken, routeId: route.id, session: sessionMeta(session), resumed: false,
      user: driverSessionUser({
        id: owner.id, name: driver.name, email: owner.email, role: owner.role,
        organizationId: owner.organizationId, driverProfileId: owner.driverProfileId, isPlatformAdmin: owner.isPlatformAdmin,
      }, session),
    };
  });
}

export async function revokeDriverAccess(driverId: string, organizationId: string) {
  const revoked = await db.transaction(async tx => {
    const [driver] = await tx.update(driversTable).set({ accessVersion: sql`${driversTable.accessVersion} + 1` })
      .where(and(eq(driversTable.id, driverId), eq(driversTable.organizationId, organizationId))).returning();
    if (!driver) throw Object.assign(new Error("Föraren finns inte."), { statusCode: 404 });
    return tx.update(sessionsTable).set({ revokedAt: new Date() }).where(and(
      eq(sessionsTable.organizationId, organizationId), isNull(sessionsTable.revokedAt),
      sql`${sessionsTable.driverAccess}->>'driverId' = ${driverId}`,
    )).returning({ id: sessionsTable.id });
  });
  for (const row of revoked) notifySessionRevoked(row.id);
  return { revoked: revoked.length };
}

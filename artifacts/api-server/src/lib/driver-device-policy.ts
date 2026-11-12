import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, driversTable, usersTable, vehiclesTable, type Session } from "@workspace/db";

export const DRIVER_DEVICE_DAYS = 30;
export const driverPhoneHash = (phone: string) =>
  createHash("sha256").update(phone.replace(/[\s()-]/g, "")).digest("hex");

export async function validDriverDevice(session: Session): Promise<boolean> {
  const scope = session.driverAccess;
  if (!scope) return false;
  const [driver] = await db.select().from(driversTable).where(and(
    eq(driversTable.id, scope.driverId), eq(driversTable.organizationId, session.organizationId),
  ));
  const [owner] = await db.select({ id: usersTable.id }).from(usersTable).where(and(
    eq(usersTable.id, session.userId), eq(usersTable.organizationId, session.organizationId),
    eq(usersTable.driverProfileId, scope.driverId), eq(usersTable.isActive, true),
  ));
  const [vehicle] = await db.select({ id: vehiclesTable.id }).from(vehiclesTable).where(and(
    eq(vehiclesTable.id, scope.vehicleId), eq(vehiclesTable.organizationId, session.organizationId),
    eq(vehiclesTable.isActive, true),
  ));
  return Boolean(owner && vehicle && driver?.isActive && driver.phone && driver.vehicleId === scope.vehicleId &&
    driver.accessVersion === scope.version && driverPhoneHash(driver.phone) === scope.phoneHash);
}

export function driverSessionUser<T extends { role: string; isPlatformAdmin?: boolean; driverProfileId: string | null }>(
  user: T, session: Pick<Session, "driverAccess">,
): T {
  return session.driverAccess ? {
    ...user, role: "driver", isPlatformAdmin: false, driverProfileId: session.driverAccess.driverId,
  } : user;
}

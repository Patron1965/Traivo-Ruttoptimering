import type { AuthUser, Driver, LoginResponse } from "./api";

export const OFFLINE_SESSION_KEY = "routeai_verified_offline_session_v1";
export const MAX_OFFLINE_MS = 12 * 60 * 60 * 1000;

export interface OfflineSession {
  version: 1;
  token: string;
  user: AuthUser;
  driver: Driver;
  verifiedAt: number;
  expiresAt: number;
}

export function createOfflineSession(
  token: string, user: AuthUser, driver: Driver | null,
  session: LoginResponse["session"], now = Date.now(),
): OfflineSession | null {
  if (user.role !== "driver" || !driver || driver.id !== user.driverProfileId ||
      driver.organizationId !== user.organizationId || !driver.vehicleId) return null;
  const expiresAt = Math.min(
    Date.parse(session.absoluteExpiresAt),
    now + session.idleTimeoutMin * 60_000,
    now + MAX_OFFLINE_MS,
  );
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { version: 1, token, user, driver, verifiedAt: now, expiresAt };
}

export function readOfflineSession(raw: string | null, token: string, now = Date.now()): OfflineSession | null {
  try {
    const value = JSON.parse(raw ?? "null") as OfflineSession | null;
    if (!value || value.version !== 1 || value.token !== token ||
        !Number.isFinite(value.verifiedAt) || !Number.isFinite(value.expiresAt) ||
        now < value.verifiedAt || now >= value.expiresAt ||
        value.expiresAt > value.verifiedAt + MAX_OFFLINE_MS ||
        !value.user?.id || !value.user.organizationId || value.user.role !== "driver" ||
        !value.driver?.vehicleId || value.driver.id !== value.user.driverProfileId ||
        value.driver.organizationId !== value.user.organizationId) return null;
    return value;
  } catch {
    return null;
  }
}

export function sameOfflineAssignment(previous: OfflineSession, user: AuthUser, driver: Driver | null): boolean {
  return user.id === previous.user.id && user.organizationId === previous.user.organizationId &&
    user.role === previous.user.role && driver?.id === previous.driver.id &&
    driver?.vehicleId === previous.driver.vehicleId;
}

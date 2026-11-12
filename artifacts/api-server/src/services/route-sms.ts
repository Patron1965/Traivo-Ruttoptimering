import { and, eq } from "drizzle-orm";
import {
  db,
  driversTable,
  routesTable,
} from "@workspace/db";
import { isSmsConfigured, sendSms } from "./sms";
import { outgoingRoute, OutgoingVersionError } from "./outgoing-route-service";
import { issueDriverAccessLink } from "./driver-access";

export type RouteSmsResultStatus = "sent" | "not_configured" | "missing_phone" | "failed";
export type RouteSmsResultCode =
  | "sms_sent"
  | "sms_not_configured"
  | "sms_missing_phone"
  | "sms_failed";

export interface RouteSmsResult {
  routeId: string;
  driverId: string;
  status: RouteSmsResultStatus;
  sent: boolean;
  code: RouteSmsResultCode;
  message: string;
}

export interface RouteSmsError {
  statusCode: 400 | 404 | 409;
  code:
    | "invalid_request"
    | "route_not_found"
    | "route_not_active"
    | "handoff_missing"
    | "handoff_stale"
    | "recipient_mismatch"
    | "recipient_unavailable";
  message: string;
}

export type RouteSmsOutcome =
  | { result: RouteSmsResult }
  | { error: RouteSmsError };

export function buildRouteDriverAppUrl(input: {
  requestOrigin: string;
  routeId: string;
  configuredUrl?: string;
}): string {
  const appUrl = new URL(
    input.configuredUrl?.trim() || "/driver-app/",
    input.requestOrigin,
  );
  appUrl.searchParams.set("routeId", input.routeId);
  return appUrl.toString();
}

export function buildRouteDriverSmsMessage(input: {
  routeName: string;
  totalStops: number;
  driverAppUrl: string;
}): string {
  const countText = input.totalStops > 0 ? ` (${input.totalStops} stopp)` : "";
  const suffix = `${countText}. Öppna uppdraget i förarappen: ${input.driverAppUrl}`;
  // Never let the provider's 459-character cap cut the one-time credential.
  const name = input.routeName.slice(0, Math.max(0, 459 - suffix.length - "Ny rutt: ".length));
  if (suffix.length + "Ny rutt: ".length > 459) throw new Error("Driver link exceeds SMS limit");
  return `Ny rutt: ${name}${suffix}`;
}

function routeSmsError(
  statusCode: RouteSmsError["statusCode"],
  code: RouteSmsError["code"],
  message: string,
): { error: RouteSmsError } {
  return { error: { statusCode, code, message } };
}

function routeSmsResult(
  routeId: string,
  driverId: string,
  status: RouteSmsResultStatus,
  sent: boolean,
  code: RouteSmsResultCode,
  message: string,
): { result: RouteSmsResult } {
  return { result: { routeId, driverId, status, sent, code, message } };
}

/**
 * Resend the current handoff notification without changing the route's
 * lifecycle. The route and its persisted handoff recipient are locked for the
 * duration of the provider call so a phone/assignment write cannot race the
 * number used for the send.
 */
export async function resendRouteSms(input: {
  routeId: string;
  organizationId: string;
  expectedDriverId: string;
  driverAppUrl: string;
}): Promise<RouteSmsOutcome> {
  return db.transaction(async (tx) => {
    let [route] = await tx
      .select()
      .from(routesTable)
      .where(and(
        eq(routesTable.id, input.routeId),
        eq(routesTable.organizationId, input.organizationId),
      ))
      .limit(1)
      .for("update");

    if (!route) {
      return routeSmsError(404, "route_not_found", "Rutten kunde inte hittas.");
    }
    if (route.handoffVersion != null || route.dispatchSnapshotVersion != null) {
      try { route = await outgoingRoute(route, tx); }
      catch (error) {
        if (error instanceof OutgoingVersionError) return routeSmsError(409, "handoff_stale", error.message);
        throw error;
      }
    }

    if (route.status !== "in_progress") {
      return routeSmsError(
        409,
        "route_not_active",
        "SMS kan bara skickas för en aktiv rutt.",
      );
    }

    if (
      route.handoffStatus === "pending"
      || route.handoffVersion == null
      || route.handoffDriverId == null
    ) {
      return routeSmsError(
        409,
        "handoff_missing",
        "Rutten har ingen aktuell utskicksmottagare.",
      );
    }

    if (route.handoffVersion !== route.planRevision) {
      return routeSmsError(
        409,
        "handoff_stale",
        "Ruttplanen har ändrats sedan utskicket. Ladda om rutten innan SMS skickas.",
      );
    }

    if (route.handoffDriverId !== input.expectedDriverId) {
      return routeSmsError(
        409,
        "recipient_mismatch",
        "Den valda chauffören är inte den sparade utskicksmottagaren.",
      );
    }

    const [driver] = await tx
      .select({
        id: driversTable.id,
        phone: driversTable.phone,
        vehicleId: driversTable.vehicleId,
        isActive: driversTable.isActive,
      })
      .from(driversTable)
      .where(and(
        eq(driversTable.id, route.handoffDriverId),
        eq(driversTable.organizationId, input.organizationId),
      ))
      .limit(1)
      .for("update");

    if (
      !driver
      || !driver.isActive
    ) {
      return routeSmsError(
        409,
        "recipient_unavailable",
        "Den sparade chauffören är inte längre tillgänglig.",
      );
    }

    if (!driver.phone?.trim()) {
      return routeSmsResult(
        route.id,
        driver.id,
        "missing_phone",
        false,
        "sms_missing_phone",
        "Chauffören saknar telefonnummer. Inget SMS skickades.",
      );
    }

    if (!isSmsConfigured()) {
      return routeSmsResult(
        route.id,
        driver.id,
        "not_configured",
        false,
        "sms_not_configured",
        "Ingen SMS-leverantör är konfigurerad. Inget SMS skickades.",
      );
    }

    let sent = false;
    try {
      const accessUrl = await issueDriverAccessLink(tx, {
        routeId: route.id, driverId: driver.id,
        organizationId: input.organizationId, appUrl: input.driverAppUrl,
      });
      sent = await sendSms(
        driver.phone,
        buildRouteDriverSmsMessage({
          routeName: route.name,
          totalStops: route.totalStops,
          driverAppUrl: accessUrl,
        }),
        input.organizationId,
      );
    } catch {
      // Provider failures are deliberately reduced to a safe result. The
      // provider response, credentials, and recipient are not returned.
      sent = false;
    }

    return sent
      ? routeSmsResult(
          route.id,
          driver.id,
          "sent",
          true,
          "sms_sent",
          "SMS skickades.",
        )
      : routeSmsResult(
          route.id,
          driver.id,
          "failed",
          false,
          "sms_failed",
          "SMS-leverantören kunde inte skicka meddelandet. Försök igen.",
        );
  });
}
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DisposableAuthFixture } from "./planning-draft-fixture";

const exec = promisify(execFile);

/** Only freshly provisioned disposable tenants may be passed here. No dispatch/send API. */
export async function seedResumeRoute(auth: DisposableAuthFixture, mobileUrl: string) {
  const { stdout } = await exec("pnpm", ["--filter", "@workspace/api-server", "exec", "tsx", "--eval", `
    import { db, pool, organizationsTable, vehiclesTable, driversTable, routesTable,
      stopsTable, routeDispatchSnapshotsTable } from "@workspace/db";
    import { eq } from "drizzle-orm";
    import { captureRouteDispatchSnapshot } from "./src/services/route-dispatch-snapshot-service";
    import { issueDriverAccessLink } from "./src/services/driver-access";
    (async () => { try {
      const organizationId = process.env.FIXTURE_ORG!;
      const result = await db.transaction(async tx => {
        const isolation = await pool.query(
          "SELECT (SELECT count(*) FROM webhooks WHERE organization_id=$1) + (SELECT count(*) FROM shopify_integrations WHERE organization_id=$1) + (SELECT count(*) FROM routes WHERE organization_id=$1) AS total",
          [organizationId]);
        if (Number(isolation.rows[0].total) !== 0) throw new Error("Expected empty disposable tenant");
        await tx.update(organizationsTable).set({ smsEnabled: false, notifySmsApproaching: false,
          notifySmsDelivered: false, notifySmsFailed: false }).where(eq(organizationsTable.id, organizationId));
        const [vehicle] = await tx.insert(vehiclesTable).values({
          organizationId, name: "Synthetic resume vehicle", licensePlate: "RESUME-TEST",
        }).returning();
        // Fictional reserved number; needed for device policy, never sent to a provider.
        const [driver] = await tx.insert(driversTable).values({
          organizationId, vehicleId: vehicle.id, name: "Synthetic resume driver", phone: "+447700900123",
        }).returning();
        const [route] = await tx.insert(routesTable).values({
          organizationId, vehicleId: vehicle.id, name: "Synthetic resume revision zero",
          date: new Date(), status: "in_progress", planRevision: 0,
          handoffVersion: 0, handoffDriverId: driver.id, handoffStatus: "accepted",
          sentAt: new Date(), acceptedAt: new Date(), totalStops: 2,
          notifyApproaching: false, notifyDelivered: false, notifyFailed: false,
        }).returning();
        const stops = await tx.insert(stopsTable).values([1, 2].map(index => ({
          organizationId, routeId: route.id, address: "Synthetic resume stop " + index,
          latitude: 59.3293, longitude: 18.0686, sequenceOrder: index,
          jobType: "delivery" as const, serviceDurationMin: 5,
        }))).returning();
        await captureRouteDispatchSnapshot(tx, route, stops, driver.id, new Date());
        const [snapshot] = await tx.select().from(routeDispatchSnapshotsTable)
          .where(eq(routeDispatchSnapshotsTable.routeId, route.id));
        if (snapshot.planRevision !== 0 || !snapshot.route.__vehicle || !snapshot.route.__driver)
          throw new Error("Canonical resource snapshot missing");
        const activationUrl = await issueDriverAccessLink(tx, {
          organizationId, routeId: route.id, driverId: driver.id, appUrl: process.env.FIXTURE_URL!,
        });
        return { routeId: route.id, vehicleId: vehicle.id, driverId: driver.id,
          stopId: stops[0].id, activationUrl };
      });
      console.log(JSON.stringify(result));
    } finally { await pool.end(); } })().catch(() => { process.exitCode = 1; });
  `], { env: { ...process.env, FIXTURE_ORG: auth.organizationId, FIXTURE_URL: mobileUrl } });
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as {
    routeId: string; vehicleId: string; driverId: string; stopId: string; activationUrl: string;
  };
}

export async function readResumeEvidence(auth: DisposableAuthFixture) {
  const { stdout } = await exec("pnpm", ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", `
    import { pool } from "@workspace/db";
    (async () => { try {
      const result = await pool.query(
        "SELECT (SELECT count(*) FROM route_executions WHERE organization_id=$1) AS executions, (SELECT count(DISTINCT start_client_event_id) FROM route_executions WHERE organization_id=$1) AS starts, (SELECT count(*) FROM delivery_notifications WHERE stop_id IN (SELECT id FROM stops WHERE organization_id=$1)) AS notifications",
        [process.env.FIXTURE_ORG]);
      console.log(JSON.stringify(result.rows[0]));
    } finally { await pool.end(); } })();
  `], { env: { ...process.env, FIXTURE_ORG: auth.organizationId } });
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as { executions: string; starts: string; notifications: string };
}

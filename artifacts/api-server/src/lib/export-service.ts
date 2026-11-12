import { eq, inArray } from "drizzle-orm";
import {
  db,
  organizationsTable,
  usersTable,
  userGroupsTable,
  customersTable,
  customerSitesTable,
  customerVisitIdempotencyTable,
  vehiclesTable,
  driversTable,
  routesTable,
  stopsTable,
  routeHistoryTable,
  routeTemplatesTable,
  geofenceEventsTable,
  vehiclePositionsTable,
  notificationsTable,
  webhooksTable,
  shopifyIntegrationsTable,
  shopifyImportLogsTable,
  subscriptionsTable,
  auditLogTable,
  deliveryProofsTable,
  deliveryNotificationsTable,
  driverPreferencesTable,
  driverBehaviorLogsTable,
  driverLearnedProfilesTable,
} from "@workspace/db";

export interface OrgExport {
  generatedAt: string;
  organizationId: string;
  tables: Record<string, Record<string, unknown>[]>;
}

/** Human-readable description of every exported table (used in the CSV README). */
export const TABLE_DESCRIPTIONS: Record<string, string> = {
  organizations: "Organisationens profil och inställningar",
  users: "Användarkonton och roller (lösenord och tvåstegsverifieringsuppgifter exkluderade)",
  user_groups: "Användargrupper",
  customers: "Kunder",
  customer_sites: "Återanvändbara kundadresser och verifieringsmetadata",
  customer_visit_idempotency: "Idempotensposter för planerade kundbesök",
  vehicles: "Fordon i flottan",
  drivers: "Förare",
  routes: "Rutter med distans, CO2 och status",
  stops: "Stopp/leveranser med adress och status",
  delivery_proofs: "Leveransbevis (foto/signatur/streckkod), filhänvisningar",
  delivery_notifications: "Skickade leveransnotiser",
  route_history: "Historiska ögonblicksbilder av rutter",
  route_templates: "Ruttmallar",
  geofence_events: "Geofence-händelser (ankomst/avgång)",
  vehicle_positions: "Loggade fordonspositioner",
  notifications: "Systemnotiser",
  webhooks: "Konfigurerade webhooks",
  driver_preferences: "Förarpreferenser",
  driver_behavior_logs: "Loggar över förarbeteende",
  driver_learned_profiles: "Inlärda förarprofiler",
  shopify_integrations: "Shopify-integrationer (åtkomsttoken exkluderad)",
  shopify_import_logs: "Shopify-importloggar",
  subscriptions: "Prenumerationer",
  audit_log: "Säkerhets- och ändringslogg",
};

function omit<T extends Record<string, unknown>>(rows: T[], keys: string[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const k of keys) delete copy[k];
    return copy;
  });
}

/**
 * Collect ALL of an organization's data into a single structured object.
 * Directly org-scoped tables filter on organizationId; child tables
 * (proofs/notifications/driver-* ) are scoped via their parent ids.
 * Secrets are stripped: user passwordHash and MFA fields, webhook secret and Shopify access
 * token are never included, and the auth `sessions` table is intentionally
 * excluded.
 */
export async function collectOrgData(orgId: string): Promise<OrgExport> {
  const [
    organizations,
    users,
    userGroups,
    customers,
    customerSites,
    customerVisitIdempotency,
    vehicles,
    drivers,
    routes,
    stops,
    routeHistory,
    routeTemplates,
    geofenceEvents,
    vehiclePositions,
    notifications,
    webhooks,
    shopifyIntegrations,
    shopifyImportLogs,
    subscriptions,
    auditLog,
  ] = await Promise.all([
    db.select().from(organizationsTable).where(eq(organizationsTable.id, orgId)),
    db.select().from(usersTable).where(eq(usersTable.organizationId, orgId)),
    db.select().from(userGroupsTable).where(eq(userGroupsTable.organizationId, orgId)),
    db.select().from(customersTable).where(eq(customersTable.organizationId, orgId)),
    db.select().from(customerSitesTable).where(eq(customerSitesTable.organizationId, orgId)),
    db.select().from(customerVisitIdempotencyTable).where(eq(customerVisitIdempotencyTable.organizationId, orgId)),
    db.select().from(vehiclesTable).where(eq(vehiclesTable.organizationId, orgId)),
    db.select().from(driversTable).where(eq(driversTable.organizationId, orgId)),
    db.select().from(routesTable).where(eq(routesTable.organizationId, orgId)),
    db.select().from(stopsTable).where(eq(stopsTable.organizationId, orgId)),
    db.select().from(routeHistoryTable).where(eq(routeHistoryTable.organizationId, orgId)),
    db.select().from(routeTemplatesTable).where(eq(routeTemplatesTable.organizationId, orgId)),
    db.select().from(geofenceEventsTable).where(eq(geofenceEventsTable.organizationId, orgId)),
    db.select().from(vehiclePositionsTable).where(eq(vehiclePositionsTable.organizationId, orgId)),
    db.select().from(notificationsTable).where(eq(notificationsTable.organizationId, orgId)),
    db.select().from(webhooksTable).where(eq(webhooksTable.organizationId, orgId)),
    db.select().from(shopifyIntegrationsTable).where(eq(shopifyIntegrationsTable.organizationId, orgId)),
    db.select().from(shopifyImportLogsTable).where(eq(shopifyImportLogsTable.organizationId, orgId)),
    db.select().from(subscriptionsTable).where(eq(subscriptionsTable.organizationId, orgId)),
    db.select().from(auditLogTable).where(eq(auditLogTable.organizationId, orgId)),
  ]);

  const stopIds = stops.map((s) => s.id);
  const driverIds = drivers.map((d) => d.id);

  const [
    deliveryProofs,
    deliveryNotifications,
    driverPreferences,
    driverBehaviorLogs,
    driverLearnedProfiles,
  ] = await Promise.all([
    stopIds.length
      ? db.select().from(deliveryProofsTable).where(inArray(deliveryProofsTable.stopId, stopIds))
      : Promise.resolve([] as Record<string, unknown>[]),
    stopIds.length
      ? db.select().from(deliveryNotificationsTable).where(inArray(deliveryNotificationsTable.stopId, stopIds))
      : Promise.resolve([] as Record<string, unknown>[]),
    driverIds.length
      ? db.select().from(driverPreferencesTable).where(inArray(driverPreferencesTable.driverId, driverIds))
      : Promise.resolve([] as Record<string, unknown>[]),
    driverIds.length
      ? db.select().from(driverBehaviorLogsTable).where(inArray(driverBehaviorLogsTable.driverId, driverIds))
      : Promise.resolve([] as Record<string, unknown>[]),
    driverIds.length
      ? db.select().from(driverLearnedProfilesTable).where(inArray(driverLearnedProfilesTable.driverId, driverIds))
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    organizationId: orgId,
    tables: {
      organizations,
      users: omit(users, ["passwordHash", "mfaRecoveryRequired", "mfaSecret", "mfaPendingSecret", "mfaPendingSessionId",
        "mfaLastStep", "mfaRecoveryHashes", "mfaFailedAttempts", "mfaFailureWindowStartedAt", "mfaLockedUntil"]),
      user_groups: userGroups,
      customers,
      customer_sites: customerSites,
      customer_visit_idempotency: customerVisitIdempotency,
      vehicles,
      drivers,
      routes,
      stops,
      delivery_proofs: deliveryProofs,
      delivery_notifications: deliveryNotifications,
      route_history: routeHistory,
      route_templates: routeTemplates,
      geofence_events: geofenceEvents,
      vehicle_positions: vehiclePositions,
      notifications,
      webhooks: omit(webhooks, ["secret"]),
      driver_preferences: driverPreferences,
      driver_behavior_logs: driverBehaviorLogs,
      driver_learned_profiles: driverLearnedProfiles,
      shopify_integrations: omit(shopifyIntegrations, ["accessToken"]),
      shopify_import_logs: shopifyImportLogs,
      subscriptions,
      audit_log: auditLog,
    },
  };
}

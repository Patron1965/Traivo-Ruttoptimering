import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

export const E2E_DEPOT = {
  latitude: 59.3293,
  longitude: 18.0686,
} as const;

type DepotVerification = {
  provider: "nominatim";
  source: "nominatim";
  displayName: string;
  query: string;
};

const DEPOT_START = {
  address: "E2E address persistence depot start, Stockholm",
  latitude: E2E_DEPOT.latitude,
  longitude: E2E_DEPOT.longitude,
  verifiedAt: "2026-01-01T00:00:00.000Z",
  verification: {
    provider: "nominatim",
    source: "nominatim",
    displayName: "E2E address persistence depot start, Stockholm",
    query: "E2E address persistence depot start, Stockholm",
  } satisfies DepotVerification,
} as const;

const DEPOT_END = {
  address: "E2E address persistence depot end, Stockholm",
  latitude: E2E_DEPOT.latitude,
  longitude: E2E_DEPOT.longitude,
  verifiedAt: "2026-01-01T00:00:00.000Z",
  verification: {
    provider: "nominatim",
    source: "nominatim",
    displayName: "E2E address persistence depot end, Stockholm",
    query: "E2E address persistence depot end, Stockholm",
  } satisfies DepotVerification,
} as const;

export type DisposableAuthFixture = {
  organizationId: string;
  userId: string;
  email: string;
  password: string;
};

const execFileAsync = promisify(execFile);

export async function provisionDisposableAuthFixture(
  suffix: string,
  options: { databaseSchema?: string } = {},
): Promise<DisposableAuthFixture> {
  if (options.databaseSchema && !/^district_e2e_[a-f0-9]{32}$/.test(options.databaseSchema)) {
    throw new Error("Invalid isolated district fixture schema");
  }
  const fixture: DisposableAuthFixture = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    email: `e2e-address-persistence-${suffix}@example.test`,
    password: `Address-${randomUUID()}-Aa1!`,
  };

  const script = `
    import { randomBytes, scrypt } from "node:crypto";
    import { promisify } from "node:util";
    import { db, organizationsTable, pool, usersTable } from "@workspace/db";

    const scryptAsync = promisify(scrypt);
    const organizationId = process.env.E2E_ADDRESS_PERSISTENCE_ORGANIZATION_ID;
    const userId = process.env.E2E_ADDRESS_PERSISTENCE_USER_ID;
    const email = process.env.E2E_ADDRESS_PERSISTENCE_EMAIL;
    const password = process.env.E2E_ADDRESS_PERSISTENCE_PASSWORD;
    if (!organizationId || !userId || !email || !password) {
      throw new Error("Address persistence fixture arguments are missing");
    }

    void (async () => {
      if (process.env.E2E_DATABASE_SCHEMA) {
        pool.options.options = "-c search_path=" + process.env.E2E_DATABASE_SCHEMA;
      }
      const salt = randomBytes(16).toString("hex");
      const derived = (await scryptAsync(password, salt, 64)) as Buffer;
      await db.insert(organizationsTable).values({
        id: organizationId,
        name: "E2E address persistence disposable organization",
        email,
        depotStartAddress: ${JSON.stringify(DEPOT_START.address)},
        depotStartLatitude: ${DEPOT_START.latitude},
        depotStartLongitude: ${DEPOT_START.longitude},
        depotStartVerifiedAt: new Date(${JSON.stringify(DEPOT_START.verifiedAt)}),
        depotStartVerification: ${JSON.stringify(DEPOT_START.verification)},
        depotEndAddress: ${JSON.stringify(DEPOT_END.address)},
        depotEndLatitude: ${DEPOT_END.latitude},
        depotEndLongitude: ${DEPOT_END.longitude},
        depotEndVerifiedAt: new Date(${JSON.stringify(DEPOT_END.verifiedAt)}),
        depotEndVerification: ${JSON.stringify(DEPOT_END.verification)},
      });
      await db.insert(usersTable).values({
        id: userId,
        organizationId,
        name: "E2E address persistence disposable admin",
        email,
        role: "admin",
        passwordHash: \`scrypt:\${salt}:\${Buffer.from(derived).toString("hex")}\`,
      });
      await pool.end();
    })().catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exitCode = 1;
    });
  `;

  await execFileAsync(
    "pnpm",
    ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", script],
    {
      env: {
        ...process.env,
        E2E_ADDRESS_PERSISTENCE_ORGANIZATION_ID: fixture.organizationId,
        E2E_ADDRESS_PERSISTENCE_USER_ID: fixture.userId,
        E2E_ADDRESS_PERSISTENCE_EMAIL: fixture.email,
        E2E_ADDRESS_PERSISTENCE_PASSWORD: fixture.password,
        E2E_DATABASE_SCHEMA: options.databaseSchema ?? "",
      },
    },
  );
  return fixture;
}

export async function cleanupDisposableAuthFixture(
  fixture: DisposableAuthFixture,
): Promise<void> {
  const script = `
    import { pool } from "@workspace/db";

    const organizationId = process.env.E2E_ADDRESS_PERSISTENCE_ORGANIZATION_ID;
    if (!organizationId) throw new Error("Address persistence organization id is missing");

    void (async () => {
      const statements = [
        // Acceptance fixtures may deliberately exercise immutable outgoing
        // versions and planning locks. Dispose only synthetic tenant data by
        // first explicitly unlocking/cancelling its routes; production guards
        // continue to reject physical removal of active outgoing work.
        "UPDATE routes SET optimization_frozen = false WHERE organization_id = $1",
        "UPDATE stops SET locked_vehicle_id = NULL, locked_driver_id = NULL, locked_service_start_at = NULL WHERE organization_id = $1",
        "UPDATE routes SET status = 'cancelled' WHERE organization_id = $1 AND status <> 'cancelled'",
        "DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE organization_id = $1)",
        "DELETE FROM stop_message_read_receipts WHERE organization_id = $1",
        "DELETE FROM stop_messages WHERE organization_id = $1",
        "DELETE FROM stop_message_threads WHERE organization_id = $1",
        "DELETE FROM route_message_read_receipts WHERE organization_id = $1",
        "DELETE FROM route_messages WHERE organization_id = $1",
        "DELETE FROM delivery_proofs WHERE stop_id IN (SELECT id FROM stops WHERE organization_id = $1)",
        "DELETE FROM delivery_notifications WHERE stop_id IN (SELECT id FROM stops WHERE organization_id = $1)",
        "DELETE FROM execution_events WHERE organization_id = $1",
        "DELETE FROM route_acknowledgements WHERE organization_id = $1",
        "DELETE FROM route_executions WHERE organization_id = $1",
        "DELETE FROM geofence_events WHERE organization_id = $1",
        "DELETE FROM vehicle_positions WHERE organization_id = $1",
        "DELETE FROM route_plan_approvals WHERE organization_id = $1",
        "DELETE FROM route_incidents WHERE organization_id = $1",
        "DELETE FROM route_history WHERE organization_id = $1",
        "DELETE FROM driver_behavior_logs WHERE driver_id IN (SELECT id FROM drivers WHERE organization_id = $1)",
        "DELETE FROM driver_learned_profiles WHERE driver_id IN (SELECT id FROM drivers WHERE organization_id = $1)",
        "DELETE FROM driver_certifications WHERE organization_id = $1",
        "DELETE FROM driver_preferences WHERE driver_id IN (SELECT id FROM drivers WHERE organization_id = $1)",
        "DELETE FROM route_templates WHERE organization_id = $1",
        "DELETE FROM planning_drafts WHERE organization_id = $1",
        "DELETE FROM stops WHERE organization_id = $1",
        "DELETE FROM routes WHERE organization_id = $1",
        "DELETE FROM customer_visit_idempotency WHERE organization_id = $1",
        "DELETE FROM customer_sites WHERE organization_id = $1",
        "DELETE FROM customers WHERE organization_id = $1",
        "DELETE FROM drivers WHERE organization_id = $1",
        "DELETE FROM vehicles WHERE organization_id = $1",
        "DELETE FROM webhooks WHERE organization_id = $1",
        "DELETE FROM shopify_integrations WHERE organization_id = $1",
        "DELETE FROM subscriptions WHERE organization_id = $1",
        "DELETE FROM notifications WHERE organization_id = $1",
        "DELETE FROM documents WHERE organization_id = $1",
        "DELETE FROM document_upload_intents WHERE organization_id = $1",
        "DELETE FROM service_report_materials WHERE organization_id = $1",
        "DELETE FROM service_reports WHERE organization_id = $1",
        "DELETE FROM audit_log WHERE organization_id = $1",
        "DELETE FROM sessions WHERE organization_id = $1",
        "DELETE FROM user_groups WHERE organization_id = $1",
        "DELETE FROM users WHERE organization_id = $1",
        "DELETE FROM organizations WHERE id = $1",
      ];
      try {
        for (const statement of statements) {
          await pool.query(statement, [organizationId]);
        }
      } finally {
        await pool.end();
      }
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  await execFileAsync(
    "pnpm",
    ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", script],
    {
      env: {
        ...process.env,
        E2E_ADDRESS_PERSISTENCE_ORGANIZATION_ID: fixture.organizationId,
      },
    },
  );
}
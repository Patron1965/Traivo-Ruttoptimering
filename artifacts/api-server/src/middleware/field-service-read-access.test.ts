import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import type { AuthUser, UserRole } from "./auth";
import {
  requireBillingReadyReadAccess,
  requireProofReadAccess,
  requireRouteReadAccess,
  requireServiceReportReadAccess,
  requireStopReadAccess,
} from "./field-service-read-access";

const baseUser: AuthUser = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Test User",
  email: "test@example.com",
  role: "admin",
  organizationId: "00000000-0000-0000-0000-000000000010",
  driverProfileId: null,
};

function asRole(role: UserRole, driverProfileId: string | null = null): AuthUser {
  return { ...baseUser, role, driverProfileId };
}

async function requestApp(app: Express, path: string): Promise<Response> {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function appFor(
  user: AuthUser,
  routePath: string,
  middleware: express.RequestHandler,
): Express {
  const app = express();
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.get(routePath, middleware, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

test("billing-ready read denies both driver and viewer roles", async () => {
  for (const role of ["driver", "viewer"] as const) {
    const app = appFor(
      asRole(role),
      "/organizations/:id/billing-ready",
      requireBillingReadyReadAccess(),
    );
    const response = await requestApp(
      app,
      "/organizations/00000000-0000-0000-0000-000000000010/billing-ready",
    );
    assert.equal(response.status, 403, `${role} must not read organization billing data`);
  }
});

test("billing-ready read permits dispatcher and admin roles", async () => {
  for (const role of ["dispatcher", "admin"] as const) {
    const app = appFor(
      asRole(role),
      "/organizations/:id/billing-ready",
      requireBillingReadyReadAccess(),
    );
    const response = await requestApp(
      app,
      "/organizations/00000000-0000-0000-0000-000000000010/billing-ready",
    );
    assert.equal(response.status, 200, `${role} should read organization billing data`);
  }
});

test("service-report read denies a driver assigned to another vehicle", async () => {
  const driverProfileId = "00000000-0000-0000-0000-000000000020";
  const middleware = requireServiceReportReadAccess(async (stopId, organizationId, driverId) => {
    assert.equal(stopId, "00000000-0000-0000-0000-000000000030");
    assert.equal(organizationId, baseUser.organizationId);
    assert.equal(driverId, driverProfileId);
    return {
      statusCode: 403,
      message: "Driver is not assigned to the vehicle on this stop's route",
    };
  });
  const app = appFor(
    asRole("driver", driverProfileId),
    "/stops/:id/service-report",
    middleware,
  );
  const response = await requestApp(
    app,
    "/stops/00000000-0000-0000-0000-000000000030/service-report",
  );
  assert.equal(response.status, 403);
  const body = await response.json() as { error?: string };
  assert.match(body.error ?? "", /not assigned to the vehicle/);
});

test("service-report read permits an assigned driver", async () => {
  const driverProfileId = "00000000-0000-0000-0000-000000000020";
  const middleware = requireServiceReportReadAccess(async () => null);
  const app = appFor(
    asRole("driver", driverProfileId),
    "/stops/:id/service-report",
    middleware,
  );
  const response = await requestApp(
    app,
    "/stops/00000000-0000-0000-0000-000000000030/service-report",
  );
  assert.equal(response.status, 200);
});

test("service-report read denies viewer without invoking ownership lookup", async () => {
  let ownershipLookups = 0;
  const middleware = requireServiceReportReadAccess(async () => {
    ownershipLookups += 1;
    return null;
  });
  const app = appFor(
    asRole("viewer"),
    "/stops/:id/service-report",
    middleware,
  );
  const response = await requestApp(
    app,
    "/stops/00000000-0000-0000-0000-000000000030/service-report",
  );
  assert.equal(response.status, 403);
  assert.equal(ownershipLookups, 0);
});

test("service-report read rejects an invalid stop id before ownership lookup", async () => {
  let ownershipLookups = 0;
  const middleware = requireServiceReportReadAccess(async () => {
    ownershipLookups += 1;
    return null;
  });
  const app = appFor(
    asRole("driver", "00000000-0000-0000-0000-000000000020"),
    "/stops/:id/service-report",
    middleware,
  );
  const response = await requestApp(app, "/stops/undefined/service-report");
  assert.equal(response.status, 400);
  assert.equal(ownershipLookups, 0);
});

test("stop read permits viewer without invoking driver ownership lookup", async () => {
  let ownershipLookups = 0;
  const middleware = requireStopReadAccess(async () => {
    ownershipLookups += 1;
    return null;
  });
  const app = appFor(asRole("viewer"), "/stops/:id", middleware);
  const response = await requestApp(
    app,
    "/stops/00000000-0000-0000-0000-000000000030",
  );
  assert.equal(response.status, 200);
  assert.equal(ownershipLookups, 0);
});

test("stop read denies a driver for another vehicle", async () => {
  const middleware = requireStopReadAccess(async () => ({
    statusCode: 403,
    message: "Driver is not assigned to the vehicle on this stop's route",
  }));
  const app = appFor(
    asRole("driver", "00000000-0000-0000-0000-000000000020"),
    "/stops/:id",
    middleware,
  );
  const response = await requestApp(
    app,
    "/stops/00000000-0000-0000-0000-000000000030",
  );
  assert.equal(response.status, 403);
});

test("proof read denies viewer before any ownership lookup", async () => {
  let ownershipLookups = 0;
  const middleware = requireProofReadAccess(async () => {
    ownershipLookups += 1;
    return null;
  });
  const app = appFor(asRole("viewer"), "/stops/:id/proofs", middleware);
  const response = await requestApp(
    app,
    "/stops/00000000-0000-0000-0000-000000000030/proofs",
  );
  assert.equal(response.status, 403);
  assert.equal(ownershipLookups, 0);
});

test("proof read permits only an assigned driver", async () => {
  const driver = asRole("driver", "00000000-0000-0000-0000-000000000020");
  for (const [ownershipResult, expectedStatus] of [
    [null, 200],
    [
      {
        statusCode: 403 as const,
        message: "Driver is not assigned to the vehicle on this stop's route",
      },
      403,
    ],
  ] as const) {
    const middleware = requireProofReadAccess(async () => ownershipResult);
    const app = appFor(driver, "/stops/:id/proofs", middleware);
    const response = await requestApp(
      app,
      "/stops/00000000-0000-0000-0000-000000000030/proofs",
    );
    assert.equal(response.status, expectedStatus);
  }
});

test("route read applies vehicle ownership for drivers", async () => {
  const driver = asRole("driver", "00000000-0000-0000-0000-000000000020");
  for (const [ownershipResult, expectedStatus] of [
    [null, 200],
    [
      {
        statusCode: 403 as const,
        message: "Driver is not assigned to the vehicle on this route",
      },
      403,
    ],
  ] as const) {
    const middleware = requireRouteReadAccess(async () => ownershipResult);
    const app = appFor(driver, "/routes/:id/stops", middleware);
    const response = await requestApp(
      app,
      "/routes/00000000-0000-0000-0000-000000000040/stops",
    );
    assert.equal(response.status, expectedStatus);
  }
});
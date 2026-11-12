import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import type { AuthUser } from "../middleware/auth";
import optimizeRouter from "./optimize";

function appFor(organizationId: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: randomUUID(),
      name: "Continuous optimization scope test",
      email: "continuous-optimization@example.test",
      role: "dispatcher",
      organizationId,
      driverProfileId: null,
    } satisfies AuthUser;
    next();
  });
  app.use(optimizeRouter);
  return app;
}

async function post(
  app: Express,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/optimize/continuous/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("continuous stop validates tenant scope and is idempotent", async () => {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const app = appFor(organizationId);

  const mismatched = await post(app, { organizationId: otherOrganizationId });
  assert.equal(mismatched.status, 403);

  const firstStop = await post(app, { organizationId });
  assert.equal(firstStop.status, 200);
  assert.equal(firstStop.body.status.running, false);

  const repeatedStop = await post(app, { organizationId });
  assert.equal(repeatedStop.status, 200);
  assert.equal(repeatedStop.body.status.running, false);
});
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import geocodingRouter from "./geocoding";
import type { AuthUser } from "../middleware/auth";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

async function requestAs(
  path: string,
  user?: AuthUser,
  init?: RequestInit,
): Promise<Response> {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  app.use(geocodingRouter);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))));
});

const dispatcher: AuthUser = {
  id: "dispatcher-id",
  name: "Dispatcher",
  email: "dispatcher@example.com",
  role: "dispatcher",
  organizationId: "organization-id",
  driverProfileId: null,
};

test("geocoding endpoints reject unauthenticated callers", async () => {
  const forward = await requestAs("/geocode?address=Storgatan%201");
  assert.equal(forward.status, 401);

  const batch = await requestAs("/geocode/batch", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addresses: ["Storgatan 1"] }),
  });
  assert.equal(batch.status, 401);
});

test("geocoding endpoints reject non-operational roles", async () => {
  const response = await requestAs("/geocode?address=Storgatan%201", {
    ...dispatcher,
    role: "viewer",
  });
  assert.equal(response.status, 403);
});

test("dispatchers reach request validation without invoking a provider", async () => {
  const forward = await requestAs("/geocode", dispatcher);
  assert.equal(forward.status, 400);

  const batch = await requestAs("/geocode/batch", dispatcher, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addresses: [] }),
  });
  assert.equal(batch.status, 400);
});
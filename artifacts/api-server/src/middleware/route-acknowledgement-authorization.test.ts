import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { authorizeWrite, type UserRole } from "./auth";

function requestFor(role: UserRole): Request {
  return {
    method: "PUT",
    path: "/routes/40000000-0000-0000-0000-000000000001/handoff",
    body: { status: "opened", version: 1 },
    user: {
      id: "10000000-0000-0000-0000-000000000001",
      name: "Test",
      email: "test@example.com",
      organizationId: "20000000-0000-0000-0000-000000000001",
      role,
      driverProfileId:
        role === "driver"
          ? "30000000-0000-0000-0000-000000000001"
          : null,
    },
  } as unknown as Request;
}

function responseRecorder() {
  let statusCode: number | undefined;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  return { response, getStatusCode: () => statusCode };
}

test("central write authorization allows driver handoff events", async () => {
  const { response, getStatusCode } = responseRecorder();
  let nextCalled = false;
  await authorizeWrite()(
    requestFor("driver"),
    response,
    (() => {
      nextCalled = true;
    }) as NextFunction,
  );
  assert.equal(nextCalled, true);
  assert.equal(getStatusCode(), undefined);
});

test("central write authorization keeps viewer handoff read-only", async () => {
  const { response, getStatusCode } = responseRecorder();
  let nextCalled = false;
  await authorizeWrite()(
    requestFor("viewer"),
    response,
    (() => {
      nextCalled = true;
    }) as NextFunction,
  );
  assert.equal(nextCalled, false);
  assert.equal(getStatusCode(), 403);
});
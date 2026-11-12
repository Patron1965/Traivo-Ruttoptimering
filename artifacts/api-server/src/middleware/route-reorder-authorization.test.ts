import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { authorizeWrite, type UserRole } from "./auth";

function requestFor(role: UserRole): Request {
  return {
    method: "PUT",
    path: "/routes/40000000-0000-4000-8000-000000000001/reorder-stops",
    body: {
      stopIds: ["50000000-0000-4000-8000-000000000001"],
    },
    user: {
      id: "10000000-0000-4000-8000-000000000001",
      name: "Test",
      email: "test@example.com",
      organizationId: "20000000-0000-4000-8000-000000000001",
      role,
      driverProfileId:
        role === "driver"
          ? "30000000-0000-4000-8000-000000000001"
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

for (const role of ["admin", "dispatcher"] as const) {
  test(`central write authorization allows ${role} route reorder`, async () => {
    const { response, getStatusCode } = responseRecorder();
    let nextCalled = false;
    await authorizeWrite()(
      requestFor(role),
      response,
      (() => {
        nextCalled = true;
      }) as NextFunction,
    );
    assert.equal(nextCalled, true);
    assert.equal(getStatusCode(), undefined);
  });
}

for (const role of ["driver", "viewer"] as const) {
  test(`central write authorization denies ${role} route reorder`, async () => {
    const { response, getStatusCode } = responseRecorder();
    let nextCalled = false;
    await authorizeWrite()(
      requestFor(role),
      response,
      (() => {
        nextCalled = true;
      }) as NextFunction,
    );
    assert.equal(nextCalled, false);
    assert.equal(getStatusCode(), 403);
  });
}
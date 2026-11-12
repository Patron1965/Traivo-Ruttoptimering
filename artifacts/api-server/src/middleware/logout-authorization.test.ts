import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { authorizeWrite, type UserRole } from "./auth";

for (const role of ["admin", "dispatcher", "driver", "viewer"] as const satisfies readonly UserRole[]) {
  test(`${role} can reach the logout handler`, async () => {
    const request = {
      method: "POST",
      path: "/auth/logout",
      body: {},
      user: {
        id: "10000000-0000-0000-0000-000000000001",
        organizationId: "20000000-0000-0000-0000-000000000001",
        role,
        driverProfileId: role === "driver" ? "30000000-0000-0000-0000-000000000001" : null,
      },
    } as unknown as Request;
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
    let nextCalled = false;
    const next = (() => {
      nextCalled = true;
    }) as NextFunction;

    await authorizeWrite()(request, response, next);

    assert.equal(nextCalled, true);
    assert.equal(statusCode, undefined);
  });
}
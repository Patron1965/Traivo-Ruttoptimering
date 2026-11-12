import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidHandoffTransition } from "./routes";
import { isAcceptedRouteRecipient } from "../services/field-service";

test("route handoff transitions are sequential and terminal", () => {
  assert.equal(isValidHandoffTransition("sent", "received"), true);
  assert.equal(isValidHandoffTransition("received", "opened"), true);
  assert.equal(isValidHandoffTransition("opened", "accepted"), true);
  assert.equal(isValidHandoffTransition("opened", "rejected"), true);

  assert.equal(isValidHandoffTransition("sent", "opened"), false);
  assert.equal(isValidHandoffTransition("received", "accepted"), false);
  assert.equal(isValidHandoffTransition("accepted", "rejected"), false);
  assert.equal(isValidHandoffTransition("rejected", "accepted"), false);
});

test("route execution requires the exact recipient and accepted current version", () => {
  const acceptedRoute = {
    handoffDriverId: "driver-a",
    handoffStatus: "accepted",
    handoffVersion: 7,
    planRevision: 7,
  };

  assert.equal(isAcceptedRouteRecipient(acceptedRoute, "driver-a"), true);
  assert.equal(isAcceptedRouteRecipient(acceptedRoute, "driver-b"), false);
  assert.equal(
    isAcceptedRouteRecipient({ ...acceptedRoute, handoffStatus: "opened" }, "driver-a"),
    false,
  );
  assert.equal(
    isAcceptedRouteRecipient({ ...acceptedRoute, planRevision: 8 }, "driver-a"),
    false,
  );
});
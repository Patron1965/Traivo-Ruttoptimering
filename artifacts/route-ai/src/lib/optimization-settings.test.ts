import assert from "node:assert/strict";
import test from "node:test";
import { optimizationSettingsPayload } from "./optimization-settings.ts";

test("optimization save sends only its six fields, not nullable notification settings", () => {
  const expected = {
    autoBalance: false, snapToRoad: true, defaultRouteType: "delivery",
    defaultServiceDurationMin: 3, maxDriverOvertimeMin: 30, allowLateStopsMin: 10,
  };
  assert.deepEqual(optimizationSettingsPayload({
    ...expected, customerNotifications: null, operatingMode: "transport",
    stopRetentionEnabled: true, notificationAttempts: [], depotStartLatitude: 59,
  }), expected);
  assert.deepEqual(optimizationSettingsPayload({ maxDriverOvertimeMin: 0 }), { maxDriverOvertimeMin: 0 });
});

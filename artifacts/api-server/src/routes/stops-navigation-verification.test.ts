import assert from "node:assert/strict";
import test from "node:test";
import {
  applyVerifiedNavigationDestination,
  verifyPreservedNavigationDestination,
  cleanNavigationVerification,
  NAVIGATION_ADDRESS_KEY,
  NAVIGATION_VERIFIED_KEY,
} from "../services/stop-service";

test("import verification preserves coordinates and rejects different or unverified destinations", () => {
  const result = { latitude: 59.32981, longitude: 18.06942, displayName: "Verifierad adress", source: "google" as const, provider: "google" as const };
  const row: Record<string, unknown> = { latitude: 59.3298101, longitude: 18.06942, customFields: { order: "TEST" } };
  assert.equal(verifyPreservedNavigationDestination(row, result), true);
  assert.equal(row.latitude, 59.3298101);
  assert.equal((row.customFields as Record<string,string>)[NAVIGATION_VERIFIED_KEY], "true");
  assert.equal(verifyPreservedNavigationDestination(row, { ...result, latitude: 59.34 }), false);
  assert.equal((row.customFields as Record<string,string>)[NAVIGATION_VERIFIED_KEY], undefined);
  assert.equal(verifyPreservedNavigationDestination(row, null), false);
  assert.equal((row.customFields as Record<string,string>).order, "TEST");
});

test("removes client-supplied navigation verification while preserving customer fields", () => {
  const input: Record<string, unknown> = {
    customFields: {
      reference: "ORDER-42",
      [NAVIGATION_VERIFIED_KEY]: "true",
      [NAVIGATION_ADDRESS_KEY]: "Spoofed address",
    },
  };

  cleanNavigationVerification(input);

  assert.deepEqual(input.customFields, { reference: "ORDER-42" });
});

test("removes forged verification from route-template stop data", () => {
  const templateStop: Record<string, unknown> = {
    address: "Caller-selected address",
    latitude: 1,
    longitude: 2,
    customFields: {
      [NAVIGATION_VERIFIED_KEY]: "true",
      [NAVIGATION_ADDRESS_KEY]: "Forged provider address",
    },
  };

  cleanNavigationVerification(templateStop);

  assert.deepEqual(templateStop.customFields, {});
  assert.equal(templateStop.latitude, 1);
  assert.equal(templateStop.longitude, 2);
});

test("uses exact provider coordinates instead of caller-supplied nearby coordinates", () => {
  const input: Record<string, unknown> = {
    latitude: 59.32930,
    longitude: 18.06860,
    customFields: { reference: "ORDER-42" },
  };
  applyVerifiedNavigationDestination(input, {
    latitude: 59.32981,
    longitude: 18.06942,
    displayName: "Verifierad adress 1, Stockholm",
    source: "google",
    provider: "google",
  });

  assert.equal(input.latitude, 59.32981);
  assert.equal(input.longitude, 18.06942);
  assert.deepEqual(input.customFields, {
    reference: "ORDER-42",
    [NAVIGATION_VERIFIED_KEY]: "true",
    [NAVIGATION_ADDRESS_KEY]: "Verifierad adress 1, Stockholm",
  });
});
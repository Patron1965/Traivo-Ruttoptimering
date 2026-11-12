import assert from "node:assert/strict";
import test from "node:test";
import {
  addressSuggestions,
  getPersistedVerifiedAddress,
  selectedAddressValue,
} from "./address-suggestions.ts";

test("an exact match visibly selects the provider's full canonical address", () => {
  const [suggestion] = addressSuggestions(
    true,
    { displayName: "Testgatan 12, 123 45 Stockholm, Sweden" },
    "Testgatan 12, Stockholm",
  );
  assert.equal(suggestion.verified, true);
  assert.equal(suggestion.value, "Testgatan 12, 123 45 Stockholm, Sweden");
  assert.equal(selectedAddressValue(suggestion), "Testgatan 12, 123 45 Stockholm, Sweden");
});

test("an exact display missing its house number retains the house in the selected value", () => {
  const [suggestion] = addressSuggestions(true, { displayName: "Testgatan, Stockholm" }, "Testgatan 12, Stockholm");
  assert.equal(suggestion.verified, true);
  assert.equal(suggestion.value, "Testgatan 12, Stockholm");
  assert.equal(selectedAddressValue(suggestion), "Testgatan 12, Stockholm");
});

test("canonical selection keeps the street house when the query also contains an apartment", () => {
  const [suggestion] = addressSuggestions(
    true,
    { displayName: "Testgatan 12, lgh 1301, 123 45 Stockholm, Sweden" },
    "Testgatan 12 lgh 1301, Stockholm",
  );
  assert.equal(suggestion.value, "Testgatan 12, lgh 1301, 123 45 Stockholm, Sweden");
});

test("partial candidates remain unverified but selecting one fills the visible candidate", () => {
  const [suggestion] = addressSuggestions(false, {
    candidates: [{ id: "street", displayName: "Testgatan, 123 45 Stockholm, Sweden" }],
  }, "Testgatan");
  assert.equal(suggestion.verified, false);
  assert.equal(suggestion.value, "Testgatan");
  assert.equal(selectedAddressValue(suggestion), "Testgatan, 123 45 Stockholm, Sweden");
});

test("empty and failed responses do not create a verified choice", () => {
  assert.deepEqual(addressSuggestions(false, {}, "Testgatan"), []);
  assert.deepEqual(addressSuggestions(false, { displayName: "Testgatan" }, "Testgatan"), []);
});

test("persisted verification requires an address and finite coordinates", () => {
  assert.deepEqual(
    getPersistedVerifiedAddress("Testgatan 12, Stockholm", 59.33, 18.06),
    { value: "Testgatan 12, Stockholm", latitude: 59.33, longitude: 18.06 },
  );
  assert.equal(getPersistedVerifiedAddress("Testgatan 12, Stockholm", null, 18.06), null);
  assert.equal(getPersistedVerifiedAddress("Testgatan 12, Stockholm", 59.33, null), null);
  assert.equal(getPersistedVerifiedAddress("Testgatan 12, Stockholm", Number.NaN, 18.06), null);
});
import test from "node:test";
import assert from "node:assert/strict";
import { clearSelectedImportMappings, restoreSelectedImportMappings } from "./import-mapping-selection.ts";
import { mergeSavedImportMapping, saveImportMappingProfile, loadImportMappingProfile } from "./import-mapping.ts";

const fields = [
  { key: "date", required: true },
  { key: "address", required: true },
  { key: "latitude", required: false },
  { key: "custom_owner", required: false },
  { key: "custom_stove", required: false },
];

test("cleared fields can be restored individually and together, including coordinates", () => {
  const original = { date: "Datum", address: "Adress", latitude: "Latitud", custom_owner: "Ägare", custom_stove: "Kamin" };
  const headers = Object.values(original);
  const cleared = clearSelectedImportMappings(original, fields, fields.map((field) => field.key));
  const one = restoreSelectedImportMappings(cleared, fields, ["custom_owner"], original, headers);
  assert.equal(one.custom_owner, "Ägare");
  assert.equal(one.latitude, null);
  assert.deepEqual(restoreSelectedImportMappings(one, fields, fields.map((field) => field.key), original, headers), original);
  const again = clearSelectedImportMappings(one, fields, ["custom_owner"]);
  assert.equal(restoreSelectedImportMappings(again, fields, ["custom_owner"], original, headers).custom_owner, "Ägare");
});

test("restoration preserves manual changes and cannot restore columns from another file", () => {
  const original = { custom_owner: "Ägare", custom_stove: "Kamin" };
  const mapping = { custom_owner: "Ny ägare", custom_stove: null };
  assert.deepEqual(restoreSelectedImportMappings(mapping, fields, ["custom_owner", "custom_stove"], original, ["Ny ägare"]), mapping);
  assert.deepEqual(restoreSelectedImportMappings({ date: null }, fields, ["date"], { date: "Datum" }, ["Datum"]), { date: null });
});

test("clears only selected optional mappings and preserves required fields and address parts", () => {
  const mapping = {
    date: "Datum",
    address: [{ component: "address" as const, column: "Adress" }, { component: "city" as const, column: "Ort" }],
    latitude: "Latitud",
    custom_owner: "Ägare",
    custom_stove: "Kamin",
  };
  const result = clearSelectedImportMappings(mapping, fields, ["date", "address", "custom_owner", "unknown"]);
  assert.equal(result.custom_owner, null);
  assert.equal(result.custom_stove, "Kamin");
  assert.equal(result.latitude, "Latitud");
  assert.deepEqual(result.address, mapping.address);
  assert.equal(result.date, "Datum");
  assert.equal(mapping.custom_owner, "Ägare");
});

test("an empty selection is a no-op and deliberate remapping is supported", () => {
  const mapping = { custom_owner: "Ägare" };
  assert.deepEqual(clearSelectedImportMappings(mapping, fields, []), mapping);
  const cleared = clearSelectedImportMappings(mapping, fields, ["custom_owner"]);
  assert.equal(cleared.custom_owner, null);
  assert.equal({ ...cleared, custom_owner: "Ny ägare" }.custom_owner, "Ny ägare");
});

test("bulk-skipped custom columns stay skipped after saving and reimporting", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } as Storage;
  const customFields = ["owner", "stove"].map((name) => ({
    key: `custom_${name}`, labelKey: name === "owner" ? "Ägare" : "Kamin",
    required: false, description: "", apiField: `custom_${name}`, exampleValue: "",
  }));
  const mapping = clearSelectedImportMappings(
    { date: "Datum", address: "Adress", custom_owner: "Ägare", custom_stove: "Kamin" },
    fields, ["custom_owner", "custom_stove"],
  );
  assert.equal(saveImportMappingProfile("synthetic-org", "synthetic-user", mapping, customFields, storage), "ok");
  const profile = loadImportMappingProfile("synthetic-org", "synthetic-user", storage).profile;
  assert.deepEqual(profile?.skippedColumns?.sort(), ["Kamin", "Ägare"].sort());
  const merged = mergeSavedImportMapping({
    headers: ["Datum", "Adress", "Ägare", "Kamin"],
    fallbackMapping: { date: "Datum", address: "Adress" },
    savedProfile: profile,
    systemFieldKeys: ["date", "address"],
    normalizeHeader: (header) => header.toLowerCase(),
  });
  assert.equal(merged.mapping.custom_owner, null);
  assert.equal(merged.mapping.custom_stove, null);
  assert.equal(merged.customFields.length, 2);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  importMappingStorageKey,
  loadImportMappingProfile,
  mergeSavedImportMapping,
  normalizePreImportDraftMapping,
  saveImportMappingProfile,
  type ImportMappingProfile,
} from "./import-mapping.ts";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
}

const normalizeHeader = (header: string) =>
  header.trim().toLocaleLowerCase("sv-SE").replace(/[\s\-\.]+/g, "_");

function merge(
  headers: string[],
  savedProfile: ImportMappingProfile,
  fallbackMapping: Record<string, string | null> = {
    date: "Datum",
    address: "Adress",
    contactName: "Namn",
    notes: "Anteckning",
  },
) {
  return mergeSavedImportMapping({
    headers,
    fallbackMapping,
    savedProfile,
    systemFieldKeys: ["date", "address", "contactName", "notes"],
    normalizeHeader,
  });
}

test("reuses exact saved columns when the new file only reorders them", () => {
  const result = merge(
    ["New", "Note", "City", "Zip", "Date", "Street"],
    {
      version: 1,
      mapping: {
        date: "Date",
        address: [
          { component: "address", column: "Street" },
          { component: "postalCode", column: "Zip" },
          { component: "city", column: "City" },
        ],
        contactName: null,
        notes: null,
        custom_note: "Note",
      },
      customFields: [{
        key: "custom_note",
        labelKey: "Note",
        required: false,
        description: "",
        apiField: "custom_note",
        exampleValue: "",
      }],
    },
  );

  assert.equal(result.mapping.date, "Date");
  assert.deepEqual(result.mapping.address, [
    { component: "address", column: "Street" },
    { component: "postalCode", column: "Zip" },
    { component: "city", column: "City" },
  ]);
  assert.equal(result.mapping.notes, null);
  assert.equal(result.mapping.custom_note, "Note");
  assert.equal(result.mapping.contactName, null);
  assert.equal(result.customFields.filter((field) => field.labelKey === "Note").length, 1);
  assert.equal(result.customFields.some((field) => field.labelKey === "New"), true);
});

test("does not invent a replacement when a previously mapped source column disappears", () => {
  const result = merge(
    ["Datum", "Adress 2", "Namn"],
    {
      version: 1,
      mapping: {
        date: "Date",
        address: "Adress",
        contactName: null,
        notes: null,
      },
      customFields: [],
    },
  );

  assert.equal(result.mapping.date, null);
  assert.equal(result.mapping.address, null);
  assert.equal(result.mapping.contactName, null);
  assert.equal(result.mapping.notes, null);
});

test("preserves explicit null exclusions instead of applying a new alias", () => {
  const result = merge(
    ["Date", "Adress", "Namn"],
    {
      version: 1,
      mapping: {
        date: null,
        address: null,
        contactName: null,
        notes: null,
      },
      customFields: [],
    },
  );

  assert.equal(result.mapping.date, null);
  assert.equal(result.mapping.address, null);
  assert.equal(result.mapping.contactName, null);
  assert.equal(result.mapping.notes, null);
});

test("does not auto-map a new target onto a header already used by saved custom mapping", () => {
  const result = merge(
    ["Note"],
    {
      version: 1,
      mapping: {
        date: null,
        address: null,
        contactName: null,
        custom_note: "Note",
      },
      customFields: [{
        key: "custom_note",
        labelKey: "Note",
        required: false,
        description: "",
        apiField: "custom_note",
        exampleValue: "",
      }],
    },
    {
      notes: "Note",
      date: null,
      address: null,
      contactName: null,
    },
  );

  assert.equal(result.mapping.notes, null);
  assert.equal(result.mapping.custom_note, "Note");
  assert.equal(result.customFields.length, 1);
});

test("round-trips an explicitly skipped custom source across repeated imports", () => {
  const storage = memoryStorage();
  const custom = {
    key: "custom_internal_note",
    labelKey: "Intern anteckning",
    required: false,
    description: "",
    apiField: "custom_internal_note",
    exampleValue: "",
  };
  const firstMapping = {
    date: "Date",
    address: "Address",
    custom_internal_note: null,
  };

  assert.equal(
    saveImportMappingProfile("org-a", "user-a", firstMapping, [custom], storage),
    "ok",
  );
  const firstProfile = loadImportMappingProfile("org-a", "user-a", storage).profile;
  assert.deepEqual(firstProfile?.skippedColumns, ["Intern anteckning"]);

  let result = merge(
    ["Date", "Address", "Intern anteckning", "New"],
    firstProfile!,
  );
  assert.equal(result.mapping.custom_internal_note, null);
  assert.equal(result.mapping.date, "Date");
  assert.equal(result.mapping.address, "Address");
  assert.equal(result.customFields.filter((field) => field.labelKey === "Intern anteckning").length, 1);
  assert.equal(result.customFields.filter((field) => field.labelKey === "New").length, 1);

  // A second save/import cycle must not create custom_..._2 for the skipped
  // source column.
  assert.equal(
    saveImportMappingProfile("org-a", "user-a", result.mapping, result.customFields, storage),
    "ok",
  );
  const secondProfile = loadImportMappingProfile("org-a", "user-a", storage).profile;
  result = merge(["New", "Intern anteckning", "Date", "Address"], secondProfile!);
  assert.equal(result.mapping.custom_internal_note, null);
  assert.equal(result.customFields.filter((field) => field.labelKey === "Intern anteckning").length, 1);
  assert.equal(result.customFields.some((field) => field.labelKey.endsWith("_2")), false);
});

test("repairs a legacy null custom mapping without a skippedColumns list", () => {
  const result = merge(
    ["Date", "Address", "Rows 60-68"],
    {
      version: 1,
      mapping: {
        date: "Date",
        address: "Address",
        legacy_custom: null,
      },
      customFields: [{
        key: "legacy_custom",
        labelKey: "Rows 60-68",
        required: false,
        description: "",
        apiField: "legacy_custom",
        exampleValue: "",
      }],
    },
  );

  assert.equal(result.mapping.legacy_custom, null);
  assert.equal(result.customFields.filter((field) => field.labelKey === "Rows 60-68").length, 1);
  assert.equal(result.customFields.some((field) => field.labelKey === "Rows 60-68" && field.key !== "legacy_custom"), false);
});

test("a remapped skipped source becomes eligible and no longer remains skipped", () => {
  const result = merge(
    ["Date", "Address", "Previously skipped"],
    {
      version: 1,
      mapping: {
        date: "Date",
        address: "Address",
        custom_skipped: "Previously skipped",
      },
      skippedColumns: ["Previously skipped"],
      customFields: [{
        key: "custom_skipped",
        labelKey: "Previously skipped",
        required: false,
        description: "",
        apiField: "custom_skipped",
        exampleValue: "",
      }],
    },
  );

  assert.equal(result.mapping.custom_skipped, "Previously skipped");
  assert.equal(result.customFields.filter((field) => field.labelKey === "Previously skipped").length, 1);
});

test("does not treat a remapped field label as a stale skipped source", () => {
  const result = merge(
    ["Date", "Address", "Original label", "Remapped source"],
    {
      version: 1,
      mapping: {
        date: "Date",
        address: "Address",
        custom_value: "Remapped source",
      },
      skippedColumns: ["Original label"],
      customFields: [{
        key: "custom_value",
        labelKey: "Original label",
        required: false,
        description: "",
        apiField: "custom_value",
        exampleValue: "",
      }],
    },
  );

  assert.equal(result.mapping.custom_value, "Remapped source");
  assert.equal(result.customFields.filter((field) => field.labelKey === "Original label").length, 2);
  assert.equal(result.customFields.filter((field) => field.labelKey === "Original label" && field.key !== "custom_value").length, 1);
});

test("does not apply a legacy skip to a distinct header with a normalization collision", () => {
  const result = merge(
    ["Date", "Address", "Rows 60 68", "Rows-60-68"],
    {
      version: 1,
      mapping: {
        date: "Date",
        address: "Address",
        custom_skipped: null,
      },
      customFields: [{
        key: "custom_skipped",
        labelKey: "Rows 60 68",
        required: false,
        description: "",
        apiField: "custom_skipped",
        exampleValue: "",
      }],
    },
  );

  assert.equal(result.mapping.custom_skipped, null);
  assert.equal(result.customFields.filter((field) => field.labelKey === "Rows 60 68").length, 1);
  assert.equal(result.customFields.filter((field) => field.labelKey === "Rows-60-68").length, 1);
});

test("collapses three dirty generated generations while preserving the original skip", () => {
  const labels = ["Erbjuden tid", "Senaste leveransdatum", "Typ", "Ja/Nej = Hoppa över"];
  const customFields = labels.flatMap((label) => {
    const base = `custom_${normalizeHeader(label)}`;
    return [base, `${base}_2`, `${base}_3`].map((key) => ({
      key,
      labelKey: label,
      required: false,
      description: "",
      apiField: key,
      exampleValue: "",
    }));
  });
  const mapping = Object.fromEntries(customFields.map((field, index) => [
    field.key,
    index % 3 === 0 ? null : field.labelKey,
  ]));
  const result = merge(labels, {
    version: 1,
    mapping,
    customFields,
  }, {
    date: null,
    address: null,
  });

  assert.equal(result.customFields.length, labels.length);
  assert.deepEqual(
    result.customFields.map((field) => field.key),
    labels.map((label) => `custom_${normalizeHeader(label)}`),
  );
  for (const label of labels) {
    assert.equal(result.mapping[`custom_${normalizeHeader(label)}`], null);
  }
});

test("repeated imports do not recreate generated custom suffixes", () => {
  const label = "Erbjuden tid";
  const field = {
    key: `custom_${normalizeHeader(label)}`,
    labelKey: label,
    required: false,
    description: "",
    apiField: `custom_${normalizeHeader(label)}`,
    exampleValue: "",
  };
  let profile: ImportMappingProfile = {
    version: 1,
    mapping: { date: "Date", [field.key]: null },
    customFields: [field],
  };
  for (let generation = 0; generation < 3; generation += 1) {
    const result = merge(["Date", label], profile);
    assert.equal(result.customFields.filter((item) => item.labelKey === label).length, 1);
    assert.equal(result.customFields.some((item) => item.key.endsWith("_2")), false);
    profile = {
      version: 1,
      mapping: result.mapping as ImportMappingProfile["mapping"],
      customFields: result.customFields,
    };
  }
});

test("keeps a generated field deliberately remapped to another source header", () => {
  const label = "Kod";
  const base = `custom_${normalizeHeader(label)}`;
  const remappedKey = `${base}_2`;
  const result = merge(["Date", label, "Extern kod"], {
    version: 1,
    mapping: {
      date: "Date",
      [base]: null,
      [remappedKey]: "Extern kod",
    },
    customFields: [
      {
        key: base,
        labelKey: label,
        required: false,
        description: "",
        apiField: base,
        exampleValue: "",
      },
      {
        key: remappedKey,
        labelKey: label,
        required: false,
        description: "",
        apiField: remappedKey,
        exampleValue: "",
      },
    ],
  });

  assert.equal(result.mapping[base], null);
  assert.equal(result.mapping[remappedKey], "Extern kod");
  assert.equal(result.customFields.filter((field) => field.labelKey === label).length, 2);
  assert.equal(result.customFields.some((field) => field.labelKey === "Extern kod"), false);
});

test("retains duplicate generated fields when every source mapping is own-source", () => {
  const label = "Telefon";
  const base = `custom_${normalizeHeader(label)}`;
  const second = `${base}_2`;
  const fields = [base, second].map((key) => ({
    key,
    labelKey: label,
    required: false,
    description: "",
    apiField: key,
    exampleValue: "",
  }));
  const mapping = { [base]: label, [second]: label };
  const result = merge(["Date", label], {
    version: 1,
    mapping: { date: "Date", ...mapping },
    customFields: fields,
  });

  assert.deepEqual(result.customFields, fields);
  assert.equal(result.mapping[base], label);
  assert.equal(result.mapping[second], label);
});

test("does not treat a missing mapping beside an own-source mapping as a skip", () => {
  const label = "Telefon";
  const base = `custom_${normalizeHeader(label)}`;
  const second = `${base}_2`;
  const fields = [base, second].map((key) => ({
    key,
    labelKey: label,
    required: false,
    description: "",
    apiField: key,
    exampleValue: "",
  }));
  const result = merge(["Date", label], {
    version: 1,
    mapping: { date: "Date", [second]: label },
    customFields: fields,
  });

  assert.deepEqual(result.customFields, fields);
  assert.equal(Object.prototype.hasOwnProperty.call(result.mapping, base), true);
  assert.equal(result.mapping[second], label);
});

test("normalizes pre-import drafts but leaves frozen imported state unchanged", () => {
  const label = "Telefon";
  const base = `custom_${normalizeHeader(label)}`;
  const fields = [base, `${base}_2`].map((key) => ({
    key,
    labelKey: label,
    required: false,
    description: "",
    apiField: key,
    exampleValue: "",
  }));
  const state = {
    mapping: { [base]: null, [`${base}_2`]: label },
    customFields: fields,
  };
  const normalized = normalizePreImportDraftMapping(state, normalizeHeader);
  assert.ok(normalized);
  assert.equal(normalized.customFields.length, 1);
  assert.equal(normalized.mapping[base], null);

  const frozen = normalizePreImportDraftMapping({
    ...state,
    importedResult: { stopIds: ["stop-1"] },
    savedStops: [{ id: "stop-1" }],
  }, normalizeHeader);
  assert.equal(frozen, null);
});

test("keeps available composite delivery parts and leaves missing parts unmapped", () => {
  const result = merge(
    ["City", "Street"],
    {
      version: 1,
      mapping: {
        date: null,
        address: [
          { component: "address", column: "Street" },
          { component: "postalCode", column: "Zip" },
          { component: "city", column: "City" },
        ],
        contactName: null,
        notes: null,
      },
      customFields: [],
    },
  );

  assert.deepEqual(result.mapping.address, [
    { component: "address", column: "Street" },
    { component: "city", column: "City" },
  ]);
});

test("storage is isolated by organization and user and stores metadata only", () => {
  const storage = memoryStorage();
  const mapping = { date: "Date" };
  const fields = [{
    key: "custom_note",
    labelKey: "Note",
    required: false,
    description: "",
    apiField: "custom_note",
    exampleValue: "",
  }] as const;

  assert.equal(saveImportMappingProfile("org-a", "user-a", mapping, fields, storage), "ok");
  const own = loadImportMappingProfile("org-a", "user-a", storage);
  assert.equal(own.status, "ok");
  assert.deepEqual(own.profile?.mapping, mapping);
  assert.equal(loadImportMappingProfile("org-b", "user-a", storage).status, "missing");
  assert.equal(loadImportMappingProfile("org-a", "user-b", storage).status, "missing");
  const raw = storage.getItem(importMappingStorageKey("org-a", "user-a")) ?? "";
  assert.equal(raw.includes("rows"), false);
  assert.equal(raw.includes("parsedData"), false);
});

test("malformed JSON and unavailable storage return safe statuses", () => {
  const key = importMappingStorageKey("org-a", "user-a");
  const malformed = memoryStorage({ [key]: "{not-json" });
  assert.equal(loadImportMappingProfile("org-a", "user-a", malformed).status, "invalid");

  const unavailable = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  } as unknown as Storage;
  assert.equal(loadImportMappingProfile("org-a", "user-a", unavailable).status, "unavailable");
  assert.equal(
    saveImportMappingProfile("org-a", "user-a", { date: "Date" }, [], unavailable),
    "unavailable",
  );
});
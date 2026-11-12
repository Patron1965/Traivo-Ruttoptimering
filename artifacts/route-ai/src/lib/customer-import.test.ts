import test from "node:test";
import assert from "node:assert/strict";
import { buildPreview, guessCustomerMapping, sheetToRows, toCustomerInput, mapRow, dedupKey } from "./customer-import.ts";

const matrix = [
  [],
  ["Kundnamn", "Kundnr", "Adress", "Postnr", "Ort", "E-post"],
  ["Berga Bygg AB", "K-10", "Storgatan 1", "11122", "Stockholm", ""],
  ["", "", "", "", "", ""],
  ["Norrlo Café", "", "", "", "", "fel@"],
  ["Ny kund", "k-10", "Annan 2", "", "", ""],
  ["Solvik", "", "", "", "", ""],
  ["Solvik", "", "", "", "", ""],
  ["Arkiv AB", "A-1", "x", "", "", ""],
  ["", "", "", "41101", "Göteborg", ""],
];

test("sheetToRows keeps excel row numbers and skips empty rows", () => {
  const { headers, rows } = sheetToRows(matrix);
  assert.equal(headers[0], "Kundnamn");
  assert.deepEqual(rows.map((r) => r.rowNumber), [3, 5, 6, 7, 8, 9, 10]);
});

test("mapping guesses swedish headers", () => {
  const m = guessCustomerMapping(matrix[1] as string[]);
  assert.equal(m.name, 0); assert.equal(m.customerNumber, 1); assert.equal(m.postalCode, 3); assert.equal(m.city, 4); assert.equal(m.email, 5);
});

test("preview statuses: existing, archived, invalid, in-file duplicate, no site", () => {
  const { headers, rows } = sheetToRows(matrix);
  const preview = buildPreview(rows, guessCustomerMapping(headers), [
    { name: "Annat namn", customerNumber: "K-10" },
    { name: "Arkiv AB", customerNumber: "a-1", archivedAt: "2024-01-01" },
  ]);
  assert.deepEqual(preview.map((p) => p.status), ["existing", "invalid", "existing", "readyNoSite", "duplicateInFile", "existingArchived", "invalid"]);
  assert.equal(preview[4].duplicateOfRow, 7);
});

test("name+address dedup when no customer number", () => {
  assert.equal(dedupKey({ name: "Solvik ", address: "Gata 1" }), dedupKey({ name: "solvik", address: "gata 1" }));
  assert.notEqual(dedupKey({ name: "Solvik", address: "Gata 1" }), dedupKey({ name: "Solvik", address: "Gata 2" }));
});

test("customer numbers preserve meaningful punctuation and missing numbers match name and address", () => {
  assert.notEqual(dedupKey({ name: "X", customerNumber: "K-10" }), dedupKey({ name: "X", customerNumber: "K 10" }));
  const preview = buildPreview([{ rowNumber: 2, cells: ["Solvik", "Gata 1"] }],
    { name: 0, address: 1 }, [{ name: "Solvik", address: "Gata 1", customerNumber: "123" }]);
  assert.equal(preview[0].status, "existing");
});

test("customer input builds a site only with street address", () => {
  const m = guessCustomerMapping(matrix[1] as string[]);
  const withSite = toCustomerInput(mapRow(matrix[2] as string[], m));
  assert.equal(withSite.sites.length, 1);
  assert.equal(withSite.sites[0].address, "Storgatan 1, 11122 Stockholm");
  assert.equal("latitude" in withSite.sites[0], false);
  assert.equal(toCustomerInput(mapRow(matrix[6] as string[], m)).sites.length, 0);
});

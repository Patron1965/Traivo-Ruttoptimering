import assert from "node:assert/strict";
import test from "node:test";
import { utils, write } from "xlsx";
import {
  normalizeImportDate,
  normalizeImportTime,
  parseCsvRecords,
  parseImportFile,
  parseLocalizedNumber,
  uniqueCustomFieldKeys,
} from "./import-file.ts";

test("parses a 247-row semicolon customer CSV without losing rows", async () => {
  const records = Array.from({ length: 247 }, (_, index) =>
    `ORDER-${index + 1};Kund ${index + 1};Gatan ${index + 1};${(index + 0.5).toFixed(1).replace(".", ",")}`,
  );
  const file = new File(
    [`\uFEFFOrdernummer;Namn;Adress;Vikt\r\n${records.join("\r\n")}`],
    "kund-247.csv",
    { type: "text/csv" },
  );
  const parsed = await parseImportFile(file);
  assert.equal(parsed.sourceRowCount, 247);
  assert.equal(parsed.rows.length, 247);
  assert.equal(parsed.rejectedRows.length, 0);
  assert.equal(parsed.rows[0].values[0], "ORDER-1");
  assert.equal(parsed.rows[246].values[0], "ORDER-247");
});

test("supports tab-separated quoted multiline fields and reports malformed rows", async () => {
  const file = new File(
    ['Id\tAdress\tKommentar\n1\t"Gata 1"\t"Rad ett\nrad två"\n2\tbara-två-kolumner\n\n'],
    "kund-tab.csv",
  );
  const parsed = await parseImportFile(file);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].values[2], "Rad ett\nrad två");
  assert.deepEqual(parsed.rejectedRows.map((row) => row.sourceRowNumber), [4, 5]);
  assert.match(parsed.rejectedRows[0].reasons[0], /2 kolumner/);
  assert.equal(parsed.rejectedRows[1].reasons[0], "Raden är tom.");
});

for (const bookType of ["xlsx", "xls"] as const) {
  test(`parses ${bookType.toUpperCase()} customer files`, async () => {
    const sheet = utils.aoa_to_sheet([
      ["Referens", "Datum", "Adress", "Extrafält"],
      ["A-1", "02.09.2026", "Storgatan 1", "bevaras"],
      ["A-2", "2026-09-03", "Storgatan 2", "också"],
    ]);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, "Ordrar");
    const bytes = write(workbook, { type: "array", bookType });
    const parsed = await parseImportFile(new File([bytes], `kund.${bookType}`));
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.headers[3], "Extrafält");
    assert.equal(parsed.rows[1].values[3], "också");
  });
}

test("operational XLSX preserves all 8,660 rows and all 18 columns, including the last cell", async () => {
  const headers = Array.from({ length: 18 }, (_, index) => `Kolumn ${index + 1}`);
  const records = Array.from({ length: 8660 }, (_, index) =>
    headers.map((_, column) => `rad-${index + 1}-kolumn-${column + 1}-värde`));
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([headers, ...records]), "Ordrar");
  const file = new File([write(workbook, { type: "array", bookType: "xlsx" })], "stor-import.xlsx");
  const parsed = await parseImportFile(file);
  assert.equal(parsed.headers.length, 18);
  assert.equal(parsed.sourceRowCount, 8660);
  assert.equal(parsed.rows.length, 8660);
  assert.equal(parsed.rejectedRows.length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify({ parsedData: parsed }), "utf8") > 512 * 1024);
  assert.equal(parsed.rows[0].values[17], records[0][17]);
  assert.equal(parsed.rows.at(-1)?.sourceRowNumber, 8661);
  assert.deepEqual(parsed.rows.at(-1)?.values, records.at(-1));
});

test("normalizes Swedish and international numbers and dates", () => {
  assert.equal(parseLocalizedNumber("1 234,56"), 1234.56);
  assert.equal(parseLocalizedNumber("1,234.56"), 1234.56);
  assert.equal(parseLocalizedNumber("1.234,56"), 1234.56);
  assert.equal(parseLocalizedNumber("12x"), undefined);
  assert.equal(normalizeImportDate("2.9.2026"), "2026-09-02");
  assert.equal(normalizeImportDate("2026/09/03"), "2026-09-03");
  assert.equal(normalizeImportDate("31.02.2026"), undefined);
  assert.equal(normalizeImportTime("8.05"), "08:05");
  assert.equal(normalizeImportTime("24:15"), undefined);
  assert.equal(normalizeImportTime("inte en tid"), undefined);
  assert.equal(normalizeImportTime("0805"), "08:05");
  assert.equal(normalizeImportTime("8"), "08:00");
  assert.deepEqual(
    uniqueCustomFieldKeys(["Å", "A", "a"], (header) => header.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()),
    ["custom_a", "custom_a_2", "custom_a_3"],
  );
});

test("CSV parser retains delimiters and escaped quotes inside quoted fields", () => {
  assert.deepEqual(
    parseCsvRecords('A,B,C\n1,"två, tre","säger ""hej"""'),
    [["A", "B", "C"], ["1", "två, tre", 'säger "hej"']],
  );
});
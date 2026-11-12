import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { buildRoutePlanWorkbook, matchesPlanningSelection } from "./route-plan-xlsx";

function rowCount(xml: string): number {
  return (xml.match(/<row r="/g) ?? []).length - 1;
}

test("route-plan workbook preserves every planned and unplanned customer row once", async () => {
  const workbook = await buildRoutePlanWorkbook([
    {
      name: "Rutter",
      preferredColumns: ["Rutt", "Förare", "Fordon"],
      rows: [{ Rutt: "Rutt 1", "Förare": "Anna Andersson", "Fordon": "Bil 7" }],
    },
    {
      name: "Planerade stopp",
      preferredColumns: ["Orderreferens", "Stoppordning", "Planerad ankomst"],
      rows: [
        {
          "Orderreferens": "ORDER-001",
          "Stoppordning": 1,
          "Planerad ankomst": "2026-09-07 08:30",
          "Kundens zon": "Nord",
          "Kundfält: Status": "Prioriterad kund",
          "Källrad i importfil": "2",
        },
        {
          "Orderreferens": "ORDER-002",
          "Stoppordning": 2,
          "Planerad ankomst": "2026-09-07 09:00",
          "Kundens zon": "Syd",
        },
      ],
    },
    {
      name: "Ej planerade stopp",
      preferredColumns: ["Orderreferens", "Orsak"],
      rows: [{
        "Orderreferens": "ORDER-003",
        "Orsak": "Stoppet har inte fått plats på någon vald rutt.",
        "Kundens zon": "Öst",
      }],
    },
  ]);

  const zip = await JSZip.loadAsync(workbook);
  const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
  const plannedXml = await zip.file("xl/worksheets/sheet2.xml")!.async("string");
  const unplannedXml = await zip.file("xl/worksheets/sheet3.xml")!.async("string");
  const customerRows = `${plannedXml}${unplannedXml}`;

  assert.match(workbookXml, /Planerade stopp/);
  assert.match(workbookXml, /Ej planerade stopp/);
  assert.equal(rowCount(plannedXml), 2);
  assert.equal(rowCount(unplannedXml), 1);
  assert.match(plannedXml, /Kundens zon/);
  assert.match(plannedXml, /Planerad ankomst/);
  assert.match(plannedXml, /Källrad i importfil/);
  assert.match(unplannedXml, /Orsak/);
  for (const reference of ["ORDER-001", "ORDER-002", "ORDER-003"]) {
    assert.equal(customerRows.split(reference).length - 1, 1, `${reference} ska förekomma exakt en gång`);
  }
});

test("route-plan workbook is a valid XLSX package with Swedish headers", async () => {
  const workbook = await buildRoutePlanWorkbook([{
    name: "Rutter",
    preferredColumns: ["Rutt", "Datum", "Sträcka (km)"],
    rows: [{ Rutt: "Rutt A", Datum: "2026-09-07", "Sträcka (km)": 12.5 }],
  }]);
  const zip = await JSZip.loadAsync(workbook);
  const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");

  assert.match(contentTypes, /spreadsheetml\.sheet\.main\+xml/);
  assert.match(sheet, /Rutt/);
  assert.match(sheet, /Sträcka \(km\)/);
  assert.match(sheet, /<v>12\.5<\/v>/);
});

test("unplanned rows are isolated to the selected plan or planning date", () => {
  const selectedPlan = "00000000-0000-4000-8000-000000000001";
  const otherPlan = "00000000-0000-4000-8000-000000000002";
  const selectedDate = new Date("2026-09-07T10:00:00.000Z");
  const rows = [
    { planningPlanId: selectedPlan, planningDate: selectedDate },
    { planningPlanId: otherPlan, planningDate: selectedDate },
    { planningPlanId: null, planningDate: new Date("2026-09-08T10:00:00.000Z") },
    { planningPlanId: null, planningDate: null },
  ];

  assert.deepEqual(
    rows.map((row) => matchesPlanningSelection(row, { planId: selectedPlan })),
    [true, false, false, false],
  );
  assert.deepEqual(
    rows.map((row) => matchesPlanningSelection(row, {
      from: new Date("2026-09-07T00:00:00.000Z"),
      to: new Date("2026-09-07T23:59:59.999Z"),
    })),
    [true, true, false, false],
  );
});
import assert from "node:assert/strict";
import test from "node:test";
import { parseImportFile } from "./import-file.ts";
import { assertCompleteAppendFile, canAppendToRoute, canConfirmAppend, mapAppendRows } from "./route-append-import.ts";

async function csv(text: string) {
  return parseImportFile(new File([text], "stopp.csv"), { preserveValues: true });
}
test("append preserves every row and source cell including custom columns", async () => {
  const file = await csv("Adress;Kontakt;Eget\nGatan 1; Anna ; 001 \nGatan 2;Bo;002");
  const rows = mapAppendRows(file, { address: "Adress", contactName: "Kontakt" }, "2026-07-19");
  assert.equal(rows.length, file.sourceRowCount);
  assert.equal(rows[0].sourceRowNumber, 2);
  assert.equal(rows[0].contactName, "Anna");
  assert.equal(rows[0].customFields?.["Källkolumn 3: Eget"], " 001 ");
  assert.equal(rows[0].customFields?.["Källkolumn 2: Kontakt"], " Anna ");
});
test("malformed/blank source rows reject whole batch, never filter", async () => {
  for (const text of ["Adress;Namn\nGatan;A\nFel", "Adress;Namn\nGatan;A\n;"]) {
    const file = await csv(text);
    assert.throws(() => assertCompleteAppendFile(file), /Hela filen avvisades/);
  }
  await assert.rejects(() => csv('Adress\n"oavslutad'));
});
test("mapping rejects missing address, invalid numbers, dates, duplicate mappings", async () => {
  const file = await csv("Adress;Tal;Datum\nGatan;fel;2026-07-20");
  assert.throws(() => mapAppendRows(file, {}, "2026-07-19"), /leveransadress/);
  assert.throws(() => mapAppendRows(file, { address: "Adress", weightKg: "Tal" }, "2026-07-19"), /Ogiltigt tal/);
  assert.throws(() => mapAppendRows(file, { address: "Adress", planningDate: "Datum" }, "2026-07-19"), /samma som/);
  assert.throws(() => mapAppendRows(file, { address: "Adress", notes: "Adress" }, "2026-07-19"), /flera fält/);
});
test("times use Stockholm and transport/service fields survive mapping", async () => {
  const file = await csv("Adress;Tid;Vikt;Typ;Hämtning;Kompetens\nGatan;08:00;25,5;pickup_delivery;Terminal;A,B");
  const [row] = mapAppendRows(file, { address: "Adress", timeWindowStart: "Tid", weightKg: "Vikt", jobType: "Typ", pickupAddress: "Hämtning", requiredSkills: "Kompetens" }, "2026-07-19");
  assert.equal(row.timeWindowStart, "2026-07-19T06:00:00.000Z");
  assert.equal(row.weightKg, 25.5);
  assert.equal(row.pickupAddress, "Terminal");
  assert.deepEqual(row.requiredSkills, ["A", "B"]);
});
test("entry eligibility fails closed for outgoing, locked and terminal routes", () => {
  const route = { status: "optimized", handoffStatus: "pending", optimizationFrozen: false, sentAt: null, acceptedAt: null } as const;
  assert.equal(canAppendToRoute(route), true);
  for (const patch of [{ status: "completed" as const }, { status: "in_progress" as const }, { handoffStatus: "sent" as const }, { optimizationFrozen: true }, { acceptedAt: "2026-07-19" }, { sentAt: "2026-07-19" }]) {
    assert.equal(canAppendToRoute({ ...route, ...patch }), false);
  }
});
test("confirmation gates expired proposals, duplicates and repeated submissions", () => {
  const state = { busy: false, submitted: false, duplicates: 0, acknowledged: false, expiresAt: "2026-07-19T12:00:00Z" };
  const now = Date.parse("2026-07-19T11:00:00Z");
  assert.equal(canConfirmAppend(state, now), true);
  assert.equal(canConfirmAppend({ ...state, duplicates: 1 }, now), false);
  assert.equal(canConfirmAppend({ ...state, duplicates: 1, acknowledged: true }, now), true);
  assert.equal(canConfirmAppend({ ...state, submitted: true }, now), false);
  assert.equal(canConfirmAppend({ ...state, busy: true }, now), false);
  assert.equal(canConfirmAppend(state, Date.parse(state.expiresAt)), false);
});

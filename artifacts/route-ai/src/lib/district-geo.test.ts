import { test } from "node:test";
import assert from "node:assert/strict";
import { pointInPolygon, resolveDraftMembers, resolveInterval } from "./district-geo.ts";
import { parseCsvRecords } from "./import-file.ts";

const square = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 0 }];

test("point in polygon", () => {
  assert.equal(pointInPolygon(0.5, 0.5, square), true);
  assert.equal(pointInPolygon(1.5, 0.5, square), false);
  assert.equal(pointInPolygon(0.5, 0.5, square.slice(0, 2)), false);
});

test("manual adjustments win over polygon", () => {
  const points = [
    { id: "a", latitude: 0.5, longitude: 0.5 },
    { id: "b", latitude: 0.2, longitude: 0.2 },
    { id: "c", latitude: 5, longitude: 5 },
  ];
  const members = resolveDraftMembers(points, square, new Set(["c"]), new Set(["b"]));
  assert.deepEqual([...members].sort(), ["a", "c"]);
});

test("interval wraps only in closed loop", () => {
  const wrap = resolveInterval(5, 4, 2, true);
  assert.ok(wrap.ok && wrap.wraps);
  if (wrap.ok) assert.deepEqual(wrap.indexes, [3, 4, 0, 1]);
  assert.equal(resolveInterval(5, 4, 2, false).ok, false);
  const plain = resolveInterval(5, 2, 3, false);
  assert.ok(plain.ok);
  if (plain.ok) assert.deepEqual(plain.indexes, [1, 2]);
  assert.equal(resolveInterval(5, 0, 3, true).ok, false);
});

test("csv parser keeps leading zeros; trims by default", () => {
  assert.deepEqual(parseCsvRecords("a;b\n00123; x \n"), [["a", "b"], ["00123", "x"]]);
});

test("csv preserve mode keeps exact values and original line numbers", async () => {
  const { parseImportFile } = await import("./import-file.ts");
  const text = 'obj;adr;lat;lon\n 007 ;"Storg 1\nuppg B";57.7;11.9\nbad;row\n0012;Väg 2;57.8;12.0\n';
  const file = new File([text], "x.csv");
  const parsed = await parseImportFile(file, { preserveValues: true });
  assert.equal(parsed.rows[0].values[0], " 007 ");
  assert.equal(parsed.rows[0].sourceRowNumber, 2);
  assert.equal(parsed.rejectedRows[0].sourceRowNumber, 4);
  assert.equal(parsed.rows[1].values[0], "0012");
  assert.equal(parsed.rows[1].sourceRowNumber, 5);
  assert.equal(parsed.sourceRowCount, 3);
  const { buildSourceRows } = await import("./district-source-rows.ts");
  const rows = buildSourceRows(parsed);
  assert.deepEqual(rows.map((r) => r.sourceRowNumber), [2, 4, 5]);
  assert.equal(rows[0].original.obj, " 007 ");
  assert.equal(rows[0].parseError, undefined);
  assert.ok(rows[1].parseError);
  assert.deepEqual(rows[1].original, { obj: "bad", adr: "row" });
});

test("sourceKey is bounded, stable and mapping-sensitive", async () => {
  const { buildSourceKey } = await import("./district-source-rows.ts");
  const bytes = new TextEncoder().encode("a;b\n1;2\n").buffer;
  const long = "x".repeat(500);
  const m = { objectNumber: long, address: long + "a", latitude: long + "b", longitude: long + "c" };
  const k1 = await buildSourceKey(bytes, m);
  assert.ok(k1.length <= 200);
  assert.equal(k1, await buildSourceKey(bytes, { ...m }));
  assert.notEqual(k1, await buildSourceKey(bytes, { ...m, address: "other" }));
});

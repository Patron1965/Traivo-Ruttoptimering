import assert from "node:assert/strict";
import test from "node:test";
import { filterRoutePlanGroups } from "./route-filters.ts";

const groups = [
  {
    key: "plan:morning",
    planTitle: "Morgon Norr",
    routes: [
      { id: "r1", name: "Rutt Norr", status: "optimized", date: "2026-04-03", vehicleName: "Volvo", vehicleLicense: "ABC123", driverName: "Åsa" },
      { id: "r2", name: "Rutt Söder", status: "completed", date: "2026-04-03", vehicleName: "Scania", vehicleLicense: "DEF456", driverName: "Bo" },
    ],
  },
];

function filter(query = "", status: "all" | "active" | "drafts" | "completed" = "all") {
  return filterRoutePlanGroups(groups, {
    query,
    status,
    getPlanTitle: (group) => group.planTitle,
    getSearchFields: (route) => route,
  });
}

test("matches route metadata and dates, including accent-insensitive driver names", () => {
  assert.deepEqual(filter("asa")[0]?.routes.map((route) => route.id), ["r1"]);
  assert.deepEqual(filter("2026-04-03")[0]?.routes.map((route) => route.id), ["r1", "r2"]);
  assert.deepEqual(filter("def456")[0]?.routes.map((route) => route.id), ["r2"]);
});

test("a plan-name match keeps all status-matching children", () => {
  assert.deepEqual(filter("morgon", "active")[0]?.routes.map((route) => route.id), ["r1"]);
  assert.deepEqual(filter("morgon", "completed")[0]?.routes.map((route) => route.id), ["r2"]);
});
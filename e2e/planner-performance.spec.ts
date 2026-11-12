import { expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authenticatedOrganizationId, login, test } from "./auth";

const largeUi = process.env.E2E_PERF_LARGE_UI === "1";
test(largeUi ? "synthetic UI workload: 228 stops and nine resources" : "normal synthetic workload: 30 stops and three resources", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1512, height: 982 });
  await login(page, "/dispatch", "dispatch-split");
  const organizationId = await authenticatedOrganizationId(page);
  const seeded = await promisify(execFile)("pnpm", ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", `
    import { db, pool, vehiclesTable, driversTable, routesTable, stopsTable } from "@workspace/db";
    import { randomUUID } from "node:crypto";
    (async () => { try {
      const org = process.env.TEST_ORG;
      const owner = await pool.query("SELECT id FROM organizations WHERE id=$1 AND email LIKE 'e2e-address-persistence-%@example.test'", [org]);
      if (owner.rowCount !== 1) throw new Error("Disposable tenant required");
      await pool.query("INSERT INTO organization_service_policies (organization_id,policy) VALUES ($1,$2::jsonb)",
        [org,JSON.stringify({roadProvider:"osrm",geocodingProvider:"disabled",smsProvider:"disabled",emailEnabled:false,aiEnabled:false,cuoptEnabled:false,districtEnabled:false})]);
      const pairs = [], stopIds = [], routes = [], planId = randomUUID();
      const large = process.env.E2E_PERF_LARGE_UI === "1";
      const point = {address:"Synthetic colocated depot",latitude:59.3,longitude:18,verifiedAt:new Date().toISOString(),verification:{provider:"synthetic"}};
      await pool.query("UPDATE organizations SET depot_start_latitude=59.3,depot_start_longitude=18,depot_end_latitude=59.3,depot_end_longitude=18 WHERE id=$1", [org]);
      for (let i=0;i<(large?9:3);i++) {
        const [v] = await db.insert(vehiclesTable).values({organizationId:org,name:"Perf vehicle "+i,licensePlate:randomUUID(),vehicleType:"fossil",capacityKg:1000,capacityVolume:10}).returning();
        const [d] = await db.insert(driversTable).values({organizationId:org,vehicleId:v.id,name:"Perf driver "+i,workStartTime:"07:00",workEndTime:"18:00",startLatitude:59.3,startLongitude:18,endLatitude:59.3,endLongitude:18}).returning();
        const count = large ? (i<3?26:25) : 10;
        let routeId;
        if (large) {
          const [r] = await db.insert(routesTable).values({organizationId:org,planId,vehicleId:v.id,name:"Synthetic UI load "+i,status:"optimized",date:new Date("2026-10-26T06:00:00Z"),totalStops:count,depotSnapshot:{start:point,end:point},optimizationPlanningSnapshot:{version:1,objective:"shortest",travelReservePercent:0,stopReserveMin:0,stopPriorities:{},excludedPairValues:[],depotOverride:null,vehicleSelectionMode:"use_all_selected_pairs"}}).returning();
          routeId=r.id; routes.push({routeId,vehicleId:v.id});
        }
        const stops = await db.insert(stopsTable).values(Array.from({length:count},(_,n)=>({organizationId:org,routeId,planningPlanId:large?planId:undefined,sequenceOrder:large?n+1:undefined,address:"Synthetic job "+i+"-"+n,latitude:59.3,longitude:18,serviceDurationMin:5}))).returning();
        pairs.push({vehicleId:v.id,driverId:d.id}); stopIds.push(...stops.map(s=>s.id));
      }
      console.log(JSON.stringify({pairs,stopIds,planId,routes}));
    } finally { await pool.end(); } })().catch(e=>{console.error(e);process.exitCode=1});
  `], { env: { ...process.env, TEST_ORG: organizationId } });
  const fixture = JSON.parse(seeded.stdout.trim());
  let plan = fixture;
  let firstPlanMs: number | null = null;
  if (!largeUi) {
    const planStart = performance.now();
    const creation = await page.request.post("/api/import/route-plans", { data: {
    stopIds: fixture.stopIds, pairs: fixture.pairs, vehicleDistributionMode: "balance",
    date: "2026-10-26", name: "Synthetic normal workload",
    depotLatitude: 59.3, depotLongitude: 18,
  } });
  expect(creation.status(), await creation.text()).toBe(200);
  plan = await creation.json();
  expect(plan.unassignedStopIds).toEqual([]);
  expect(plan.routes).toHaveLength(3);
  firstPlanMs = performance.now() - planStart;
  }
  fixture.planId = plan.planId;
  fixture.routeIds = plan.routes.map((route: any) => route.routeId);
  const firstPair = fixture.pairs.find((pair: any) => pair.vehicleId === plan.routes[0].vehicleId);
  const samples: { boardMs: number; previewMs: number; overviewMs: number }[] = [];
  for (let i = 0; i < 5; i++) {
    let start = performance.now();
    await page.goto(`/dispatch?planId=${fixture.planId}`);
    await expect(page.getByTestId("dispatch-gantt-row")).toHaveCount(largeUi ? 9 : 3);
    await expect(page.getByTestId("dispatch-stop-block")).toHaveCount(largeUi ? 228 : 30);
    const boardMs = performance.now() - start;
    start = performance.now();
    const overview = page.getByTestId("dispatch-plan-overview");
    await overview.locator(":scope > summary").click();
    await expect(overview).toHaveAttribute("open", "");
    await overview.locator(":scope > summary").click();
    const overviewMs = performance.now() - start;
    const route = await (await page.request.get(`/api/routes/${fixture.routeIds[0]}`)).json();
    start = performance.now();
    const preview = await page.request.post("/api/planner-corrections/route-resources/preview", {
      data: { routeId: route.id, planRevision: route.planRevision, vehicleId: firstPair.vehicleId, driverId: firstPair.driverId, force: false },
    });
    expect(preview.status(), await preview.text()).toBe(200);
    const previewMs = performance.now() - start;
    samples.push({ boardMs, overviewMs, previewMs });
  }
  console.log("PERFORMANCE_BASELINE", JSON.stringify({ firstPlanMs, samples }));
  await info.attach("workload-baseline.json", { body: JSON.stringify({ workload: largeUi ? "228 synthetic preassigned stops / 9 resources; no optimization" : "30 synthetic colocated stops / 3 resources", firstPlanMs, samples }), contentType: "application/json" });
  // Explicit local regression budgets established after the recorded baseline.
  // These are not production SLOs or real-road optimization quality claims.
  if (firstPlanMs !== null) expect(firstPlanMs).toBeLessThan(15_000);
  for (const sample of samples) {
    expect(sample.boardMs).toBeLessThan(largeUi ? 15_000 : 5_000);
    expect(sample.overviewMs).toBeLessThan(largeUi ? 1_500 : 1_000);
    expect(sample.previewMs).toBeLessThan(1_000);
  }
  await page.screenshot({ path: info.outputPath("normal-workload.png") });
});

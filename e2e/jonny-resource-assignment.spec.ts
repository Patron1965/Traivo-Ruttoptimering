import { expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authenticatedOrganizationId, login, test } from "./auth";

test("real planner journey: resource changes, stale preview, map replan, pointer selection, persistent locks and concurrent confirmation", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page, "/dispatch", "dispatch-split");
  const organizationId = await authenticatedOrganizationId(page);
  const seeded = await promisify(execFile)("pnpm", ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", `
    import { db, pool, vehiclesTable, driversTable, routesTable, stopsTable } from "@workspace/db";
    (async () => { try {
      const org = process.env.E2E_ORG;
      const owned = await pool.query("SELECT id FROM organizations WHERE id=$1 AND email LIKE 'e2e-address-persistence-%@example.test'", [org]);
      if (owned.rowCount !== 1) throw new Error("Not disposable");
      await pool.query("INSERT INTO organization_service_policies (organization_id,policy) VALUES ($1,$2::jsonb) ON CONFLICT (organization_id) DO UPDATE SET policy=EXCLUDED.policy",
        [org, JSON.stringify({roadProvider:"osrm",geocodingProvider:"disabled",smsProvider:"disabled",emailEnabled:false,aiEnabled:false,cuoptEnabled:false,districtEnabled:false})]);
      const pairs = [];
      for (let i=0; i<2; i++) {
        const [v] = await db.insert(vehiclesTable).values({organizationId:org, name:"Verifieringsbil "+i, licensePlate:"VERIFY-"+i+"-"+Date.now(), capacityKg:1000, capacityVolume:10, vehicleType:"fossil"}).returning();
        const [d] = await db.insert(driversTable).values({organizationId:org, vehicleId:v.id, name:"Verifieringsförare "+i, workStartTime:"07:00",workEndTime:"18:00",startLatitude:59.3,startLongitude:18,endLatitude:59.3,endLongitude:18}).returning();
        pairs.push({vehicleId:v.id,driverId:d.id});
      }
      const point = {address:"Synthetic colocated depot",latitude:59.3,longitude:18,verifiedAt:new Date().toISOString(),verification:{provider:"synthetic"}};
      const [route] = await db.insert(routesTable).values({organizationId:org,name:"Verifiera förartilldelning",status:"optimized",date:new Date("2026-10-26T06:00:00Z"),depotSnapshot:{start:point,end:point},optimizationPlanningSnapshot:{version:1,objective:"shortest",travelReservePercent:0,stopReserveMin:0,stopPriorities:{},excludedPairValues:[],depotOverride:null,vehicleSelectionMode:"use_all_selected_pairs"},totalStops:1}).returning();
      const [stop] = await db.insert(stopsTable).values({organizationId:org,routeId:route.id,planningPlanId:route.planId,address:"Synthetic colocated stop",latitude:59.3,longitude:18,sequenceOrder:1,serviceDurationMin:5}).returning();
      const [unplanned] = await db.insert(stopsTable).values({organizationId:org,planningPlanId:route.planId,address:"Synthetic unplanned colocated stop",latitude:59.3,longitude:18,serviceDurationMin:5}).returning();
      console.log(JSON.stringify({routeId:route.id, planId:route.planId, stopId:stop.id, unplannedId:unplanned.id,pairs}));
    } finally {await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1});
  `], { env: { ...process.env, E2E_ORG: organizationId } });
  const fixture = JSON.parse(seeded.stdout.trim());
  for (let index = 0; index < 2; index++) {
    await page.goto(`/routes/${fixture.routeId}`);
    const action = page.getByTestId(`route-driver-action-${fixture.routeId}`);
    await expect(action).toHaveText(index === 0 ? "Tilldela förare" : "Byt förare");
    await action.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").selectOption(`${fixture.pairs[index].vehicleId}:${fixture.pairs[index].driverId}`);
    await expect(dialog.getByTestId("resource-pair-change")).toContainText("fordonet byts också");
    await dialog.getByRole("button", { name: "Förhandsgranska resursbyte" }).click();
    await dialog.getByLabel("Jag har granskat resurspar, före/efter och eventuella okända mått.").check();
    if (index === 1) {
      const before = await (await page.request.get(`/api/routes/${fixture.routeId}`)).json();
      // Resource facts can change without changing the route's revision.
      const changedShift = await page.request.put(`/api/drivers/${fixture.pairs[index].driverId}`, {
        data: { workEndTime: "17:59" },
      });
      expect(changedShift.status(), await changedShift.text()).toBe(200);
      const rejected = page.waitForResponse(r => r.url().includes("/route-resources/confirm") && r.request().method() === "POST");
      await dialog.getByRole("button", { name: "Bekräfta resursbyte" }).click();
      expect((await rejected).status()).toBe(409);
      await expect(dialog.getByRole("alert")).toContainText("Inget nytt försök görs automatiskt");
      await expect(dialog.getByRole("button", { name: "Bekräfta resursbyte" })).toHaveCount(0);
      const unchanged = await (await page.request.get(`/api/routes/${fixture.routeId}`)).json();
      expect(unchanged.planRevision).toBe(before.planRevision);
      expect(unchanged.vehicleId).toBe(before.vehicleId);
      await dialog.getByRole("button", { name: "Förhandsgranska resursbyte" }).click();
      await dialog.getByLabel("Jag har granskat resurspar, före/efter och eventuella okända mått.").check();
    }
    const response = page.waitForResponse(r => r.url().includes("/route-resources/confirm") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Bekräfta resursbyte" }).click();
    expect((await response).status()).toBe(200);
    await page.reload();
    const saved = await (await page.request.get(`/api/routes/${fixture.routeId}`)).json();
    expect(saved.vehicleId).toBe(fixture.pairs[index].vehicleId);
    const stops = await (await page.request.get(`/api/routes/${fixture.routeId}/stops`)).json();
    expect(stops.map((s: any) => [s.id, s.sequenceOrder])).toEqual([[fixture.stopId, 1]]);
  }

  // Same map window: add a real resource pair and include this plan's backlog.
  await page.goto(`/map-popout?planId=${fixture.planId}`);
  await page.getByText("Välj chaufförer", { exact: false }).click();
  await page.getByTestId("map-edit-plan-drivers").click();
  const review = page.getByRole("dialog");
  const extraPair = review.getByTestId(`checkbox-replan-resource-${fixture.pairs[0].vehicleId}-${fixture.pairs[0].driverId}`);
  await extraPair.check();
  page.once("dialog", dialog => dialog.accept());
  const saved = page.waitForResponse(r => r.url().includes("/reoptimize-service-time") && r.request().method() === "POST");
  await review.getByTestId("button-replan-selected-resources").click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
  await expect(review.getByText("Omberäkningen är sparad som arbetsplan", { exact: false })).toBeVisible();
  await review.getByRole("button", { name: "Stäng", exact: true }).click();
  await page.reload();
  const routesResponse = await page.request.get(`/api/routes?organizationId=${organizationId}`);
  expect(routesResponse.status(), await routesResponse.text()).toBe(200);
  const currentRoutes = await routesResponse.json();
  const planRoutes = currentRoutes.filter((r: any) => r.planId === fixture.planId && r.status !== "cancelled");
  expect(planRoutes).toHaveLength(2);
  expect(new Set(planRoutes.map((r: any) => r.vehicleId))).toEqual(new Set(fixture.pairs.map((p: any) => p.vehicleId)));
  const stopsResponse = await page.request.get(`/api/stops?organizationId=${organizationId}`);
  expect(stopsResponse.status(), await stopsResponse.text()).toBe(200);
  const currentStops = await stopsResponse.json();
  for (const id of [fixture.stopId, fixture.unplannedId]) {
    const stop = currentStops.find((s: any) => s.id === id);
    expect(stop.planningPlanId).toBe(fixture.planId);
    expect(planRoutes.map((r: any) => r.id)).toContain(stop.routeId);
  }
  await expect(page).toHaveURL(new RegExp(`/map-popout\\?planId=${fixture.planId}`));

  // Continue the same real-API plan into lock/reload/concurrent-change checks.
  const lockedStop = currentStops.find((s: any) => s.id === fixture.stopId);
  const lockRouteId = lockedStop.routeId;
  await page.goto(`/dispatch?planId=${fixture.planId}`);
  // Ordinary pointer selection must remain reachable beside sticky driver cells.
  await page.locator(`[data-testid="dispatch-stop-block"][data-stop-id="${fixture.stopId}"]`).click({ timeout: 15_000 });
  const lockResponse = () => page.waitForResponse(r =>
    r.url().endsWith(`/routes/${lockRouteId}/planning-locks`) && r.request().method() === "PUT");
  await page.getByTestId(`button-lock-resource-${fixture.stopId}`).click();
  let pending = lockResponse();
  await page.getByTestId("button-confirm-resource-lock").click();
  expect((await pending).status()).toBe(200);
  const timeInput = page.getByTestId(`input-service-start-lock-${fixture.stopId}`);
  expect(await timeInput.inputValue()).not.toBe("");
  await page.getByTestId(`button-lock-time-${fixture.stopId}`).click();
  pending = lockResponse();
  await page.getByTestId("button-confirm-time-lock").click();
  expect((await pending).status()).toBe(200);
  await page.reload();
  const persisted = await (await page.request.get(`/api/stops/${fixture.stopId}`)).json();
  expect(persisted.lockedVehicleId).toBeTruthy();
  expect(persisted.lockedServiceStartAt).toBeTruthy();
  const overview = page.getByTestId("dispatch-plan-overview");
  await overview.locator(":scope > summary").click();
  await page.getByText("Ruttlås – frysning mot planändringar", { exact: true }).click();
  await page.getByTestId(`button-freeze-route-${lockRouteId}`).click();
  pending = lockResponse();
  await page.getByTestId("button-confirm-route-freeze").click();
  expect((await pending).status()).toBe(200);
  await page.reload();
  expect((await (await page.request.get(`/api/routes/${lockRouteId}`)).json()).optimizationFrozen).toBe(true);
  await overview.locator(":scope > summary").click();
  await page.getByText("Ruttlås – frysning mot planändringar", { exact: true }).click();
  await page.getByTestId(`button-unfreeze-route-${lockRouteId}`).click();
  // A second actor wins while the first actor's confirmation is still open.
  const before = await (await page.request.get(`/api/routes/${lockRouteId}`)).json();
  const concurrent = await page.request.put(`/api/routes/${lockRouteId}/planning-locks`, {
    data: { planRevision: before.planRevision, frozen: false },
  });
  expect(concurrent.status()).toBe(200);
  pending = lockResponse();
  await page.getByTestId("button-confirm-route-unfreeze").click();
  expect((await pending).status()).toBe(409);
  await expect(page.getByTestId("text-planning-lock-error")).toBeVisible();
  const after = await (await page.request.get(`/api/routes/${lockRouteId}`)).json();
  expect(after.planRevision).toBe(before.planRevision + 1);
  expect(after.optimizationFrozen).toBe(false);
});

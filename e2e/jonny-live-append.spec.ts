import { expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authenticatedOrganizationId, login, test } from "./auth";

// Explicit opt-in only: this acceptance spends a small amount of provider quota.
test.skip(process.env.RUN_LIVE_APPEND_ACCEPTANCE !== "1", "Real provider acceptance is opt-in");
test("CSV append uses real geocoding and roads and survives reload", async ({ page }, info) => {
  test.setTimeout(180_000);
  await login(page, "/dispatch", "dispatch-split");
  const organizationId = await authenticatedOrganizationId(page);
  const run = async (script: string) => {
    const result = await promisify(execFile)("pnpm", ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", `
      import { db, pool, vehiclesTable, driversTable, routesTable, stopsTable } from "@workspace/db";
      (async () => { try {
        const org = process.env.E2E_ORG;
        const owned = await pool.query("SELECT id FROM organizations WHERE id=$1 AND email LIKE 'e2e-address-persistence-%@example.test'", [org]);
        if (owned.rowCount !== 1) throw new Error("Not a disposable organization");
        ${script}
      } finally { await pool.end(); } })().catch(e => { console.error(e); process.exitCode=1; });
    `], { env: { ...process.env, E2E_ORG: organizationId } });
    return JSON.parse(result.stdout.trim());
  };
  const fixture = await run(`
    await pool.query("INSERT INTO organization_service_policies (organization_id,policy) VALUES ($1,$2::jsonb) ON CONFLICT (organization_id) DO UPDATE SET policy=EXCLUDED.policy",
      [org, JSON.stringify({roadProvider:"geoapify",geocodingProvider:"google",smsProvider:"disabled",emailEnabled:false,aiEnabled:false,cuoptEnabled:false,districtEnabled:false})]);
    const [vehicle] = await db.insert(vehiclesTable).values({organizationId:org,name:"Live acceptance vehicle",licensePlate:"TEST-"+Date.now(),capacityKg:1000,capacityVolume:10,vehicleType:"fossil"}).returning();
    const [driver] = await db.insert(driversTable).values({organizationId:org,vehicleId:vehicle.id,name:"Live acceptance driver",workStartTime:"07:00",workEndTime:"18:00",startLatitude:59.3293,startLongitude:18.0686,endLatitude:59.3293,endLongitude:18.0686}).returning();
    const point = {address:"Synthetic acceptance depot",latitude:59.3293,longitude:18.0686,verifiedAt:new Date().toISOString(),verification:{provider:"synthetic"}};
    const [route] = await db.insert(routesTable).values({organizationId:org,vehicleId:vehicle.id,name:"Live append acceptance",status:"optimized",date:new Date("2026-10-26T06:00:00Z"),totalStops:1,
      depotSnapshot:{start:point,end:point},optimizationResourceSnapshot:{driver:{id:driver.id}},
      optimizationPlanningSnapshot:{version:1,objective:"shortest",travelReservePercent:0,stopReserveMin:0,stopPriorities:{},excludedPairValues:[],depotOverride:null,vehicleSelectionMode:"use_all_selected_pairs"}}).returning();
    const [stop] = await db.insert(stopsTable).values({organizationId:org,routeId:route.id,planningPlanId:route.planId,address:"Synthetic existing stop",latitude:59.3293,longitude:18.0686,sequenceOrder:1,serviceDurationMin:5,notes:"Must survive live append",customFields:{source:"original"}}).returning();
    console.log(JSON.stringify({routeId:route.id,stop}));
  `);
  await page.goto(`/routes/${fixture.routeId}`);
  await page.getByRole("button", { name: "Importera fler stopp", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "live-append.csv", mimeType: "text/csv",
    buffer: Buffer.from("Leveransadress;Referensnummer;Eget fält\nSveavägen 1, Stockholm;LIVE-APPEND-1;bevarat\n"),
  });
  const previewResponse = page.waitForResponse(r => r.url().includes("/import-stops/preview") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Validera adresser och förhandsgranska" }).click();
  const preview = await previewResponse;
  const previewBody = await preview.json();
  expect(preview.status(), JSON.stringify(previewBody)).toBe(200);
  await expect(dialog).toContainText("1 befintliga + 1 nya = 2 stopp");
  const confirmResponse = page.waitForResponse(r => r.url().includes("/import-stops/apply") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Bekräfta import och optimera hela rutten" }).click();
  const confirmed = await confirmResponse;
  const confirmation = await confirmed.json();
  expect(confirmed.status(), JSON.stringify(confirmation)).toBe(200);
  await expect(dialog).toContainText("Importen är sparad");
  await page.reload();
  await expect(page.getByText("Sveavägen 1, Stockholm").first()).toBeVisible();
  const response = await page.request.get(`/api/routes/${fixture.routeId}/stops`);
  expect(response.status()).toBe(200);
  const stops = await response.json();
  expect(stops).toHaveLength(2);
  expect(stops.find((s: any) => s.id === fixture.stop.id)).toMatchObject({
    address: fixture.stop.address, notes: fixture.stop.notes, customFields: fixture.stop.customFields,
  });
  const appended = stops.find((s: any) => s.id !== fixture.stop.id);
  expect(appended).toMatchObject({
    address: "Sveavägen 1, Stockholm", externalRef: "LIVE-APPEND-1",
    customFields: { "Källkolumn 3: Eget fält": "bevarat" },
  });
  expect(appended.latitude).toBeGreaterThan(59.3);
  expect(appended.latitude).toBeLessThan(59.4);
  expect(appended.longitude).toBeGreaterThan(18);
  expect(appended.longitude).toBeLessThan(18.2);
  const usage = await run(`
    const result = await pool.query("SELECT provider,operation,outcome,units FROM planning_usage_events WHERE organization_id=$1 ORDER BY occurred_at", [org]);
    console.log(JSON.stringify(result.rows));
  `);
  await info.attach("live-provider-evidence", { body: JSON.stringify({ usage, counts: confirmation.counts, appended }, null, 2), contentType: "application/json" });
  console.log("Live provider usage:", JSON.stringify(usage));
  expect(usage.some((u: any) => u.provider === "google" && u.outcome === "success")).toBe(true);
  expect(usage.some((u: any) => u.provider === "geoapify" && u.outcome === "success")).toBe(true);
  await page.screenshot({ path: info.outputPath("live-append-reloaded.png"), fullPage: true });
});

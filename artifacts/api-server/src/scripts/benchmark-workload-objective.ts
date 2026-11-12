/**
 * Isolated 154-stop acceptance harness. Input is an authorized, frozen array of
 * route resource snapshots (no live database reads or plan writes).
 * Run from the workspace root; pass an ignored directory containing input.json.
 * Provider responses are cached once and shared by old/new code comparisons.
 * Never commit customer snapshots or provider responses.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { optimizeWithALNS } from "../services/alns/runner";
import { evaluateRoute, computeGeographicCohesionCost } from "../services/alns/cost";
import { evaluateRouteWorkday } from "../services/route-workday";
import { precomputeDistanceMatrix, getDistanceMatrixCacheCoverage } from "../services/osrm";
import { withRequiredRoadData } from "../services/road-data-policy";
import { policyToALNSConfig, resolveOptimizationPolicy } from "../services/alns/optimization-policy";
import { recoverPlanningCoverage } from "../services/planning-coverage-recovery";
import { planningWeights, routingConstraintsForDriver, reinsertUnassignedNodes, admitPrioritizedUnassignedNodes, fillExplicitlySelectedEmptyRoutes } from "../services/import-route-workflow";
import type { ALNSNode, ALNSVehicle } from "../services/alns/types";
import { DEFAULT_WEIGHTS } from "../services/alns/types";

const dir = process.argv[2] ?? ".local/task252";
const bytes = readFileSync(`${dir}/input.json`);
const input = JSON.parse(bytes.toString());
const hash = createHash("sha256").update(bytes).digest("hex");
const start = new Date(input[0].date);
const config = input[0].inputs;
const profile = process.argv[3] ?? config.objective;
if (!["balanced", "shortest", "geographic", "areas_worktime", "minimize_vehicles"].includes(profile)) throw Error("Unknown profile");
const selection = process.argv[4] ?? "use_all_selected_pairs";
if (!["use_all_selected_pairs", "minimize_vehicles"].includes(selection)) throw Error("Unknown resource selection");
config.objective = profile;
config.vehicleSelectionMode = selection;
const vehicles: ALNSVehicle[] = input.map((r: any) => {
  const d = r.resource.driver, v = r.resource.vehicle;
  if (d.tempo !== "normal" || v.vehicleType !== "fossil") throw Error("Unexpected resource");
  return { ...v, driverId: d.id, capacityKg: Math.min(d.capacityKg, v.capacityKg),
    capacityVolume: Math.min(d.capacityVolume, v.capacityVolume),
    startLatitude: d.startLatitude, startLongitude: d.startLongitude,
    endLatitude: d.endLatitude, endLongitude: d.endLongitude,
    tempoMultiplier: 1, maxDriverOvertimeMin: config.maxDriverOvertimeMin,
    allowLateStopsMin: config.allowLateStopsMin, travelReservePercent: config.travelReservePercent,
    canonicalDriverConstraints: routingConstraintsForDriver({...d, name: "benchmark"}) };
});
const nodes: ALNSNode[] = input.flatMap((r: any) => r.resource.stops.map((s: any) => {
  if(s.jobType !== "delivery" || s.timeWindowStart || s.timeWindowEnd || s.pickupLatitude || s.requiredSkills) throw Error("Unexpected stop constraint");
  return { ...s, weightKg: s.weightKg ?? 0, volumeM3: s.volumeM3 ?? 0,
    planningPriority: config.stopPriorities[s.id] ?? 0,
    stopReserveMin: config.stopReserveMin, travelReservePercent: config.travelReservePercent };
}));
if (nodes.length !== 154 || vehicles.length !== 2) throw Error("Wrong fixture");
const lat = vehicles[0].startLatitude!, lon = vehicles[0].startLongitude!;
const coords = [...nodes.map(n=>({lat:n.latitude,lon:n.longitude})),
  ...vehicles.flatMap(v=>[{lat:v.startLatitude!,lon:v.startLongitude!},{lat:v.endLatitude!,lon:v.endLongitude!}])];
const nativeFetch = globalThis.fetch;
let offline = false, attempts = 0;
globalThis.fetch = async (url, options) => {
  if(offline) throw Error("Network forbidden after warmup");
  const u = new URL(String(url));
  if(u.origin !== "https://api.geoapify.com" || u.pathname !== "/v1/routematrix" || typeof options?.body !== "string") throw Error("Unexpected request");
  const key = createHash("sha256").update(options.body).digest("hex");
  const path = `${dir}/matrix-${key}.json`;
  if(existsSync(path)) return new Response(readFileSync(path,"utf8"),{status:200});
  if(++attempts>36) throw Error("Request budget exhausted");
  const res = await nativeFetch(url, {...options,redirect:"error"});
  if(!res.ok) throw Error("Matrix request failed");
  const text = await res.text(); JSON.parse(text); writeFileSync(path,text,{mode:0o600});
  return new Response(text,{status:200});
};
async function main() {
  const warm = performance.now();
  if(!await precomputeDistanceMatrix(coords,{timeoutMs:30000}) || !getDistanceMatrixCacheCoverage(coords).complete) throw Error("Incomplete matrix");
  offline=true;
  const warmupMs=performance.now()-warm;
  const constraints=new Map(vehicles.map(v=>[v.id,v.canonicalDriverConstraints!]));
  const objective={weights:{...DEFAULT_WEIGHTS,...planningWeights(config)},vehicleDistributionMode:
    selection === "use_all_selected_pairs" ? "balance" as const : "minimize" as const};
  let seed=252; Math.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  const began=performance.now();
  const candidate=await optimizeWithALNS(structuredClone(nodes),structuredClone(vehicles),lat,lon,start,{
    ...policyToALNSConfig(resolveOptimizationPolicy(nodes.length,12000)),
    ...objective,driverConstraints:[...constraints.values()],
  });
  const saved:any={routes:input.map((r:any)=>({vehicleId:r.vehicleId,
    nodes:r.resource.stops.slice().sort((a:any,b:any)=>a.sequenceOrder-b.sequenceOrder).map((s:any)=>nodes.find(n=>n.id===s.id)),
    totalWeight:0,totalVolume:0})),unassigned:[]};
  const optimizerMs=performance.now()-began;
  console.log(JSON.stringify({phase:"optimizer_complete",profile,optimizerMs}));
  const rows:any[]=[];
  for(const [label,result] of [["saved",saved],["candidate",candidate]] as const) {
    console.log(JSON.stringify({phase:"validate",profile,label}));
    await withRequiredRoadData(async()=>{
      reinsertUnassignedNodes(result,vehicles,constraints,lat,lon,start,objective);
      admitPrioritizedUnassignedNodes(result,vehicles,constraints,lat,lon,start,objective);
      if (selection === "use_all_selected_pairs") fillExplicitlySelectedEmptyRoutes(result,vehicles,constraints,lat,lon,start,objective);
      await recoverPlanningCoverage(result,{nodes,vehicles,constraints,depotLatitude:lat,depotLongitude:lon,start,...objective});
      const metrics=result.routes.map((r:any)=>{
        const v=vehicles.find(v=>v.id===r.vehicleId)!;
        const evalResult=evaluateRoute(r,v,lat,lon,start);
        const day=evaluateRouteWorkday(r.nodes,v,lat,lon,start);
        return {stops:r.nodes.length,feasible:evalResult.feasible && day.feasible,
          reason:day.reasonCode,km:evalResult.totalDistanceKm,
          drivingMin:day.summary.nonReturnDrivingMin+day.summary.returnMin,
          totalMin:day.summary.totalMin};
      });
      const ids=result.routes.flatMap((r:any)=>r.nodes.map((n:any)=>n.id));
      if(new Set(ids).size!==ids.length || ids.length+result.unassigned.length!==154)throw Error("Coverage");
      const allIds=[...ids,...result.unassigned.map((n:any)=>n.id)].sort();
      if(JSON.stringify(allIds)!==JSON.stringify(nodes.map(n=>n.id).sort()))throw Error("Stop identity mismatch");
      if(result.unassigned.length || !metrics.every((m:any)=>m.feasible) ||
        (selection === "use_all_selected_pairs" && (metrics.some((m:any)=>m.stops===0) ||
        new Set(result.routes.map((r:any)=>r.vehicleId)).size!==vehicles.length)))throw Error("Incomplete or infeasible plan");
      rows.push({label,metrics,unassigned:result.unassigned.length,cohesion:computeGeographicCohesionCost(result.routes)});
    });
  }
  const report={profile,selection,inputHash:hash,warmupMs,attempts,optimizerMs,wallMs:performance.now()-began,rows};
  writeFileSync(`${dir}/comparison-${profile}-${selection}.json`,JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.name,e.message);process.exit(1)});

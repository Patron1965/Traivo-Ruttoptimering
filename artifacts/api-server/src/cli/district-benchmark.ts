/**
 * Development-only full API/worker benchmark. No HTTP benchmark endpoint.
 * Synthetic schema is retained: deletion requires separate user approval.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { endianness } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { db, pool, organizationsTable as organizations, districtPlansTable as plans,
  districtZonesTable as zones, districtImportsTable as imports,
  districtPointsTable as points, districtJobsTable as jobs } from "@workspace/db";
import { bulkCapacity, type DistrictBulkSnapshot } from "../services/district-bulk-solver";
import type { DistrictCoordinate, DistrictInput, DistrictMeasurements } from "../services/district-solver";

const root=resolve(import.meta.dirname,"../../../..");
const directory=resolve(root,"generated-artifacts/district-benchmark");
const tables=["organizations","organization_routing_providers","district_plans","district_zones",
  "district_imports","district_points","district_intakes","district_jobs","district_exports"] as const;
const hashFile=async(path:string)=>{
  const hash=createHash("sha256");
  for await(const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
type RecordOfRun={
  label:string; jobId:string; createdAt:string; claimedAt?:string; queueMilliseconds?:number;
  originSchema?:string; originProcessStartedAt?:string;
  totalMilliseconds?:number; activeMilliseconds?:number; measurements?:DistrictMeasurements;
  status?:string; error?:string|null; distanceMeters?:number; pointCount?:number; geometryPoints?:number;
  baselineRssBytes:number; sampledPeakRssBytes:number; highWaterRssBytes:number;
  phaseRssBytes:Record<string,number>; cancellationRequestedAt?:string;
  cancellationMilliseconds?:number; matrixSha256?:string;
};

async function main() {
  assert.equal(process.env.NODE_ENV,"development","Explicit development required");
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,"1","Published runtime forbidden");
  assert.equal(endianness(),"LE","Binary baseline requires little endian");
  assert.match(process.env.DISTRICT_BENCHMARK_DB_FINGERPRINT??"",/^[a-f0-9]{32}$/,
    "Verify development target independently first");
  // No connection string or credential is ever printed or written to evidence.
  const target=await pool.query(`SELECT md5(current_database() || ':' ||
    coalesce(inet_server_addr()::text,'local') || ':' || current_user) AS fingerprint`);
  assert.equal(target.rows[0].fingerprint,process.env.DISTRICT_BENCHMARK_DB_FINGERPRINT,
    "Database target differs from independently verified development database");
  assert.equal(process.env.DISTRICT_LOCAL_OSRM_BASE_URL,"http://127.0.0.1:5001");
  assert.equal(process.env.DISTRICT_OSRM_BASE_URL,undefined,"Remote pilot must not override native benchmark");
  assert.equal(process.env.DISTRICT_BULK_PROVIDERS_JSON,undefined,"Use the existing native attestation only");
  const manifest=JSON.parse(await readFile(resolve(root,".cache/district-road/bulk-provider-identity.json"),"utf8"));
  assert.equal(manifest.bulkApproved,true);assert.equal(manifest.profile,"car");assert.equal(manifest.algorithm,"CH");
  const inputFile=resolve(directory,"input.json");
  const source=JSON.parse(await readFile(inputFile,"utf8")) as {
    start:DistrictCoordinate; points:DistrictInput["points"]; positionsSha256:string;
    sourceSha256:string; bbox:number[]; selection:string; candidateCount:number;
    preflightDatasetIdentity:string;connectivityCandidatesExamined:number;connectivityRejected:number;
  };
  assert.equal(source.preflightDatasetIdentity,manifest.datasetIdentity,"Input was checked against a different road dataset");
  assert.ok(source.points.length>750);
  assert.equal(new Set(source.points.map(p=>`${p.latitude},${p.longitude}`)).size,source.points.length);
  assert.ok(bulkCapacity(source.points,source.start).allowed);
  assert.equal(source.positionsSha256,createHash("sha256").update(JSON.stringify(
    [source.start,...source.points.map(({latitude,longitude})=>({latitude,longitude}))])).digest("hex"));
  // Explicit recovery of already complete measurements, never silent reuse.
  // Validate exact input, road dataset and binary baseline before any new writes.
  const reuse=process.argv.includes("--reuse-first-results");
  const prior=reuse ? JSON.parse(await readFile(resolve(directory,"first-results.json"),"utf8")) : undefined;
  const inputSha256=await hashFile(inputFile);
  const firstLabels=["cold","warm","small-solo"];
  const importedRuns:RecordOfRun[]=prior ? firstLabels.map(label=>{
    assert.equal(prior.roadDataset,manifest.datasetIdentity);
    assert.equal(prior.inputSha256,inputSha256);
    const record=prior.runs.find((r:RecordOfRun)=>r.label===label);
    assert.equal(record?.status,"completed",`Cannot reuse unfinished ${label}`);
    return {...record,originSchema:prior.schema,originProcessStartedAt:prior.startedAt};
  }) : [];
  if(prior) {
    assert.equal(prior.positionsSha256,source.positionsSha256);
    assert.equal(importedRuns[0].matrixSha256,await hashFile(resolve(directory,"distances.f64le")));
  }
  await mkdir(directory,{recursive:true});
  const schema=`district_bench_${randomUUID().replaceAll("-","")}`;
  // A single transaction avoids partial schema creation; no public data copied.
  const setup=await pool.connect();
  try {
    await setup.query("BEGIN");
    await setup.query(`CREATE SCHEMA "${schema}"`);
    for(const table of tables)
      await setup.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    await setup.query("COMMIT");
  } catch(error) {await setup.query("ROLLBACK");throw error;}
  finally {setup.release();}
  // Reset all connections BEFORE importing the full API application.
  // pool has only the setup connection, so set its session too.
  pool.options.options=`-c search_path=${schema}`;
  const session=await pool.connect();
  await session.query(`SET search_path TO "${schema}"`);session.release();
  const check=await pool.query("SHOW search_path");assert.equal(check.rows[0].search_path,schema);
  await writeFile(resolve(directory,"schema.json"),JSON.stringify({schema,retained:true,contains:"synthetic public road objects only"})+"\n");
  const {default:app}=await import("../app");
  const {tickDistrictWorker}=await import("../services/district-worker");
  const {resolveOrganizationRoutingProvider}=await import("../services/routing-provider-config");
  // API app runs in this measured process, but no public port or user request is exposed.
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const runs:RecordOfRun[]=[...importedRuns];
  const clocks=new Map<string,{created:number;claimed?:number;cancel?:number}>();
  let active:RecordOfRun|undefined,phase="idle";
  const sample=()=>{
    const rss=process.memoryUsage().rss;
    if(active) {
      active.sampledPeakRssBytes=Math.max(active.sampledPeakRssBytes,rss);
      active.phaseRssBytes[phase]=Math.max(active.phaseRssBytes[phase]??0,rss);
    }
  };
  const sampling=setInterval(sample,20);
  const started=performance.now();
  const report={
    version:1,startedAt:new Date().toISOString(),schema,
    runtime:{node:process.version,platform:process.platform,arch:process.arch},
    roadDataset:manifest.datasetIdentity,inputSha256,
    priorSession:prior ? {schema:prior.schema,startedAt:prior.startedAt,
      reusedLabels:firstLabels,report:"first-results.json",overallMilliseconds:prior.overallMilliseconds} : undefined,
    positionsSha256:source.positionsSha256,sourceSha256:source.sourceSha256,
    bbox:source.bbox,selection:source.selection,candidateCount:source.candidateCount,
    connectivityCandidatesExamined:source.connectivityCandidatesExamined,
    connectivityRejected:source.connectivityRejected,
    capacity:bulkCapacity(source.points,source.start),runs,
    coldDefinition:"First matrix in a fresh API process; OSRM already loaded. No OS page-cache flush.",
    warmDefinition:"Repeat same directed table requests on same running native dataset. API bulk matrix cache remains disabled.",
    memoryDefinition:"Full API application and real worker in isolated process; 20ms RSS samples plus Linux process-lifetime ru_maxrss. OSRM/Python memory excluded.",
    overallMilliseconds:0,apiHighWaterRssBytes:0,baseline:undefined as unknown,
  };
  const persist=async()=>{sample();report.overallMilliseconds=performance.now()-started;
    report.apiHighWaterRssBytes=Math.max(process.resourceUsage().maxRSS*1024,...importedRuns.map(r=>r.highWaterRssBytes));
    await writeFile(resolve(directory,"report.json"),JSON.stringify(report,null,2)+"\n");};
  type Owner={planId:string;zoneId:string;input:DistrictInput;binding:{serverId:string;configurationVersion:string}};
  const owner=async(label:string,count:number):Promise<Owner>=>{
    const [org]=await db.insert(organizations).values({name:`Synthetic benchmark ${label}`,
      email:`${randomUUID()}@invalid.local`}).returning();
    const [plan]=await db.insert(plans).values({organizationId:org.id,name:`Public road benchmark ${label}`}).returning();
    const [zone]=await db.insert(zones).values({planId:plan.id,name:"Synthetic",color:"#112233"}).returning();
    const [imported]=await db.insert(imports).values({planId:plan.id,sourceKey:"benchmark",
      payloadHash:source.positionsSha256,total:count,valid:count,rejected:0,revision:0}).returning();
    const members:DistrictInput["points"]=[];
    for(let offset=0;offset<count;offset+=200) {
      const created=await db.insert(points).values(source.points.slice(offset,Math.min(count,offset+200)).map((p,i)=>({
        planId:plan.id,zoneId:zone.id,importId:imported.id,sourceRowNumber:offset+i+1,
        objectNumber:p.id,address:"Public mapped road node, not a customer address",
        latitude:p.latitude,longitude:p.longitude,original:{Object:p.id}}))).returning();
      members.push(...created.map(p=>({id:p.id,latitude:p.latitude,longitude:p.longitude})));
    }
    const selected=await resolveOrganizationRoutingProvider(org.id);
    return {planId:plan.id,zoneId:zone.id,input:{points:members,start:source.start,mode:"open",serviceMinutes:0},
      binding:selected.binding};
  };
  const enqueue=async(owner:Owner,label:string,bulk=true)=>{
    const snapshot:DistrictBulkSnapshot={engine:"bulk-road-v1",scope:"plan",planRevision:0,
      intakeRevision:null,datasetIdentity:manifest.datasetIdentity,sourceHash:source.positionsSha256,exceptions:[],
      sourceRows:owner.input.points.map((p,i)=>({id:p.id,pointId:p.id,sourceRowNumber:i+1,
        objectNumber:source.points[i].id,original:{Object:source.points[i].id},status:"ready",reason:""}))};
    const time=performance.now();
    const [job]=await db.insert(jobs).values({planId:owner.planId,zoneId:owner.zoneId,revision:0,
      input:{...owner.input,routingProvider:{binding:owner.binding},...(bulk?{bulk:snapshot}:{})} as typeof jobs.$inferInsert["input"]}).returning();
    const rss=process.memoryUsage().rss;
    const record:RecordOfRun={label,jobId:job.id,createdAt:job.createdAt.toISOString(),
      baselineRssBytes:rss,sampledPeakRssBytes:rss,highWaterRssBytes:0,phaseRssBytes:{}};
    runs.push(record);clocks.set(job.id,{created:time});
    return record;
  };
  let cancelAtPhase:string|undefined,cancelTask:Promise<void>|undefined;
  const diagnostics={
    onClaim:(id:string)=>{
      active=runs.find(r=>r.jobId===id)!;phase="claim";
      process.stdout.write(JSON.stringify({benchmark:active.label,phase})+"\n");
      const clock=clocks.get(id)!;clock.claimed=performance.now();
      active.claimedAt=new Date().toISOString();active.queueMilliseconds=clock.claimed-clock.created;sample();
    },
    onMeasurements:(id:string,m:DistrictMeasurements)=>{runs.find(r=>r.jobId===id)!.measurements=m;},
    bulk:(id:string)=>({
      onPhase:(next:"matrix"|"solver"|"geometry")=>{
        phase=next;sample();
        process.stdout.write(JSON.stringify({benchmark:runs.find(r=>r.jobId===id)!.label,phase})+"\n");
        if(next===cancelAtPhase) {
          cancelAtPhase=undefined;
          cancelTask=(async()=>{
            if(next==="matrix") await delay(500); // real requests must be in flight
            const record=runs.find(r=>r.jobId===id)!;
            clocks.get(id)!.cancel=performance.now();record.cancellationRequestedAt=new Date().toISOString();
            await db.update(jobs).set({status:"cancelled",updatedAt:new Date()}).where(eq(jobs.id,id));
          })();
        }
      },
      onMatrix:async(matrix: {distance:Float64Array;width:number})=>{
        if(active?.label!=="cold") return;
        const path=resolve(directory,"distances.f64le");
        await writeFile(path,new Uint8Array(matrix.distance.buffer,matrix.distance.byteOffset,matrix.distance.byteLength));
        active.matrixSha256=await hashFile(path);
      },
    }),
  };
  const work=async()=>{
    await tickDistrictWorker(diagnostics);
    if(!active) return;
    await cancelTask;cancelTask=undefined;
    const [row]=await db.select().from(jobs).where(eq(jobs.id,active.jobId));
    const clock=clocks.get(active.jobId)!;
    active.status=row.status;active.error=row.error;
    active.totalMilliseconds=performance.now()-clock.created;
    active.activeMilliseconds=performance.now()-clock.claimed!;
    active.highWaterRssBytes=process.resourceUsage().maxRSS*1024;sample();
    if(clock.cancel) {
      active.cancellationMilliseconds=performance.now()-clock.cancel;
      assert.equal(row.result,null,"Cancelled job must not publish a partial result");
      assert.equal(row.status,"cancelled");
    } else {
      assert.equal(row.status,"completed",row.error??"Job failed");
      assert.ok(row.result);
      active.distanceMeters=row.result.distanceMeters;active.pointCount=row.result.orderedPointIds.length;
      active.geometryPoints=row.result.geometry.length;
      assert.equal(active.pointCount,row.input.points.length);
      assert.equal(new Set(row.result.orderedPointIds).size,active.pointCount);
    }
    active=undefined;phase="idle";await persist();
  };
  try {
    const a=await owner("A",source.points.length),b=await owner("B",source.points.length),small=await owner("C",24);
    if(!prior) {
      await enqueue(a,"cold");await persist();await work();
      await enqueue(a,"warm");await work();
      await enqueue(small,"small-solo",false);await work();
    }
    const loaded=await enqueue(a,"concurrent-A");
    const waiting=await enqueue(b,"concurrent-B");
    const smallWaiting=await enqueue(small,"small-queued",false);
    const cancelledQueued=await enqueue(b,"cancel-queued");
    const running=work();
    // Repeated real scheduler ticks while A owns the bulk matrix.
    // Fairness may choose B first because A has already received solo work.
    // Observe the actual claim rather than prescribing a tenant's priority.
    let runningError:unknown;
    void running.catch(error=>{runningError=error;});
    const claimDeadline=performance.now()+10000;
    while(!active || ![loaded.jobId,waiting.jobId].includes(active.jobId)) {
      if(runningError) throw runningError;
      assert.ok(performance.now()<claimDeadline,"No competing bulk job was claimed");
      await delay(10);
    }
    await tickDistrictWorker(diagnostics);
    for(const record of [loaded,waiting,smallWaiting,cancelledQueued].filter(r=>r.jobId!==active!.jobId)) {
      const [row]=await db.select().from(jobs).where(eq(jobs.id,record.jobId));
      assert.equal(row.status,"queued","Same-process bulk gate must retain competing jobs");
    }
    const cancelStarted=performance.now();
    await db.update(jobs).set({status:"cancelled",updatedAt:new Date()}).where(eq(jobs.id,cancelledQueued.jobId));
    const [cancelled]=await db.select().from(jobs).where(eq(jobs.id,cancelledQueued.jobId));
    assert.equal(cancelled.attempts,0);assert.equal(cancelled.result,null);
    cancelledQueued.status=cancelled.status;cancelledQueued.cancellationMilliseconds=performance.now()-cancelStarted;
    await running;
    await work();await work(); // actual fairness chooses B/C, not a harness-defined queue
    assert.ok(waiting.queueMilliseconds!>0 && smallWaiting.queueMilliseconds!>0);
    await enqueue(a,"cancel-matrix");cancelAtPhase="matrix";await work();
    await enqueue(a,"cancel-solver");cancelAtPhase="solver";await work();
    // Baseline runs AFTER all API memory measurements; its process is excluded.
    const cold=runs.find(r=>r.label==="cold")!;
    assert.equal(runs.find(r=>r.label==="warm")!.distanceMeters,cold.distanceMeters);
    const baselineFile=resolve(directory,"gtb.json");
    const python=spawn("python",[resolve(root,"scripts/gtb_road_order.py"),"--matrix",
      resolve(directory,"distances.f64le"),"--width",String(source.points.length+1),"--output",baselineFile],
      {stdio:["ignore","inherit","inherit"]});
    const [code]=await once(python,"exit");assert.equal(code,0,"GTB baseline failed");
    const baseline=JSON.parse(await readFile(baselineFile,"utf8"));
    assert.equal(baseline.matrixSha256,cold.matrixSha256);
    assert.equal(baseline.order.length,source.points.length);
    report.baseline={...baseline,order:undefined,
      bulkDistanceMeters:cold.distanceMeters,
      differencePercent:100*(cold.distanceMeters!-baseline.distanceMeters)/baseline.distanceMeters};
    await persist();
  } finally {
    clearInterval(sampling);await persist();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await pool.end();
  }
}

main().catch(error=>{
  // No raw database/config error: these may contain credentials or connection details.
  process.stderr.write(`District benchmark failed (${error instanceof assert.AssertionError ? error.message : "see retained report and job status"}).\n`);
  process.exitCode=1;
});

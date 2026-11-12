import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { and,eq } from "drizzle-orm";
import { db,pool,organizationsTable as organizations,districtPlansTable as plans,districtZonesTable as zones,
  districtImportsTable as imports,districtPointsTable as points,districtIntakesTable as intakes,
  districtJobsTable as jobs,districtExportsTable as exportsTable } from "@workspace/db";
import router from "./district";
import { authorizeWrite,type AuthUser } from "../middleware/auth";
import { tickDistrictWorker } from "../services/district-worker";
import { claimDistrictJob,finishDistrictJob,isDistrictJobLive } from "../services/district-capacity";

test("bulk HTTP/worker: tenant isolation, preserved source rows, immutable dataset, full/partial exports, failures and cancellation",async()=>{
  assert.equal(process.env.NODE_ENV,"test");
  const schema=`district_bulk_${randomUUID().replaceAll("-","")}`;
  const original={url:process.env.OSRM_BASE_URL,approval:process.env.DISTRICT_BULK_PROVIDERS_JSON};
  const tables=["organizations","organization_routing_providers","district_plans","district_zones","district_imports","district_points","district_intakes","district_jobs","district_exports"];
  const client=await pool.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  for(const table of tables) await client.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
  pool.options.options=`-c search_path=${schema}`;
  await client.query(`SET search_path TO "${schema}"`);
  client.release();
  let dataset="approved-synthetic-v1";
  let gate:Promise<void>|undefined,release:(()=>void)|undefined;
  let received:()=>void=()=>{};
  let providerCalls=0;
  const provider=createServer(async(req,res)=>{
    const url=new URL(req.url!,"http://local");
    const match=url.pathname.match(/\/(table|route)\/v1\/driving\/(.+)$/)!;
    providerCalls++;
    received();
    if(gate) await gate;
    const coordinates=match[2].split(";").map(pair=>pair.split(",").map(Number));
    let body:unknown;
    if(match[1]==="table") {
      const sources=(url.searchParams.get("sources")??"").split(";").map(Number);
      const destinations=(url.searchParams.get("destinations")??"").split(";").map(Number);
      const values=sources.map(a=>destinations.map(b=>Math.abs(coordinates[a][1]-coordinates[b][1])*100000+Math.abs(coordinates[a][0]-coordinates[b][0])*100000));
      body={code:"Ok",distances:values,durations:values.map(r=>r.map(d=>d/10)),
        sources:sources.map(i=>({location:coordinates[i]})),destinations:destinations.map(i=>({location:coordinates[i]}))};
    } else body={code:"Ok",routes:[{geometry:{coordinates}}],waypoints:coordinates.map(location=>({location}))};
    res.setHeader("x-osrm-dataset-id",dataset);
    res.setHeader("content-type","application/json");res.end(JSON.stringify(body));
  }).listen(0);
  await once(provider,"listening");
  process.env.OSRM_BASE_URL=`http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.DISTRICT_BULK_PROVIDERS_JSON=JSON.stringify([{serverId:"shared",datasetIdentity:dataset,maxTableCoordinates:500}]);
  const orgA=randomUUID(),orgB=randomUUID(),actor=randomUUID();
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{
    req.user={id:actor,name:"Synthetic",email:"synthetic@invalid.local",role:(req.get("x-role")??"dispatcher") as AuthUser["role"],
      organizationId:req.get("x-org")==="B"?orgB:orgA,driverProfileId:null};
    next();
  });
  app.use(authorizeWrite(),router);
  const server=app.listen(0);await once(server,"listening");
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send=async(path:string,method="GET",body?:unknown,headers:Record<string,string>={})=>{
    const response=await fetch(base+path,{method,headers:{"content-type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text();
    let data:any;try {data=JSON.parse(text);}catch {data=text;}
    return {status:response.status,data,text};
  };
  let worker:Promise<void>|undefined;
  try {
    await db.insert(organizations).values([{id:orgA,name:"Synthetic A",email:orgA+"@invalid.local"},{id:orgB,name:"Synthetic B",email:orgB+"@invalid.local"}]);
    const [plan]=await db.insert(plans).values({organizationId:orgA,name:"Synthetic bulk"}).returning();
    const [zone]=await db.insert(zones).values({planId:plan.id,name:"Anchor zone",color:"#112233"}).returning();
    const [imported]=await db.insert(imports).values({planId:plan.id,sourceKey:"synthetic",payloadHash:"hash",total:4,valid:3,rejected:1,revision:0}).returning();
    const source=await db.insert(points).values([0,1,2].map(i=>({planId:plan.id,importId:imported.id,zoneId:i===2?null:zone.id,
      sourceRowNumber:i+1,objectNumber:`000${i+1}`,address:"Synthetic",latitude:i===1?57.701:57.701+i/1000,longitude:11.8,
      original:{Object:`000${i+1}`,CustomerOnly:`A-source-${i+1}`}}))).returning();
    await db.insert(intakes).values({planId:plan.id,sourceKey:"synthetic",payloadHash:"hash",rows:[
      ...source.map(p=>({sourceRowNumber:p.sourceRowNumber,objectNumber:p.objectNumber,address:p.address,original:p.original,
        status:"ready" as const,reason:"",pointId:p.id,latitude:p.latitude,longitude:p.longitude})),
      {sourceRowNumber:4,objectNumber:"0004",address:"Unknown",original:{Object:"0004",OnlyUnresolved:"preserve me"},status:"unresolved",reason:"Position saknas"},
    ]});
    const root=`/district-plans/${plan.id}`;
    const prefix=`${root}/zones/${zone.id}`;
    const body={expectedRevision:0,mode:"open",start:{latitude:57.7,longitude:11.8},bulkScope:"plan",serviceMinutes:0};
    const before=JSON.stringify(await db.select().from(points).where(eq(points.planId,plan.id)));
    const count=providerCalls;
    assert.equal((await send(prefix+"/bulk-preview","POST",body,{"x-org":"B"})).status,404);
    assert.equal((await send(prefix+"/bulk-preview","POST",body,{"x-role":"viewer"})).status,403);
    assert.equal(providerCalls,count);
    assert.equal((await send(prefix+"/bulk-preview","POST",{...body,start:{pointId:source[0].id}})).status,422);
    assert.equal((await send(prefix+"/jobs","POST",body)).status,409,"position check proof is mandatory");
    const preview=await send(prefix+"/bulk-preview","POST",body);
    assert.equal(preview.status,200,preview.text);
    assert.equal(preview.data.ready,true);
    assert.deepEqual([preview.data.sourceCount,preview.data.positionedCount,preview.data.unresolvedCount],[4,3,1]);
    const oneException={pointId:source[0].id,maxSnapMeters:500,reason:"Manuellt granskad position"};
    assert.equal((await send(prefix+"/bulk-preview","POST",{...body,distanceExceptions:[oneException]})).status,422,
      "co-located source objects require individual explicit approval");
    const explicit=await send(prefix+"/bulk-preview","POST",{...body,distanceExceptions:[
      oneException,{...oneException,pointId:source[1].id},
    ]});
    assert.equal(explicit.status,200,explicit.text);
    assert.equal(explicit.data.ready,true);
    assert.ok(explicit.data.warnings.some((w:string)=>w.includes(source[0].id) && w.includes("500")));
    assert.ok(explicit.data.warnings.some((w:string)=>w.includes(source[1].id) && w.includes("Manuellt")));
    assert.equal((await send(prefix+"/jobs","POST",{...body,bulkPreviewHash:explicit.data.previewHash})).status,409,
      "explicit exception approvals cannot be omitted from the checked request");
    const runBody={...body,bulkPreviewHash:preview.data.previewHash};
    const started=await send(prefix+"/jobs","POST",runBody);
    assert.equal(started.status,201,started.text);
    assert.equal(started.data.datasetIdentity,dataset);
    await tickDistrictWorker();
    const [completed]=await db.select().from(jobs).where(eq(jobs.id,started.data.id));
    assert.equal(completed.status,"completed",completed.error??"");
    assert.equal(completed.result!.orderedPointIds.length,3);
    assert.equal(completed.input.bulk!.sourceRows.length,4);
    assert.notDeepEqual(completed.result!.geometry.at(-1),body.start);
    assert.equal(JSON.stringify(await db.select().from(points).where(eq(points.planId,plan.id))),before);
    assert.equal((await send(`${root}/jobs/${completed.id}`,"GET",undefined,{"x-org":"B"})).status,404);
    assert.equal((await send(`${root}/jobs/${completed.id}/exports`,"POST",{pointIds:completed.result!.orderedPointIds,columns:["Object"],confirmReexport:true},{"x-org":"B"})).status,404);
    const extracted=await send(`${root}/jobs/${completed.id}/exports`,"POST",{pointIds:completed.result!.orderedPointIds,columns:[],confirmReexport:true});
    assert.equal(extracted.status,201,extracted.text);
    const [saved]=await db.select().from(exportsTable).where(eq(exportsTable.id,extracted.data.export.id));
    assert.equal(saved.rows.length,4);
    assert.equal(saved.rows[3].routeOrder,0);
    assert.equal(saved.rows[3].original.OnlyUnresolved,"preserve me");
    assert.equal(saved.rows[3].sourceStatus,"unresolved");
    assert.ok(saved.columns.includes("OnlyUnresolved"));
    const csv=await send(`${root}/exports/${saved.id}/file?format=csv`);
    assert.equal(csv.status,200,csv.text);
    assert.ok(csv.text.includes("0004") && csv.text.includes("Position saknas") && csv.text.includes(dataset));
    assert.equal((await send(`${root}/exports/${saved.id}/file?format=csv`,"GET",undefined,{"x-org":"B"})).status,404);
    assert.equal((await send(`${root}/exports/${saved.id}/file?format=csv`,"GET",undefined,{"x-role":"viewer"})).status,403);
    const partial=await send(`${root}/jobs/${completed.id}/exports`,"POST",{pointIds:[completed.result!.orderedPointIds[0]],columns:["Object"],confirmReexport:true});
    assert.equal(partial.status,201,partial.text);
    const [part]=await db.select().from(exportsTable).where(eq(exportsTable.id,partial.data.export.id));
    assert.equal(part.rows.length,1);
    assert.deepEqual(part.columns,["Object"]);
    // Same accepted input, but a different responding dataset: fail, no fallback.
    const next=await send(prefix+"/jobs","POST",runBody);
    assert.equal(next.status,201,next.text);
    dataset="unapproved-replacement";
    await tickDistrictWorker();
    const [failed]=await db.select().from(jobs).where(eq(jobs.id,next.data.id));
    assert.equal(failed.status,"failed");
    assert.equal(failed.result,null);
    dataset="approved-synthetic-v1";
    const cancellation=await send(prefix+"/jobs","POST",runBody);
    assert.equal(cancellation.status,201,cancellation.text);
    gate=new Promise(resolve=>{release=resolve;});
    const observed=new Promise<void>(resolve=>{received=resolve;});
    worker=tickDistrictWorker();
    await observed;
    assert.equal((await send(`${root}/jobs/${cancellation.data.id}/cancel`,"POST",{},{"x-org":"B"})).status,404);
    assert.equal((await send(`${root}/jobs/${cancellation.data.id}/cancel`,"POST",{})).status,200);
    release!();gate=undefined;
    await worker;
    const [cancelled]=await db.select().from(jobs).where(eq(jobs.id,cancellation.data.id));
    assert.equal(cancelled.status,"cancelled");
    assert.equal(cancelled.result,null);
    // Whole-plan membership and source snapshots are invalidated on edits, and
    // already saved files remain byte-identical.
    const finalJob=await send(prefix+"/jobs","POST",runBody);
    assert.equal(finalJob.status,201,finalJob.text);
    const claim=await claimDistrictJob();
    assert.equal(claim?.id,finalJob.data.id);
    await db.update(plans).set({revision:1}).where(eq(plans.id,plan.id));
    assert.equal(await isDistrictJobLive(claim!),false);
    assert.equal(await finishDistrictJob(claim!,completed.result!),false);
    assert.equal((await send(prefix+"/jobs","POST",runBody)).status,409);
    assert.equal((await send(`${root}/jobs/${completed.id}/exports`,"POST",{pointIds:completed.result!.orderedPointIds,columns:[],confirmReexport:true})).status,409);
    assert.equal((await send(`${root}/exports/${saved.id}/file?format=csv`)).text,csv.text);
    // A remote/unapproved provider must fail before any provider request.
    process.env.DISTRICT_BULK_PROVIDERS_JSON="[]";
    const currentCalls=providerCalls;
    assert.equal((await send(prefix+"/bulk-preview","POST",body)).status,503);
    assert.equal(providerCalls,currentCalls);
    assert.equal((await db.select().from(plans).where(eq(plans.organizationId,orgB))).length,0);
    const columns=(await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1",[schema])).rows.map(r=>r.table_name);
    assert.ok(!columns.includes("stops") && !columns.includes("routes"),"isolated domain has no operational tables");
  } finally {
    release?.();
    await worker;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await new Promise<void>(resolve=>provider.close(()=>resolve()));
    if(original.url===undefined) delete process.env.OSRM_BASE_URL;else process.env.OSRM_BASE_URL=original.url;
    if(original.approval===undefined) delete process.env.DISTRICT_BULK_PROVIDERS_JSON;else process.env.DISTRICT_BULK_PROVIDERS_JSON=original.approval;
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});

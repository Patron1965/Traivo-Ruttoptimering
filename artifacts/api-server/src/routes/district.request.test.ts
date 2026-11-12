import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import type {AddressInfo} from "node:net";
import express from "express";
import {db, organizationsTable, districtPlansTable, districtZonesTable, districtPointsTable, districtImportsTable, districtJobsTable, districtExportsTable} from "@workspace/db";
import {eq,inArray} from "drizzle-orm";
import type {AuthUser} from "../middleware/auth";
import {authorizeWrite} from "../middleware/auth";
import districtRouter from "./district";
import {claimNextDistrictJob} from "../services/district-worker";

test("district HTTP: isolated plans, reviewed import, idempotency, exclusive transfers, revisions, cancellation, snapshots and soft delete",async()=>{
  const originalOsrm=process.env.OSRM_BASE_URL;
  process.env.OSRM_BASE_URL="http://127.0.0.1:9999";
  const orgA=randomUUID(),orgB=randomUUID(),actor=randomUUID();
  await db.insert(organizationsTable).values([{id:orgA,name:"District A",email:orgA+"@test.local"},{id:orgB,name:"District B",email:orgB+"@test.local"}]);
  const app=express(); app.use(express.json({limit:"3mb"}));
  app.use((req,_res,next)=>{
    const role=(req.get("x-role")||"dispatcher") as AuthUser["role"];
    req.user={id:actor,name:"Planner",email:"planner@test.local",role,organizationId:req.get("x-org")==="B"?orgB:orgA,driverProfileId:null};
    next();
  });
  app.use(authorizeWrite(),districtRouter);
  app.use((e:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(500).json({error:e.message});});
  const server=app.listen(0);await once(server,"listening");
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send=async(path:string,method="GET",body?:unknown,headers:Record<string,string>={})=>{
    const response=await fetch(base+path,{method,headers:{"content-type":"application/json",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json().catch(()=>null) as any};
  };
  let planId:string|undefined;
  try {
    const created=await send("/district-plans","POST",{name:"Göteborg"}); assert.equal(created.status,201,JSON.stringify(created.body));
    planId=created.body.id;
    const root=`/district-plans/${planId}`;
    assert.equal((await send(root,"GET",undefined,{"x-org":"B"})).status,404);
    assert.equal((await send("/district-plans","POST",{name:"Forbidden"},{"x-role":"viewer"})).status,403);
    assert.equal((await send("/district-plans","GET",undefined,{"x-role":"driver"})).status,403);
    const payload={sourceKey:"source-001",mapping:{objectNumber:"Obj",address:"Address",latitude:"Lat",longitude:"Lon"},rows:[
      {Obj:"0001",Address:"A",Lat:"57.7",Lon:"11.9",Extra:"=SUM(1)"},
      {Obj:"0002",Address:"B",Lat:"57.71",Lon:"11.91",Extra:"B"},
      {Obj:"0003",Address:"C",Lat:"57.72",Lon:"11.92",Extra:"C"},
      {Obj:"0004",Address:"D",Lat:"200",Lon:"12",Extra:"D"},
    ]};
    const preview=await send(root+"/imports/preview","POST",payload);
    assert.deepEqual([preview.body.total,preview.body.valid,preview.body.rejected],[4,3,1]);
    assert.equal((await send(root+"/imports","POST",{...payload,confirmValidOnly:false})).status,422);
    const imported=await send(root+"/imports","POST",{...payload,confirmValidOnly:true});
    assert.equal(imported.status,201,JSON.stringify(imported.body));
    assert.equal((await send(root+"/imports","POST",{...payload,confirmValidOnly:true})).body.id,imported.body.id);
    assert.equal((await send(root+"/imports","POST",{...payload,rows:[...payload.rows.slice(0,3)],confirmValidOnly:true})).status,409);
    assert.equal((await send(root+"/imports","POST",{...payload,sourceKey:"different-file",confirmValidOnly:true})).status,409);
    const list=await send(root+"/points?limit=2");
    assert.equal(list.body.total,3);assert.equal(list.body.points.length,2);
    const all=(await send(root+"/points?limit=6000")).body.points;
    assert.equal(all[0].objectNumber,"0001");assert.equal(all[0].original.Extra,"=SUM(1)");
    assert.deepEqual((await send(root+"/points?limit=1","GET",undefined,{"x-role":"viewer"})).body.points[0].original,{});
    const zonal=(name:string,pointIds:string[],transfers:string[]=[])=>({name,color:"#abcdef",pointIds,transfers});
    const zone1=await send(root+"/zones","POST",zonal("West",[all[0].id,all[1].id]));
    assert.equal(zone1.status,201,JSON.stringify(zone1.body));
    const zone2=await send(root+"/zones","POST",zonal("East",[all[2].id]));
    assert.equal(zone2.status,201);
    assert.equal((await send(root+"/zones/"+zone2.body.id,"PUT",{...zonal("East",[all[0].id,all[2].id]),expectedRevision:0})).status,409);
    const moved=await send(root+"/zones/"+zone2.body.id,"PUT",{...zonal("East",[all[0].id,all[2].id],[all[0].id]),expectedRevision:0});
    assert.equal(moved.status,200,JSON.stringify(moved.body));
    assert.equal((await send(root+"/zones/"+zone2.body.id,"PUT",{...zonal("East",[]),expectedRevision:0})).status,409);
    const job=await send(root+"/zones/"+zone2.body.id+"/jobs","POST",{expectedRevision:moved.body.revision,mode:"loop",start:{pointId:all[0].id},routingProvider:{binding:{serverId:"attacker-selected",configurationVersion:"fake"}}});
    assert.equal(job.status,201,JSON.stringify(job.body));
    const [boundJob]=await db.select().from(districtJobsTable).where(eq(districtJobsTable.id,job.body.id));
    assert.equal((boundJob.input as typeof boundJob.input & {routingProvider:{binding:{serverId:string;configurationVersion:string}}}).routingProvider.binding.serverId,"shared");
    assert.notEqual((boundJob.input as typeof boundJob.input & {routingProvider:{binding:{serverId:string;configurationVersion:string}}}).routingProvider.binding.configurationVersion,"fake");
    assert.equal((await send(root+"/jobs/"+job.body.id+"/cancel","POST")).status,200);
    assert.equal((await send(root+"/jobs/"+job.body.id)).body.job.status,"cancelled");
    const completed=await send(root+"/zones/"+zone2.body.id+"/jobs","POST",{expectedRevision:moved.body.revision,mode:"open",start:{pointId:all[0].id}});
    assert.equal(completed.status,201);
    await db.update(districtJobsTable).set({status:"completed",progress:100,result:{orderedPointIds:[all[0].id,all[2].id],distanceMeters:100,driveSeconds:50,geometry:[{latitude:57.7,longitude:11.9}],warnings:[]}}).where(eq(districtJobsTable.id,completed.body.id));
    const detail=await send(root+"/jobs/"+completed.body.id);
    assert.equal(detail.body.job.mode,"open");
    assert.equal(detail.body.job.start.pointId,all[0].id);
    assert.deepEqual(detail.body.result.orderedPointIds,[all[0].id,all[2].id]);
    const exported=await send(root+"/jobs/"+completed.body.id+"/exports","POST",{pointIds:[all[0].id,all[2].id],columns:["Extra"],confirmReexport:false});
    assert.equal(exported.status,201,JSON.stringify(exported.body));
    const file=await fetch(base+root+"/exports/"+exported.body.export.id+"/file?format=csv");
    const csv=await file.text();
    assert.equal(file.status,200);assert.match(csv,/'=SUM\(1\)/);assert.match(csv,/0001/);
    assert.equal((await send(root+"/exports/"+exported.body.export.id+"/file?format=csv","GET",undefined,{"x-role":"viewer"})).status,403);
    assert.equal((await send(root+"/jobs/"+completed.body.id+"/exports","POST",{pointIds:[all[0].id],columns:["Extra"],confirmReexport:false})).status,409);
    assert.equal((await send(root+"/jobs/"+completed.body.id+"/exports","POST",{pointIds:[all[0].id],columns:["Extra"],confirmReexport:true})).status,201);
    const rerouted=await send(root+"/zones/"+zone2.body.id+"/jobs","POST",{expectedRevision:completed.body.revision,mode:"open",start:{pointId:all[2].id}});
    assert.equal(rerouted.status,201,JSON.stringify(rerouted.body));
    assert.equal(rerouted.body.revision,completed.body.revision+1);
    assert.equal((await send(root+"/jobs/"+completed.body.id+"/exports","POST",{pointIds:[all[0].id],columns:["Extra"],confirmReexport:true})).status,409);
    assert.equal((await send(root+"/zones/"+zone2.body.id,"DELETE",{expectedRevision:rerouted.body.revision,confirm:true})).status,204);
    assert.equal((await send(root+"/jobs/"+completed.body.id+"/exports","POST",{pointIds:[all[0].id],columns:["Extra"],confirmReexport:true})).status,409);
    assert.equal((await send(root+"/exports/"+exported.body.export.id+"/file?format=csv")).status,200);
    assert.equal((await send(root+"/points?limit=6000")).body.points.filter((p:any)=>p.zoneId===null).length,2);
  } finally {
    if(originalOsrm===undefined) delete process.env.OSRM_BASE_URL; else process.env.OSRM_BASE_URL=originalOsrm;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(planId) {
      await db.delete(districtExportsTable).where(eq(districtExportsTable.planId,planId));
      await db.delete(districtJobsTable).where(eq(districtJobsTable.planId,planId));
      await db.delete(districtPointsTable).where(eq(districtPointsTable.planId,planId));
      await db.delete(districtZonesTable).where(eq(districtZonesTable.planId,planId));
      await db.delete(districtImportsTable).where(eq(districtImportsTable.planId,planId));
      await db.delete(districtPlansTable).where(eq(districtPlansTable.id,planId));
    }
    await db.delete(organizationsTable).where(eq(organizationsTable.id,orgA));
    await db.delete(organizationsTable).where(eq(organizationsTable.id,orgB));
  }
});

test("6000 physical source lines survive persistence; legacy jobs fail with rerun guidance",async()=>{
  const org=randomUUID(),planId=randomUUID(),importId=randomUUID(),zoneId=randomUUID(),jobId=randomUUID();
  await db.insert(organizationsTable).values({id:org,name:"District bulk",email:org+"@test.local"});
  try {
    await db.insert(districtPlansTable).values({id:planId,organizationId:org,name:"Bulk source"});
    await db.insert(districtImportsTable).values({id:importId,planId,sourceKey:"bulk",payloadHash:"sha256",total:6000,valid:6000,rejected:0,revision:1});
    for(let offset=0;offset<6000;offset+=500) {
      await db.insert(districtPointsTable).values(Array.from({length:500},(_,n)=>{
        const i=offset+n;
        return {planId,importId,sourceRowNumber:i+10,objectNumber:String(i).padStart(8,"0"),address:"Göteborg "+i,latitude:57.7+i/100000,longitude:11.9,original:{Id:String(i).padStart(8,"0"),Extra:"value "+i}};
      }));
    }
    const rows=await db.select().from(districtPointsTable).where(eq(districtPointsTable.planId,planId)).orderBy(districtPointsTable.sourceRowNumber);
    assert.equal(rows.length,6000);
    assert.equal(rows[0].sourceRowNumber,10);
    assert.equal(rows.at(-1)?.sourceRowNumber,6009);
    assert.equal(rows.at(-1)?.objectNumber,"00005999");
    await db.insert(districtZonesTable).values({id:zoneId,planId,name:"Small",color:"#ee66aa"});
    await db.insert(districtJobsTable).values({id:jobId,planId,zoneId,revision:0,status:"running",attempts:2,leaseUntil:new Date(Date.now()+120000),input:{points:[{id:rows[0].id,latitude:57.7,longitude:11.9}],mode:"loop",start:{pointId:rows[0].id},serviceMinutes:0}});
    await claimNextDistrictJob([org]);
    const [recovered]=await db.select().from(districtJobsTable).where(eq(districtJobsTable.id,jobId));
    assert.equal(recovered.status,"failed");
    assert.match(recovered.error??"",/saknar en sparad leverantörsbindning/);
    assert.match(recovered.error??"",/Kör om optimeringen/);
  } finally {
    await db.delete(districtJobsTable).where(eq(districtJobsTable.planId,planId));
    await db.delete(districtPointsTable).where(eq(districtPointsTable.planId,planId));
    await db.delete(districtZonesTable).where(eq(districtZonesTable.planId,planId));
    await db.delete(districtImportsTable).where(eq(districtImportsTable.planId,planId));
    await db.delete(districtPlansTable).where(eq(districtPlansTable.id,planId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id,org));
  }
});

test("concurrent district admissions share the five-job organization cap across plans",async()=>{
  const previousOsrm=process.env.OSRM_BASE_URL;
  process.env.OSRM_BASE_URL="http://127.0.0.1:9999";
  const org=randomUUID(),actor=randomUUID();
  const planIds=[randomUUID(),randomUUID()],importIds=[randomUUID(),randomUUID()];
  const zoneIds=[randomUUID(),randomUUID()],pointIds=[randomUUID(),randomUUID()];
  await db.insert(organizationsTable).values({id:org,name:"District queue "+org,email:org+"@queue.test"});
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{
    req.user={id:actor,name:"Queue planner",email:"queue@test.local",role:"dispatcher",organizationId:org,driverProfileId:null};
    next();
  });
  app.use(authorizeWrite(),districtRouter);
  app.use((error:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(500).json({error:error.message});});
  const server=app.listen(0);await once(server,"listening");
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await db.insert(districtPlansTable).values(planIds.map((id,index)=>({id,organizationId:org,name:`Queue plan ${index}`})));
    await db.insert(districtImportsTable).values(importIds.map((id,index)=>({
      id,planId:planIds[index],sourceKey:"queue-source",payloadHash:"queue-hash",total:1,valid:1,rejected:0,revision:1,
    })));
    await db.insert(districtZonesTable).values(zoneIds.map((id,index)=>({
      id,planId:planIds[index],name:`Queue zone ${index}`,color:"#123456",
    })));
    await db.insert(districtPointsTable).values(pointIds.map((id,index)=>({
      id,planId:planIds[index],importId:importIds[index],sourceRowNumber:1,objectNumber:`Q${index}`,address:`Queue ${index}`,
      latitude:57.7+index/100,longitude:11.9,original:{},zoneId:zoneIds[index],
    })));
    const post=async(index:number)=>{
      const response=await fetch(`${base}/district-plans/${planIds[index%2]}/zones/${zoneIds[index%2]}/jobs`,{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({expectedRevision:0,mode:"loop",start:{pointId:pointIds[index%2]}}),
      });
      return {status:response.status,body:await response.json() as any};
    };
    const outcomes=await Promise.all(Array.from({length:6},(_,index)=>post(index)));
    assert.equal(outcomes.filter(outcome=>outcome.status===201).length,5,JSON.stringify(outcomes));
    assert.equal(outcomes.filter(outcome=>outcome.status===429).length,1,JSON.stringify(outcomes));
    const rows=await db.select({status:districtJobsTable.status}).from(districtJobsTable)
      .where(eq(districtJobsTable.planId,planIds[0]));
    const other=await db.select({status:districtJobsTable.status}).from(districtJobsTable)
      .where(eq(districtJobsTable.planId,planIds[1]));
    assert.equal(rows.length+other.length,5);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(previousOsrm===undefined) delete process.env.OSRM_BASE_URL; else process.env.OSRM_BASE_URL=previousOsrm;
    await db.delete(districtJobsTable).where(inArray(districtJobsTable.planId,planIds));
    await db.delete(districtPointsTable).where(inArray(districtPointsTable.planId,planIds));
    await db.delete(districtZonesTable).where(inArray(districtZonesTable.planId,planIds));
    await db.delete(districtImportsTable).where(inArray(districtImportsTable.planId,planIds));
    await db.delete(districtPlansTable).where(inArray(districtPlansTable.id,planIds));
    await db.delete(organizationsTable).where(eq(organizationsTable.id,org));
  }
});
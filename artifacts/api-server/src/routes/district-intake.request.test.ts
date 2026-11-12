import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import type {AddressInfo} from "node:net";
import express from "express";
import {eq} from "drizzle-orm";
import {db,organizationsTable,organizationServicePoliciesTable,districtPlansTable,districtImportsTable,districtIntakesTable,districtPointsTable,planningDraftsTable} from "@workspace/db";
import type {AuthUser} from "../middleware/auth";
import router from "./district-intake";

test("intake source copying accepts historical plan IDs, conserves rows, denies foreign/viewer, retries and guards stale revisions",async()=>{
  const plan=`${randomUUID().slice(0,14)}0000-0000-${randomUUID().slice(-12)}`;
  const org=randomUUID(),foreign=randomUUID(),draft=randomUUID();
  await db.insert(organizationsTable).values([{id:org,name:"Intake test",email:org+"@test.local"},{id:foreign,name:"Foreign test",email:foreign+"@test.local"}]);
  // Both tenants need entitlement so cross-tenant access reaches the ownership guard.
  // Keep paid external providers disabled for these synthetic fixtures.
  await db.insert(organizationServicePoliciesTable).values([org,foreign].map(organizationId=>({
    organizationId,policy:{roadProvider:"disabled" as const,geocodingProvider:"disabled" as const,
      smsProvider:"disabled" as const,emailEnabled:false,aiEnabled:false,cuoptEnabled:false,districtEnabled:true}
  })));
  await db.insert(districtPlansTable).values({id:plan,name:"Intake",organizationId:org});
  await db.insert(planningDraftsTable).values({id:draft,name:"Source",organizationId:org,startAt:new Date(),state:{parsedData:{headers:["Obj","Adress"],sourceRowCount:2,rows:[{sourceRowNumber:2,values:["001","A"]},{sourceRowNumber:3,values:["002","B"]}]},mappedRows:[{_sourceRowNumber:2,address:"A",latitude:57.7,longitude:11.9}]}});
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.user={id:randomUUID(),name:"Test",email:"test@test.local",role:(req.get("x-role")??"dispatcher") as AuthUser["role"],organizationId:req.get("x-foreign")?foreign:org,driverProfileId:null};next();});
  app.use(router);app.use((e:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(500).json({error:e.message});});
  const server=app.listen(0);await once(server,"listening");
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/district-plans/${plan}/intake`;
  const send=async(path="",body?:unknown,headers:Record<string,string>={})=>{const r=await fetch(base+path,{method:body?"POST":"GET",headers:{"content-type":"application/json",...headers},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json() as any};};
  try{
    const payload={draftId:draft,revision:0,mapping:{objectNumber:"Obj",address:"Adress"}};
    assert.equal((await send("",undefined,{"x-role":"viewer"})).status,403);
    assert.equal((await send("/from-draft",payload,{"x-foreign":"1"})).status,404);
    assert.equal((await send("/from-draft",{...payload,revision:1})).status,409);
    const first=await send("/from-draft",payload);assert.equal(first.status,200,JSON.stringify(first.body));
    assert.equal(first.body.intake.total,2);assert.equal(first.body.intake.ready,1);assert.equal(first.body.intake.unresolved,1);
    const retry=await send("/from-draft",payload);assert.equal(retry.body.intake.id,first.body.intake.id);
    await db.update(planningDraftsTable).set({revision:1}).where(eq(planningDraftsTable.id,draft));
    const oldRetry=await send("/from-draft",payload);
    assert.equal(oldRetry.status,200);assert.equal(oldRetry.body.intake.id,first.body.intake.id);
    assert.equal((await db.select().from(districtPointsTable).where(eq(districtPointsTable.planId,plan))).length,1);
    // Ready-row search must fail before reaching a paid provider.
    assert.equal((await send("/rows/2/search",{revision:0})).status,409);
    assert.equal((await send("/rows/3/accept",{revision:0,candidateIndex:0})).status,422);
    assert.equal((await send("/rows/3/search",{revision:9})).status,409);
    // Persist explicit synthetic ambiguous search results without calling a provider.
    const [pending]=await db.select().from(districtIntakesTable).where(eq(districtIntakesTable.planId,plan));
    pending.rows[1].candidates=[{latitude:57.8,longitude:11.8,displayName:"Candidate A"},{latitude:57.9,longitude:11.9,displayName:"Candidate B"}];
    await db.update(districtIntakesTable).set({rows:pending.rows}).where(eq(districtIntakesTable.id,pending.id));
    assert.equal((await send()).body.intake.unresolved,1);
    const accepted=await send("/rows/3/accept",{revision:0,candidateIndex:1});
    assert.equal(accepted.status,200,JSON.stringify(accepted.body));
    assert.equal(accepted.body.intake.ready,2);
    assert.equal(accepted.body.intake.rows[1].latitude,57.9);
    assert.equal(accepted.body.intake.rows[1].original.Adress,"B");
    assert.equal((await send("/rows/3/accept",{revision:0,candidateIndex:1})).status,409);
  }finally{
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    await db.delete(districtIntakesTable).where(eq(districtIntakesTable.planId,plan));
    await db.delete(districtPointsTable).where(eq(districtPointsTable.planId,plan));
    await db.delete(districtImportsTable).where(eq(districtImportsTable.planId,plan));
    await db.delete(districtPlansTable).where(eq(districtPlansTable.id,plan));
    await db.delete(planningDraftsTable).where(eq(planningDraftsTable.id,draft));
    await db.delete(organizationsTable).where(eq(organizationsTable.id,org));
    await db.delete(organizationsTable).where(eq(organizationsTable.id,foreign));
  }
});
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db, pool, organizationsTable as organizations, districtPlansTable as plans, districtImportsTable as imports, districtZonesTable as zones, districtPointsTable as points, districtJobsTable as jobs, type DistrictJobInput, type DistrictResult } from "@workspace/db";
import { assertDistrictJobAdmission, DistrictAdmissionError, claimDistrictJob, heartbeatDistrictJob, isDistrictJobLive, finishDistrictJob, failDistrictJob } from "./district-capacity";

// Only disposable development tables are visible to this process. No public
// fallback, global worker tick, application startup, or road provider invocation.
const schema=`district_capacity_${randomUUID().replaceAll("-","")}`;
const tableNames=["organizations","district_plans","district_imports","district_zones","district_points","district_jobs"] as const;
let schemaCreated=false;

before(async()=>{
  assert.equal(process.env.NODE_ENV,"test","DB capacity tests must run with NODE_ENV=test");
  const client=await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated=true;
    for(const table of tableNames) await client.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    // LIKE does not copy FKs: restore the fixture's actual scoped relationships.
    for(const [table,column,target] of [
      ["district_plans","organization_id","organizations"],
      ["district_imports","plan_id","district_plans"],
      ["district_zones","plan_id","district_plans"],
      ["district_points","plan_id","district_plans"],
      ["district_points","import_id","district_imports"],
      ["district_points","zone_id","district_zones"],
      ["district_jobs","plan_id","district_plans"],
      ["district_jobs","zone_id","district_zones"],
    ]) await client.query(`ALTER TABLE "${schema}"."${table}" ADD FOREIGN KEY ("${column}") REFERENCES "${schema}"."${target}" (id)`);
    pool.options.options=`-c search_path=${schema}`;
    await client.query(`SET search_path TO "${schema}"`);
    assert.equal((await client.query("SHOW search_path")).rows[0].search_path,schema);
  } finally {client.release();}
});

beforeEach(async()=>{
  // These identifiers are fixed/UUID-generated, never user-controlled.
  await pool.query(`TRUNCATE ${tableNames.map(name=>`"${schema}"."${name}"`).join(",")} CASCADE`);
});

after(async()=>{
  try {
    if(schemaCreated) {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      assert.equal((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname=$1",[schema])).rowCount,0);
    }
  } finally {await pool.end();}
});

type Fixture={organizationId:string;entries:{planId:string;zoneId:string;input:DistrictJobInput}[]};
async function fixture(planCount=1):Promise<Fixture> {
  const organizationId=randomUUID();
  await db.insert(organizations).values({id:organizationId,name:"Capacity fixture",email:`${organizationId}@example.test`});
  const entries=[];
  for(let i=0;i<planCount;i++) {
    const planId=randomUUID(),zoneId=randomUUID(),importId=randomUUID(),pointId=randomUUID();
    await db.insert(plans).values({id:planId,organizationId,name:`Capacity plan ${i}`});
    await db.insert(imports).values({id:importId,planId,sourceKey:"capacity",payloadHash:"fixture",total:1,valid:1,rejected:0,revision:0});
    await db.insert(zones).values({id:zoneId,planId,name:`Capacity zone ${i}`,color:"#abcdef"});
    await db.insert(points).values({id:pointId,planId,importId,zoneId,sourceRowNumber:1,objectNumber:"0001",address:"Fixture address",latitude:57.7,longitude:11.9,original:{Id:"0001"}});
    entries.push({planId,zoneId,input:{points:[{id:pointId,latitude:57.7,longitude:11.9}],mode:"loop" as const,start:{pointId},serviceMinutes:0}});
  }
  return {organizationId,entries};
}
async function enqueue(owner:Fixture,index=0,overrides:Partial<typeof jobs.$inferInsert>={}) {
  const [job]=await db.insert(jobs).values({...owner.entries[index],revision:0,...overrides}).returning();
  return job;
}
async function admit(owner:Fixture,index=0) {
  return db.transaction(async tx=>{
    await assertDistrictJobAdmission(tx,owner.organizationId);
    const [job]=await tx.insert(jobs).values({...owner.entries[index],revision:0}).returning();
    return job;
  });
}
async function state(id:string) {
  const [job]=await db.select().from(jobs).where(eq(jobs.id,id));
  assert.ok(job);
  return job;
}
const date=(n:number)=>new Date(Date.UTC(2025,0,1,0,0,n));
const result=(input:DistrictJobInput):DistrictResult=>({orderedPointIds:input.points.map(p=>p.id),distanceMeters:100,driveSeconds:50,geometry:input.points.map(p=>({latitude:p.latitude,longitude:p.longitude})),warnings:[]});

test("global scheduling allows one bulk matrix while another tenant's small job can use the second slot",async()=>{
  const a=await fixture(1),b=await fixture(1),c=await fixture(1);
  const makeBulk=(input:DistrictJobInput):DistrictJobInput=>({...input,mode:"open",start:{latitude:57.6,longitude:11.8},
    bulk:{engine:"bulk-road-v1",scope:"plan",planRevision:0,intakeRevision:null,datasetIdentity:"synthetic",
      sourceHash:"synthetic",exceptions:[],sourceRows:[]}});
  const ja=await enqueue(a,0,{input:makeBulk(a.entries[0].input),createdAt:date(0)});
  const jb=await enqueue(b,0,{input:makeBulk(b.entries[0].input),createdAt:date(1)});
  const jc=await enqueue(c,0,{createdAt:date(2)});
  const first=await claimDistrictJob();
  assert.equal(first?.id,ja.id);
  const second=await claimDistrictJob();
  assert.equal(second?.id,jc.id,"second bulk job waits while small job remains eligible");
  assert.equal((await state(jb.id)).status,"queued");
  await finishDistrictJob(first!,result(first!.input));
  assert.equal((await claimDistrictJob())?.id,jb.id);
});

test("atomic admission: eight simultaneous sessions across eight plans admit exactly five organization jobs",async()=>{
  const owner=await fixture(8);
  // Hold eight independent PostgreSQL sessions before releasing the start barrier.
  const clients=await Promise.all(Array.from({length:8},()=>pool.connect()));
  const sessions=await Promise.all(clients.map(async client=>{
    assert.equal((await client.query("SHOW search_path")).rows[0].search_path,schema);
    return (await client.query("SELECT pg_backend_pid() AS id")).rows[0].id;
  }));
  assert.equal(new Set(sessions).size,8);
  clients.forEach(client=>client.release());
  const attempts=await Promise.allSettled(owner.entries.map((_,i)=>admit(owner,i)));
  assert.equal(attempts.filter(a=>a.status==="fulfilled").length,5);
  const rejected=attempts.filter(a=>a.status==="rejected");
  assert.equal(rejected.length,3);
  for(const attempt of rejected) {
    assert.ok(attempt.status==="rejected" && attempt.reason instanceof DistrictAdmissionError);
    assert.equal(attempt.reason.status,429);
    assert.equal(attempt.reason.code,"QUEUE_FULL");
    assert.match(attempt.reason.message,/Organisationen.*fem.*alla planer/);
    assert.match(attempt.reason.message,/Vänta.*avbryt/);
  }
  const [{n}]=await db.select({n:count()}).from(jobs);
  assert.equal(n,5);
  const other=await fixture();
  assert.equal((await admit(other)).status,"queued","A full organization must not consume B's admission allowance");
});

test("organization quota counts queued and running across plans, excludes terminal jobs, and cancellation releases one slot",async()=>{
  const owner=await fixture(9);
  for(let i=0;i<5;i++) await enqueue(owner,i,{status:i<2?"queued":"running",attempts:i<2?0:1,leaseUntil:date(30)});
  for(const [i,status] of ["completed","failed","cancelled","stale"].entries()) await enqueue(owner,i+5,{status});
  await assert.rejects(admit(owner,8),DistrictAdmissionError);
  const [cancelled]=await db.update(jobs).set({status:"cancelled",leaseUntil:null}).where(and(eq(jobs.planId,owner.entries[0].planId),eq(jobs.status,"queued"))).returning();
  assert.ok(cancelled);
  await admit(owner,8);
  await assert.rejects(admit(owner,0),DistrictAdmissionError);
});

test("rolled-back admission does not reserve a quota slot or leave an organization lock behind",async()=>{
  const owner=await fixture(2);
  for(let i=0;i<4;i++) await admit(owner);
  await assert.rejects(db.transaction(async tx=>{
    await assertDistrictJobAdmission(tx,owner.organizationId);
    await tx.insert(jobs).values({...owner.entries[1],revision:0});
    throw new Error("fixture rollback");
  }),/fixture rollback/);
  await admit(owner,1);
  await assert.rejects(admit(owner,0),DistrictAdmissionError);
  assert.equal((await db.select({n:count()}).from(jobs))[0].n,5);
});

test("concurrent claim sessions enforce global two and organization one across multiple plans",async()=>{
  const a=await fixture(5),b=await fixture(2),c=await fixture();
  for(let i=0;i<5;i++) await enqueue(a,i,{createdAt:date(i)});
  for(let i=0;i<2;i++) await enqueue(b,i,{createdAt:date(10+i)});
  await enqueue(c,0,{createdAt:date(20)});
  const claims=(await Promise.all(Array.from({length:8},()=>claimDistrictJob()))).filter(c=>c!==null);
  assert.equal(claims.length,2);
  assert.equal(new Set(claims.map(j=>j.id)).size,2);
  assert.deepEqual(new Set(claims.map(j=>j.organizationId)),new Set([a.organizationId,b.organizationId]));
  assert.equal(await claimDistrictJob(),null);
  const running=await db.select({organizationId:plans.organizationId,n:count()}).from(jobs).innerJoin(plans,eq(jobs.planId,plans.id))
    .where(eq(jobs.status,"running")).groupBy(plans.organizationId);
  assert.equal(running.reduce((sum,r)=>sum+r.n,0),2);
  assert.ok(running.every(r=>r.n===1));
  const first=claims.find(j=>j.organizationId===a.organizationId)!;
  assert.equal(await finishDistrictJob(first,result(first.input)),true);
  const next=await claimDistrictJob();
  assert.equal(next?.organizationId,c.organizationId,"Never-served C must run before A's older backlog");
});

test("durable tenant fairness rotates organizations, with FIFO across all of each organization's plans",async()=>{
  const a=await fixture(3),b=await fixture(2),c=await fixture(2);
  const expected=[];
  for(const [owner,offset] of [[a,0],[b,10],[c,20]] as const) {
    for(let i=0;i<owner.entries.length;i++) expected.push(await enqueue(owner,i,{createdAt:date(offset+i)}));
  }
  const selected=[];
  for(let i=0;i<7;i++) {
    const claim=await claimDistrictJob();
    assert.ok(claim);
    selected.push(claim.id);
    await finishDistrictJob(claim,result(claim.input));
  }
  assert.deepEqual(selected,[expected[0].id,expected[3].id,expected[5].id,expected[1].id,expected[4].id,expected[6].id,expected[2].id]);
  assert.equal(await claimDistrictJob(),null);
});

test("scheduler skips a tenant's locked zone rather than waiting or deadlocking with zone-first mutations",{timeout:5000},async()=>{
  const a=await fixture(),b=await fixture();
  const aJob=await enqueue(a,0,{createdAt:date(0)});
  const bJob=await enqueue(b,0,{createdAt:date(1)});
  await db.transaction(async tx=>{
    await tx.select().from(zones).where(eq(zones.id,aJob.zoneId)).for("update");
    const claim=await claimDistrictJob();
    assert.ok(claim);
    assert.equal(claim.id,bJob.id);
    assert.equal((await state(aJob.id)).status,"queued");
    assert.equal(await finishDistrictJob(claim,result(claim.input)),true);
  });
  assert.equal((await claimDistrictJob())?.id,aJob.id);
});

test("expiry fences old progress/result/failure writes before reclaim; retry preserves org and attempts; final expiry releases capacity",async()=>{
  const a=await fixture(2),b=await fixture();
  const old=await enqueue(a,0,{createdAt:date(0)});
  const waiting=await enqueue(a,1,{createdAt:date(1)});
  const claim=await claimDistrictJob();
  assert.ok(claim);
  assert.equal(claim.id,old.id);
  await db.update(jobs).set({leaseUntil:sql`clock_timestamp() - interval '1 second'`}).where(eq(jobs.id,claim.id));
  assert.equal(await isDistrictJobLive(claim),false);
  assert.equal(await heartbeatDistrictJob(claim,80),false);
  assert.equal(await finishDistrictJob(claim,result(claim.input)),false);
  assert.equal(await failDistrictJob(claim,"old failure"),false);
  const retry=await claimDistrictJob();
  assert.ok(retry);
  assert.equal(retry.id,claim.id);
  assert.equal(retry.organizationId,a.organizationId);
  assert.equal(retry.planId,claim.planId);
  assert.equal(retry.attempts,2);
  assert.equal((await state(waiting.id)).status,"queued");
  assert.equal(await heartbeatDistrictJob(claim,90),false);
  assert.equal(await finishDistrictJob(claim,result(claim.input)),false);
  assert.equal(await failDistrictJob(claim,"late attempt"),false);
  assert.equal(await heartbeatDistrictJob(retry,35),true);
  assert.equal((await state(retry.id)).progress,35);
  const bJob=await enqueue(b);
  assert.equal((await claimDistrictJob())?.id,bJob.id);
  await db.update(jobs).set({leaseUntil:sql`clock_timestamp() - interval '1 second'`}).where(eq(jobs.id,retry.id));
  assert.equal((await claimDistrictJob())?.id,waiting.id);
  assert.equal((await state(retry.id)).status,"failed");
  assert.equal((await state(retry.id)).leaseUntil,null);
  assert.match((await state(retry.id)).error??"",/omkörningsgränsen/);
  assert.equal(await finishDistrictJob(retry,result(retry.input)),false);
});

test("cancelled and stale attempts never revive; zone revision invalidation beats expiry recovery",async()=>{
  const owner=await fixture(3);
  const first=await enqueue(owner,0,{createdAt:date(0)});
  const second=await enqueue(owner,1,{createdAt:date(1)});
  const third=await enqueue(owner,2,{createdAt:date(2)});
  const cancelled=await claimDistrictJob();
  assert.ok(cancelled);
  assert.equal(cancelled.id,first.id);
  await db.update(jobs).set({status:"cancelled",leaseUntil:null}).where(eq(jobs.id,cancelled.id));
  assert.equal(await heartbeatDistrictJob(cancelled),false);
  assert.equal(await finishDistrictJob(cancelled,result(cancelled.input)),false);
  assert.equal(await failDistrictJob(cancelled,"late cancel failure"),false);
  const stale=await claimDistrictJob();
  assert.ok(stale);
  assert.equal(stale.id,second.id);
  await db.update(zones).set({revision:1}).where(eq(zones.id,stale.zoneId));
  await db.update(jobs).set({leaseUntil:sql`clock_timestamp() - interval '1 second'`}).where(eq(jobs.id,stale.id));
  assert.equal(await heartbeatDistrictJob(stale),false);
  assert.equal(await finishDistrictJob(stale,result(stale.input)),false);
  assert.equal((await claimDistrictJob())?.id,third.id);
  assert.equal((await state(first.id)).status,"cancelled");
  assert.equal((await state(second.id)).status,"stale");
  assert.equal((await state(second.id)).attempts,1);
  assert.equal((await state(second.id)).leaseUntil,null);
});

test("legacy cross-plan zone and foreign-point snapshots are stale, not provider-eligible; valid work is selected in the same claim",async()=>{
  const a=await fixture(3),b=await fixture();
  const foreignZone=await enqueue(a,0,{zoneId:b.entries[0].zoneId,input:b.entries[0].input,createdAt:date(0)});
  const foreignInput=await enqueue(a,1,{input:b.entries[0].input,createdAt:date(1)});
  const valid=await enqueue(a,2,{createdAt:date(2)});
  const bJob=await enqueue(b,0,{createdAt:date(3)});
  assert.equal((await claimDistrictJob())?.id,valid.id);
  assert.equal((await state(foreignZone.id)).status,"stale");
  assert.equal((await state(foreignInput.id)).status,"stale");
  assert.equal((await state(bJob.id)).status,"queued");
  assert.equal((await claimDistrictJob())?.id,bJob.id);
});

test("null leases are recovered, exhausted queued retries fail, and deleted zones never restart",async()=>{
  const owner=await fixture(4);
  const noLease=await enqueue(owner,0,{status:"running",attempts:1,leaseUntil:null,createdAt:date(0)});
  const exhausted=await enqueue(owner,1,{attempts:2,createdAt:date(1)});
  const deleted=await enqueue(owner,2,{status:"running",attempts:1,leaseUntil:null,createdAt:date(2)});
  await db.update(zones).set({deletedAt:new Date()}).where(eq(zones.id,deleted.zoneId));
  const next=await claimDistrictJob();
  assert.equal(next?.id,noLease.id);
  assert.equal(next?.attempts,2);
  assert.equal((await state(exhausted.id)).status,"failed");
  assert.equal((await state(deleted.id)).status,"stale");
  const terminal=await db.select().from(jobs).where(inArray(jobs.id,[exhausted.id,deleted.id]));
  assert.ok(terminal.every(j=>j.leaseUntil===null));
});

test("claim ownership is revalidated on every lease/result/failure write, even with a valid job and attempt",async()=>{
  const a=await fixture(),b=await fixture();
  await enqueue(a);
  const claim=await claimDistrictJob();
  assert.ok(claim);
  const forged={...claim,organizationId:b.organizationId};
  assert.equal(await isDistrictJobLive(forged),false);
  assert.equal(await heartbeatDistrictJob(forged,99),false);
  assert.equal(await finishDistrictJob(forged,result(claim.input)),false);
  assert.equal(await failDistrictJob(forged,"forged tenant"),false);
  assert.equal((await state(claim.id)).status,"running");
  assert.equal(await finishDistrictJob(claim,result(claim.input)),true);
  assert.equal((await state(claim.id)).status,"completed");
});
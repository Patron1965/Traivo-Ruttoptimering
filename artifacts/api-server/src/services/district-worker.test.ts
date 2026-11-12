import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { db, organizationsTable, districtPlansTable, districtZonesTable, districtJobsTable, type DistrictJobInput } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { claimNextDistrictJob } from "./district-worker";

test("database queue claims oldest-served tenant across plans, then prevents a second active job for that tenant", async () => {
  const orgA=randomUUID(),orgB=randomUUID();
  const planA1=randomUUID(),planA2=randomUUID(),planB=randomUUID();
  const zoneA1=randomUUID(),zoneA2=randomUUID(),zoneB=randomUUID();
  const aHistory=randomUUID(),bHistory=randomUUID();
  const a1=randomUUID(),a2=randomUUID(),b1=randomUUID();
  const base=new Date("2026-01-01T00:00:00.000Z");
  const at=(minute:number)=>new Date(base.getTime()+minute*60_000);
  const plans=[planA1,planA2,planB],zones=[zoneA1,zoneA2,zoneB];
  const input=(startedAt?:Date):DistrictJobInput=>({
    points:[{id:randomUUID(),latitude:57.7,longitude:11.9}],
    mode:"loop",start:{latitude:57.7,longitude:11.9},serviceMinutes:0,
    routingProvider:{binding:{serverId:"shared",configurationVersion:"test-binding"}},
    ...(startedAt?{startedAt:startedAt.toISOString()}:{}),
  } as DistrictJobInput);
  await db.insert(organizationsTable).values([
    {id:orgA,name:"Queue A "+orgA,email:orgA+"@queue.test"},
    {id:orgB,name:"Queue B "+orgB,email:orgB+"@queue.test"},
  ]);
  try {
    await db.insert(districtPlansTable).values([
      {id:planA1,organizationId:orgA,name:"A plan one"},
      {id:planA2,organizationId:orgA,name:"A plan two"},
      {id:planB,organizationId:orgB,name:"B plan"},
    ]);
    await db.insert(districtZonesTable).values([
      {id:zoneA1,planId:planA1,name:"A1",color:"#123456"},
      {id:zoneA2,planId:planA2,name:"A2",color:"#123456"},
      {id:zoneB,planId:planB,name:"B",color:"#123456"},
    ]);
    await db.insert(districtJobsTable).values([
      {id:aHistory,planId:planA1,zoneId:zoneA1,revision:0,status:"completed",attempts:1,createdAt:at(0),updatedAt:at(10),input:input(at(10))},
      {id:bHistory,planId:planB,zoneId:zoneB,revision:0,status:"completed",attempts:1,createdAt:at(0),updatedAt:at(5),input:input(at(5))},
      {id:a1,planId:planA1,zoneId:zoneA1,revision:0,status:"queued",createdAt:at(1),input:input()},
      {id:a2,planId:planA2,zoneId:zoneA2,revision:0,status:"queued",createdAt:at(2),input:input()},
      {id:b1,planId:planB,zoneId:zoneB,revision:0,status:"queued",createdAt:at(3),input:input()},
    ]);

    const first=await claimNextDistrictJob([orgA,orgB]);
    assert.equal(first?.job.id,b1,"B was served earlier than A even though B's queued job is newer");
    assert.equal(first?.organizationId,orgB);
    const second=await claimNextDistrictJob([orgA,orgB]);
    assert.equal(second?.job.id,a1,"A's oldest job across both plans is claimed next");
    assert.equal(second?.organizationId,orgA);
    assert.equal(await claimNextDistrictJob([orgA,orgB]),null,"the scoped two-slot limit is now full");

    const rows=await db.select({id:districtJobsTable.id,status:districtJobsTable.status,input:districtJobsTable.input})
      .from(districtJobsTable).where(inArray(districtJobsTable.id,[a1,a2,b1]));
    const byId=new Map(rows.map(row=>[row.id,row]));
    assert.equal(byId.get(a1)?.status,"running");
    assert.equal(byId.get(a2)?.status,"queued","A cannot occupy both worker slots");
    assert.equal(byId.get(b1)?.status,"running");
    assert.equal(typeof (byId.get(b1)?.input as {startedAt?:unknown}).startedAt,"string");
    await db.update(districtJobsTable).set({status:"completed"}).where(eq(districtJobsTable.id,b1));
    assert.equal(await claimNextDistrictJob([orgA,orgB]),null,"A's second plan stays queued while A already owns its slot");
  } finally {
    await db.delete(districtJobsTable).where(inArray(districtJobsTable.planId,plans));
    await db.delete(districtZonesTable).where(inArray(districtZonesTable.id,zones));
    await db.delete(districtPlansTable).where(inArray(districtPlansTable.id,plans));
    await db.delete(organizationsTable).where(inArray(organizationsTable.id,[orgA,orgB]));
  }
});
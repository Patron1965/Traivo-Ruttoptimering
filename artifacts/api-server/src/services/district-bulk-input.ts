import { createHash } from "node:crypto";
import { and,eq } from "drizzle-orm";
import { db,districtPointsTable as points,districtIntakesTable as intakes,districtPlansTable as plans } from "@workspace/db";
import { bulkCapacity,coordinateKey,type DistrictBulkSnapshot,type DistrictDistanceException } from "./district-bulk-solver";
import type { DistrictEndpoint } from "./district-solver";

export async function prepareDistrictBulk(database:Pick<typeof db,"select">,planId:string,zoneId:string,
  scope:"zone"|"plan",start:DistrictEndpoint,datasetIdentity:string,exceptions:DistrictDistanceException[]) {
  const [plan]=await database.select().from(plans).where(eq(plans.id,planId));
  if(!plan) throw new Error("Planen saknas.");
  const members=await database.select().from(points).where(and(eq(points.planId,planId),
    scope==="zone"?eq(points.zoneId,zoneId):undefined)).orderBy(points.sourceRowNumber,points.id);
  const [intake]=await database.select().from(intakes).where(eq(intakes.planId,planId));
  const sourceRows:DistrictBulkSnapshot["sourceRows"]=members.map(p=>({
    id:p.id,pointId:p.id,sourceRowNumber:p.sourceRowNumber,objectNumber:p.objectNumber,original:p.original,status:"ready",reason:"",
  }));
  if(scope==="plan" && intake) {
    const memberIds=new Set(members.map(p=>p.id));
    for(const row of intake.rows) {
      if(row.pointId && memberIds.has(row.pointId)) continue;
      if(row.status==="ready") throw new Error("En klar källrad saknar kartpunkt. Åtgärda underlaget före beräkning.");
      sourceRows.push({id:`intake:${intake.id}:${row.sourceRowNumber}`,sourceRowNumber:row.sourceRowNumber,
        objectNumber:row.objectNumber,original:row.original,status:row.status,reason:row.reason});
    }
  }
  if(new Set(sourceRows.map(r=>r.id)).size!==sourceRows.length) throw new Error("Källradernas identiteter är inte unika.");
  const snapLimits=new Map<string,number>();
  const memberMap=new Map(members.map(p=>[p.id,p]));
  const seen=new Set<string>();
  for(const exception of exceptions) {
    const point=memberMap.get(exception.pointId);
    if(!point || seen.has(exception.pointId) || !Number.isFinite(exception.maxSnapMeters) ||
      exception.maxSnapMeters<=250 || exception.maxSnapMeters>1000 || !exception.reason.trim())
      throw new Error("Avståndsundantag kräver en vald post, 251–1000 meter och ett uttryckligt skäl.");
    seen.add(exception.pointId);
    if(coordinateKey(point)===coordinateKey(start as {latitude:number;longitude:number}))
      throw new Error("Ett objekt med avståndsundantag får inte också vara den externa startpositionen.");
    // Provider sees positions, not source IDs: explicitly record all co-located rows affected.
    const same=members.filter(p=>coordinateKey(p)===coordinateKey(point));
    if(same.some(p=>!exceptions.some(e=>e.pointId===p.id && e.maxSnapMeters===exception.maxSnapMeters)))
      throw new Error("Alla samplacerade objekt måste ha samma uttryckliga avståndsgodkännande.");
    snapLimits.set(coordinateKey(point),exception.maxSnapMeters);
  }
  const sourceHash=createHash("sha256").update(JSON.stringify({planRevision:plan.revision,intakeRevision:intake?.revision??null,
    scope,start,datasetIdentity,exceptions,sourceRows,members:members.map(p=>({id:p.id,latitude:p.latitude,longitude:p.longitude}))})).digest("hex");
  const snapshot:DistrictBulkSnapshot={engine:"bulk-road-v1",scope,planRevision:plan.revision,intakeRevision:intake?.revision??null,
    datasetIdentity,sourceHash,exceptions,sourceRows};
  const capacity=bulkCapacity(members,start);
  if(sourceRows.length>20000) capacity.allowed=false;
  return {members,snapshot,snapLimits,capacity};
}

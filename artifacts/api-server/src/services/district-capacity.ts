import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db, organizationsTable as organizations, districtPlansTable as plans, districtJobsTable as jobs, districtZonesTable as zones, districtPointsTable as points, type DistrictResult } from "@workspace/db";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const DISTRICT_MAX_OUTSTANDING_PER_ORG=5;
export const DISTRICT_MAX_RUNNING=2;
export const DISTRICT_MAX_ATTEMPTS=2;
export const DISTRICT_LEASE_MS=60000;
export type ClaimedDistrictJob=typeof jobs.$inferSelect & {organizationId:string};

export class DistrictAdmissionError extends Error {
  readonly code="QUEUE_FULL";
  readonly status=429;
  constructor() {
    super("Organisationen har redan fem köade eller pågående distriktsjobb, sammanlagt för alla planer. Vänta tills ett jobb är klart eller avbryt ett jobb innan du försöker igen.");
  }
}

// Must be called BEFORE plan/zone/job row locks. The organization row serializes
// admission across all plans and processes; insert the job in this same transaction.
export async function assertDistrictJobAdmission(tx:Transaction,organizationId:string) {
  const [organization]=await tx.select({id:organizations.id}).from(organizations).where(eq(organizations.id,organizationId)).for("update");
  if(!organization) throw new Error("Organisationen hittades inte vid köläggning.");
  const [{pending}]=await tx.select({pending:count()}).from(jobs).innerJoin(plans,eq(plans.id,jobs.planId))
    .where(and(eq(plans.organizationId,organizationId),inArray(jobs.status,["queued","running"])));
  if(pending>=DISTRICT_MAX_OUTSTANDING_PER_ORG) throw new DistrictAdmissionError();
}

const validZone=sql`EXISTS (
  SELECT 1 FROM district_zones z WHERE z.id = ${jobs.zoneId}
  AND z.plan_id = ${jobs.planId} AND z.deleted_at IS NULL AND z.revision = ${jobs.revision}
  AND (${jobs.input}->'bulk' IS NULL OR EXISTS (
    SELECT 1 FROM district_plans bulk_plan WHERE bulk_plan.id=${jobs.planId}
    AND bulk_plan.revision=(${jobs.input}->'bulk'->>'planRevision')::integer
  ))
)`;
const databaseNow=sql<Date>`clock_timestamp()`;

// Attempts fence a replaced lease; expiry fences a suspended process even before
// another worker has reclaimed it. Ownership and zone scope are checked on EVERY write.
export function liveDistrictClaim(claim:ClaimedDistrictJob) {
  return and(eq(jobs.id,claim.id),eq(jobs.planId,claim.planId),eq(jobs.zoneId,claim.zoneId),
    eq(jobs.status,"running"),eq(jobs.attempts,claim.attempts),eq(jobs.revision,claim.revision),
    sql`${jobs.leaseUntil} > clock_timestamp()`,validZone,
    sql`EXISTS (SELECT 1 FROM district_plans p WHERE p.id = ${jobs.planId} AND p.organization_id = ${claim.organizationId}
      AND (${jobs.input}->'bulk' IS NULL OR p.revision = (${jobs.input}->'bulk'->>'planRevision')::integer))`);
}

export async function claimDistrictJob(database:typeof db=db):Promise<ClaimedDistrictJob|null> {
  return database.transaction(async tx=>{
    // All instances share the same capacity/scheduling lock. Never hold it while solving.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(926104721)`);
    // Mutations lock zone -> job. Lock available zones FIRST, including recovery,
    // to avoid job -> zone deadlocks with edits/transfers. Busy zones are skipped
    // so an editing tenant cannot block another tenant's scheduling.
    const availableZones=await tx.select({id:zones.id}).from(zones).where(sql`EXISTS (
      SELECT 1 FROM district_jobs active_job WHERE active_job.zone_id = ${zones.id}
      AND active_job.status IN ('queued','running')
    )`).orderBy(zones.id).for("update",{skipLocked:true});
    if(!availableZones.length) return null;
    const processable=inArray(jobs.zoneId,availableZones.map(z=>z.id));
    await tx.update(jobs).set({status:"stale",leaseUntil:null,error:"Zonen har ändrats sedan jobbet köades.",updatedAt:databaseNow})
      .where(and(processable,inArray(jobs.status,["queued","running"]),sql`NOT (${validZone})`));
    const expired=and(processable,eq(jobs.status,"running"),sql`(${jobs.leaseUntil} IS NULL OR ${jobs.leaseUntil} <= clock_timestamp())`);
    await tx.update(jobs).set({status:"failed",leaseUntil:null,error:"Jobbet hann inte klart inom omkörningsgränsen. Minska zonen och försök igen.",updatedAt:databaseNow})
      .where(and(expired,sql`${jobs.attempts} >= ${DISTRICT_MAX_ATTEMPTS}`));
    await tx.update(jobs).set({status:"queued",leaseUntil:null,progress:0,error:"Återupptas efter processavbrott.",updatedAt:databaseNow})
      .where(and(expired,sql`${jobs.attempts} < ${DISTRICT_MAX_ATTEMPTS}`));
    await tx.update(jobs).set({status:"failed",leaseUntil:null,error:"Jobbet har nått omkörningsgränsen. Minska zonen och försök igen.",updatedAt:databaseNow})
      .where(and(processable,eq(jobs.status,"queued"),sql`${jobs.attempts} >= ${DISTRICT_MAX_ATTEMPTS}`));
    const [{n}]=await tx.select({n:count()}).from(jobs).where(eq(jobs.status,"running"));
    if(n>=DISTRICT_MAX_RUNNING) return null;
    for(;;) {
      // Least recently served ORGANIZATION, then FIFO within that organization.
      // Attempted-job history is durable across processes/restarts. Its latest
      // activity (claim, heartbeat, recovery or terminal write) records service.
      // Adding plans cannot improve this priority or obtain a second running slot.
      const [candidate]=await tx.select({job:jobs,organizationId:plans.organizationId}).from(jobs).innerJoin(plans,eq(plans.id,jobs.planId))
        .where(and(processable,eq(jobs.status,"queued"),sql`NOT EXISTS (
          SELECT 1 FROM district_jobs running_job JOIN district_plans running_plan ON running_plan.id = running_job.plan_id
          WHERE running_job.status = 'running' AND running_plan.organization_id = ${plans.organizationId}
        )`,sql`(${jobs.input}->'bulk' IS NULL OR NOT EXISTS (
          SELECT 1 FROM district_jobs bulk_job WHERE bulk_job.status='running' AND bulk_job.input->'bulk' IS NOT NULL
        ))`))
        .orderBy(sql`(
          SELECT max(history_job.updated_at) FROM district_jobs history_job
          JOIN district_plans history_plan ON history_plan.id = history_job.plan_id
          WHERE history_plan.organization_id = ${plans.organizationId} AND history_job.attempts > 0
        ) ASC NULLS FIRST`,jobs.createdAt,jobs.id).limit(1);
      if(!candidate) return null;
      // Match the mutation lock order (zone -> job), not job -> zone.
      const [zone]=await tx.select().from(zones).where(and(eq(zones.id,candidate.job.zoneId),eq(zones.planId,candidate.job.planId))).for("update").limit(1);
      const [job]=await tx.select().from(jobs).where(and(eq(jobs.id,candidate.job.id),eq(jobs.planId,candidate.job.planId))).for("update").limit(1);
      if(!job || job.status!=="queued") continue;
      const members=await tx.select({id:points.id,latitude:points.latitude,longitude:points.longitude}).from(points)
        .where(and(eq(points.planId,job.planId),job.input.bulk?.scope==="plan"?undefined:eq(points.zoneId,job.zoneId)));
      const byId=new Map(members.map(p=>[p.id,p]));
      const scopedInput=members.length>0 && members.length===job.input.points.length && new Set(job.input.points.map(p=>p.id)).size===members.length &&
        job.input.points.every(p=>{const member=byId.get(p.id);return member && member.latitude===p.latitude && member.longitude===p.longitude;});
      if(!zone || zone.deletedAt || zone.revision!==job.revision || !scopedInput) {
        await tx.update(jobs).set({status:"stale",leaseUntil:null,error:"Zonens innehåll eller plantillhörighet har ändrats. Optimera zonen på nytt.",updatedAt:databaseNow}).where(eq(jobs.id,job.id));
        continue;
      }
      const [updated]=await tx.update(jobs).set({status:"running",attempts:job.attempts+1,
        leaseUntil:sql`clock_timestamp() + ${DISTRICT_LEASE_MS} * interval '1 millisecond'`,updatedAt:databaseNow}).where(and(eq(jobs.id,job.id),eq(jobs.status,"queued"))).returning();
      return {...updated,organizationId:candidate.organizationId};
    }
  });
}

export async function heartbeatDistrictJob(claim:ClaimedDistrictJob,progress?:number,database:typeof db=db) {
  const updated=await database.update(jobs).set({leaseUntil:sql`clock_timestamp() + ${DISTRICT_LEASE_MS} * interval '1 millisecond'`,updatedAt:databaseNow,
    ...(progress===undefined?{}:{progress:Math.max(0,Math.min(99,Math.floor(progress)))})}).where(liveDistrictClaim(claim)).returning({id:jobs.id});
  return updated.length===1;
}

export async function isDistrictJobLive(claim:ClaimedDistrictJob,database:typeof db=db) {
  const [job]=await database.select({id:jobs.id}).from(jobs).where(liveDistrictClaim(claim)).limit(1);
  return !!job;
}

export async function finishDistrictJob(claim:ClaimedDistrictJob,result:DistrictResult,database:typeof db=db) {
  return database.transaction(async tx=>{
    // Bulk snapshots include all source rows. Serialize with plan/intake edits
    // before taking the zone lock; legacy small-job locking stays unchanged.
    if(claim.input.bulk)
      await tx.select({id:plans.id}).from(plans).where(and(eq(plans.id,claim.planId),eq(plans.organizationId,claim.organizationId))).for("update");
    // Zone lock makes revision validation atomic with result persistence.
    await tx.select({id:zones.id}).from(zones).where(and(eq(zones.id,claim.zoneId),eq(zones.planId,claim.planId))).for("update");
    const updated=await tx.update(jobs).set({status:"completed",result,progress:100,leaseUntil:null,error:null,updatedAt:databaseNow})
      .where(liveDistrictClaim(claim)).returning({id:jobs.id});
    return updated.length===1;
  });
}

export async function failDistrictJob(claim:ClaimedDistrictJob,error:string,database:typeof db=db) {
  const updated=await database.update(jobs).set({status:"failed",error,leaseUntil:null,updatedAt:databaseNow})
    .where(liveDistrictClaim(claim)).returning({id:jobs.id});
  return updated.length===1;
}
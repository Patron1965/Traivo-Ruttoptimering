import { and, eq, inArray, lt, sql, count } from "drizzle-orm";
import { db, districtJobsTable as jobs, districtZonesTable as zones, districtPlansTable as plans } from "@workspace/db";
import { solveDistrict } from "./district-solver";
import { sortDistrictQueueCandidates } from "./district-queue";
import { resolveBoundRoutingProvider, resolveDistrictBulkProvider } from "./routing-provider-config";
import { solveDistrictBulk, coordinateKey, type DistrictBulkDiagnostics } from "./district-bulk-solver";
import { logger } from "../lib/logger";
import { claimDistrictJob, heartbeatDistrictJob, isDistrictJobLive, finishDistrictJob, failDistrictJob } from "./district-capacity";

const LEGACY_BINDING_ERROR="Distriktsjobbet saknar en sparad leverantörsbindning. Kör om optimeringen för att skapa ett nytt jobb.";
const MAX_RUNNING=2, MAX_ATTEMPTS=2, LEASE_MS=60000;
let timer: ReturnType<typeof setInterval>|undefined;

let localClaimBusy=false;
export function startDistrictWorker() {
  if(timer) return;
  // Reclaim expired work on startup and on every tick. Competing processes
  // serialize claims under a transaction-scoped global advisory lock.
  timer=setInterval(()=>{void tickDistrictWorker().catch(error=>logger.error({error},"District worker tick failed"));},3000);
  timer.unref();
  void tickDistrictWorker().catch(error=>logger.error({error},"District worker startup failed"));
}
/** Legacy scoped queue-test entry point; production ticks use fenced claimDistrictJob below. */
export async function claimNextDistrictJob(organizationScope?:readonly string[]) {
  return db.transaction(async tx=>{
      const scoped=organizationScope?.length?Array.from(organizationScope):undefined;
      const scopeUuidList=scoped?sql.join(scoped.map(id=>sql`${id}::uuid`),sql`, `):undefined;
      const legacyScope=scoped?sql`${jobs.planId} IN (
        SELECT id FROM district_plans WHERE organization_id IN (${scopeUuidList})
      )`:undefined;
      const bindingScope=scoped?sql`AND bound_job.plan_id IN (
        SELECT id FROM district_plans WHERE organization_id IN (${scopeUuidList})
      )`:sql``;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(926104721)`);
      const now=new Date();
      await tx.update(jobs).set({status:"failed",error:"Jobbet hann inte klart inom omkörningsgränsen. Minska zonen och försök igen.",updatedAt:now}).where(and(eq(jobs.status,"running"),legacyScope,lt(jobs.leaseUntil,now),sql`${jobs.attempts} >= ${MAX_ATTEMPTS}`));
      await tx.update(jobs).set({status:"queued",progress:0,error:"Återupptas efter processavbrott.",updatedAt:now}).where(and(eq(jobs.status,"running"),legacyScope,lt(jobs.leaseUntil,now),sql`${jobs.attempts} < ${MAX_ATTEMPTS}`));
      // A provider must never be inferred from current organization settings for
      // pre-binding work. Fail it explicitly so the planner can submit a fresh job.
      await tx.update(jobs).set({status:"failed",error:LEGACY_BINDING_ERROR,leaseUntil:null,updatedAt:now})
        .where(and(inArray(jobs.status,["queued","running"]),legacyScope,sql`(${jobs.input}->'routingProvider'->'binding'->>'serverId' IS NULL OR ${jobs.input}->'routingProvider'->'binding'->>'configurationVersion' IS NULL)`));
      const activeRows=scoped
        ?await tx.select({n:count()}).from(jobs).innerJoin(plans,eq(jobs.planId,plans.id))
          .where(and(eq(jobs.status,"running"),inArray(plans.organizationId,scoped)))
        :await tx.select({n:count()}).from(jobs).where(eq(jobs.status,"running"));
      const [{n}]=activeRows;
      if(n>=MAX_RUNNING) return null;
      const candidates=await tx.select({
        job:jobs,organizationId:plans.organizationId,
        lastStartedAt:sql<Date|null>`(SELECT max((served.input->>'startedAt')::timestamptz)
          FROM district_jobs served
          JOIN district_plans served_plan ON served_plan.id=served.plan_id
          WHERE served_plan.organization_id=${plans.organizationId}
            AND served.input->>'startedAt' IS NOT NULL)`
          .mapWith(value=>value===null?null:value instanceof Date?value:new Date(String(value))),
      })
        .from(jobs).innerJoin(plans,eq(jobs.planId,plans.id))
        .where(and(eq(jobs.status,"queued"),scoped?inArray(plans.organizationId,scoped):undefined,sql`NOT EXISTS (
          SELECT 1 FROM district_jobs active_job
          JOIN district_plans active_plan ON active_plan.id=active_job.plan_id
          WHERE active_job.status='running' AND active_plan.organization_id=${plans.organizationId}
        ) AND (SELECT count(*) FROM district_jobs bound_job
          WHERE bound_job.status='running'
            AND bound_job.input->'routingProvider'->'binding'->>'serverId' =
              ${jobs.input}->'routingProvider'->'binding'->>'serverId' ${bindingScope}) < ${MAX_RUNNING}`))
        .orderBy(jobs.createdAt);
      const candidate=sortDistrictQueueCandidates(candidates.map(item=>({
        ...item,lastStartedAt:item.lastStartedAt===null?null:new Date(item.lastStartedAt),
        jobId:item.job.id,planId:item.job.planId,createdAt:item.job.createdAt,
      })))[0];
      const job=candidate?.job;
      if(!job) return null;
      const [lockedJob]=await tx.select().from(jobs).where(and(eq(jobs.id,job.id),eq(jobs.status,"queued")))
        .for("update",{skipLocked:true}).limit(1);
      if(!lockedJob) return null;
      const binding=(lockedJob.input as typeof lockedJob.input & {routingProvider?:{binding?:{serverId?:string}}}).routingProvider?.binding;
      if(!binding?.serverId) {
        await tx.update(jobs).set({status:"failed",error:LEGACY_BINDING_ERROR,updatedAt:now}).where(eq(jobs.id,lockedJob.id));
        return null;
      }
      const bindingRows=scoped
        ?await tx.select({forBinding:count()}).from(jobs).innerJoin(plans,eq(jobs.planId,plans.id))
          .where(and(eq(jobs.status,"running"),inArray(plans.organizationId,scoped),sql`${jobs.input}->'routingProvider'->'binding'->>'serverId' = ${binding.serverId}`))
        :await tx.select({forBinding:count()}).from(jobs)
          .where(and(eq(jobs.status,"running"),sql`${jobs.input}->'routingProvider'->'binding'->>'serverId' = ${binding.serverId}`));
      const [{forBinding}]=bindingRows;
      if(forBinding>=MAX_RUNNING) return null;
      const [zone]=await tx.select().from(zones).where(eq(zones.id,lockedJob.zoneId)).limit(1);
      if(!zone || zone.deletedAt || zone.revision!==lockedJob.revision) {
        await tx.update(jobs).set({status:"stale",error:"Zonen har ändrats sedan jobbet köades.",updatedAt:now}).where(eq(jobs.id,lockedJob.id));
        return null;
      }
      const startedInput={...lockedJob.input,startedAt:now.toISOString()} as typeof lockedJob.input;
      const [updated]=await tx.update(jobs).set({status:"running",input:startedInput,attempts:lockedJob.attempts+1,leaseUntil:new Date(now.getTime()+LEASE_MS),updatedAt:now}).where(eq(jobs.id,lockedJob.id)).returning();
      return {job:updated,organizationId:candidate.organizationId};
  });
}

/** Optional trusted in-process diagnostics; the normal scheduler supplies none. */
export async function tickDistrictWorker(diagnostics?: {
  onClaim?: (jobId: string) => void;
  onMeasurements?: (jobId: string, measurements: import("./district-solver").DistrictMeasurements) => void;
  bulk?: (jobId: string) => DistrictBulkDiagnostics;
}) {
  if(localClaimBusy || localActive.size>=2 || localBulkActive) return;
  localClaimBusy=true;
  let claimed;
  try {
    claimed=await claimDistrictJob();
    if(claimed) {localActive.add(`${claimed.id}:${claimed.attempts}`);if(claimed.input.bulk) localBulkActive=true;}
  } finally {localClaimBusy=false;}
  try {
    if(!claimed) return;
    diagnostics?.onClaim?.(claimed.id);
    const started=Date.now();
    const maxRuntime=claimed.input.bulk?30*60000:MAX_RUNTIME_MS;
    const abort=new AbortController();
    const deadline=setTimeout(()=>abort.abort(new Error("Distriktsjobbet överskred sin tidsbudget.")),maxRuntime);
    deadline.unref();
    const heartbeat=async(progress?:number)=>{
      if(Date.now()-started>=maxRuntime) {abort.abort();return;}
      if(!await heartbeatDistrictJob(claimed,progress)) abort.abort(new Error("Distriktsjobbet har avbrutits, ändrats eller förlorat sin körningstid."));
    };
    const interval=setInterval(()=>{void heartbeat().catch(error=>{
      abort.abort(error);
      logger.error({error,jobId:claimed.id},"District lease heartbeat failed");
    });},15000);
    interval.unref();
    try {
      const stored=claimed.input as typeof claimed.input & {routingProvider?:{binding?:{serverId:string;configurationVersion:string}};startedAt?:string};
      const binding=stored.routingProvider?.binding;
      if(!binding?.serverId || !binding.configurationVersion) throw new Error(LEGACY_BINDING_ERROR);
      const snapLimits=new Map(claimed.input.bulk?.exceptions.map(e=>{
        const point=claimed.input.points.find(p=>p.id===e.pointId);
        if(!point) throw new Error("Ett godkänt avståndsundantag saknar källpunkt.");
        return [coordinateKey(point),e.maxSnapMeters] as const;
      })??[]);
      const provider=claimed.input.bulk
        ? (await resolveDistrictBulkProvider(claimed.organizationId,binding,claimed.input.bulk.datasetIdentity,snapLimits)).provider
        : await resolveBoundRoutingProvider(claimed.organizationId,binding);
      const solveInput={...stored};
      delete solveInput.routingProvider;
      delete solveInput.startedAt;
      const callbacks={
        onProgress:heartbeat,
        isCancelled:async()=>{
          return Date.now()-started>maxRuntime || !await isDistrictJobLive(claimed);
        },
      };
      const options={signal:abort.signal,provider,
        onMeasurements:diagnostics?.onMeasurements ? (m:import("./district-solver").DistrictMeasurements)=>diagnostics.onMeasurements!(claimed.id,m) : undefined};
      const result=claimed.input.bulk?await solveDistrictBulk(solveInput,callbacks,options,claimed.input.bulk,diagnostics?.bulk?.(claimed.id))
        :await solveDistrict(solveInput,callbacks,options);
      const required=new Set(claimed.input.points.map(p=>p.id));
      if(result.orderedPointIds.length!==required.size || new Set(result.orderedPointIds).size!==required.size || result.orderedPointIds.some(id=>!required.has(id))) throw new Error("Vägoptimeringen täcker inte varje vald post exakt en gång.");
      if(!Number.isFinite(result.distanceMeters)||!Number.isFinite(result.driveSeconds)||!result.geometry.length) throw new Error("Vägoptimeringen saknar fullständig väggeometri eller kostnad.");
      await finishDistrictJob(claimed,result);
    } catch(error) {
      await failDistrictJob(claimed,error instanceof Error?error.message:String(error));
    } finally {clearInterval(interval);clearTimeout(deadline);}
  } finally {if(claimed) {localActive.delete(`${claimed.id}:${claimed.attempts}`);if(claimed.input.bulk) localBulkActive=false;}}
}

const MAX_RUNTIME_MS=10*60000;

const localActive=new Set<string>();
let localBulkActive=false;

import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, inArray, sql, count, desc } from "drizzle-orm";
import { db, organizationsTable, districtPlansTable as plans, districtPointsTable as points, districtZonesTable as zones, districtImportsTable as imports, districtJobsTable as jobs, districtExportsTable as exportsTable } from "@workspace/db";
import {
  CreateDistrictPlanBody, CreateDistrictPlanResponse, ListDistrictPlansResponse, GetDistrictPlanResponse,
  PreviewDistrictImportBody, PreviewDistrictImportResponse, ImportDistrictPointsBody, ImportDistrictPointsResponse,
  ListDistrictPointsResponse, CreateDistrictZoneBody, UpdateDistrictZoneBody, CreateDistrictZoneResponse, UpdateDistrictZoneResponse,
  DeleteDistrictZoneBody, StartDistrictJobBody, StartDistrictJobResponse, GetDistrictJobResponse,
  CancelDistrictJobResponse, CreateDistrictExportBody, CreateDistrictExportResponse, ListDistrictExportsResponse,
  PreviewDistrictBulkBody, PreviewDistrictBulkResponse,
} from "@workspace/api-zod";
import { getOrgId, assertOrgScope, OrgScopeError, requireRole, isUuidParam } from "../middleware/auth";
import { inspectDistrictRows, districtPayloadHash, assertDistrictSelection, safeDistrictCell, districtExportHeaders } from "../services/district-domain";
import { buildRoutePlanWorkbook } from "../lib/route-plan-xlsx";
import { resolveOrganizationRoutingProvider, resolveDistrictBulkProvider } from "../services/routing-provider-config";
import { assertDistrictJobAdmission, DistrictAdmissionError } from "../services/district-capacity";
import { prepareDistrictBulk } from "../services/district-bulk-input";
import { recordBulkPreview, validBulkPreview } from "../services/district-bulk-preview";
import { requireDistrictEntitlement } from "../middleware/district-entitlement";

const router: IRouter = Router();
router.use("/district-plans", requireDistrictEntitlement);
router.use("/district-plans", requireRole("admin","dispatcher","viewer"));
const write=requireRole("admin","dispatcher");
class DomainError extends Error { constructor(public status:number,message:string,public code:string="INVALID_REQUEST"){super(message);} }
const conflict=(message:string)=>new DomainError(409,message,"CONFLICT");
const missing=()=>new DomainError(404,"Distriktsplan eller post hittades inte.","NOT_FOUND");
function previewRows(rows:Parameters<typeof inspectDistrictRows>[0],mapping:Parameters<typeof inspectDistrictRows>[1]) {
  try {return inspectDistrictRows(rows,mapping);}
  catch(error) {throw new DomainError(400,error instanceof Error?error.message:"Ogiltiga källrader.");}
}
function parsed<T>(schema:{safeParse:(value:unknown)=>{success:true,data:T}|{success:false,error:{message:string}}}, value:unknown):T {
  const result=schema.safeParse(value);
  if(!result.success) throw new DomainError(400,result.error.message);
  return result.data;
}
function param(req:Request,name:string) {
  const value=req.params[name];
  if(typeof value!=="string" || !isUuidParam(value)) throw new DomainError(400,"Ogiltigt UUID: "+name);
  return value;
}
const scoped=(req:Request)=>eq(plans.organizationId,getOrgId(req));
async function plan(req:Request) {
  const [p]=await db.select().from(plans).where(and(eq(plans.id,param(req,"planId")),scoped(req))).limit(1);
  if(!p) throw missing();
  return p;
}
function handle(fn:(req:Request,res:Response)=>Promise<void>) {
  return async (req:Request,res:Response):Promise<void>=>{
    try {
      // Validate explicit hints before Zod strips unknown body fields. Scope is
      // always session/route-owned, including for read, cancel and file endpoints.
      assertOrgScope(req,req.body?.organizationId);
      assertOrgScope(req,req.query.organizationId);
      for(const supplied of [req.body?.planId,req.query.planId]) {
        if(supplied!=null && (typeof supplied!=="string" || supplied!==req.params.planId)) throw missing();
      }
      await fn(req,res);
    }
    catch(error) {
      if(error instanceof OrgScopeError) {res.status(error.statusCode).json({error:"Organisationen i begäran stämmer inte med din inloggade organisation.",code:"FORBIDDEN"});return;}
      if(error instanceof DomainError || error instanceof DistrictAdmissionError) {res.status(error.status).json({error:error.message,code:error.code});return;}
      if(error instanceof Error && "code" in error && (error as {code?:string}).code==="23505") {res.status(409).json({error:"Samtidig ändring. Ladda om och försök igen.",code:"CONFLICT"});return;}
      throw error;
    }
  };
}
const planJson=(p:typeof plans.$inferSelect)=>({id:p.id,name:p.name,revision:p.revision,createdAt:p.createdAt});
const jobJson=(j:typeof jobs.$inferSelect)=>({id:j.id,zoneId:j.zoneId,revision:j.revision,status:j.status,progress:j.progress,mode:j.input.mode,start:j.input.start,...(j.input.end?{end:j.input.end}:{}),serviceMinutes:j.input.serviceMinutes,...(j.input.bulk?{bulkScope:j.input.bulk.scope,datasetIdentity:j.input.bulk.datasetIdentity}:{}),...(j.result?{result:j.result}:{}),error:j.error,createdAt:j.createdAt});
const exportJson=(e:typeof exportsTable.$inferSelect)=>({id:e.id,jobId:e.jobId,actorId:e.actorId,pointIds:e.rows.filter(r=>r.routeOrder!==0).map(r=>r.pointId),createdAt:e.createdAt});
async function zoneJson(z:typeof zones.$inferSelect) {
  const members=await db.select({id:points.id}).from(points).where(and(eq(points.zoneId,z.id),eq(points.planId,z.planId)));
  return {id:z.id,name:z.name,color:z.color,revision:z.revision,pointIds:members.map(m=>m.id),polygon:z.polygon??null,deletedAt:z.deletedAt};
}
async function lockPlan(tx:Parameters<Parameters<typeof db.transaction>[0]>[0],id:string,org:string) {
  const [p]=await tx.select().from(plans).where(and(eq(plans.id,id),eq(plans.organizationId,org))).for("update").limit(1);
  if(!p) throw missing();
  return p;
}
router.get("/district-plans",handle(async(req,res)=>{
  const list=await db.select().from(plans).where(scoped(req)).orderBy(desc(plans.createdAt));
  res.json(ListDistrictPlansResponse.parse({plans:list.map(planJson)}));
}));
router.post("/district-plans",write,handle(async(req,res)=>{
  const body=parsed(CreateDistrictPlanBody,req.body);
  const [p]=await db.insert(plans).values({organizationId:getOrgId(req),name:body.name.trim()}).returning();
  res.status(201).json(CreateDistrictPlanResponse.parse(planJson(p)));
}));
router.get("/district-plans/:planId",handle(async(req,res)=>{
  const p=await plan(req);
  const [zs,im,js,ex]=await Promise.all([
    db.select().from(zones).where(and(eq(zones.planId,p.id),sql`${zones.deletedAt} IS NULL`)),
    db.select().from(imports).where(eq(imports.planId,p.id)),
    db.select().from(jobs).where(eq(jobs.planId,p.id)).orderBy(desc(jobs.createdAt)),
    db.select().from(exportsTable).where(eq(exportsTable.planId,p.id)).orderBy(desc(exportsTable.createdAt)),
  ]);
  res.json(GetDistrictPlanResponse.parse({plan:planJson(p),zones:await Promise.all(zs.map(zoneJson)),imports:im.map(i=>({id:i.id,total:i.total,valid:i.valid,rejected:i.rejected,revision:i.revision})),jobs:js.map(jobJson),exports:ex.map(exportJson)}));
}));
router.post("/district-plans/:planId/imports/preview",write,handle(async(req,res)=>{
  await plan(req);
  const body=parsed(PreviewDistrictImportBody,req.body);
  const {validRows,...preview}=previewRows(body.rows,body.mapping);
  res.json(PreviewDistrictImportResponse.parse(preview));
}));
router.post("/district-plans/:planId/imports",write,handle(async(req,res)=>{
  const p=await plan(req);
  const body=parsed(ImportDistrictPointsBody,req.body);
  const hash=districtPayloadHash({rows:body.rows,mapping:body.mapping});
  const preview=previewRows(body.rows,body.mapping);
  const imported=await db.transaction(async tx=>{
    const locked=await lockPlan(tx,p.id,getOrgId(req));
    const [prior]=await tx.select().from(imports).where(and(eq(imports.planId,p.id),eq(imports.sourceKey,body.sourceKey))).limit(1);
    if(prior) {
      if(prior.payloadHash!==hash) throw conflict("Källnyckeln används redan med annat innehåll.");
      return prior;
    }
    if(!preview.valid || (preview.rejected && !body.confirmValidOnly)) throw new DomainError(422,"Bekräfta import av enbart giltiga rader efter granskning.");
    const [existingImport]=await tx.select({id:imports.id}).from(imports).where(eq(imports.planId,p.id)).limit(1);
    if(existingImport) throw conflict("Grundunderlaget är redan importerat. Skapa en ny distriktsplan för en annan källfil.");
    const [existingZones]=await tx.select({n:count()}).from(zones).where(eq(zones.planId,p.id));
    const [existingJobs]=await tx.select({n:count()}).from(jobs).where(eq(jobs.planId,p.id));
    const [existingExports]=await tx.select({n:count()}).from(exportsTable).where(eq(exportsTable.planId,p.id));
    if(existingZones.n || existingJobs.n || existingExports.n) throw conflict("En plan med zoner, jobb eller uttag kan inte få ett nytt grundunderlag. Skapa en ny distriktsplan.");
    await tx.delete(points).where(eq(points.planId,p.id));
    const [entry]=await tx.insert(imports).values({planId:p.id,sourceKey:body.sourceKey,payloadHash:hash,total:preview.total,valid:preview.valid,rejected:preview.rejected,revision:locked.revision+1}).returning();
    for(let i=0;i<preview.validRows.length;i+=500) {
      await tx.insert(points).values(preview.validRows.slice(i,i+500).map(row=>({...row,planId:p.id,importId:entry.id})));
    }
    await tx.update(plans).set({revision:locked.revision+1}).where(eq(plans.id,p.id));
    return entry;
  });
  res.status(201).json(ImportDistrictPointsResponse.parse({id:imported.id,total:imported.total,valid:imported.valid,rejected:imported.rejected,revision:imported.revision}));
}));
router.get("/district-plans/:planId/points",handle(async(req,res)=>{
  const p=await plan(req);
  const limit=Number(req.query.limit??1000),offset=Number(req.query.offset??0);
  if(!Number.isInteger(limit)||limit<1||limit>6000||!Number.isInteger(offset)||offset<0) throw new DomainError(400,"Ogiltig sidindelning.");
  const [records,[totalRow],history]=await Promise.all([
    db.select().from(points).where(eq(points.planId,p.id)).orderBy(points.sourceRowNumber).limit(limit).offset(offset),
    db.select({n:count()}).from(points).where(eq(points.planId,p.id)),
    db.select({rows:exportsTable.rows}).from(exportsTable).where(eq(exportsTable.planId,p.id)),
  ]);
  const exported=new Set(history.flatMap(e=>e.rows.map(r=>r.pointId)));
  res.json(ListDistrictPointsResponse.parse({total:totalRow.n,points:records.map(r=>({id:r.id,sourceRowNumber:r.sourceRowNumber,objectNumber:r.objectNumber,address:r.address,latitude:r.latitude,longitude:r.longitude,original:req.user?.role==="viewer"?{}:r.original,zoneId:r.zoneId,exported:exported.has(r.id)}))}));
}));
async function changeZone(req:Request,existing:boolean) {
  const p=await plan(req);
  const body=parsed(existing?UpdateDistrictZoneBody:CreateDistrictZoneBody,req.body);
  const zoneId=existing?param(req,"zoneId"):undefined;
  return db.transaction(async tx=>{
    await lockPlan(tx,p.id,getOrgId(req));
    let old:typeof zones.$inferSelect|undefined;
    if(zoneId) {
      [old]=await tx.select().from(zones).where(and(eq(zones.id,zoneId),eq(zones.planId,p.id),sql`${zones.deletedAt} IS NULL`)).for("update").limit(1);
      if(!old) throw missing();
      if(old.revision!==(body as unknown as {expectedRevision:number}).expectedRevision) throw conflict("Zonrevisionen har ändrats. Ladda om.");
    }
    const selected=body.pointIds;
    if(new Set(selected).size!==selected.length) throw new DomainError(400,"Dubbletter i zonurval.");
    const selectedRows=selected.length?await tx.select().from(points).where(and(eq(points.planId,p.id),inArray(points.id,selected))):[];
    if(selectedRows.length!==selected.length) throw new DomainError(400,"En eller flera poster hör inte till distriktsplanen.");
    const conflicts=selectedRows.filter(row=>row.zoneId && row.zoneId!==zoneId).map(row=>row.id);
    if(conflicts.some(id=>!body.transfers?.includes(id))) throw conflict("Överlapp kräver uttrycklig flytt av alla berörda poster: "+conflicts.join(","));
    if(body.transfers?.some(id=>!conflicts.includes(id))) throw new DomainError(400,"Flyttlistan innehåller poster utan konflikt.");
    let z:typeof zones.$inferSelect;
    if(old) {
      [z]=await tx.update(zones).set({name:body.name.trim(),color:body.color,polygon:body.polygon??null,revision:old.revision+1}).where(eq(zones.id,old.id)).returning();
      await tx.update(points).set({zoneId:null}).where(and(eq(points.planId,p.id),eq(points.zoneId,old.id)));
    } else [z]=await tx.insert(zones).values({planId:p.id,name:body.name.trim(),color:body.color,polygon:body.polygon??null}).returning();
    if(selected.length) await tx.update(points).set({zoneId:z.id}).where(and(eq(points.planId,p.id),inArray(points.id,selected)));
    if(old) await tx.update(jobs).set({status:"stale",leaseUntil:null,updatedAt:new Date()}).where(and(eq(jobs.planId,p.id),eq(jobs.zoneId,old.id),inArray(jobs.status,["queued","running","completed"])));
    for(const priorZone of new Set(selectedRows.map(row=>row.zoneId).filter((id):id is string=>!!id&&id!==zoneId))) {
      await tx.update(zones).set({revision:sql`${zones.revision}+1`}).where(and(eq(zones.id,priorZone),eq(zones.planId,p.id)));
      await tx.update(jobs).set({status:"stale",leaseUntil:null,updatedAt:new Date()}).where(and(eq(jobs.planId,p.id),eq(jobs.zoneId,priorZone),inArray(jobs.status,["queued","running","completed"])));
    }
    return {id:z.id,name:z.name,color:z.color,revision:z.revision,pointIds:selected,polygon:z.polygon,deletedAt:null};
  });
}
router.post("/district-plans/:planId/zones",write,handle(async(req,res)=>{res.status(201).json(CreateDistrictZoneResponse.parse(await changeZone(req,false)));}));
router.put("/district-plans/:planId/zones/:zoneId",write,handle(async(req,res)=>{res.json(UpdateDistrictZoneResponse.parse(await changeZone(req,true)));}));
router.delete("/district-plans/:planId/zones/:zoneId",write,handle(async(req,res)=>{
  const p=await plan(req),zoneId=param(req,"zoneId"),body=parsed(DeleteDistrictZoneBody,req.body);
  await db.transaction(async tx=>{
    await lockPlan(tx,p.id,getOrgId(req));
    const [old]=await tx.select().from(zones).where(and(eq(zones.id,zoneId),eq(zones.planId,p.id),sql`${zones.deletedAt} IS NULL`)).for("update");
    if(!old) throw missing();
    if(old.revision!==body.expectedRevision) throw conflict("Zonrevisionen har ändrats.");
    await tx.update(points).set({zoneId:null}).where(and(eq(points.planId,p.id),eq(points.zoneId,zoneId)));
    await tx.update(zones).set({deletedAt:new Date(),revision:old.revision+1}).where(eq(zones.id,zoneId));
    await tx.update(jobs).set({status:"stale",leaseUntil:null,updatedAt:new Date()}).where(and(eq(jobs.planId,p.id),eq(jobs.zoneId,zoneId),inArray(jobs.status,["queued","running","completed"])));
  });
  res.sendStatus(204);
}));
const assertBulkEndpoints=(body:{mode:string;start:{pointId?:string;latitude?:number;longitude?:number};end?:unknown})=>{
  if(body.mode!=="open" || body.end || body.start.pointId || !Number.isFinite(body.start.latitude) ||
    !Number.isFinite(body.start.longitude) || Math.abs(body.start.latitude!)>90 || Math.abs(body.start.longitude!)>180)
    throw new DomainError(422,"Stor vägoptimering kräver en extern kartstart, fritt sista stopp och ingen depotretur.");
};
// Preflights share a process-wide bound; no matrix allocation and no paid/geocoding calls.
let bulkPreviewActive=false;
router.post("/district-plans/:planId/zones/:zoneId/bulk-preview",write,handle(async(req,res)=>{
  const p=await plan(req),zoneId=param(req,"zoneId"),body=parsed(PreviewDistrictBulkBody,req.body);
  if(!body.bulkScope) throw new DomainError(422,"Välj zon eller hela underlaget.");
  assertBulkEndpoints(body);
  const [zone]=await db.select().from(zones).where(and(eq(zones.id,zoneId),eq(zones.planId,p.id),sql`${zones.deletedAt} IS NULL`));
  if(!zone) throw missing();
  if(zone.revision!==body.expectedRevision) throw conflict("Zonen har ändrats.");
  if(bulkPreviewActive) throw new DomainError(429,"En positionskontroll pågår. Försök igen när den är klar.","QUEUE_FULL");
  bulkPreviewActive=true;
  const abort=new AbortController();
  const disconnected=()=>abort.abort();
  res.on("close",disconnected);
  const deadline=setTimeout(()=>abort.abort(),120000);
  try {
    let routing:Awaited<ReturnType<typeof resolveOrganizationRoutingProvider>>;
    let approved:Awaited<ReturnType<typeof resolveDistrictBulkProvider>>;
    try {
      routing=await resolveOrganizationRoutingProvider(p.organizationId);
      approved=await resolveDistrictBulkProvider(p.organizationId,routing.binding);
    } catch(error) {throw new DomainError(503,error instanceof Error?error.message:"Godkänd bulkleverantör saknas.","ROUTING_UNAVAILABLE");}
    const prepared=await prepareDistrictBulk(db,p.id,zoneId,body.bulkScope,body.start,approved.datasetIdentity,body.distanceExceptions??[])
      .catch(error=>{throw new DomainError(422,error instanceof Error?error.message:"Ogiltigt underlag.");});
    const bulk=await resolveDistrictBulkProvider(p.organizationId,routing.binding,approved.datasetIdentity,prepared.snapLimits);
    const warnings=[
      `${prepared.snapshot.sourceRows.length} källrader; ${prepared.members.length} positionerade objekt. Samplacerade objekt bevaras separat.`,
      `${prepared.capacity.uniqueCoordinates} unika positioner; ${Math.ceil(prepared.capacity.matrixBytes/1048576)} MiB vägmatris; ${prepared.capacity.tableRequests} blockanrop. Ett stort jobb åt gången, högst 30 minuter.`,
      `${prepared.snapshot.sourceRows.filter(r=>!r.pointId).length} olösta/avvisade rader bevaras utan vägordning. Ingen automatisk geokodning.`,
      "Väganknytning är inte bevis för körbar anslutning till fastigheten. Kontrollera öar och avvikande positioner. Originalkoordinater ändras aldrig.",
      ...prepared.snapshot.exceptions.map(e=>`Godkänt undantag ${e.pointId}: ${e.maxSnapMeters} meter — ${e.reason}`),
    ];
    let ready=prepared.capacity.allowed;
    if(!ready) warnings.push("Kapacitetsgränsen är 768 MiB matris, 1600 blockanrop och 20000 källrader. Dela upp underlaget; inga rader har tagits bort.");
    if(ready) {
      try {
        const coordinates=[body.start as {latitude:number;longitude:number},...prepared.members];
        for(let from=0;from<coordinates.length;from+=200) {
          const block=coordinates.slice(from,from+200);
          const table=await bulk.provider.table(block,block,AbortSignal.any([abort.signal,AbortSignal.timeout(20000)]));
          if(![table.distances,table.durations].every(matrix=>matrix.length===block.length &&
            matrix.every(row=>row.length===block.length && row.every(value=>typeof value==="number" && Number.isFinite(value) && value>=0))))
            throw new Error("Positionskontrollen saknar fullständiga bilvägsförbindelser i ett block. Kontrollera öar och vägtäckning före start.");
        }
      } catch(error) {
        ready=false;
        warnings.push(error instanceof Error?error.message:"Positionskontrollen misslyckades.");
      }
    }
    res.json(PreviewDistrictBulkResponse.parse({ready,sourceCount:prepared.snapshot.sourceRows.length,
      positionedCount:prepared.members.length,unresolvedCount:prepared.snapshot.sourceRows.filter(r=>!r.pointId).length,
      matrixBytes:prepared.capacity.matrixBytes,tableRequests:prepared.capacity.tableRequests,warnings,
      ...(ready?{previewHash:recordBulkPreview(p.organizationId,p.id,zoneId,prepared.snapshot.sourceHash,routing.binding),datasetIdentity:approved.datasetIdentity}:{})}));
  } finally {bulkPreviewActive=false;clearTimeout(deadline);res.off("close",disconnected);}
}));
router.post("/district-plans/:planId/zones/:zoneId/jobs",write,handle(async(req,res)=>{
  const p=await plan(req),zoneId=param(req,"zoneId"),body=parsed(StartDistrictJobBody,req.body);
  const record=await db.transaction(async tx=>{
    await assertDistrictJobAdmission(tx,getOrgId(req));
    await lockPlan(tx,p.id,getOrgId(req));
    // The same organization row serializes admissions across its plans and also
    // coordinates provider-preference updates before resolving the snapshot.
    const [organization]=await tx.select({id:organizationsTable.id}).from(organizationsTable)
      .where(eq(organizationsTable.id,p.organizationId)).for("update").limit(1);
    if(!organization) throw missing();
    const [{pending}]=await tx.select({pending:count()}).from(jobs)
      .innerJoin(plans,eq(jobs.planId,plans.id))
      .where(and(eq(plans.organizationId,p.organizationId),inArray(jobs.status,["queued","running"])));
    if(pending>=5) throw new DomainError(429,"Högst fem pågående distriktsjobb per organisation. Vänta tills ett jobb är klart.","QUEUE_FULL");
    let routing:Awaited<ReturnType<typeof resolveOrganizationRoutingProvider>>;
    try {routing=await resolveOrganizationRoutingProvider(p.organizationId,tx);}
    catch(error) {throw new DomainError(503,error instanceof Error?error.message:"Vägdataleverantör saknas.","ROUTING_UNAVAILABLE");}
    const [zone]=await tx.select().from(zones).where(and(eq(zones.id,zoneId),eq(zones.planId,p.id),sql`${zones.deletedAt} IS NULL`)).for("update");
    if(!zone) throw missing();
    if(zone.revision!==body.expectedRevision) throw conflict("Zonrevisionen har ändrats.");
    let members=await tx.select({id:points.id,latitude:points.latitude,longitude:points.longitude}).from(points).where(and(eq(points.zoneId,zoneId),eq(points.planId,p.id))).orderBy(points.sourceRowNumber);
    let bulk:Awaited<ReturnType<typeof prepareDistrictBulk>>|undefined;
    if(body.bulkScope) {
      assertBulkEndpoints(body);
      const approved=await resolveDistrictBulkProvider(p.organizationId,routing.binding)
        .catch(error=>{throw new DomainError(503,error instanceof Error?error.message:"Godkänd bulkleverantör saknas.","ROUTING_UNAVAILABLE");});
      bulk=await prepareDistrictBulk(tx,p.id,zoneId,body.bulkScope,body.start,approved.datasetIdentity,body.distanceExceptions??[])
        .catch(error=>{throw new DomainError(422,error instanceof Error?error.message:"Ogiltigt underlag.");});
      if(!bulk.capacity.allowed) throw new DomainError(422,"Underlaget överskrider den stora motorns kapacitetsbudget.","CAPACITY_EXCEEDED");
      if(!validBulkPreview(body.bulkPreviewHash,p.organizationId,p.id,zoneId,bulk.snapshot.sourceHash,routing.binding))
        throw conflict("Gör om kapacitets- och positionskontrollen och godkänn varningarna för aktuellt underlag.");
      members=bulk.members.map(({id,latitude,longitude})=>({id,latitude,longitude}));
    }
    if(!members.length) throw new DomainError(422,"Zonen saknar poster.");
    if(!bulk && members.length>750) throw new DomainError(422,`Zonen innehåller ${members.length} poster. Välj stor vägoptimering eller dela upp den (max 750 i den vanliga motorn).`,"CAPACITY_EXCEEDED");
    const validateLocation=(v:{pointId?:string,latitude?:number,longitude?:number}|undefined,label:string)=>{
      if(!v) return;
      if(v.pointId) {
        if(v.latitude!==undefined || v.longitude!==undefined || !members.some(m=>m.id===v.pointId)) throw new DomainError(400,`${label} måste vara en post i zonen eller en kartkoordinat.`);
      } else if(typeof v.latitude!=="number" || typeof v.longitude!=="number" || !Number.isFinite(v.latitude)||!Number.isFinite(v.longitude)||Math.abs(v.latitude)>90||Math.abs(v.longitude)>180) throw new DomainError(400,`${label} måste ha WGS84 latitud och longitud.`);
    };
    validateLocation(body.start,"Startpunkt");
    validateLocation(body.end,"Slutpunkt");
    if(body.mode==="loop" && body.end) throw new DomainError(400,"Sluten slinga har ingen separat slutpunkt.");
    const input={points:members,mode:body.mode,start:body.start,end:body.end,serviceMinutes:body.serviceMinutes??0,
      ...(bulk?{bulk:bulk.snapshot}:{}),routingProvider:{binding:routing.binding}} as typeof jobs.$inferSelect["input"];
    const [previous]=await tx.select().from(jobs).where(and(eq(jobs.planId,p.id),eq(jobs.zoneId,zoneId))).orderBy(desc(jobs.createdAt)).limit(1);
    const config=(v:typeof jobs.$inferSelect["input"])=>JSON.stringify({mode:v.mode,start:v.start,end:v.end??null,serviceMinutes:v.serviceMinutes,...(v.bulk?{bulkScope:v.bulk.scope,exceptions:v.bulk.exceptions}:{})});
    const revision=previous && config(previous.input)!==config(input)?zone.revision+1:zone.revision;
    if(revision!==zone.revision) {
      await tx.update(zones).set({revision}).where(eq(zones.id,zoneId));
      await tx.update(jobs).set({status:"stale",leaseUntil:null,updatedAt:new Date()}).where(and(eq(jobs.planId,p.id),eq(jobs.zoneId,zoneId),inArray(jobs.status,["queued","running","completed"])));
    }
    const [job]=await tx.insert(jobs).values({planId:p.id,zoneId,revision,input}).returning();
    return job;
  });
  res.status(201).json(StartDistrictJobResponse.parse(jobJson(record)));
}));
router.get("/district-plans/:planId/jobs/:jobId",handle(async(req,res)=>{
  const p=await plan(req);
  const [job]=await db.select().from(jobs).where(and(eq(jobs.id,param(req,"jobId")),eq(jobs.planId,p.id)));
  if(!job) throw missing();
  res.json(GetDistrictJobResponse.parse({job:jobJson(job),...(job.result?{result:job.result}:{})}));
}));
router.post("/district-plans/:planId/jobs/:jobId/cancel",write,handle(async(req,res)=>{
  const p=await plan(req);
  const [job]=await db.update(jobs).set({status:"cancelled",updatedAt:new Date(),leaseUntil:null}).where(and(eq(jobs.id,param(req,"jobId")),eq(jobs.planId,p.id),inArray(jobs.status,["queued","running"]))).returning();
  if(!job) {
    const [prior]=await db.select().from(jobs).where(and(eq(jobs.id,param(req,"jobId")),eq(jobs.planId,p.id)));
    if(!prior) throw missing();
    res.status(409).json({error:"Endast köade eller pågående jobb kan avbrytas.",code:"CONFLICT"});return;
  }
  res.json(CancelDistrictJobResponse.parse({job:jobJson(job)}));
}));
router.post("/district-plans/:planId/jobs/:jobId/exports",write,handle(async(req,res)=>{
  const p=await plan(req),jobId=param(req,"jobId"),body=parsed(CreateDistrictExportBody,req.body);
  const response=await db.transaction(async tx=>{
    await lockPlan(tx,p.id,getOrgId(req));
    const [reference]=await tx.select({zoneId:jobs.zoneId}).from(jobs).where(and(eq(jobs.id,jobId),eq(jobs.planId,p.id)));
    if(!reference) throw missing();
    const [zone]=await tx.select().from(zones).where(and(eq(zones.id,reference.zoneId),eq(zones.planId,p.id))).for("update");
    const [job]=await tx.select().from(jobs).where(and(eq(jobs.id,jobId),eq(jobs.planId,p.id))).for("update");
    if(!job || !job.result) throw missing();
    if(job.status!=="completed" || !zone || zone.deletedAt || zone.revision!==job.revision) throw conflict("Resultatet är inaktuellt. Optimera zonen på nytt före uttag.");
    if(job.input.bulk) {
      const current=await prepareDistrictBulk(tx,p.id,job.zoneId,job.input.bulk.scope,job.input.start,job.input.bulk.datasetIdentity,job.input.bulk.exceptions);
      if(current.snapshot.sourceHash!==job.input.bulk.sourceHash) throw conflict("Underlaget har ändrats. Beräkna ett nytt stort jobb före uttag.");
    }
    try {assertDistrictSelection(job.result.orderedPointIds,body.pointIds,job.input.mode);}
    catch(e) {throw new DomainError(422,(e as Error).message);}
    const members=await tx.select().from(points).where(and(eq(points.planId,p.id),inArray(points.id,body.pointIds)));
    if(members.length!==body.pointIds.length || (job.input.bulk?.scope!=="plan" && members.some(m=>m.zoneId!==job.zoneId))) throw conflict("Zonmedlemskapet har ändrats.");
    const byId=new Map(members.map(m=>[m.id,m]));
    const fullBulk=!!job.input.bulk && body.pointIds.length===job.result.orderedPointIds.length;
    const columns=fullBulk?[...new Set(job.input.bulk!.sourceRows.flatMap(r=>Object.keys(r.original)))]:body.columns;
    if(!fullBulk && (body.columns.some(c=>!members.every(m=>Object.hasOwn(m.original,c))) || new Set(body.columns).size!==body.columns.length)) throw new DomainError(400,"Valda originalkolumner saknas i källunderlaget.");
    const previous=await tx.select({rows:exportsTable.rows}).from(exportsTable).where(eq(exportsTable.planId,p.id));
    const seen=new Set(previous.flatMap(e=>e.rows.map(r=>r.pointId)));
    const overlapPointIds=body.pointIds.filter(id=>seen.has(id));
    if(overlapPointIds.length && !body.confirmReexport) throw new DomainError(409,`Posterna har redan exporterats: ${overlapPointIds.join(",")}. Bekräfta omexport.`,"REEXPORT_CONFIRMATION_REQUIRED");
    const rows:typeof exportsTable.$inferSelect["rows"]=body.pointIds.map((id,i)=>{
      const m=byId.get(id)!;
      const source=job.input.bulk?.sourceRows.find(r=>r.pointId===id);
      const exception=job.input.bulk?.exceptions.find(e=>e.pointId===id);
      return {pointId:id,objectNumber:m.objectNumber,sourceRowNumber:m.sourceRowNumber,routeOrder:job.result!.orderedPointIds.indexOf(id)+1,exportOrder:i+1,
        original:Object.fromEntries(columns.map(c=>[c,(source?.original??m.original)[c]??""])),
        ...(job.input.bulk?{sourceStatus:"ready",reason:"",datasetIdentity:job.input.bulk.datasetIdentity,
          distanceException:exception?`${exception.maxSnapMeters} m: ${exception.reason}`:""}:{})};
    });
    // A full bulk extraction includes every unresolved source row from the immutable
    // input, never reconstructed from today's intake. Partial route extracts stay partial.
    if(fullBulk && job.input.bulk) {
      for(const row of job.input.bulk.sourceRows.filter(r=>!r.pointId)) {
        rows.push({pointId:row.id,objectNumber:row.objectNumber,sourceRowNumber:row.sourceRowNumber,routeOrder:0,
          exportOrder:rows.length+1,original:Object.fromEntries(columns.map(c=>[c,row.original[c]??""])),
          sourceStatus:row.status,reason:row.reason,datasetIdentity:job.input.bulk.datasetIdentity,distanceException:""});
      }
    }
    const [saved]=await tx.insert(exportsTable).values({planId:p.id,jobId:job.id,actorId:req.user!.id,columns,rows}).returning();
    return {export:exportJson(saved),overlapPointIds};
  });
  res.status(201).json(CreateDistrictExportResponse.parse(response));
}));
router.get("/district-plans/:planId/exports",handle(async(req,res)=>{
  const p=await plan(req);
  const history=await db.select().from(exportsTable).where(eq(exportsTable.planId,p.id)).orderBy(desc(exportsTable.createdAt));
  res.json(ListDistrictExportsResponse.parse({exports:history.map(exportJson)}));
}));
router.get("/district-plans/:planId/exports/:exportId/file",requireRole("admin","dispatcher"),handle(async(req,res)=>{
  const p=await plan(req),id=param(req,"exportId"),format=req.query.format;
  if(format!=="csv" && format!=="xlsx") throw new DomainError(400,"Ange format csv eller xlsx.");
  const [snapshot]=await db.select().from(exportsTable).where(and(eq(exportsTable.id,id),eq(exportsTable.planId,p.id)));
  if(!snapshot) throw missing();
  const headers=districtExportHeaders(snapshot.columns);
  const bulkHeaders=snapshot.rows.some(r=>r.datasetIdentity)?["Källstatus","Positionsvarning","Vägdataversion","Godkänt avståndsundantag"].map(label=>{
    let header=label;
    while(headers.includes(header)) header=`${header} (beräkning)`;
    return header;
  }):[];
  const rows=snapshot.rows.map(r=>({...Object.fromEntries(headers.map((h,i)=>[h,safeDistrictCell(String(i===0?r.objectNumber:i===1?r.sourceRowNumber:i===2?r.routeOrder:i===3?r.exportOrder:r.original[snapshot.columns[i-4]]??""))])),
    ...Object.fromEntries(bulkHeaders.map((h,i)=>[h,safeDistrictCell([r.sourceStatus,r.reason,r.datasetIdentity,r.distanceException][i]??"")]))}));
  headers.push(...bulkHeaders);
  res.setHeader("Cache-Control","private, no-store");
  res.setHeader("Content-Disposition",`attachment; filename="distrikt-${snapshot.id}.${format}"`);
  if(format==="csv") {
    const escape=(value:string)=>`"${value.replace(/"/g,'""')}"`;
    const text="\uFEFF"+[headers.map(escape).join(";"),...rows.map(r=>headers.map(h=>escape(r[h])).join(";"))].join("\r\n")+"\r\n";
    res.type("text/csv; charset=utf-8").send(text);
  } else {
    const workbook=await buildRoutePlanWorkbook([{name:"Distriktsuttag",rows,preferredColumns:headers}]);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(workbook);
  }
}));
export default router;
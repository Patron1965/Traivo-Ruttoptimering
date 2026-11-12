import { Router, type Request, type Response } from "express";
import { and,eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { ZodError as GeneratedZodError } from "zod";
import { TransferDistrictIntakeBody,SearchDistrictIntakeAddressBody,AcceptDistrictIntakeAddressBody,GetDistrictIntakeResponse,ListDistrictIntakeSourcesResponse } from "@workspace/api-zod";
import { db,districtPlansTable as plans,districtImportsTable as imports,districtIntakesTable as intakes,districtPointsTable as points,planningDraftsTable as drafts,type DistrictIntakeRow } from "@workspace/db";
import { requireRole,getOrgId } from "../middleware/auth";
import { intakeBody,intakeMapping,inspectIntake,draftIntake,intakeSummary,validIntakeCoordinate } from "../services/district-intake";
import { districtPayloadHash } from "../services/district-domain";
import { geocodeDetailed } from "../services/geocoding";
import { requireDistrictEntitlement } from "../middleware/district-entitlement";

const router=Router();
router.use(["/district-plans", "/district-intake"], requireDistrictEntitlement);
const role=requireRole("admin","dispatcher");
type Tx=Parameters<Parameters<typeof db.transaction>[0]>[0];
class IntakeError extends Error {constructor(public status:number,message:string){super(message);}}
function handler(fn:(req:Request,res:Response)=>Promise<void>){
  return async(req:Request,res:Response)=>{try{await fn(req,res);}catch(e){if(e instanceof IntakeError){res.status(e.status).json({error:e.message,code:e.status===409?"CONFLICT":"INVALID_REQUEST"});return;}if(e instanceof z.ZodError||e instanceof GeneratedZodError){res.status(400).json({error:"Ogiltigt underlag.",code:"INVALID_REQUEST"});return;}throw e;}};
}
function id(req:Request){return z.guid().parse(req.params.planId);}
async function lock(tx:Tx,req:Request){
  const [plan]=await tx.select().from(plans).where(and(eq(plans.id,id(req)),eq(plans.organizationId,getOrgId(req)))).for("update");
  if(!plan)throw new IntakeError(404,"Distriktsplanen hittades inte.");return plan;
}
async function scopedPlan(req:Request){
  const [plan]=await db.select().from(plans).where(and(eq(plans.id,id(req)),eq(plans.organizationId,getOrgId(req))));
  if(!plan)throw new IntakeError(404,"Distriktsplanen hittades inte.");return plan;
}
function build(fn:()=>DistrictIntakeRow[]){try{return fn();}catch(e){throw new IntakeError(422,e instanceof Error?e.message:"Källraderna kan inte stämmas av.");}}
async function promote(tx:Tx,planId:string,importId:string,rows:DistrictIntakeRow[]){
  const ready=rows.filter(r=>r.status==="ready"&&!r.pointId);
  for(const r of ready)r.pointId=randomUUID();
  for(let i=0;i<ready.length;i+=500)await tx.insert(points).values(ready.slice(i,i+500).map(r=>({id:r.pointId!,planId,importId,sourceRowNumber:r.sourceRowNumber,objectNumber:r.objectNumber,address:r.address,latitude:r.latitude!,longitude:r.longitude!,original:r.original})));
}
async function create(tx:Tx,req:Request,sourceKey:string,hash:string,rows:DistrictIntakeRow[],draftId?:string,draftRevision?:number){
  const p=await lock(tx,req);
  const [prior]=await tx.select().from(intakes).where(eq(intakes.planId,p.id));
  if(prior){if(prior.sourceKey!==sourceKey||prior.payloadHash!==hash)throw new IntakeError(409,"Planen har redan ett annat underlag.");return prior;}
  const [existing]=await tx.select().from(imports).where(eq(imports.planId,p.id));
  if(existing)throw new IntakeError(409,"Planen har redan ett underlag. Skapa en ny plan.");
  const summary=intakeSummary({rows});
  const [entry]=await tx.insert(imports).values({planId:p.id,sourceKey,payloadHash:hash,total:summary.total,valid:summary.ready,rejected:summary.unresolved+summary.rejected,revision:p.revision+1}).returning();
  await promote(tx,p.id,entry.id,rows);
  const [intake]=await tx.insert(intakes).values({planId:p.id,sourceKey,payloadHash:hash,rows,sourceDraftId:draftId,sourceDraftRevision:draftRevision}).returning();
  await tx.update(plans).set({revision:p.revision+1}).where(eq(plans.id,p.id));return intake;
}
router.get("/district-intake/sources",role,handler(async(req,res)=>{
  const list=await db.select().from(drafts).where(eq(drafts.organizationId,getOrgId(req)));
  res.json(ListDistrictIntakeSourcesResponse.parse({sources:list.map(d=>{const p=d.state.parsedData as {headers?:unknown,sourceRowCount?:unknown}|undefined;return{id:d.id,name:d.name,revision:d.revision,headers:p?.headers??[],sourceRowCount:p?.sourceRowCount??0,mappedRowCount:Array.isArray(d.state.mappedRows)?d.state.mappedRows.length:0};})}));
}));
router.get("/district-plans/:planId/intake",role,handler(async(req,res)=>{
  await scopedPlan(req);const [intake]=await db.select().from(intakes).where(eq(intakes.planId,id(req)));
  res.json(GetDistrictIntakeResponse.parse({intake:intake?intakeSummary(intake):null}));
}));
router.post("/district-plans/:planId/intake",role,handler(async(req,res)=>{
  const body=intakeBody.parse(req.body);
  const rows=build(()=>inspectIntake(body.rows,body.mapping));
  const intake=await db.transaction(tx=>create(tx,req,body.sourceKey,districtPayloadHash(body),rows));
  res.json(GetDistrictIntakeResponse.parse({intake:intakeSummary(intake)}));
}));
router.post("/district-plans/:planId/intake/from-draft",role,handler(async(req,res)=>{
  const body=TransferDistrictIntakeBody.parse(req.body);
  const intake=await db.transaction(async tx=>{
    await lock(tx,req);
    const [draft]=await tx.select().from(drafts).where(and(eq(drafts.id,body.draftId),eq(drafts.organizationId,getOrgId(req)))).for("share");
    if(!draft)throw new IntakeError(404,"Importutkastet hittades inte.");
    const [prior]=await tx.select().from(intakes).where(eq(intakes.planId,id(req)));
    if(prior&&prior.sourceDraftId===body.draftId&&prior.sourceDraftRevision===body.revision&&prior.payloadHash===districtPayloadHash(body))return prior;
    if(draft.revision!==body.revision)throw new IntakeError(409,"Importutkastet har ändrats. Läs om underlaget.");
    return create(tx,req,`draft:${draft.id}:${draft.revision}`,districtPayloadHash(body),build(()=>draftIntake(draft.state,body.mapping)),draft.id,draft.revision);
  });res.json(GetDistrictIntakeResponse.parse({intake:intakeSummary(intake)}));
}));
const editBody=z.object({revision:z.number().int().nonnegative(),address:z.string().trim().min(1).max(1000).optional(),candidateIndex:z.number().int().nonnegative().optional(),objectNumber:z.string().trim().min(1).max(500).optional()});
for(const action of ["search","accept"] as const)router.post(`/district-plans/:planId/intake/rows/:sourceRowNumber/${action}`,role,handler(async(req,res)=>{
  const body=editBody.parse((action==="search"?SearchDistrictIntakeAddressBody:AcceptDistrictIntakeAddressBody).parse(req.body)),number=z.coerce.number().int().positive().parse(req.params.sourceRowNumber);
  const intake=await db.transaction(async tx=>{
    const p=await lock(tx,req);
    const [current]=await tx.select().from(intakes).where(eq(intakes.planId,p.id)).for("update");
    if(!current)throw new IntakeError(404,"Underlaget hittades inte.");
    if(current.revision!==body.revision)throw new IntakeError(409,"Underlaget har ändrats. Läs om.");
    const row=current.rows.find(r=>r.sourceRowNumber===number);
    if(!row)throw new IntakeError(404,"Källraden hittades inte.");
    if(row.status==="ready")throw new IntakeError(409,"Granskade koordinater ersätts inte.");
    if(row.status==="rejected")throw new IntakeError(422,"Källradens strukturfel måste rättas i en ny grundfil.");
    if(action==="search"){
      const address=body.address??row.address;
      if(!address)throw new IntakeError(422,"Ange adress.");
      // Plan + intake row locks remain held across this bounded provider lookup.
      // Concurrent search/accept operations wait, then fail their revision check;
      // an old provider response can never overwrite a newer accepted row.
      const result=await geocodeDetailed(address,"se");
      if(result.status==="provider_unavailable")throw new IntakeError(503,"Geokodningstjänsten är inte tillgänglig.");
      row.address=address;
      row.candidates=(result.candidates.length?result.candidates:result.result?[result.result]:[]).filter(c=>validIntakeCoordinate(c.latitude,c.longitude)).map(c=>({latitude:c.latitude,longitude:c.longitude,displayName:c.displayName}));
      row.reason=row.candidates.length?"Välj och bekräfta en adressträff.":"Ingen adressträff. Kontrollera adressen.";
    }else{
      const candidate=body.candidateIndex===undefined?undefined:row.candidates?.[body.candidateIndex];
      if(!candidate)throw new IntakeError(422,"Välj en aktuell adressträff.");
      row.objectNumber=body.objectNumber??row.objectNumber;
      if(!row.objectNumber)throw new IntakeError(422,"Ange objektnummer.");
      row.latitude=candidate.latitude;row.longitude=candidate.longitude;row.status="ready";row.reason="";delete row.candidates;
      const [entry]=await tx.select().from(imports).where(eq(imports.planId,p.id));
      await promote(tx,p.id,entry.id,current.rows);
      const summary=intakeSummary(current);
      await tx.update(imports).set({valid:summary.ready,rejected:summary.unresolved+summary.rejected}).where(eq(imports.id,entry.id));
      await tx.update(plans).set({revision:p.revision+1}).where(eq(plans.id,p.id));
    }
    // Intake-only edits also change the immutable source snapshot of a whole-plan bulk job.
    if(action!=="accept") await tx.update(plans).set({revision:p.revision+1}).where(eq(plans.id,p.id));
    const [updated]=await tx.update(intakes).set({rows:current.rows,revision:current.revision+1}).where(eq(intakes.id,current.id)).returning();return updated;
  });res.json(GetDistrictIntakeResponse.parse({intake:intakeSummary(intake)}));
}));
export default router;
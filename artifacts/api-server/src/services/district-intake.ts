import { z } from "zod";
import { CreateDistrictIntakeBody } from "@workspace/api-zod";
import type { DistrictIntakeRow } from "@workspace/db";

export const intakeBody=CreateDistrictIntakeBody;
export const intakeMapping=intakeBody.shape.mapping;
export const intakeSourceRow=intakeBody.shape.rows.element;
type DistrictIntakeSourceRow=z.infer<typeof intakeSourceRow>;
type DistrictIntakeMapping=z.infer<typeof intakeMapping>;
export function validIntakeCoordinate(lat:unknown,lon:unknown):boolean {
  return typeof lat==="number"&&typeof lon==="number"&&Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180&&(lat!==0||lon!==0);
}
function parseSourceCoordinate(value:string|undefined):number {
  // Accept decimal comma without accepting grouped, mixed-separator or partial
  // numeric input. Normalization is local; original source strings stay exact.
  const normalized=value?.trim().replace(",",".")??"";
  return /^-?\d+(?:\.\d+)?$/.test(normalized)?Number(normalized):NaN;
}
export function inspectIntake(rows:DistrictIntakeSourceRow[],mapping:DistrictIntakeMapping):DistrictIntakeRow[] {
  const seen=new Set<number>();
  return rows.map(row=>{
    if(seen.has(row.sourceRowNumber)) throw new Error("Dubbelt källradsnummer.");
    seen.add(row.sourceRowNumber);
    const objectNumber=(row.original[mapping.objectNumber]??"").trim();
    const address=[row.original[mapping.address],mapping.postalCity?row.original[mapping.postalCity]:"",mapping.postalCode?row.original[mapping.postalCode]:"",mapping.city?row.original[mapping.city]:""].filter(Boolean).join(" ").trim();
    const rawLat=mapping.latitude?row.original[mapping.latitude]:"";
    const rawLon=mapping.longitude?row.original[mapping.longitude]:"";
    const latitude=parseSourceCoordinate(rawLat),longitude=parseSourceCoordinate(rawLon);
    const ready=!row.parseError&&!!objectNumber&&!!address&&validIntakeCoordinate(latitude,longitude);
    return {sourceRowNumber:row.sourceRowNumber,original:row.original,objectNumber,address,status:row.parseError?"rejected":ready?"ready":"unresolved",reason:row.parseError??(ready?"":"Adress, objektnummer eller koordinater behöver granskas."),...(ready?{latitude,longitude}:{})};
  });
}
export function draftIntake(state:Record<string,unknown>,mapping:DistrictIntakeMapping) {
  const parsed=state.parsedData as {headers?:string[],rows?:unknown[],rejectedRows?:unknown[],sourceRowCount?:number}|undefined;
  if(!parsed||!Array.isArray(parsed.headers)||!Array.isArray(parsed.rows)) throw new Error("Utkastet saknar ursprungliga filrader.");
  if(new Set(parsed.headers).size!==parsed.headers.length) throw new Error("Dubbla kolumnnamn kan inte bevaras entydigt. Ingen överföring gjordes.");
  const sourceNumbers=new Set(parsed.rows.map(v=>(v as {sourceRowNumber:number}).sourceRowNumber));
  // Top-level rejectedRows also includes user-reviewed removals. A removed row
  // already present in parsedData remains the same authoritative source row.
  const rejected=Array.isArray(state.rejectedRows)?state.rejectedRows:parsed.rejectedRows??[];
  const raw=[...parsed.rows,...rejected.filter(v=>!sourceNumbers.has((v as {sourceRowNumber:number}).sourceRowNumber))];
  const sources=raw.map(value=>{
    const row=value as {sourceRowNumber:number,values:string[],reason?:string,reasons?:string[]};
    if(!Number.isInteger(row.sourceRowNumber)||row.sourceRowNumber<1||!Array.isArray(row.values)||row.values.some(v=>typeof v!=="string")) throw new Error("Utkastets källrader kan inte stämmas av.");
    const reason=row.reason??row.reasons?.join("; ");
    const original=Object.fromEntries(parsed.headers!.map((header,i)=>[header,row.values[i]??""]));
    row.values.slice(parsed.headers!.length).forEach((value,i)=>{let key=`__extra_column_${i+1}`;while(Object.hasOwn(original,key))key="_"+key;original[key]=value;});
    return {sourceRowNumber:row.sourceRowNumber,original,...(reason?{parseError:reason}:{})};
  }).sort((a,b)=>a.sourceRowNumber-b.sourceRowNumber);
  if(parsed.sourceRowCount!==sources.length) throw new Error("Filens radantal stämmer inte med sparade källrader. Ingen överföring gjordes.");
  if(raw.length===0||raw.length>20000)throw new Error("Underlaget måste innehålla 1–20 000 källrader.");
  const rows=inspectIntake(sources,mapping);
  const mapped=new Map<number,Record<string,unknown>>();
  for(const value of (Array.isArray(state.mappedRows)?state.mappedRows:[])) {
    const r=value as Record<string,unknown>;
    const number=r._sourceRowNumber??r.sourceRowNumber;
    if(typeof number!=="number"||mapped.has(number)||!sources.some(s=>s.sourceRowNumber===number)) throw new Error("Mappade rader saknar entydigt källradsnummer.");
    mapped.set(number,r);
  }
  for(const row of rows) {
    const r=mapped.get(row.sourceRowNumber);
    if(r&&row.status!=="rejected"&&(r._deliveryGeocodeError||(Array.isArray(r._deliveryCandidates)&&r._deliveryCandidates.length))){
      row.status="unresolved";row.reason="Adressgranskningen i källutkastet är inte klar.";
      delete row.latitude;delete row.longitude;
    }
    if(r&&row.status!=="rejected"&&row.objectNumber&&!r._deliveryGeocodeError&&!(Array.isArray(r._deliveryCandidates)&&r._deliveryCandidates.length)&&validIntakeCoordinate(r.latitude,r.longitude)){
      row.latitude=r.latitude as number;row.longitude=r.longitude as number;
      row.address=typeof r.address==="string"&&r.address.trim()?[r.address,r.postalCode,r.city].filter(v=>typeof v==="string"&&v.trim()).join(" "):row.address;
      if(row.address){row.status="ready";row.reason="";}
    }
  }
  return rows;
}
export function intakeSummary<T extends {rows:DistrictIntakeRow[]}>(intake:T) {
  return {...intake,total:intake.rows.length,ready:intake.rows.filter(r=>r.status==="ready").length,unresolved:intake.rows.filter(r=>r.status==="unresolved").length,rejected:intake.rows.filter(r=>r.status==="rejected").length};
}
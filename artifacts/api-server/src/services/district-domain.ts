import { createHash } from "node:crypto";

export type SourceRow = Record<string, string>;
export type ImportRow = SourceRow | {sourceRowNumber:number,original:SourceRow,parseError?:string};
export type Mapping = {objectNumber:string,address:string,latitude:string,longitude:string};
export function inspectDistrictRows(rows: ImportRow[], mapping: Mapping) {
  const issues: {rowNumber:number,reason:string}[] = [];
  const duplicateCandidates: {rowNumber:number,otherRowNumber:number}[] = [];
  const validRows: {sourceRowNumber:number,objectNumber:string,address:string,latitude:number,longitude:number,original:SourceRow}[] = [];
  const seen = new Map<string,number>();
  let previousRowNumber=0;
  for (let i=0;i<rows.length;i++) {
    const source=rows[i];
    const enriched=typeof source.sourceRowNumber==="number" && typeof source.original==="object" && source.original!==null && !Array.isArray(source.original);
    const sourceRowNumber=enriched?source.sourceRowNumber as number:i+1;
    if(!Number.isInteger(sourceRowNumber) || sourceRowNumber<=previousRowNumber) throw new Error("Källradsnummer måste vara unika, positiva och strikt stigande.");
    previousRowNumber=sourceRowNumber;
    const row=enriched?source.original as SourceRow:source as SourceRow;
    if(enriched && typeof source.parseError==="string" && source.parseError.length) {
      issues.push({rowNumber:sourceRowNumber,reason:"Källraden kunde inte tolkas: "+source.parseError.slice(0,250)});
      continue;
    }
    const objectNumber=row[mapping.objectNumber]?.trim();
    const address=row[mapping.address]?.trim();
    const latRaw=row[mapping.latitude]?.trim();
    const lonRaw=row[mapping.longitude]?.trim();
    const latitude=Number(latRaw), longitude=Number(lonRaw);
    if (!objectNumber || !address || !latRaw || !lonRaw || !/^-?\d+(?:\.\d+)?$/.test(latRaw) || !/^-?\d+(?:\.\d+)?$/.test(lonRaw) || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude)>90 || Math.abs(longitude)>180 || (latitude===0 && longitude===0)) {
      issues.push({rowNumber:sourceRowNumber,reason:"Ogiltigt objektnummer, adress eller WGS84-koordinat (latitud/longitud i decimalgrader)."});
      continue;
    }
    const key=objectNumber.toLocaleLowerCase("sv-SE")+"|"+address.toLocaleLowerCase("sv-SE");
    if (seen.has(key)) duplicateCandidates.push({rowNumber:sourceRowNumber,otherRowNumber:seen.get(key)!});
    else seen.set(key,sourceRowNumber);
    validRows.push({sourceRowNumber,objectNumber,address,latitude,longitude,original:row});
  }
  return {total:rows.length,valid:validRows.length,rejected:issues.length,issues,duplicateCandidates,validRows};
}
export function districtPayloadHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function assertDistrictSelection(order:string[],selected:string[],mode:"loop"|"open") {
  if (!selected.length || new Set(selected).size!==selected.length || selected.length>order.length) throw new Error("Urvalet måste innehålla unika poster i resultatet.");
  const offset=order.indexOf(selected[0]);
  if(offset<0 || selected.some((id,i)=>order[(offset+i)%order.length]!==id) || (mode==="open" && offset+selected.length>order.length)) throw new Error("Välj ett sammanhängande intervall i besöksordning.");
}
export function safeDistrictCell(value:string) {
  // Spreadsheet formula injection applies equally to CSV and XML string cells.
  return /^[\s\u0000-\u001f]*[=+\-@]/.test(value) ? "'"+value : value;
}
export function districtExportHeaders(columns:string[]) {
  const fixed=["Objektnummer","Källrad","Ruttordning","Uttagsordning"];
  const used=new Set(fixed);
  const originals=columns.map(name=>{
    let label=safeDistrictCell(name);
    if(used.has(label)) label="Original: "+label;
    let candidate=label,number=2;
    while(used.has(candidate)) candidate=`${label} (${number++})`;
    used.add(candidate);
    return candidate;
  });
  return [...fixed,...originals];
}
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { buildMatrix, type DistrictInput, type DistrictResult, type DistrictCallbacks, type DistrictSolveOptions, type DistrictCoordinate } from "./district-solver";

// Matrix-only allocation budget, not an API RSS ceiling. One bulk job globally;
// transport, snapshots, geometry and unreclaimed allocations need extra headroom.
export const DISTRICT_BULK_MATRIX_BYTES = 768 * 1024 * 1024;
export const DISTRICT_BULK_MAX_ROWS = 20000;
export const DISTRICT_BULK_LIMITS = {blockSize:200,maxRequests:1600,maxBytes:DISTRICT_BULK_MATRIX_BYTES};
export const coordinateKey=(p:DistrictCoordinate)=>`${p.latitude},${p.longitude}`;
export type DistrictDistanceException={pointId:string;maxSnapMeters:number;reason:string};
export type DistrictBulkSnapshot={
  engine:"bulk-road-v1";
  scope:"zone"|"plan";
  planRevision:number;
  intakeRevision:number|null;
  datasetIdentity:string;
  sourceHash:string;
  exceptions:DistrictDistanceException[];
  sourceRows:{id:string;pointId?:string;sourceRowNumber:number;objectNumber:string;original:Record<string,string>;status:string;reason:string}[];
};
/** In-process development instrumentation, never accepted from an HTTP request. */
export interface DistrictBulkDiagnostics {
  onPhase?: (phase: "matrix" | "solver" | "geometry") => void;
  onMatrix?: (matrix: Awaited<ReturnType<typeof buildMatrix>>) => Promise<void> | void;
}

export function bulkCapacity(points:DistrictInput["points"], start:DistrictInput["start"]) {
  const uniqueCoordinates=new Set([...points, start as DistrictCoordinate].map(coordinateKey)).size;
  const matrixBytes=16*uniqueCoordinates*uniqueCoordinates;
  const tableRequests=Math.ceil(uniqueCoordinates/DISTRICT_BULK_LIMITS.blockSize)**2;
  return {uniqueCoordinates,matrixBytes,tableRequests,
    allowed:points.length>0 && points.length<=DISTRICT_BULK_MAX_ROWS &&
      matrixBytes<=DISTRICT_BULK_MATRIX_BYTES && tableRequests<=DISTRICT_BULK_LIMITS.maxRequests};
}

/** O(n²) construction, bounded directed relocation. No cubic cheapest insertion, no straight-line costs. */
export async function bulkRoadOrder(width:number,cost:(a:number,b:number)=>number,pulse:()=>Promise<void>) {
  const remaining=new Set(Array.from({length:width-1},(_,i)=>i+1));
  const order:number[]=[];
  let previous=0;
  while(remaining.size) {
    let chosen=-1,lowest=Infinity;
    for(const candidate of remaining) {
      const value=cost(previous,candidate);
      if(value<lowest) {lowest=value;chosen=candidate;}
    }
    if(chosen<0) throw new Error("Ingen fullständig riktad vägordning kan skapas.");
    order.push(chosen);remaining.delete(chosen);previous=chosen;
    if(order.length%32===0) await pulse();
  }
  // Road-nearest candidate sets: bounded O(24 n²), O(24 n) retained memory.
  const neighbors:number[][]=[];
  for(let from=0;from<width;from++) {
    const candidates:number[]=[];
    for(let to=1;to<width;to++) {
      if(from===to) continue;
      if(candidates.length===24 && cost(from,to)>=cost(from,candidates[23])) continue;
      let at=0;
      while(at<candidates.length && cost(from,candidates[at])<=cost(from,to)) at++;
      candidates.splice(at,0,to);
      if(candidates.length>24) candidates.pop();
    }
    neighbors.push(candidates);
    if(from%16===0) await pulse();
  }
  for(let pass=0;pass<4;pass++) {
    const positions=new Int32Array(width);
    order.forEach((node,i)=>{positions[node]=i;});
    let changed=false;
    for(const node of order.slice()) {
      const i=positions[node],before=i===0?0:order[i-1],after=order[i+1];
      const remove=(after===undefined?0:cost(before,after)-cost(node,after))-cost(before,node);
      let best=-1e-6,anchor:number|undefined;
      for(const candidate of [0,...neighbors[node]]) {
        if(candidate===node || candidate===before) continue;
        const j=candidate===0?-1:positions[candidate],following=order[j+1];
        if(following===node) continue;
        const delta=remove+cost(candidate,node)+(following===undefined?0:cost(node,following)-cost(candidate,following));
        if(delta<best) {best=delta;anchor=candidate;}
      }
      if(anchor!==undefined) {
        order.splice(i,1);
        const j=anchor===0?-1:order.indexOf(anchor);
        order.splice(j+1,0,node);
        order.forEach((value,index)=>{positions[value]=index;});
        changed=true;
      }
      if(i%32===0) await pulse();
    }
    if(!changed) break;
  }
  return order;
}

export async function solveDistrictBulk(input:DistrictInput, callbacks:DistrictCallbacks,
  options:DistrictSolveOptions, snapshot:DistrictBulkSnapshot, diagnostics?:DistrictBulkDiagnostics):Promise<DistrictResult> {
  if(input.mode!=="open" || input.end || input.start.pointId ||
      !Number.isFinite(input.start.latitude) || !Number.isFinite(input.start.longitude) ||
      Math.abs(input.start.latitude!)>90 || Math.abs(input.start.longitude!)>180)
    throw new Error("Stora underlag kräver extern start, fritt sista stopp och ingen depotretur.");
  if(!options.provider?.cacheKey || !bulkCapacity(input.points,input.start).allowed)
    throw new Error("Jobbet saknar låst bulkleverantör eller överskrider kapacitetsbudgeten.");
  if(new Set(input.points.map(p=>p.id)).size!==input.points.length ||
      input.points.some(p=>!p.id || !Number.isFinite(p.latitude)||!Number.isFinite(p.longitude)||Math.abs(p.latitude)>90||Math.abs(p.longitude)>180))
    throw new Error("Alla objekt måste ha unik identitet och giltig position.");
  const abort=new AbortController();
  const cancel=()=>abort.abort();
  options.signal?.addEventListener("abort",cancel,{once:true});
  if(options.signal?.aborted) abort.abort();
  let polling=false, pollError:unknown;
  const poll=async()=>{
    if(polling) return;
    polling=true;
    try {if(await callbacks.isCancelled()) abort.abort();}
    catch(error) {pollError=error;abort.abort();}
    finally {polling=false;}
  };
  const timer=setInterval(()=>{void poll();},300);
  const pulse=async()=>{
    await yieldToEventLoop();
    await poll();
    if(pollError) throw pollError;
    if(abort.signal.aborted) throw new Error("Distriktsjobbet har avbrutits.");
  };
  try {
    await pulse();
    const start=input.start as DistrictCoordinate;
    const nodes:DistrictCoordinate[]=[start];
    const groups:typeof input.points[]=[[]];
    const indices=new Map([[coordinateKey(start),0]]);
    for(const point of input.points) {
      const key=coordinateKey(point);
      let at=indices.get(key);
      if(at===undefined) {at=nodes.length;nodes.push(point);groups.push([]);indices.set(key,at);}
      groups[at].push(point);
    }
    let lastProgress=0;
    const progress=async(value:number)=>{
      await pulse();
      const rounded=Math.floor(value);
      if(rounded>lastProgress) {lastProgress=rounded;await callbacks.onProgress(rounded);}
    };
    diagnostics?.onPhase?.("matrix");
    const matrixStarted=performance.now();
    const matrix=await buildMatrix(nodes,options.provider,abort.signal,f=>progress(f*65),false,DISTRICT_BULK_LIMITS);
    const matrixMilliseconds=performance.now()-matrixStarted;
    await diagnostics?.onMatrix?.(matrix);
    const cost=(a:number,b:number)=>matrix.distance[a*matrix.width+b];
    diagnostics?.onPhase?.("solver");
    const solverStarted=performance.now();
    const order=await bulkRoadOrder(nodes.length,cost,pulse);
    const solverMilliseconds=performance.now()-solverStarted;
    await progress(80);
    const visits=[0,...order];
    let distanceMeters=0,driveSeconds=0;
    for(let i=1;i<visits.length;i++) {
      const cell=visits[i-1]*matrix.width+visits[i];
      distanceMeters+=matrix.distance[cell];driveSeconds+=matrix.duration[cell];
    }
    const geometry:DistrictCoordinate[]=[];
    diagnostics?.onPhase?.("geometry");
    const geometryStarted=performance.now();
    const geometryVisits=visits.length===1?[0,0]:visits;
    const snapLimits=new Map(snapshot.exceptions.map(e=>{
      const point=input.points.find(p=>p.id===e.pointId);
      if(!point) throw new Error("Avståndsundantaget saknar källpunkt.");
      return [coordinateKey(point),e.maxSnapMeters] as const;
    }));
    const near=(a:DistrictCoordinate,b:DistrictCoordinate)=>Math.abs(a.latitude-b.latitude)<=0.000025 && Math.abs(a.longitude-b.longitude)<=0.000025;
    for(let from=0;from<geometryVisits.length-1;from+=49) {
      await pulse();
      const requested=geometryVisits.slice(from,from+50).map(i=>nodes[i]);
      const requestSignal=AbortSignal.any([abort.signal,AbortSignal.timeout(20000)]);
      const route=await options.provider.route(requested,requestSignal);
      if(route.waypoints.length!==requested.length || route.geometry.length<2 ||
          !route.waypoints.every((p,i)=>{
            const source=requested[i];
            const meters=Math.hypot((source.latitude-p.latitude)*111320,
              (source.longitude-p.longitude)*111320*Math.cos((source.latitude+p.latitude)*Math.PI/360));
            return Number.isFinite(p.latitude) && Math.abs(p.latitude)<=90 && Number.isFinite(p.longitude) && Math.abs(p.longitude)<=180 &&
              Number.isFinite(meters) && meters<=(snapLimits.get(coordinateKey(source))??250);
          }) ||
          !route.geometry.every(p=>Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&Math.abs(p.latitude)<=90&&Math.abs(p.longitude)<=180) ||
          !near(route.geometry[0],route.waypoints[0]) || !near(route.geometry.at(-1)!,route.waypoints.at(-1)!) ||
          (geometry.length>0 && !near(geometry.at(-1)!,route.geometry[0])))
        throw new Error("Väggeometrin saknar verifierade ändpunkter eller sammanhängande skarvar.");
      if(geometry.length+route.geometry.length>1000000) throw new Error("Väggeometrin överskrider minnesbudgeten.");
      for(const point of geometry.length?route.geometry.slice(1):route.geometry) geometry.push(point);
      await progress(80+19*Math.min(1,(from+49)/(geometryVisits.length-1)));
    }
    await pulse();
    const geometryMilliseconds=performance.now()-geometryStarted;
    const orderedPointIds=visits.flatMap(i=>groups[i].map(p=>p.id));
    if(orderedPointIds.length!==input.points.length || new Set(orderedPointIds).size!==input.points.length)
      throw new Error("Radbevarandet misslyckades. Inget delresultat sparas.");
    const unresolved=snapshot.sourceRows.filter(r=>!r.pointId).length;
    if(options.onMeasurements) {
      let asymmetricDistancePairs=0,sourceOrderDistanceMeters=0;
      for(let a=0;a<matrix.width;a++)
        for(let b=a+1;b<matrix.width;b++)
          if(Math.abs(cost(a,b)-cost(b,a))>1) asymmetricDistancePairs++;
      for(let i=1;i<nodes.length;i++) sourceOrderDistanceMeters+=cost(i-1,i);
      options.onMeasurements({matrixMilliseconds,solverMilliseconds,geometryMilliseconds,
        uniqueCoordinates:matrix.width,matrixCells:matrix.width**2,tableRequests:matrix.tableRequests,
        matrixCacheHit:matrix.cacheHit,asymmetricDistancePairs,sourceOrderDistanceMeters});
    }
    return {orderedPointIds,distanceMeters,driveSeconds,geometry,
      ...(matrix.matrixRepairs.length?{matrixRepairs:structuredClone(matrix.matrixRepairs)}:{}),warnings:[
      `Stor vägoptimering · ${snapshot.engine} · dataset ${snapshot.datasetIdentity}. Heuristisk ordning, inte ett optimalitetsbevis eller en dagsrutt.`,
      `${snapshot.sourceRows.length} källrader bevarade; ${unresolved} olösta/avvisade saknar vägordning och följer med vid uttag av hela underlaget.`,
      ...snapshot.exceptions.map(e=>`Godkänt avståndsundantag: ${e.pointId}, högst ${e.maxSnapMeters} m. ${e.reason}. Originalpositionen är oförändrad.`),
      ...(options.provider.warnings?.()??[]),
    ]};
  } finally {
    clearInterval(timer);abort.abort();options.signal?.removeEventListener("abort",cancel);
  }
}

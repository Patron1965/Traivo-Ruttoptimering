import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkCapacity,bulkRoadOrder,solveDistrictBulk,type DistrictBulkSnapshot } from "./district-bulk-solver";
import { createDistrictOsrmProvider,solveDistrict,type DistrictInput,type DistrictRoadProvider } from "./district-solver";
import { recordBulkPreview,validBulkPreview } from "./district-bulk-preview";

const snapshot:DistrictBulkSnapshot={engine:"bulk-road-v1",scope:"plan",planRevision:0,intakeRevision:0,
  datasetIdentity:"synthetic-roads-v1",sourceHash:"test",exceptions:[],sourceRows:[]};
const input:DistrictInput={mode:"open",start:{latitude:57.7,longitude:11.8},serviceMinutes:0,
  points:[{id:"a",latitude:57.701,longitude:11.8},{id:"b",latitude:57.702,longitude:11.8}]};
const callbacks={onProgress:()=>{},isCancelled:()=>false};
function syntheticProvider():DistrictRoadProvider {
  const cost=(a:number,b:number)=>Math.abs(b-a)*100000*(b<a?1.25:1);
  return {cacheKey:"synthetic-roads-v1",
    table:async(from,to)=>({distances:from.map(a=>to.map(b=>cost(a.latitude,b.latitude))),
      durations:from.map(a=>to.map(b=>cost(a.latitude,b.latitude)/10))}),
    route:async(points)=>({geometry:points,waypoints:points})};
}

test("bulk capacity budgets count distinct positions, never drop co-located source objects",()=>{
  const many=Array.from({length:6506},(_,i)=>({id:String(i),latitude:57+i/100000,longitude:11.9}));
  const capacity=bulkCapacity(many,input.start);
  assert.equal(capacity.allowed,true);
  assert.equal(capacity.uniqueCoordinates,6507);
  assert.equal(capacity.matrixBytes,16*6507**2);
  assert.equal(bulkCapacity(Array.from({length:8000},(_,i)=>({...many[0],id:String(i),longitude:i/10000})),input.start).allowed,false);
  assert.equal(bulkCapacity(Array.from({length:20001},(_,i)=>({...many[0],id:String(i)})),input.start).allowed,false);
});

test("6006 source objects including co-location and unresolved rows survive a complete open bulk solve",async()=>{
  const large:DistrictInput={...input,points:Array.from({length:6001},(_,i)=>({
    id:`row-${i}`,latitude:57.70001+i/100000,longitude:11.8,
  }))};
  large.points.push(...Array.from({length:4},(_,i)=>({...large.points[90],id:`same-place-${i}`})));
  const sourceRows:DistrictBulkSnapshot["sourceRows"]=[
    ...large.points.map((p,i)=>({id:p.id,pointId:p.id,sourceRowNumber:i+1,objectNumber:`000${i}`,original:{Object:`000${i}`},status:"ready",reason:""})),
    {id:"unresolved-source",sourceRowNumber:6006,objectNumber:"006006",original:{Object:"006006"},status:"unresolved",reason:"Position saknas"},
  ];
  const before=JSON.stringify(large);
  let maxWaypoints=0,lastRequested:{latitude:number;longitude:number}|undefined;
  const provider=syntheticProvider();
  const originalRoute=provider.route;
  provider.route=async(points,signal)=>{maxWaypoints=Math.max(maxWaypoints,points.length);lastRequested=points.at(-1);return originalRoute(points,signal);};
  const progress:number[]=[];
  const result=await solveDistrictBulk(large,{...callbacks,onProgress:p=>{progress.push(p);}},{provider},{...snapshot,sourceRows});
  assert.equal(result.orderedPointIds.length,6005);
  assert.deepEqual(new Set(result.orderedPointIds),new Set(large.points.map(p=>p.id)));
  assert.equal(JSON.stringify(large),before);
  assert.notDeepEqual(lastRequested,large.start,"free final stop is not a depot return");
  assert.ok(maxWaypoints<=50);
  assert.ok(result.warnings.some(w=>w.includes("6006 källrader") && w.includes("1 olösta")));
  assert.ok(progress.every((value,i)=>i===0 || value>progress[i-1]));
  assert.ok(result.distanceMeters>0 && result.geometry.length>6000);
});

test("bulk instrumentation observes actual phases and validated matrix without retaining a cache",async()=>{
  const phases:string[]=[];
  let measurements:import("./district-solver").DistrictMeasurements|undefined;
  let observed=0;
  const result=await solveDistrictBulk(input,callbacks,{
    provider:syntheticProvider(),onMeasurements:m=>{measurements=m;},
  },snapshot,{
    onPhase:p=>{phases.push(p);},
    onMatrix:matrix=>{
      observed++;
      assert.equal(matrix.width,3);
      assert.equal(matrix.distance.length,9);
      assert.equal(matrix.cacheHit,false);
    },
  });
  assert.deepEqual(phases,["matrix","solver","geometry"]);
  assert.equal(observed,1);
  assert.ok(measurements);
  assert.equal(measurements.uniqueCoordinates,3);
  assert.equal(measurements.matrixCells,9);
  assert.equal(measurements.tableRequests,1);
  assert.equal(measurements.matrixCacheHit,false);
  assert.ok(measurements.asymmetricDistancePairs>0);
  assert.ok(measurements.sourceOrderDistanceMeters>=result.distanceMeters);
  for(const key of ["matrixMilliseconds","solverMilliseconds","geometryMilliseconds"] as const)
    assert.ok(Number.isFinite(measurements[key]) && measurements[key]>=0);
});

test("bulk road geometry explicitly permits turns at visits without changing ordinary route requests",async()=>{
  const original=globalThis.fetch;
  const turns:(string|null)[]=[];
  globalThis.fetch=async(url)=>{
    const parsed=new URL(String(url));
    turns.push(parsed.searchParams.get("continue_straight"));
    const locations=[[11.8,57.7],[11.8,57.701]];
    return new Response(JSON.stringify({code:"Ok",routes:[{geometry:{coordinates:locations}}],
      waypoints:locations.map(location=>({location}))}),
      {headers:{"x-osrm-dataset-id":snapshot.datasetIdentity}});
  };
  try {
    const visits=[input.start as {latitude:number;longitude:number},input.points[0]];
    await createDistrictOsrmProvider("http://127.0.0.1:5001","bulk",undefined,
      {datasetIdentity:snapshot.datasetIdentity}).route(visits,new AbortController().signal);
    await createDistrictOsrmProvider("http://127.0.0.1:5001","ordinary").route(visits,new AbortController().signal);
    assert.deepEqual(turns,["false",null]);
  } finally {globalThis.fetch=original;}
});

test("directed ordering uses asymmetric road costs and keeps every node",async()=>{
  const matrix=[[0,4,1,9],[7,0,2,3],[8,2,0,4],[1,5,7,0]];
  const order=await bulkRoadOrder(4,(a,b)=>matrix[a][b],async()=>{});
  assert.deepEqual(new Set(order),new Set([1,2,3]));
  assert.equal(order[0],2);
});

test("all objects at the external start keep distinct IDs with a verified zero-length geometry",async()=>{
  const same={...input,points:input.points.map(p=>({...p,latitude:input.start.latitude!,longitude:input.start.longitude!}))};
  const result=await solveDistrictBulk(same,callbacks,{provider:syntheticProvider()},snapshot);
  assert.deepEqual(result.orderedPointIds,["a","b"]);
  assert.equal(result.distanceMeters,0);
  assert.equal(result.geometry.length,2);
  const malformed=syntheticProvider();
  malformed.route=async p=>({waypoints:p,geometry:[{latitude:NaN,longitude:0},p[1]]});
  await assert.rejects(solveDistrictBulk(same,callbacks,{provider:malformed},snapshot),/Väggeometrin/);
});

test("bulk endpoint contract, malformed matrices and geometry fail without a partial result",async()=>{
  const provider=syntheticProvider();
  await assert.rejects(solveDistrictBulk({...input,mode:"loop"},callbacks,{provider},snapshot),/extern start/);
  await assert.rejects(solveDistrictBulk({...input,end:{pointId:"b"}},callbacks,{provider},snapshot),/extern start/);
  await assert.rejects(solveDistrictBulk({...input,start:{pointId:"a"}},callbacks,{provider},snapshot),/extern start/);
  await assert.rejects(solveDistrictBulk(input,callbacks,{provider:{...provider,table:async()=>({distances:[[null]],durations:[[0]]})}},snapshot),/saknar rader/);
  const invalid=syntheticProvider();
  invalid.table=async(a,b)=>({distances:a.map(()=>b.map(()=>-9)),durations:a.map(()=>b.map(()=>0))});
  await assert.rejects(solveDistrictBulk(input,callbacks,{provider:invalid},snapshot),/ogiltig/);
  const badGeometry=syntheticProvider();
  badGeometry.route=async p=>({geometry:[{latitude:0,longitude:0},p.at(-1)!],waypoints:p});
  await assert.rejects(solveDistrictBulk(input,callbacks,{provider:badGeometry},snapshot),/Väggeometrin/);
});

test("abort cancels in-flight matrix transport and preserves source inputs",async()=>{
  const abort=new AbortController();
  let observed=false;
  const provider=syntheticProvider();
  provider.table=async(_a,_b,signal)=>new Promise((_resolve,reject)=>{
    signal.addEventListener("abort",()=>{observed=true;reject(new Error("cancelled"));},{once:true});
    abort.abort();
  });
  const before=JSON.stringify(input);
  await assert.rejects(solveDistrictBulk(input,callbacks,{provider,signal:abort.signal},snapshot),/Avbruten|avbrutits/);
  assert.equal(observed,true);
  assert.equal(JSON.stringify(input),before);
});

test("cancelled callbacks and geometry transport cancellation cannot return a result",async()=>{
  await assert.rejects(solveDistrictBulk(input,{...callbacks,isCancelled:()=>true},{provider:syntheticProvider()},snapshot),/avbrutits/);
  const abort=new AbortController();
  const provider=syntheticProvider();
  provider.route=async(_points,signal)=>new Promise((_resolve,reject)=>{
    signal.addEventListener("abort",()=>reject(new Error("geometry cancelled")),{once:true});
    abort.abort();
  });
  await assert.rejects(solveDistrictBulk(input,callbacks,{provider,signal:abort.signal},snapshot),/cancelled/);
});

test("position-check proof is tenant/plan/zone/input/provider-bound and cannot be forged",()=>{
  const binding={serverId:"shared",configurationVersion:"tenant-specific"};
  const token=recordBulkPreview("A","plan","zone","hash",binding);
  assert.equal(validBulkPreview(token,"A","plan","zone","hash",binding),true);
  assert.equal(validBulkPreview(token,"B","plan","zone","hash",binding),false);
  assert.equal(validBulkPreview(token,"A","foreign","zone","hash",binding),false);
  assert.equal(validBulkPreview(token,"A","plan","zone","new-input",binding),false);
  assert.equal(validBulkPreview(token,"A","plan","zone","hash",{...binding,configurationVersion:"changed"}),false);
  assert.equal(validBulkPreview("hash","A","plan","zone","hash",binding),false);
});

test("small solver remains limited to 750 and retains its closed endpoint contract",async()=>{
  await assert.rejects(solveDistrict({...input,points:Array.from({length:751},(_,i)=>({...input.points[0],id:String(i)}))},callbacks,{provider:syntheticProvider()}),/1–750/);
  const result=await solveDistrict({...input,mode:"loop"},callbacks,{provider:syntheticProvider()});
  assert.deepEqual(result.geometry[0],result.geometry.at(-1));
  assert.equal(result.orderedPointIds.length,2);
});

test("bulk provider verifies the dataset on every response, including successful HTTP with missing identity",async()=>{
  const originalFetch=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response(JSON.stringify({code:"Ok"}),{headers:{"content-type":"application/json"}});
    const provider=createDistrictOsrmProvider("http://127.0.0.1:5001","synthetic",undefined,{datasetIdentity:"approved-v1"});
    await assert.rejects(provider.table(input.points,input.points,new AbortController().signal),/datasetidentitet/);
    globalThis.fetch=async()=>new Response(JSON.stringify({code:"Ok"}),{headers:{"x-osrm-dataset-id":"other-version"}});
    await assert.rejects(provider.route(input.points,new AbortController().signal),/datasetidentitet/);
  } finally {globalThis.fetch=originalFetch;}
});

test("verified negative-cost repairs remain visible with immutable dataset identity and preserved source coordinates",async()=>{
  const originalFetch=globalThis.fetch;
  const before=JSON.stringify(input.points);
  try {
    let calls=0;
    globalThis.fetch=async url=>{
      calls++;
      const body=String(url).includes("/table/")?
        {code:"Ok",distances:[[-0.2,-0.2],[-0.2,-0.2]],durations:[[0,0],[0,0]],
          sources:input.points.map(()=>({location:[11.8,57.701]})),destinations:input.points.map(()=>({location:[11.8,57.701]}))}:
        {code:"Ok",waypoints:[{location:[11.8,57.701]},{location:[11.8,57.701]}],
          routes:[{distance:0,duration:0,legs:[{distance:0,duration:0}],
            geometry:{type:"LineString",coordinates:[[11.8,57.701],[11.8,57.701]]}}]};
      return new Response(JSON.stringify(body),{headers:{"content-type":"application/json","x-osrm-dataset-id":"approved"}});
    };
    const provider=createDistrictOsrmProvider("http://127.0.0.1:5001","synthetic",undefined,{datasetIdentity:"approved"});
    const table=await provider.table(input.points,input.points,new AbortController().signal);
    assert.deepEqual(table.distances,[[0,0],[0,0]]);
    assert.equal(calls,5,"each negative cost requires its own directed road verification");
    assert.match(provider.warnings!()[0],/4 negativa OSRM-avstånd har verifierats separat/);
    assert.equal(table.matrixRepairs?.length,4);
    const withRepairs=syntheticProvider(),originalTable=withRepairs.table;
    withRepairs.table=async(...args)=>({...await originalTable(...args),matrixRepairs:table.matrixRepairs});
    const result=await solveDistrictBulk(input,callbacks,{provider:withRepairs},snapshot);
    assert.deepEqual(result.matrixRepairs,table.matrixRepairs,"bulk result preserves every provider verification");
    assert.equal(JSON.stringify(input.points),before);
    globalThis.fetch=async()=>new Response(JSON.stringify({code:"Ok"}),{headers:{"x-osrm-dataset-id":"changed"}});
    await assert.rejects(provider.table(input.points,input.points,new AbortController().signal),/datasetidentitet/);
  } finally {globalThis.fetch=originalFetch;}
});

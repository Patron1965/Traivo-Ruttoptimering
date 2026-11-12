import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectDistrictRows, assertDistrictSelection, safeDistrictCell, districtPayloadHash, districtExportHeaders } from "./district-domain";

test("6000 source rows retain zero-padded identifiers, original fields and distinct objects at one address",()=>{
  const rows=Array.from({length:6000},(_,i)=>({Obj:String(i+1).padStart(8,"0"),Adress:"Göteborgsgatan 1",Lat:String(57.68+i/1e5),Lon:"11.95",Extra:"="+i}));
  const result=inspectDistrictRows(rows,{objectNumber:"Obj",address:"Adress",latitude:"Lat",longitude:"Lon"});
  assert.equal(result.total,6000);
  assert.equal(result.valid,6000);
  assert.equal(result.rejected,0);
  assert.equal(result.validRows[0].objectNumber,"00000001");
  assert.equal(result.validRows[5999].original.Extra,"=5999");
  assert.equal(result.duplicateCandidates.length,0);
  assert.equal(new Set(result.validRows.map(r=>r.sourceRowNumber)).size,6000);
});
test("invalid coordinates rejected; candidates reviewed but never merged",()=>{
  const rows=[{Id:"01",Addr:"A",Lat:"57.7",Lon:"11.9"},{Id:"01",Addr:"A",Lat:"57.71",Lon:"11.91"},{Id:"03",Addr:"B",Lat:"6400000",Lon:"11"},{Id:"04",Addr:"C",Lat:"NaN",Lon:"12"},{Id:"05",Addr:"D",Lat:"90.01",Lon:"12"}];
  const v=inspectDistrictRows(rows,{objectNumber:"Id",address:"Addr",latitude:"Lat",longitude:"Lon"});
  assert.equal(v.total,v.valid+v.rejected);
  assert.equal(v.valid,2);
  assert.deepEqual(v.duplicateCandidates,[{rowNumber:2,otherRowNumber:1}]);
  assert.deepEqual(v.issues.map(x=>x.rowNumber),[3,4,5]);
  assert.notEqual(districtPayloadHash(rows),districtPayloadHash(rows.slice(1)));
});
test("physical source line numbers and parser-rejected lines are retained for reconciliation",()=>{
  const rows=[
    {sourceRowNumber:4,original:{Id:"001",Addr:"A",Lat:"57.7",Lon:"11.9"}},
    {sourceRowNumber:9,original:{Id:"002",Addr:"B",Lat:"57.8",Lon:"12"},parseError:"Malformed CSV quote"},
    {sourceRowNumber:16,original:{Id:"003",Addr:"C",Lat:"57.9",Lon:"12"}},
  ];
  const result=inspectDistrictRows(rows,{objectNumber:"Id",address:"Addr",latitude:"Lat",longitude:"Lon"});
  assert.deepEqual([result.total,result.valid,result.rejected],[3,2,1]);
  assert.deepEqual(result.validRows.map(r=>r.sourceRowNumber),[4,16]);
  assert.equal(result.issues[0].rowNumber,9);
  assert.throws(()=>inspectDistrictRows([rows[0],{...rows[1],sourceRowNumber:4}],{objectNumber:"Id",address:"Addr",latitude:"Lat",longitude:"Lon"}));
});
test("open interval cannot wrap, loop may wrap, skipping or duplicate stops prohibited",()=>{
  const order=["A","B","C","D"];
  assertDistrictSelection(order,["C","D","A"],"loop");
  assert.throws(()=>assertDistrictSelection(order,["C","D","A"],"open"));
  assert.throws(()=>assertDistrictSelection(order,["B","D"],"loop"));
  assert.throws(()=>assertDistrictSelection(order,["B","B"],"loop"));
});
test("CSV and spreadsheet cells cannot execute leading formula prefixes",()=>{
  for(const prefix of ["=","+","-","@","\t=","\r@"]) assert.equal(safeDistrictCell(prefix+"1"),"'"+prefix+"1");
  assert.equal(safeDistrictCell("000123"),"000123");
});
test("export headers cannot overwrite fixed identifiers or inject spreadsheet formulas",()=>{
  assert.deepEqual(districtExportHeaders(["Objektnummer","Ruttordning","=SUM(1)","'=SUM(1)"]),[
    "Objektnummer","Källrad","Ruttordning","Uttagsordning",
    "Original: Objektnummer","Original: Ruttordning","'=SUM(1)","Original: '=SUM(1)",
  ]);
});
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftIntake, inspectIntake, intakeSummary } from "./district-intake";
const mapping={objectNumber:"Obj",address:"Adress"};
test("source conservation includes rejected physical rows and excluded mapped rows",()=>{
  const result=draftIntake({
    parsedData:{headers:["Obj","Adress"],sourceRowCount:4,rows:[
      {sourceRowNumber:2,values:["0001","A"]},{sourceRowNumber:3,values:["0002","A"]},{sourceRowNumber:4,values:["0003","B"]},
    ]},
    rejectedRows:[{sourceRowNumber:5,values:["bad"],reasons:["Fel kolumnantal"]}],
    mappedRows:[{_sourceRowNumber:2,address:"Reviewed A",latitude:57.7,longitude:11.9}],
  },mapping);
  assert.equal(result.length,4);
  assert.equal(result[0].objectNumber,"0001");
  assert.equal(result[0].original.Adress,"A");
  assert.equal(result[0].address,"Reviewed A");
  assert.equal(result[0].latitude,57.7);
  assert.equal(result[1].status,"unresolved");
  assert.equal(result[2].status,"unresolved");
  assert.equal(result[3].status,"rejected");
  const summary=intakeSummary({rows:result});
  assert.deepEqual([summary.total,summary.ready,summary.unresolved,summary.rejected],[4,1,2,1]);
});
test("8660 original rows survive 6644 mapped rows with exactly 6506 reviewed coordinates",()=>{
  const headers=["Obj","Adress","Postort","Original notering"];
  const sourceRows=Array.from({length:8660},(_,index)=>({
    sourceRowNumber:index+2,
    values:[String(index+1).padStart(8,"0"),`  Testvägen ${Math.floor(index/2)+1}  `,"471 00 Tjörn",` Rad ${index+1}: åäö; =original\nNästa rad `],
  }));
  const mappedRows=sourceRows.slice(0,6644).map((source,index)=>({
    _sourceRowNumber:source.sourceRowNumber,
    address:`Granskad testadress ${index+1}`,
    ...(index<6506
      ?{latitude:57.7+index/1000000,longitude:11.9+index/1000000}
      :{_deliveryCandidates:[{latitude:57.8,longitude:11.8,displayName:"Obekräftat förslag"}]}),
  }));
  const state={parsedData:{headers,rows:sourceRows,sourceRowCount:8660},mappedRows,rejectedRows:[]};
  const before=JSON.stringify(state);
  const rows=draftIntake(state,mapping);
  const summary=intakeSummary({rows});
  assert.deepEqual([summary.total,summary.ready,summary.unresolved,summary.rejected],[8660,6506,2154,0]);
  assert.equal(new Set(rows.map(row=>row.sourceRowNumber)).size,8660);
  for(let index=0;index<sourceRows.length;index++){
    const row=rows[index],source=sourceRows[index];
    assert.equal(row.sourceRowNumber,source.sourceRowNumber);
    assert.deepEqual(row.original,Object.fromEntries(headers.map((header,column)=>[header,source.values[column]])));
    assert.equal(row.objectNumber,source.values[0]);
    if(index<6506){
      assert.equal(row.status,"ready");
      assert.equal(row.latitude,57.7+index/1000000);
      assert.equal(row.longitude,11.9+index/1000000);
    }else{
      assert.equal(row.status,"unresolved");
      assert.equal(row.latitude,undefined);
      assert.equal(row.longitude,undefined);
    }
  }
  assert.equal(JSON.stringify(state),before,"transfer must not mutate the operational source draft");
});
test("address file performs no implicit matching and co-located objects stay separate",()=>{
  const rows=inspectIntake([2,3].map(sourceRowNumber=>({sourceRowNumber,original:{Obj:"001",Adress:"Same address"}})),mapping);
  assert.equal(rows.length,2); assert.ok(rows.every(r=>r.status==="unresolved"&&!r.latitude&&!r.candidates));
});
test("draft count mismatch and ambiguous source identity fail closed",()=>{
  assert.throws(()=>draftIntake({parsedData:{headers:[],rows:[],sourceRowCount:8660}},mapping),/radantal/);
  assert.throws(()=>inspectIntake([2,2].map(sourceRowNumber=>({sourceRowNumber,original:{}})),mapping),/Dubbelt/);
});
test("ready coordinates are reused and missing coordinate is not treated as zero",()=>{
  const rows=inspectIntake([{sourceRowNumber:2,original:{Obj:"1",Adress:"A",Lat:"57.7",Lon:"11.9"}},{sourceRowNumber:3,original:{Obj:"2",Adress:"A",Lat:"",Lon:"11"}}],{...mapping,latitude:"Lat",longitude:"Lon"});
  assert.equal(rows[0].status,"ready");assert.equal(rows[1].status,"unresolved");
});
test("Swedish decimal commas accept valid coordinates without changing original values",()=>{
  const original={Obj:"001",Adress:"A",Lat:" 57,71230 ",Lon:"11,98760"};
  const [row]=inspectIntake([{sourceRowNumber:2,original}],{...mapping,latitude:"Lat",longitude:"Lon"});
  assert.equal(row.status,"ready");
  assert.equal(row.latitude,57.7123);assert.equal(row.longitude,11.9876);
  assert.equal(row.original.Lat," 57,71230 ");assert.equal(row.original.Lon,"11,98760");
  for(const invalid of ["57,7,1","57,7.1","57 712","57,7x","0x39",""]){
    const [rejected]=inspectIntake([{sourceRowNumber:2,original:{...original,Lat:invalid}}],{...mapping,latitude:"Lat",longitude:"Lon"});
    assert.equal(rejected.status,"unresolved",invalid);
    assert.equal(rejected.latitude,undefined);
  }
});
test("postalCity and separate postal code/city compose review queries while preserving originals",()=>{
  const original={Obj:"001",Adress:"  Vägen 1  ",Postal:"471 00",City:"Tjörn",Combined:"471 00 Tjörn"};
  const source=[{sourceRowNumber:2,original}];
  assert.equal(inspectIntake(source,{...mapping,postalCity:"Combined"})[0].address,"Vägen 1   471 00 Tjörn");
  assert.equal(inspectIntake(source,{...mapping,postalCode:"Postal",city:"City"})[0].address,"Vägen 1   471 00 Tjörn");
  assert.equal(inspectIntake(source,mapping)[0].original.Adress,"  Vägen 1  ");
});
test("unconfirmed candidate coordinates in mapped draft are never reused",()=>{
  const rows=draftIntake({parsedData:{headers:["Obj","Adress","Lat","Lon"],sourceRowCount:1,rows:[{sourceRowNumber:2,values:["001","A","57","11"]}]},mappedRows:[{_sourceRowNumber:2,latitude:58,longitude:12,_deliveryCandidates:[{latitude:58,longitude:12}]}]},{...mapping,latitude:"Lat",longitude:"Lon"});
  assert.equal(rows[0].status,"unresolved");assert.equal(rows[0].latitude,undefined);
});
test("duplicate headers reject explicitly and overflow cells cannot overwrite original header values",()=>{
  assert.throws(()=>draftIntake({parsedData:{headers:["Obj","Obj"],sourceRowCount:1,rows:[{sourceRowNumber:2,values:["001","002"]}]}},mapping),/Dubbla/);
  const rows=draftIntake({parsedData:{headers:["Obj","Adress","__extra_column_1"],sourceRowCount:1,rows:[]},rejectedRows:[{sourceRowNumber:2,values:["001","A","original","overflow"],reasons:["Bad width"]}]},mapping);
  assert.equal(rows[0].original.__extra_column_1,"original");assert.equal(rows[0].original.___extra_column_1,"overflow");
});
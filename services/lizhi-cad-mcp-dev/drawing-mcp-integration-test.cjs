"use strict";
// Real native Rust CADCraft sessions + local immutable versioned DXF storage.
// All endpoints are isolated 127.0.0.1 and no real user data is involved.
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {randomBytes}=require("node:crypto");
const {createDevServer}=require("./server.cjs");
const bin=process.argv[2];
const evidence=process.argv[3];
if(!bin)throw Error("Provide source-built CADCraft CLI executable");
const randomToken=()=>randomBytes(32).toString("hex");
let id=1;
async function client(app,token){
  const address=await app.listen();
  const uri="http://127.0.0.1:"+address.port+"/mcp";
  const headers={Authorization:"Bearer "+token,"Content-Type":"application/json",Accept:"application/json"};
  async function send(method,params={},session=null){
    const response=await fetch(uri,{method:"POST",headers:{...headers,...(session?{"Mcp-Session-Id":session}:{})},
      body:JSON.stringify({jsonrpc:"2.0",id:id++,method,params})});
    return {status:response.status,sid:response.headers.get("mcp-session-id"),body:await response.json()};
  }
  async function init(){
    const x=await send("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"lz-qa",version:"1"}});
    assert.equal(x.status,200);
    assert.equal(x.body.result.serverInfo.name,"cadcraft");
    return x.sid;
  }
  async function tool(session,name,args={},expectError=false){
    const response=await send("tools/call",{name,arguments:args},session);
    assert.equal(response.status,200,JSON.stringify(response.body));
    if(expectError){
      assert.equal(response.body.result?.isError,true,name+" must be rejected: "+JSON.stringify(response.body));
      return JSON.parse(response.body.result.content[0].text);
    }
    assert.ok(!response.body.error);
    assert.notEqual(response.body.result?.isError,true,name+" failed: "+JSON.stringify(response.body));
    return response.body.result.content?.[0]?.type==="text"
      ?JSON.parse(response.body.result.content[0].text)
      :response.body.result.content?.[0];
  }
  return {uri,headers,init,tool,send};
}
async function run(){
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),"lizhi-native-dxf-revision-e2e-"));
  const root=path.join(tmp,"store");
  let A=null,B=null,restarted=null;
  let tests=0;
  function ok(name){tests++;console.log("PASS",name)}
  try{
    const secretA=randomToken();
    A=createDevServer({cliPath:bin,token:secretA,storeRoot:root,ownerId:"owner_A"});
    const a=await client(A,secretA);
    const session1=await a.init();
    const list=await a.send("tools/list",{},session1);
    const names=list.body.result.tools.map(t=>t.name);
    for(const n of ["execute","lizhi_create_drawing","lizhi_save_revision","lizhi_open_revision","lizhi_list_revisions"])
      assert.ok(names.includes(n),"Missing MCP drawing tool "+n);
    assert.ok(!names.includes("open")&&!names.includes("save")&&!names.includes("lizhi_internal_snapshot_save"));
    ok("Native MCP tools preserve geometry-only limits while adding version tools");

    const forbidden=await a.send("tools/call",{name:"lizhi_internal_snapshot_save",arguments:{capability:"fake"}},session1);
    assert.equal(forbidden.body.error?.code,-32601);
    await a.tool(session1,"save",{path:"/etc/passwd"},true);
    ok("Remote client cannot call internal snapshots or native file paths");

    const newDrawing=await a.tool(session1,"lizhi_create_drawing",{drawingId:"cabinet_01"});
    assert.equal(newDrawing.revision,0);
    await a.tool(session1,"execute",{command:"rectang",params:{p1:[0,0],p2:[100,60]}});
    const saved1=await a.tool(session1,"lizhi_save_revision",{expectedRevision:0});
    assert.equal(saved1.revision,1);
    assert.match(saved1.sha256,/^[a-f0-9]{64}$/);
    ok("Native Rust rectangle saved as immutable private DXF revision 1 without model-supplied path");

    await a.tool(session1,"execute",{command:"circle",params:{center:[12,14],radius:5}});
    const saved2=await a.tool(session1,"lizhi_save_revision",{expectedRevision:1});
    assert.equal(saved2.revision,2);
    assert.notEqual(saved2.sha256,saved1.sha256);
    const versions=await a.tool(session1,"lizhi_list_revisions",{drawingId:"cabinet_01"});
    assert.deepEqual(versions.revisions.map(r=>r.revision),[1,2]);
    ok("Revision 2 differs from immutable revision 1 and lists both");

    const conflict=await a.tool(session1,"lizhi_save_revision",{expectedRevision:1},true);
    assert.equal(conflict.error,"VERSION_CONFLICT");
    const found=await a.tool(session1,"lizhi_list_revisions",{drawingId:"cabinet_01"});
    assert.equal(found.revisions.length,2);
    ok("Stale revision save refuses overwrite");

    const session2=await a.init();
    const old=await a.tool(session2,"lizhi_open_revision",{drawingId:"cabinet_01",revision:1});
    assert.equal(old.revision,1);
    let state=await a.tool(session2,"inspect_drawing",{entities:false});
    assert.equal(state.entityCount,1);
    const recent=await a.tool(session2,"lizhi_open_revision",{drawingId:"cabinet_01",revision:2});
    assert.equal(recent.revision,2);
    state=await a.tool(session2,"inspect_drawing",{entities:false});
    assert.equal(state.entityCount,2);
    ok("New native Rust process opens old and latest real DXF with correct geometry");

    const secretB=randomToken();
    B=createDevServer({cliPath:bin,token:secretB,storeRoot:root,ownerId:"owner_B"});
    const b=await client(B,secretB);
    const other=await b.init();
    const denied=await b.tool(other,"lizhi_open_revision",{drawingId:"cabinet_01"},true);
    assert.equal(denied.error,"NOT_FOUND");
    const deniedList=await b.tool(other,"lizhi_list_revisions",{drawingId:"cabinet_01"},true);
    assert.equal(deniedList.error,"NOT_FOUND");
    ok("Server-bound owner identity prevents cross-owner drawing lookup");
    await B.close();B=null;

    // Two CAD sessions load version 2; only one may publish version 3.
    await a.tool(session1,"lizhi_open_revision",{drawingId:"cabinet_01",revision:2});
    await a.tool(session1,"execute",{command:"circle",params:{center:[40,30],radius:2}});
    await a.tool(session2,"execute",{command:"circle",params:{center:[50,30],radius:2}});
    const results=await Promise.all([
      a.send("tools/call",{name:"lizhi_save_revision",arguments:{expectedRevision:2}},session1),
      a.send("tools/call",{name:"lizhi_save_revision",arguments:{expectedRevision:2}},session2),
    ]);
    const committed=results.filter(r=>r.body.result?.isError!==true);
    const rejected=results.filter(r=>r.body.result?.isError===true);
    assert.equal(committed.length,1,"Exactly one concurrent revision should be published");
    assert.equal(rejected.length,1,"Exactly one concurrent revision should conflict");
    assert.equal(JSON.parse(committed[0].body.result.content[0].text).revision,3);
    assert.equal(JSON.parse(rejected[0].body.result.content[0].text).error,"VERSION_CONFLICT");
    ok("Two native CAD sessions cannot overwrite the same committed revision");

    await A.close();A=null;
    const newToken=randomToken();
    restarted=createDevServer({cliPath:bin,token:newToken,storeRoot:root,ownerId:"owner_A"});
    const c=await client(restarted,newToken);
    const s=await c.init();
    const openAfterRestart=await c.tool(s,"lizhi_open_revision",{drawingId:"cabinet_01"});
    assert.equal(openAfterRestart.revision,3);
    const draw=await c.tool(s,"inspect_drawing",{entities:false});
    assert.equal(draw.entityCount,3);
    const versionsAfter=await c.tool(s,"lizhi_list_revisions",{drawingId:"cabinet_01"});
    assert.deepEqual(versionsAfter.revisions.map(x=>x.revision),[1,2,3]);
    ok("After HTTP service restart: original native DXF drawing and all revisions are restored");

    const report={name:"LiZhi native CADCraft MCP + local immutable DXF end-to-end",
      passed:tests,revisionCount:3,latestEntityCount:draw.entityCount,
      isolatedOwners:true,blockedPathAccess:true,staleWriteRejected:true,
      nativeReopenAfterGatewayRestart:true,fullCloudOAuth:false,
      publicNetworkAccess:false,multiHostSafe:false,productionReady:false};
    if(evidence){
      await fs.mkdir(evidence,{recursive:true});
      await fs.writeFile(path.join(evidence,"drawing-native-mcp-versions.json"),JSON.stringify(report,null,2));
    }
    assert.equal(tests,8);
    console.log("LIZHI_CAD_NATIVE_DXF_VERSIONS_E2E_PASS",JSON.stringify(report));
  }finally{
    if(B)await B.close().catch(()=>{});
    if(restarted)await restarted.close().catch(()=>{});
    if(A)await A.close().catch(()=>{});
    await fs.rm(tmp,{recursive:true,force:true});
  }
}
run().catch(e=>{console.error(e);process.exitCode=1});

"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const path=require("node:path");
const {randomBytes}=require("node:crypto");
const {createDevServer}=require("./server.cjs");

const cli=process.argv[2];
const evidence=process.argv[3];
if(!cli)throw Error("Supply source-built CADCraft CLI path");
async function main(){
  const token=randomBytes(32).toString("hex");
  const app=createDevServer({cliPath:cli,token});
  const address=await app.listen();
  const url="http://127.0.0.1:"+address.port;
  const auth={authorization:"Bearer "+token,accept:"application/json, text/event-stream","content-type":"application/json"};
  let id=1;
  async function post(method,params={},session,headers={}){
    const payload={jsonrpc:"2.0",id:id++,method,params};
    const r=await fetch(url+"/mcp",{method:"POST",headers:{...auth,...(session?{"mcp-session-id":session}:{}),...headers},body:JSON.stringify(payload)});
    return {http:r.status,session:r.headers.get("mcp-session-id"),body:await r.json()};
  }
  async function tool(session,name,args={}){
    const r=await post("tools/call",{name,arguments:args},session);
    assert.equal(r.http,200,JSON.stringify(r.body));
    assert.ok(!r.body.error,"Native MCP returned error for "+name+": "+JSON.stringify(r.body));
    assert.notEqual(r.body.result?.isError,true,"Native CAD tool failed for "+name);
    const content=r.body.result.content?.[0];
    assert.ok(content,"No MCP content for "+name);
    return content.type==="text"?JSON.parse(content.text):content;
  }
  try{
    let r=await fetch(url+"/mcp",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
    assert.equal(r.status,401,"Missing bearer must be rejected");
    r=await fetch(url+"/mcp",{method:"POST",headers:{...auth,origin:"https://evil.example"},body:"{}"});
    assert.equal(r.status,403,"Foreign browser origin must be rejected");
    r=await fetch(url+"/mcp",{method:"GET",headers:auth});
    assert.equal(r.status,405,"SSE GET is intentionally unsupported in isolated prototype");
    const init=await post("initialize",{protocolVersion:"2025-06-18",clientInfo:{name:"lizhi-local-test",version:"1"},capabilities:{}});
    assert.equal(init.http,200,JSON.stringify(init.body));
    assert.equal(init.body.result.serverInfo.name,"cadcraft");
    const sid=init.session;
    assert.ok(/^[0-9a-f]{48}$/.test(sid),"Session id not secure random hex");

    r=await fetch(url+"/mcp",{method:"POST",headers:{...auth,"mcp-session-id":sid},body:JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})});
    assert.equal(r.status,202,"Notification should get HTTP 202");
    const listed=await post("tools/list",{},sid);
    assert.equal(listed.http,200);
    const names=listed.body.result.tools.map(x=>x.name);
    assert.deepEqual(names.slice().sort(),["list_commands","inspect_drawing","query_entities","find_text","render","new_drawing","execute"].sort());
    const cmds=await post("tools/call",{name:"execute",arguments:{command:"open",params:{path:"/etc/passwd"}}},sid);
    assert.equal(cmds.body.error?.code,-32602,"Arbitrary file opening must be refused");
    const save=await post("tools/call",{name:"save",arguments:{path:"/tmp/unsafe.dxf"}},sid);
    assert.equal(save.body.error?.code,-32602,"Arbitrary save must be refused");
    await tool(sid,"new_drawing",{metric:true});
    await tool(sid,"execute",{command:"rectang",params:{p1:[0,0],p2:[100,60]}});
    await tool(sid,"execute",{command:"circle",params:{center:[10,10],radius:5}});
    const entities=await tool(sid,"query_entities",{limit:20});
    assert.equal(entities.count,2,"Native drawing state lost across HTTP requests");
    const png=await tool(sid,"render",{width:320,height:240});
    assert.equal(png.type,"image");
    const image=Buffer.from(png.data,"base64");
    assert.ok(image.length>200);
    assert.equal(image.subarray(0,8).toString("hex"),"89504e470d0a1a0a");

    const initB=await post("initialize",{protocolVersion:"2025-06-18",clientInfo:{name:"another-dev-session",version:"1"},capabilities:{}});
    assert.equal(initB.http,200);
    assert.notEqual(initB.session,sid);
    const fresh=await tool(initB.session,"inspect_drawing",{entities:false});
    assert.equal(fresh.entityCount,0,"Fresh HTTP session leaked geometry from another CAD drawing");

    r=await fetch(url+"/mcp",{method:"DELETE",headers:{...auth,"mcp-session-id":sid}});
    assert.equal(r.status,204);
    assert.equal((await post("tools/list",{},sid)).http,404);
    assert.equal((await post("tools/list",{},"000000000000000000000000000000000000000000000000")).http,404);
    r=await fetch(url+"/mcp",{method:"DELETE",headers:{...auth,"mcp-session-id":initB.session}});
    assert.equal(r.status,204);

    const report={mode:"localhost-only-authenticated-dev-prototype",protocol:"2025-06-18",bind:"127.0.0.1",allowedTools:names,
      deniedUnknownToken:true,deniedForeignOrigin:true,deniedFileOpen:true,deniedFileSave:true,
      drawingEntities:entities.count,renderPngBytes:image.length,isolatedSession:true,
      sessionRevoked:true,remoteProduction:false,oauthImplemented:false,storagePersistent:false};
    if(evidence){
      await fs.mkdir(evidence,{recursive:true});
      await fs.writeFile(path.join(evidence,"local-http-mcp-smoke.json"),JSON.stringify(report,null,2));
      await fs.writeFile(path.join(evidence,"local-http-mcp-render.png"),image);
    }
    console.log("LIZHI_CAD_HTTP_DEV_MCP_PASS",JSON.stringify(report));
  }finally{await app.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});

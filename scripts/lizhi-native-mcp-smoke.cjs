"use strict";
// E2E against the CADCraft v0.12.0 source-built *native* stdio MCP, not a mock.
// Run: node lizhi-native-mcp-smoke.cjs /path/to/cadcraft-cli [evidence/dir] [--readonly]
const assert=require("node:assert/strict");
const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {spawn}=require("node:child_process");
const bin=process.argv[2];
const evidence=process.argv[3]||null;
const readOnly=process.argv.includes("--readonly");
const geometryOnly=process.argv.includes("--geometry-only");
if(!bin)throw Error("Supply path to SOURCE-BUILT cadcraft-cli");
async function main(){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"cadcraft-native-mcp-"));
  let child=null,timer=null;
  try{
    const pending=new Map();
    let nextId=1,stdout="",stderr="";
    child=spawn(bin,["mcp"],{stdio:["pipe","pipe","pipe"],shell:false,env:{PATH:process.env.PATH||"",HOME:temp,CADCRAFT_CONFIG_DIR:temp,...(readOnly?{LIZHI_CAD_MCP_READ_ONLY:"1"}:{}),...(geometryOnly?{LIZHI_CAD_MCP_GEOMETRY_ONLY:"1"}:{})}});
    const failAll=(reason)=>{for(const p of pending.values())p.reject(new Error(reason));pending.clear();};
    child.on("error",err=>failAll("CADCraft MCP spawn: "+err.message));
    child.on("close",(code,signal)=>failAll("CADCraft MCP exited: "+code+"/"+signal+" "+stderr.slice(-300)));
    child.stderr.on("data",b=>{stderr=(stderr+b.toString()).slice(-4000);});
    child.stdout.on("data",b=>{
      stdout+=b.toString("utf8");
      if(stdout.length>8*1024*1024){failAll("MCP stdout buffer exceeded 8 MiB");child.kill("SIGKILL");return;}
      let i;
      while((i=stdout.indexOf("\n"))>=0){
        const raw=stdout.slice(0,i).trim();stdout=stdout.slice(i+1);
        if(!raw)continue;
        let data;try{data=JSON.parse(raw);}catch(e){failAll("Invalid JSON-RPC response from MCP");return;}
        const p=pending.get(data.id);if(!p)continue;pending.delete(data.id);p.resolve(data);
      }
    });
    timer=setTimeout(()=>{failAll("MCP smoke timed out");child?.kill("SIGKILL");},75000);
    const send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=nextId++;pending.set(id,{resolve,reject});
      child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n",err=>{if(err){pending.delete(id);reject(err);}});
    });
    async function rpc(method,params={}){
      const out=await send(method,params);assert.equal(out.jsonrpc,"2.0");
      assert.ok(!out.error,method+" returned error "+JSON.stringify(out.error));
      return out.result;
    }
    async function tool(name,args={}){
      const r=await rpc("tools/call",{name,arguments:args});
      assert.notEqual(r.isError,true,"MCP tool returned failure "+name);
      const v=r.content?.[0];assert.ok(v,"Missing MCP content for "+name);
      return v.type==="text"?JSON.parse(v.text):v;
    }
    const init=await rpc("initialize",{protocolVersion:"2025-06-18",clientInfo:{name:"lizhi-source-baseline",version:"1.0"},capabilities:{}});
    assert.equal(init.serverInfo?.name,"cadcraft");
    assert.equal(init.protocolVersion,"2025-06-18");
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
    const tools=await rpc("tools/list");
    const names=tools.tools.map(x=>x.name);
    if(geometryOnly && !readOnly){
      const allowed=["list_commands","inspect_drawing","query_entities","find_text","render","new_drawing","execute"];
      assert.deepEqual([...names].sort(), [...allowed].sort(),"Geometry MCP must advertise only safe CAD tools");
      const denied=[
        ["command_line",{text:"erase all"}],
        ["script",{text:"_quit"}],
        ["save",{path:path.join(temp,"bypass.dxf")}],
        ["open",{path:"/etc/passwd"}],
        ["execute",{command:"open",params:{path:"/etc/passwd"}}],
        ["execute",{command:"saveas",params:{path:"/tmp/bypass.dxf"}}],
        ["render",{path:path.join(temp,"bypass.png")}],
        ["render",{width:5000}],
      ];
      for(const [name,args] of denied){
        const r=await send("tools/call",{name,arguments:args});
        assert.equal(r.error?.code,-32602,"Forbidden CAD request must fail: "+name+" "+JSON.stringify(args));
      }
      await tool("new_drawing",{metric:true});
      await tool("execute",{command:"rectang",params:{p1:[0,0],p2:[100,60]}});
      await tool("execute",{command:"circle",params:{center:[10,10],radius:5}});
      const geometry=await tool("query_entities",{limit:10});
      assert.equal(geometry.count,2,"Geometry-only mode must create real CAD entities");
      const render=await tool("render",{width:320,height:240});
      assert.equal(render.type,"image");
      assert.ok(render.data.length>100);
      const afterFiles=await fs.readdir(temp);
      assert.ok(!afterFiles.some(n=>n.startsWith("bypass")),"Geometry-only MCP unexpectedly wrote to file");
      const proof={mode:"geometry-only",entities:geometry.count,allowedTools:names,blocked:denied.length,renderPngBytes:Buffer.from(render.data,"base64").length,unauthorizedDiskWrites:false};
      if(evidence){
        await fs.mkdir(evidence,{recursive:true});
        await fs.writeFile(path.join(evidence,"native-mcp-geometry-only.json"),JSON.stringify(proof,null,2));
        await fs.writeFile(path.join(evidence,"native-mcp-geometry-only.png"),Buffer.from(render.data,"base64"));
      }
      console.log("LIZHI_NATIVE_MCP_GEOMETRY_ONLY_PASS",JSON.stringify(proof));
      return;
    }
    if(readOnly){
      const allowed=["list_commands","inspect_drawing","query_entities","find_text","render"];
      assert.deepEqual([...names].sort(), [...allowed].sort(),"Read-only MCP must advertise exactly the safe tools");
      const renderSpec=tools.tools.find(x=>x.name==="render");
      assert.ok(!("path" in (renderSpec.inputSchema?.properties||{})),"Render path must not be advertised");
      const summary=await tool("inspect_drawing",{});
      assert.equal(summary.entityCount,0,"Fresh read-only session should be empty");
      for(const [name,args] of [
        ["command_line",{text:"circle 0,0 1"}],
        ["execute",{command:"circle",params:{center:[0,0],radius:2}}],
        ["save",{path:path.join(temp,"no-output.dxf")}],
        ["render",{path:path.join(temp,"no-output.png")}],
      ]){
        const out=await send("tools/call",{name,arguments:args});
        assert.equal(out.error?.code,-32602,"Read-only MCP must reject "+name);
      }
      const files=await fs.readdir(temp);
      assert.ok(!files.some(n=>n.startsWith("no-output")),"Read-only MCP wrote a forbidden file");
      if(evidence){
        await fs.mkdir(evidence,{recursive:true});
        await fs.writeFile(path.join(evidence,"native-mcp-readonly.json"),JSON.stringify({tools:names,denied_tools:["command_line","execute","save","render(path)"],geometry_unchanged:true,no_files_written:true},null,2));
      }
      console.log("LIZHI_NATIVE_MCP_READ_ONLY_PASS",JSON.stringify({tools:names.length,blocked:4}));
      return;
    }
    for(const name of ["command_line","execute","inspect_drawing","query_entities","render","new_drawing","save","open"])
      assert.ok(names.includes(name),"Missing native MCP tool "+name);
    assert.ok(!names.includes("ui_click"),"Headless MCP must not expose desktop click tools");
    await tool("new_drawing",{metric:true});
    await tool("command_line",{text:"rectang 0,0 800,900"});
    const a=await tool("inspect_drawing",{entities:false});
    assert.equal(a.entityCount,1,JSON.stringify(a).slice(0,300));
    const entities=await tool("query_entities",{type:"Polyline",limit:10});
    assert.equal(entities.count,1,JSON.stringify(entities).slice(0,300));
    await tool("execute",{command:"circle",params:{center:[100,100],radius:25}});
    const b=await tool("inspect_drawing",{entities:false});
    assert.equal(b.entityCount,2,JSON.stringify(b).slice(0,300));
    const image=await tool("render",{width:320,height:240});
    assert.equal(image.type,"image");
    assert.equal(image.mimeType,"image/png");
    assert.ok(image.data.length>100,"Empty PNG rendered");
    const file=path.join(temp,"native-mcp-test.dxf");
    await tool("save",{path:file});
    assert.ok((await fs.stat(file)).size>200,"DXF not saved");
    await tool("open",{path:file});
    const c=await tool("inspect_drawing",{entities:false});
    assert.equal(c.entityCount,2,"MCP reopened DXF changed geometry");
    const report={source:"LiZhi fork built from pinned CADCraft v0.12.0 Rust source",engine:"native cadcraft-cli mcp",protocol:init.protocolVersion,tool_names:names,rectangles:entities.count,entity_count_before:a.entityCount,entity_count_after:c.entityCount,headless_ui_click_exposed:false,actual_dxf_reopened:true,render_png_bytes:Buffer.from(image.data,"base64").length};
    if(evidence){
      await fs.mkdir(evidence,{recursive:true});
      await fs.writeFile(path.join(evidence,"native-mcp-smoke.json"),JSON.stringify(report,null,2));
      await fs.copyFile(file,path.join(evidence,"native-mcp-smoke.dxf"));
      await fs.writeFile(path.join(evidence,"native-mcp-smoke.png"),Buffer.from(image.data,"base64"));
    }
    console.log("CADCRAFT_SOURCE_BUILT_NATIVE_MCP_PASS",JSON.stringify({entity_count:report.entity_count_after,tools:names.length,dxf_reopen:report.actual_dxf_reopened,png_bytes:report.render_png_bytes}));
  }finally{
    if(timer)clearTimeout(timer);
    if(child){child.kill("SIGKILL");child.stdin?.destroy();}
    await fs.rm(temp,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});

"use strict";
// LOCAL TEST ONLY: trusted single-operator, loopback-bound Streamable HTTP
// bridge to source-built CADCraft's native stdio MCP. Not a public OAuth server.
// Production still needs OAuth 2.1, per-user ACL, origin/audience checks and
// durable storage. Never deploy this process behind a public reverse proxy.
const http=require("node:http");
const {spawn}=require("node:child_process");
const {randomBytes,timingSafeEqual}=require("node:crypto");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");

const MAX_BODY=64*1024;
const MAX_SESSIONS=2;
const MAX_IDLE=5*60*1000;
const REQUEST_TIMEOUT=20000;
const HOST="127.0.0.1";

function response(res,status,body,headers={}){
  res.writeHead(status,{"cache-control":"no-store","x-content-type-options":"nosniff",...headers,
    ...(body===null?{}:{"content-type":"application/json; charset=utf-8"})});
  res.end(body===null?"":JSON.stringify(body));
}
function checkBearer(req,secret){
  const m=/^Bearer ([a-zA-Z0-9_-]+)$/.exec(req.headers.authorization||"");
  if(!m)return false;
  const got=Buffer.from(m[1]);
  const expected=Buffer.from(secret);
  return got.length===expected.length && timingSafeEqual(got,expected);
}
async function readJson(req){
  let size=0;const buffers=[];
  for await(const chunk of req){
    size+=chunk.length;
    if(size>MAX_BODY)throw Object.assign(new Error("payload too large"),{httpStatus:413});
    buffers.push(chunk);
  }
  let value;
  try{value=JSON.parse(Buffer.concat(buffers).toString("utf8"))}
  catch{throw Object.assign(new Error("invalid JSON"),{httpStatus:400})}
  if(!value||Array.isArray(value)||typeof value!=="object"||value.jsonrpc!=="2.0"
     ||typeof value.method!=="string"||(!Number.isSafeInteger(value.id)&&typeof value.id!=="string"&&value.id!==undefined)){
    throw Object.assign(new Error("invalid JSON-RPC request"),{httpStatus:400});
  }
  return value;
}
function spawnNative(cli){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),"lizhi-cad-dev-mcp-"));
  const child=spawn(cli,["mcp"],{
    cwd,
    shell:false,
    stdio:["pipe","pipe","pipe"],
    env:{PATH:process.env.PATH||"",HOME:cwd,TMPDIR:cwd,LANG:"C.UTF-8",
      LIZHI_CAD_MCP_GEOMETRY_ONLY:"1",LIZHI_CAD_MCP_READ_ONLY:"0"}
  });
  const s={child,cwd,id:randomBytes(24).toString("hex"),pending:null,stdout:"",queue:Promise.resolve(),last:Date.now(),closed:false};
  function fail(reason){
    if(s.pending){clearTimeout(s.pending.timer);s.pending.reject(new Error(reason));s.pending=null;}
  }
  child.stdout.on("data",buf=>{
    s.stdout+=buf.toString("utf8");
    if(s.stdout.length>4*1024*1024){fail("CAD MCP response too large");child.kill("SIGKILL");return}
    for(let at;(at=s.stdout.indexOf("\n"))>=0;){
      const line=s.stdout.slice(0,at).trim();s.stdout=s.stdout.slice(at+1);
      if(!line)continue;
      let obj;try{obj=JSON.parse(line)}catch{fail("invalid native MCP JSON-RPC");continue}
      if(!s.pending)continue;
      const {resolve,timer}=s.pending;s.pending=null;clearTimeout(timer);resolve(obj);
    }
  });
  child.stderr.on("data",()=>{}); // Never log CAD data, credentials or file paths.
  child.on("error",()=>fail("native CADCraft MCP failed to spawn"));
  child.on("close",()=>{s.closed=true;fail("native CADCraft MCP terminated")});
  s.call=(msg)=>{
    s.last=Date.now();
    const job=async()=>{
      if(s.closed)throw new Error("MCP session closed");
      return new Promise((resolve,reject)=>{
        const notification=msg.id===undefined;
        if(notification){
          child.stdin.write(JSON.stringify(msg)+"\n",e=>e?reject(e):resolve(null));
          return;
        }
        const timer=setTimeout(()=>{fail("native MCP request timeout");child.kill("SIGKILL");},REQUEST_TIMEOUT);
        s.pending={resolve,reject,timer};
        child.stdin.write(JSON.stringify(msg)+"\n",e=>{if(e){fail("cannot send native MCP request")}})
      });
    };
    // Serializes same-session calls, avoiding JSON-RPC id collisions.
    const result=s.queue.then(job);
    s.queue=result.catch(()=>{});
    return result;
  };
  s.close=()=>{
    if(s.closed)return;
    s.closed=true;
    fail("session closed");
    child.kill("SIGKILL");
    try{fs.rmSync(cwd,{recursive:true,force:true})}catch{}
  };
  return s;
}
function createDevServer({cliPath,token,port=0}){
  if(!cliPath||!fs.existsSync(cliPath))throw Error("missing source-built CADCraft CLI");
  if(typeof token!=="string"||token.length<32||!/^[a-zA-Z0-9_-]+$/.test(token))throw Error("dev token must be random and >=32 ascii chars");
  const sessions=new Map();
  const server=http.createServer(async(req,res)=>{
    try{
      const actualPort=server.address()?.port;
      const validHost=new Set(["127.0.0.1:"+actualPort,"localhost:"+actualPort]);
      if(!validHost.has(req.headers.host)){response(res,403,{error:"untrusted host"});return}
      if(req.headers.origin&&!["http://127.0.0.1:"+actualPort,"http://localhost:"+actualPort].includes(req.headers.origin)){
        response(res,403,{error:"untrusted origin"});return;
      }
      if(req.url==="/healthz"&&req.method==="GET"){response(res,200,{ok:true,transport:"loopback-dev-only"});return}
      if(req.url!=="/mcp"){response(res,404,{error:"not found"});return}
      if(!checkBearer(req,token)){
        response(res,401,{error:"authorization required"},{"www-authenticate":"Bearer"});return;
      }
      if(req.method==="GET"){response(res,405,{error:"SSE not supported"},{"allow":"POST, DELETE"});return}
      if(req.method==="DELETE"){
        const id=req.headers["mcp-session-id"];
        if(typeof id!=="string"||!sessions.has(id)){response(res,404,{error:"unknown session"});return}
        sessions.get(id).close();sessions.delete(id);
        response(res,204,null);return;
      }
      if(req.method!=="POST"){response(res,405,{error:"method not allowed"},{"allow":"POST, DELETE"});return}
      const msg=await readJson(req);
      let session;
      if(msg.method==="initialize"){
        if(sessions.size>=MAX_SESSIONS){response(res,429,{error:"session limit reached"});return}
        session=spawnNative(cliPath);
        sessions.set(session.id,session);
      }else{
        const id=req.headers["mcp-session-id"];
        if(typeof id!=="string"||!sessions.has(id)){response(res,404,{error:"unknown session"});return}
        session=sessions.get(id);
      }
      const result=await session.call(msg);
      if(result===null){response(res,202,null,{"mcp-session-id":session.id});return}
      response(res,200,result,{"mcp-session-id":session.id,"mcp-protocol-version":"2025-06-18"});
    }catch(e){
      // On malformed requests return only a sanitized error, no paths or secrets.
      const status=e.httpStatus||503;
      response(res,status,{error:e.httpStatus?e.message:"MCP session operation unavailable"});
    }
  });
  const idleTimer=setInterval(()=>{
    for(const [id,s] of sessions){
      if(s.closed||Date.now()-s.last>MAX_IDLE){s.close();sessions.delete(id)}
    }
  },30000);
  idleTimer.unref();
  server.on("close",()=>{clearInterval(idleTimer);for(const s of sessions.values())s.close();sessions.clear()});
  return {server,sessions,listen:()=>new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(port,HOST,()=>{server.removeListener("error",reject);resolve(server.address())})
  }),close:()=>new Promise(resolve=>server.close(resolve))};
}
module.exports={createDevServer};
if(require.main===module){
  const app=createDevServer({cliPath:process.env.LIZHI_CAD_CLI,token:process.env.LIZHI_CAD_MCP_DEV_TOKEN,
    port:Number(process.env.LIZHI_CAD_MCP_PORT||0)});
  app.listen().then(({address,port})=>process.stdout.write("LIZHI_CAD_LOCAL_DEV_MCP_READY http://"+address+":"+port+"/mcp\n"))
    .catch(()=>{process.stderr.write("Cannot start local CAD MCP test server\n");process.exitCode=1});
  process.on("SIGTERM",()=>app.close());
}

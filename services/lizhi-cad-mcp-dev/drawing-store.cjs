"use strict";
/**
 * LiZhi CAD local prototype: private immutable DXF revisions.
 *
 * The caller MUST derive ownerId from a VERIFIED identity; never accept it from
 * the model or untrusted HTTP JSON. No auth, cloud replication or cross-host
 * locking is supplied by this module. NOT YET wired to native MCP sessions.
 */
const fs=require("node:fs/promises");
const path=require("node:path");
const crypto=require("node:crypto");

const MAX_DXF=8*1024*1024;
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
class StoreError extends Error {
  constructor(code,message){super(message);this.name="StoreError";this.code=code;}
}
function goodId(value,label) {
  if(typeof value!=="string"||!ID.test(value)||value==="."||value==="..")
    throw new StoreError("INVALID_ID","Invalid "+label);
  return value;
}
function goodRevision(value){
  if(!Number.isSafeInteger(value)||value<0||value>1000000)
    throw new StoreError("INVALID_REVISION","Expected a nonnegative revision number");
  return value;
}
function hash(buffer){return crypto.createHash("sha256").update(buffer).digest("hex")}
function verifyDXF(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length<30||bytes.length>MAX_DXF)
    throw new StoreError("INVALID_DXF","DXF must be Buffer of 30 bytes to 8 MiB");
  // This prototype deliberately accepts ASCII DXF only, not binary DXF / DWG.
  const text=bytes.toString("latin1");
  if(!/\bSECTION\b/.test(text.slice(0,1024))||!text.trimEnd().endsWith("EOF"))
    throw new StoreError("INVALID_DXF","Only complete ASCII DXF drawings are accepted");
  return bytes;
}
async function dirChecked(dir){
  await fs.mkdir(dir,{recursive:false,mode:0o700}).catch(e=>{
    if(e.code!=="EEXIST")throw e;
  });
  const stat=await fs.lstat(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink())
    throw new StoreError("UNSAFE_PATH","Symlink/non-directory in store path");
}
async function readJson(file){
  try{return JSON.parse(await fs.readFile(file,"utf8"))}
  catch(e){
    if(e.code==="ENOENT")return null;
    throw new StoreError("CORRUPT_METADATA","Unreadable drawing metadata");
  }
}
async function writeNew(file,bytes){
  const handle=await fs.open(file,"wx",0o600);
  try{await handle.writeFile(bytes);await handle.sync();}
  finally{await handle.close();}
}
async function writeHead(dir,obj){
  const tmp=path.join(dir,"."+crypto.randomBytes(10).toString("hex")+".tmp");
  try{
    await writeNew(tmp,Buffer.from(JSON.stringify(obj)+"\n","utf8"));
    await fs.rename(tmp,path.join(dir,"HEAD.json"));
  }finally{await fs.rm(tmp,{force:true})}
}
class DrawingStore {
  constructor(root){
    if(typeof root!=="string"||!path.isAbsolute(root))throw new StoreError("INVALID_ROOT","Storage root must be absolute");
    this.root=path.resolve(root);
    this.queues=new Map();
  }
  async directories(ownerId,drawingId,create){
    const owner=goodId(ownerId,"ownerId");
    const drawing=goodId(drawingId,"drawingId");
    const levels=[this.root,path.join(this.root,owner),path.join(this.root,owner,drawing)];
    if(create){
      // Protect every path component against replacing a drawing directory with a symlink.
      // The root's ancestor directories must themselves be trusted by the service operator.
      for(const dir of levels)await dirChecked(dir);
    }else{
      for(const dir of levels){
        let s;try{s=await fs.lstat(dir)}catch(e){
          if(e.code==="ENOENT")throw new StoreError("NOT_FOUND","Drawing not found");
          throw e;
        }
        if(!s.isDirectory()||s.isSymbolicLink())throw new StoreError("UNSAFE_PATH","Unsafe drawing directory");
      }
    }
    return levels[2];
  }
  // Serializes writes per drawing in *one* process. A real multi-host deployment
  // must replace this with database transactional CAS or a distributed lock.
  async locked(key,fn){
    const prev=this.queues.get(key)||Promise.resolve();
    let finish;
    const completion=new Promise(resolve=>finish=resolve);
    this.queues.set(key,completion);
    await prev;
    try{return await fn()}
    finally{
      if(this.queues.get(key)===completion)this.queues.delete(key);
      finish();
    }
  }
  async append({ownerId,drawingId,expectedRevision,bytes}){
    goodId(ownerId,"ownerId");goodId(drawingId,"drawingId");
    goodRevision(expectedRevision);
    verifyDXF(bytes);
    const key=ownerId+"/"+drawingId;
    return this.locked(key,async()=>{
      const dir=await this.directories(ownerId,drawingId,true);
      const head=await readJson(path.join(dir,"HEAD.json"));
      const current=head?.revision??0;
      if(current!==expectedRevision)
        throw new StoreError("VERSION_CONFLICT","Drawing revision has changed");
      const revision=current+1,digest=hash(bytes);
      const stem="rev-"+String(revision).padStart(6,"0");
      const meta={version:1,ownerId,drawingId,revision,sha256:digest,size:bytes.length,createdAt:new Date().toISOString()};
      const dxf=path.join(dir,stem+".dxf"),info=path.join(dir,stem+".json");
      try{
        await writeNew(dxf,bytes);
        await writeNew(info,Buffer.from(JSON.stringify(meta)+"\n"));
        await writeHead(dir,{revision,sha256:digest});
      }catch(e){
        // Safe best-effort cleanup of an interrupted unpublished revision. Never
        // touch any already-published rev; doing so would break immutability.
        const published=await readJson(path.join(dir,"HEAD.json")).catch(()=>null);
        if(published?.revision!==revision) {
          await fs.rm(dxf,{force:true}).catch(()=>{});
          await fs.rm(info,{force:true}).catch(()=>{});
        }
        throw e;
      }
      return Object.freeze({...meta});
    });
  }
  async head({ownerId,drawingId}){
    const dir=await this.directories(ownerId,drawingId,false);
    const h=await readJson(path.join(dir,"HEAD.json"));
    if(!h||!Number.isSafeInteger(h.revision)||h.revision<1||!/^[0-9a-f]{64}$/.test(h.sha256))
      throw new StoreError("NOT_FOUND","Drawing not found");
    return {...h};
  }
  async load({ownerId,drawingId,revision}){
    const dir=await this.directories(ownerId,drawingId,false);
    const h=await this.head({ownerId,drawingId});
    const version=revision===undefined?h.revision:goodRevision(revision);
    if(version<1||version>h.revision)throw new StoreError("NOT_FOUND","Revision not found");
    const stem="rev-"+String(version).padStart(6,"0");
    const meta=await readJson(path.join(dir,stem+".json"));
    if(!meta||meta.ownerId!==ownerId||meta.drawingId!==drawingId||meta.revision!==version)
      throw new StoreError("CORRUPT_METADATA","Stored revision metadata invalid");
    const dxfPath=path.join(dir,stem+".dxf");
    const stat=await fs.lstat(dxfPath).catch(e=>{if(e.code==="ENOENT")throw new StoreError("NOT_FOUND","DXF revision not found");throw e});
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==meta.size||stat.size>MAX_DXF)
      throw new StoreError("CORRUPT_DXF","Stored revision file invalid");
    const bytes=await fs.readFile(dxfPath);
    if(hash(bytes)!==meta.sha256||(version===h.revision&&meta.sha256!==h.sha256))
      throw new StoreError("CORRUPT_DXF","DXF integrity check failed");
    return {metadata:{...meta},bytes};
  }
  async list({ownerId,drawingId}){
    const h=await this.head({ownerId,drawingId});
    const versions=[];
    for(let revision=1;revision<=h.revision;revision++){
      const item=await this.load({ownerId,drawingId,revision});
      versions.push(item.metadata);
    }
    return versions;
  }
}
module.exports={DrawingStore,StoreError,MAX_DXF};

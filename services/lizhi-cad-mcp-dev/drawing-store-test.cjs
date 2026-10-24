"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const {DrawingStore,StoreError,MAX_DXF}=require("./drawing-store.cjs");
const tinyDXF=n=>Buffer.from(`0\nSECTION\n2\nENTITIES\n0\nLINE\n5\n1\n8\n0\n10\n0\n20\n0\n11\n${n}\n21\n5\n0\nENDSEC\n0\nEOF\n`);
async function rejectsCode(fn,code){
  await assert.rejects(fn,e=>e instanceof StoreError&&e.code===code,`Expected ${code}`);
}
async function run(){
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),"lizhi-dxf-store-"));
  let passed=0;
  async function check(title,fn){await fn();passed++;console.log("PASS",title)}
  try{
    const root=path.join(tmp,"private-store"),s=new DrawingStore(root);
    const original=tinyDXF(100),edited=tinyDXF(200);
    await check("Create revision 1 and verify SHA256",async()=>{
      const m=await s.append({ownerId:"account_A",drawingId:"cabinet_01",expectedRevision:0,bytes:original});
      assert.equal(m.revision,1);
      assert.match(m.sha256,/^[a-f0-9]{64}$/);
      const x=await s.load({ownerId:"account_A",drawingId:"cabinet_01"});
      assert.deepEqual(x.bytes,original);
      assert.equal(x.metadata.sha256,m.sha256);
    });
    await check("Revision 2 keeps revision 1 immutable",async()=>{
      const m=await s.append({ownerId:"account_A",drawingId:"cabinet_01",expectedRevision:1,bytes:edited});
      assert.equal(m.revision,2);
      assert.deepEqual((await s.load({ownerId:"account_A",drawingId:"cabinet_01",revision:1})).bytes,original);
      assert.deepEqual((await s.load({ownerId:"account_A",drawingId:"cabinet_01"})).bytes,edited);
      assert.deepEqual((await s.list({ownerId:"account_A",drawingId:"cabinet_01"})).map(x=>x.revision),[1,2]);
    });
    await check("Reject stale expected revision (optimistic CAS)",async()=>{
      await rejectsCode(()=>s.append({ownerId:"account_A",drawingId:"cabinet_01",expectedRevision:1,bytes:original}),"VERSION_CONFLICT");
      assert.equal((await s.head({ownerId:"account_A",drawingId:"cabinet_01"})).revision,2);
    });
    await check("Concurrent same-process writes have exactly one winner",async()=>{
      const result=await Promise.allSettled([s.append({ownerId:"account_A",drawingId:"cabinet_01",expectedRevision:2,bytes:original}),
        s.append({ownerId:"account_A",drawingId:"cabinet_01",expectedRevision:2,bytes:edited})]);
      assert.equal(result.filter(x=>x.status==="fulfilled").length,1);
      assert.equal(result.filter(x=>x.status==="rejected"&&x.reason?.code==="VERSION_CONFLICT").length,1);
      assert.equal((await s.head({ownerId:"account_A",drawingId:"cabinet_01"})).revision,3);
    });
    await check("Restart process: recover published HEAD and old versions",async()=>{
      const newProcess=new DrawingStore(root);
      assert.equal((await newProcess.head({ownerId:"account_A",drawingId:"cabinet_01"})).revision,3);
      assert.deepEqual((await newProcess.load({ownerId:"account_A",drawingId:"cabinet_01",revision:1})).bytes,original);
    });
    await check("Separate owner and drawing namespace",async()=>{
      await rejectsCode(()=>s.load({ownerId:"account_B",drawingId:"cabinet_01"}),"NOT_FOUND");
      await s.append({ownerId:"account_B",drawingId:"cabinet_01",expectedRevision:0,bytes:edited});
      assert.equal((await s.head({ownerId:"account_B",drawingId:"cabinet_01"})).revision,1);
      assert.equal((await s.head({ownerId:"account_A",drawingId:"cabinet_01"})).revision,3);
    });
    await check("Reject path traversal or malformed owner and drawing IDs",async()=>{
      for(const id of ["../x","/tmp/test","x/y",".","..","",String.fromCharCode(0)," "]) {
        await rejectsCode(()=>s.load({ownerId:id,drawingId:"cabinet_01"}),"INVALID_ID");
        await rejectsCode(()=>s.load({ownerId:"account_A",drawingId:id}),"INVALID_ID");
      }
    });
    await check("Reject invalid ASCII DXF and oversized payloads",async()=>{
      for(const bytes of [Buffer.from("not a dxf"),Buffer.alloc(MAX_DXF+1,0x41),Buffer.alloc(55,0x33)]) {
        await rejectsCode(()=>s.append({ownerId:"account_A",drawingId:"invalid",expectedRevision:0,bytes}),"INVALID_DXF");
      }
    });
    await check("Require valid nonnegative expected revision",async()=>{
      for(const expectedRevision of [null,-1,1.5,Number.MAX_SAFE_INTEGER+1,"3"]) {
        await rejectsCode(()=>s.append({ownerId:"account_A",drawingId:"cabinet_01",expectedRevision,bytes:original}),"INVALID_REVISION");
      }
    });
    await check("Tampered DXF is detected before serving",async()=>{
      const file=path.join(root,"account_A","cabinet_01","rev-000001.dxf");
      await fs.writeFile(file,Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n"));
      await rejectsCode(()=>s.load({ownerId:"account_A",drawingId:"cabinet_01",revision:1}),"CORRUPT_DXF");
    });
    await check("Disallow drawing-directory symlink escape",async()=>{
      const outside=path.join(tmp,"outside");await fs.mkdir(outside);
      await fs.symlink(outside,path.join(root,"account_A","linked_draw"));
      await rejectsCode(()=>s.append({ownerId:"account_A",drawingId:"linked_draw",expectedRevision:0,bytes:original}),"UNSAFE_PATH");
      assert.deepEqual(await fs.readdir(outside),[]);
    });
    await check("Disallow symlinked published DXF",async()=>{
      const dir=path.join(root,"account_B","cabinet_01");
      const source=path.join(dir,"rev-000001.dxf"),outside=path.join(tmp,"target-secret.dxf");
      await fs.writeFile(outside,edited);
      await fs.rm(source);await fs.symlink(outside,source);
      await rejectsCode(()=>s.load({ownerId:"account_B",drawingId:"cabinet_01",revision:1}),"CORRUPT_DXF");
    });
    await check("Does not follow invalid store root symlink",async()=>{
      const outside=path.join(tmp,"external");await fs.mkdir(outside);
      const link=path.join(tmp,"linked-store");await fs.symlink(outside,link);
      const bad=new DrawingStore(link);
      await rejectsCode(()=>bad.append({ownerId:"other",drawingId:"fig1",expectedRevision:0,bytes:original}),"UNSAFE_PATH");
      assert.deepEqual(await fs.readdir(outside),[]);
    });
    assert.equal(passed,13);
    console.log("LIZHI_DXF_IMMUTABLE_LOCAL_STORE_PASS",JSON.stringify({tests:passed,mode:"local-prototype-only",durableAcrossProcessRestart:true,privateNamespace:true,hasOAuth:false,cloudStorage:false,multiHostLock:false}));
  }finally{await fs.rm(tmp,{recursive:true,force:true})}
}
run().catch(e=>{console.error(e);process.exitCode=1});

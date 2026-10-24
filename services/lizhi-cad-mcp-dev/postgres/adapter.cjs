"use strict";
/**
 * Staging-only PostgreSQL storage adapter for the LiZhi CAD native MCP bridge.
 *
 * A trusted application authenticates the caller and supplies ownerId. This
 * adapter never accepts an owner from MCP tools or SQL sent by an end user.
 * Runtime DB credentials MUST be server-only; custom PostgreSQL GUCs can be
 * spoofed by users with arbitrary SQL access to the runtime role.
 *
 * PostgreSQL transactions provide atomic version CAS across hosts; the DXF
 * bytes live in the same database transaction as metadata (<=8 MiB).
 * This is not a finished production storage/auth/deployment configuration.
 */
const crypto=require("node:crypto");
const {StoreError,validateAsciiDXF,validateDrawingId}=require("../drawing-store.cjs");

function verifiedOwner(ownerId){return validateDrawingId(ownerId,"verified ownerId")}
function checkedRevision(value){
  if(!Number.isSafeInteger(value)||value<0||value>1000000)
    throw new StoreError("INVALID_REVISION","Invalid requested revision");
  return value;
}
function dataHash(buf){return crypto.createHash("sha256").update(buf).digest("hex")}
class PostgresDrawingStore {
  constructor(pool) {
    if(!pool||typeof pool.connect!=="function")throw new Error("PostgreSQL pool required");
    this.pool=pool;
  }
  async transaction(ownerId,fn){
    verifiedOwner(ownerId);
    const client=await this.pool.connect();
    let started=false;
    try{
      await client.query("BEGIN");
      started=true;
      await client.query("SELECT set_config('lizhi_cad.owner_id',$1,true)",[ownerId]);
      const result=await fn(client);
      await client.query("COMMIT");
      started=false;
      return result;
    }catch(e){
      if(started)await client.query("ROLLBACK").catch(()=>{});
      throw e;
    }finally{
      client.release();
    }
  }
  async append({ownerId,drawingId,expectedRevision,bytes}){
    validateDrawingId(drawingId,"drawingId");
    checkedRevision(expectedRevision);
    validateAsciiDXF(bytes);
    const hash=dataHash(bytes);
    const record=await this.transaction(ownerId,async(client)=>{
      const {rows}=await client.query(
        "SELECT result_status,new_revision,digest FROM lizhi_cad.save_revision($1,$2,$3,$4)",
        [drawingId,expectedRevision,bytes,hash]
      );
      return rows[0];
    });
    if(!record)throw new StoreError("STORAGE_ERROR","Database returned no version result");
    if(record.result_status==="VERSION_CONFLICT")
      throw new StoreError("VERSION_CONFLICT","Drawing revision has changed");
    if(record.result_status!=="SAVED"||record.digest!==hash||record.new_revision!==expectedRevision+1)
      throw new StoreError("STORAGE_ERROR","Database revision integrity mismatch");
    return {version:1,ownerId,drawingId,revision:record.new_revision,sha256:hash,size:bytes.length};
  }
  async head({ownerId,drawingId}){
    validateDrawingId(drawingId,"drawingId");
    const row=await this.transaction(ownerId,async(client)=>{
      const {rows}=await client.query(
        "SELECT revision,sha256 FROM lizhi_cad.drawing_heads WHERE drawing_id=$1",
        [drawingId]
      );
      return rows[0];
    });
    if(!row||!row.revision)throw new StoreError("NOT_FOUND","Drawing not found");
    return {revision:row.revision,sha256:row.sha256};
  }
  async load({ownerId,drawingId,revision}){
    validateDrawingId(drawingId,"drawingId");
    if(revision!==undefined)checkedRevision(revision);
    const row=await this.transaction(ownerId,async(client)=>{
      const {rows}=await client.query(
        "SELECT drawing_id,revision,sha256,dxf FROM lizhi_cad.load_revision($1,$2)",
        [drawingId,revision??null]
      );
      return rows[0];
    });
    if(!row)throw new StoreError("NOT_FOUND","Drawing revision not found");
    if(!Buffer.isBuffer(row.dxf)||dataHash(row.dxf)!==row.sha256)
      throw new StoreError("CORRUPT_DXF","PostgreSQL DXF integrity mismatch");
    validateAsciiDXF(row.dxf);
    return {metadata:{version:1,ownerId,drawingId,revision:row.revision,sha256:row.sha256,size:row.dxf.length},bytes:row.dxf};
  }
  async list({ownerId,drawingId}){
    validateDrawingId(drawingId,"drawingId");
    const rows=await this.transaction(ownerId,async(client)=>{
      const result=await client.query(
        "SELECT revision,sha256,created_at FROM lizhi_cad.list_revisions($1)",
        [drawingId]
      );
      return result.rows;
    });
    if(rows.length===0)throw new StoreError("NOT_FOUND","Drawing not found");
    return rows.map(x=>({ownerId,drawingId,revision:x.revision,sha256:x.sha256,createdAt:x.created_at}));
  }
}
module.exports={PostgresDrawingStore};

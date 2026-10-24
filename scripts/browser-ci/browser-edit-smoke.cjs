"use strict";
// Real browser command-line draw and DXF-download acceptance. No online deployment.
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const path=require("node:path");
const {chromium}=require("playwright");
const {PNG}=require("pngjs");
const origin=process.env.CAD_TEST_ORIGIN||"http://127.0.0.1:8771";
const out=path.resolve(process.env.CAD_BROWSER_EVIDENCE||"cad-browser-evidence");
function diffCount(a,b){
  const p=PNG.sync.read(a),q=PNG.sync.read(b);
  assert.equal(p.width,q.width);assert.equal(p.height,q.height);
  let n=0;
  for(let i=0;i<p.data.length;i+=4){
    const d=Math.abs(p.data[i]-q.data[i])+Math.abs(p.data[i+1]-q.data[i+1])+Math.abs(p.data[i+2]-q.data[i+2]);
    if(d>45)n++;
  }
  return n;
}
async function command(page,text){
  await page.keyboard.type(text,{delay:35});
  await page.keyboard.press("Enter");
  await page.waitForTimeout(180);
}
async function main(){
  await fs.mkdir(out,{recursive:true});
  const browser=await chromium.launch({headless:true,args:["--enable-webgl","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox"]});
  const errors=[];
  try{
    const context=await browser.newContext({viewport:{width:1366,height:820},acceptDownloads:true});
    const page=await context.newPage();
    page.on("pageerror",e=>errors.push(e.message));
    await page.goto(origin+"/?cpu",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>!document.getElementById("cadcraft_loading"),null,{timeout:90000});
    await page.waitForTimeout(900);
    const canvas=page.locator("#cadcraft_canvas");
    await canvas.click({position:{x:480,y:400}});
    await page.waitForTimeout(300);
    const before=await page.screenshot({animations:"disabled"});
    await fs.writeFile(path.join(out,"edit-before.png"),before);
    // Explicit Enter per CADCraft's AutoCAD-style prompt; matches native MCP command syntax.
    await command(page,"rectang");
    await command(page,"0,0");
    await command(page,"100,60");
    await command(page,"zoom");
    await command(page,"e");
    await page.waitForTimeout(850);
    const after=await page.screenshot({animations:"disabled"});
    await fs.writeFile(path.join(out,"edit-after.png"),after);
    const changed=diffCount(before,after);
    assert.ok(changed>1500,"Drawing did not visibly change (pixels="+changed+")");
    const downloadWait=page.waitForEvent("download",{timeout:18000});
    await page.keyboard.press("Control+s");
    const download=await downloadWait;
    const file=path.join(out,"edit-download.dxf");
    await download.saveAs(file);
    const buf=await fs.readFile(file);
    assert.ok(buf.length>250,"Downloaded DXF too small");
    const dxf=buf.toString("utf8");
    assert.ok(/LWPOLYLINE|POLYLINE/.test(dxf),"Downloaded file does not contain a polyline");
    const pairs=dxf.replace(/\r/g,"").split("\n").reduce((out,line,i,lines)=>{
      if(i%2===0&&i+1<lines.length)out.push([line.trim(),lines[i+1].trim()]);
      return out;
    },[]);
    const start=pairs.findIndex(([code,value])=>code==="0"&&value==="LWPOLYLINE");
    assert.ok(start>=0,"Rectangle is not encoded as LWPOLYLINE");
    const vertices=[];
    let lastX=null;
    for(let i=start+1;i<pairs.length;i++){
      const [code,value]=pairs[i];
      if(code==="0")break;
      if(code==="10")lastX=Number(value);
      if(code==="20"&&lastX!==null){
        vertices.push([lastX,Number(value)]);
        lastX=null;
      }
    }
    assert.ok(vertices.length>=4,"Rectangle should contain at least 4 DXF polyline vertices");
    const xVals=vertices.map(v=>v[0]),yVals=vertices.map(v=>v[1]);
    const extents={minX:Math.min(...xVals),maxX:Math.max(...xVals),minY:Math.min(...yVals),maxY:Math.max(...yVals)};
    const approx=(a,b)=>Math.abs(a-b)<0.0001;
    assert.ok(approx(extents.minX,0)&&approx(extents.maxX,100)&&approx(extents.minY,0)&&approx(extents.maxY,60),
      "Incorrect actual DXF rectangle coordinates: "+JSON.stringify({extents,vertices}));

    // The browser's own File > Open picker must accept the exact DXF we just saved.
    const pickerWait=page.waitForEvent("filechooser",{timeout:16000});
    await page.keyboard.press("Control+o");
    const picker=await pickerWait;
    await picker.setFiles(file);
    await page.waitForTimeout(1100);
    const reopenDownloadWait=page.waitForEvent("download",{timeout:16000});
    await page.keyboard.press("Control+s");
    const reopenDownload=await reopenDownloadWait;
    const reopenedFile=path.join(out,"edit-reopened-download.dxf");
    await reopenDownload.saveAs(reopenedFile);
    const reopened=(await fs.readFile(reopenedFile)).toString("utf8");
    assert.ok(reopened.includes("LWPOLYLINE"),"Reopened DXF was not preserved");
    assert.deepEqual(errors,[],"JavaScript page errors");
    const report={kind:"actual-browser-canvas-cad-edit",passed:true,changedPixels:changed,downloadName:download.suggestedFilename(),downloadBytes:buf.length,hasPolyline:true,rectangleExtents:extents,vertices:vertices.length,reopenedDXFBytes:(await fs.stat(reopenedFile)).size,notDeployed:true,notes:"Real Chromium RECTANG and exact 100x60 DXF geometry; browser File > Open + Ctrl+S re-export."};
    await fs.writeFile(path.join(out,"browser-edit.json"),JSON.stringify(report,null,2));
    console.log("LIZHI_BROWSER_EDIT_SAVE_DXF_PASS",JSON.stringify(report));
    await context.close();
  }catch(e){
    await fs.writeFile(path.join(out,"browser-edit-failed.txt"),String(e.stack||e)+"\n"+JSON.stringify(errors,null,2));
    throw e;
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

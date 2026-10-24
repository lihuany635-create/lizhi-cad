"use strict";
// Real, isolated Chromium smoke of the source-built LiZhi CAD WebAssembly bundle.
// Does not deploy a site or touch user drawings.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
const { PNG } = require("pngjs");

const origin = process.env.CAD_TEST_ORIGIN || "http://127.0.0.1:8771";
const evidence = path.resolve(process.env.CAD_BROWSER_EVIDENCE || "cad-browser-evidence");

function colorsIn(buffer) {
  const png = PNG.sync.read(buffer);
  const colors = new Set();
  const step = Math.max(1, Math.floor(Math.min(png.width,png.height)/90));
  for (let y=0; y<png.height; y+=step) {
    for (let x=0; x<png.width; x+=step) {
      const i=(y*png.width+x)*4;
      const r=png.data[i]>>3,g=png.data[i+1]>>3,b=png.data[i+2]>>3;
      colors.add((r<<10)|(g<<5)|b);
    }
  }
  return {count:colors.size,width:png.width,height:png.height};
}
async function run(browser,{name,viewport,query,mobile=false}) {
  const context=await browser.newContext({viewport,deviceScaleFactor:1,hasTouch:mobile,isMobile:mobile,acceptDownloads:true});
  const page=await context.newPage();
  const errors=[],failedRequests=[],consoleErrors=[];
  page.on("pageerror",e=>errors.push(e.message));
  page.on("requestfailed",req=>failedRequests.push(req.url()+" "+req.failure()?.errorText));
  page.on("console",msg=>{if(msg.type()==="error")consoleErrors.push(msg.text().slice(0,500));});
  let loaded=false;
  try{
    const res=await page.goto(origin+"/"+query,{waitUntil:"domcontentloaded",timeout:60000});
    assert.equal(res.status(),200,"failed HTTP document load");
    await page.waitForFunction(()=>{
      const e=document.querySelector("#cadcraft_loading");
      return !e || /failed to start/i.test(e.textContent||"");
    },null,{timeout:110000});
    const loading=await page.locator("#cadcraft_loading").count();
    if(loading)throw Error("WASM app failed to initialize: "+await page.locator("#cadcraft_loading").innerText());
    await page.waitForTimeout(1700); // allow egui render after app startup
    const canvas=page.locator("#cadcraft_canvas");
    await canvas.waitFor({state:"visible"});
    const size=await canvas.boundingBox();
    assert.ok(size?.width>240&&size?.height>180,"Canvas has no real size");
    const screen=await page.screenshot({animations:"disabled"});
    await fs.writeFile(path.join(evidence,name+".png"),screen);
    const pixels=colorsIn(screen);
    assert.ok(pixels.count>12,"Rendered CAD screen unexpectedly blank: "+JSON.stringify(pixels));
    assert.equal(errors.length,0,"JavaScript runtime errors: "+errors.join(" | "));
    assert.equal(failedRequests.length,0,"Failed web assets: "+failedRequests.join(" | "));
    loaded=true;
    return {name,passed:true,url:origin+"/"+query,viewport,pixels,canvas:size,consoleErrors};
  } catch(e) {
    await fs.writeFile(path.join(evidence,name+"-error.txt"),String(e.stack||e)+"\n"+JSON.stringify({errors,failedRequests,consoleErrors},null,2));
    await page.screenshot({path:path.join(evidence,name+"-failure.png")}).catch(()=>{});
    return {name,passed:false,error:String(e),runtimeErrors:errors,failedRequests,consoleErrors};
  } finally { await context.close(); }
}
async function main(){
  await fs.mkdir(evidence,{recursive:true});
  const browser=await chromium.launch({headless:true,args:["--enable-webgl","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--disable-dev-shm-usage","--no-sandbox"]});
  const reports=[];
  try{
    reports.push(await run(browser,{name:"desktop-sample-cpu",viewport:{width:1366,height:820},query:"?cpu&sample"}));
    reports.push(await run(browser,{name:"desktop-empty-cpu",viewport:{width:1280,height:800},query:"?cpu"}));
    reports.push(await run(browser,{name:"mobile-sample-cpu",viewport:{width:390,height:844},query:"?cpu&sample",mobile:true}));
  }finally{await browser.close();}
  await fs.writeFile(path.join(evidence,"browser-smoke.json"),JSON.stringify({kind:"actual-playwright-chromium-runtime",not_a_deployed_site:true,not_actual_manual_drawing_test:true,reports},null,2));
  console.log("LIZHI_BROWSER_WASM_SMOKE",JSON.stringify(reports.map(r=>({name:r.name,passed:r.passed,pixels:r.pixels?.count,error:r.error}))));
  assert.ok(reports.every(r=>r.passed),"One or more real browser WASM runtime tests failed");
}
main().catch(e=>{console.error(e);process.exitCode=1;});

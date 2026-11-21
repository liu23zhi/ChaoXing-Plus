import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createTestDirectory } from './test-helpers/temp-directory.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const browserRequire=createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES || '.','package.json'));
const puppeteer=browserRequire('puppeteer');
async function until(fn, title) {
  for(let n=0;n<120;n++) { if(fn()) return; await sleep(75); }
  throw Error(title);
}
test('real packaged worker obeys admin policy, reuses scope across suspension and rotates on browser restart',{timeout:70000},async t=>{
  const starts=[], batches=[]; let enabled=true,denials=0;
  const server=createServer(async(req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
    if(req.headers.authorization!=='Bearer fixture-access'){res.writeHead(401).end();return;}
    if(req.url==='/api/extension-logs/policy?mode=extension'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({enabled}));return;}
    if(!enabled){denials++;res.writeHead(403,{'Content-Type':'application/json'}).end(JSON.stringify({enabled:false}));return;}
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    const data=JSON.parse(Buffer.concat(chunks).toString());
    if(req.url==='/api/extension-logs/start') starts.push(data);
    else if(req.url==='/api/extension-logs') batches.push(data);
    else {res.writeHead(404).end(); return;}
    res.writeHead(204).end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const profile=createTestDirectory('extension-diagnostic-profile');
  const launch=()=>puppeteer.launch({headless:true,userDataDir:profile,executablePath:process.env.CX_BROWSER_EXECUTABLE,enableExtensions:[resolve('dist')]});
  let browser=await launch();t.after(()=>browser.close());
  const isWorker=t=>t.type()==='service_worker' && t.url().endsWith('/extension-worker.js');
  const target=await browser.waitForTarget(isWorker), popup=new URL('popup.html',target.url()).href;
  const page=await browser.newPage();await page.goto(popup);
  assert.equal(await page.$('#diagnostics-enabled'),null);
  const base='http://127.0.0.1:'+server.address().port;
  await page.evaluate(b=>chrome.storage.local.set({'common.settings.tiku-adapter.baseurl':b,'common.settings.tiku-adapter.key':'fixture-access','common.settings.device-id':'fixture-profile-1'}),base);
  await until(()=>starts.length===1,'missing real launch signal');
  const mark=v=>page.evaluate(value=>chrome.storage.local.set({'common.settings.diagnostic-test-signal':value}),v);
  await mark('first');await until(()=>batches.length===1,'missing first event');
  const initial=starts[0];
  assert.equal(initial.device_id,'fixture-profile-1');assert.match(initial.launch_id,/^[a-f0-9-]{36}$/);
  assert.equal(batches[0].launch_id,initial.launch_id);
  assert.deepEqual(Object.keys(batches[0].entries[0]).sort(),['event','level','time']);
  assert.equal(batches[0].entries[0].event,'settings.saved');
  // A fresh worker within the SAME extension load keeps the storage.session launch identity.
  const worker=await target.worker();await worker.close();
  await page.reload();await mark('second');await until(()=>batches.length===2,'worker wake did not deliver');
  assert.equal(starts.length,1);assert.equal(batches[1].launch_id,initial.launch_id);
  enabled=false;await mark('third');await until(()=>denials>0,'server did not observe disable transition');
  await page.reload();await page.waitForFunction(()=>document.getElementById('diagnostics-state').textContent.includes('管理员已关闭'));
  assert.equal(batches.length,2);
  // Restart the actual browser with the same installed extension profile.
  enabled=true;await browser.close();browser=await launch();
  const reopened=await browser.newPage();await reopened.goto(popup);
  await until(()=>starts.length===2,'browser restart did not open its new launch');
  assert.notEqual(starts[1].launch_id,initial.launch_id);assert.equal(starts[1].device_id,initial.device_id);
});

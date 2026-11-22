// Run only with the independently compiled tests/owned-exam-log-tests.c binary (never a client executable).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';

const bin=process.argv[2];
if(!bin || basename(bin).toLowerCase()!=='owned-receipt.exe') throw Error('Supply the isolated owned-receipt.exe fixture.');
const run=promisify(execFile), calls=[];let enabled=false;
const server=createServer(async(req,res)=>{
  const buf=[];for await(const b of req) buf.push(b);
  const text=Buffer.concat(buf).toString(), body=text && JSON.parse(text);
  // Keep receipts free of raw authorization headers and never print account or device identifiers.
  calls.push({path:req.url, method:req.method, bound:req.headers.authorization==='Bearer sr_synthetic_receipt_1234567890'
    && req.headers['x-script-identity']==='synthetic-binding', body});
  if(req.url==='/api/extension-logs/policy?mode=native_exam'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({enabled}));}
  else if(!enabled){res.writeHead(403,{'Content-Type':'application/json'}).end('{"enabled":false}');}
  else res.writeHead(204).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
try {
  const port=String(server.address().port);
  await run(bin,[port,'ordinary']);assert.equal(calls.length,0);console.log('ordinary credential: 0 HTTP calls');
  await run(bin,[port,'disabled']);assert.deepEqual(calls.map(c=>c.path),['/api/extension-logs/policy?mode=native_exam']);console.log('admin-disabled: policy only, 0 starts and 0 entries');
  calls.length=0;enabled=true;
  await run(bin,[port,'accept']);
  assert.deepEqual(calls.map(c=>c.path),['/api/extension-logs/policy?mode=native_exam','/api/extension-logs/start','/api/extension-logs']);
  assert.ok(calls.every(c=>c.bound));const [start,batch]=calls.slice(1).map(c=>c.body);
  assert.deepEqual(Object.keys(start).sort(),['device_id','launch_id','mode','version']);assert.equal(start.mode,'native_exam');
  assert.deepEqual({...start,entries:batch.entries},batch);
  assert.deepEqual(batch.entries.map(({time,...safe})=>safe),[{event:'sync.success',level:'info'}]);assert.ok(Date.parse(batch.entries[0].time));
  console.log('authorized launcher: authenticated policy -> start -> 1 fixed launcher sync-success event; no client process was loaded');
} finally { server.closeAllConnections();await new Promise(r=>server.close(r)); }

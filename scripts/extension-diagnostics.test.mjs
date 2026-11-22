import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { BASE, KEY, DEVICE, BROWSER, LAUNCH, createDiagnostics, serviceURL } from '../src/extension-diagnostics.js';

function store(initial = {}) {
  const values = { ...initial };
  return { values, get:async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => Object.hasOwn(values,k)).map(k => [k,values[k]])),
    set:async fields => { Object.assign(values,fields); }, remove:async k => { delete values[k]; } };
}
const response = (status,body) => ({ status, json:async () => body });
const settings = { [BASE]:'https://service.invalid/team/', [KEY]:'test-token', [DEVICE]:'fixture-profile-1' };
function fixture({ local=store(settings), session=store(), handler, ...opts }={}) {
  const calls=[];
  const d=createDiagnostics({ storage:local,session,version:'6.3.0',batchDelay:5,retryDelay:10,timeout:150,
    send:async (url,req) => {
      const path=new URL(url).pathname.replace('/team/api/extension-logs','');
      const call={...req,url,path,body:req.body && JSON.parse(req.body)}; calls.push(call);
      return await handler?.(call,calls) || (path==='/policy'?response(200,{enabled:true}):response(204));
    }, ...opts });
  return { d, local, session, calls, paths:()=>calls.map(c=>c.path) };
}
test('service uses explicit HTTPS or local HTTP', () => {
  for(const raw of ['http://example.org','https://example.org/?parameter=value','https://example.org/#anchor','']) assert.equal(serviceURL(raw),'');
  assert.equal(serviceURL('http://[::1]:3060/path//'),'http://[::1]:3060/path');
  assert.equal(serviceURL('https://example.org/'),'https://example.org');
});
test('no own service address, key or existing device: no request and no replacement device',async()=>{
  for(const change of [{[BASE]:''},{[KEY]:''},{[DEVICE]:''}]) {
    const f=fixture({local:store({...settings,...change})}); await f.d.wake(); await f.d.record('extension.ready'); await wait(16);
    assert.deepEqual(f.calls,[]); assert.deepEqual(f.local.values,{...settings,...change});
  }
});
test('default enabled starts before ordinary events; only structured fields reach the service',async()=>{
  const f=fixture(); await f.d.record('not.a.diagnostic'); await f.d.record('sync.success',11);
  await f.d.record('sync.success',{text:'not an event field'}); await f.d.record('runtime.error','unused input'); await f.d.status();
  assert.deepEqual(f.paths(),['/policy','/start','']);
  const [policy,start,batch]=f.calls; assert.equal(policy.method,'GET'); assert.equal(new URL(policy.url).searchParams.get('mode'),'extension'); assert.equal(start.method,'POST');
  assert.match(start.body.launch_id,/^[a-f0-9-]{36}$/); assert.equal(start.body.device_id,settings[DEVICE]);
  assert.deepEqual(Object.keys(start.body).sort(),['device_id','launch_id','mode','version']); assert.deepEqual({...start.body,entries:batch.body.entries},batch.body);
  assert.deepEqual(batch.body.entries.map(({time,...e})=>e),[
    {event:'sync.success',level:'info',duration_ms:11,count:2},{event:'runtime.error',level:'error'}
  ]);
  for(const c of f.calls) {
    assert.equal(c.headers.Authorization,'Bearer test-token'); assert.equal(c.credentials,'omit'); assert.equal(c.redirect,'error'); assert.equal(c.referrerPolicy,'no-referrer');
  }
  assert.deepEqual(await f.d.status(),{service:'https://service.invalid/team',state:'enabled'});
});
test('worker wake reuses a session, browser restart starts a new file',async()=>{
  const session=store(),f=fixture({session}); await f.d.wake(); const id=f.calls[1].body.launch_id;
  const resumed=fixture({session}); await resumed.d.wake(); await resumed.d.record('network.offline'); await resumed.d.status();
  assert.deepEqual(resumed.paths(),['/policy','']); assert.equal(resumed.calls[1].body.launch_id,id);
  const restarted=fixture(); await restarted.d.wake(); assert.notEqual(restarted.calls[1].body.launch_id,id);
});
test('admin stop clears the buffer; re-enabling requires a successful handshake',async()=>{
  let enabled=false;
  const f=fixture({handler:c=>c.path==='/policy'?response(200,{enabled}):undefined});
  await f.d.record('sync.success'); assert.equal((await f.d.status()).state,'disabled');
  await f.d.record('sync.failed'); await wait(20); assert.deepEqual(f.paths(),['/policy']);
  enabled=true; await f.d.wake(); await f.d.record('runtime.error'); await f.d.status();
  assert.deepEqual(f.paths(),['/policy','/policy','/start','']); assert.equal(f.calls[3].body.entries.length,1);
  assert.equal(f.d.setEnabled,undefined);
});
test('server stop during an upload takes effect; an aged file triggers only one re-handshake',async()=>{
  const f=fixture({handler:(c,calls)=>c.path===''&&calls.filter(r=>r.path==='').length===1?response(409,{need_start:true}):c.path===''?response(403,{enabled:false}):undefined});
  await f.d.record('sync.failed'); await f.d.status(); await f.d.record('runtime.error'); await wait(20);
  assert.deepEqual(f.paths(),['/policy','/start','','/start','']);
  assert.equal(new Set(f.calls.filter(c=>c.body).map(c=>c.body.launch_id)).size,1);
  assert.equal((await f.d.status()).state,'disabled');
});
test('offline startup retries with the original launch ID and bounds failed sends',async()=>{
  let ok=false;
  const f=fixture({handler:c=>{
    if(c.path==='/start'&&!ok) throw Error('offline'); if(c.path==='') return response(503);
  }});
  await f.d.wake(); await wait(42); assert.deepEqual(f.paths(),['/policy','/start','/start']);
  const launch=f.session.values[LAUNCH]; ok=true; await f.d.wake(); await f.d.record('sync.failed'); await wait(52);
  assert.equal(f.calls.filter(c=>c.path==='').length,2);
  assert.equal(f.calls.filter(c=>c.body).every(c=>c.body.launch_id===launch),true);
});
test('a change of account and device purges old events before first send',async()=>{
  const f=fixture({batchDelay:15}); await f.d.wake(); await f.d.record('sync.failed');
  await f.local.set({[KEY]:'second-fixture',[DEVICE]:'fixture-profile-2'}); f.d.onStorageChanged({[KEY]:{oldValue:'a',newValue:'b'}},'local');
  await wait(32); await f.d.record('runtime.error'); await f.d.status();
  assert.deepEqual(f.paths(),['/policy','/start','/policy','/start','']);
  const b=f.calls.at(-1); assert.equal(b.headers.Authorization,'Bearer second-fixture');
  assert.equal(b.body.device_id,'fixture-profile-2'); assert.deepEqual(b.body.entries.map(e=>e.event),['runtime.error']);
});

test('managed browsers use each host-owned session ID, never the runtime page instance or a newly derived ID',async()=>{
  const hostDevice='one-host';
  const ids=Array.from({length:3},()=>crypto.randomUUID());
  const results=await Promise.all(ids.map(async id=>{
    const f=fixture({local:store({...settings,[DEVICE]:hostDevice,[BROWSER]:id})});
    await f.d.record('sync.success');await f.d.status();
    assert.deepEqual(f.paths(),['/policy','/start','']);assert.equal(new URL(f.calls[0].url).searchParams.get('mode'),'native_browser');
    const b=f.calls[2].body;assert.equal(b.mode,'native_browser');assert.equal(b.device_id,hostDevice);return b.browser_id;
  }));
  assert.deepEqual(results,ids);
});

test('owned exam host uses only a live bound short session: same identity on all calls, no ordinary-token fallback',async()=>{
  const {startHostExamDiagnostics}=await import('../windows/node-source/extension-diagnostics.mjs');
  const key='sr_'+ 'q'.repeat(36), identity='fixture-bound-identity';
  const params={...settings,[KEY]:key,'common.settings.tiku-adapter.script-session-token':key,'common.settings.tiku-adapter.script-identity':identity};
  const activation={identity,expiresAt:new Date(Date.now()+30000).toISOString()},calls=[];
  const options={version:'6.3.0',send:async(url,req)=>{calls.push({url,...req});return req.method==='GET'?response(200,{enabled:true}):response(204);}};
  assert.equal(await startHostExamDiagnostics(params,activation,options),true);assert.equal(calls.length,3);
  assert.equal(new URL(calls[0].url).searchParams.get('mode'),'native_exam');
  for(const call of calls){assert.equal(call.headers.Authorization,'Bearer '+key);assert.equal(call.headers['X-Script-Identity'],identity);
    if(call.body){const b=JSON.parse(call.body);assert.equal(b.mode,'native_exam');assert.equal(b.browser_id,undefined);assert.equal(b.device_id,settings[DEVICE]);}}
  const n=calls.length;
  assert.equal(await startHostExamDiagnostics({...params,[KEY]:'ordinary'},activation,options),false);
  assert.equal(await startHostExamDiagnostics({...params,[KEY]:'ordinary','common.settings.tiku-adapter.script-session-token':'ordinary'},activation,options),false);
  assert.equal(await startHostExamDiagnostics(params,{...activation,identity:'other'},options),false);
  assert.equal(await startHostExamDiagnostics(params,{...activation,expiresAt:'2000-01-01T00:00:00Z'},options),false);
  assert.equal(calls.length,n);
});

test('changing just the service origin never sends the old credential to that origin',async()=>{
  const f=fixture();await f.d.wake();
  await f.local.set({[BASE]:'https://new-service.invalid/team'});
  f.d.onStorageChanged({[BASE]:{oldValue:settings[BASE],newValue:f.local.values[BASE]}},'local');
  await f.d.record('sync.failed');assert.equal((await f.d.status()).state,'changed-service');
  assert.equal(f.calls.some(c=>c.url.includes('new-service.invalid')),false);
  await f.local.set({[KEY]:'new-service-fixture-key'});await f.d.wake();
  assert.equal(f.calls.at(-1).headers.Authorization,'Bearer new-service-fixture-key');
  assert.match(f.calls.at(-1).url,/new-service/);
});

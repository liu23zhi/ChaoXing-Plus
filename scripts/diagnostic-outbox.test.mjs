import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDiagnosticOutbox } from '../src/runtime/diagnostic-outbox.js';

const scope = {
  mode:'extension', version:'6.3.0', device_id:'synthetic-device',
  launch_id:'11111111-1111-4111-8111-111111111111'
};
const newEvent = (time = '2026-11-27T08:00:01.123Z') => ({
  time, level:'info', event:'sync.success', duration_ms:0
});
const receipt = (packet, status = 201) => ({
  status, receipt:{
    scope:Object.fromEntries(Object.entries(packet).filter(([k])=>!['entries','batch_id'].includes(k))),
    batch_id:packet.batch_id, accepted_event_ids:packet.entries.map(e=>e.event_id)
  }
});
const deferred = () => {
  let resolve;
  const promise = new Promise(fn => { resolve = fn; });
  return {promise,resolve};
};

// Actual disk, atomic rename and one shared writer in this test process.
// This adapter does not claim cross-process locking for simultaneous writes.
async function disk(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),'owned-diagnostic-outbox-test-'));
  t.after(() => fs.rm(folder,{recursive:true,force:true}));
  const file = path.join(folder,'queue.json');
  let tail = Promise.resolve(), failCommit = false;
  const read = async () => {
    try { return JSON.parse(await fs.readFile(file,'utf8')); }
    catch (error) { if (error.code==='ENOENT') return null; throw error; }
  };
  const transact = change => {
    const task = tail.then(async () => {
      const prior = await read();
      const {snapshot,value}=change(prior);
      if (snapshot!==prior) {
        if (failCommit) { failCommit=false; throw new Error('synthetic storage write failed'); }
        await fs.writeFile(file+'.next',JSON.stringify(snapshot),{mode:0o600});
        await fs.rename(file+'.next',file);
      }
      return value;
    });
    tail=task.catch(()=>{});
    return task;
  };
  return {transact,read,failNextWrite(){failCommit=true;}};
}

test('default disabled is inert before and after an event is present', async t=>{
  const storage=await disk(t);
  const q=createDiagnosticOutbox({storage,scope});
  let transportCalls=0;
  const transport=()=>{transportCalls++;};
  assert.deepEqual(await q.flush({transport}),{state:'disabled'});
  assert.equal(await storage.read(),null);
  assert.equal((await q.enqueue(newEvent())).state,'queued');
  const pending=await storage.read();
  assert.deepEqual(await q.flush({enabled:false,transport}),{state:'disabled'});
  assert.equal(transportCalls,0);
  assert.equal(await q.pendingCount(),1);
  assert.deepEqual(await storage.read(),pending);
});

test('disk reopen preserves original batch identity, event IDs, seq and backwards event time', async t=>{
  const storage=await disk(t);
  const [first,second]=['2026-11-27T08:00:01.900Z','2026-11-27T08:00:01.100Z'].map(newEvent);
  const q=createDiagnosticOutbox({storage,scope});
  const a=await q.enqueue(first), b=await q.enqueue(second);
  const packets=[];
  assert.deepEqual(await q.flush({enabled:true,transport:packet=>{
    packets.push(packet);
    throw Error('synthetic lost receipt');
  }}),{state:'retry'});
  const restarted=createDiagnosticOutbox({storage,scope,batchSize:1});
  assert.equal(await restarted.pendingCount(),2);
  assert.deepEqual(await restarted.flush({enabled:true,transport:packet=>{
    packets.push(packet);
    return receipt(packet);
  }}),{state:'accepted',accepted:2});
  assert.deepEqual(packets[0],packets[1]);
  assert.ok(Object.isFrozen(packets[0])&&Object.isFrozen(packets[0].entries)&&Object.isFrozen(packets[0].entries[0]));
  assert.deepEqual(packets[1].entries.map(e=>[e.time,e.event_seq,e.event_id,e.duration_ms]),
    [[first.time,1,a.event_id,0],[second.time,2,b.event_id,0]]);
  assert.equal(await restarted.pendingCount(),0);
  assert.deepEqual(await restarted.flush({enabled:true,transport:()=>assert.fail('no empty sends')}),{state:'empty'});
});

test('only exact batch/full ordered receipt removes events; malformed, partial or unrelated receipts retain original packet', async t=>{
  const storage=await disk(t), q=createDiagnosticOutbox({storage,scope});
  await q.enqueue(newEvent()); await q.enqueue(newEvent());
  const observed=[];
  const invalid=[
    () => ({status:201,accepted:2}),
    packet => ({...receipt(packet),status:204}),
    packet => ({...receipt(packet),receipt:{...receipt(packet).receipt,batch_id:scope.launch_id}}),
    packet => ({status:201,receipt:{batch_id:packet.batch_id,accepted_event_ids:packet.entries.map(e=>e.event_id)}}),
    packet => ({status:201,receipt:{...receipt(packet).receipt,scope:{...scope,mode:'native_exam'}}}),
    packet => ({status:201,receipt:{...receipt(packet).receipt,accepted_event_ids:[packet.entries[0].event_id]}}),
    packet => ({status:201,receipt:{...receipt(packet).receipt,accepted_event_ids:packet.entries.map(e=>e.event_id).reverse()}}),
    packet => ({status:201,receipt:{...receipt(packet).receipt,accepted_event_ids:[packet.entries[0].event_id,packet.entries[0].event_id]}})
  ];
  for(const step of invalid) {
    assert.equal((await q.flush({enabled:true,transport:p=>{observed.push(p); return step(p);}})).state,'unconfirmed');
    assert.equal(await q.pendingCount(),2);
  }
  assert.ok(observed.every(packet=>packet.batch_id===observed[0].batch_id));
  assert.ok(observed.every(packet=>JSON.stringify(packet)===JSON.stringify(observed[0])));
  assert.deepEqual(await q.flush({enabled:true,transport:p=>receipt(p,200)}),{state:'accepted',accepted:2});
});

test('policy/authorization failures and transient responses retain the same batch without implicit sends', async t=>{
  const storage=await disk(t), q=createDiagnosticOutbox({storage,scope});
  await q.enqueue(newEvent());
  const sent=[];
  for(const [code,state] of [[401,'unauthorized'],[403,'forbidden'],[429,'retry'],[503,'retry'],[400,'unconfirmed']]) {
    const got=await q.flush({enabled:true,transport:p=>{sent.push(p);return receipt(p,code);}});
    assert.deepEqual(got,{state});
    assert.equal(await q.pendingCount(),1);
  }
  assert.equal(sent.length,5);
  assert.ok(sent.every(p=>JSON.stringify(p)===JSON.stringify(sent[0])));
});

test('full capacity refuses new events, batches a stable prefix and does not reuse seq after draining', async t=>{
  const storage=await disk(t);
  const q=createDiagnosticOutbox({storage,scope,capacity:3,batchSize:2});
  const sizes=[];
  for(let i=1;i<=3;i++) assert.equal((await q.enqueue(newEvent())).event_seq,i);
  assert.deepEqual(await q.enqueue(newEvent()),{state:'full'});
  for(let i=0;i<2;i++) await q.flush({enabled:true,transport:p=>{sizes.push(p.entries.length);return receipt(p);}});
  assert.deepEqual(sizes,[2,1]);
  assert.equal((await q.enqueue(newEvent())).event_seq,4);
});

test('allowlists exclude raw/free fields and false or non-millisecond event times before storage', async t=>{
  const storage=await disk(t), q=createDiagnosticOutbox({storage,scope});
  const forged={...newEvent(),[Symbol('not-a-field')]:'synthetic'};
  for(const value of [
    {...newEvent(), message:'owned synthetic payload'}, {...newEvent(),event_seq:7},
    {...newEvent(),token:'owned synthetic marker'}, {...newEvent(),event:'unapproved.event'}, forged,
    {...newEvent(),time:'2026-02-31T08:00:01.123Z'}, {...newEvent(),time:'2026-11-27T08:00:01Z'},
    {...newEvent(),count:-1}, {...newEvent(),duration_ms:86_400_001}
  ]) await assert.rejects(q.enqueue(value),/invalid diagnostic event/);
  assert.equal(await storage.read(),null);
  for (const extra of [{url:'https://fixture.invalid'}, {key:'synthetic'}, {mode:'native_browser'}, {browser_id:'forbidden-in-extension'}])
    assert.throws(()=>createDiagnosticOutbox({storage,scope:{...scope,...extra}}),/invalid diagnostic outbox configuration/);
});

test('a fixed persisted slot cannot be rebound to a different launch, browser, device, version or mode', async t=>{
  const storage=await disk(t), q=createDiagnosticOutbox({storage,scope});
  await q.enqueue(newEvent());
  const original=await storage.read();
  for (const change of [
    {launch_id:'22222222-2222-4222-8222-222222222222'},
    {device_id:'different-synthetic-device'},{version:'7.1.0'},
    {mode:'native_exam'}, {mode:'native_browser',browser_id:'owned-browser'}
  ]) {
    const wrong=createDiagnosticOutbox({storage,scope:{...scope,...change}});
    await assert.rejects(wrong.flush({enabled:true,transport:()=>assert.fail('no wrong-scope delivery')}),/differently bound/);
    assert.deepEqual(await storage.read(),original);
  }
  assert.equal(await q.pendingCount(),1);
});

test('all three modes preserve separate envelopes even when test IDs/launch and event times overlap',async t=>{
  const first='aaaa1111-1111-4111-8111-111111111111', next='aaaa2222-2222-4222-8222-222222222222';
  for(const mode of ['extension','native_browser','native_exam']) {
    const storage=await disk(t);
    const fixed={...scope,mode,...(mode==='native_browser'?{browser_id:'owned-browser'}:{})};
    const ids=[first,next];
    const q=createDiagnosticOutbox({scope:fixed,storage,randomId:()=>ids.shift()});
    await q.enqueue(newEvent());
    let sent;
    const result=await q.flush({enabled:true,transport:packet=>{sent=packet;return receipt(packet);}});
    assert.deepEqual(result,{state:'accepted',accepted:1});
    assert.deepEqual(Object.fromEntries(Object.entries(sent).filter(([k])=>!['entries','batch_id'].includes(k))),fixed);
    assert.deepEqual(Object.keys(sent.entries[0]).sort(),['duration_ms','event','event_id','event_seq','level','time']);
    assert.equal(sent.entries[0].event_id,first);
    assert.equal(sent.entries[0].event_seq,1);
  }
});

test('a late matching response cannot delete another opener’s newly reserved prefix',async t=>{
  const storage=await disk(t), a=createDiagnosticOutbox({storage,scope,batchSize:1}), b=createDiagnosticOutbox({storage,scope,batchSize:1});
  await a.enqueue(newEvent());
  const second=await a.enqueue(newEvent());
  const entered=deferred(), gate=deferred();
  const waiting=a.flush({enabled:true,transport:packet=>{entered.resolve(packet);return gate.promise;}});
  const older=await entered.promise;
  assert.deepEqual(await a.flush({enabled:true,transport:()=>assert.fail()}),{state:'busy'});
  let retried;
  assert.deepEqual(await b.flush({enabled:true,transport:packet=>{retried=packet;return receipt(packet);}}),
    {state:'accepted',accepted:1});
  assert.deepEqual(older,retried);
  let newer;
  await b.flush({enabled:true,transport:packet=>{newer=packet;return {status:503};}});
  assert.notEqual(older.batch_id,newer.batch_id);
  assert.equal(newer.entries[0].event_id,second.event_id);
  gate.resolve(receipt(older));
  assert.deepEqual(await waiting,{state:'stale-receipt'});
  assert.equal(await b.pendingCount(),1);
  let retriedNewer;
  assert.deepEqual(await b.flush({enabled:true,transport:packet=>{retriedNewer=packet;return receipt(packet);}}),
    {state:'accepted',accepted:1});
  assert.deepEqual(retriedNewer,newer);
  assert.equal(await b.pendingCount(),0);
});

test('failed durable commit after an acknowledgement does not silently lose the old event',async t=>{
  const storage=await disk(t), q=createDiagnosticOutbox({storage,scope});
  await q.enqueue(newEvent());
  let prior;
  await assert.rejects(q.flush({enabled:true,transport:p=>{
    prior=p;storage.failNextWrite();return receipt(p);
  }}),/synthetic storage write failed/);
  assert.equal(await q.pendingCount(),1);
  const reopened=createDiagnosticOutbox({storage,scope});
  let retried;
  assert.deepEqual(await reopened.flush({enabled:true,transport:p=>{retried=p;return receipt(p);}}),
    {state:'accepted',accepted:1});
  assert.deepEqual(retried,prior);
  assert.equal(await reopened.pendingCount(),0);
});

test('transport is not called if the prospective batch cannot be committed first',async t=>{
  const storage=await disk(t), q=createDiagnosticOutbox({storage,scope});
  await q.enqueue(newEvent());
  const previous=await storage.read();
  let sends=0;
  storage.failNextWrite();
  await assert.rejects(q.flush({enabled:true,transport:()=>{sends++;}}),/synthetic storage write failed/);
  assert.deepEqual(await storage.read(),previous);
  assert.equal(sends,0);
  assert.deepEqual(await q.flush({enabled:true,transport:packet=>{sends++;return receipt(packet);}}),
    {state:'accepted',accepted:1});
  assert.equal(sends,1);
});

test('an unexpectedly changed durable snapshot is not sent, reset or overwritten',async t=>{
  const storage=await disk(t), q=createDiagnosticOutbox({storage,scope});
  await q.enqueue(newEvent());
  await storage.transact(state=>({snapshot:{...state,unrecognized:'owned synthetic'},value:null}));
  const previous=await storage.read();
  let sends=0;
  await assert.rejects(q.flush({enabled:true,transport:()=>{sends++;}}),/outbox snapshot/);
  await assert.rejects(q.enqueue(newEvent()),/outbox snapshot/);
  assert.equal(sends,0);
  assert.deepEqual(await storage.read(),previous);
});

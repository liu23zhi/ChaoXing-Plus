import assert from 'node:assert/strict';
import test from 'node:test';

const get = () => import('../src/extension-diagnostic-receipt.js');

function memory(seed = {}) {
  let data = structuredClone(seed);
  return {
    async get(keys) {
      if (keys === null) return structuredClone(data);
      if (!Array.isArray(keys)) keys = [keys];
      return structuredClone(Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])));
    },
    async set(values) { data = {...data, ...structuredClone(values)}; },
    async remove(key) { delete data[key]; }
  };
}
function environment(mod) {
  let now = Date.parse('2026-11-28T07:00:00.000Z'), policy = false, allowed = true, binding = 'authorized-source-a';
  let reply = packet => ({
    status: 201,
    body: { scope: Object.fromEntries(Object.entries(packet).filter(([k]) => k !== 'batch_id' && k !== 'entries')),
      batch_id: packet.batch_id, accepted_event_ids: packet.entries.map(entry => entry.event_id) }
  });
  const store = memory({'agreement.view.v1': { phase: 'accepted' }}), requests = [];
  const authority = async () => !allowed ? { state: 'waiting-agreement' } : {
    binding, deviceId: 'owned-device',
    async send(packet, signal) {
      assert.ok(signal instanceof AbortSignal);
      requests.push(packet === null ? null : structuredClone(packet));
      return packet === null ? {status: 200, body: {enabled: policy, transport: 'receipt-v1'}} : reply(packet, signal);
    }
  };
  const start = (session = memory()) => mod.createReceiptDiagnostics({
    storage: store, session, version: '6.3.0', authority, now: () => now,
    schedule: () => Symbol('pending timer; explicit wake in fixture'), cancel: () => {}
  });
  const packets = () => requests.filter(Boolean);
  return { start, store, requests, packets, setPolicy(v) {policy=v;}, setReply(v) {reply=v;}, setBinding(v) {binding=v;},
    setAllowed(v) {allowed=v;}, advance(v) {now+=v;}, correct: reply };
}

test('default is authorized only after fresh policy; forged display or startup never stages a log', async () => {
  const mod = await get(), e = environment(mod), d = e.start();
  assert.equal((await d.wake()).state, 'policy-disabled');
  await d.record('extension.ready');
  assert.equal(e.packets().length, 0);
  assert.equal((await e.store.get(mod.OUTBOX_KEY))[mod.OUTBOX_KEY], undefined);
  e.setAllowed(false);
  e.setPolicy(true);
  assert.equal((await d.wake()).state, 'waiting-agreement');
  assert.equal(e.packets().length, 0);
  e.setAllowed(true);
  assert.equal((await d.wake()).state, 'enabled');
  await d.record('extension.ready');
  assert.equal((await d.wake()).state, 'received');
  const [p] = e.packets();
  assert.deepEqual(Object.keys(p).sort(), ['batch_id','device_id','entries','launch_id','mode','version']);
  assert.deepEqual(Object.keys(p.entries[0]).sort(), ['event','event_id','event_seq','level','time']);
  assert.equal(p.entries[0].time,'2026-11-28T07:00:00.000Z');
  assert.equal(p.mode,'extension');
  assert.ok(!JSON.stringify(await e.store.get(mod.OUTBOX_KEY)).includes('Bearer'));
});

test('unknown receipt retains the same original launch, ids and time across worker and Chrome restarts', async () => {
  const mod = await get(), e = environment(mod);
  e.setPolicy(true);
  const firstSession = memory(), d = e.start(firstSession);
  await d.record('network.timeout', 43);
  e.setReply(() => ({status: 200, body: {accepted: 1}}));
  assert.equal((await d.wake()).state, 'unconfirmed');
  const [initial] = e.packets();
  assert.equal(initial.entries[0].duration_ms,43);
  e.advance(1000);
  e.setReply(e.correct);
  assert.equal((await e.start(firstSession).wake()).state, 'received');
  assert.deepEqual(e.packets()[1], initial);

  const wakeAgain = e.start(firstSession);
  await wakeAgain.record('runtime.error');
  e.setReply(() => {throw new Error('fixture transport timeout');});
  assert.equal((await wakeAgain.wake()).state, 'pending');
  const oldest = e.packets().at(-1);
  e.advance(1000);
  e.setReply(e.correct);
  const nextBrowser = e.start();
  await nextBrowser.record('extension.ready');
  assert.equal((await nextBrowser.wake()).state, 'received');
  assert.deepEqual(e.packets().at(-1), oldest);
  assert.equal((await nextBrowser.wake()).state, 'received');
  assert.notEqual(e.packets().at(-1).launch_id, initial.launch_id);
});

test('disabled policy and user opt-out purge unconfirmed data; changed account never ships old events', async () => {
  const mod = await get(), e = environment(mod), d = e.start();
  e.setPolicy(true);
  await d.record('sync.failed');
  e.setPolicy(false);
  assert.equal((await d.wake()).state,'policy-disabled');
  assert.equal(e.packets().length,0);
  e.setPolicy(true);
  await d.record('extension.ready');
  await e.store.set({[mod.DIAGNOSTICS_OPT_OUT]:false});
  assert.equal((await d.wake()).state,'opted-out');
  const parked = JSON.stringify(await e.store.get(mod.OUTBOX_KEY));
  assert.ok(!parked.includes('extension.ready'));
  const profileStillOff = e.start();
  assert.equal((await profileStillOff.wake()).state,'opted-out');
  await e.store.set({[mod.DIAGNOSTICS_OPT_OUT]:true});
  await d.record('sync.failed');
  e.setBinding('another-authorized-source');
  assert.equal((await d.wake()).state,'enabled');
  assert.equal(e.packets().length,0);
});

test('no replay after 24 hours and no retention of arbitrary event fields', async () => {
  const mod = await get(), e = environment(mod), d = e.start();
  e.setPolicy(true);
  await d.record('arbitrary-free-text');
  await d.record('sync.failed', {secret:'not a field'});
  e.advance(24*60*60*1000);
  assert.equal((await d.wake()).state,'enabled');
  assert.equal(e.packets().length,0);
  assert.ok(!JSON.stringify(await e.store.get(mod.OUTBOX_KEY)).includes('sync.failed'));
  await d.record('sync.failed', {secret:'not a field'});
  await d.wake();
  const [p] = e.packets();
  assert.equal(p.entries[0].duration_ms, undefined);
  assert.deepEqual(Object.keys(p.entries[0]).sort(), ['event','event_id','event_seq','level','time']);
});

test('private authority requires the approved source and existing device credential; never enrolls or exports a proof field', async () => {
  const {createAgreementController, digest} = await import('../src/extension-agreement-core.js');
  const base = 'https://127.0.0.1:12345', key = 'owned-fixture-key', device = 'owned-browser-installation';
  const [scope,keyHash] = await Promise.all([digest(JSON.stringify([base,device])), digest(key)]);
  const proofField = 'agreement.device.' + scope, bound = 'agreement.key-base.' + keyHash;
  const secret = 'agd_' + 'f'.repeat(43), deviceId = '7075530c-7398-40eb-b5b1-9f1ce331f762';
  const storage = memory({'common.settings.tiku-adapter.baseurl':base,'common.settings.tiku-adapter.key':key,
    'common.settings.device-id':device,'agreement.view.v1':{phase:'accepted'}});
  const hits = [];
  const controller = createAgreementController({read: storage.get,write:storage.set,remove:storage.remove, defaultBase:base,
    request:async (url, opts) => {hits.push({url,opts}); return Response.json({enabled:true,transport:'receipt-v1'});}});
  assert.deepEqual(await controller.diagnosticAuthority(), {state:'waiting-agreement'});
  assert.equal(hits.length,0);
  await storage.set({[proofField]:{deviceId,deviceCredential:secret}, [bound]:base,
    'agreement.approved-provider.v1':{base, rawBase:base, key}});
  const authority = await controller.diagnosticAuthority();
  assert.deepEqual(Object.keys(authority).sort(),['binding','deviceId','send']);
  assert.doesNotMatch(JSON.stringify(authority), /owned-fixture-key|agd_/);
  const r = await authority.send(null,new AbortController().signal);
  assert.equal(r.status,200);
  assert.equal(hits[0].url,base+'/api/extension-logs/receipt-policy?mode=extension');
  assert.equal(hits[0].opts.headers.Authorization,'Bearer '+key);
  assert.equal(hits[0].opts.headers['X-Agreement-Device'],secret);
  assert.equal(hits[0].opts.redirect,'error');
  assert.equal(hits[0].opts.credentials,'omit');
  await storage.set({'common.settings.tiku-adapter.baseurl':'https://127.0.0.1:12346'});
  assert.equal((await authority.send(null,new AbortController().signal)).status,403);
  assert.equal(hits.length,1);
  await storage.set({'common.settings.tiku-adapter.baseurl':base, 'common.settings.device-instance':deviceId});
  assert.deepEqual(await controller.diagnosticAuthority(), {state:'host-unavailable'});
  assert.equal(hits.length,1);
});

test('a late receipt after local opt-out cannot clear data in a newer collection epoch', async () => {
  const mod = await get(), e = environment(mod), d = e.start();
  e.setPolicy(true);
  await d.record('network.offline');
  let signal;
  let finish;
  let sent;
  const observed = new Promise(resolve => {sent = resolve;});
  // A terminal signal that an adapter can ignore simulates an already
  // received server write; MV3 must still drop the old generation locally.
  const replies = new Promise(resolve => {finish=resolve;});
  e.setReply((packet, a) => {signal=a; sent(packet); return replies;});
  const pending = d.wake();
  const old = await observed;
  await e.store.set({[mod.DIAGNOSTICS_OPT_OUT]:false});
  d.changed({[mod.DIAGNOSTICS_OPT_OUT]:{oldValue:true,newValue:false}},'local');
  assert.equal(signal.aborted,true);
  finish(e.correct(old));
  await pending;
  assert.equal((await d.wake()).state,'opted-out');
  assert.equal((await e.store.get(mod.OUTBOX_KEY))[mod.OUTBOX_KEY],undefined);
  assert.equal(e.packets().length,1);
  await e.store.set({[mod.DIAGNOSTICS_OPT_OUT]:true});
  d.changed({[mod.DIAGNOSTICS_OPT_OUT]:{oldValue:false,newValue:true}},'local');
  e.setReply(e.correct);
  await d.record('sync.success');
  assert.equal((await d.wake()).state,'received');
  assert.notEqual(e.packets()[1].launch_id,old.launch_id);
  assert.deepEqual(e.packets()[1].entries.map(x=>x.event),['sync.success']);
});

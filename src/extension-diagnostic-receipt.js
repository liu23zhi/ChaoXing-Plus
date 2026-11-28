import {AGREEMENT_CONFIG_KEYS, AGREEMENT_VIEW_KEY, DIAGNOSTICS_OPT_OUT} from './extension-agreement-core.js';
import { createDiagnosticOutbox, DIAGNOSTIC_OUTBOX_PENDING_LIMIT } from './runtime/diagnostic-outbox.js';

export { DIAGNOSTICS_OPT_OUT };
export const OUTBOX_KEY = 'extension.diagnostics.outbox.v2';
const LAUNCH_KEY = 'extension.diagnostics.launch.receipt-v1';
const KIND = 'chaoxing-plus:extension-diagnostics';
const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LEVELS = new Map([
  ['extension.ready','info'], ['settings.saved','info'], ['sync.success','info'], ['sync.failed','warn'],
  ['network.timeout','warn'], ['network.offline','warn'], ['runtime.error','error']
]);

export function createReceiptDiagnostics({storage, session, version, authority, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout}) {
  let queue = Promise.resolve(), timer, epoch = 0, inFlight, state = 'checking', failures = 0, queuedRecords = 0, wakeFlight;
  const inspect = () => ({state});
  const ordered = work => {
    const generation = epoch;
    const result = queue.then(async () => {
      if (generation === epoch) await work(() => generation === epoch);
      return inspect();
    }).catch(() => { if (generation === epoch) state = 'unavailable'; return inspect(); });
    queue = result;
    return result;
  };
  const setting = async (area, key) => (await area.get(key))[key];
  const optedOut = async () => (await setting(storage, DIAGNOSTICS_OPT_OUT)) === false;
  const fresh = at => {
    const age = now() - at;
    return age >= 0 && age < DAY;
  };
  function clearEntries(stream) {
    stream.firstAt = 0;
    stream.snapshot = {...stream.snapshot, entries: [], batch: null};
  }
  function stopTimer() { if (timer !== undefined) cancel(timer); timer = undefined; }
  function later(retrying = false) {
    if (timer !== undefined) return;
    const wait = retrying ? Math.min(20_000, 1000 * 2 ** Math.min(++failures, 5)) : 750;
    timer = schedule(() => { timer = undefined; void wake(); }, wait);
  }
  async function discard() {
    if (await setting(storage, OUTBOX_KEY) !== undefined) {
      // A revoked collection epoch must never reuse sequence numbers with a
      // previous launch that the server may have committed before revocation.
      await session.remove(LAUNCH_KEY);
      await storage.remove(OUTBOX_KEY);
    }
  }
  async function deny(reason) { failures = 0; state = reason; await discard(); }
  async function authorityOrDeny(live) {
    if (await optedOut()) {
      if (live()) await deny('opted-out');
      return null;
    }
    const result = await authority();
    if (!live()) return null;
    if (!result?.binding) {
      await deny(result?.state === 'host-unavailable' || result?.state === 'unconfigured'
        ? result.state : 'waiting-agreement');
      return null;
    }
    return result;
  }
  async function request(a, packet, live, canDispatch = () => true) {
    if (!live() || await optedOut() || !live()) return {status: 403};
    if (!canDispatch()) return {status: 410};
    const ctrl = new AbortController();
    inFlight = ctrl;
    try {
      const result = await a.send(packet, ctrl.signal, canDispatch);
      return live() ? result : {status: 403};
    } finally { if (inFlight === ctrl) inFlight = undefined; }
  }
  async function policy(a, live) {
    let r;
    try { r = await request(a, null, live); } catch { r = null; }
    if (!live()) return false;
    if (r?.status === 401 || r?.status === 403) {
      await deny('waiting-agreement');
      return false;
    }
    const b = r?.body;
    if (r?.status === 200 && b?.transport === 'receipt-v1' && typeof b.enabled === 'boolean') {
      if (!b.enabled) { await deny('policy-disabled'); return false; }
      return true;
    }
    state = 'unavailable';
    return false; // Unknown policy never authorizes collection or upload.
  }
  async function load(a, live) {
    const [value, launch] = await Promise.all([setting(storage, OUTBOX_KEY), setting(session, LAUNCH_KEY)]);
    if (!live()) return null;
    if (value !== undefined && (value?.binding !== a.binding || value.schema !== 1
      || !Array.isArray(value.streams) || value.streams.length > DIAGNOSTIC_OUTBOX_PENDING_LIMIT
      || !value.streams.every(x => UUID.test(x?.snapshot?.scope?.launch_id ?? '')
        && Array.isArray(x.snapshot.entries) && Number.isSafeInteger(x.firstAt)))) {
      await discard();
      return {schema: 1, binding: a.binding, streams: []};
    }
    const result = value ?? {schema: 1, binding: a.binding, streams: []};
    let changed = false;
    result.streams = result.streams.filter(s => {
      const current = s.snapshot.scope.launch_id === launch;
      if (s.snapshot.entries.length && !fresh(s.firstAt)) {
        changed = true;
        clearEntries(s);
      }
      const keep = current || s.snapshot.entries.length > 0;
      if (!keep) changed = true;
      return keep;
    });
    if (changed && live()) await save(result);
    return live() ? result : null;
  }
  const count = data => data.streams.reduce((n, s) => n + s.snapshot.entries.length, 0);
  async function save(data) {
    if (data.streams.length) await storage.set({[OUTBOX_KEY]: data});
    else await storage.remove(OUTBOX_KEY);
  }
  function outbox(data, scope, live, firstAt = 0) {
    return createDiagnosticOutbox({scope, storage: {
      async transact(fn) {
        if (!live()) throw new Error('diagnostic scope changed');
        const i = data.streams.findIndex(s => s.snapshot.scope.launch_id === scope.launch_id);
        const saved = i < 0 ? undefined : data.streams[i].snapshot;
        const {snapshot, value} = fn(saved);
        if (!live()) throw new Error('diagnostic scope changed');
        if (snapshot !== saved) {
          if (i < 0) data.streams.push({firstAt, snapshot});
          else {
            if (!saved.entries.length && snapshot.entries.length) data.streams[i].firstAt = firstAt;
            data.streams[i].snapshot = snapshot;
          }
          await save(data);
        }
        return value;
      }
    }});
  }
  function record(event, duration) {
    const level = LEVELS.get(event), at = now();
    if (!level || queuedRecords >= DIAGNOSTIC_OUTBOX_PENDING_LIMIT) return Promise.resolve(inspect());
    queuedRecords++;
    return ordered(async live => {
      const a = await authorityOrDeny(live);
      // Reconfirm the live server policy before collecting any new event.
      // An unavailable check may delay an existing batch but cannot admit new data.
      if (!a || !await policy(a, live)) return;
      const data = await load(a, live);
      if (!data || count(data) >= DIAGNOSTIC_OUTBOX_PENDING_LIMIT || !live() || !fresh(at)) return;
      let launch_id = await setting(session, LAUNCH_KEY);
      if (!live()) return;
      if (!UUID.test(launch_id ?? '')) {
        launch_id = crypto.randomUUID();
        await session.set({[LAUNCH_KEY]: launch_id});
      }
      if (!live() || !fresh(at)) return;
      const scope = {mode: 'extension', version, device_id: a.deviceId, launch_id};
      const entry = {time: new Date(at).toISOString(), event, level};
      if (Number.isSafeInteger(duration) && duration >= 0 && duration <= 60000) entry.duration_ms = duration;
      await outbox(data, scope, live, at).enqueue(entry);
      if (!live()) return;
      state = 'pending';
      later();
    }).finally(() => { queuedRecords--; });
  }
  function wake() {
    if (wakeFlight?.epoch === epoch) return wakeFlight.work;
    const flight = {epoch};
    flight.work = ordered(async live => {
      stopTimer();
      const a = await authorityOrDeny(live);
      if (!a) return;
      const enabled = await policy(a, live);
      if (!live() || (!enabled && state !== 'unavailable')) return;
      const data = await load(a, live);
      if (!data) return;
      if (!enabled) {
        if (count(data)) later(true);
        return;
      }
      const next = data.streams.find(s => s.snapshot.entries.length);
      if (!next) { failures = 0; if (state !== 'received') state = 'enabled'; return; }
      const scope = next.snapshot.scope;
      if (scope.device_id !== a.deviceId || scope.mode !== 'extension') { await deny('waiting-agreement'); return; }
      let expired = false;
      const canDispatch = () => {
        expired ||= !fresh(next.firstAt);
        return live() && !expired;
      };
      const r = await outbox(data, scope, live).flush({enabled: true,
        transport: async packet => {
          const reply = await request(a, packet, live, canDispatch);
          return {status: reply?.status, receipt: reply?.body};
        }});
      if (!live()) return;
      if (expired) {
        // The durable staging write or last trusted credential read may have
        // crossed the deadline. Drop this parked batch, never post a partial one.
        clearEntries(next);
        await save(data);
        failures = 0;
        state = count(data) ? 'pending' : 'enabled';
        if (count(data)) later();
      } else if (r.state === 'accepted') {
        failures = 0; state = 'received';
        if (count(data)) later();
      } else if (r.state === 'unauthorized' || r.state === 'forbidden') await deny('waiting-agreement');
      else { state = r.state === 'unconfirmed' ? 'unconfirmed' : 'pending'; later(true); }
    }).finally(() => { if (wakeFlight === flight) wakeFlight = undefined; });
    wakeFlight = flight;
    return flight.work;
  }
  function changed(changes, area) {
    if (area !== 'local') return;
    if ([...AGREEMENT_CONFIG_KEYS, 'agreement.approved-provider.v1', 'agreement.last-device-replacement.v1', DIAGNOSTICS_OPT_OUT]
      .some(key => Object.hasOwn(changes, key))) {
      epoch++; failures = 0; inFlight?.abort(); stopTimer();
      void ordered(async live => { if (live()) await discard(); });
      void wake();
    } else if (Object.hasOwn(changes, AGREEMENT_VIEW_KEY)) {
      // UI values are only wake signals, never evidence that consent exists.
      void wake();
    }
  }
  return {record, wake, changed};
}

export function registerReceiptDiagnostics(api, authority) {
  const d = createReceiptDiagnostics({storage: api.storage.local, session: api.storage.session,
    version: api.runtime.getManifest().version, authority});
  api.storage.onChanged.addListener(d.changed);
  api.runtime.onStartup.addListener(() => void d.wake());
  api.runtime.onInstalled.addListener(() => void d.wake());
  api.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== api.runtime.id || msg?.kind !== KIND) return false;
    let work;
    if (msg.op === 'inspect' && sender.url === api.runtime.getURL('popup.html')) work = d.wake();
    else if (sender.frameId === 0 && Number.isInteger(sender.tab?.id)
      && /^https?:\/\/(?:[a-z0-9-]+\.)*chaoxing\.com(?::[0-9]+)?(?:\/|$)/i.test(sender.url ?? '')) {
      if (msg.op === 'record') work = d.record(msg.event, msg.duration_ms).then(() => null);
      else if (msg.op === 'online') work = d.wake().then(() => null);
    }
    if (!work) return false;
    void work.then(reply, () => reply(null));
    return true;
  });
  void d.wake();
}

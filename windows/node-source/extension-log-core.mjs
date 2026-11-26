// Diagnostics for extension profiles and explicitly authorized local hosts. Event messages never set destinations or credentials.
export const BASE = 'common.settings.tiku-adapter.baseurl';
export const KEY = 'common.settings.tiku-adapter.key';
export const DEVICE = 'common.settings.device-id'; // same persisted value used by X-Device-Id
export const BROWSER = 'common.settings.device-instance'; // authoritative ID assigned once to each native-owned browser
export const KIND = 'chaoxing-plus:extension-diagnostics';
export const LAUNCH = 'extension.diagnostics.launch.v1', ACK = 'extension.diagnostics.ack.v1';
const LEVELS = new Map(Object.entries({
  'extension.ready':'info', 'settings.saved':'info', 'sync.success':'info',
  'sync.failed':'warn', 'network.offline':'warn', 'runtime.error':'error'
}));
const ENDPOINT_BINDING = 'extension.diagnostics.service-binding.v1';
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2,'0')).join('');
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

export function serviceURL(raw) {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash) return '';
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (!(u.protocol === 'https:' || (local && u.protocol === 'http:'))) return '';
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return ''; }
}

export function createDiagnostics({ storage, session, version, nativeExam, send = fetch, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, batchDelay = 1000, retryDelay = 3500, timeout = 5000, policyTTL = 60000 }) {
  let epoch = 0, pending = [], timer, active, request, launchPromise, policy;
  let state = 'pending', service = '', wantRefresh = false, refreshRetried = false;
  const inspect = () => ({ service, state }); // never expose account, device, launch ID or key
  async function config() {
    const values = await storage.get([BASE, KEY, DEVICE, BROWSER, ENDPOINT_BINDING]);
    const text = v => typeof v === 'string' ? v.trim() : '';
    const url = serviceURL(values[BASE]), key = text(values[KEY]), device = text(values[DEVICE]);
    const valid = url && key && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(device) && !device.includes('..');
    if (!valid) return { url, reason: !url || !key ? 'unconfigured' : 'waiting-device' };
    const browser = text(values[BROWSER]);
    let mode = 'extension', identity = '';
    if (nativeExam) {
      // Only the host that completed this session exchange supplies the binding; a page-provided mode is not authority.
      const a = nativeExam();
      if (!a || a.key !== key || !/^sr_[a-zA-Z0-9_-]{16,256}$/.test(key) || !a.identity || /[\r\n]/.test(a.identity)
        || a.identity.length > 256 || !Number.isFinite(a.expires) || a.expires <= now()) return {url, reason:'no-script-session'};
      mode = 'native_exam'; identity = a.identity;
    } else {
      if (key.startsWith('sr_')) return {url,reason:'no-script-session'};
      if (browser && !UUID.test(browser)) return {url,reason:'waiting-device'};
      if (browser) mode = 'native_browser';
      // A shared-page setting can change the service address separately from the key.
      // Do not forward the previous service's credential to another origin on that change.
      const origin = new URL(url).origin, hash = await digest(key), previous = values[ENDPOINT_BINDING];
      if (previous?.hash === hash && previous.origin !== origin) return {url,reason:'changed-service'};
      if (previous?.hash !== hash || previous.origin !== origin) await storage.set({[ENDPOINT_BINDING]:{origin,hash}});

    }
    return { url, key, device, mode, browser, identity, scope:await digest(JSON.stringify([url,key,device,mode,browser,identity])) };
  }
  function launchID() {
    // Chrome clears storage.session on browser restart and extension reload/update/disable,
    // not on MV3 worker suspension. Never use the per-page X-Device-Instance for rotation.
    return launchPromise ??= (async () => {
      const old = (await session.get(LAUNCH))[LAUNCH];
      if (typeof old === 'string' && UUID.test(old)) return old;
      const id = crypto.randomUUID();
      await session.set({ [LAUNCH]:id }); return id;
    })().catch(error => { launchPromise = undefined; throw error; });
  }
  function later(delay) {
    if (timer === undefined && !active && (pending.length || wantRefresh)) {
      timer = schedule(() => { timer = undefined; void pump(); }, delay);
    }
  }
  function reset() {
    epoch++; pending = []; policy = undefined; state = 'pending'; service = '';
    wantRefresh = true; refreshRetried = false; cancel(timer); timer = undefined; request?.abort();
    later(0);
  }
  async function http(cfg, path, json) {
    const ctrl = request = new AbortController();
    const deadline = schedule(() => ctrl.abort(), timeout);
    try {
      const headers = { Authorization:'Bearer ' + cfg.key };
      if (cfg.mode === 'native_exam') headers['X-Script-Identity'] = cfg.identity;
      if (json) headers['Content-Type'] = 'application/json';
      const res = await send(cfg.url + '/api/extension-logs' + path, {
        method:json ? 'POST' : 'GET', headers, ...(json ? { body:JSON.stringify(json) } : {}),
        credentials:'omit', redirect:'error', referrerPolicy:'no-referrer', signal:ctrl.signal
      });
      const body = (!json || res.status === 403 || res.status === 409) ? await res.json().catch(() => null) : null;
      return { status:res.status, body };
    } finally { cancel(deadline); request = undefined; }
  }
  function pump(forcePolicy = false) {
    if (active) return active;
    const generation = epoch, batch = pending.splice(0,24);
    const live = () => generation === epoch;
    wantRefresh = false;
    let backoff = false;
    active = (async () => {
      const cfg = await config(); if (!live()) return;
      service = cfg.url;
      if (!cfg.scope || !session) { state = cfg.reason || 'unavailable'; pending = []; return; }
      const owned = batch.filter(e => e.scope === cfg.scope);
      // The standalone Node host keeps its existing eager handshake behavior.
      const hostStamp = nativeExam ? await launchID() : undefined; if (!live()) return;
      const disable = async () => {
        pending = []; state = 'disabled';
        policy = { scope:cfg.scope, expires:now()+policyTTL, enabled:false };
        await session.remove(ACK);
      };
      // Unknown/old backend is not implicit permission. Recheck on wake or when this cache expires.
      if (forcePolicy || !policy || policy.scope !== cfg.scope || now() >= policy.expires) {
        const r = await http(cfg,'/policy?mode=' + cfg.mode); if (!live()) return;
        if (r.status === 403 && r.body?.enabled === false) { await disable(); return; }
        if (r.status !== 200 || typeof r.body?.enabled !== 'boolean') throw Error('policy');
        if (!r.body.enabled) { await disable(); return; }
        policy = { scope:cfg.scope, expires:now()+policyTTL, enabled:true };
      }
      if (!policy.enabled) { state = 'disabled'; pending = []; return; }
      // Startup, popup inspection, worker wake and settings hydration are not target-page events.
      // Even older services that write during /start must not receive it for an idle profile.
      if (!nativeExam && !owned.length) { state = 'enabled'; return; }
      const stamp = hostStamp ?? await launchID(); if (!live()) return;
      const identity = { version, mode:cfg.mode, device_id:cfg.device, ...(cfg.mode === 'native_browser' ? {browser_id:cfg.browser} : {}), launch_id:stamp };
      const ack = cfg.scope + ':' + stamp;
      const previous = (await session.get(ACK))[ACK]; if (!live()) return;
      const start = async () => {
        const r = await http(cfg,'/start',identity); if (!live()) return false;
        if (r.status === 403 && r.body?.enabled === false) { await disable(); return false; }
        if (![200,201,204].includes(r.status)) throw Error('start');
        await session.set({ [ACK]:ack }); return live();
      };
      if (previous !== ack) {
        if (!await start()) return;
      }
      if (!live()) return;
      state = 'enabled';
      const entries = owned.map(({ scope, retried, ...fields }) => fields);
      if (!entries.length) return; // An eager host handshake is not a diagnostic event.
      const payload = { ...identity, entries };
      let r = await http(cfg,'',payload); if (!live()) return;
      if (r.status === 409 && r.body?.need_start === true) {
        await session.remove(ACK); if (!live() || !await start()) return;
        r = await http(cfg,'',payload); if (!live()) return; // exactly one re-handshake for this batch
      }
      if (r.status === 403 && r.body?.enabled === false) { await disable(); return; }
      if (r.status === 429 || r.status >= 500) throw Error('transient');
      if (![200,201,202,204].includes(r.status)) state = 'unavailable';
    })().catch(() => {
      if (!live()) return;
      state = 'unavailable';
      pending = [...batch.filter(e => !e.retried).map(e => ({...e,retried:true})), ...pending].slice(-64);
      // Retry a quiet/offline policy refresh once (an explicit Node host may also handshake here).
      if (!batch.length && !refreshRetried) { refreshRetried = true; wantRefresh = true; }
      backoff = true;
    }).finally(() => { active = undefined; later(backoff ? retryDelay : batchDelay); });
    return active;
  }
  async function record(event, duration) {
    const level = LEVELS.get(event); if (!level) return;
    const observedAt = nativeExam ? undefined : now();
    const generation = epoch, cfg = await config(); if (generation !== epoch || !cfg.scope) return;
    if (policy?.scope === cfg.scope && !policy.enabled) {
      if (now() >= policy.expires) void pump();
      return; // never buffer events observed while the server reported disabled
    }
    const prev = pending.at(-1);
    if (prev?.scope === cfg.scope && !prev.retried && prev.event === event) prev.count = Math.min(1000,(prev.count || 1)+1);
    else {
      const e = { time:new Date(observedAt ?? now()).toISOString(), event, level, scope:cfg.scope };
      if (Number.isSafeInteger(duration) && duration >= 0 && duration <= 60000) e.duration_ms = duration;
      if (pending.length === 64) pending.shift();
      pending.push(e);
    }
    later(batchDelay);
  }
  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if ([BASE,KEY,DEVICE,BROWSER].some(k => changes[k] && changes[k].oldValue !== changes[k].newValue)) reset();
    else if (nativeExam && Object.keys(changes).some(k => k.startsWith('common.settings.'))) void record('settings.saved').catch(() => {});
  }
  return { record, onStorageChanged, wake: () => pump(true), status:async () => { await pump(); if (state === 'pending') await pump(); return inspect(); } };
}

function isTargetPageSender(sender) {
  if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) return false;
  try {
    const { protocol, hostname } = new URL(sender.url);
    return (protocol === 'https:' || protocol === 'http:')
      && (hostname === 'chaoxing.com' || hostname.endsWith('.chaoxing.com'));
  } catch { return false; }
}

export function registerDiagnostics(api, send = fetch) {
  const diag = createDiagnostics({ storage:api.storage.local, session:api.storage.session, version:api.runtime.getManifest().version, send });
  api.storage.onChanged.addListener(diag.onStorageChanged);
  api.runtime.onStartup.addListener(diag.wake);
  api.runtime.onInstalled.addListener(diag.wake);
  api.runtime.onMessage.addListener((msg,sender,respond) => {
    if (sender.id !== api.runtime.id || msg?.kind !== KIND) return false;
    const popup = sender.url === api.runtime.getURL('popup.html');
    let work;
    if (popup && msg.op === 'inspect') work = diag.status();
    else if (msg.op === 'record' && isTargetPageSender(sender)) work = diag.record(msg.event,msg.duration_ms);
    else if (msg.op === 'online' && isTargetPageSender(sender)) work = diag.wake();
    else return false;
    Promise.resolve(work).then(result => respond(result ?? {ok:true}), () => respond({state:'unavailable'}));
    return true;
  });
  void diag.wake();
}

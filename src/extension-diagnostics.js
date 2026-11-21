// Extension-private consent is deliberately outside the page-shared common.settings.* prefix.
export const CONSENT = 'diagnostics.upload.consent.v1';
export const BASE = 'common.settings.tiku-adapter.baseurl';
export const KEY = 'common.settings.tiku-adapter.key';
export const MASTER = 'common.settings.extension-enabled';
export const KIND = 'chaoxing-plus:extension-diagnostics';
const LEVELS = new Map(Object.entries({
  'extension.ready': 'info', 'settings.saved': 'info', 'sync.success': 'info',
  'sync.failed': 'warn', 'network.offline': 'warn', 'runtime.error': 'error'
}));

export function serviceURL(raw) {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash) return '';
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (!(u.protocol === 'https:' || (local && u.protocol === 'http:'))) return '';
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return ''; }
}

async function fingerprint(service, key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(service + '\0' + key));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// Best effort and memory-only. Re-reading the settings after an invalidation prevents
// a queued event or retry from travelling with the next account's credential.
export function createDiagnostics({ storage, fallback = '', version, send = fetch, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, batchDelay = 1200, retryDelay = 3500, timeout = 5000 }) {
  let epoch = 0, pending = [], timer, active = false, request, cache;

  async function read() {
    const snapshot = await storage.get([BASE, KEY, CONSENT, MASTER]);
    const url = serviceURL(snapshot[BASE] || fallback);
    const key = typeof snapshot[KEY] === 'string' ? snapshot[KEY].trim() : '';
    const stamp = url && key ? await fingerprint(url, key) : '';
    return { url, key, stamp, master: snapshot[MASTER] !== false,
      enabled: Boolean(stamp && stamp === snapshot[CONSENT]) };
  }
  const state = () => (cache ??= read().catch(error => { cache = undefined; throw error; }));
  const view = s => ({ service: s.url, stamp: s.stamp, enabled: s.enabled, master: s.master });

  function invalidate() {
    epoch++; pending = []; cache = undefined;
    cancel(timer); timer = undefined;
    request?.abort();
  }
  function later(delay) {
    if (pending.length && timer === undefined && !active) {
      timer = schedule(() => { timer = undefined; void flush().catch(() => {}); }, delay);
    }
  }
  async function flush() {
    if (active || !pending.length) return;
    active = true;
    const generation = epoch;
    const entries = pending.splice(0, 24);
    let nextDelay = batchDelay;
    try {
      const s = await read();
      if (generation !== epoch || !s.enabled || !s.master || entries.some(e => e.scope !== s.stamp)) return;
      const ctrl = request = new AbortController();
      const deadline = schedule(() => ctrl.abort(), timeout);
      let transient = false;
      try {
        const response = await send(s.url + '/api/extension-logs', {
          method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.key },
          body: JSON.stringify({ version, entries: entries.map(({ retried, scope, ...publicEntry }) => publicEntry) }),
          signal: ctrl.signal
        });
        transient = response.status === 429 || response.status >= 500;
      } catch { transient = true; }
      finally { cancel(deadline); }
      // At most one retry, even if fresh events arrive continuously. No recursive failure logs.
      if (transient && generation === epoch) {
        const retry = entries.filter(e => !e.retried).map(e => ({ ...e, retried: true }));
        pending = [...retry, ...pending].slice(-64); nextDelay = retryDelay;
      }
    } finally { request = undefined; active = false; later(nextDelay); }
  }
  async function record(event, duration) {
    const level = LEVELS.get(event);
    if (!level) return;
    const generation = epoch, s = await state();
    if (epoch !== generation || !s.master || !s.enabled) return;
    const prev = pending.at(-1);
    if (prev && !prev.retried && prev.scope === s.stamp && prev.event === event) {
      prev.count = Math.min(1000, (prev.count || 1) + 1);
    } else {
      const entry = { time: new Date(now()).toISOString(), event, level, scope: s.stamp };
      if (Number.isSafeInteger(duration) && duration >= 0 && duration <= 60000) entry.duration_ms = duration;
      if (pending.length === 64) pending.shift();
      pending.push(entry);
    }
    later(batchDelay);
  }
  async function setEnabled(on, expectedStamp) {
    const s = await read();
    if (on && (!s.stamp || s.stamp !== expectedStamp || !s.master)) {
      return view(s); // Endpoint or account changed since the popup rendered.
    }
    invalidate();
    if (on) await storage.set({ [CONSENT]: s.stamp });
    else await storage.remove(CONSENT);
    cache = undefined;
    return view(await state());
  }
  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    const credentialsChanged = [BASE, KEY].some(k => changes[k] && changes[k].oldValue !== changes[k].newValue);
    if (credentialsChanged || changes[MASTER] || changes[CONSENT]) {
      invalidate();
      if (credentialsChanged) void storage.remove(CONSENT).catch(() => {});
    } else if (Object.keys(changes).some(k => k.startsWith('common.settings.'))) {
      void record('settings.saved').catch(() => {});
    }
  }
  return { record, inspect: async () => view(await state()), setEnabled, onStorageChanged };
}

export function registerDiagnostics(api, fallback, send = fetch) {
  const diag = createDiagnostics({ storage: api.storage.local, version: api.runtime.getManifest().version, fallback, send });
  api.storage.onChanged.addListener(diag.onStorageChanged);
  api.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== api.runtime.id || msg?.kind !== KIND) return false;
    const popup = sender.url === api.runtime.getURL('popup.html');
    let work;
    if (popup && msg.op === 'inspect') work = diag.inspect();
    else if (popup && msg.op === 'toggle' && typeof msg.on === 'boolean') work = diag.setEnabled(msg.on, msg.stamp);
    else if (msg.op === 'record' && Number.isInteger(sender.tab?.id)) {
      work = diag.record(msg.event, msg.duration_ms);
    } else return false;
    Promise.resolve(work).then(result => respond(result ?? { ok: true }), () => respond({ unavailable: true }));
    return true;
  });
}

export const AGREEMENT_KIND = 'chaoxing-plus:agreement';
export const AGREEMENT_VIEW_KEY = 'agreement.view.v1';
export const AGREEMENT_INSTALL_KEY = 'agreement.install.v1';
export const DIAGNOSTICS_OPT_OUT = 'extension.diagnostics.enabled.v2';
const BASE = 'common.settings.tiku-adapter.baseurl';
const KEY = 'common.settings.tiku-adapter.key';
const APPROVED_SOURCE = 'agreement.approved-provider.v1';
const LOCAL_DEVICE = 'common.settings.device-id';
const BOOTSTRAP_DEVICE = 'agreement.local-device.v1'; // Agreement-owned; never exported through the shared settings bridge.
const REPLACED_DEVICE = 'agreement.last-device-replacement.v1'; // Atomic with the ordinary device recovery write.
const HOST_MODE_KEYS = ['common.settings.device-instance', 'common.settings.tiku-adapter.script-identity'];
export const AGREEMENT_CONFIG_KEYS = [BASE, KEY, LOCAL_DEVICE, ...HOST_MODE_KEYS, 'common.settings.extension-enabled'];

const text = value => typeof value === 'string' ? value.trim() : '';
const bytes = value => new TextEncoder().encode(value);
const MAX_BODY = 256 * 1024;
const MAX_DOCUMENT_JSON = 2 * 1024 * 1024; // Escaped JSON can exceed the decoded body limit.
const versionOK = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,47}$/.test(value);
const hashOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuidOK = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const dateOK = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value))),
  b => b.toString(16).padStart(2, '0')).join('');

// Not a published agreement. Remove this explicit placeholder when T06 supplies its approved text.
const OFFLINE = Object.freeze({
  version: 'offline-unpublished',
  hash: '92d7f5b8a39706ef508e0f25a28924dec76b10b331b451b48dc76ebdfb5d1461',
  summary: '离线阅读说明（不是已发布协议）',
  body: '暂时无法获取服务端已发布的用户协议。请在网络恢复后重新获取、完整阅读并主动签署；此内置说明不代表任何已发布版本，也不能签署。',
  offlineOnly: true
});

export function normalizeAgreementBase(raw) {
  try {
    const url = new URL(text(raw));
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return '';
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return ''; }
}

export async function readAgreementJSON(response, max) {
  const len = Number(response.headers.get('Content-Length'));
  if (!response.body || (Number.isFinite(len) && len > max)) throw new Error('size');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let raw = '', size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(raw + decoder.decode());
      size += value.byteLength;
      if (size > max) throw new Error('size');
      raw += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function validDocument(doc) {
  return Boolean(doc && versionOK(doc.version) && hashOK(doc.hash)
    && typeof doc.summary === 'string' && doc.summary.trim() && bytes(doc.summary).length <= 8192
    && typeof doc.body === 'string' && doc.body.trim() && bytes(doc.body).length <= MAX_BODY
    && dateOK(doc.publishedAt));
}

export function createAgreementController({
  read, write, remove, request = fetch, defaultBase,
  now = Date.now, offline = () => globalThis.navigator?.onLine === false
}) {
  const readers = new Map();
  let queue = Promise.resolve();
  let lastView;
  let lastViewContext;
  let configRevision = 0;
  let loadedCache;
  let firstObservedDevice = '';
  let offlineDocument;
  const diagnosticInstance = crypto.randomUUID();
  let enrollmentWait = 0; // The server also rate-limits registration across all configured deployments.

  function changed(changes) {
    // The first business ID can be replaced before a queued read sees it.
    // Use the trusted storage event's old value so a T07 replacement cannot inherit the fresh alias.
    if (HOST_MODE_KEYS.some(key => text(changes?.[key]?.oldValue) || text(changes?.[key]?.newValue))
      || changes?.['common.settings.extension-enabled']?.newValue === false) {
      firstObservedDevice = '';
    } else if (!firstObservedDevice && changes?.[LOCAL_DEVICE]) {
      firstObservedDevice = text(changes[LOCAL_DEVICE].oldValue) || text(changes[LOCAL_DEVICE].newValue);
    }
    configRevision++;
    readers.clear();
    lastViewContext = undefined;
    lastView = undefined;
  }
  async function fallback() {
    offlineDocument ??= await digest(OFFLINE.body) === OFFLINE.hash ? OFFLINE : null;
    return offlineDocument;
  }
  async function publish(view) {
    if (!lastView || view.document !== lastView.document || view.phase !== lastView.phase || view.scope !== lastView.scope
      || view.pendingVersion !== lastView.pendingVersion || view.acceptedVersion !== lastView.acceptedVersion
      || view.installState !== lastView.installState || view.serviceBase !== lastView.serviceBase) {
      await write({ [AGREEMENT_VIEW_KEY]: view });
      lastView = view;
    }
    return view;
  }
  async function configuration() {
    const config = await read([...AGREEMENT_CONFIG_KEYS, BOOTSTRAP_DEVICE, REPLACED_DEVICE]);
    const rawBase = typeof config[BASE] === 'string' ? config[BASE] : '';
    const key = text(config[KEY]);
    const base = normalizeAgreementBase(text(rawBase) || defaultBase);
    const mode = HOST_MODE_KEYS.some(k => text(config[k])) ? 'host'
      : config['common.settings.extension-enabled'] === false ? 'disabled' : 'extension';
    const sharedDevice = text(config[LOCAL_DEVICE]);
    const stored = config[BOOTSTRAP_DEVICE];
    const profile = uuidOK(stored?.id) && (stored.firstDevice === null || stored.firstDevice === false
      || (text(stored.firstDevice) && text(stored.firstDevice) === stored.firstDevice)) ? stored : undefined;
    const replacement = config[REPLACED_DEVICE];
    // An atomic recovery can be visible before its onChanged event or after a worker restart.
    // Retire an unbound alias even for a malformed/stale marker; it cannot prove a first ID.
    const firstDevice = profile?.firstDevice ?? (replacement === undefined ? firstObservedDevice || sharedDevice : false);
    const unresolvedReplacement = profile?.firstDevice === null && replacement !== undefined
      && (!uuidOK(replacement) || replacement !== sharedDevice);
    // Before the first business ID, the private seed is the subject. After binding it
    // to that first ID, a real replacement uses its own scope; disappearance grants nothing.
    const scopeDevice = unresolvedReplacement ? '' : profile ? (sharedDevice === firstDevice ? profile.id : sharedDevice)
      : stored === undefined ? sharedDevice : '';
    return { base, rawBase, key, mode, sharedDevice, profile, firstDevice, scopeDevice,
      device: sharedDevice || scopeDevice, missingProfile: stored === undefined };
  }
  async function context() {
    const initial = await configuration();
    if (initial.mode !== 'extension') {
      firstObservedDevice = '';
      return initial;
    }
    if (!initial.base) return initial;
    if (initial.missingProfile && !initial.sharedDevice) {
      // A host may write the shared pair while this old snapshot is in flight.
      // Writing only the private seed cannot touch that pair; re-read before any operation.
      firstObservedDevice = '';
      await write({ [BOOTSTRAP_DEVICE]: { id: crypto.randomUUID(), firstDevice: null } });
      return context();
    }
    if (initial.profile?.firstDevice === null && (initial.firstDevice === false || initial.firstDevice)) {
      await write({ [BOOTSTRAP_DEVICE]: { id: initial.profile.id, firstDevice: initial.firstDevice } });
      return context();
    }
    if (!initial.scopeDevice) return initial;
    return { ...initial, keyHash: await digest(initial.key), scope: await digest(JSON.stringify([initial.base, initial.scopeDevice])),
      revision: configRevision };
  }
  async function ensureCurrent(cfg) {
    const actual = await configuration();
    if (cfg.revision !== configRevision || actual.mode !== 'extension'
      || actual.base !== cfg.base || actual.key !== cfg.key || actual.sharedDevice !== cfg.sharedDevice
      || actual.scopeDevice !== cfg.scopeDevice) throw new Error('configuration');
  }
  async function api(cfg, endpoint, { method = 'GET', headers = {}, body, max = 16384 } = {}) {
    const signal = AbortSignal.timeout(8500);
    const response = await request(cfg.base + '/api/agreements/' + endpoint, {
      method, headers, body, signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const retry = response.headers.get('Retry-After');
      const seconds = Number(retry);
      const wait = retry === null ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - now();
      const code = response.status === 404 ? 'not-published' : response.status === 409 ? 'version-changed'
        : response.status === 401 || response.status === 403 ? 'configuration' : 'unavailable';
      throw Object.assign(new Error(code), { status: response.status, wait: Math.min(Math.max(0, wait) || 0, 300000) });
    }
    return readAgreementJSON(response, max);
  }
  const names = cfg => ({
    credentialsKey: 'agreement.device.' + cfg.scope,
    cacheKey: 'agreement.cache.' + cfg.scope,
    stageKey: 'agreement.stage.' + cfg.scope,
    retryKey: 'agreement.retry.' + cfg.scope
  });
  async function bindKey(cfg) {
    if (!cfg.key) return;
    const name = 'agreement.key-base.' + cfg.keyHash;
    const stored = await read([name, APPROVED_SOURCE]);
    const bound = stored[name];
    const choice = stored[APPROVED_SOURCE];
    if (bound && bound !== cfg.base) throw new Error('configuration');
    const confirmed = choice?.rawBase === cfg.rawBase && choice?.key === cfg.key && choice?.base === cfg.base;
    if (cfg.base !== normalizeAgreementBase(defaultBase) && !confirmed) throw new Error('source-unconfirmed');
    if (!bound || !confirmed) {
      await ensureCurrent(cfg);
      const updates = { [name]: cfg.base, [APPROVED_SOURCE]: { base: cfg.base, rawBase: cfg.rawBase, key: cfg.key } };
      await write(updates);
    }
  }
  async function diagnose(cfg) {
    if (cfg.mode !== 'extension' || !cfg.scope) return { state: 'invalid-config' };
    if (!cfg.key) return { state: 'missing-key' };
    if (offline()) return { state: 'server-error' };
    try {
      await ensureCurrent(cfg);
      await bindKey(cfg);
      await ensureCurrent(cfg);
      const started = now();
      const response = await request(cfg.base + '/api/search/health', {
        method: 'GET', headers: {
          Authorization: 'Bearer ' + cfg.key, 'X-Device-Id': cfg.device, 'X-Device-Instance': diagnosticInstance
        }, signal: AbortSignal.timeout(3000), redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
      });
      await ensureCurrent(cfg);
      if (response.status === 401) return { state: 'invalid-key' };
      if (response.status === 429) return { state: 'rate-limited' };
      if (response.status !== 403 && !response.ok) return { state: 'server-error' };
      const value = await readAgreementJSON(response, 16384);
      await ensureCurrent(cfg);
      const count = n => Number.isSafeInteger(n) && n >= 0;
      if (response.status === 403) {
        if (value?.code !== 'DEVICE_LIMIT_EXCEEDED' || (value.reason !== 'limit-exceeded' && !(value.reason === undefined
          && count(value.limit) && value.limit > 0 && count(value.used) && value.used >= value.limit))) return { state: 'invalid-key' };
        return { state: 'device-limit-exceeded', deviceLimit: count(value.limit) ? value.limit : undefined,
          deviceUsed: count(value.used) ? value.used : undefined };
      }
      if (value?.success !== true || value.status !== 'succeeded' || !text(value.taskId) || !text(value.statusUrl)) {
        return { state: 'server-error' };
      }
      const access = value.deviceAccess;
      const counts = access?.allowed === true && access.reason === 'already-registered' && count(access.limit)
        && access.limit > 0 && count(access.used) && access.used > access.limit
        ? { deviceLimit: access.limit, deviceUsed: access.used } : {};
      return { state: 'ok', latencyMs: now() - started, ...counts };
    } catch (error) {
      return { state: error?.message === 'source-unconfirmed' ? 'source-unconfirmed' : 'server-error' };
    }
  }
  async function credentials(cfg) {
    const { credentialsKey } = names(cfg);
    let value = (await read([credentialsKey]))[credentialsKey];
    if (!value) {
      if (now() < enrollmentWait) throw new Error('unavailable');
      try { value = await api(cfg, 'devices', { method: 'POST' }); }
      catch (error) {
        enrollmentWait = now() + Math.max(error?.wait ?? 0, 5000);
        throw error;
      }
      if (!uuidOK(value?.deviceId) || !/^agd_[A-Za-z0-9_-]{43}$/.test(text(value?.deviceCredential))) {
        throw new Error('configuration');
      }
      await ensureCurrent(cfg);
      await write({ [credentialsKey]: { deviceId: value.deviceId, deviceCredential: value.deviceCredential } });
    }
    if (!uuidOK(value.deviceId) || !/^agd_[A-Za-z0-9_-]{43}$/.test(text(value.deviceCredential))) throw new Error('configuration');
    return { deviceId: value.deviceId, headers: {
      'X-Agreement-Device': value.deviceCredential,
      ...(cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {})
    } };
  }
  // Internal service-worker capability only. Unlike the agreement UI flow, a
  // diagnostic check never enrolls a device or trusts a persisted display phase.
  async function diagnosticAuthority() {
    const cfg = await configuration();
    if (cfg.mode !== 'extension') return { state: cfg.mode === 'host' ? 'host-unavailable' : 'unconfigured' };
    if (!cfg.base || !cfg.key || !/^[!-~]{1,1024}$/.test(cfg.key) || cfg.key.startsWith('sr_')) return { state: 'unconfigured' };
    if (!cfg.sharedDevice || !cfg.scopeDevice) return { state: 'waiting-agreement' };
    cfg.revision = configRevision;
    cfg.keyHash = await digest(cfg.key);
    cfg.scope = await digest(JSON.stringify([cfg.base, cfg.scopeDevice]));
    const { credentialsKey } = names(cfg);
    const bound = 'agreement.key-base.' + cfg.keyHash;
    const readScope = async () => {
      try { await ensureCurrent(cfg); } catch { return null; }
      const values = await read([credentialsKey, bound, APPROVED_SOURCE, DIAGNOSTICS_OPT_OUT]);
      const saved = values[credentialsKey], choice = values[APPROVED_SOURCE];
      if (values[DIAGNOSTICS_OPT_OUT] === false || values[bound] !== cfg.base
        || choice?.base !== cfg.base || choice?.rawBase !== cfg.rawBase || choice?.key !== cfg.key
        || !uuidOK(saved?.deviceId) || !/^agd_[A-Za-z0-9_-]{43}$/.test(text(saved?.deviceCredential))) return null;
      return saved;
    };
    const saved = await readScope();
    if (!saved) return { state: 'waiting-agreement' };
    const binding = await digest(JSON.stringify([cfg.base, cfg.keyHash, cfg.scope, cfg.sharedDevice, saved.deviceId, saved.deviceCredential]));
    return {binding, deviceId: cfg.sharedDevice, async send(packet, signal) {
      const current = await readScope();
      if (signal.aborted || !current || current.deviceId !== saved.deviceId
        || current.deviceCredential !== saved.deviceCredential) return {status: 403};
      const response = await request(cfg.base + '/api/extension-logs/' + (packet === null ? 'receipt-policy?mode=extension' : 'batches'), {
        method: packet === null ? 'GET' : 'POST',
        headers: {Authorization: 'Bearer ' + cfg.key, 'X-Agreement-Device': saved.deviceCredential,
          ...(packet === null ? {} : {'Content-Type': 'application/json'})},
        ...(packet === null ? {} : {body: JSON.stringify(packet)}), credentials: 'omit', redirect: 'error',
        cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])
      });
      if (response.status === 200 || response.status === 201) {
        return {status: response.status, body: await readAgreementJSON(response, 16384).catch(() => null)};
      }
      void response.body?.cancel().catch(() => {});
      return {status: response.status};
    }};
  }
  async function cache(cfg) {
    if (loadedCache?.scope === cfg.scope) return loadedCache.data;
    const { cacheKey } = names(cfg);
    const data = (await read([cacheKey]))[cacheKey];
    const verified = validDocument(data?.document) && await digest(data.document.body) === data.document.hash
      && uuidOK(data.deviceId);
    const result = verified ? data : {};
    loadedCache = { scope: cfg.scope, data: result };
    return result;
  }
  async function replaceCache(cfg, data) {
    await ensureCurrent(cfg);
    await write({ [names(cfg).cacheKey]: data });
    loadedCache = { scope: cfg.scope, data };
  }
  async function display(cfg, data, phase, pendingVersion = null) {
    if (cfg?.scope) await ensureCurrent(cfg);
    const install = (await read([AGREEMENT_INSTALL_KEY]))[AGREEMENT_INSTALL_KEY] ?? 'incomplete';
    const view = await publish({
      phase, pendingVersion,
      installState: install,
      acceptedVersion: data?.acceptedVersion ?? null,
      document: data?.document ?? await fallback(),
      canSign: phase === 'pending' && pendingVersion !== null,
      // View state is never an authorization grant; callers require a live proof.
      scope: cfg?.scope ?? null,
      serviceBase: cfg?.rawBase?.trim() || cfg?.base || normalizeAgreementBase(defaultBase)
    });
    if (cfg?.scope) await ensureCurrent(cfg);
    lastViewContext = cfg;
    return view;
  }
  function resetObsoleteReaders(cfg, document) {
    for (const [id, reader] of readers) {
      if (reader.scope !== cfg.scope || reader.version !== document.version || reader.hash !== document.hash) readers.delete(id);
    }
  }
  async function refresh(cfg, online = false) {
    if (cfg.mode !== 'extension') return display(null, null, cfg.mode);
    if (!cfg.scope) return display(cfg, null, 'configuration');
    const previous = await cache(cfg);
    if (offline()) return display(cfg, previous, 'offline');
    const { retryKey } = names(cfg);
    const lastFailure = (await read([retryKey]))[retryKey];
    if (lastFailure && now() < lastFailure.until && (!online || lastFailure.limited)) {
      return display(cfg, previous, lastFailure.phase);
    }
    try {
      await ensureCurrent(cfg);
      await bindKey(cfg);
      const credential = await credentials(cfg);
      await ensureCurrent(cfg);
      const status = await api(cfg, 'status', { headers: credential.headers });
      if (!versionOK(status?.version) || !hashOK(status.content_hash) || status.deviceId !== credential.deviceId
        || typeof status.needsAcceptance !== 'boolean') throw new Error('contract');
      if (previous.document?.version === status.version && previous.document.hash !== status.content_hash) {
        throw new Error('contract'); // Published version identifiers are immutable.
      }
      let current = previous;
      if (current.deviceId !== credential.deviceId || current.document?.version !== status.version || current.document?.hash !== status.content_hash) {
        const value = await api(cfg, 'current?version=' + encodeURIComponent(status.version), { headers: credential.headers, max: MAX_DOCUMENT_JSON });
        const document = { version: value?.version, hash: value?.content_hash, summary: value?.summary,
          body: value?.body, publishedAt: value?.publishedAt };
        if (value?.type !== 'user_agreement' || document.version !== status.version || document.hash !== status.content_hash
          || value.needsAcceptance !== status.needsAcceptance || !validDocument(document)) throw new Error('contract');
        const { stageKey } = names(cfg);
        try {
          await ensureCurrent(cfg);
          await write({ [stageKey]: document });
          const staged = (await read([stageKey]))[stageKey];
          if (!validDocument(staged) || staged.version !== status.version || staged.hash !== status.content_hash
            || await digest(staged.body) !== staged.hash) throw new Error('contract');
          current = {
            document: staged, deviceId: credential.deviceId,
            acceptedVersion: status.needsAcceptance ? previous.acceptedVersion ?? null : status.version
          };
          await replaceCache(cfg, current);
        } finally {
          await remove([stageKey]).catch(() => {});
        }
      }
      const acceptedVersion = status.needsAcceptance ? (current.acceptedVersion === status.version ? null : current.acceptedVersion) : status.version;
      if (current.acceptedVersion !== acceptedVersion) {
        current = { ...current, acceptedVersion };
        await replaceCache(cfg, current);
      }
      await ensureCurrent(cfg);
      if (!status.needsAcceptance && (await read([AGREEMENT_INSTALL_KEY]))[AGREEMENT_INSTALL_KEY] !== 'complete') {
        await write({ [AGREEMENT_INSTALL_KEY]: 'complete' });
      }
      if (lastFailure) await remove([retryKey]).catch(() => {});
      resetObsoleteReaders(cfg, current.document);
      return display(cfg, current, status.needsAcceptance ? 'pending' : 'accepted', status.needsAcceptance ? status.version : null);
    } catch (error) {
      await ensureCurrent(cfg);
      const phase = ['not-published', 'version-changed', 'configuration', 'contract', 'source-unconfirmed'].includes(error?.message)
        ? error.message : 'unavailable';
      if (phase === 'source-unconfirmed') return display(cfg, previous, phase);
      const failures = (lastFailure?.failures ?? 0) + 1;
      await write({ [retryKey]: { failures, phase, limited: Boolean(error?.wait),
        until: now() + Math.max(error?.wait ?? 0, Math.min(300000, 5000 * 2 ** Math.min(failures - 1, 6))) } }).catch(() => {});
      return display(cfg, previous, phase);
    }
  }
  function matches(current, view) {
    return lastViewContext?.keyHash === current.keyHash && lastViewContext?.revision === current.revision
      && view?.scope === current.scope && view.canSign === true && view.document;
  }
  async function dispatch(operation, data, reader) {
    if (operation === 'abandon') { readers.delete(reader); return null; }
    if (operation === 'install') {
      readers.clear();
      await write({ [AGREEMENT_INSTALL_KEY]: 'incomplete', [AGREEMENT_VIEW_KEY]: null });
      lastView = undefined;
      lastViewContext = undefined;
      return null;
    }
    const cfg = await context();
    if (operation === 'diagnose') return diagnose(cfg);
    if (operation === 'clear-source-key' && cfg.mode !== 'host') {
      const latest = await configuration();
      if (latest.rawBase !== cfg.rawBase || latest.mode !== cfg.mode || latest.key !== cfg.key || latest.sharedDevice !== cfg.sharedDevice || latest.scopeDevice !== cfg.scopeDevice) return { cleared: false };
      await write({ [KEY]: '', [APPROVED_SOURCE]: null });
      changed();
      return { cleared: true }; // The worker storage listener refreshes without the removed key.
    }
    if (operation === 'configure-source' || operation === 'confirm-source') {
      if (cfg.mode !== 'extension') return display(null, null, 'configuration');
      const newBase = normalizeAgreementBase(data.base);
      if (!newBase || (operation === 'confirm-source' && newBase !== cfg.base)) return { ...lastView, sourceError: '需要有效的 HTTPS 题库地址。' };
      const newKey = text(data.key) || (newBase === cfg.base ? cfg.key : '');
      if (newKey && !/^[\x21-\x7e]{1,1024}$/.test(newKey)) return { ...lastView, sourceError: '访问令牌格式无效。' };
      const boundKey = newKey ? 'agreement.key-base.' + await digest(newKey) : '';
      const existing = boundKey ? (await read([boundKey]))[boundKey] : undefined;
      if (existing && existing !== newBase) return { ...lastView, sourceError: '该访问令牌已关联另一题库地址；请使用新地址签发的令牌。' };
      const original = await configuration();
      if (original.rawBase !== cfg.rawBase || original.key !== cfg.key || original.mode !== cfg.mode
        || original.sharedDevice !== cfg.sharedDevice || original.scopeDevice !== cfg.scopeDevice) {
        return { ...lastView, sourceError: '题库配置已变更，请核对后重试。' };
      }
      await write({ [BASE]: newBase, [KEY]: newKey, [APPROVED_SOURCE]: { base: newBase, rawBase: newBase, key: newKey },
        ...(boundKey ? { [boundKey]: newBase } : {}) });
      changed();
      const configured = await context();
      if (configured.scope) await remove([names(configured).retryKey]).catch(() => {});
      return refresh(configured);
    }
    if (operation === 'authorize') {
      if (!cfg.scope || !cfg.key || normalizeAgreementBase(data.base) !== cfg.base || data.keyHash !== cfg.keyHash) return { allowed: false };
      const view = await refresh(cfg);
      await ensureCurrent(cfg);
      return { allowed: view.phase === 'accepted' && !offline() };
    }
    if (operation === 'refresh') return refresh(cfg, data.online === true);
    const view = lastView && lastViewContext?.keyHash === cfg.keyHash && lastViewContext?.revision === cfg.revision
      && lastView.scope === cfg.scope ? lastView : await refresh(cfg);
    const doc = matches(cfg, view);
    if (!doc || doc.version !== data.version || doc.hash !== data.hash || offline()) {
      return operation === 'accept' ? { ...view, resetReading: true } : view;
    }
    const prior = readers.get(reader);
    if (operation === 'prepare') {
      await ensureCurrent(cfg);
      if (!prior || prior.scope !== cfg.scope || prior.version !== doc.version || prior.hash !== doc.hash) {
        if (readers.size >= 256) readers.delete(readers.keys().next().value);
        readers.set(reader, { scope: cfg.scope, version: doc.version, hash: doc.hash, reached: now() });
      }
      return view;
    }
    if (operation !== 'accept' || !prior || prior.scope !== cfg.scope || prior.version !== doc.version
      || prior.hash !== doc.hash || now() - prior.reached < 5000) {
      return operation === 'accept' ? { ...view, resetReading: true } : view;
    }
    try {
      await ensureCurrent(cfg);
      const credential = await credentials(cfg);
      await ensureCurrent(cfg);
      const result = await api(cfg, 'consents', { method: 'POST',
        headers: { ...credential.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: doc.version }) });
      if (result?.accepted !== true || result.version !== doc.version || result.deviceId !== credential.deviceId || !dateOK(result.acceptedAt)) {
        throw new Error('contract');
      }
      // A new release can be published immediately after POST. STATUS is the final
      // authority before propagating acceptance or allowing an operation.
      const confirmed = await refresh(cfg);
      if (confirmed.phase === 'accepted') readers.clear();
      return confirmed;
    } catch (error) {
      await ensureCurrent(cfg);
      const previous = await cache(cfg);
      if (error?.status === 409) return refresh(cfg);
      if (error?.status === 401 || error?.status === 403) return display(cfg, previous, 'configuration');
      // Keep the same idempotency key (device/version) and require another explicit click.
      return display(cfg, previous, 'submit-failed');
    }
  }
  return { diagnosticAuthority,
    changed,
    abandonTab(tab) {
      for (const id of readers.keys()) if (id.startsWith(tab + ':')) readers.delete(id);
    },
    run(operation, data = {}, reader = '') {
      const task = queue.then(() => dispatch(operation, data, reader)).catch(() =>
        operation === 'authorize' ? { allowed: false }
          : { phase: 'configuration', canSign: false, document: null, pendingVersion: null });
      queue = task;
      return task;
    }
  };
}

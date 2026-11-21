import { randomBytes } from 'node:crypto';
import { parseActivationDeadline } from './self-destruct-control.mjs';

const settingsPrefix = 'common.settings.tiku-adapter.';
const heartbeatIntervalMs = 60000;
const requestTimeoutMs = 10000;

function dependencies(options) {
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
    setTimeoutImpl: options.setTimeoutImpl ?? setTimeout,
    clearTimeoutImpl: options.clearTimeoutImpl ?? clearTimeout
  };
}

function httpUrl(address, base) {
  const value = new URL(address, base);
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.hash) {
    throw new Error('invalid lease URL');
  }
  return value;
}

async function requestJSON(address, init, env, controller = new AbortController()) {
  const timeout = env.setTimeoutImpl(() => controller.abort(), requestTimeoutMs);
  timeout?.unref?.();
  try {
    const response = await env.fetchImpl(address, { ...init, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('lease request rejected');
    }
    return JSON.parse(await response.text());
  } finally {
    env.clearTimeoutImpl(timeout);
  }
}

export async function activateScriptSessionFromSettings(settings, options = {}) {
  const activationToken = String(settings?.[settingsPrefix + 'script-activation-token'] || '').trim();
  const sessionURL = String(settings?.[settingsPrefix + 'script-session-url'] || '').trim();
  if (!activationToken && !sessionURL) return null;
  const env = dependencies(options);
  try {
    if (!activationToken || !sessionURL) throw new Error('incomplete activation');
    const activation = httpUrl(sessionURL);
    const baseurl = settings[settingsPrefix + 'baseurl'];
    if (baseurl && httpUrl(baseurl).origin !== activation.origin) throw new Error('activation origin mismatch');
    const identity = randomBytes(32).toString('hex');
    const body = await requestJSON(activation.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ activationToken, identity })
    }, env);
    if (!body || typeof body.token !== 'string' || !body.token.trim()
      || typeof body.heartbeatUrl !== 'string' || !body.heartbeatUrl.trim()
      || !(parseActivationDeadline(body.expiresAt) > env.now())) throw new Error('invalid activation response');
    const heartbeat = httpUrl(body.heartbeatUrl, activation);
    if (heartbeat.origin !== activation.origin) throw new Error('heartbeat origin mismatch');
    const token = body.token.trim();
    settings[settingsPrefix + 'key'] = token;
    settings[settingsPrefix + 'script-session-token'] = token;
    settings[settingsPrefix + 'script-identity'] = identity;
    settings[settingsPrefix + 'script-session-expires-at'] = String(body.expiresAt);
    delete settings[settingsPrefix + 'script-activation-token'];
    delete settings[settingsPrefix + 'script-session-url'];
    return Object.freeze({ token, identity, expiresAt: body.expiresAt, heartbeatUrl: heartbeat.href });
  } catch {
    // Upstream error text can contain credentials. Only this fixed message is
    // allowed to reach the host logger or startup error output.
    throw new Error('脚本运行会话激活失败，未继续启动。');
  }
}

export function startScriptSessionLease(activation, options = {}) {
  const env = dependencies(options);
  const deadline = parseActivationDeadline(activation.expiresAt);
  const onInvalid = options.onInvalid ?? (() => {});
  let closed = false;
  let heartbeatTimer;
  let deadlineTimer;
  let inFlight;
  const close = () => {
    if (closed) return;
    closed = true;
    env.clearTimeoutImpl(heartbeatTimer);
    env.clearTimeoutImpl(deadlineTimer);
    inFlight?.abort();
  };
  const invalidate = (reason) => {
    if (closed) return;
    close();
    try { Promise.resolve(onInvalid(reason)).catch(() => {}); } catch { /* cleanup stays closed */ }
  };
  const heartbeat = async () => {
    if (closed) return;
    if (env.now() >= deadline) { invalidate('expired'); return; }
    inFlight = new AbortController();
    try {
      const body = await requestJSON(activation.heartbeatUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + activation.token,
          'X-Script-Identity': activation.identity,
          'Cache-Control': 'no-store'
        }
      }, env, inFlight);
      if (!body || !(parseActivationDeadline(body.expiresAt) > env.now())) throw new Error('invalid heartbeat');
      // The activation deadline is immutable. A heartbeat can keep the lease
      // online, but cannot grant additional runtime.
      if (!closed) {
        heartbeatTimer = env.setTimeoutImpl(() => { void heartbeat(); }, heartbeatIntervalMs);
        heartbeatTimer?.unref?.();
      }
    } catch {
      if (!closed) invalidate('heartbeat-failed');
    } finally { inFlight = null; }
  };
  if (!Number.isFinite(deadline) || deadline <= env.now()) invalidate('expired');
  else {
    deadlineTimer = env.setTimeoutImpl(() => invalidate('expired'), deadline - env.now());
    deadlineTimer?.unref?.();
    heartbeatTimer = env.setTimeoutImpl(() => { void heartbeat(); }, heartbeatIntervalMs);
    heartbeatTimer?.unref?.();
  }
  return { close };
}

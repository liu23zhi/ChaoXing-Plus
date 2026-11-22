import { createDiagnostics, serviceURL, BASE, KEY, DEVICE } from './extension-log-core.mjs';

// This adapter consumes a session already activated by the owning host. It cannot exchange a token,
// start an exam, access a third-party process, refresh a lease, or register a device.
export async function startHostExamDiagnostics(settingsOrGet, activation, options = {}) {
  try {
    const settings = typeof settingsOrGet === 'function' ? settingsOrGet : () => settingsOrGet;
    const original = settings() || {}, key = original['common.settings.tiku-adapter.script-session-token'];
    const bound = original['common.settings.tiku-adapter.script-identity'];
    const service = serviceURL(original[BASE]), device = original[DEVICE];
    if (!service || !device || !key || key !== original[KEY] || !bound || bound !== activation?.identity) return false;
    const expires = Date.parse(activation.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now() || !options.version) return false;
    // Keep no additional persistent data: one instance of the owned host process is one launch.
    const values = {};
    const snapshot = async keys => {
      const current = settings() || {};
      if (serviceURL(current[BASE]) !== service || current[DEVICE] !== device || current[KEY] !== key
        || current['common.settings.tiku-adapter.script-session-token'] !== key
        || current['common.settings.tiku-adapter.script-identity'] !== bound) return {};
      return Object.fromEntries(keys.map(k=>[k,current[k]]));
    };
    const session = {get:async k=>({[k]:values[k]}),set:async v=>Object.assign(values,v),remove:async k=>{delete values[k];}};
    const engine = createDiagnostics({storage:{get:snapshot},session,version:options.version,nativeExam:()=>({key,identity:bound,expires}),
      ...(options.send ? {send:options.send} : {})});
    options.attach?.(event => {
      // Only notifications from the launcher's own settings file, never page diagnostics or raw error messages.
      if (event === 'settings.saved' || event === 'sync.failed') void engine.record(event).catch(()=>{});
    });
    await engine.record('extension.ready');
    return (await engine.status()).state === 'enabled';
  } catch { return false; } // A failed diagnostic must not interrupt the owning host.
}

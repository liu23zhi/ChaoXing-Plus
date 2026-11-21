const BASE='common.settings.tiku-adapter.baseurl', KEY='common.settings.tiku-adapter.key';
const ID='common.settings.tiku-adapter.script-identity', SESSION='common.settings.tiku-adapter.script-session-token';
export const EXAM_DENIED='考试模式仅限已激活、身份匹配且未过期的专属脚本会话。普通题库令牌不能启动。';
export function needsExamGrant(opts) {
  return !(opts.help || opts.version || opts.capabilities || opts.selfCheck || opts.listClients || opts.printEffectiveConfig);
}
export function hasActivationInput(settings) {
  try {
    const service=new URL(settings[BASE]), activation=new URL(settings['common.settings.tiku-adapter.script-session-url']);
    const eligible=service.protocol==='https:' || (service.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(service.hostname));
    return eligible && !service.username && !service.password && !activation.username && !activation.password
      && activation.origin===service.origin && typeof settings['common.settings.tiku-adapter.script-activation-token']==='string'
      && settings['common.settings.tiku-adapter.script-activation-token'].trim().length>0;
  } catch { return false; }
}
// Only capture an already-returned receipt from the launcher's successful exchange. Never read grants from disk/CLI.
export function captureExamGrant(settings, receipt, now=Date.now()) {
  if (!settings || !receipt || typeof receipt.key!=='string' || !/^sr_[A-Za-z0-9_-]{16,256}$/.test(receipt.key)
    || settings[KEY]!==receipt.key || settings[SESSION]!==receipt.key || !receipt.identity || receipt.identity!==settings[ID]) return null;
  const expires=Date.parse(receipt.expiresAt); if(!Number.isFinite(expires) || expires<=now)return null;
  return Object.freeze({service:settings[BASE],key:receipt.key,identity:receipt.identity,expires});
}
export function dispatchWithExamGrant(grant,settings,next,now=Date.now()) {
  if (!grant || !settings || grant.expires<=now || !grant.service || settings[BASE]!==grant.service
    || settings[KEY]!==grant.key || settings[SESSION]!==grant.key || settings[ID]!==grant.identity) throw Error(EXAM_DENIED);
  return next();
}

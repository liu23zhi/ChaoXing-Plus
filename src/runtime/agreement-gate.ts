/** The ordinary browser bundle runs only as an isolated MV3 content script. */
declare const __CXPLUS_BROWSER_AGREEMENT_GATE__: boolean;
declare const __CXPLUS_ORDINARY_NATIVE__: boolean;
export const AGREEMENT_REQUIRED_MESSAGE = '请先阅读并同意当前用户协议，再试一次。';

type ExtensionRuntime = {
  id?: string;
  sendMessage?: (message: Record<string, unknown>) => Promise<{ allowed?: boolean } | undefined>;
};
export function usesBrowserAgreementGate(): boolean {
  return typeof __CXPLUS_BROWSER_AGREEMENT_GATE__ !== 'undefined' && __CXPLUS_BROWSER_AGREEMENT_GATE__;
}
export function browserExtensionRuntime(): ExtensionRuntime | undefined {
  const runtime = (globalThis as { chrome?: { runtime?: ExtensionRuntime } }).chrome?.runtime;
  return usesBrowserAgreementGate() && runtime?.id && typeof runtime.sendMessage === 'function' ? runtime : undefined;
}

export async function hasTikuAgreement(base: string, key: string, mayDispatch?: () => boolean): Promise<boolean> {
  if (!usesBrowserAgreementGate()) return true;
  const runtime = browserExtensionRuntime();
  if (!runtime || !navigator.onLine) return false;
  const ordinaryNative = typeof __CXPLUS_ORDINARY_NATIVE__ !== 'undefined' && __CXPLUS_ORDINARY_NATIVE__;
  if (!ordinaryNative && (!base || !key)) return false;
  try {
    let ordinaryScope = {};
    if (!ordinaryNative) {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
      const keyHash = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
      ordinaryScope = { base, keyHash };
    }
    return await new Promise<boolean>(resolve => {
      const finish = (allowed: boolean) => {
        clearTimeout(timer);
        window.removeEventListener('pagehide', onLeave);
        resolve(allowed);
      };
      const onLeave = () => finish(false);
      const timer = setTimeout(onLeave, 20000);
      window.addEventListener('pagehide', onLeave, { once: true });
      void Promise.resolve()
        .then(() => {
          // Conflict recovery may end while the digest is in flight. Check at dispatch, not before hashing.
          if (mayDispatch && !mayDispatch()) return;
          return runtime.sendMessage?.({ kind: 'chaoxing-plus:agreement', operation: 'authorize', ...ordinaryScope });
        })
        .then(answer => finish(answer?.allowed === true && navigator.onLine), onLeave);
    });
  } catch {
    return false;
  }
}

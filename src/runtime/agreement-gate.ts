/** Browser-extension client gate; injected Node/Native bundles do not enable this build flag. */
declare const __CXPLUS_BROWSER_AGREEMENT_GATE__: boolean;
export const AGREEMENT_REQUIRED_MESSAGE = '请先阅读并同意当前用户协议，再试一次。';

export async function hasTikuAgreement(base: string, key: string): Promise<boolean> {
  if (typeof __CXPLUS_BROWSER_AGREEMENT_GATE__ === 'undefined' || !__CXPLUS_BROWSER_AGREEMENT_GATE__) return true;
  if (!navigator.onLine || !base || !key) return false;
  try {
    const random = crypto.getRandomValues(new Uint32Array(4)).join('-');
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    const keyHash = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
    return await new Promise<boolean>(resolve => {
      const onResult = (event: Event) => {
        const result = (event as CustomEvent<{ id?: string; allowed?: boolean }>).detail;
        if (result?.id === random) finish(result.allowed === true && navigator.onLine);
      };
      const onLeave = () => finish(false);
      const finish = (allowed: boolean) => {
        clearTimeout(timeout);
        document.removeEventListener('chaoxing-plus:agreement-result', onResult);
        window.removeEventListener('pagehide', onLeave);
        resolve(allowed);
      };
      const timeout = setTimeout(() => finish(false), 20000);
      document.addEventListener('chaoxing-plus:agreement-result', onResult);
      window.addEventListener('pagehide', onLeave, { once: true });
      document.dispatchEvent(new CustomEvent('chaoxing-plus:agreement-check', { detail: { id: random, base, keyHash } }));
    });
  } catch {
    return false;
  }
}

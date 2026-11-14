import { tikuAdapterDeviceHeaders } from './device-identity.js';

export const $gm = {
  unsafeWindow: window,
  getInfos(): undefined {
    return undefined;
  },
  getMetadataFromScriptHead(_key: string): string[] {
    return [];
  }
};

/**
 * GM 兼容层的 fetch 包装（141 §7 的第 5 处请求入口）。
 *
 * 设备标识只盖在**调用方没显式给**的头上（`...init?.headers` 在后）：
 * 这样调用方要覆盖 `X-Device-Id` 时仍然说了算，不会被这里静默改回去。
 */
export async function gmRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...tikuAdapterDeviceHeaders(),
      ...(init?.headers as Record<string, string> | undefined)
    }
  });
  return (await response.json()) as T;
}

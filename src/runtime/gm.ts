export const $gm = {
  unsafeWindow: window,
  getInfos(): undefined {
    return undefined;
  },
  getMetadataFromScriptHead(_key: string): string[] {
    return [];
  }
};

export async function gmRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  return (await response.json()) as T;
}

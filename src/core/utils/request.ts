export async function request<T extends 'json' | 'text'>(
  url: string,
  opts: {
    type?: 'fetch' | 'GM_xmlhttpRequest';
    method?: 'get' | 'post' | 'head';
    responseType?: T;
    headers?: Record<string, string>;
    data?: Record<string, any>;
  }
): Promise<T extends 'json' ? any : string> {
  const { responseType = 'json' as T, method = 'get', headers = {}, data = {} } = opts || {};
  const upperMethod = method.toUpperCase();
  const isBodyMethod = upperMethod === 'POST';
  const contentType = headers['Content-Type'] || headers['content-type'] || 'application/json';
  const body = isBodyMethod
    ? contentType === 'application/x-www-form-urlencoded'
      ? new URLSearchParams(data).toString()
      : JSON.stringify(data)
    : undefined;

  const response = await fetch(url, {
    method: upperMethod,
    headers: Object.keys(headers).length ? headers : undefined,
    body
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  if (responseType === 'text') {
    return (await response.text()) as T extends 'json' ? any : string;
  }

  return (await response.json()) as T extends 'json' ? any : string;
}

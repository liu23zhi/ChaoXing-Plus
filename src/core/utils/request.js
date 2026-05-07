export async function request(url, opts) {
    const { responseType = 'json', method = 'get', headers = {}, data = {} } = opts || {};
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
        return (await response.text());
    }
    return (await response.json());
}

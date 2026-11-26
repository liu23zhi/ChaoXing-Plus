// 141 §4.2 / §6.3：`DEVICE_ID_CONFLICT` 冲突后重新生成并**只重试一次**。
//
// 重试上限是这条链路上最危险的参数：
//   - 重试 0 次：一次镜像复制就让后到的那份永久不可用（要用户手动清 storage）
//   - 重试 N 次：每次冲突都换一个新 device_id，服务端逐个登记
//     ⇒ **该账号的设备槽位被一个个耗尽**，而用户看到的是「设备数量已达上限」
//
// 所以这里既断言「会重试」（否则功能没生效），也断言「只重试一次」
// （否则第二次冲突会被吞掉、或陷入换 ID 循环）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./scripts/ci/ts-source-hooks.mjs', new URL('../', import.meta.url));

const { request } = await import('../src/core/utils/request.js');
const { DEVICE_ID_HEADER, DEVICE_INSTANCE_HEADER, DEVICE_ID_CONFLICT_CODE, regenerateDeviceId } =
  await import('../src/runtime/device-identity.js');

const ADAPTER_URL = 'https://conflict.adapter.test/api/search';
const AUTH = { Authorization: 'Bearer tk-conflict-test' };

async function withFetch(handler, body) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

/** 造一个 409 + DEVICE_ID_CONFLICT 响应。 */
function conflictResponse() {
  return Response.json(
    { code: DEVICE_ID_CONFLICT_CODE, message: '设备标识冲突' },
    { status: 409 }
  );
}

test('★ 409 冲突 → 换 device_id 后重试一次并成功', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return conflictResponse();
    return Response.json({ answer: { answerText: 'A' } });
  }, async () => {
    const result = await request(ADAPTER_URL, { headers: AUTH, timeoutMs: 5000 });
    assert.deepEqual(result, { answer: { answerText: 'A' } });
  });

  assert.equal(calls.length, 2, '冲突后必须重试恰好一次');
  const firstId = calls[0].init.headers[DEVICE_ID_HEADER];
  const secondId = calls[1].init.headers[DEVICE_ID_HEADER];
  assert.notEqual(secondId, firstId, '重试必须带**新的** device_id，否则再撞同一个冲突');
  assert.equal(calls[1].init.headers[DEVICE_INSTANCE_HEADER], calls[0].init.headers[DEVICE_INSTANCE_HEADER],
    'instance 表示「这次运行」，换 device_id 不该动它');
});

test('★★ 第二次仍 409 → 只重试一次，然后把错误抛出来（不吞、不循环）', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return conflictResponse();
  }, async () => {
    await assert.rejects(
      request(ADAPTER_URL, { headers: AUTH, timeoutMs: 5000 }),
      (error) => {
        // 第二次冲突按普通错误抛出，不能返回「成功」也不能返回 undefined。
        assert.ok(error, '必须抛错');
        assert.equal(error.status, 409, '应保留 409 状态码');
        return true;
      }
    );
  });

  assert.equal(calls.length, 2, `必须恰好 2 次请求（初次 + 一次重试），实际 ${calls.length} 次 —— 多一次就会耗尽设备槽位`);
  assert.notEqual(
    calls[1].init.headers[DEVICE_ID_HEADER],
    calls[0].init.headers[DEVICE_ID_HEADER],
    '重试必须换 ID'
  );
});

test('★ 409 但错误码不是 DEVICE_ID_CONFLICT → 不换 ID、不重试', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ code: 'SOME_OTHER_CONFLICT', message: '同一题目正在被处理' }, { status: 409 });
  }, async () => {
    await assert.rejects(request(ADAPTER_URL, { headers: AUTH, timeoutMs: 5000 }));
  });

  assert.equal(calls.length, 1, '非设备冲突的 409 不该触发换 ID 重试');
});

test('★ 200 响应体里带 DEVICE_ID_CONFLICT → 不触发换 ID（只认 409）', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ code: DEVICE_ID_CONFLICT_CODE, answer: { answerText: 'A' } });
  }, async () => {
    const result = await request(ADAPTER_URL, { headers: AUTH, timeoutMs: 5000 });
    assert.deepEqual(result, { code: DEVICE_ID_CONFLICT_CODE, answer: { answerText: 'A' } });
  });

  assert.equal(calls.length, 1, '200 不是冲突响应，不该重试');
});

test('冲突重试对 POST 也生效（业务上不会重放的请求也必须换一次 ID）', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return conflictResponse();
    return Response.json({ answer: { answerText: 'A' } });
  }, async () => {
    await request(ADAPTER_URL, { method: 'post', headers: AUTH, data: { q: 'x' }, timeoutMs: 5000 });
  });

  assert.equal(calls.length, 2, 'POST 的 maxAttempts 恒为 1，但设备冲突重试必须独立于它');
  assert.notEqual(calls[1].init.headers[DEVICE_ID_HEADER], calls[0].init.headers[DEVICE_ID_HEADER]);
  // body 必须原样重发（这是同一次业务操作，只是身份换了）。
  assert.equal(calls[1].init.body, calls[0].init.body);
});

test('冲突重试不消耗既有重试预算：GET 的 maxAttempts 仍然是原来的语义', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return conflictResponse();
    if (calls.length === 2) throw new TypeError('Failed to fetch');
    return Response.json({ answer: { answerText: 'A' } });
  }, async () => {
    const result = await request(ADAPTER_URL, {
      headers: AUTH,
      retry: { maxAttempts: 3, delayMs: 0 },
      timeoutMs: 5000
    });
    assert.deepEqual(result, { answer: { answerText: 'A' } });
  });

  // 冲突重试（第 2 次）之后，网络错误仍应能走既有重试逻辑（第 3 次）。
  assert.equal(calls.length, 3, '冲突重试不该吃掉一次网络重试预算');
});

test('regenerateDeviceId 的落点一致：冲突后用过的 ID 不会在后续请求里复活', async () => {
  const ids = [];
  await withFetch(async (url, init) => {
    ids.push(init.headers[DEVICE_ID_HEADER]);
    if (ids.length === 1) return conflictResponse();
    if (ids.length === 2) return conflictResponse();
    return Response.json({ answer: { answerText: 'A' } });
  }, async () => {
    await assert.rejects(request(ADAPTER_URL, { headers: AUTH, timeoutMs: 5000 }));
  });

  // 初次 + 一次重试 = 2 个不同 ID；第三次请求不存在（不循环）。
  assert.equal(ids.length, 2, '只应有 2 次请求');
  assert.notEqual(ids[0], ids[1]);
  assert.equal(new Set(ids).size, 2, '两次请求必须用两个不同的 ID');
});

test('直接调 regenerateDeviceId 是幂等可用：连续调用得到不同 ID', () => {
  const a = regenerateDeviceId();
  const b = regenerateDeviceId();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.match(b, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(a, b);
});

test('host-owned browser retains the injected device and session after a conflict instead of rewriting either', async () => {
  const device = 'fixture-native-host';
  const instance = 'ac67a37a-668f-4918-bb9e-bd219ab2b107';
  const key = 'common.settings.device-id', instanceKey = 'common.settings.device-instance';
  const values = new Map([[key, JSON.stringify(device)], [instanceKey, JSON.stringify(instance)]]);
  const before = globalThis.localStorage;
  globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v) };
  const { __resetDeviceIdentityCacheForTests: reset } = await import('../src/runtime/device-identity.js');
  reset();
  const ids = [];
  try {
    await withFetch(async (_url, init) => {
      ids.push([init.headers[DEVICE_ID_HEADER], init.headers[DEVICE_INSTANCE_HEADER]]);
      return conflictResponse();
    }, async () => {
      await assert.rejects(request(ADAPTER_URL, { headers: AUTH }), error => error.status === 409);
    });
    assert.deepEqual(ids, [[device, instance]]);
    assert.equal(JSON.parse(values.get(key)), device);
    assert.equal(JSON.parse(values.get(instanceKey)), instance);
  } finally { globalThis.localStorage = before; reset(); }
});

test('script-authenticated conflict surfaces without changing the ordinary device ID or replaying the request', async () => {
  const calls = [];
  await withFetch(async (_url, init) => { calls.push(init); return conflictResponse(); }, async () => {
    await assert.rejects(request(ADAPTER_URL, {
      headers: { ...AUTH, 'x-script-identity': 'owned-fixture' }
    }), error => error.status === 409);
  });
  assert.equal(calls.length, 1);
});

test('parallel responses for the same retired device reuse a single replacement and follow the persisted profile value', async () => {
  const device = 'fixture-profile-before';
  const key = 'common.settings.device-id';
  const values = new Map([[key, JSON.stringify(device)]]);
  const writes = [], extensionWrites = [];
  const before = globalThis.localStorage, previousChrome = globalThis.chrome;
  globalThis.localStorage = { getItem: k => values.get(k) ?? null,
    setItem: (k, v) => { values.set(k,v); writes.push(JSON.parse(v)); } };
  globalThis.chrome = { storage: { local: { set: (items, cb) => { extensionWrites.push(items); cb(); } } } };
  const { getDeviceIdentity, __resetDeviceIdentityCacheForTests: reset } = await import('../src/runtime/device-identity.js');
  reset();
  const ids = [];
  try {
    await withFetch(async (_url, init) => {
      const id = init.headers[DEVICE_ID_HEADER]; ids.push(id);
      // Yield so both first requests used the same original ID; no network access.
      return id === device ? conflictResponse() : Response.json({ ok:true });
    }, () => Promise.all([request(ADAPTER_URL, { headers: AUTH }), request(ADAPTER_URL, { headers: AUTH })]));
    assert.equal(ids.length, 4);
    assert.deepEqual(ids.slice(0,2), [device,device]);
    assert.notEqual(ids[2],device);
    assert.deepEqual(ids.slice(2), [ids[2],ids[2]]);
    assert.equal(JSON.parse(values.get(key)), ids[2]);
    assert.deepEqual(writes, [ids[2]]);
    assert.deepEqual(extensionWrites, [{ [key]: ids[2] }]);
    // Simulate hydration from another extension tab; the old in-memory ID must not win.
    values.set(key, JSON.stringify('fixture-profile-synchronized'));
    assert.equal(getDeviceIdentity().deviceId, 'fixture-profile-synchronized');
  } finally { globalThis.localStorage = before; globalThis.chrome = previousChrome; reset(); }
});

test('when the shared device write does not take effect, a conflict surfaces without replaying the old ID', async () => {
  const key = 'common.settings.device-id', device = 'fixture-read-only-profile';
  const before = globalThis.localStorage;
  globalThis.localStorage = { getItem: k => k === key ? JSON.stringify(device) : null,
    setItem() { throw new Error('fixture storage is read only'); } };
  const { getDeviceIdentity, __resetDeviceIdentityCacheForTests: reset } = await import('../src/runtime/device-identity.js');
  reset();
  const ids = [];
  try {
    await withFetch(async (_url, init) => { ids.push(init.headers[DEVICE_ID_HEADER]); return conflictResponse(); }, async () => {
      await assert.rejects(request(ADAPTER_URL, { headers: AUTH }), error => error.status === 409);
    });
    assert.deepEqual(ids, [device]);
    assert.equal(getDeviceIdentity().deviceId, device);
  } finally { globalThis.localStorage = before; reset(); }
});

test('a caller-owned explicit device header is not replayed or reidentified by the ordinary profile', async () => {
  const calls = [];
  await withFetch(async (_url, init) => { calls.push(init); return conflictResponse(); }, async () => {
    await assert.rejects(request(ADAPTER_URL, {
      headers: { ...AUTH, [DEVICE_ID_HEADER]: 'fixture-external-owner-device' }
    }), error => error.status === 409);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers[DEVICE_ID_HEADER], 'fixture-external-owner-device');
});

async function isolatedProfile(testBody) {
  const key = 'common.settings.device-id', original = 'fixture-old-isolated-device';
  const names = ['window', 'navigator', 'localStorage', 'chrome', '__CXPLUS_BROWSER_AGREEMENT_GATE__', '__CXPLUS_PRIVATE_SETTINGS__'];
  const descriptors = names.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const listeners = new Set(), writes = [], authorizations = [];
  let shared = original, stored = original, allowed = true, firstWrite;
  const writing = new Promise(resolve => { firstWrite = resolve; });
  const runtime = { id: 'fixture-extension', sendMessage: async msg => {
    assert.equal(msg.operation, 'authorize');
    authorizations.push(allowed);
    return { allowed };
  }};
  const local = {
    set: (values, done) => { writes.push({ id: values[key], done }); firstWrite(); },
    get: (_keys, done) => { queueMicrotask(() => done({ [key]: stored })); }
  };
  const publish = (id, notify = true) => {
    shared = id;
    if (notify) for (const listener of listeners) listener({ [key]: { newValue: id } }, 'local');
  };
  const chrome = { runtime, storage: { local, onChanged: {
    addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener)
  }} };
  const privateSettings = {
    has: k => k === key, get: () => shared,
    set: (k, value) => { shared = value; local.set({ [k]: value }, () => { void runtime.lastError; }); }
  };
  for (const [name, value] of Object.entries({
    window: new EventTarget(), navigator: { onLine: true }, localStorage: { getItem: () => null },
    chrome, __CXPLUS_BROWSER_AGREEMENT_GATE__: true, __CXPLUS_PRIVATE_SETTINGS__: privateSettings,
  })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const { __resetDeviceIdentityCacheForTests: reset } = await import('../src/runtime/device-identity.js');
  reset();
  try {
    await testBody({
      original, writes, writing, authorizations, shared: () => shared, stored: () => stored,
      authorize: value => { allowed = value; }, publish, commit: id => { stored = id; },
      fail() {
        runtime.lastError = { message: 'fixture storage rejected the write' };
        try { for (const item of writes) item.done(); } finally { delete runtime.lastError; }
      },
    });
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    reset();
  }
}

test('isolated ordinary recovery requires a successful Chrome write AND an updated shared mirror', async () => {
  await isolatedProfile(async f => {
    const sent = [], operation = () => request(ADAPTER_URL, { headers: AUTH, timeoutMs: 3000 });
    await withFetch(async (_url, init) => {
      const id = init.headers[DEVICE_ID_HEADER]; sent.push(id);
      return id === f.original ? conflictResponse() : Response.json({ accepted:true });
    }, async () => {
      const inFlight = Promise.all([operation(), operation()]);
      await f.writing;
      assert.equal(f.shared(), f.original, 'dispatching the write is not confirmation');
      assert.equal(f.writes.length, 1);
      const { id, done } = f.writes[0];
      f.commit(id); done();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(sent, [f.original, f.original], 'Chrome receipt without synchronized mirror is not a retry');
      f.publish(id);
      const results = await inFlight;
      assert.deepEqual(results, [{ accepted:true }, { accepted:true }]);
      assert.deepEqual(sent, [f.original, f.original, id, id]);
      assert.equal(f.writes.length, 1);
      assert.equal(f.stored(), id);
      assert.equal(f.shared(), id);
    });
  });
});

test('isolated ordinary recovery on Chrome storage failure retains the previous ID and surfaces the original 409', async () => {
  await isolatedProfile(async f => {
    const sent = [];
    await withFetch(async (_url, init) => {
      sent.push(init.headers[DEVICE_ID_HEADER]); return conflictResponse();
    }, async () => {
      const rejected = assert.rejects(request(ADAPTER_URL, { headers: AUTH }), e => e.status === 409);
      await f.writing; f.fail();
      await rejected;
    });
    assert.deepEqual(sent, [f.original]);
    assert.equal(f.shared(), f.original);
    assert.equal(f.stored(), f.original);
  });
});

test('isolated ordinary recovery does not resend after trusted authorization is withdrawn', async () => {
  await isolatedProfile(async f => {
    const sent = [];
    await withFetch(async (_url, init) => {
      sent.push(init.headers[DEVICE_ID_HEADER]); return conflictResponse();
    }, async () => {
      const rejected = assert.rejects(request(ADAPTER_URL, { headers: AUTH }), e => e.status === 409);
      await f.writing;
      const { id, done } = f.writes[0];
      f.authorize(false);
      f.commit(id); f.publish(id); done();
      await rejected;
      assert.equal(f.stored(), id);
    });
    assert.deepEqual(sent, [f.original]);
    assert.deepEqual(f.authorizations, [false]);
  });
});

test('isolated ordinary recovery reuses a cross-tab replacement only if Chrome already persisted it', async () => {
  for (const durable of [false, true]) {
    await isolatedProfile(async f => {
      const sharedReplacement = 'fixture-cross-tab-updated-id', calls = [];
      await withFetch(async (_url, init) => {
        calls.push(init.headers[DEVICE_ID_HEADER]);
        if (calls.length > 1) return Response.json({ accepted:true });
        if (durable) f.commit(sharedReplacement);
        f.publish(sharedReplacement);
        return conflictResponse();
      }, async () => {
        const result = request(ADAPTER_URL, { headers: AUTH });
        if (durable) assert.deepEqual(await result, { accepted:true });
        else await assert.rejects(result, e => e.status === 409);
      });
      assert.deepEqual(calls, durable ? [f.original, sharedReplacement] : [f.original]);
      assert.deepEqual(f.writes, [], 'an observed replacement is verified, not regenerated');
    });
  }
});

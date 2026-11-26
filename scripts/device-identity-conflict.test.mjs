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

test('a confirmed 409 permits just one recovery replay even if it ends in a transport failure', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return conflictResponse();
    if (calls.length === 2) throw new TypeError('Failed to fetch');
    return Response.json({ answer: { answerText: 'A' } });
  }, async () => {
    await assert.rejects(request(ADAPTER_URL, {
      headers: AUTH,
      retry: { maxAttempts: 3, delayMs: 0 },
      timeoutMs: 5000
    }), /Failed to fetch/);
  });
  assert.equal(calls.length, 2, 'the remaining transport budget cannot send a third request after conflict recovery');
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
  const key = 'common.settings.device-id', marker = 'agreement.last-device-replacement.v1', original = 'fixture-old-isolated-device';
  const names = ['window', 'navigator', 'localStorage', 'chrome', '__CXPLUS_BROWSER_AGREEMENT_GATE__', '__CXPLUS_PRIVATE_SETTINGS__'];
  const descriptors = names.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const listeners = new Set(), writes = [], authorizations = [];
  let shared = original, stored = original, storedMarker, allowed = true, firstWrite, firstAuthorization, heldAuthorization;
  const writing = new Promise(resolve => { firstWrite = resolve; });
  const checking = new Promise(resolve => { firstAuthorization = resolve; });
  const runtime = { id: 'fixture-extension', sendMessage: async msg => {
    assert.equal(msg.operation, 'authorize');
    authorizations.push(allowed);
    firstAuthorization();
    return { allowed: heldAuthorization ? await heldAuthorization : allowed };
  }};
  const local = {
    set: (values, done) => { writes.push({ id: values[key], marker: values[marker], done }); firstWrite(); },
    get: (_keys, done) => { queueMicrotask(() => done({ [key]: stored, [marker]: storedMarker })); }
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
      original, writes, writing, checking, authorizations, shared: () => shared, stored: () => stored,
      authorize: value => { allowed = value; },
      holdAuthorization() {
        let release;
        heldAuthorization = new Promise(resolve => { release = resolve; });
        return release;
      },
      publish, commit: (id, durableMarker = id) => { stored = id; storedMarker = durableMarker; },
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
      const { id, marker, done } = f.writes[0];
      f.commit(id, marker ?? null); done();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(sent, [f.original, f.original], 'Chrome receipt without synchronized mirror is not a retry');
      f.publish(id);
      const results = await inFlight;
      assert.deepEqual(results, [{ accepted:true }, { accepted:true }]);
      assert.deepEqual(sent, [f.original, f.original, id, id]);
      assert.equal(f.writes.length, 1);
      assert.equal(f.stored(), id);
      assert.equal(f.shared(), id);
      assert.equal(marker, id, 'the new ID and private rotation marker are sent in the same write');
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
  for (const storage of ['missing-id', 'missing-marker', 'wrong-marker', 'confirmed']) {
    await isolatedProfile(async f => {
      const durable = storage === 'confirmed';
      const sharedReplacement = 'fixture-cross-tab-updated-id', calls = [];
      await withFetch(async (_url, init) => {
        calls.push(init.headers[DEVICE_ID_HEADER]);
        if (calls.length > 1) return Response.json({ accepted:true });
        if (storage !== 'missing-id') f.commit(sharedReplacement,
          durable ? sharedReplacement : storage === 'wrong-marker' ? 'other-id' : null);
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


const timedRecovery = { headers: AUTH, timeoutMs: 4500, retry: { maxAttempts: 3, delayMs: 0 } };

function recoveryClock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  return t.mock.timers;
}

function observeRequest(opts = timedRecovery) {
  const observed = {};
  observed.finished = request(ADAPTER_URL, opts).then(
    result => { observed.result = result; },
    error => { observed.error = error; }
  );
  return observed;
}

test('slow confirmed-conflict storage failure preserves 409 despite available transport attempts', async t => {
  const clock = recoveryClock(t);
  await isolatedProfile(async f => {
    const calls = [];
    await withFetch(async (_url, req) => {
      calls.push(req.headers[DEVICE_ID_HEADER]);
      return calls.length === 1 ? conflictResponse() : Response.json({ unexpected:true });
    }, async () => {
      const observed = observeRequest();
      await f.writing;
      clock.tick(1600); // past the 1500 ms transport slice, still inside the 4500 ms request
      f.fail();
      await observed.finished;
      assert.equal(observed.error?.status, 409);
      assert.deepEqual(calls, [f.original]);
      assert.equal(f.shared(), f.original);
    });
  });
});

test('slow confirmed-conflict storage success can still replay exactly once before the overall deadline', async t => {
  const clock = recoveryClock(t);
  await isolatedProfile(async f => {
    const calls = [], signals = [];
    await withFetch(async (_url, req) => {
      calls.push(req.headers[DEVICE_ID_HEADER]); signals.push(req.signal);
      return calls.length === 1 ? conflictResponse() : Response.json({ accepted:true });
    }, async () => {
      const observed = observeRequest();
      await f.writing;
      clock.tick(1600);
      const { id, done } = f.writes[0]; f.commit(id); f.publish(id); done();
      await observed.finished;
      assert.equal(signals[0].aborted, false, 'the completed fetch body is no longer under a transport timer');
      assert.deepEqual(observed.result, { accepted:true });
      assert.deepEqual(calls, [f.original, id]);
      assert.equal(f.writes.length, 1);
      assert.deepEqual(f.authorizations, [true]);
    });
  });
});

test('slow trusted refusal after a confirmed conflict preserves 409 and forbids replay', async t => {
  const clock = recoveryClock(t);
  await isolatedProfile(async f => {
    const calls = [], release = f.holdAuthorization();
    await withFetch(async (_url, req) => {
      calls.push(req.headers[DEVICE_ID_HEADER]);
      return calls.length === 1 ? conflictResponse() : Response.json({ unexpected:true });
    }, async () => {
      const observed = observeRequest();
      await f.writing;
      const { id, done } = f.writes[0]; f.commit(id); f.publish(id); done();
      await f.checking;
      clock.tick(1600);
      release(false);
      await observed.finished;
      assert.equal(observed.error?.status, 409);
      assert.deepEqual(calls, [f.original]);
    });
  });
});

test('overall deadline stops a confirmed conflict waiting for consent without losing its 409', async t => {
  const clock = recoveryClock(t);
  await isolatedProfile(async f => {
    const calls = [], release = f.holdAuthorization();
    await withFetch(async (_url, req) => {
      calls.push(req.headers[DEVICE_ID_HEADER]);
      return calls.length === 1 ? conflictResponse() : Response.json({ unexpected:true });
    }, async () => {
      const observed = observeRequest({ ...timedRecovery, timeoutMs:1200 });
      await f.writing;
      const { id, done } = f.writes[0]; f.commit(id); f.publish(id); done();
      await f.checking;
      clock.tick(1200);
      await new Promise(resolve => setImmediate(resolve));
      const settledAtDeadline = observed.error;
      release(true);
      await observed.finished;
      assert.equal(settledAtDeadline?.status, 409);
      assert.equal(observed.error?.status, 409);
      assert.deepEqual(calls, [f.original]);
    });
  });
});

test('external cancellation interrupts confirmed-conflict storage wait without any replay', async t => {
  recoveryClock(t);
  await isolatedProfile(async f => {
    const calls = [], caller = new AbortController(), reason = new DOMException('fixture canceled', 'AbortError');
    await withFetch(async (_url, req) => {
      calls.push(req.headers[DEVICE_ID_HEADER]); return conflictResponse();
    }, async () => {
      const observed = observeRequest({ ...timedRecovery, signal:caller.signal });
      await f.writing;
      caller.abort(reason);
      await new Promise(resolve => setImmediate(resolve));
      const settledAtAbort = observed.error;
      const { id, done } = f.writes[0]; f.commit(id); f.publish(id); done();
      await observed.finished;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settledAtAbort, reason);
      assert.equal(observed.error, reason);
      assert.deepEqual(calls, [f.original]);
      assert.deepEqual(f.authorizations, []);
    });
  });
});


test('late storage success after the overall deadline cannot start consent or replay', async t => {
  const clock = recoveryClock(t);
  await isolatedProfile(async f => {
    const calls = [];
    await withFetch(async (_url, req) => {
      calls.push(req.headers[DEVICE_ID_HEADER]); return conflictResponse();
    }, async () => {
      const observed = observeRequest({ ...timedRecovery, timeoutMs:1200 });
      await f.writing;
      clock.tick(1200);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(observed.error?.status, 409);
      const { id, done } = f.writes[0]; f.commit(id); f.publish(id); done();
      await observed.finished;
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(calls, [f.original]);
      assert.deepEqual(f.authorizations, []);
    });
  });
});

test('a device changed again during consent cannot replace the identity confirmed for the only replay', async () => {
  await isolatedProfile(async f => {
    const calls = [], release = f.holdAuthorization();
    await withFetch(async (_url, req) => {
      calls.push(req.headers[DEVICE_ID_HEADER]);
      return calls.length === 1 ? conflictResponse() : Response.json({ unexpected:true });
    }, async () => {
      const observed = observeRequest();
      await f.writing;
      const { id, done } = f.writes[0]; f.commit(id); f.publish(id); done();
      await f.checking;
      f.commit('fixture-newer-cross-tab-id'); f.publish('fixture-newer-cross-tab-id');
      release(true);
      await observed.finished;
      assert.equal(observed.error?.status, 409);
      assert.deepEqual(calls, [f.original]);
    });
  });
});

for (const end of ['caller abort', 'overall deadline']) {
  test(`recovery digest completing after ${end} never dispatches worker authorization`, async t => {
    const clock = recoveryClock(t), controller = new AbortController();
    const reason = new DOMException('fixture canceled during digest', 'AbortError');
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto'), realCrypto = globalThis.crypto;
    let startDigest, finishDigest;
    const digestStarted = new Promise(resolve => { startDigest = resolve; });
    const digestResult = new Promise(resolve => { finishDigest = resolve; });
    try {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
        getRandomValues: array => realCrypto.getRandomValues(array),
        subtle: { digest: () => { startDigest(); return digestResult; } }
      } });
      await isolatedProfile(async f => {
        const calls = [];
        await withFetch(async (_url, req) => {
          calls.push(req.headers[DEVICE_ID_HEADER]);
          return calls.length === 1 ? conflictResponse() : Response.json({ unexpected:true });
        }, async () => {
          const observed = observeRequest({ ...timedRecovery, timeoutMs:1200, signal:controller.signal });
          await f.writing;
          const { id, done } = f.writes[0]; f.commit(id); f.publish(id); done();
          await digestStarted;
          assert.deepEqual(f.authorizations, [], 'digest is pending and no worker message is in flight');
          if (end === 'caller abort') controller.abort(reason);
          else clock.tick(1200);
          await observed.finished;
          if (end === 'caller abort') assert.equal(observed.error, reason);
          else assert.equal(observed.error?.status, 409);

          finishDigest(new ArrayBuffer(32));
          await new Promise(resolve => setImmediate(resolve));
          assert.deepEqual(f.authorizations, [], 'a late digest must not dispatch authorize');
          assert.deepEqual(calls, [f.original], 'no further business fetch');
        });
      });
    } finally {
      if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
      else delete globalThis.crypto;
    }
  });
}

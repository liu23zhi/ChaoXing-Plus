// 141 §4.1 / §4.3 / §7：设备标识的两个字段、它们的生命周期差异，以及 5 处 header 出口。
//
// 这组用例守的是**本设计唯一的命门**：`deviceId` 持久化、`clientInstance` 不持久化。
// 两者一旦都持久化（这是最容易「顺手统一」的写法），镜像复制出来的两份设备在服务端
// 看来就是「同一实例重连」，冲突检测静默失效 —— 没有任何报错，只是槽位被悄悄抢走。
//
// 因此「镜像复制识别」那条用例必须让 **clientInstance 也落盘** 的变异变红（见任务书
// 的变异验证要求）；这条用例的存在理由就是它。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { register } from 'node:module';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';

const execFileAsync = promisify(execFile);

// 与构建口径一致：src 下的 `.js` 说明符解析到 `.ts` 源码（build.mjs 的 resolve.extensions）。
register('./scripts/ci/ts-source-hooks.mjs', new URL('../', import.meta.url));

const {
  DEVICE_ID_HEADER,
  DEVICE_INSTANCE_HEADER,
  DEVICE_ID_STORAGE_KEY,
  DEVICE_ID_CONFLICT_CODE,
  getDeviceIdentity,
  tikuAdapterDeviceHeaders,
  regenerateDeviceId,
  isDeviceIdConflict,
  __resetDeviceIdentityCacheForTests
} = await import('../src/runtime/device-identity.js');

const PROBE = resolveTestPath('scripts', 'test-helpers', 'device-identity-probe.mjs');

// ---------------------------------------------------------------------------
// 一次「扩展加载」＝ 一个独立进程。这是 clientInstance 生命周期的唯一可靠判据：
// 模块级常量在同一个进程里只会求值一次，靠重新 import 测不出来。
// ---------------------------------------------------------------------------

function createProbeStore() {
  return resolve(createTestDirectory('device-identity-probe'), 'store.json');
}

/** 跑一次「加载」，返回那一轮的身份与落盘内容。store 由调用方给，用于模拟镜像复制。 */
async function loadOnce(storePath, { regenerate = false } = {}) {
  const { stdout } = await execFileAsync(process.execPath, [PROBE], {
    cwd: resolveTestPath('.'),
    env: {
      ...process.env,
      CX_DEVICE_PROBE_STORE: storePath,
      ...(regenerate ? { CX_DEVICE_PROBE_REGENERATE: '1' } : {})
    },
    maxBuffer: 1024 * 1024
  });
  const line = stdout.trim().split(/\r?\n/u).pop();
  return JSON.parse(line);
}

// ---------------------------------------------------------------------------
// §7：两个 header 名与服务端约定一致
// ---------------------------------------------------------------------------

test('header 名与 141 §7 的字面量一致（服务端按这两个名字读，改名即全站失配）', () => {
  assert.equal(DEVICE_ID_HEADER, 'X-Device-Id');
  assert.equal(DEVICE_INSTANCE_HEADER, 'X-Device-Instance');
  assert.equal(DEVICE_ID_CONFLICT_CODE, 'DEVICE_ID_CONFLICT');
  // 存 chrome.storage 的 key 必须落在 `common.settings.` 前缀里，否则
  // extension-entry.js 的 shared-store 桥不会把它同步进 chrome.storage.local
  // （store.ts 的 SHARED_STORE_PREFIXES）。
  assert.equal(DEVICE_ID_STORAGE_KEY, 'common.settings.device-id');
  assert.ok(DEVICE_ID_STORAGE_KEY.startsWith('common.settings.'));
});

test('tikuAdapterDeviceHeaders 返回的就是这两个头，且值非空', () => {
  const headers = tikuAdapterDeviceHeaders();
  assert.deepEqual(Object.keys(headers).sort(), [DEVICE_ID_HEADER, DEVICE_INSTANCE_HEADER].sort());
  assert.match(headers[DEVICE_ID_HEADER], /^[0-9a-f-]{36}$/u);
  assert.match(headers[DEVICE_INSTANCE_HEADER], /^[0-9a-f-]{36}$/u);
  // 同一个运行里反复取必须是同一对值 —— 否则每个请求都换身份，服务端每次判冲突。
  assert.deepEqual(tikuAdapterDeviceHeaders(), headers);
  assert.deepEqual(getDeviceIdentity(), {
    deviceId: headers[DEVICE_ID_HEADER],
    clientInstance: headers[DEVICE_INSTANCE_HEADER]
  });
});

test('deviceId 与 clientInstance 是两个独立的随机值，不是同一个', () => {
  const { deviceId, clientInstance } = getDeviceIdentity();
  assert.notEqual(deviceId, clientInstance, '两个字段语义不同，撞成同一个值说明生成逻辑被合并了');
});

test('UUIDv4 结构（version=4、variant in 8/9/a/b）', () => {
  const { deviceId, clientInstance } = getDeviceIdentity();
  for (const id of [deviceId, clientInstance]) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, `${id} 不是 UUIDv4`);
  }
});

// ---------------------------------------------------------------------------
// ★ 本设计的命门：deviceId 持久化，clientInstance 每次加载新生成
// ---------------------------------------------------------------------------

test('★ deviceId 跨「加载」复用（同一 profile 不新增设备槽位）', async () => {
  const store = createProbeStore();
  const first = await loadOnce(store);
  const second = await loadOnce(store);

  assert.equal(second.deviceId, first.deviceId,
    'deviceId 必须持久化：同一浏览器 profile 重开要复用同一个 ID，否则每次开浏览器都多占一个设备');
});

test('★ clientInstance 每次「加载」都新生成（同 profile 两次运行不同实例）', async () => {
  const store = createProbeStore();
  const first = await loadOnce(store);
  const second = await loadOnce(store);

  assert.equal(second.deviceId, first.deviceId);
  assert.notEqual(second.clientInstance, first.clientInstance,
    'clientInstance 必须是「这次运行」的标识，跨加载必须不同');
});

test('★ 镜像复制识别：把 storage 整份复制过去，两份镜像的 instance 必须不同', async () => {
  // 141 §4.3 的场景：一套系统镜像被复制成多份，chrome.storage 的内容**一起被复制**。
  const sourceStore = createProbeStore();
  const mirrorStore = resolve(createTestDirectory('device-identity-mirror'), 'store.json');

  const original = await loadOnce(sourceStore);
  // 「做镜像」：把源 storage 逐字节复制过去（真实镜像就是这么发生的）。
  await writeFile(mirrorStore, await readFile(sourceStore, 'utf8'), 'utf8');

  const clone = await loadOnce(mirrorStore);

  // 前提：deviceId 被复制过去了一定相同 —— 这正是「同 device_id」那一半。
  assert.equal(clone.deviceId, original.deviceId,
    '前提：镜像复制会带走 deviceId（否则这条用例测的不是镜像场景）');

  // 核心断言：instance 不同 ⇒ 服务端才能判「同 device_id + 不同 instance = 冲突」。
  // 若 clientInstance 也被持久化，这里会相等，服务端会当成「同一实例重连」，冲突检测完全失效。
  assert.notEqual(clone.clientInstance, original.clientInstance,
    '镜像复制后 clientInstance 必须不同 —— 相同则服务端判成「同一实例重连」，冲突检测静默失效');
});

test('★ storage 里只落 deviceId，绝不落 clientInstance', async () => {
  const store = createProbeStore();
  const loaded = await loadOnce(store);
  const raw = await readFile(store, 'utf8');

  assert.deepEqual(loaded.storeKeys, [DEVICE_ID_STORAGE_KEY], `落盘 key 只应有 device-id，实际 ${loaded.storeKeys.join(', ')}`);
  assert.ok(raw.includes(loaded.deviceId), '落盘内容必须含 deviceId');
  assert.equal(raw.includes(loaded.clientInstance), false,
    '落盘内容不得含 clientInstance —— 一旦包含，镜像复制后两份实例相同，冲突检测失效');
});

test('storage 文件真的存在且能被下一轮读到（不是只在内存里转一圈）', async () => {
  const store = createProbeStore();
  const loaded = await loadOnce(store);

  assert.equal(existsSync(store), true, '必须真的写进存储（chrome.storage.local 的替身）');
  const parsed = JSON.parse(await readFile(store, 'utf8'));
  // runtimeStore 落的是 JSON.stringify 之后的值，所以再解析一层。
  assert.equal(JSON.parse(parsed[DEVICE_ID_STORAGE_KEY]), loaded.deviceId);
});

// ---------------------------------------------------------------------------
// regenerateDeviceId：冲突后换 ID
// ---------------------------------------------------------------------------

test('regenerateDeviceId 换掉 deviceId 但保留本次运行的 clientInstance', () => {
  __resetDeviceIdentityCacheForTests();
  const base = getDeviceIdentity();
  const next = regenerateDeviceId();

  assert.notEqual(next, base.deviceId, '必须真的换一个新 ID');
  assert.match(next, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(getDeviceIdentity().deviceId, next, '缓存必须更新到新 ID');
  assert.equal(getDeviceIdentity().clientInstance, base.clientInstance,
    'instance 表示「这次运行」，换 deviceId 不该动它');
});

test('★ regenerateDeviceId 真的写回 storage：下一次「加载」拿到新 ID，不复活旧值', async () => {
  const store = createProbeStore();
  const first = await loadOnce(store);
  // 第二轮：加载时撞冲突，换 ID 并落盘。
  const conflicted = await loadOnce(store, { regenerate: true });

  assert.equal(conflicted.deviceId, first.deviceId, '前提：这一轮加载开始时先读到了旧值');
  assert.notEqual(conflicted.regenerated, first.deviceId, 'regenerate 必须产出新 ID');
  assert.equal(conflicted.afterRegenerateDeviceId, conflicted.regenerated, '本轮的当前身份必须已经换成新 ID');
  assert.equal(conflicted.afterRegenerateClientInstance, conflicted.clientInstance,
    'regenerate 只换 deviceId，不动 clientInstance');

  // 核心：第三轮加载读到的必须是**新** ID。若 regenerate 只改内存不落盘，这里会退回旧值。
  const afterReload = await loadOnce(store);
  assert.equal(afterReload.deviceId, conflicted.regenerated,
    'regenerateDeviceId 必须持久化新 ID，否则重启后又要撞一次同一个冲突');
  assert.notEqual(afterReload.deviceId, first.deviceId, '不得复活被换掉的那个旧 ID');
});

// ---------------------------------------------------------------------------
// 冲突判定
// ---------------------------------------------------------------------------

test('isDeviceIdConflict：409 + code 才对，其余都不算', () => {
  assert.equal(isDeviceIdConflict(409, { code: DEVICE_ID_CONFLICT_CODE }), true);
  assert.equal(isDeviceIdConflict(409, { code: 'device_id_conflict' }), true, '错误码大小写不敏感');
  assert.equal(isDeviceIdConflict(409, { error: { code: DEVICE_ID_CONFLICT_CODE } }), true, '嵌套 error.code 也认');
  assert.equal(isDeviceIdConflict(409, { code: 'OTHER_CONFLICT' }), false, '只认状态码会把其它 409 也当成设备冲突');
  assert.equal(isDeviceIdConflict(200, { code: DEVICE_ID_CONFLICT_CODE }), false, '200 里的同名字段不是冲突响应');
  assert.equal(isDeviceIdConflict(409, null), false);
  assert.equal(isDeviceIdConflict(409, 'device conflict'), false, '纯文本 body 无结构化错误码');
  assert.equal(isDeviceIdConflict(409, { message: '设备标识冲突' }), false,
    '只凭 message 文案判冲突太脆（文案会改）；必须有稳定 code');
});

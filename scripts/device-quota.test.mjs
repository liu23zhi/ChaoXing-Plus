import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createConfigStore,
  DEVICE_ID_KEY,
  DEVICE_INSTANCE_KEY,
  hostDeviceId
} from '../windows/node-source/config.mjs';

/*
  设备槽位（141 号文档 §5/§8）的落地钉子。

  这里刻意分两类用例：
    A) 行为级：真的建临时目录、真的读回磁盘，验证 device_id 生成/复用/不写盘。
    B) 跨文件结构级：device_id 的三处存储键名必须逐字一致，以及
       「C5-2 只提醒不拦截」在源码层面确实没有拦截分支。
  B 类必须配合变异验证读（把 C5-2 改成拦截 → 必红），否则只是字符串断言。
*/

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEVICE_SOURCE = path.join(root, 'windows', 'native-source', 'device-quota.c');
const DEVICE_HEADER = path.join(root, 'windows', 'native-source', 'device-quota.h');
const HOME_SOURCE = path.join(root, 'windows', 'native-source', 'home.c');
const CONFIG_SOURCE = path.join(root, 'windows', 'node-source', 'config.mjs');

async function makeTempConfig() {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-device-'));
  return { directory, file: path.join(directory, 'config.json') };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/* 剥掉 C 注释，避免把「反例说明」误判成「又改回去了」。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('device id survives a reload and is reused instead of regenerated', async () => {
  const { directory, file } = await makeTempConfig();
  try {
    const first = createConfigStore(file, { debounceMs: 0 });
    await first.load();
    const generated = first.deviceId();
    assert.match(generated, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      'device id must be a lowercase RFC 4122 version 4 uuid');
    await first.flush();
    await first.close();

    const onDisk = await readJson(file);
    assert.equal(onDisk.settings[DEVICE_ID_KEY], generated,
      'device id must be persisted under settings[DEVICE_ID_KEY]');

    const second = createConfigStore(file, { debounceMs: 0 });
    await second.load();
    assert.equal(second.deviceId(), generated,
      'a restart must reuse the persisted device id (R5: the host slot is stable)');
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('--no-disk-write keeps the device id in memory and writes nothing', async () => {
  const { directory, file } = await makeTempConfig();
  try {
    const store = createConfigStore(file, { debounceMs: 0, persistEnabled: false });
    await store.load();
    const generated = store.deviceId();
    assert.match(generated, /^[0-9a-f-]{36}$/u, 'a device id is still minted for this run');
    await store.flush();
    await store.close();
    await assert.rejects(fs.access(file), (error) => error.code === 'ENOENT',
      'no-disk-write must not create the configuration file');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an existing device id in the config file is reused as-is', async () => {
  const { directory, file } = await makeTempConfig();
  try {
    await fs.writeFile(file, `${JSON.stringify({ settings: { [DEVICE_ID_KEY]: 'fixed-device-id' } }, null, 2)}\n`, 'utf8');
    const store = createConfigStore(file, { debounceMs: 0 });
    await store.load();
    assert.equal(store.deviceId(), 'fixed-device-id');
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hostDeviceId rejects malformed values instead of trusting the file', () => {
  assert.equal(hostDeviceId({}), '');
  assert.equal(hostDeviceId({ [DEVICE_ID_KEY]: '' }), '');
  assert.equal(hostDeviceId({ [DEVICE_ID_KEY]: 42 }), '');
  assert.equal(hostDeviceId({ [DEVICE_ID_KEY]: 'x'.repeat(65) }), '');
  assert.equal(hostDeviceId({ [DEVICE_ID_KEY]: 'ok-id' }), 'ok-id');
});

/*
  三处存储键一致性：扩展（src/runtime/device-identity.ts）、
  node 宿主（config.mjs）、原生宿主（device-quota.h）。
  任何一处改名，注入到 chrome.storage 的键扩展就读不到 —— 症状是「设备系统静默不生效」。
*/
test('device storage keys are identical in the node host and the native host', async () => {
  assert.equal(DEVICE_ID_KEY, 'common.settings.device-id');
  assert.equal(DEVICE_INSTANCE_KEY, 'common.settings.device-instance');

  const header = await fs.readFile(DEVICE_HEADER, 'utf8');
  assert.match(header, /#define CX_DEVICE_ID_KEY "common\.settings\.device-id"/u);
  assert.match(header, /#define CX_DEVICE_INSTANCE_KEY "common\.settings\.device-instance"/u);
});

/*
  R8 的结构级防线（配合变异 S10）：
  home_begin 里对超限提醒的调用**必须**丢弃返回值语义上的「拦截」，
  且同函数体内不得出现「因为 over_limit 而 return」的分支。
*/
test('the over-limit prompt never blocks starting a browser (R8)', async () => {
  const source = stripComments(await fs.readFile(HOME_SOURCE, 'utf8'));
  const begin = source.slice(source.indexOf('static void home_begin('));
  const body = begin.slice(0, begin.indexOf('\nstatic void '));

  assert.match(body, /home_device_confirm_over_limit\(state\);/u,
    'home_begin must consult the over-limit prompt');
  assert.doesNotMatch(body, /if\s*\(\s*!?\s*home_device_confirm_over_limit/u,
    'the prompt result must not gate home_begin — that would be blocking, which violates R8');
  assert.doesNotMatch(body, /cx_device_over_limit\s*\(/u,
    'home_begin must not make its own over-limit decision; only the prompt does');

  // 提醒函数本身不得有「拒绝」出口：只剩「用户点了仍然新建」与「用户点取消」。
  const promptFn = source.slice(source.indexOf('static BOOL home_device_confirm_over_limit('));
  const promptBody = promptFn.slice(0, promptFn.indexOf('\nstatic '));
  assert.match(promptBody, /return TRUE;/u, 'the prompt must default to TRUE (continue)');
  assert.doesNotMatch(promptBody, /return FALSE;[\s\S]*?block/u);
});

test('over-limit never fires for unlimited accounts or before a quota is known', async () => {
  const source = stripComments(await fs.readFile(DEVICE_SOURCE, 'utf8'));
  const fn = source.slice(source.indexOf('BOOL cx_device_over_limit('));
  const body = fn.slice(0, fn.indexOf('\nstatic '));
  assert.match(body, /quota->limit <= 0/u, 'limit==0 (unlimited) must never count as over limit');
  assert.match(body, /quota->known/u, 'an unknown quota must never count as over limit');
  assert.match(body, /quota->used >= quota->limit/u, 'the single over-limit judgement');
});

test('device reporting is fail-open: failures only change the status text', async () => {
  const source = stripComments(await fs.readFile(HOME_SOURCE, 'utf8'));
  // 上报/查询全部走独立线程，结果经 HOME_DEVICE_DONE 回来；失败只写文案。
  assert.match(source, /#define HOME_DEVICE_DONE \(WM_APP \+ 25\)/u);
  assert.match(source, /home_device_kick\(state, HOME_DEVICE_REPORT/u);
  assert.match(source, /home_device_flush_exit/u);
  // 失败分支必须只更新状态文案，不得 return / 不得改 operationOK。
  const settle = source.slice(source.indexOf('static void home_device_settle('));
  const settleBody = settle.slice(0, settle.indexOf('static BOOL home_device_prompt_modal('));
  assert.match(settleBody, /无法获取设备配额/u,
    'a failed quota fetch must surface as a status line');
  assert.doesNotMatch(settleBody, /state->operationOK\s*=\s*FALSE/u,
    'a failed device call must never fail the local operation');
  assert.doesNotMatch(settleBody, /state->closing\s*=/u,
    'a failed device call must never change the shutdown flow');
});

test('config.mjs documents that the device keys are shared with the extension', async () => {
  const source = await fs.readFile(CONFIG_SOURCE, 'utf8');
  assert.match(source, /DEVICE_ID_KEY/u);
  assert.match(source, /device-identity/u,
    'config.mjs must point at the extension-side owner of the same key names');
});

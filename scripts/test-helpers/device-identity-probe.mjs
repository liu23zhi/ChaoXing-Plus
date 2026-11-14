// 「一次扩展加载」的最小复现体：独立进程 + 文件背书的 localStorage。
//
// 为什么必须是**独立进程**而不是同一个测试进程里重新 import：
// `clientInstance` 是模块级常量，一个 Node 进程只会求值一次。要验证
// 「每次扩展加载都新生成」，就必须让模块在一个全新的 bundle 执行环境里跑一次 ——
// 独立进程正是这个环境的最忠实近似。
//
// 存储用文件背书，这样父测试能把**同一份文件**喂给第二次加载，精确复现
// 141 §4.3 的镜像复制场景（chrome.storage 内容一起被复制）。
//
// 输出一行 JSON：{ deviceId, clientInstance, storeKeys, storeRaw }
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const storePath = process.env.CX_DEVICE_PROBE_STORE;
if (!storePath) {
  throw new Error('CX_DEVICE_PROBE_STORE is required');
}

function readStore() {
  if (!existsSync(storePath)) return {};
  try {
    return JSON.parse(readFileSync(storePath, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function writeStore(value) {
  writeFileSync(storePath, JSON.stringify(value), 'utf8');
}

// runtimeStore 的读写契约：getItem 返回**已序列化的 JSON 字符串**或 null；
// setItem 收到的是 JSON.stringify 之后的值。
globalThis.localStorage = {
  getItem(key) {
    const store = readStore();
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
  },
  setItem(key, value) {
    const store = readStore();
    store[key] = String(value);
    writeStore(store);
  },
  removeItem(key) {
    const store = readStore();
    delete store[key];
    writeStore(store);
  }
};

// 与 src 的 .ts 解析 hook 对齐（build.mjs 里 .ts 优先于 .js 的同一条口径）。
// 用祖先目录 URL 作为 parentURL：hook 路径按调用方目录解析，用仓库根更直观。
const repoRootUrl = new URL('../../', import.meta.url);
register(new URL('../../scripts/ci/ts-source-hooks.mjs', import.meta.url).href, repoRootUrl);

const { getDeviceIdentity, regenerateDeviceId } = await import('../../src/runtime/device-identity.js');

const identity = getDeviceIdentity();
// 可选：模拟「运行中撞到 409 冲突 → 换 ID」。换完之后本轮的身份应该已经是新 ID，
// 且已落盘 —— 下一次加载必须拿到新值，不能复活旧 ID。
const regenerated = process.env.CX_DEVICE_PROBE_REGENERATE === '1' ? regenerateDeviceId() : undefined;
const afterRegenerate = regenerated ? getDeviceIdentity() : undefined;
const store = readStore();

process.stdout.write(`${JSON.stringify({
  deviceId: identity.deviceId,
  clientInstance: identity.clientInstance,
  regenerated,
  afterRegenerateDeviceId: afterRegenerate?.deviceId,
  afterRegenerateClientInstance: afterRegenerate?.clientInstance,
  storeKeys: Object.keys(store),
  storeRaw: Object.values(store).join('\n')
})}\n`);

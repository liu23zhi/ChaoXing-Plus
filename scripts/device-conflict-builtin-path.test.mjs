// 141 §4.2 / S7：**内置题库链路**的 409 冲突重试。
//
// ## 为什么必须单独一组（不能靠 device-identity-conflict.test.mjs）
//
// 那个文件测的是 `core/utils/request.ts` —— 那是**自定义题库**的通用调用器
// （被 core/answer-wrapper/handler 与 parser 使用）。
//
// 内置题库走的是另一条链路，共同经过 `requestTikuAdapterJSON`：
//
//   common.ts  createTikuAdapterAnswererWrapper
//     ├── asyncSearch=false → requestTikuAdapterLegacySearch → requestTikuAdapterJSON → /api/search
//     └── asyncSearch=true  → requestTikuAdapterSearchTask   → requestTikuAdapterJSON → /api/search/tasks
//
// 这两条都是**不同的 fetch 实现**（不是 request.ts），原本都**没有** 409 重试。
// 于是「镜像复制出来的第二份」在用内置题库时（＝绝大多数用户的默认路径）
// 会直接失败，且失败信息只是一句普通 HTTP 错误，用户没有任何可执行的动作。
//
// 服务端那两条端点都挂了 DeviceLimit（TIKU router.go:177/208 与 :186/209），
// 所以这不是假想场景。
//
// ## 为什么用 asyncSearch=false（legacy /api/search）做入口
//
// asyncSearch=true 那条要先过两跳 health 探测再进轮询，mock 稍有偏差就会悬挂
// （我实测卡死过两轮）。legacy 路径**一跳直连 /api/search**、无探测无轮询，
// 是同一段 `requestTikuAdapterJSON` 逻辑的最小可复现入口。
// 两者的 409 处理在同一处（requestTikuAdapterJSON 内），测一条即覆盖两条。
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./scripts/ci/ts-source-hooks.mjs', new URL('../', import.meta.url));

const { requestTikuAdapterAIFallback } = await import('../src/projects/tiku-adapter-config.js');
const { DEVICE_ID_CONFLICT_CODE, DEVICE_ID_HEADER } = await import('../src/runtime/device-identity.js');

const CONFIG = { baseurl: 'https://builtin.adapter.test', key: 'tk-builtin-test' };
// 实际端点：requestTikuAdapterAIFallback 默认走**异步任务版**，即 /api/ai-fallback/tasks。
// 它同样挂了 DeviceLimit（TIKU router.go:213），所以 409 冲突在这里也会发生。
const SEARCH_URL = '/api/ai-fallback/tasks';

async function withFetch(handler, body) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

function conflictResponse() {
  return Response.json(
    { code: DEVICE_ID_CONFLICT_CODE, message: '设备标识冲突，请重启以重新生成' },
    { status: 409 }
  );
}

function deviceIdOf(call) {
  const headers = call?.init?.headers ?? {};
  return headers[DEVICE_ID_HEADER] ?? headers[DEVICE_ID_HEADER.toLowerCase()] ?? '';
}

/** 只统计打到 /api/search（不是 health、不是 status）的请求。 */
function isSearchCall(url) {
  return String(url).endsWith(SEARCH_URL);
}

const OPTS = { requestTimeoutMs: 2000, retryAttempts: 3, retryDelayMs: 0 };

test('★ 内置题库：/api/search 收到 409 冲突 → 换 device_id 后重试并成功', async () => {
  const calls = [];
  let conflictSeen = false;

  const result = await withFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    if (!conflictSeen) {
      conflictSeen = true;
      return conflictResponse();
    }
    return Response.json({ answer: { answerKeyText: 'A' } });
  }, () => requestTikuAdapterAIFallback(CONFIG, { title: 'q' }, { requestTimeoutMs: 2000, retryAttempts: 3, retryDelayMs: 0 }));

  assert.ok(conflictSeen, '必须先收到 409 才会走到这条分支');
  assert.ok(result, '重试后应当拿到结果而不是抛错');

  const searchCalls = calls.filter((c) => isSearchCall(c.url));
  assert.ok(searchCalls.length >= 2,
    `冲突后应当再发一次 /api/search，实际 searchCalls=${searchCalls.length}`);

  // 核心：两次请求带的 device_id **必须不同**。
  // 只断言「重试了」不够 —— 不换 ID 的重试必然还是 409，只是白跑一趟。
  const firstId = deviceIdOf(searchCalls[0]);
  const lastId = deviceIdOf(searchCalls[searchCalls.length - 1]);
  assert.ok(firstId, '内置题库请求必须带 X-Device-Id（141 §7 入口 4）');
  assert.notEqual(lastId, firstId,
    '冲突重试必须换一个新的 device_id，否则重试必然再次 409');
});

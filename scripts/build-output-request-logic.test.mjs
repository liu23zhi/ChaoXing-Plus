import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

// 回归防线：src/core 下同时存在 .ts 与 .js，而 vite 默认把 .js 排在 .ts 前面。
// 一旦 resolve.extensions 丢了或顺序被改回默认，源码里的 'from "./x.js"' 就会
// 重新解析到影子文件，request.ts 的 tikuAdapter 错误分类会再次静默消失 —— 构建
// 仍然成功、测试仍然全绿，只有产物少了几段逻辑。
//
// 这里断言的是**行为特征**而不是函数名：产物经过 minify，标识符会被重命名，
// 但字符串字面量与语句结构保留。每条正则都对应 request.ts 里一段独有逻辑。
const distPath = resolveTestPath('dist', 'chaoxing-plus.js');

const REQUEST_TS_MARKERS = [
  {
    name: '余额封锁前置（请求前直接抛 INSUFFICIENT_BALANCE）',
    // request.ts: `throw new TikuAdapterRequestError('INSUFFICIENT_BALANCE')` 紧接重试循环
    pattern: /throw new \w+\(`INSUFFICIENT_BALANCE`\);for\(let/,
  },
  {
    name: 'HTTP 200 但响应体带 error 且无答案时识别为业务错误',
    // request.ts: `const responseData = await response.json(); if (isTikuAdapterRequest && responseData?.error && !hasTikuAdapterAnswer(responseData))`
    pattern: /await \w+\.json\(\);if\(\w+&&\w+\?\.error&&!\w+\(\w+\)\)\{/,
  },
  {
    name: '余额不足不参与重试',
    // request.ts: `if (err instanceof TikuAdapterRequestError && err.code === 'INSUFFICIENT_BALANCE') return false;`
    pattern: /instanceof \w+&&\w+\.code===`INSUFFICIENT_BALANCE`\?!1/,
  },
];

test('构建产物包含 request.ts 的 tikuAdapter 错误分类逻辑', { skip: !existsSync(distPath) && 'dist 未构建（先 npm run build）' }, async () => {
  const bundle = await readFile(distPath, 'utf8');
  assert.ok(bundle.length > 100_000, `产物过小，可能不是完整构建：${bundle.length} 字节`);

  const missing = REQUEST_TS_MARKERS.filter((marker) => !marker.pattern.test(bundle)).map((marker) => marker.name);
  assert.deepEqual(missing, [], [
    '以下 request.ts 独有逻辑没有进入构建产物：',
    ...missing.map((name) => `  - ${name}`),
    '',
    '最可能的原因：build.mjs 的 resolve.extensions 丢了，或 .js 被排到 .ts 前面，',
    '导致 "from \'./x.js\'" 重新解析到 src/core 下的影子 .js 文件。',
  ].join('\n'));
});

test('构建产物不再来自 src/core 的影子 .js（.ts 优先）', { skip: !existsSync(distPath) && 'dist 未构建（先 npm run build）' }, async () => {
  const buildScript = await readFile(resolveTestPath('build.mjs'), 'utf8');
  // 断言的是「.ts 出现在 .js 之前」，而不是某个具体写法，允许换行/空格差异。
  const match = buildScript.match(/extensions:\s*\[([^\]]+)\]/u);
  assert.ok(match, 'build.mjs 必须显式声明 resolve.extensions');

  const extensions = match[1].split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/gu, ''));
  const tsIndex = extensions.indexOf('.ts');
  const jsIndex = extensions.indexOf('.js');
  assert.notEqual(tsIndex, -1, `resolve.extensions 必须包含 .ts：${extensions.join(', ')}`);
  assert.notEqual(jsIndex, -1, `resolve.extensions 必须包含 .js：${extensions.join(', ')}`);
  assert.ok(tsIndex < jsIndex, `.ts 必须排在 .js 之前，否则影子文件会覆盖源码：${extensions.join(', ')}`);
});

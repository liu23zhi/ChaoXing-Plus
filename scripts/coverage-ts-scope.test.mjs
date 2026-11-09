// src 组必须统计 .ts 源码，而不是同名 .js 影子文件。
//
// build.mjs 的 resolve.extensions 把 .ts 排在 .js 前面（PR #19），进构建产物的是 .ts；
// 但历史测试仍 `import '../src/core/utils/request.js'`，Node 默认会加载影子 .js，
// 于是覆盖率门禁在给一份**不会上线**的文件打分。
//
// 实测（scripts/runtime-request-retry.test.mjs）：
//   无 hook -> request.js  96.81 / 72.22 / 80.00
//   有 hook -> request.ts  82.14 / 63.74 / 81.82
// 这组用例把「hook 生效」钉住，避免 CI 漏掉 --import 时门禁静默退回错误口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// TAP 覆盖率行形如：`#    request.js |  96.81 |    72.22 |   80.00 | 77 89-90`
const COVERAGE_ROW = /^#\s+(\S+)\s*\|\s*[\d.]+\s*\|/u;

function reportedFiles(extraArgs) {
  // 本用例自己就跑在 `node --test` 里；Node 会把 NODE_TEST_CONTEXT 传给子进程，
  // 子进程于是以为自己是父运行器的测试进程而**不输出任何内容**（实测 len=0）。
  // 清掉它，子进程才会真的执行并产出覆盖率表。
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  // 覆盖率表走 stdout（stderr 只有诊断），用 stdio pipe 同时收下两路更稳妥。
  const output = execFileSync(process.execPath, [
    ...extraArgs,
    '--test', '--experimental-test-coverage', '--test-concurrency=1',
    '--test-reporter=tap', 'scripts/runtime-request-retry.test.mjs'
  ], { encoding: 'utf8', stdio: 'pipe', cwd: resolve(import.meta.dirname, '..'), env });

  const files = new Set();
  for (const line of output.split(/\r?\n/u)) {
    const row = line.match(COVERAGE_ROW);
    if (row) files.add(row[1].trim());
  }
  return files;
}

test('without the resolve hook coverage reports the shadow request.js', () => {
  const files = reportedFiles([]);
  assert.ok(files.has('request.js'), `默认解析应统计影子 .js，实际: ${[...files].join(', ') || '(空)'}`);
  assert.equal(files.has('request.ts'), false, '默认解析不该统计 .ts');
});

test('with the resolve hook coverage reports request.ts and never the shadow', () => {
  const files = reportedFiles(['--import', './scripts/ci/coverage-register.mjs']);
  assert.ok(files.has('request.ts'), `注册 hook 后应统计 .ts，实际: ${[...files].join(', ') || '(空)'}`);
  assert.equal(files.has('request.js'), false, '同一逻辑不能既算 .js 又算 .ts（会被算两遍）');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';

// 覆盖率门禁的解析器曾经有一个静默失效的 bug：
//
// TAP 覆盖率报告是**缩进式目录树**：
//   # windows |
//   #  node-source |
//   #   main.mjs | 77.56 | ...
//
// 最初的解析器只看最后一段文件名、不维护目录栈，于是每个文件都被算成"未归组"，
// 门禁在**一个文件都没检查**的情况下照样打印"覆盖率门禁通过"。这比没有门禁更危险：
// 它给出的是虚假的信心。
//
// 下面的用例把两条都钉住：路径必须按深度还原；一组为空时必须判失败。

const gate = resolveTestPath('scripts', 'ci', 'check-coverage.mjs');

function runGate(tapContent) {
  const directory = createTestDirectory('coverage-gate');
  const tapPath = resolve(directory, 'coverage.tap');
  writeFileSync(tapPath, tapContent, 'utf8');
  try {
    const stdout = execFileSync(process.execPath, [gate, tapPath], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

// 生成一个最小的合法覆盖率 TAP：只有目录头与文件行，比例可控。
function tapFor(rows) {
  return [
    'TAP version 13',
    'ok 1 - dummy',
    '# start of coverage report',
    '# -----------------------------------------------------------------',
    '# file | line % | branch % | funcs % | uncovered lines',
    '# -----------------------------------------------------------------',
    ...rows,
    '# -----------------------------------------------------------------',
    '# all files | 90.00 | 90.00 | 90.00 |',
    '# -----------------------------------------------------------------',
    '# end of coverage report',
    '',
  ].join('\n');
}

test('覆盖率门禁按缩进深度还原完整路径，不会把文件算成未归组', () => {
  const tap = tapFor([
    '# windows |        |          |         |',
    '#  node-source |        |          |         |',
    '#   main.mjs |  99.00 |    99.00 |   99.00 |',
    '#   inject.mjs |  99.00 |    99.00 |   99.00 |',
    '#  share-file |        |          |         |',
    '#   package-windows.mjs |  99.00 |    99.00 |   99.00 |',
    '# src |        |          |         |',
    '#  core |        |          |         |',
    '#   utils |        |          |         |',
    '#    request.js |  99.00 |    99.00 |   99.00 |',
  ]);

  const result = runGate(tap);
  assert.equal(result.code, 0, result.output);

  // 三组都要真的被统计到，而不是"未统计到任何文件"
  assert.doesNotMatch(result.output, /未统计到任何文件/u, result.output);
  assert.match(result.output, /windows\/node-source\s+2 文件/u, result.output);
  assert.match(result.output, /windows\/share-file\s+1 文件/u, result.output);
  assert.match(result.output, /src\s+1 文件/u, result.output);
});

test('覆盖率低于阈值时门禁失败并指出具体指标', () => {
  const tap = tapFor([
    '# windows |        |          |         |',
    '#  node-source |        |          |         |',
    '#   main.mjs |  10.00 |    10.00 |   10.00 |',
    '#  share-file |        |          |         |',
    '#   package-windows.mjs |  99.00 |    99.00 |   99.00 |',
    '# src |        |          |         |',
    '#  core |        |          |         |',
    '#   utils |        |          |         |',
    '#    request.js |  99.00 |    99.00 |   99.00 |',
  ]);

  const result = runGate(tap);
  assert.equal(result.code, 1, result.output);
  // 必须点名是哪一组、哪个指标、实际值
  assert.match(result.output, /windows\/node-source/u, result.output);
  assert.match(result.output, /line 10\.00% < 要求 \d+%/u, result.output);
});

test('某组一个文件都没统计到时判失败，不静默通过', () => {
  // 只给 src，不给 windows 两组：这两组必须报"未统计到任何文件"并让门禁失败
  const tap = tapFor([
    '# src |        |          |         |',
    '#  core |        |          |         |',
    '#   utils |        |          |         |',
    '#    request.js |  99.00 |    99.00 |   99.00 |',
  ]);

  const result = runGate(tap);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /windows\/node-source\s+✗ 未统计到任何文件/u, result.output);
});

test('报告为空时以退出码 2 报错，不当作通过', () => {
  const result = runGate('TAP version 13\nok 1 - nothing\n');
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /覆盖率报告解析为空/u, result.output);
});

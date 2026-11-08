import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// 内部交接标记与原生明确拒绝的 Node-only 能力：不进入 --help，避免误导使用者。
const INTERNAL_FLAGS = new Set([
  '--elevated',
  '--elevated-client',
  '--staged-boot',
  '--stage-boot-internal',
  '--delete-suspend',
  '--memory-exec',
  '--execution-mode-memory',
  '--execution-mode-delete-suspend',
  '--wipe-owned-files-on-start',
  '--wipe-failure-policy',
  '--wipe-retries',
  '--wipe-retry-delay',
  '--wipe-runtime-interval',
  '--wipe-runtime-retry',
  '--no-wipe-runtime-retry',
  '--self-destruct-key',
  '--self-destruct-delay',
  '--self-destruct-on-fullscreen-exit',
  '--no-self-destruct-confirm',
  '--silent-client'
]);

// 用户可见且容易漏写的参数：必须在 --help 文本里出现。
// 以前这条断言读 docs/windows.md；文档迁到 TikuDoc 后改为直接断言 host.c 内嵌的
// --help 字符串——那是随代码走的唯一权威来源，测试不再依赖任何文档。
const MUST_BE_IN_HELP = [
  '--inject-mode',
  '--inject-proxy-dir',
  '--show-inject-reasons',
  '--panel-all-pages',
  '--install-proxy',
  '--proxy-source',
  '--uninstall-proxy',
  '--probe-client',
  '--probe-all',
  '--pipe-test',
  '--pipe-client',
  '--pipe-call',
  '--console',
  '--stage-boot'
];

const optionsSource = resolve('windows/native-source/options.c');
const hostSource = resolve('windows/native-source/host.c');
const hostExe = process.env.CX_NATIVE_HOST_EXE ? resolve(process.env.CX_NATIVE_HOST_EXE) : resolve('windows/native-build/bin/chaoxing_plus.exe');

async function acceptedFlags() {
  const source = await readFile(optionsSource, 'utf8');
  const flags = new Set();
  for (const match of source.matchAll(/cx_streq\(name,\s*L"(--[a-z0-9-]+)"\)/gu)) flags.add(match[1]);
  return [...flags].sort();
}

function helpText() {
  const result = spawnSync(hostExe, ['--help'], { encoding: 'utf8', timeout: 60000 });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

test('每个用户可见开关都出现在 --help 中', { skip: process.platform !== 'win32' || !existsSync(hostExe) }, async () => {
  const flags = await acceptedFlags();
  assert.ok(flags.length > 50, `解析到的开关数量异常：${flags.length}`);
  const help = helpText();
  const missing = flags.filter((flag) => !INTERNAL_FLAGS.has(flag) && !help.includes(flag));
  assert.deepEqual(missing, [], `以下开关未出现在 --help：${missing.join(', ')}`);
});

test('注入相关的用户可见开关都写进了 host.c 的 --help 文本', async () => {
  const source = await readFile(hostSource, 'utf8');
  const missing = MUST_BE_IN_HELP.filter((flag) => !source.includes(flag));
  assert.deepEqual(missing, [], `以下开关未出现在 host.c 的 --help 文本：${missing.join(', ')}`);
});

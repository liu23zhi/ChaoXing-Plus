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

// 用户可见参数必须同时出现在文档参数表中。
const MUST_BE_IN_DOCS = [
  '--inject-mode',
  '--inject-proxy-dir',
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
const docsPath = resolve('docs/windows.md');
const hostExe = process.env.CX_NATIVE_HOST_EXE ? resolve(process.env.CX_NATIVE_HOST_EXE) : resolve('build-windows/bin/chaoxing_plus.exe');

async function acceptedFlags() {
  const source = await readFile(optionsSource, 'utf8');
  const flags = new Set();
  for (const match of source.matchAll(/cx_streq\(a,\s*L"(--[a-z0-9-]+)"\)/gu)) flags.add(match[1]);
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

test('注入相关的用户可见开关都写进了文档参数表', async () => {
  const docs = await readFile(docsPath, 'utf8');
  const missing = MUST_BE_IN_DOCS.filter((flag) => !docs.includes(flag));
  assert.deepEqual(missing, [], `以下开关未出现在 docs/windows.md：${missing.join(', ')}`);
});
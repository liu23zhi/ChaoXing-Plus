// 生成式 .ps1 必须带 UTF-8 BOM。
//
// 背景（本机实测，不是推测）：Windows PowerShell 5.1 对**没有 BOM** 的 .ps1 按
// ANSI/OEM 代码页解码。仓库路径含中文时（例如 .../学习通客户端/...），脚本里的
// 路径字面量会被解码成乱码（实测 `学习通客户端` → `瀛︿範閫氬鎴风`），于是
// `. 'C:\...\windows-client-entry.ps1'` 直接报 "not recognized as the name of a
// cmdlet"。测试看到的是下游症状（"Fixture could not acquire foreground" 之类），
// 真正的编码问题被掩盖。
//
// 历史测试在纯 ASCII 路径下全绿、在含中文路径下全红，就是这个原因。
// 下面把「生成的脚本必须带 BOM」和「带 BOM 后中文路径真的能 dot-source」都钉住，
// 避免以后有人改成无 BOM 写法又悄悄红掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createTestDirectory } from './test-helpers/temp-directory.mjs';
import { writePowerShellScript, runPowerShellScript } from './test-helpers/windows-script.mjs';

const BOM_BYTES = [0xEF, 0xBB, 0xBF];
const windowsOnly = process.platform === 'win32' ? undefined : 'Windows PowerShell encoding regression';

test('writePowerShellScript always emits a UTF-8 BOM so PowerShell 5.1 decodes non-ASCII paths', () => {
  const directory = createTestDirectory('ps1-bom');
  const scriptPath = path.join(directory, 'probe.ps1');
  writePowerShellScript(scriptPath, "Write-Output 'hello'\n");

  const bytes = readFileSync(scriptPath);
  assert.deepEqual([...bytes.subarray(0, 3)], BOM_BYTES, '生成的 .ps1 前 3 字节必须是 EF BB BF');

  // 幂等：已经带 BOM 的内容不能再叠一个。
  writePowerShellScript(scriptPath, '\uFEFFWrite-Output "again"\n');
  const text = readFileSync(scriptPath, 'utf8');
  assert.equal(text.match(/\uFEFF/gu).length, 1, 'BOM 不得重复叠加');
  assert.match(text, /again/u);
});

test('a generated script can dot-source a path containing non-ASCII characters', { skip: windowsOnly }, () => {
  const directory = createTestDirectory('ps1-cjk');

  // 造一个「子目录名含中文」的场景：不依赖仓库本身是否在中文路径下，
  // 因此在 CI 的 ASCII 工作目录里同样有意义。
  const cjkDirectory = path.join(directory, '\u5b66\u4e60\u901a\u5ba2\u6237\u7aef'); // 学习通客户端
  mkdirSync(cjkDirectory, { recursive: true });

  const target = path.join(cjkDirectory, 'target.ps1');
  writePowerShellScript(target, "Write-Output 'DOT-SOURCED'\n");

  const harness = path.join(directory, 'harness.ps1');
  writePowerShellScript(harness, `. '${target.replace(/'/gu, "''")}'\n`);

  const result = runPowerShellScript(harness, { timeout: 30_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /DOT-SOURCED/u);
});

test('the checked-in dialog and cleanup regressions generate their harness through the BOM helper', () => {
  // 防止有人把 harness 写回裸 writeFileSync（那会让中文路径再次全红）。
  for (const testFile of ['windows-client-dialog.test.mjs', 'windows-real-client-cleanup.test.mjs']) {
    const source = readFileSync(path.join(process.cwd(), 'scripts', testFile), 'utf8');
    assert.match(source, /writePowerShellScript/u, `${testFile} 必须用 writePowerShellScript 生成 .ps1`);
    assert.doesNotMatch(
      source,
      /writeFileSync\(\s*(?:harness|path\.join\(directory, '[^']+\.ps1'\))/u,
      `${testFile} 不得再对 .ps1 直接 writeFileSync（会丢 BOM）`
    );
  }
  assert.ok(existsSync(path.join(process.cwd(), 'scripts', 'test-helpers', 'windows-script.mjs')));
});

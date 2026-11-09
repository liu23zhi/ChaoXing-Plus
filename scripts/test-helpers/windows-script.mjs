// 生成并执行临时 PowerShell 脚本的辅助。
//
// 为什么需要它：Windows PowerShell 5.1 对**没有 BOM** 的 .ps1 按 ANSI/OEM 代码页解码。
// 只要脚本里出现非 ASCII 字符（最典型的是仓库路径含中文，例如
// `C:\Users\...\学习通客户端\...`），字面量就会被解码成乱码
// （实测：`学习通客户端` → `瀛︿範閫氬鎴风`），于是 `. 'C:\...\windows-client-entry.ps1'`
// 直接报 "not recognized as the name of a cmdlet"，测试表现为
// "Fixture could not acquire foreground" 之类的下游症状，掩盖了真正的编码问题。
//
// Node 的 `writeFileSync(path, text)` 默认写 UTF-8 **不带** BOM，所以历史测试
// 在 ASCII 路径下正常、在含中文的路径下全红。这里统一补 BOM。
//
// 用法：
//   import { writePowerShellScript, runPowerShellScript } from './windows-script.mjs';
//   writePowerShellScript(harness, '...');
//   runPowerShellScript(harness, { timeout: 45_000 });
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const BOM = '\uFEFF';

/** 写出一个带 UTF-8 BOM 的 .ps1，供 Windows PowerShell 5.1 正确解码非 ASCII 路径。 */
export function writePowerShellScript(filePath, content) {
  const body = content.startsWith(BOM) ? content : `${BOM}${content}`;
  writeFileSync(filePath, body, 'utf8');
}

/**
 * 用 Windows PowerShell 执行脚本并返回 spawnSync 结果。
 * options 透传给 spawnSync（encoding/windowsHide/timeout/env/cwd 等）。
 */
export function runPowerShellScript(filePath, options = {}) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', filePath
  ], {
    encoding: 'utf8',
    windowsHide: true,
    ...options
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

const preparationScript = resolveTestPath('scripts', 'ci', 'prepare-windows-real-client-environment.ps1');
const source = readFileSync(preparationScript, 'utf8');

// 2026-11-11 的失败（run 42963609890，job 130336247683，客户端 v4.1.4.25389 数据库2）表现为：
//   attempts=0 reason=entry-button-never-visible / pageSessions=0
// 桌面截图里屏幕中央有 OBS 的 Auto-Configuration Wizard。
//
// 机制（读代码得到，不是推测）：入口按钮靠 Get-WindowScanBuffer 定位，而它用的是
// Graphics.CopyFromScreen —— 抓的是**屏幕像素**，不是窗口自身的 DC。所以任何压在客户端窗口
// 之上的窗口都会让按钮「看不见」，随后 CEF 页面根本不会创建。
//
// 这组断言钉住三件事，缺一条这个竞态就会回来：
//   ① 启动 OBS 之前预写配置（降低向导出现的概率）
//   ② 启动之后检测并关闭向导（向导真出现时兜底）
//   ③ 关不掉时不静默（日志必须点名，便于下次直接定位）

test('OBS 启动前必须预写配置，让首次运行向导不再出现', () => {
  // 函数的调用必须排在 Start-Process 之前，否则配置来不及生效。
  const initAt = source.indexOf('Initialize-ObsProfile -ObsExecutable');
  const startAt = source.indexOf("Start-Process -FilePath $obs");
  assert.notEqual(initAt, -1, 'Add-VirtualCamera 必须先调用 Initialize-ObsProfile');
  assert.notEqual(startAt, -1, '必须保留 Start-Process 启动 OBS');
  assert.ok(initAt < startAt, 'Initialize-ObsProfile 必须在启动 OBS 之前调用（否则首启已经弹过向导）');

  // OBS 28+ 把 [General] 从 global.ini 挪到了 user.ini，只写 global.ini 在现行版本上无效。
  assert.match(source, /user\.ini/u, '必须写 user.ini（OBS 28+ 的 [General] 在这里）');
  assert.match(source, /FirstRun=false/u, '必须显式写 FirstRun=false');
  // 空 .sentinel 才是「配置目录已初始化」的真正标记；缺它 OBS 会把下次启动当首启。
  assert.match(source, /\.sentinel/u, '必须创建 .sentinel，否则 OBS 仍按首启处理并弹向导');
  // ConfirmOnExit=false：避免 OBS 在收尾时卡在模态确认框上，把作业拖到超时。
  assert.match(source, /ConfirmOnExit=false/u, '必须关掉 OBS 退出确认框，避免收尾卡住');
});

test('OBS 启动后必须检测并关闭向导，且不能杀掉 obs64 本体', () => {
  const waitAt = source.indexOf('Wait-ObsWizardGone -TimeoutSeconds');
  const startAt = source.indexOf("Start-Process -FilePath $obs");
  assert.notEqual(waitAt, -1, '启动 OBS 之后必须调用 Wait-ObsWizardGone');
  assert.ok(startAt < waitAt, '向导检测必须在启动之后进行');

  assert.match(source, /function Wait-ObsWizardGone/u, '必须保留 Wait-ObsWizardGone');
  assert.match(source, /Auto-Configuration/u, '必须按 Auto-Configuration 标题匹配向导窗口');

  // 虚拟摄像头依赖 obs64 常驻：关向导只能关那个窗口，不能杀进程。
  const waitBody = source.slice(source.indexOf('function Wait-ObsWizardGone'));
  const waitEnd = waitBody.indexOf('\nfunction ');
  const body = waitEnd === -1 ? waitBody : waitBody.slice(0, waitEnd);
  assert.doesNotMatch(body, /Stop-Process/u,
    'Wait-ObsWizardGone 不得 Stop-Process：虚拟摄像头依赖 obs64 常驻，杀掉会让设备消失');
  assert.match(body, /WM_CLOSE|SendMessageW/u, '必须用 WM_CLOSE 关窗口而不是杀进程');
});

test('向导关不掉时必须显式告警，不能静默', () => {
  assert.match(source, /WARNING OBS wizard is still visible/u,
    '向导仍在时必须输出 WARNING，并点明后果（entry button may be covered / pageSessions=0）');
  assert.match(source, /pageSessions=0/u, '告警文案必须点出可观测的后果，便于对日志');
});

test('设备始终没出现时要把当时的窗口列表写进日志', () => {
  assert.match(source, /function Get-VisibleWindowSummary/u, '必须保留窗口摘要辅助函数');
  assert.match(source, /camera: windows when no device appeared/u,
    '设备未出现时必须记录当时的窗口列表，否则下次仍只能靠截图定位');
  // 记录的是「进程名:标题」，标题里才有 Auto-Configuration 这类可读信息。
  assert.match(source, /ProcessName.*MainWindowTitle|MainWindowTitle.*ProcessName/u,
    '窗口摘要必须同时带进程名与标题');
});

test('预写配置真的会落出 OBS 认识的结构（用假 APPDATA 实跑）', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'cx-obs-profile-'));
  try {
    // 只抽 Initialize-ObsProfile 一个函数来跑，避免触发 choco / 启动 OBS。
    const start = source.indexOf('function Initialize-ObsProfile');
    const end = source.indexOf('# Close the Auto-Configuration Wizard');
    assert.notEqual(start, -1, '必须存在 Initialize-ObsProfile');
    assert.notEqual(end, -1, 'Initialize-ObsProfile 必须排在 Wait-ObsWizardGone 之前');
    const fn = source.slice(start, end);
    const runner = [
      "function Write-Step([string] $message) { Write-Host \"[desktop-prep] $message\" }",
      `$env:APPDATA = '${sandbox.replace(/\\/gu, '\\\\')}'`,
      fn,
      "Initialize-ObsProfile -ObsExecutable 'C:/nowhere/obs64.exe'",
    ].join('\n');

    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', runner], {
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(result.status, 0, `预写配置执行失败: ${result.stderr ?? ''}`);

    const root = join(sandbox, 'obs-studio');
    assert.ok(existsSync(root), '必须在 %APPDATA%\\obs-studio 下建立配置目录');
    // .sentinel 必须是 0 字节空文件：OBS 用它判断「配置目录已初始化」。
    const sentinel = join(root, '.sentinel');
    assert.ok(existsSync(sentinel), '必须创建 .sentinel');
    assert.equal(statSync(sentinel).size, 0, '.sentinel 必须是空文件（有内容时 OBS 行为不同）');

    const userIni = readFileSync(join(root, 'user.ini'), 'utf8');
    assert.match(userIni, /FirstRun=false/u, 'user.ini 必须写 FirstRun=false');
    assert.match(userIni, /ConfirmOnExit=false/u, 'user.ini 必须写 ConfirmOnExit=false');
    assert.match(userIni, /Profile=CI/u, 'user.ini 必须指向 CI profile');

    // profiles 与 scenes 必须都有实体：只有 user.ini 而缺 profile 时 OBS 会重新走首启流程。
    const profiles = readdirSync(join(root, 'basic', 'profiles'));
    assert.deepEqual(profiles, ['CI'], `profiles 下必须只有 CI 一个 profile，实际: ${profiles.join(',')}`);
    assert.ok(existsSync(join(root, 'basic', 'profiles', 'CI', 'basic.ini')), 'CI profile 必须有 basic.ini');
    const scenes = readdirSync(join(root, 'basic', 'scenes'));
    assert.deepEqual(scenes, ['CI.json'], `scenes 下必须有 CI.json，实际: ${scenes.join(',')}`);
    const sceneJson = JSON.parse(readFileSync(join(root, 'basic', 'scenes', 'CI.json'), 'utf8'));
    assert.equal(sceneJson.name, 'CI', 'scene 集合名必须与 user.ini 的 SceneCollectionFile 对应');

    assert.ok(existsSync(join(root, 'global.ini')), '必须写 global.ini');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('保持 CI 可直接调用的既有契约：纯 ASCII、不 exit', () => {
  const bytes = readFileSync(preparationScript);
  assert.equal(bytes.some((byte) => byte > 0x7f), false, '必须保持纯 ASCII（见文件头注释）');
  assert.doesNotMatch(source, /^\s*exit \d+/mu, '脚本不得 exit，否则会截断 CI 步骤');
});

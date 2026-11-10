import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

async function read(relative) {
  return readFile(path.join(root, relative), 'utf8');
}

// 把 YAML 注释行去掉，只留真正会被执行的内容。
// 负向断言必须跑在这份文本上：注释里出现「chmod 666」「pull_request_target」
// 这类字样是解释历史，不是行为。
function withoutComments(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n');
}

// 这一组断言锁的是 2026-11-09 的实测结论（run 42588732951 / 42590175761），
// 让「托管 runner 不支持嵌套虚拟化」这个已被推翻的说法不会悄悄回到注释里，
// 也让每日巡检作业的成本上限（5 分钟、不装机）不会被人手改回去。
// 数据出处：task_doc/06-CI升级与虚拟机测试.md §4.2 / §5.5，
// 索引：task_doc/00-总览与任务索引.md §8「PLUS KVM 探测结论」、§9 第 12 条。

test('ci-vm.yml 提到旧断言时必须同处标注它已被推翻', async () => {
  const workflow = await read('.github/workflows/ci-vm.yml');
  const claim = '不支持嵌套虚拟化';
  const hits = workflow
    .split(/\r?\n/u)
    .map((line, index) => ({ line, index: index + 1 }))
    .filter((entry) => entry.line.includes(claim));

  assert.ok(hits.length > 0, `必须保留对旧断言的修订说明（找不到「${claim}」）`);
  for (const hit of hits) {
    assert.match(
      hit.line,
      /推翻|不成立|已修订|错/u,
      `第 ${hit.index} 行仍把「${claim}」当结论使用，缺少「已被推翻」类标注：${hit.line.trim()}`,
    );
  }
});

test('ci-vm.yml 必须写清留在 self-hosted 的真实理由', async () => {
  const workflow = await read('.github/workflows/ci-vm.yml');
  // 真实理由一：作业内不能真重启宿主（托管 runner 一次作业一台一次性 VM）。
  assert.match(workflow, /一次作业一[台次]/u, '必须写明托管 runner 的生命周期限制');
  // 真实理由二：KVM 设备存在但作业用户不在 kvm 组。
  assert.match(workflow, /\/dev\/kvm/u, '必须提到 /dev/kvm 实测事实');
  assert.match(workflow, /KVM_ACCESSIBLE=no|不在 kvm 组/u, '必须写明权限而不是「没有设备」');
  // 必须指向 QEMU 备选与它的成本，避免读者以为没试过。
  assert.match(workflow, /QEMU/u, '必须提到 QEMU + Windows guest 这条备选路径');
  // 论证必须留在仓库内可达的位置：本文件头部已把两条实测结论就地写全，
  // 不再外链 task_doc 的编号文档（那是跨轮次记忆目录，不在本仓库、对外不可达）。
  assert.match(workflow, /嵌套虚拟化|KVM_ACCESSIBLE=no/u, '必须就地写明实测结论，不得只给外部出处');
});

test('ci-vm.yml 的 runner 标签与必要检查名保持不变', async () => {
  const workflow = await read('.github/workflows/ci-vm.yml');
  assert.match(workflow, /runs-on: \[self-hosted, windows, cx-vm\]/u, 'self-hosted cx-vm 策略不变');
  assert.match(workflow, /name: 关机自毁与开机续删（虚拟机）/u, '既有 job 名不得改动');
  assert.match(workflow, /vars\.CX_VM_ENABLED == 'true'/u, '三重保护不变');
  // 托管 runner 上的语义验证作业必须保留，否则「RunOnce 命令串是否可执行」
  // 会退回到「从未验证」。
  assert.match(workflow, /^ {2}wiring-probe:$/mu, 'wiring-probe 作业必须保留');
  assert.match(workflow, /name: 自毁续删语义验证（不关机，托管 runner）/u, '作业名需说明它验证的是语义而非接线');
});

test('wiring-probe 必须真跑两阶段语义验证，不能只验证接线', async () => {
  const workflow = withoutComments(await read('.github/workflows/ci-vm.yml'));

  // 1) 必须是 workflow_dispatch 独占：不参与 PR、不参与夜间巡检。
  //    2026-11-10 合并后改为多行 if（多了 gate 日判重），语义不变、约束更强，
  //    因此这里断言『if 块里出现 workflow_dispatch 且没有 pull_request/schedule』。
  assert.match(workflow, /^\s+if: \|/mu, 'wiring-probe 必须显式声明 if 块');
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/u, '只由手动触发');
  assert.doesNotMatch(workflow, /^\s{2}pull_request:/mu, '不得挂 pull_request');
  assert.doesNotMatch(workflow, /^\s{2}schedule:/mu, '不得挂 schedule');

  // 2) 不得再挂 continue-on-error —— 挂了就永远绿，等于没有门禁。
  //    缺陷 c/d 已由 PR #29 修掉，保留它会让真实的续删回归被吞掉。
  assert.doesNotMatch(workflow, /continue-on-error/u, '不得保留 continue-on-error（会让门禁永远是绿的）');

  // 3) 两阶段都必须真跑，且顺序固定：先登记再重放。
  const shutdownIndex = workflow.indexOf('-Stage shutdown -NoShutdown');
  const replayIndex = workflow.indexOf('-Stage resume -ReplayRunOnce');
  assert.ok(shutdownIndex > 0, '必须跑 shutdown -NoShutdown 阶段');
  assert.ok(replayIndex > 0, '必须跑 resume -ReplayRunOnce 阶段（这是盖住「续删真的执行」的那一半）');
  assert.ok(shutdownIndex < replayIndex, '必须先登记再重放：resume 断言的正是重放之后的状态');

  // 4) 覆盖边界必须写在注释里，不许留悬空断言。
  const raw = await read('.github/workflows/ci-vm.yml');
  assert.match(raw, /不覆盖|盖不住/u, '必须写明这个作业覆盖不到什么');
  assert.match(raw, /WM_QUERYENDSESSION/u, '必须点名未覆盖的真实关机时序');
  assert.match(raw, /MOVEFILE_DELAY_UNTIL_REBOOT/u, '必须点名未覆盖的重启后删除');

  // 5) workflow 传了 -ReplayRunOnce，脚本就必须真的实现它。
  //    否则参数被静默忽略，两阶段退化成两次 -NoShutdown：作业仍是绿的，
  //    但「注册表里那条命令串能不能执行」这一半又回到从未验证。
  const vmScript = await read('scripts/vm/run-shutdown-destruct.ps1');
  assert.match(vmScript, /\[switch\]\$ReplayRunOnce/u, '脚本必须声明 -ReplayRunOnce 开关');
  assert.match(vmScript, /if \(\$ReplayRunOnce\)/u, '开关必须真的分支，不能只声明');
  // 重放必须按注册表原文执行（cmd /c <stored command>），不能自己拼一条新命令。
  assert.match(vmScript, /& \$shell \/c \$command/u, '必须把注册表里存的命令串原样交给 shell');
  assert.match(vmScript, /Get-ItemProperty -LiteralPath \$runOnceKey -Name \$name/u, '命令串必须从 RunOnce 读回');
  // 重放后登记必须清空，否则 -ReplayRunOnce 就成了「跑了但没断言」。
  assert.match(vmScript, /重放 RunOnce 后登记仍在/u, '重放后残留登记必须记为问题');

  // 6) 残留检查必须查脚本真正用的那个临时根目录。
  //    run-shutdown-destruct.ps1 用「有 RUNNER_TEMP 就用它，否则 %TEMP%」，
  //    只查 %TEMP% 会在 runner 上漏报（%TEMP% 与 RUNNER_TEMP 不是同一个目录）。
  const leftoverStep = raw.slice(raw.indexOf('断言运行后无残留'));
  assert.match(leftoverStep, /\$env:RUNNER_TEMP/u, '残留检查必须覆盖 RUNNER_TEMP');
  assert.match(leftoverStep, /IsNullOrWhiteSpace\(\$_\)|IsNullOrWhiteSpace\(\$env:TEMP\)/u,
    '临时根目录要过滤空值后取唯一值');

  // 7) 不得设对本作业无效的环境变量：上一轮的 CX_NATIVE_BUILD_ALLOW_UNSIGNED
  //    就是这样来的（全仓只此一处，没人读它）。本作业不跑任何宿主，
  //    CXPLUS_NO_LOG_FILE 只被 windows/node-source/main.mjs 读取。
  //    注意要跑在去注释文本上：注释里正好在解释「为什么不设它」。
  assert.doesNotMatch(workflow, /CXPLUS_NO_LOG_FILE/u,
    'CXPLUS_NO_LOG_FILE 只被 Node 宿主读取，本作业不跑宿主，设了就是死变量');
});

test('每个跑测试的作业都要把 TAP 传成 artifact', async () => {
  // 历史缺陷：TAP 只写进 runner 临时目录，作业结束即销毁，
  // 失败时最需要 TAP 却拿不到。逐个作业核对「写了哪个 tap」==「传了哪个 tap」。
  const workflow = withoutComments(await read('.github/workflows/ci.yml'));

  const writePaths = [...workflow.matchAll(/Join-Path \$env:RUNNER_TEMP '([^']+\.tap)'/gu)].map((m) => m[1]);
  const uploadPaths = [...workflow.matchAll(/path: \$\{\{ runner\.temp \}\}\/([^\s]+\.tap)/gu)].map((m) => m[1]);
  const artifactNames = [...workflow.matchAll(/^\s+name: ([\w-]+-tap)\s*$/gmu)].map((m) => m[1]);

  assert.ok(writePaths.length > 0, '必须能找到 TAP 写入路径');
  // 每个写出的 TAP 都必须被上传，否则该作业的日志等于丢弃。
  for (const tap of new Set(writePaths)) {
    assert.ok(uploadPaths.includes(tap), `TAP ${tap} 被写出但没有上传`);
  }
  // artifact 名不得重复：同名 artifact 会引起覆盖/上传冲突。
  assert.equal(new Set(artifactNames).size, artifactNames.length,
    `artifact 名重复: ${artifactNames.join(', ')}`);
});

// 2026-11-10：原先独立的 probe-kvm-daily.yml 已并入 ci-vm.yml（用户要求合并成单一
// 虚拟机验证入口），因此这两条断言对象改为 ci-vm.yml 里的 kvm-probe 作业段。
// 语义不变：巡检仍是「轻量、只读、不进 PR 门禁」的那条链路。
async function kvmProbeSection() {
  const raw = withoutComments(await read('.github/workflows/ci-vm.yml'));
  const lines = raw.split('\n');
  const start = lines.findIndex((line) => /^\s{2}kvm-probe:\s*$/u.test(line));
  assert.notEqual(start, -1, 'ci-vm.yml 必须包含 kvm-probe 作业');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{2}[a-z][a-z0-9-]*:\s*$/u.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

test('KVM 巡检段：轻量只读，不进 PR 门禁', async () => {
  const workflow = withoutComments(await read('.github/workflows/ci-vm.yml'));
  const job = await kvmProbeSection();

  // 绝不参与 PR 检查 —— 任何时候都不会把 PR 判红。
  assert.doesNotMatch(workflow, /pull_request_target/u, '不得挂 pull_request_target');
  assert.doesNotMatch(workflow, /^\s{2}pull_request:/mu, '不得挂 pull_request 触发');
  // 触发只有手动 + CI 调用；已移除 schedule（用户 2026-11-10 定）。
  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/mu, '必须保留手动触发');
  assert.match(workflow, /^\s{2}workflow_call:\s*$/mu, '必须允许 CI 调用');
  assert.doesNotMatch(workflow, /^\s{2}schedule:\s*$/mu, '不得再有 schedule');

  // 成本红线：巡检作业本身超时不得超过 5 分钟。
  const timeouts = [...job.matchAll(/timeout-minutes:\s*(\d+)/gu)].map((m) => Number(m[1]));
  assert.ok(timeouts.length > 0, 'kvm-probe 必须显式声明 timeout-minutes');
  for (const value of timeouts) {
    assert.ok(value <= 5, `kvm-probe 超时 ${value} 分钟超过红线 5 分钟`);
  }

  // 目标必须是实测过的托管 ubuntu-24.04。
  assert.match(job, /runs-on: ubuntu-24\.04/u, '巡检目标必须是实测过的 ubuntu-24.04');
});

test('KVM 巡检段不得真装机、下载镜像或改设备权限', async () => {
  const job = await kvmProbeSection();
  // 实测冷启动到 Windows Setup 已 9.7 分钟，装机路径绝不能进巡检。
  assert.doesNotMatch(job, /qemu-system|qemu-img|virt-install/u, '巡检段不得启动虚拟机');
  assert.doesNotMatch(job, /apt-get\s+install|apt\s+install|apt-cache\s+policy/u, '巡检段不得安装软件包');
  assert.doesNotMatch(job, /https?:\/\/\S*\.iso|curl\s[^\n]*\.iso|wget\s[^\n]*\.iso/u, '巡检段不得下载镜像');
  assert.doesNotMatch(job, /chmod\s+[0-7]+\s+\/dev\/kvm/u, '巡检段不得修改 /dev/kvm 权限');
  assert.doesNotMatch(job, /usermod|gpasswd\s+-a/u, '巡检段不得改组成员关系');
  // 必须把结论打出来。
  assert.match(job, /KVM_ACCESSIBLE=/u, '必须输出 KVM_ACCESSIBLE 结论');
  assert.match(job, /GITHUB_STEP_SUMMARY/u, '必须写入 Step Summary');
});

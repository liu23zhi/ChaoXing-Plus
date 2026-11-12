import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

// ============================================================================
// 2026-11-10：ci-vm.yml 已**整体并入 ci.yml**（用户要求「把 ci-vm.yml 合并到
// ci.yml，完整 ci 添加上完整的关机自毁测试」），ci-vm.yml 已从仓库删除。
// 因此本文件的断言对象统一改成 .github/workflows/ci.yml，并**必须按作业段断言**：
// 合并后一个文件里有 15 个 job，整文件断言会把「别的 job 的行为」误算成本作业的。
// ============================================================================

const WORKFLOW = '.github/workflows/ci.yml';

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

// 从去注释文本里切出某个 job 的段落。
// ci.yml 的 job 名固定 2 空格缩进，job 内的键至少 4 空格，所以「下一个 2 空格
// 缩进的 key」就是段落边界。这条规则在合并后的 ci.yml 上仍成立（实测每个 job
// 都能切到合理长度，见 CI 日志里的段长打印）。
function jobSection(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^ {2}${name}:\\s*$`, 'u').test(line));
  assert.notEqual(start, -1, `ci.yml 必须包含 ${name} 作业`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[a-z][a-z0-9-]*:\s*$/u.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// 这一组断言锁的是 2026-11-09 的实测结论（run 42588732951 / 42590175761），
// 让「托管 runner 不支持嵌套虚拟化」这个已被推翻的说法不会悄悄回到注释里，
// 也让每日巡检作业的成本上限（5 分钟、不装机）不会被人手改回去。
// 数据出处：task_doc/06-CI升级与虚拟机测试.md §4.2 / §5.5，
// 索引：task_doc/00-总览与任务索引.md §8「PLUS KVM 探测结论」、§9 第 12 条。

test('ci.yml 提到旧断言时必须同处标注它已被推翻', async () => {
  const workflow = await read(WORKFLOW);
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

test('ci.yml 必须写清「不再用 self-hosted」的演进与残余缺口', async () => {
  const workflow = await read(WORKFLOW);
  // 2026-11-11 用户要求「重写整个关机自毁检查，使用虚拟机，绕过该问题，不使用 self-hosted」：
  // 原来那条跑在 [self-hosted, windows, cx-vm] 的作业已整条删除（本仓库 runners
  // total_count = 0，它永远排队到超时被取消，既没验证任何东西又让 CI 长期不可用）。
  //
  // 本测试锁的是「删除之后，说明与补偿都还在」：
  //   ① 头部必须写清演进（为什么删、删了什么、缺口是什么）
  //   ② 必须保留 Linux 客机真实重启这条替代
  //   ③ 必须保留 wiring-probe 的两阶段语义验证
  assert.match(workflow, /关机自毁验证的演进/u, '头部必须有演进说明');
  assert.match(workflow, /total_count\s*=\s*0/u, '必须写明该作业删除的原因（0 runner）');
  assert.match(workflow, /缺口/u, '必须如实记录残余缺口');
  assert.match(workflow, /PendingFileRenameOperations/u, '必须点名只有 Windows 客机能验证的那一项');
  assert.match(workflow, /qemu-destruct-linux-guest/u, '必须有 Linux 客机真实重启这条替代');
  assert.match(workflow, /^ {2}wiring-probe:$/mu, '必须保留 wiring-probe 两阶段语义验证');
});

test('ci.yml 的 runner 标签与必要检查名保持不变', async () => {
  // 这三条锚的是**跨作业的固定字符串**（标签、job 名、变量名），不是某一段的行为，
  // 所以继续整文件断言；它们各自唯一，不会与别的 job 混淆。
  const workflow = await read(WORKFLOW);
  // 2026-11-11 用户要求「不用 self-hosted」：该作业已整条删除。
  assert.doesNotMatch(workflow, /runs-on: \[self-hosted/u, '不得再出现 self-hosted runner 标签');
  // 该作业已删除，其 job 名不应再出现（否则读者会以为它还在）。
  assert.doesNotMatch(workflow, /name: 关机自毁与开机续删（虚拟机）/u, '已删除的作业名不得残留');
  // 2026-11-11 用户三次要求「不要跳过任务」：CX_VM_ENABLED 变量门已取消，
  // 否则该作业在从未配置该变量时永远 skip（且历史上还因此假绿）。
  assert.doesNotMatch(workflow, /vars\.CX_VM_ENABLED/u, '变量门已取消（用户要求不跳过）');
  // 托管 runner 上的语义验证作业必须保留，否则「RunOnce 命令串是否可执行」
  // 会退回到「从未验证」。
  assert.match(workflow, /^ {2}wiring-probe:$/mu, 'wiring-probe 作业必须保留');
  // 2026-11-12：job name 改为更准确的中文：「自毁登记与续删语义验证（不真实关机）」
  assert.match(workflow, /name: 自毁登记与续删语义验证（不真实关机）/u, '作业名需说明它验证的是语义而非接线');
});

test('wiring-probe 必须真跑两阶段语义验证，不能只验证接线', async () => {
  const workflow = withoutComments(await read(WORKFLOW));
  const job = jobSection(workflow, 'wiring-probe');

  // 1) 触发：push / pull_request / workflow_dispatch 三档都跑。
  //    2026-11-10 合并时用户要求「完整 ci 添加上完整的关机自毁测试」，本作业
  //    是唯一能在托管 runner 上跑完整两阶段的作业，因此不再限定手动触发。
  assert.match(job, /^\s+if:/mu, 'wiring-probe 必须显式声明 if');
  // 2026-11-11: if 不再按 event 分支。continue-on-error 仍可引用 event_name
  // （那是「PR 上放行失败」，不是跳过作业，与「不跳过任务」不冲突）。
  const ifLine = job.split('\n').find((l) => /^\s+if:/.test(l)) || '';
  assert.doesNotMatch(ifLine, /github\.event_name/u, 'wiring-probe 的 if 不得再按 event_name 限制');
  assert.match(ifLine, /needs\.gate\.result/u, 'wiring-probe 的 if 必须仍受 gate.result 约束');
  assert.doesNotMatch(ifLine, /pull_request/u, 'wiring-probe 的 if 不得再按 pull_request 分支');
  // 手动触发统一在 workflow 级（见下一条断言），作业 if 不再重复判定。
  assert.doesNotMatch(workflow, /^ {2}schedule:/mu, '不得挂 schedule');

  // 2) continue-on-error 只允许对 pull_request 一档放宽。
  //    无条件挂上会让它永远绿，等于没有门禁（缺陷 c/d 已由 PR #29 修掉）；
  //    而在 PR 上放宽是刻意的成本权衡：它受宿主环境影响，不该阻塞代码评审，
  //    主干合并后由 push 那一档严格复核。所以这里允许出现，但必须是
  //    「只对 pull_request 成立」的条件表达式，不能是裸 true。
  for (const line of job.split('\n').filter((l) => /continue-on-error/u.test(l))) {
    assert.doesNotMatch(line, /continue-on-error:\s*true\s*$/u,
      `continue-on-error 不得无条件为 true（会让门禁永远是绿的）：${line.trim()}`);
    assert.match(line, /pull_request/u,
      `continue-on-error 只允许对 pull_request 一档放宽：${line.trim()}`);
  }

  // 3) 两阶段都必须真跑，且顺序固定：先登记再重放。
  const shutdownIndex = job.indexOf('-Stage shutdown -NoShutdown');
  const replayIndex = job.indexOf('-Stage resume -ReplayRunOnce');
  assert.ok(shutdownIndex > 0, '必须跑 shutdown -NoShutdown 阶段');
  assert.ok(replayIndex > 0, '必须跑 resume -ReplayRunOnce 阶段（这是盖住「续删真的执行」的那一半）');
  assert.ok(shutdownIndex < replayIndex, '必须先登记再重放：resume 断言的正是重放之后的状态');

  // 4) 覆盖边界必须写在注释里，不许留悬空断言。
  //    这段说明位于 wiring-probe 的 job 定义**上方**（注释块 + job 之间没有空行约束），
  //    因此只能在整文件原文上断言，不能切段。
  const raw = await read(WORKFLOW);
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
  const leftoverStep = job.slice(job.indexOf('断言运行后无残留'));
  assert.match(leftoverStep, /\$env:RUNNER_TEMP/u, '残留检查必须覆盖 RUNNER_TEMP');
  assert.match(leftoverStep, /IsNullOrWhiteSpace\(\$_\)|IsNullOrWhiteSpace\(\$env:TEMP\)/u,
    '临时根目录要过滤空值后取唯一值');

  // 7) 本作业不得设对它无效的环境变量：上一轮的 CX_NATIVE_BUILD_ALLOW_UNSIGNED
  //    就是这样来的（全仓只此一处，没人读它）。本作业不跑任何宿主，
  //    CXPLUS_NO_LOG_FILE 只被 windows/node-source/main.mjs 读取。
  //    ⚠️ 必须只在本作业段上断言：合并后 ci.yml 的 windows-unit / windows-pause /
  //    windows-window / windows-browser 四段**合法地**设了它，整文件断言会误报。
  assert.doesNotMatch(job, /CXPLUS_NO_LOG_FILE/u,
    'CXPLUS_NO_LOG_FILE 只被 Node 宿主读取，本作业不跑宿主，设了就是死变量');
});

test('每个跑测试的作业都要把 TAP 传成 artifact', async () => {
  // 历史缺陷：TAP 只写进 runner 临时目录，作业结束即销毁，
  // 失败时最需要 TAP 却拿不到。逐个作业核对「写了哪个 tap」==「传了哪个 tap」。
  const workflow = withoutComments(await read(WORKFLOW));

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

// 2026-11-10：原先独立的 probe-kvm-daily.yml 已并入 ci-vm.yml，后者又整体并入 ci.yml。
// 因此断言对象是 ci.yml 里的 kvm-probe 作业段，语义不变：
// 巡检仍是「轻量、只读、不进 PR 门禁」的那条链路。
async function kvmProbeSection() {
  const raw = withoutComments(await read(WORKFLOW));
  return jobSection(raw, 'kvm-probe');
}

test('KVM 巡检段：轻量只读，不进 PR 门禁', async () => {
  const workflow = withoutComments(await read(WORKFLOW));
  const job = await kvmProbeSection();

  // 合并前这里断言「整个文件不挂 pull_request」，合并后 ci.yml 顶层自带
  // pull_request（日常构建必须跑），整文件断言语义已不成立。
  // 原意是「巡检不会因为在 PR 里跑而把 PR 判红」，因此改为两条更精确的断言：
  //   ① 巡检段的 if 不按事件类型分支（只受日判重闸控制，不是 pass/fail 闸门）
  //   ② 它自己写明失败不阻塞 PR
  assert.doesNotMatch(job, /pull_request/u, 'KVM 巡检的 if 不得按 pull_request 单独判定');
  assert.match(job, /if: needs\.gate\.result == 'success'/u, 'KVM 巡检只受 gate.result 约束（判重已取消）');
  const kvmIf = job.split('\n').find((l) => /^\s+if:/.test(l)) || '';
  assert.doesNotMatch(kvmIf, /needs\.gate\.outputs\.(skip|sha_verified)/u,
    'KVM 巡检的 if 不得再读任何判重输出（outputs 段透传展示不算闸门）');
  assert.match(job, /红叉不影响任何 PR 的必需检查/u, '必须写明巡检失败不阻塞 PR');
  assert.doesNotMatch(workflow, /pull_request_target/u, '不得挂 pull_request_target');

  // 触发统一在 workflow 级。ci.yml 现在是**唯一入口**，不再是 callee，
  // 所以不得再声明 workflow_call（声明了也不会有人调它，且会让人误以为是可复用件）。
  assert.match(workflow, /^ {2}workflow_dispatch:\s*$/mu, '必须保留手动触发');
  assert.doesNotMatch(workflow, /^ {2}workflow_call:\s*$/mu,
    'ci.yml 已是唯一入口，不得再声明 workflow_call');
  assert.doesNotMatch(workflow, /^ {2}schedule:\s*$/mu, '不得再有 schedule');

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

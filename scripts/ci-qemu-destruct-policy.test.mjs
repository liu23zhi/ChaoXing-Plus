import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

// ============================================================================
// 2026-11-10：QEMU 自毁作业所在的 ci-vm.yml 已**整体并入 ci.yml**
// （用户要求「把 ci-vm.yml 合并到 ci.yml，完整 ci 添加上完整的关机自毁测试」），
// ci-vm.yml 已从仓库删除。因此断言对象统一改为 .github/workflows/ci.yml，
// 并按作业段（qemuJobSection）切出来断言 —— 合并后一个文件里 15 个 job，
// 整文件断言会把别的 job 的行为误算成本作业的。
// ============================================================================

const WORKFLOW = '.github/workflows/ci.yml';

async function read(relative) {
  return readFile(path.join(root, relative), 'utf8');
}

// 与 ci-vm-runner-policy.test.mjs 同一套做法：把 YAML 注释行去掉，只留真正会被
// 执行的内容。负向断言必须跑在这份文本上 —— 注释里出现「pull_request」「.iso」
// 这类字样是解释历史与拒绝理由，不是行为。
function withoutComments(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n');
}

// PowerShell 侧同理：去掉 <# ... #> 块注释与 # 行注释，只留会执行的语句。
// 负向断言（例如「不得引用不存在的 -ReplayRunOnce」）必须跑在这份文本上，
// 否则解释性的注释会被当成真实调用。
function withoutPsComments(text) {
  return text
    .replace(/<#[\s\S]*?#>/gu, '')
    .split(/\r?\n/u)
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n');
}

// 从去注释文本里切出某个 job 的段落：ci.yml 的 job 名固定 2 空格缩进，
// job 内的键至少 4 空格，所以「下一个 2 空格缩进的 key」就是段落边界。
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

// 这一组断言锁的是「托管 Ubuntu + QEMU + KVM 的自毁验证作业」的形态约束：
//   · 它不参与 PR，只在 push 到 main 与手动触发时尝试 —— 单次成本上限 45 分钟；
//   · KVM 拿不到要 skip 而不是 fail —— 那是 runner 能力问题，不是仓库代码问题；
//   · 不许下载 Windows ISO —— 体积（5.6 GiB 级）、许可与冷启动时间都不合适；
//   · 两阶段语义必须与 shutdown 作业一致，且不得引用不存在的 -ReplayRunOnce。
//
// 已知：本作业自 2026-11-10 落地以来**尚未在真实 Actions 上运行过**（本地没有
// QEMU / KVM / 客机镜像）。策略测试只能证明「文件形态正确」，不能证明「作业能跑通」。
// 第一次真跑之后请把 run id 补在这段注释里。

async function qemuJobSection() {
  const raw = withoutComments(await read(WORKFLOW));
  return jobSection(raw, 'qemu-shutdown-destruct');
}

test('QEMU 自毁作业已取消 event 限制（PR 上也跑）', async () => {
  const workflow = withoutComments(await read(WORKFLOW));
  const job = await qemuJobSection();

  // 2026-11-11 用户明确要求「不要跳过任务」：作业 if 不再按 event_name 分支。
  // 历史：原写法限定 push/workflow_dispatch，PR 上整条 45 分钟链路被 skip；
  // 后来发现「跳过却 success」是假绿（t96），最终改成 job 级只判 gate.result。
  assert.doesNotMatch(job, /github\.event_name/u,
    'QEMU 作业不得再按 event_name 限制（PR 上也要跑）');
  assert.match(job, /needs\.gate\.result/u, 'QEMU 作业必须仍受 gate.result 约束');
  assert.doesNotMatch(workflow, /pull_request_target/u, '不得挂 pull_request_target');
  assert.match(workflow, /^ {2}workflow_dispatch:\s*$/mu, '必须保留手动触发');
  // ci.yml 现在是唯一入口，不再是 callee，不得再声明 workflow_call。
  assert.doesNotMatch(workflow, /^ {2}workflow_call:\s*$/mu, 'ci.yml 已是唯一入口，不得再声明 workflow_call');
  assert.doesNotMatch(workflow, /^ {2}schedule:\s*$/mu, '不得再有 schedule（已改 push + 手动）');
  assert.doesNotMatch(workflow, /cron:/u, '不得残留任何 cron 表达式');
});

test('ci.yml#qemu-shutdown-destruct 必须跑在托管 ubuntu-24.04 上，不得退回 self-hosted', async () => {
  // ⚠️ 这条必须只对 qemu 段断言。合并前它读整个 ci-vm.yml，而那时文件里也有
  // `runs-on: [self-hosted, windows, cx-vm]`（vm-shutdown-destruct），能过只是
  // 因为正则 /runs-on:.*self-hosted/ 的行内匹配恰好没命中那段（`[self-hosted`
  // 前面还有别的字符，但 `.` 不跨行，且当时那段的行文与现在不同）。
  // 合并后 ci.yml 里 self-hosted 段落明确存在，整文件断言必然误报。
  const job = await qemuJobSection();
  assert.match(job, /runs-on: ubuntu-24\.04/u, '目标必须是实测过的托管 ubuntu-24.04');
  assert.doesNotMatch(job, /runs-on:.*self-hosted/u, '不得依赖自托管 runner（那正是 QEMU 这条路的约束）');
  // contents: read 在 workflow 级 permissions，不在 job 段内 —— 单独断言。
  assert.match(withoutComments(await read(WORKFLOW)), /^ {2}contents: read$/mu, '权限只能是只读');
});

test('ci.yml#qemu-shutdown-destruct 每个作业都必须有 timeout-minutes 且不超过 45 分钟', async () => {
  const workflow = await qemuJobSection();

  const jobNames = [...workflow.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gmu)].map((match) => match[1]);
  assert.ok(jobNames.length > 0, '必须至少有一个作业');

  const timeouts = [...workflow.matchAll(/timeout-minutes:\s*(\d+)/gu)].map((match) => Number(match[1]));
  assert.ok(timeouts.length > 0, '必须显式声明 timeout-minutes（否则挂住的 QEMU 会占满 6 小时上限）');
  for (const value of timeouts) {
    assert.ok(value > 0 && value <= 45, `单作业超时 ${value} 分钟超出红线 45 分钟`);
  }
});

test('ci.yml#qemu-shutdown-destruct 必须自己提权 /dev/kvm 并在提权后复核', async () => {
  const workflow = await qemuJobSection();

  // 事实来源：2026-11-09 实测 run 42588732951 / 42590175761 ——
  // 设备在、作业用户不在 kvm 组、免密 sudo 可用、chmod 666 实测 8 ms 生效。
  assert.match(workflow, /\/dev\/kvm/u, '必须探测 /dev/kvm');
  assert.match(workflow, /sudo chmod 666 \/dev\/kvm/u, '必须用实测有效的 sudo chmod 666 提权');
  assert.match(workflow, /sudo -n true/u, '必须先断言免密 sudo 可用再动手');

  // 提权后必须**重新**断言，不能沿用提权前的结论。
  assert.match(workflow, /kvm_accessible_before/u, '必须记录提权前的可读写状态');
  assert.match(workflow, /kvm_ok=yes|out kvm_ok/u, '必须输出提权后的权威结论');
  assert.match(workflow, /KVM_ACCESSIBLE=yes/u, '必须打印 KVM_ACCESSIBLE 结论');
});

test('ci.yml#qemu-shutdown-destruct 拿不到 KVM 时必须走 skip 而不是 fail', async () => {
  const workflow = await qemuJobSection();

  // skip 的实现方式：KVM 步骤把结论写成 output，后续重活以它为门。
  assert.match(
    workflow,
    /if:\s*steps\.kvm\.outputs\.kvm_ok\s*==\s*'yes'/u,
    '后续步骤必须以 kvm_ok 为门（拿不到 KVM 就跳过，不能整作业判红）',
  );
  assert.match(workflow, /::notice title=[^\n]*KVM[^\n]*跳过/u, '跳过时必须发 notice 说明原因');
  assert.match(workflow, /kvm_reason/u, '必须输出跳过原因供 Step Summary 使用');

  // KVM 步骤本身不得用 exit 1 结束（能力缺失不是代码缺陷）。
  const kvmStep = workflow.split(/- name: KVM 授权与可用性断言/u)[1]?.split(/- name: /u)[0] ?? '';
  assert.ok(kvmStep.length > 0, '找不到 KVM 探测步骤');
  assert.doesNotMatch(kvmStep, /exit 1/u, 'KVM 探测步骤不得以 exit 1 结束');
});

test('ci.yml#qemu-shutdown-destruct 的客机镜像只走占位变量，且不得下载 Windows ISO', async () => {
  const workflow = await qemuJobSection();

  // 镜像来源：手动输入优先，其次 repo variable；两者都空 → skip。
  assert.match(workflow, /CX_QEMU_GUEST_IMAGE/u, '必须用 CX_QEMU_GUEST_IMAGE 作为镜像占位变量');
  assert.match(workflow, /vars\.CX_QEMU_GUEST_IMAGE/u, '必须支持仓库变量');
  // ci.yml 是普通 workflow：push 事件下 inputs.* 上下文为 null，
  // 因此必须写 github.event.inputs.*（写成裸 inputs.* 会在非手动触发下取到空值）。
  assert.match(workflow, /github\.event\.inputs\.guest_image/u,
    '必须支持手动触发时覆盖（用 github.event.inputs.guest_image，push 下 inputs.* 为 null）');
  assert.doesNotMatch(workflow, /[^.]inputs\.guest_image/u,
    '不得残留裸 inputs.* 写法（push 事件下为 null）');
  assert.match(workflow, /未配置客机镜像/u, '镜像未配置时必须 skip 并说明');
  assert.match(workflow, /if:\s*steps\.image\.outputs\.image_ok\s*==\s*'yes'/u, '客机步骤必须以 image_ok 为门');

  // 拒绝 ISO 装机路径：任何提到 .iso 的行都必须同时是「拒绝」，且不存在下载它的命令。
  const isoLines = workflow
    .split(/\r?\n/u)
    .map((line, index) => ({ line, index: index + 1 }))
    .filter((entry) => /\.iso/iu.test(entry.line));
  for (const entry of isoLines) {
    assert.match(
      entry.line,
      /skip|拒绝|不合适/u,
      `qemu 段第 ${entry.index} 行提到 .iso 但不是拒绝语句：${entry.line.trim()}`,
    );
  }
  assert.doesNotMatch(workflow, /https?:\/\/\S*\.iso/iu, '不得出现 ISO 下载地址');
  assert.doesNotMatch(workflow, /(curl|wget)[^\n]*\.iso/iu, '不得下载 ISO');
  // 也不能偷偷用装机工装（virt-install / autounattend / windows-server 镜像名）。
  assert.doesNotMatch(workflow, /virt-install|autounattend|windows-server/iu, '不得引入装机路径');

  // 母镜像只读 + 覆盖层：母镜像必须不被写入，写入全落覆盖层。
  // 断言锚到行首（缩进后直接是命令）：否则 `echo qemu-img create ...` 这类
  // 「注释掉实际执行」的改法仍会命中子串，测不出覆盖层被删。
  assert.match(
    workflow,
    /^\s+qemu-img create -f qcow2 -b /mu,
    '必须用 qcow2 覆盖层保证母镜像不被写入（断言锚到行首，注释掉会变红）',
  );
  // 覆盖层必须真的被 -drive 引用，否则建了也没用，客机仍在写母镜像。
  assert.match(
    workflow,
    /-drive file="\$RUNNER_TEMP\/guest-overlay\.qcow2"/u,
    'QEMU 必须从覆盖层启动（-drive 指向 guest-overlay.qcow2）',
  );
  // 母镜像只读：不得以 rw 方式直接挂母镜像。
  assert.doesNotMatch(workflow, /-drive file="\$RUNNER_TEMP\/guest-base\.qcow2"/u, '不得直接以读写方式挂母镜像');
});

test('ci.yml#qemu-shutdown-destruct 不得加 -no-reboot / -no-shutdown（会让重启后客机永远不再上电）', async () => {
  const workflow = await qemuJobSection();
  // 这条不是风格问题：QEMU 加 -no-reboot 时，客机一重启进程就退出，
  // 「登记 → 重启 → 重放」会断在第二步，而 Step Summary 会误报成「重启后未回连」。
  assert.doesNotMatch(workflow, /(?:^|\s)-no-reboot\b/mu, '不得给 qemu 加 -no-reboot');
  assert.doesNotMatch(workflow, /(?:^|\s)-no-shutdown\b/mu, '不得给 qemu 加 -no-shutdown');
  // QEMU 必须显式启用 KVM：没有它冷启动远超 45 分钟上限。
  assert.match(workflow, /-enable-kvm/u, 'QEMU 必须显式 -enable-kvm');
});

test('ci.yml#qemu-shutdown-destruct 的两阶段语义与 shutdown 作业一致，且不引用不存在的开关', async () => {
  const workflow = await qemuJobSection();

  // 工作流本身只负责「调客机驱动脚本」+「由宿主发起重启」。
  // 两阶段语义在客机驱动脚本里，由下面那一段单独钉住。
  // 注意：这里必须断言**真实调用现场**（`-File ... -Phase register`），不能只断言
  // 文件里出现过 `-Stage shutdown` —— 那种字样在 Step Summary 的说明表格里也有，
  // 改坏调用链照样绿，是典型假钉子。
  // 路径统一用正斜杠 C:/cx/...（PoweShell 在 Windows 上接受）：
  // 这些命令包在 bash 单引号/双引号里，反斜杠要么被 bash 吃掉要么需要双写，
  // 而双写在 PowerShell 里不是转义（转义符是反引号），会在客机上造出畸形路径。
  const guestDriver = String.raw`C:[/\\]cx[/\\]scripts[/\\]vm[/\\]qemu-guest-destruct\.ps1`;
  assert.match(
    workflow,
    new RegExp(`${guestDriver} -Phase register`, 'u'),
    '工作流必须真实调用客机驱动的 register 阶段',
  );
  assert.match(
    workflow,
    new RegExp(`${guestDriver} -Phase replay`, 'u'),
    '工作流必须真实调用客机驱动的 replay 阶段',
  );
  // 重启由宿主经命令通道发起，不是脚本参数。
  assert.match(workflow, /shutdown \/r \/f \/t 5/u, '客机重启必须由宿主经命令通道发起');
  // run-shutdown-destruct.ps1 全文没有 -ReplayRunOnce 的这条路（那是 wiring-probe 的），
  // 在 QEMU 客机链路里引用它等于引用不存在的接口。
  assert.doesNotMatch(workflow, /-ReplayRunOnce/u, 'QEMU 客机链路不得引用 -ReplayRunOnce 参数');
  // 重启必须发生在 register 之后、replay 之前：顺序写反则断言针对的是上一次启动。
  const registerAt = workflow.indexOf('-Phase register');
  const rebootAt = workflow.indexOf('shutdown /r /f /t 5');
  const replayAt = workflow.indexOf('-Phase replay');
  assert.ok(registerAt > 0 && rebootAt > 0 && replayAt > 0, '三个阶段/步骤必须都存在');
  assert.ok(
    registerAt < rebootAt && rebootAt < replayAt,
    `顺序必须是 登记 → 重启 → 重放，实际索引 register=${registerAt} reboot=${rebootAt} replay=${replayAt}`,
  );

  // 客机内的驱动脚本必须真的委托给既有两阶段脚本，不能自己重写一套断言。
  // 断言要钉住**调用现场**而不是任意出现的字样：`/-Stage resume/` 会匹配
  // `-Stage resumeXXX`（前缀命中），改坏实现也照样绿 —— 这类假钉子必须避免。
  const guest = withoutPsComments(await read('scripts/vm/qemu-guest-destruct.ps1'));
  assert.match(guest, /run-shutdown-destruct\.ps1/u, '客机驱动脚本必须复用 run-shutdown-destruct.ps1');
  assert.match(
    guest,
    /&\s*\$vmScript\s+-Stage\s+shutdown\s+-NoShutdown/u,
    '客机驱动脚本必须真的执行 `& $vmScript -Stage shutdown -NoShutdown`（登记阶段）',
  );
  assert.match(
    guest,
    /&\s*\$vmScript\s+-Stage\s+resume(?![A-Za-z])/u,
    '客机驱动脚本必须真的执行 `& $vmScript -Stage resume`（重放阶段）',
  );
  // 委托是「执行」，不是「提及」：两个阶段都要有调用点，不能只有一个。
  const callSites = [...guest.matchAll(/&\s*\$vmScript\s+-Stage\s+(shutdown|resume)/gu)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(callSites)].sort(),
    ['resume', 'shutdown'],
    `两个阶段都必须有真实调用点，实际找到：${callSites.join(',') || '（无）'}`,
  );
  assert.doesNotMatch(
    guest,
    /-ReplayRunOnce/u,
    '客机驱动脚本不得引用不存在的 -ReplayRunOnce 参数',
  );
  // 两阶段的待删目标必须是同一个固定路径，否则「文件不存在」的断言会假通过。
  assert.match(guest, /shutdown-target\.txt/u, '两阶段必须共用固定的待删目标名');
});

test('ci.yml#qemu-shutdown-destruct 的 Step Summary 必须写清四项：KVM、镜像、跳过原因、执行到哪一步', async () => {
  const workflow = await qemuJobSection();

  assert.match(workflow, /GITHUB_STEP_SUMMARY/u, '必须写入 Step Summary');
  assert.match(workflow, /KVM 可用（提权后复核）/u, '摘要必须写明 KVM 是否可用');
  assert.match(workflow, /客机镜像已配置/u, '摘要必须写明客机镜像是否配置');
  assert.match(workflow, /跳过不等于验证通过/u, '摘要必须明确「跳过 ≠ 通过」');
  assert.match(workflow, /实际执行到了哪一步/u, '摘要必须写明实际执行到了哪一步');
  // 跳过要有明确停在哪一段，而不是一句笼统的 skipped。
  assert.match(workflow, /停在：/u, '摘要必须写明停在哪一段');
});

test('ci.yml#qemu-shutdown-destruct 必须显式证明 Linux pwsh 不能跑两阶段', async () => {
  const workflow = await qemuJobSection();

  // run-shutdown-destruct.ps1 依赖 HKCU:\...\RunOnce；Linux pwsh 没有 Registry provider。
  // 工作流必须探测这一点，否则读者会以为「两阶段本来就能在宿主跑」。
  assert.match(workflow, /Get-PSDrive -Name HKCU/u, '必须探测 Linux pwsh 是否有 HKCU 驱动器');
  assert.match(workflow, /PWSH_HKCU_PROVIDER=/u, '必须打印探测结论');
  // 用 PowerShell 解析器做语法校验（执行会失败，解析不会）。
  assert.match(workflow, /\[System\.Management\.Automation\.Language\.Parser\]::ParseFile/u, '必须用解析器校验脚本语法');
  // 三个脚本都要被校验，包括本任务新增的客机驱动脚本。
  assert.match(workflow, /scripts\/vm\/qemu-guest-destruct\.ps1/u, '新增的客机驱动脚本必须纳入接线检查');
});

test('ci.yml#qemu-shutdown-destruct 的 teardown 断言必须真的能判红，不得被 || true 吞掉', async () => {
  const workflow = await qemuJobSection();

  // 这条作业存在的意义就是「抓自毁没清干净」。把 teardown 断言写成
  // `assert-clean.ps1 -Stage teardown || true` 会让它永远绿 —— 典型假钉子。
  assert.match(workflow, /assert-clean\.ps1 -Stage teardown/u, '必须有 teardown 自毁断言');
  assert.doesNotMatch(
    workflow,
    /assert-clean\.ps1 -Stage teardown'?\s*\|\|\s*true/u,
    'teardown 断言不得用 || true 吞掉失败',
  );
  // 必须真的把退出码拿出来判红，而不是只看最后一条命令的状态。
  assert.match(workflow, /TEARDOWN_ASSERT_EXIT_CODE/u, '必须记录 teardown 断言的退出码');
  assert.match(workflow, /REPLAY_EXIT_CODE/u, '必须记录重放阶段的退出码');
  // 客机镜像已配置但两阶段没走完时，摘要不得给出「结论/通过」。
  assert.match(workflow, /未完成（不是通过）/u, '两阶段未走完时摘要必须明确「不是通过」');
});

test('ci.yml#qemu-shutdown-destruct 的 purge 产物路径必须穿过 SSH 边界显式传参', async () => {
  const workflow = await qemuJobSection();
  const guest = withoutPsComments(await read('scripts/vm/qemu-guest-destruct.ps1'));

  // workflow 里的 `env:` 设的是宿主（Ubuntu）进程的环境变量，**不会**穿过 SSH
  // 进入客机。之前那种「在 workflow 里写 CX_NATIVE_PURGE_EXE 就以为客机读得到」
  // 的做法会让客机侧永远读到空值 → 两阶段必然假失败。
  assert.match(workflow, /-PurgeExe/u, '工作流必须把 purge 产物路径作为参数传进客机脚本');
  // ⚠️ 这条负向断言必须只对 qemu 段生效：合并后 ci.yml 的 vm-shutdown-destruct 与
  // wiring-probe 两段**合法地**用 env: 给本机进程设 CX_NATIVE_PURGE_EXE
  // （那边不跨 SSH，是正确的），整文件断言会误报。
  assert.doesNotMatch(
    workflow,
    /^\s+CX_NATIVE_PURGE_EXE:/mu,
    '不得在 qemu 作业里用 env: 假装给客机设 purge 产物路径（env 不跨 SSH）',
  );
  // 客机脚本必须接收这个参数，并把它提升成 run-shutdown-destruct.ps1 认的变量名。
  assert.match(guest, /\[string\]\$PurgeExe/u, '客机脚本必须接收 -PurgeExe');
  assert.match(guest, /\$env:CX_NATIVE_PURGE_EXE\s*=\s*\$PurgeExe/u, '客机脚本必须把参数提升成 CX_NATIVE_PURGE_EXE');
  // 两阶段的 RUNNER_TEMP 必须钉死成同一个根，否则 workRoot 会漂移。
  assert.match(guest, /\$env:RUNNER_TEMP\s*=\s*\$tempRoot/u, '客机脚本必须钉死 RUNNER_TEMP');
});

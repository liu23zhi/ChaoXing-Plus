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
  assert.match(workflow, /name: 接线就绪度探针（不关机，托管 runner）/u, '既有作业名不得改动');
  assert.match(workflow, /vars\.CX_VM_ENABLED == 'true'/u, '三重保护不变');
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

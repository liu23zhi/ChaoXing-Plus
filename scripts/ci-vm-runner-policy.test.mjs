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
  // 必须指向数据出处，不留悬空断言。
  assert.match(workflow, /06-CI升级与虚拟机测试\.md/u, '必须指向论证出处');
});

test('ci-vm.yml 的 runner 标签与必要检查名保持不变', async () => {
  const workflow = await read('.github/workflows/ci-vm.yml');
  assert.match(workflow, /runs-on: \[self-hosted, windows, cx-vm\]/u, 'self-hosted cx-vm 策略不变');
  assert.match(workflow, /name: 关机自毁与开机续删（虚拟机）/u, '既有 job 名不得改动');
  assert.match(workflow, /name: 接线就绪度探针（不关机，托管 runner）/u, '既有作业名不得改动');
  assert.match(workflow, /vars\.CX_VM_ENABLED == 'true'/u, '三重保护不变');
});

test('每日 KVM 巡检只由定时与手动触发，不进 PR 检查', async () => {
  const workflow = withoutComments(await read('.github/workflows/probe-kvm-daily.yml'));

  const crons = [...workflow.matchAll(/^\s*-\s*cron:\s*'([^']+)'\s*$/gmu)].map((match) => match[1]);
  assert.equal(crons.length, 1, `只允许一个 cron，实际 ${crons.length} 个`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = crons[0].split(/\s+/u);
  assert.match(minute, /^\d+$/u, 'cron 分钟位必须是数字');
  assert.match(hour, /^\d+$/u, 'cron 小时位必须是数字');
  assert.equal(dayOfMonth, '*', 'cron 必须是每日一次（日期不限）');
  assert.equal(month, '*', 'cron 必须是每日一次（月份不限）');
  assert.equal(dayOfWeek, '*', 'cron 必须是每日一次（星期不限）');

  // 成本红线：任何作业超时都不得超过 5 分钟。
  const timeouts = [...workflow.matchAll(/timeout-minutes:\s*(\d+)/gu)].map((match) => Number(match[1]));
  assert.ok(timeouts.length > 0, '必须显式声明 timeout-minutes');
  for (const value of timeouts) {
    assert.ok(value <= 5, `单作业超时 ${value} 分钟超过红线 5 分钟`);
  }

  // 不参与 PR 检查，任何时候都不会把 PR 判红。
  assert.doesNotMatch(workflow, /pull_request_target/u, '不得挂 pull_request_target');
  assert.doesNotMatch(workflow, /^\s*pull_request:/mu, '不得挂 pull_request 触发');
  assert.match(workflow, /^\s*schedule:/mu, '必须有 schedule 触发');
  assert.match(workflow, /^\s*workflow_dispatch:/mu, '必须保留手动触发');
  assert.match(workflow, /runs-on: ubuntu-24\.04/u, '巡检目标必须是实测过的 ubuntu-24.04');
  assert.match(workflow, /contents: read/u, '权限只能是只读');
});

test('每日 KVM 巡检不得真装机、下载镜像或改设备权限', async () => {
  const workflow = withoutComments(await read('.github/workflows/probe-kvm-daily.yml'));
  // 实测冷启动到 Windows Setup 已 9.7 分钟，装机路径绝不能进每日作业。
  assert.doesNotMatch(workflow, /qemu-system|qemu-img|virt-install/u, '不得启动虚拟机');
  assert.doesNotMatch(workflow, /apt-get\s+install|apt\s+install|apt-cache\s+policy/u, '不得安装软件包');
  assert.doesNotMatch(workflow, /https?:\/\/\S*\.iso|curl\s[^\n]*\.iso|wget\s[^\n]*\.iso/u, '不得下载镜像');
  assert.doesNotMatch(workflow, /chmod\s+[0-7]+\s+\/dev\/kvm/u, '巡检不得修改 /dev/kvm 权限');
  assert.doesNotMatch(workflow, /usermod|gpasswd\s+-a/u, '巡检不得改组成员关系');
  // 必须把结论打出来。
  assert.match(workflow, /KVM_ACCESSIBLE=/u, '必须输出 KVM_ACCESSIBLE 结论');
  assert.match(workflow, /GITHUB_STEP_SUMMARY/u, '必须写入 Step Summary');
});

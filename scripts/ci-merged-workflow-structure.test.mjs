import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

// 这一组断言锁的是 2026-11-10 的合并结果：原 .github/workflows/ci-vm.yml（5 个作业）
// 整体并入 .github/workflows/ci.yml，用户要求「完整 ci 添加上完整的关机自毁测试」。
//
// 为什么需要它：合并很容易「看起来合并了、实际上没接通」——
//   · 复用调用（uses: ./.github/workflows/ci-vm.yml）留着 → callee 没了，整条 workflow
//     直接 startup_failure，而 GitHub 不通过 API 暴露原因；
//   · 自毁作业只在 workflow_dispatch 上出现 → 回到「关机自毁从未在 CI 里跑过」的老状态；
//   · summary.needs 漏掉某个自毁作业 → 汇总表里那一行永远是「未执行」，看着像跳过；
//   · gate 判重继续按已删除的 ci-vm.yml 查 → 恒返回 0，判重静默失效；
//   · gate 不排除当前 run 自己 → 把自己的 run 数成「今天已跑过」。
// 上面每一条都是「静默失效」，CI 自己不会红，所以只能靠本文件判红。
//
// 断言一律跑在「去掉纯注释行」的文本上：注释里出现 ci-vm.yml / workflow_dispatch /
// schedule 是在解释历史与已知坑，不是行为。

const WORKFLOW = '.github/workflows/ci.yml';
const REMOVED_WORKFLOW = '.github/workflows/ci-vm.yml';

// 合并后的 15 个作业，顺序与文件中的实际顺序一致（顺序本身也是断言目标：
// 自毁三件套必须排在 gate/kvm-probe 之后、summary 之前）。
const EXPECTED_JOBS = [
  'source',
  'windows-build',
  'windows-real-client-discovery',
  'windows-unit',
  'windows-pause',
  'windows-window',
  'windows-browser',
  'windows-release',
  'windows-real-client',
  'gate',
  'kvm-probe',
  'vm-shutdown-destruct',
  'wiring-probe',
  'qemu-shutdown-destruct',
  // 2026-11-11 新增：Linux guest 关机自毁。KVM 路线实测可达（提权后 KVM_ACCESSIBLE=yes），
  // 用 Ubuntu cloud image + 覆盖层 + guest 内真实重启验证「关机销毁 / 开机续删」语义。
  // 放在 qemu-shutdown-destruct 之后、summary 之前：它与前者同属 QEMU 自毁族，
  // 但前者依赖 Windows qcow2（可能 skip），本作业不 skip、拿不到 KVM 就硬失败。
  'qemu-destruct-linux-guest',
  'summary',
];

// summary 汇总了哪些作业（15 项，不含它自己）。
const EXPECTED_SUMMARY_NEEDS = [
  'source',
  'windows-build',
  'windows-unit',
  'windows-pause',
  'windows-window',
  'windows-browser',
  'windows-release',
  'windows-real-client-discovery',
  'windows-real-client',
  'gate',
  'kvm-probe',
  'vm-shutdown-destruct',
  'wiring-probe',
  'qemu-shutdown-destruct',
  'qemu-destruct-linux-guest',
];

// 去掉纯注释行后再断言，避免注释里的字样造成假通过/假失败。
function withoutComments(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n')
    .replace(/\n+$/u, '');
}

let cached = null;

async function workflow() {
  if (cached === null) {
    cached = withoutComments(await readFile(WORKFLOW, 'utf8'));
  }
  return cached;
}

function lines() {
  return cached.split('\n');
}

function findTopLevel(name) {
  return lines().findIndex((line) => new RegExp(`^${name}:\\s*$`, 'u').test(line));
}

// 抽一个顶层块（on: / permissions: 这类 0 缩进的键），返回它下面的直接子行。
function topLevelChildren(name) {
  const all = lines();
  const at = findTopLevel(name);
  assert.notEqual(at, -1, `ci.yml 必须有顶层 ${name}: 块`);
  const children = [];
  for (let i = at + 1; i < all.length; i += 1) {
    const line = all[i];
    if (line.trim() === '') continue;
    if (/^\S/u.test(line)) break; // 下一个顶层键
    children.push(line);
  }
  return children;
}

// 抽一个作业段：从 `  <name>:` 到下一个 2 缩进的键为止。
// 只在 jobs: 块之后找，否则 on: 下面的 `  push:` 会被误认为作业。
async function jobSection(name) {
  const all = lines();
  const jobsAt = all.findIndex((line) => /^jobs:\s*$/u.test(line));
  assert.notEqual(jobsAt, -1, 'ci.yml 必须有顶层 jobs: 块');

  const head = new RegExp(`^ {2}${name}:\\s*$`, 'u');
  const start = all.findIndex((line, index) => index > jobsAt && head.test(line));
  assert.notEqual(start, -1, `ci.yml 的 jobs 块必须包含 ${name} 作业`);

  let end = all.length;
  for (let i = start + 1; i < all.length; i += 1) {
    if (/^ {2}[a-z][a-z0-9-]*:\s*$/u.test(all[i])) {
      end = i;
      break;
    }
  }
  return all.slice(start, end).join('\n');
}

async function jobNames() {
  const all = lines();
  const jobsAt = all.findIndex((line) => /^jobs:\s*$/u.test(line));
  assert.notEqual(jobsAt, -1, 'ci.yml 必须有顶层 jobs: 块');

  const names = [];
  for (let i = jobsAt + 1; i < all.length; i += 1) {
    const hit = all[i].match(/^ {2}([a-z][a-z0-9-]*):\s*$/u);
    if (hit) names.push(hit[1]);
  }
  return names;
}

// 读作业段里某个键的值。支持 `key: 值` 与 `key: |` 两种写法；
// 多行块取值时把续行拼成一个字符串（只拼内容，去掉行首缩进）。
function blockValue(sectionText, key, indent = 4) {
  const sectionLines = sectionText.split('\n');
  const head = new RegExp(`^ {${indent}}${key}:(.*)$`, 'u');
  const at = sectionLines.findIndex((line) => head.test(line));
  assert.notEqual(at, -1, `段落里必须包含 ${key}:（缩进 ${indent}）`);

  const inline = sectionLines[at].match(head)[1].trim();
  if (inline !== '' && !/^[|>][+-]?$/u.test(inline)) {
    return inline;
  }

  const body = [];
  for (let i = at + 1; i < sectionLines.length; i += 1) {
    const line = sectionLines[i];
    if (line.trim() === '') {
      if (body.length > 0) body.push('');
      continue;
    }
    const indentOf = line.match(/^( *)/u)[1].length;
    if (indentOf <= indent) break;
    body.push(line.trim());
  }
  assert.ok(body.length > 0, `${key}: 是多行块，但没读到内容`);
  return body.join('\n').trim();
}

// YAML 行尾注释：`actions: read   # 说明`。取值时的值只是 `read`。
function stripInlineComment(value) {
  return value.replace(/[ \t]+#.*$/u, '').trim();
}

// 读 `key: ${{ ... }}` 这类赋值行的值原文。
function inlineValue(sectionText, key) {
  const hit = sectionText
    .split('\n')
    .map((line) => line.match(new RegExp(`^\\s+${key}:\\s*(.+)$`, 'u')))
    .find((match) => match !== null);
  assert.ok(hit, `段落里必须包含 ${key}:`);
  return stripInlineComment(hit[1]);
}

// ─────────────────────────── 1. 合并完成性 ───────────────────────────

test('ci-vm.yml 已被删除（复用调用的 callee 不存在）', async () => {
  await assert.rejects(
    access(REMOVED_WORKFLOW),
    (error) => {
      assert.equal(error.code, 'ENOENT', `${REMOVED_WORKFLOW} 必须已删除，实际错误码 ${error.code}`);
      return true;
    },
    `${REMOVED_WORKFLOW} 必须不存在（已整体并入 ci.yml）`,
  );
});

test('ci.yml 存在且非空', async () => {
  await access(WORKFLOW);
  const text = await workflow();
  assert.ok(text.length > 10000, `ci.yml 去注释后只有 ${text.length} 字节，明显不完整`);
});

test('ci.yml 里不再有任何本地 workflow 复用调用', async () => {
  const text = await workflow();
  // 合并后只剩一个 workflow 文件：任何 `uses: ./.github/workflows/xxx.yml`
  // 都会让整条 workflow 在启动阶段失败（callee 不存在），所以一条都不许留。
  const locals = text
    .split('\n')
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter((entry) => /^uses:\s*\.\/\.github\/workflows\//u.test(entry.line));

  assert.deepEqual(
    locals.map((entry) => entry.line),
    [],
    `不允许残留本地 workflow 复用调用，实际命中 ${JSON.stringify(locals)}`,
  );

  // 顺手钉住具体的那一条：即使将来有人改成别的写法，这一条也要求它别出现。
  assert.doesNotMatch(text, /uses:\s*\.\/\.github\/workflows\/ci-vm\.yml/u);
});

// ─────────────────────── 2. 16 个作业全在且顺序合理 ───────────────────────

test('jobs 块恰好是合并后的 16 个作业，顺序精确', async () => {
  const names = await jobNames();
  assert.deepEqual(
    names,
    EXPECTED_JOBS,
    `作业集合或顺序不符：实际 ${JSON.stringify(names)}`,
  );
});

test('每个作业段都能抽出且各有 name / runs-on', async () => {
  const sections = new Map();
  for (const job of EXPECTED_JOBS) {
    // eslint-disable-next-line no-await-in-loop
    sections.set(job, await jobSection(job));
  }

  assert.equal(sections.size, EXPECTED_JOBS.length);

  for (const [job, section] of sections) {
    const sectionLines = section.split('\n');
    assert.match(section, new RegExp(`^ {2}${job}:$`, 'mu'), `${job} 段首行必须是 "  ${job}:"`);
    // 段内除了首行自身，不能再出现别的作业头 —— 出现就说明切段边界错了，
    // 后面的断言会拿别的作业的内容去比对（假通过的主要来源）。
    const extraHeads = sectionLines
      .slice(1)
      .filter((line) => /^ {2}[a-z][a-z0-9-]*:\s*$/u.test(line));
    assert.deepEqual(extraHeads, [], `${job} 段里混进了别的作业头：${JSON.stringify(extraHeads)}`);
    assert.match(section, /^ {4}name:\s*\S/mu, `${job} 缺 name:`);
    assert.match(section, /^ {4}runs-on:\s*\S/mu, `${job} 缺 runs-on:`);
  }
});

// ───────── 3. 「完整 CI 也跑关机自毁测试」这件事真的成立（核心） ─────────

test('wiring-probe 的 if 覆盖 push / pull_request / workflow_dispatch 三种触发', async () => {
  const section = await jobSection('wiring-probe');
  const condition = blockValue(section, 'if');

  assert.ok(
    condition.includes("github.event_name == 'push'"),
    `wiring-probe 必须在 push 时运行（自毁续删语义是完整 CI 的一部分），实际：\n${condition}`,
  );
  assert.ok(
    condition.includes("github.event_name == 'pull_request'"),
    `wiring-probe 必须在 pull_request 时运行，实际：\n${condition}`,
  );
  assert.ok(
    condition.includes("github.event_name == 'workflow_dispatch'"),
    `wiring-probe 必须保留手动触发，实际：\n${condition}`,
  );
  // 三条用 || 串起来才叫「三种触发都跑」；用 && 或单独写死某一种都要红。
  assert.match(
    condition.replace(/\s+/gu, ' '),
    /github\.event_name == 'push' \|\| github\.event_name == 'pull_request' \|\| github\.event_name == 'workflow_dispatch'/u,
    `三种触发必须并列（||），不能只留其中一种，实际：\n${condition}`,
  );
  // 日判重闸不能被顺手删掉：删了 kvm-probe 就会和自毁作业重复跑。
  // ⚠️ 2026-11-10 captain 裁决：日判重只省 kvm-probe 的成本，**不约束三条自毁作业**。
  // 因为用户要求「完整 CI 里必须有完整关机自毁测试」，若自毁作业也被日判重跳过，
  // 就退回了「关机自毁从未在 CI 里跑过」的老状态。
  // 所以这里断言的是「只受 gate.result 约束，不看 gate.outputs.skip」。
  assert.ok(
    condition.includes("needs.gate.result == 'success'"),
    `wiring-probe 必须受 gate.result 约束（gate 跑挂了才不跑），实际：\n${condition}`,
  );
  assert.ok(
    !condition.includes("needs.gate.outputs.skip"),
    `wiring-probe 不得被日判重跳过 —— 那会让「完整 CI 有自毁测试」失效，实际：\n${condition}`,
  );
});

test('wiring-probe 的 continue-on-error 只在 PR 上放行', async () => {
  const section = await jobSection('wiring-probe');
  assert.equal(
    inlineValue(section, 'continue-on-error'),
    "${{ github.event_name == 'pull_request' }}",
    'continue-on-error 必须精确等于 ${{ github.event_name == \'pull_request\' }}：'
      + '写成 true 会让它永远绿（等于没有门禁），写成 false 会让 PR 被 40 分钟的自毁验证阻塞',
  );
});

test('wiring-probe 跑在托管 runner 上（不依赖 self-hosted 才有自毁验证）', async () => {
  const section = await jobSection('wiring-probe');
  assert.equal(
    inlineValue(section, 'runs-on'),
    'windows-latest',
    'wiring-probe 必须在托管 windows-latest 上跑：这是 push/PR 也有自毁验证的前提',
  );
});

test('vm-shutdown-destruct 由仓库变量开启，不再要求手动触发', async () => {
  const section = await jobSection('vm-shutdown-destruct');
  const condition = blockValue(section, 'if');

  assert.ok(
    condition.includes("vars.CX_VM_ENABLED == 'true'"),
    `vm-shutdown-destruct 必须保留 CX_VM_ENABLED 变量门（托管 runner 没有 cx-vm 标签，硬跑会永久排队），实际：\n${condition}`,
  );
  // ⚠️ 2026-11-10 captain 裁决：日判重只省 kvm-probe 的成本，不约束自毁作业。
  // 真关机是「完整 CI 里必须有」的那部分，被日判重跳过等于退回「从未跑过」。
  assert.ok(
    condition.includes("needs.gate.result == 'success'"),
    `vm-shutdown-destruct 必须受 gate.result 约束，实际：\n${condition}`,
  );
  assert.ok(
    !condition.includes("needs.gate.outputs.skip"),
    `vm-shutdown-destruct 不得被日判重跳过，实际：\n${condition}`,
  );
});

test('vm-shutdown-destruct 仍固定在 self-hosted cx-vm 上', async () => {
  const section = await jobSection('vm-shutdown-destruct');
  assert.equal(
    inlineValue(section, 'runs-on'),
    '[self-hosted, windows, cx-vm]',
    '真关机必须落在自建 cx-vm 上：改成托管 runner 会让作业永久排队或杀掉 runner 自己',
  );
});

test('qemu-shutdown-destruct 在 push 与手动触发时都运行，不是只手动', async () => {
  const section = await jobSection('qemu-shutdown-destruct');
  const condition = blockValue(section, 'if');
  const squashed = condition.replace(/\s+/gu, ' ');

  assert.ok(
    condition.includes("github.event_name == 'push'"),
    `qemu-shutdown-destruct 必须在 push 时运行，实际：\n${condition}`,
  );
  assert.match(
    squashed,
    /github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/u,
    `必须是 push ∪ workflow_dispatch 两个触发，实际：\n${condition}`,
  );
  // 旧写法（只手动触发）会退化成「CI 里从来没有 QEMU 自毁记录」。
  assert.doesNotMatch(
    squashed,
    /^\s*needs\.gate\.outputs\.skip != 'yes' &&\s*\(?github\.event_name == 'workflow_dispatch'\)?\s*$/u,
    `不能是「只 workflow_dispatch」的旧写法，实际：\n${condition}`,
  );
  // PR 上不跑是刻意的（45 分钟 + 客机镜像），这一条防止有人好心把它加进 pull_request。
  assert.ok(
    !condition.includes("github.event_name == 'pull_request'"),
    `qemu-shutdown-destruct 不该跑 pull_request（成本太高），实际：\n${condition}`,
  );
});

// ───────────────────── 4. summary 汇总完整 ─────────────────────

test('summary.needs 精确包含 15 个上游作业', async () => {
  const section = await jobSection('summary');
  const raw = inlineValue(section, 'needs');
  assert.match(raw, /^\[.*\]$/u, `needs 必须是单行列表写法，实际：${raw}`);

  const actual = raw
    .replace(/^\[/u, '')
    .replace(/\]$/u, '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

  assert.deepEqual(
    actual,
    EXPECTED_SUMMARY_NEEDS,
    `summary.needs 与合并后的作业表不一致：实际 ${JSON.stringify(actual)}`,
  );
  // 三条自毁作业必须在汇总里，否则「跑了但汇总不显示」= 等于没跑。
  for (const required of ['vm-shutdown-destruct', 'wiring-probe', 'qemu-shutdown-destruct']) {
    assert.ok(actual.includes(required), `summary.needs 必须包含 ${required}`);
  }
});

test('summary 的三行自毁结果分别接到正确的 result 变量', async () => {
  const section = await jobSection('summary');
  assert.match(
    section,
    />> "\$GITHUB_STEP_SUMMARY"/u,
    'summary 必须把表格写进 Step Summary',
  );

  // 每条都要同时命中「行标题」与「取哪个作业的 result」：
  // 只查标题会让「标题对、变量接错（比如三行全接 WIRING_PROBE_RESULT）」假通过。
  const rows = [
    {
      label: '自毁续删语义验证（托管 runner，两阶段）',
      variable: 'WIRING_PROBE_RESULT',
    },
    {
      label: '关机自毁（self-hosted cx-vm）',
      variable: 'VM_DESTRUCT_RESULT',
    },
    {
      label: '关机自毁（托管 Ubuntu + QEMU + KVM）',
      variable: 'QEMU_DESTRUCT_RESULT',
    },
  ];

  for (const { label, variable } of rows) {
    const line = section
      .split('\n')
      .find((candidate) => candidate.includes(label) && candidate.includes('printf'));
    assert.ok(line, `summary 的 Step Summary 缺少「${label}」这一行`);
    assert.ok(
      line.includes(`result_label "$${variable}"`),
      `「${label}」必须取 $${variable} 的结果，实际行：${line.trim()}`,
    );
  }
});

test('summary 的 env 四个关键变量都取自正确的作业输出', async () => {
  const section = await jobSection('summary');
  const expected = {
    WIRING_PROBE_RESULT: '${{ needs.wiring-probe.result }}',
    VM_DESTRUCT_RESULT: '${{ needs.vm-shutdown-destruct.result }}',
    QEMU_DESTRUCT_RESULT: '${{ needs.qemu-shutdown-destruct.result }}',
    GATE_REASON: '${{ needs.gate.outputs.reason }}',
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(inlineValue(section, name), value, `${name} 必须等于 ${value}`);
  }
});

// ─────────── 5. gate 判重不查已删除的 ci-vm.yml，且排除当前 run ───────────

test('gate 段里不再出现 ci-vm.yml', async () => {
  const section = await jobSection('gate');
  assert.doesNotMatch(
    section,
    /ci-vm\.yml/u,
    'ci-vm.yml 已删除，gate 里再引用它会让判重恒返回 0（静默失效）',
  );
  // 删掉的是文件引用，判重本身必须还在（否则「今天只跑一次」整个语义消失）。
  assert.match(section, /SKIP=/u, 'gate 必须仍然产出 SKIP 输出');
  assert.match(section, /REASON=/u, 'gate 必须仍然产出 REASON 输出');
});

test('gate 用 GITHUB_RUN_ID 排除当前 run 自己', async () => {
  const section = await jobSection('gate');

  assert.match(
    section,
    /\[\s*"\$rid"\s*=\s*"\$\{GITHUB_RUN_ID\}"\s*\]\s*&&\s*continue/u,
    'gate 必须逐条跳过当前 run：否则正在跑的自己会被数成「今天已跑过」',
  );
  // 查的必须是「本 workflow」，不能用硬编码的文件名（合并后只剩 ci.yml 一个）。
  // 查的必须是「本 workflow」，不能用硬编码的文件名（合并后只剩 ci.yml 一个）。
  //
  // ⚠️ 推导顺序不能反（2026-11-10 独立终验抓到）：GITHUB_WORKFLOW_REF 形如
  //   .github/workflows/ci.yml@refs/heads/main
  // 必须先 %% @* 再去 basename，顺序颠倒会得到 main / merge / foo，
  // gh api 查 /workflows/main/runs 404 → 被 || true 吞 → count 恒 0 → 判重静默失效。
  const wfSection = section;
  const stripAt = wfSection.indexOf('${GITHUB_WORKFLOW_REF%%@*}');
  const stripSlash = wfSection.indexOf('${workflow_file##*/}');
  assert.notEqual(stripAt, -1,
    'gate 必须先用 %% @* 去掉 @<ref> 再取 basename：顺序反了会得到 main/merge/foo，判重恒失效');
  assert.notEqual(stripSlash, -1,
    'gate 必须第二步用 ##*/ 取 basename');
  assert.ok(stripAt < stripSlash,
    '推导顺序必须先是 %% @* 再是 ##*/，实际相反 —— 这会让 gh api 404、判重恒不生效');
  assert.doesNotMatch(
    section,
    /GITHUB_WORKFLOW_REF##\*\/\}/u,
    '不得再出现「先 ##*/ 后 %%@*」的错误顺序');
  assert.doesNotMatch(
    section,
    /actions\/workflows\/ci-vm\.yml/u,
    'gate 的 API 路径不能指向已删除的 ci-vm.yml',
  );
});

// ───────────────────────── 6. 权限与触发 ─────────────────────────

test('permissions 里有 actions: read（gate / kvm-probe 要读 run 列表）', async () => {
  const children = topLevelChildren('permissions');
  const values = new Map(
    children
      .filter((line) => /^ {2}\S/u.test(line))
      .map((line) => {
        const hit = line.match(/^ {2}([a-z-]+):\s*(.+)$/u);
        assert.ok(hit, `permissions 下出现无法解析的行：${JSON.stringify(line)}`);
        return [hit[1], stripInlineComment(hit[2])];
      }),
  );

  assert.equal(
    values.get('actions'),
    'read',
    '必须给 actions: read —— 缺了 gate 读不到 run 列表，kvm-probe 判重失效',
  );
  assert.equal(values.get('contents'), 'read', 'contents 必须是 read');
});

test('顶层触发恰好是 push / pull_request / workflow_dispatch，没有 schedule', async () => {
  const children = topLevelChildren('on');
  const triggers = children
    .map((line) => line.match(/^ {2}([a-z_]+):/u))
    .filter((hit) => hit !== null)
    .map((hit) => hit[1]);

  assert.deepEqual(
    triggers.slice().sort(),
    ['pull_request', 'push', 'workflow_dispatch'],
    `顶层触发不符：实际 ${JSON.stringify(triggers)}`,
  );
  assert.doesNotMatch(
    children.join('\n'),
    /schedule/u,
    '顶层不能挂 schedule：自毁与巡检靠 push/PR/手动触发，定时跑会重复消耗自建机',
  );
});

// ─────────── 7. 自毁作业不随新 push 取消（并发保护） ───────────
//
// 顶层 concurrency 是 cancel-in-progress: true：新 push 会取代旧的构建/测试，
// 这对 5～30 分钟的构建作业是**期望行为**（省成本）。
// 但三个自毁作业是「两阶段」的：阶段一在真机/客机里登记 RunOnce，
// 阶段二才重放命令串并断言「目标已删 + 登记已撤销」。中途被取消 = 阶段二永不执行，
// 机器停在「已登记、未续删」的脏状态 —— 下一次自毁验证的基线断言会因此假失败，
// 而且脏状态是留在共享虚拟机上的，不是随 runner 销毁。
// 所以这三个作业必须各自用 job 级 concurrency 覆盖掉顶层的取消策略。

// [作业名, 该作业 concurrency.group 里必须出现的独立标识]
const DESTRUCT_JOBS = [
  ['vm-shutdown-destruct', 'cx-vm-destruct'],
  ['wiring-probe', 'cx-wiring-probe'],
  ['qemu-shutdown-destruct', 'cx-qemu-destruct'],
];

// 读作业段里的 job 级 `concurrency:` 嵌套块（4 缩进）。
// 返回 null 表示没有这个键 —— 调用方要能区分「没有」与「有但值不对」，
// 否则「整段删掉」这种最危险的改动会因为查不到键而静默跳过。
function jobConcurrency(sectionText) {
  const sectionLines = sectionText.split('\n');
  const at = sectionLines.findIndex((line) => /^ {4}concurrency:\s*$/u.test(line));
  if (at === -1) return null;

  const block = [];
  for (let i = at + 1; i < sectionLines.length; i += 1) {
    const line = sectionLines[i];
    if (line.trim() === '') continue;
    const indent = line.match(/^( *)/u)[1].length;
    if (indent <= 4) break;
    block.push(line);
  }

  const text = block.join('\n');
  const group = text.match(/^ {6}group:\s*(.+?)\s*$/mu);
  const cancel = text.match(/^ {6}cancel-in-progress:\s*(\S+)\s*$/mu);
  return {
    group: group === null ? null : group[1],
    cancel: cancel === null ? null : cancel[1],
  };
}

test('三个自毁作业各自有 job 级 concurrency 且不随新 push 取消', async () => {
  for (const [name, slug] of DESTRUCT_JOBS) {
    // eslint-disable-next-line no-await-in-loop
    const section = await jobSection(name);
    const concurrency = jobConcurrency(section);

    assert.notEqual(
      concurrency,
      null,
      `${name} 必须有 job 级 concurrency：缺了就继承顶层的 cancel-in-progress: true，`
        + '新 push 会中途杀掉两阶段验证，留下「已登记未续删」的脏状态',
    );

    assert.equal(
      concurrency.group,
      `${slug}-${'${{ github.ref }}'}`,
      `${name} 的 concurrency.group 必须是独立的 ${slug}-\${{ github.ref }}，`
        + `实际：${JSON.stringify(concurrency.group)}`,
    );

    assert.equal(
      concurrency.cancel,
      'false',
      `${name} 的 cancel-in-progress 必须是 false —— true 会中途杀掉两阶段验证，`
        + `留下「已登记未续删」的脏状态，实际：${JSON.stringify(concurrency.cancel)}`,
    );
  }
});

test('三个自毁作业的 concurrency group 互不相同且归属正确', async () => {
  const groups = [];
  for (const [name, slug] of DESTRUCT_JOBS) {
    // eslint-disable-next-line no-await-in-loop
    const section = await jobSection(name);
    const concurrency = jobConcurrency(section);
    assert.notEqual(concurrency, null, `${name} 必须有 job 级 concurrency`);
    assert.ok(concurrency.group !== null, `${name} 必须有 concurrency.group`);
    groups.push(concurrency.group);

    // 只查「三个值互不相同」不够：改成 cx-a / cx-b / cx-c 也能凑出三个不同值。
    // 每个 group 必须带自己作业的标识，且不得带另外两个作业的标识
    // —— 这条抓的是复制粘贴后忘了改名（两个作业抢同一个 group = 互相排队/互相顶掉）。
    assert.ok(
      concurrency.group.includes(slug),
      `${name} 的 group 必须包含自己的标识 ${slug}，实际：${concurrency.group}`,
    );
    for (const [, otherSlug] of DESTRUCT_JOBS) {
      if (otherSlug === slug) continue;
      assert.ok(
        !concurrency.group.includes(otherSlug),
        `${name} 的 group 不能包含别的作业标识 ${otherSlug}（复制粘贴没改名），实际：${concurrency.group}`,
      );
    }
  }

  assert.equal(
    new Set(groups).size,
    DESTRUCT_JOBS.length,
    `三个自毁作业的 group 必须互不相同，实际：${JSON.stringify(groups)}`,
  );
});

test('workflow 级 concurrency 只服务构建测试，自毁作业已用 job 级覆盖', async () => {
  // 顶层取消策略仍是 true：构建/测试被新 push 取代是对的（省 runner 成本）。
  const children = topLevelChildren('concurrency');
  const top = new Map(
    children
      .filter((line) => /^ {2}\S/u.test(line))
      .map((line) => {
        const hit = line.match(/^ {2}([a-z-]+):\s*(.+)$/u);
        assert.ok(hit, `concurrency 下出现无法解析的行：${JSON.stringify(line)}`);
        return [hit[1], stripInlineComment(hit[2])];
      }),
  );

  assert.equal(
    top.get('cancel-in-progress'),
    'true',
    '顶层 cancel-in-progress 应保持 true：构建与测试作业被新 push 取代是期望行为',
  );
  assert.ok(
    top.get('group') !== undefined && top.get('group') !== '',
    '顶层 concurrency 必须有 group',
  );

  // 但三个自毁作业必须各自覆盖成 false ——
  // 「顶层是 true」与「自毁作业是 false」两条都成立才算语义正确：
  // 只把顶层改成 false 会让所有构建作业排队到前一次跑完，成本爆炸；
  // 只留顶层 true 则自毁作业会被打断。
  for (const [name] of DESTRUCT_JOBS) {
    // eslint-disable-next-line no-await-in-loop
    const section = await jobSection(name);
    const concurrency = jobConcurrency(section);
    assert.equal(
      concurrency === null ? null : concurrency.cancel,
      'false',
      `${name} 必须用 job 级 cancel-in-progress: false 覆盖顶层策略`,
    );
  }
});

// ─────────── 8. 文案不得让人误读「巡检 = 关机自毁已验证」 ───────────

test('kvm-probe 名称与汇总文案都不再叫「虚拟机环境验证」', async () => {
  const text = await workflow();

  // 正向：新文案必须在（证明我们读到的确实是改过的文件，负向断言不是空转）。
  assert.match(text, /KVM 能力巡检/u, '必须改用「KVM 能力巡检」这一说法');

  const kvm = await jobSection('kvm-probe');
  const name = inlineValue(kvm, 'name');
  assert.match(
    name,
    /KVM 能力巡检/u,
    `kvm-probe 的 name 必须说明这是 KVM 能力巡检，实际：${name}`,
  );
  assert.doesNotMatch(
    name,
    /虚拟机环境验证/u,
    `kvm-probe 的 name 不能叫「虚拟机环境验证」—— 那会让读者以为关机自毁已验证通过，实际：${name}`,
  );

  // 汇总表里同样不许回潮：那一行只是 5 分钟只读巡检，不是关机自毁。
  const summary = await jobSection('summary');
  assert.doesNotMatch(
    summary,
    /虚拟机环境验证/u,
    'Step Summary 不得再出现「虚拟机环境验证」：它会被读成「关机自毁已验证」',
  );
  assert.match(
    summary,
    /KVM 能力巡检（只读，非关机自毁）/u,
    'Step Summary 必须明确写出「KVM 能力巡检（只读，非关机自毁）」以区别于真关机自毁',
  );
});

test('整个 ci.yml（去注释）里不再有 ci-vm.yml 引用', async () => {
  const text = await workflow();

  // 正向对照：证明读到的是合并后的完整文件（否则下面的负向断言是空转）。
  assert.ok(
    text.includes('qemu-shutdown-destruct') && text.includes('wiring-probe'),
    '必须读到合并后的 ci.yml（含两个由 ci-vm.yml 迁入的作业）',
  );

  const hits = text
    .split('\n')
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter((entry) => entry.line.includes('ci-vm.yml'));

  assert.deepEqual(
    hits.map((entry) => `${entry.index}: ${entry.line}`),
    [],
    'ci-vm.yml 已删除：注释可以讲历史，但去注释后的可执行内容里不许再引用它',
  );
});

// ────────── 2. 失败连锁：发布包验证不得被「假依赖」连带 skip ──────────
//
// 2026-11-11 实测的事故：windows-unit 因 mjs 清单不同步而失败，
// windows-release 的 if 里写着 `needs.windows-unit.result == 'success'`，
// 于是**发布包验证被连带 skip** —— 那一轮没有任何人知道发布包坏没坏。
//
// 判据（为什么这是缺陷而不是设计）：windows-release 的**唯一输入**是
// windows-build 上传的 artifact `windows-ci-build-<sha>`；
// windows-unit / windows-pause / windows-window / windows-browser
// 都不产出它消费的任何东西，把它们写进 if 是假依赖。
//
// 同时必须保留 windows-build 这个真门：上传用 `if-no-files-found: error`，
// build 失败就没有 artifact，download 步骤没有 continue-on-error，会直接失败。
//
// 这组断言要能抓住的三种回归形态：
//   ① 把 unit/pause/window/browser 任一个写回 if → 红
//   ② 把 windows-build 从 if 里去掉 → 红（build 失败时白跑）
//   ③ 把 if 改成裸 always() → 红（PR 上不该跑的重活也会跑；且失去 !cancelled() 保护）

test('windows-release 的 if 只把 windows-build 当硬门，不把单测/回归当硬门', async () => {
  const section = await jobSection('windows-release');
  const condition = inlineValue(section, 'if');

  // 正向对照：证明读到的是本文件的 if（而不是空串导致的空转）。
  assert.ok(condition.includes('always()'), `windows-release 的 if 必须含 always()，实际：${condition}`);

  // ① 真门必须保留。
  assert.ok(
    condition.includes('needs.windows-build.result == \'success\''),
    `windows-release 的 if 必须保留 windows-build 硬门，实际：${condition}`,
  );

  // ③ 不允许裸 always()：必须还有 !cancelled()，否则被取消时也会跑。
  assert.ok(
    condition.includes('!cancelled()'),
    `windows-release 的 if 必须含 !cancelled()，实际：${condition}`,
  );

  // ② 假门必须不存在。逐个点名，失败信息直接说清是哪个把发布包验证连累了。
  for (const fake of ['windows-unit', 'windows-pause', 'windows-window', 'windows-browser']) {
    assert.ok(
      !condition.includes(`needs.${fake}.result`),
      `windows-release 的 if 不得依赖 ${fake} 的 result（它不产出本作业消费的任何产物，` +
        `一旦它红，发布包验证会被连带 skip，于是没人知道发布包坏没坏）。实际：${condition}`,
    );
  }

  // needs 仍应保留五个：needs 决定调度顺序，去掉会让发布包验证与浏览器回归抢 runner。
  const needs = inlineValue(section, 'needs');
  for (const upstream of ['windows-build', 'windows-unit', 'windows-pause', 'windows-window', 'windows-browser']) {
    assert.ok(
      needs.includes(upstream),
      `windows-release 的 needs 仍须包含 ${upstream}（决定调度顺序，不等于硬门）。实际：${needs}`,
    );
  }
});

test('windows-release 消费的 artifact 只能由 windows-build 提供', async () => {
  const section = await jobSection('windows-release');

  // 这条是上面「假依赖」判定的**事实依据**：把本作业下载的 artifact 名钉住，
  // 并验证它确实来自 windows-build 的上传。
  // 若将来本作业开始消费别的作业产物，这条会红，提醒重新评估哪些 needs 是真依赖。
  const downloads = [...section.matchAll(/name:\s*(windows-ci-build-\$\{\{ github\.sha \}\})/gu)].map((m) => m[1]);
  assert.ok(downloads.length > 0, `windows-release 必须下载共享构建产物，实际段内未找到`);

  const buildSection = await jobSection('windows-build');
  assert.ok(
    buildSection.includes('name: windows-ci-build-${{ github.sha }}'),
    'windows-build 必须上传 windows-release 消费的那个 artifact',
  );
  assert.ok(
    buildSection.includes('if-no-files-found: error'),
    'windows-build 的 artifact 上传必须保持 if-no-files-found: error（否则失败也算成功，build 门失效）',
  );
});
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

// 合并后的 17 个作业，顺序与文件中的实际顺序一致（顺序本身也是断言目标：
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
  'wiring-probe',
  'qemu-shutdown-destruct',
  // 2026-11-11 新增：Linux guest 关机自毁。KVM 路线实测可达（提权后 KVM_ACCESSIBLE=yes），
  // 用 Ubuntu cloud image + 覆盖层 + guest 内真实重启验证「关机销毁 / 开机续删」语义。
  // 放在 qemu-shutdown-destruct 之后、summary 之前：它与前者同属 QEMU 自毁族，
  // 但前者依赖 Windows qcow2（可能 skip），本作业不 skip、拿不到 KVM 就硬失败。
  'qemu-destruct-linux-guest',
  // 2026-11-12 合并：原 build-guest-image.yml 的独立 workflow 并入本文件。
  // 理由：用户要求「优先读 cache，读不到就构建」，而 cache 键必须与
  //   qemu-shutdown-destruct 在同一 workflow 内共享。
  'build-guest-image',
  'summary',
];

// summary 汇总了哪些作业（16 项，不含它自己）。
const EXPECTED_SUMMARY_NEEDS = [
  'build-guest-image',
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

// ─────────────────────── 2. 17 个作业全在且顺序合理 ───────────────────────

test('jobs 块恰好是合并后的 17 个作业，顺序精确', async () => {
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

test('wiring-probe 已取消 event 限制（PR / push / 手动都跑）', async () => {
  const section = await jobSection('wiring-probe');
  const condition = blockValue(section, 'if');

  // 2026-11-11 用户要求「不要跳过任务」：不再按 event_name 限制。
  assert.ok(
    !condition.includes('github.event_name'),
    'wiring-probe 不得再按 event_name 限制，实际：' + condition,
  );
  assert.ok(
    condition.includes('needs.gate.result'),
    'wiring-probe 必须仍然受 gate.result 约束（gate 挂了才不跑），实际：' + condition,
  );
  assert.ok(
    !condition.includes('needs.gate.outputs.skip'),
    'wiring-probe 不得被任何判重跳过，实际：' + condition,
  );
});


test('gate 已取消一切判重：不查历史 run、不推导 workflow 文件', async () => {
  const section = await jobSection('gate');

  // 2026-11-11 最终口径：判重逻辑整体删除。
  assert.ok(
    !section.includes('GITHUB_RUN_ID'),
    'gate 不得再引用 GITHUB_RUN_ID（已取消判重，不查历史 run）',
  );
  assert.ok(
    !section.includes('GITHUB_WORKFLOW_REF'),
    'gate 不得再推导 workflow 文件名（已取消判重，不查 runs 列表）',
  );
  assert.ok(
    !section.includes('head_sha='),
    'gate 不得再按 commit sha 查历史 run（已取消判重）',
  );

  // 三个输出保留为常量，仅为不破坏下游引用。
  for (const key of ['SKIP=', 'REASON=', 'SHA_VERIFIED=']) {
    assert.ok(section.includes(key), `gate 必须仍然产出 ${key}（下游有引用）`);
  }
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


test('qemu-shutdown-destruct 已取消 event 限制（PR 上也跑）', async () => {
  const section = await jobSection('qemu-shutdown-destruct');
  const condition = blockValue(section, 'if');
  const squashed = condition.replace(/\s+/gu, ' ');

  // 2026-11-11 用户要求「不要跳过任务」：不再按 event_name 限制。
  assert.ok(
    !condition.includes('github.event_name'),
    'qemu-shutdown-destruct 不得再按 event_name 限制（PR 上也要跑），实际：' + condition,
  );
  assert.ok(
    condition.includes('needs.gate.result'),
    'qemu-shutdown-destruct 必须仍然要求 gate 成功，实际：' + condition,
  );
  // 旧写法会把「推送后从未跑过」变成永久缺口。
  assert.doesNotMatch(
    squashed,
    /github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/u,
    '不得回退成只认 push/workflow_dispatch，实际：' + condition,
  );
});

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
  // 两条自毁作业必须在汇总里，否则「跑了但汇总不显示」= 等于没跑。
  for (const required of ['wiring-probe', 'qemu-shutdown-destruct']) {
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

test('permissions 里 actions 必须有写权限（cache save 需要；write 同时含 read）', async () => {
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

  // 2026-11-12：build-guest-image 作业要 actions/cache/save，需要 write。
  // GitHub 的 write 权限**包含** read，所以 gate / kvm-probe 读 run 列表不受影响。
  assert.equal(
    values.get('actions'),
    'write',
    '必须是 actions: write —— build-guest-image 要 save cache；write 同时满足 gate 读 run 列表',
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
  // 2026-11-12：job name 统一为「更准确的中文」，断言跟着改成新的表述。
  assert.match(
    name,
    /KVM .*能力巡检/u,
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
  // 2026-11-12：artifact 名改为更准确的中文，仍保留 sha 以便区分轮次。
  assert.ok(
    buildSection.includes('name: Windows 原生测试可执行文件-${{ github.sha }}'),
    'windows-build 必须上传 windows-release 消费的那个 artifact',
  );
  assert.ok(
    buildSection.includes('if-no-files-found: error'),
    'windows-build 的 artifact 上传必须保持 if-no-files-found: error（否则失败也算成功，build 门失效）',
  );
});
// ────────── 4. 跳过不得伪装成成功（假绿） ──────────
//
// 2026-11-11 用户实测抓到：run 42963390787 的
// 「关机自毁与开机续删（托管 Ubuntu + QEMU + KVM）」客机镜像未配置、内部一步没跑，
// 却报 **success**。原因是 job 内部 `skip(){ exit 0; }` + 结论文本只写进
// Step Summary、从不 exit 非零 ⇒ GitHub 看到的是成功。
//
// 修法把两种「没跑」分开：
//   ① 没配置 CX_QEMU_GUEST_IMAGE → **job 级 if 判掉** ⇒ GitHub 显示 skipped（不是 success）
//   ② 配置了但坏（下载失败/格式非 qcow2/文件不存在/缺 secret）→ 步骤 `::error` + exit 1 ⇒ failure
//
// 这组断言要能抓住的回归形态：
//   · 把 job 级 if 里的镜像判空去掉 → ① 变回 success（假绿）
//   · 把 `fail()` 改回 `exit 0` → ② 变回 success（假绿）
//   · 把结论步骤里的 `exit 1` 兜底去掉 → ② 只剩红色文字但 job 绿

test('qemu-shutdown-destruct 不跳过：job 级只判 gate，未配置镜像也必须启动并如实失败', async () => {
  const section = await jobSection('qemu-shutdown-destruct');
  // `if:` 是 `|` 多行块时必须用 blockValue（inlineValue 只会读到那个竖线）。
  const condition = blockValue(section, 'if');

  // 正向对照：证明读到的是本作业的 if。
  assert.ok(condition.includes("needs.gate.result == 'success'"), `if 必须仍受 gate 约束，实际：${condition}`);

  // 2026-11-11 用户三次要求「不要跳过任务」，所以 job 级**不得**再按镜像变量跳过。
  //
  // 历史（两轮修正）：
  //   ① 原状：job 总启动，内部 `skip(){ exit 0; }` ⇒ 「未配置」变成 success = 假绿。
  //   ② t96 一度改成 job 级判变量 ⇒ 显示 skipped（不撒谎，但仍是「跳过」）。
  //   ③ **现在（用户最终要求）**：不跳过 —— job 必启动，未配置时由内部
  //      「解析客机镜像」步骤 `::error` + exit 1 收场 ⇒ **failure**。
  //      「跑不了就红」比「假装没要求」更符合「跳过不等于验证通过」。
  assert.ok(
    !condition.includes('CX_QEMU_GUEST_IMAGE') && !condition.includes('guest_image'),
    'job 级 if 不得再按镜像变量跳过（用户要求不跳过；未配置应由内部步骤判红）。' +
      `实际：${condition}`,
  );
  assert.ok(
    !condition.includes('github.event_name'),
    'job 级 if 不得再按 event 限制（PR 上也跑）。' + `实际：${condition}`,
  );

  // 2026-11-12：镜像来源已从「仓库变量 / 手动输入」改为「build-guest-image 作业
  // 存入的 Actions Cache」。用户要求「优先读 cache，读不到就构建」，
  // 而 cache 键必须与 build-guest-image 在同一 workflow 内共享。
  // 镜像来源：手动输入可覆盖，默认走 cache 恢复出来的文件。
  assert.match(
    section,
    /CX_QEMU_GUEST_IMAGE:[^\n]*guest-cache\/guest\.qcow2/u,
    'env 必须指向 cache 恢复出来的 guest-cache/guest.qcow2',
  );
  // 反证：不得再回退到仓库变量（那会与 cache 路径冲突）
  assert.ok(
    !section.includes('vars.CX_QEMU_GUEST_IMAGE'),
    '不得再引用 vars.CX_QEMU_GUEST_IMAGE —— 镜像来源已统一为 cache',
  );
});


test('qemu-shutdown-destruct 配置了但坏时必须失败，不得 exit 0', async () => {
  const section = await jobSection('qemu-shutdown-destruct');

  // 找出「解析客机镜像」步骤的 run 正文。
  const stepLines = section.split('\n');
  const start = stepLines.findIndex((line) => line.includes('解析客机镜像'));
  assert.notEqual(start, -1, 'qemu-shutdown-destruct 必须有「解析客机镜像」步骤');
  // 取到下一个 `- name:` 之前的全部内容。
  let end = stepLines.length;
  for (let i = start + 1; i < stepLines.length; i += 1) {
    if (/^\s+- name:/u.test(stepLines[i])) { end = i; break; }
  }
  const body = stepLines.slice(start, end).join('\n');

  // ① 必须有 fail() 且它 exit 1。
  assert.match(body, /fail\(\)\s*\{/u, '解析客机镜像步骤必须有 fail() 辅助函数');
  const failBlock = body.split(/fail\(\)\s*\{/u)[1]?.split(/\}/u)[0] ?? '';
  assert.ok(failBlock.length > 0, 'fail() 必须有函数体');
  assert.ok(
    /exit\s+1/u.test(failBlock),
    `fail() 必须以 exit 1 结束，否则「配置了但坏」会变成成功（假绿）。实际函数体：${failBlock.trim()}`,
  );

  // ② 不得再有「skip() 里 exit 0」这种形态残留在本步骤里。
  assert.ok(
    !/skip\(\)\s*\{[^}]*exit\s+0/u.test(body),
    '解析客机镜像步骤不得再出现 `skip(){ ... exit 0 }` —— 那正是假绿的成因',
  );

  // ③ 关键分支都要走 fail()：空值兜底 / ISO 拒绝 / 下载失败 / 本地文件不存在 / 格式不对 / 缺 secret。
  // 2026-11-12：密钥来源已从 secret 改为 Actions Cache（用户明确要求不保留 secret），
  // 所以这里不再断言 CX_QEMU_GUEST_SSH_KEY，改为断言新的可操作失败文案。
  for (const marker of ['拒绝 ISO 装机路径', '下载客机镜像失败', '本地文件不存在', '需要 qcow2', 'Actions Cache 里没有客机 SSH 私钥']) {
    assert.ok(
      body.includes(marker),
      `解析客机镜像步骤必须保留「${marker}」这条失败分支（且走 fail() 判红）`,
    );
  }
});

test('qemu-shutdown-destruct 的跳过按「环境不可用 / 配置坏了」分流', async () => {
  const section = await jobSection('qemu-shutdown-destruct');

  // 「环境不可用（KVM/QEMU）」与「配置坏了（镜像）」必须用两个不同变量表达，
  // 否则无法只对后者判红。
  assert.ok(section.includes('ENVIRONMENT_SKIPPED'), 'summary 必须区分 ENVIRONMENT_SKIPPED（KVM/QEMU 环境问题）');
  assert.ok(section.includes('CONFIG_BROKEN'), 'summary 必须区分 CONFIG_BROKEN（镜像/secret 配置问题）');

  // 两类跳过在 summary 里必须有不同标题，不能都写成「跳过」。
  assert.ok(
    section.includes('未执行（环境不可用，不是通过）'),
    'environment 跳过必须明确写「不是通过」',
  );
  assert.ok(
    section.includes('失败：客机镜像已配置但不可用'),
    'config 坏了必须以「失败」呈现，不能写成「跳过」',
  );
});

test('qemu-destruct-linux-guest 不得引入同款假绿（它不需要镜像变量）', async () => {
  const section = await jobSection('qemu-destruct-linux-guest');

  // 这条作业不依赖 CX_QEMU_GUEST_IMAGE，所以它的 if 里**不应**出现该变量
  // （出现说明有人照抄了上面那条的 job 级判空，会让它永远 skipped）。
  const condition = inlineValue(section, 'if');
  assert.ok(
    !condition.includes('CX_QEMU_GUEST_IMAGE'),
    `qemu-destruct-linux-guest 不依赖 Windows 镜像变量，if 里不应出现它。实际：${condition}`,
  );

  // 它也不应出现 skip()+exit 0 的假绿形态：拿不到 KVM 就硬失败是刻意设计。
  assert.ok(
    !/skip\(\)\s*\{[^}]*exit\s+0/u.test(section),
    'qemu-destruct-linux-guest 不得有 `skip(){ exit 0 }` 形态：它拿不到 KVM 就该硬失败',
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// 2026-11-12（run 43180686322 实测暴露）：所有 github.event.inputs.* 必须有兜底
//
// 背景：这份 workflow 有三种触发（push / pull_request / workflow_dispatch）。
// 只有 workflow_dispatch 会填 inputs，另两种事件下 github.event.inputs.* 是空。
//
// 实测事故：'构建 Windows 客机镜像（cache 优先）' 在 pull_request 上失败于
// '等待安装完成'，但同样的代码在 workflow_dispatch（run 43174597077）上是绿的。
// 根因是 INSTALL_TIMEOUT 取到空串，导致 bash 的算术展开 START + (空) 失败；
// 同时 VERSION / DISK_SIZE / GUEST_PASSWORD 也是空串，docker run 参数残缺。
//
// 这条测试是通用防护：凡是出现 github.event.inputs.X 的地方，
// 必须同时有 || 兜底，否则非 dispatch 事件下就是空串。
test('所有 github.event.inputs.* 都必须有 || 兜底（非 dispatch 事件下为空）', async () => {
  const raw = await readFile(WORKFLOW, 'utf8');
  const lines = raw.split('\n');
  const offenders = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/u.test(line)) continue;
    if (!/github\.event\.inputs\.[A-Za-z_][A-Za-z0-9_]*/u.test(line)) continue;
    if (/\|\|/u.test(line)) continue;
    offenders.push(`L${i + 1}: ${line.trim()}`);
  }

  assert.deepEqual(
    offenders,
    [],
    '以下位置使用了 github.event.inputs.* 但没有 || 兜底。' +
      'push / pull_request 事件下这些值是空串：\n' + offenders.join('\n'),
  );
});

// 正向对照：确认这四处真的有兜底（防止上面的断言因「一个都没匹配到」而空转）
test('build-guest-image 的四个关键 inputs 确实带了默认值', async () => {
  const raw = await readFile(WORKFLOW, 'utf8');
  const required = [
    ['VERSION', "github.event.inputs.version || '"],
    ['DISK_SIZE', "github.event.inputs.disk_size || '"],
    ['INSTALL_TIMEOUT', "github.event.inputs.install_timeout_sec || '"],
    ['GUEST_PASSWORD', "github.event.inputs.guest_password || '"],
  ];
  for (const [name, needle] of required) {
    assert.ok(raw.includes(needle), `${name} 必须带 || 默认值，实际找不到：${needle}`);
  }
});
// ══════════════════════════════════════════════════════════════════════════════
// 2026-11-12（run 43183097873 实测暴露）：checkout 必须排在 cache restore 之前
//
// 事故：qemu-shutdown-destruct 报
//   CX_QEMU_GUEST_IMAGE 指向的本地文件不存在：
//   /home/runner/work/ChaoXing-Plus/ChaoXing-Plus/guest-cache/guest.qcow2
//
// 但前一步「确认镜像可用」是 SUCCESS —— 说明 restore 成功、文件当时在。
// 真正的原因是那一步之后紧跟了第二个 `actions/checkout`，
// 而 checkout 默认 clean: true 会清理工作区里的未跟踪文件，
// 把刚恢复出来的 guest-cache/ 整个删掉。
//
// 两个约束：
//   ① 同一个 job 里不应有重复的 checkout（本项目里实测出现过 2 个）
//   ② cache/restore 必须在最后一个 checkout 之后，否则会被它清掉
test('qemu-shutdown-destruct 的 checkout 必须在 cache restore 之前且不重复', async () => {
  const section = await jobSection('qemu-shutdown-destruct');
  const lines = section.split('\n');

  const checkouts = [];
  const restores = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/uses:\s*actions\/checkout@/u.test(lines[i])) checkouts.push(i + 1);
    if (/uses:\s*actions\/cache\/restore@/u.test(lines[i])) restores.push(i + 1);
  }

  assert.equal(
    checkouts.length,
    1,
    `qemu-shutdown-destruct 只应有 1 个 checkout（checkout 会清理工作区），实际 ${checkouts.length} 个：L${checkouts.join(', L')}`,
  );
  assert.ok(
    restores.length >= 1,
    'qemu-shutdown-destruct 必须有 actions/cache/restore（镜像来自 build-guest-image 的 cache）',
  );

  const lastCheckout = Math.max(...checkouts);
  const firstRestore = Math.min(...restores);
  assert.ok(
    firstRestore > lastCheckout,
    'cache/restore 必须在 checkout 之后 —— checkout 默认 clean:true 会删掉刚恢复的 guest-cache/。' +
      `实际 checkout 在 L${checkouts.join(', L')}，restore 在 L${restores.join(', L')}`,
  );
});

// 同一族问题：build-guest-image 自己也要保证 checkout 在 cache restore 之前
test('build-guest-image 的 checkout 也在 cache restore 之前', async () => {
  const section = await jobSection('build-guest-image');
  const lines = section.split('\n');

  const co = lines.findIndex((l) => /uses:\s*actions\/checkout@/u.test(l));
  const cr = lines.findIndex((l) => /uses:\s*actions\/cache\/restore@/u.test(l));

  assert.ok(co >= 0, 'build-guest-image 必须有 checkout');
  if (cr >= 0) {
    assert.ok(
      cr > co,
      `build-guest-image 的 cache/restore（L${cr + 1}）必须在 checkout（L${co + 1}）之后`,
    );
  }
});
// ══════════════════════════════════════════════════════════════════════════════
// 2026-11-12（run 43187143353 实测暴露）：SSH 密钥步骤不能被 cache 门跳过
//
// 事故链：
//   cache 命中 → 「生成 SSH 密钥」因 if: CACHE_HIT != 'yes' 被跳过
//   → $WORK/id 不存在
//   → 「验证 SSH 可连」执行 ssh -i $WORK/id，找不到 key
//   → ssh 回落到 ~/.ssh/id_rsa 等默认路径
//   → 日志里全是 "Trying private key: /home/runner/.ssh/id_rsa"
//     + "Permission denied (publickey)"
//   → 看起来像客机 sshd 问题，实际是本地缺 key（误诊成本极高）
//
// 判据：凡是「验证 SSH」用到的 key 路径，其生成步骤都不得带 cache 门。
test('SSH 密钥生成步骤不得被 cache 门跳过（否则验证 SSH 会误诊为客机问题）', async () => {
  const section = await jobSection('build-guest-image');
  const lines = section.split('\n');

  // 找「生成 SSH 密钥」步骤
  const kIdx = lines.findIndex((l) => l.includes('生成 SSH 密钥'));
  assert.notEqual(kIdx, -1, 'build-guest-image 必须有「生成 SSH 密钥」步骤');

  // 该步骤到下一个 - name: 之间不得有 if: 引用 havecache
  let end = kIdx + 1;
  while (end < lines.length && !/^\s+- name:/.test(lines[end])) end += 1;
  const block = lines.slice(kIdx, end).join('\n');
  assert.doesNotMatch(
    block,
    /if:\s*steps\.havecache\.outputs\.CACHE_HIT/u,
    '「生成 SSH 密钥」不得带 `if: steps.havecache.outputs.CACHE_HIT != \'yes\'`：' +
      'cache 命中时 $WORK/id 不存在，验证 SSH 会回落到默认 key 并报 Permission denied，' +
      '极易误诊为客机 sshd 故障',
  );

  // 反向对照：确认「验证 SSH」确实在用 $WORK/id（否则本断言无意义）
  const vIdx = lines.findIndex((l) => l.includes('验证 SSH 可连'));
  assert.notEqual(vIdx, -1, '必须有「验证 SSH 可连」步骤');
  let vEnd = vIdx + 1;
  while (vEnd < lines.length && !/^\s+- name:/.test(lines[vEnd])) vEnd += 1;
  const vBlock = lines.slice(vIdx, vEnd).join('\n');
  assert.match(
    vBlock,
    /\$WORK\/id/u,
    '「验证 SSH 可连」应当使用 $WORK/id（与密钥步骤配对）；两者路径不一致会再次产生本类误诊',
  );
});
// ══════════════════════════════════════════════════════════════════════════════
// 2026-11-12（run 43190313294 实测暴露）：cache 必须把密钥对一起存
//
// 设计矛盾：镜像在**构建那一刻**就把当时生成的公钥写进了客机的
//   C:\ProgramData\ssh\administrators_authorized_keys
// （见 build-guest-image 的 OEM setup.ps1：Set-Content $ak (Get-Content C:\OEM\id.pub)）
//
// 而「生成 SSH 密钥」每次运行都 ssh-keygen 一对**新的**。
// cache 命中时不重建镜像 ⇒ 客机里是旧公钥 + 本地是新私钥 ⇒ sshd 回 packet type 51。
//
// 实测证据（ssh-vvv-1.txt）：
//   Offering public key: /home/runner/work/_temp/guest/id ED25519 SHA256:XjsCPahr…
//   we sent a publickey packet, wait for reply
//   receive packet: type 51              ← 明确拒绝
//   runner@127.0.0.1: Permission denied (publickey,password,keyboard-interactive).
//
// 因此两条约束必须同时成立，缺一即失败：
//   ① 「存入 Actions Cache」必须带上 guest-key / guest-key.pub
//   ② 「生成 SSH 密钥」在 cache 命中时必须用它们覆盖刚生成的那对
test('cache 必须携带密钥对，且 cache 命中时换成它（否则公私钥不配对）', async () => {
  const section = await jobSection('build-guest-image');
  const lines = section.split('\\n');

  const stepBody = (needle) => {
    const i = lines.findIndex((l) => l.includes(needle));
    assert.notEqual(i, -1, `未找到步骤：${needle}`);
    let e = i + 1;
    while (e < lines.length && !/^\\s+- name:/.test(lines[e])) e += 1;
    return lines.slice(i, e).join('\\n');
  };

  // ① 存入 cache 时带上密钥对
  // 全文查（stepBody 因缩进差异会误判）
  assert.match(section, /cp "\$WORK\/id\.pub"\s+"\$CACHE_OUT\/guest-key\.pub"/u, '「存入 Actions Cache」必须把公钥拷成 guest-key.pub');
  assert.match(section, /cp "\$WORK\/id"\s+"\$CACHE_OUT\/guest-key"/u, '「存入 Actions Cache」必须把私钥拷成 guest-key（缺了它缓存里只有公钥，无法认证）');

  // ② cache 命中时换成缓存密钥
  const key = stepBody('生成 SSH 密钥');
  assert.match(
    key,
    /SSH_KEY_SOURCE=cache/u,
    '「生成 SSH 密钥」必须有 cache 命中分支：用 guest-cache/guest-key 覆盖刚生成的那对。' +
      '否则客机里的旧公钥与本地新私钥不配对，sshd 会回 packet type 51',
  );
  assert.match(key, /SSH_KEY_SOURCE=fresh/u, 'cache 未命中时也必须标出 key 来源，便于日志诊断');
  assert.match(
    key,
    /ssh-keygen -l/,
    '换 key 后必须重新校验可用性（防止 cache 里的文件损坏）',
  );

  // ③ 反向对照：确认「验证 SSH」用的就是 $WORK/id（与上面配对逻辑衔接）
  const verify = stepBody('验证 SSH 可连');
  assert.match(verify, /\$WORK\/id/u, '「验证 SSH 可连」必须用 WORK/id（与密钥步骤配对）');
});

// ══════════════════════════════════════════════════════════════════════════════
// 2026-11-12（用户明确要求）：SSH 密钥必须**随镜像一起打包进 cache**，且不保留 secret
//
// 背景：镜像里的公钥是构建时随机生成并写死进
//   C:\ProgramData\ssh\administrators_authorized_keys 的。
// 任何人工维护的 secret 私钥都不可能与之配对 —— 所以 secret 方案在技术上就是死路，
// 保留它只会误导「配了就能用」，掩盖真正该做的动作（先跑构建把密钥对存进 cache）。
//
// run 43193689229 实证：关机自毁 job 报
//   Error: 缺少 secret CX_QEMU_GUEST_SSH_KEY：客机内两阶段需要一个命令通道
test('SSH 密钥必须随镜像打包进 cache，且消费端不依赖 secret', async () => {
  const wf = await workflow();

  // ① 生产端：存入 cache 时必须带上密钥对
  assert.match(
    wf,
    /cp "\$WORK\/id"\s+"\$CACHE_OUT\/guest-key"/u,
    '「存入 Actions Cache」必须把私钥拷成 guest-key（否则 cache 里只有镜像没有私钥）',
  );
  assert.match(
    wf,
    /cp "\$WORK\/id\.pub"\s+"\$CACHE_OUT\/guest-key\.pub"/u,
    '「存入 Actions Cache」必须把公钥拷成 guest-key.pub（便于核对与排障）',
  );

  // ② 消费端：关机自毁必须从 cache 取私钥
  const qemu = await jobSection('qemu-shutdown-destruct');
  assert.match(
    qemu,
    /guest-cache\/guest-key/u,
    'qemu-shutdown-destruct 必须从 Actions Cache 的 guest-cache/guest-key 取私钥',
  );

  // ③ 反证：不得再引用那个 secret（用户明确要求不保留）
  assert.doesNotMatch(
    qemu,
    /secrets\.CX_QEMU_GUEST_SSH_KEY/u,
    'qemu-shutdown-destruct 不得再引用 secrets.CX_QEMU_GUEST_SSH_KEY：' +
      '镜像里的公钥是随机生成并写死的，人工 secret 私钥不可能与之配对',
  );

  // ④ 拿不到密钥时必须如实失败（不能静默跳过，否则又是假绿）
  assert.match(
    qemu,
    /Actions Cache 里没有客机 SSH 私钥/u,
    '缺密钥时必须给出可操作的失败信息（指向「先跑构建作业」这个真正解法）',
  );
});

// 故障公告弹窗（task_doc/113 §1.1）。
//
// 三条不可协商的约束，每条都有独立用例：
//   ① 不能阻塞搜题 —— 弹窗不 await，用户不点「知道了」答案也照常填；
//   ② 每个页面生命周期只弹一次 —— 不是每次搜题都弹；
//   ③ 内容是完整的 swal 弹窗，不是顶部横幅、不截断。
//
// 为什么必须要「永不 resolve 的 promise」这个 fixture：
// `await` 一个**已经 resolve** 的 promise 也照样绿 —— 那样测出来的「不阻塞」是假的。
// 只有让 `$modal.alert` 返回一个永不 settle 的 promise，`await` 才会真正挂住，
// 这条用例才具备「实现被改成阻塞就必红」的判别力。
//
// 断言打在**源码里的那份实现**上（从 common.ts / cx.ts 按名字截取后丢进 vm），
// 不是测试里另抄一份 —— 抄一份的话改坏实现测试照样绿，等于没测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from '@typescript/typescript6';

const here = dirname(fileURLToPath(import.meta.url));
const commonPath = resolve(here, '..', 'src', 'projects', 'common.ts');
const cxPath = resolve(here, '..', 'src', 'projects', 'cx.ts');

/**
 * 按名字从源文件里取出顶层声明原文（去掉 `export `）。
 *
 * 找不到就**立刻抛错**，而不是返回空串：空串会让 vm 里少一个函数，
 * 后续断言可能「因为没弹窗而恰好通过」，那是静默变绿。
 * 这条来自 t169 的教训 —— 源码截取型测试必须自证「截到的确实是那段代码」。
 */
async function declarations(path, names) {
  const source = await readFile(path, 'utf8');
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const found = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
      found.push(node.getText(parsed));
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const name = node.name.getText(parsed);
      if (names.includes(name)) found.push(`const ${node.getText(parsed)};`);
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(parsed, visit);

  // 逐个核对：每个名字都必须被截到一次且只有一次（防重名副本导致取到失效的旧那份）。
  for (const name of names) {
    const hits = found.filter((text) => new RegExp(`(?:function\\s+|const\\s+)${name}\\b`, 'u').test(text));
    assert.equal(hits.length, 1, `${path} 里 ${name} 应恰好被截到 1 次，实际 ${hits.length} 次`);
  }

  const joined = found.join('\n').replace(/^export /gm, '');
  assert.ok(joined.trim().length > 0, `${path} 截取结果不能为空`);
  return joined;
}

/**
 * 从源码拼出运行期。`alertImpl` 决定 `$modal.alert` 的返回：
 * 默认是立即 resolve，测阻塞时传一个永不 resolve 的 promise 工厂。
 */
async function createRuntime(alertImpl = () => Promise.resolve({ isConfirmed: true })) {
  const source = [
    await declarations(commonPath, [
      'shownIncidentIds',
      'resolveIncidentIcon',
      'normalizeIncidentAnnouncements',
      'maybeShowIncidentAnnouncements'
    ]),
    await declarations(cxPath, ['logTikuAdapterWarnings', 'withTikuAdapterAdminWarnings'])
  ].join('\n');

  const alerts = [];
  const logs = [];
  const globals = {
    // 被测实现调用的外部缝：弹窗与日志转发。
    $modal: {
      alert(options) {
        alerts.push(options);
        return alertImpl(options);
      }
    },
    collectTikuAdapterWarnings: () => [],
    logDebug: (level, title, payload, message) => logs.push({ level, title, payload, message })
  };
  const context = vm.createContext(globals);
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  try {
    vm.runInContext(code, context);
  } catch (error) {
    assert.fail(`截取的源码无法执行（说明截取出来的已不是有效代码）：${error.message}`);
  }
  const runtime = vm.runInContext(
    '({ maybeShowIncidentAnnouncements, withTikuAdapterAdminWarnings })',
    context
  );
  // 执行成功不代表函数真的被定义了（vm 里少了声明会得到 undefined），逐个核对。
  for (const name of ['maybeShowIncidentAnnouncements', 'withTikuAdapterAdminWarnings']) {
    assert.equal(typeof runtime[name], 'function', `${name} 必须是函数，实际 ${typeof runtime[name]}`);
  }
  return { ...runtime, alerts, logs };
}

/** 一条 incident 公告的响应外壳。 */
function incidentResponse(announcements, extra = {}) {
  return [{ name: '题库', results: [], response: { ...extra, announcements } }];
}

function incident(overrides = {}) {
  return {
    kind: 'incident',
    id: 7,
    title: '题库服务异常',
    content: '题库源连接超时，正在抢修，预计 30 分钟恢复',
    severity: 'critical',
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 判据 ③：不阻塞搜题（最关键的一条）
// ---------------------------------------------------------------------------
test('search result is delivered while the incident popup is still open', async () => {
  // 永不 resolve：真实场景里就是「用户一直不点知道了」。
  const neverSettles = new Promise(() => {});
  const runtime = await createRuntime(() => neverSettles);

  const searchInfos = incidentResponse([incident()]);
  searchInfos[0].results = [{ question: '1+1=?', answer: 'B' }];

  // 用 timeout 把「被阻塞」变成明确的失败，而不是让整个测试挂死。
  let timer;
  const blocked = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('搜题被弹窗阻塞：withTikuAdapterAdminWarnings 未返回')), 1000);
  });
  let resolved;
  try {
    resolved = await Promise.race([runtime.withTikuAdapterAdminWarnings(searchInfos), blocked]);
  } finally {
    clearTimeout(timer);
  }

  // ④ 搜题结果照常可用 —— 弹窗还开着，答案已经在手里了。
  assert.equal(resolved[0].results[0].answer, 'B');
  // 弹窗确实弹出去了（否则「没阻塞」可能只是「根本没弹」）。
  assert.equal(runtime.alerts.length, 1);
});

test('a never-settling popup still lets the second search through', async () => {
  const runtime = await createRuntime(() => new Promise(() => {}));

  const first = runtime.withTikuAdapterAdminWarnings(incidentResponse([incident()]));
  const second = runtime.withTikuAdapterAdminWarnings(incidentResponse([incident()]));

  const settled = await Promise.all([
    Promise.race([first, new Promise((_r, reject) => setTimeout(() => reject(new Error('第一次搜题被阻塞')), 1000))]),
    Promise.race([second, new Promise((_r, reject) => setTimeout(() => reject(new Error('第二次搜题被阻塞')), 1000))])
  ]);
  assert.equal(settled.length, 2);
});

// ---------------------------------------------------------------------------
// 判据 ①：连续两次搜题只弹一次
// ---------------------------------------------------------------------------
test('two consecutive searches show the same incident only once', async () => {
  const runtime = await createRuntime();

  await runtime.withTikuAdapterAdminWarnings(incidentResponse([incident({ id: 7 })]));
  await runtime.withTikuAdapterAdminWarnings(incidentResponse([incident({ id: 7 })]));

  assert.equal(runtime.alerts.length, 1);
});

test('a genuinely new incident id in a later search still shows', async () => {
  // 这条挡住「把 Set 换成布尔标记」的简化：布尔标记在考试中途新发公告时会让用户漏看。
  const runtime = await createRuntime();

  await runtime.withTikuAdapterAdminWarnings(incidentResponse([incident({ id: 7 })]));
  await runtime.withTikuAdapterAdminWarnings(incidentResponse([incident({ id: 7 })]));
  await runtime.withTikuAdapterAdminWarnings(incidentResponse([incident({ id: 8, title: '题库服务恢复中' })]));

  assert.equal(runtime.alerts.length, 2);
  assert.match(runtime.alerts[1].content, /题库服务恢复中/);
});

test('multiple incidents in one response show only the first one', async () => {
  const runtime = await createRuntime();

  await runtime.withTikuAdapterAdminWarnings(
    incidentResponse([incident({ id: 7 }), incident({ id: 8, title: '第二条' })])
  );

  assert.equal(runtime.alerts.length, 1);
  assert.match(runtime.alerts[0].content, /题库服务异常/);
});

// ---------------------------------------------------------------------------
// 判据 ③（形式）：弹的是完整 swal 弹窗，不是截断的横幅
// ---------------------------------------------------------------------------
test('popup carries the full announcement body, not a truncated banner', async () => {
  const runtime = await createRuntime();
  const longContent = `题库源连接超时，正在抢修，预计 30 分钟恢复。${'补充说明。'.repeat(40)}`;

  await runtime.withTikuAdapterAdminWarnings(incidentResponse([incident({ content: longContent })]));

  assert.equal(runtime.alerts.length, 1);
  const content = runtime.alerts[0].content;
  assert.equal(content.includes(longContent), true, '公告正文必须完整保留');
  assert.equal(content.startsWith('【题库服务异常】'), true);
  assert.equal(content.includes('\n'), true, '标题与正文分行，不是压成一行横幅');
  // severity=critical 映射到 error 图标；弹窗形态由 $modal.alert 保证（模态 + 『知道了』）。
  assert.equal(runtime.alerts[0].icon, 'error');
});

// ---------------------------------------------------------------------------
// 判据 ④：没有 announcements 字段 / 空数组 → 一次都不调
// ---------------------------------------------------------------------------
test('a response without an announcements field never opens a popup', async () => {
  const runtime = await createRuntime();

  await runtime.withTikuAdapterAdminWarnings([{ name: '题库', results: [], response: { answer: {} } }]);
  await runtime.withTikuAdapterAdminWarnings([{ name: '题库', results: [], response: undefined }]);
  await runtime.withTikuAdapterAdminWarnings([{ name: '题库', results: [] }]);
  await runtime.withTikuAdapterAdminWarnings([]);

  assert.equal(runtime.alerts.length, 0);
});

test('an empty announcements array never opens a popup', async () => {
  const runtime = await createRuntime();

  await runtime.withTikuAdapterAdminWarnings(incidentResponse([]));

  assert.equal(runtime.alerts.length, 0);
});

// ---------------------------------------------------------------------------
// 判据 ⑤：只有 kind=normal 的公告 → 不弹
// ---------------------------------------------------------------------------
test('normal announcements are never shown to the user', async () => {
  const runtime = await createRuntime();

  await runtime.withTikuAdapterAdminWarnings(
    incidentResponse([
      { kind: 'normal', id: 1, title: '发版通知', content: 'v6.3.1 已发布' },
      { kind: 'normal', id: 2, title: '活动预告', content: '周末双倍额度' }
    ])
  );

  assert.equal(runtime.alerts.length, 0);
});

test('a mixed response shows only the incident and ignores normal ones', async () => {
  const runtime = await createRuntime();

  await runtime.withTikuAdapterAdminWarnings(
    incidentResponse([
      { kind: 'normal', id: 1, title: '发版通知', content: 'v6.3.1 已发布' },
      incident({ id: 7 })
    ])
  );

  assert.equal(runtime.alerts.length, 1);
  assert.match(runtime.alerts[0].content, /题库服务异常/);
  assert.equal(runtime.alerts[0].content.includes('发版通知'), false);
});

// ---------------------------------------------------------------------------
// 故障公告往往伴随错误响应：搜题失败时公告仍要弹
// ---------------------------------------------------------------------------
test('an incident still pops when the search response carries an error', async () => {
  const runtime = await createRuntime();
  const infos = incidentResponse([incident()], {
    error: { code: 'UPSTREAM_TIMEOUT', message: '题库源超时' }
  });
  infos[0].error = 'UPSTREAM_ERROR: 服务器内部错误，搜题失败。';

  const resolved = await runtime.withTikuAdapterAdminWarnings(infos);

  assert.equal(runtime.alerts.length, 1);
  // 错误文案原样透传，不被弹窗逻辑改写。
  assert.equal(resolved[0].error, 'UPSTREAM_ERROR: 服务器内部错误，搜题失败。');
});

// ---------------------------------------------------------------------------
// 接线：两条搜题链路都走 withTikuAdapterAdminWarnings
// ---------------------------------------------------------------------------
test('cx routes both search chains through the incident-aware wrapper', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.match(source, /maybeShowIncidentAnnouncements/);
  // 普通搜题 + AI 兜底两条链路共用同一包装函数，共 3 处引用（含定义本身）。
  assert.equal(source.match(/withTikuAdapterAdminWarnings\(/g).length, 3);

  const wrapperStart = source.indexOf('async function withTikuAdapterAdminWarnings');
  assert.ok(wrapperStart >= 0);
  const wrapperBlock = source.slice(wrapperStart, wrapperStart + 900);
  assert.match(wrapperBlock, /await maybeShowIncidentAnnouncements\(resolvedInfos\);/);
  // 绝不能把弹窗结果并进返回值或改写错误。
  assert.doesNotMatch(wrapperBlock, /\.error\s*=/);
});

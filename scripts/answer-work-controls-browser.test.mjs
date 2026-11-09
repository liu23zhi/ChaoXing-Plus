import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
let browser;
let runtime;

before(async () => {
  const source = await readFile('src/projects/common.ts', 'utf8');
  const parsed = ts.createSourceFile('common.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set([
    'createElement', 'createWorkResultsPanel', 'renderWorkResultsPanel', 'getWorkResultStats',
    'applyActionButtonStyle', 'applySectionCardStyle', 'createWorkResultsDetail',
    // 面板表现层 helper：createWorkResultsPanel 直接调用它们，缺一个就 ReferenceError。
    'applySectionTitleStyle', 'applyHintTextStyle', 'applyControlChrome',
    'applyThinScrollbar', 'applyScrollPaneStyle', 'ensurePanelStyleSheet',
    'createPanelStatusStrip', 'resolvePanelOuterWidth',
    // 面板顶部页签：createWorkResultsPanel 现在用它们把板块收进互斥页签。
    'createPanelTabBar', 'createPanelTabPanel', 'createPanelRenderFailureView'
  ]);
  const resetNames = new Set(['clearAndRetryWorkResults', 'patchWorkResult', 'mergeIncomingWorkResults',
    'shouldPreserveExistingWorkResult', 'hasUsableWorkResultAnswer']);
  const declarations = parsed.statements.filter((node) => ts.isFunctionDeclaration(node)
    && (names.has(node.name?.text) || resetNames.has(node.name?.text) || node.name?.text === 'syncWorkResultsControlDocument'));
  assert.equal(declarations.filter((node) => names.has(node.name?.text)).length, names.size);
  const methods = [];
  const methodNames = new Set(['setRuntimeControls', 'clearRuntimeControls', 'refresh']);
  function visit(node) {
    if (ts.isMethodDeclaration(node) && methodNames.has(node.name.getText(parsed))) methods.push(node.getText(parsed));
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(methods.length, methodNames.size);
  const pauseRuntime = ts.transpileModule(await readFile('src/projects/tab-answer-pause.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText.replace(/^export /gm, '');
  const pauseSubscription = parsed.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => item.name.getText(parsed) === 'unsubscribeTabAnswerPause'));
  assert.ok(pauseSubscription);
  runtime = ts.transpileModule(`(() => {
    ${pauseRuntime}
    // 面板表现层常量：与 common.ts 同名同值（顺带把红线钉死在测试里）。
    const PANEL_TOUCH_TARGET_MIN_HEIGHT = '32px';
    const PANEL_SCROLL_STYLE_ID = 'chaoxing-plus-panel-scroll-style';
    const PANEL_NARROW_VIEWPORT_PX = 400;
    const PANEL_MIN_VIEWPORT_MARGIN = 12;
    const state = {
      panels: { workResults: { root: document.querySelector('#panel'), body: document.querySelector('#body') } },
      workResults: { results: [], type: 'numbers', currentResultIndex: 0, runtimeControls: undefined,
        controlDocument: document, resetGeneration: 0 },
      apps: { localQuestionCaches: [] }
    };
    const panelPinkTheme = new Proxy({}, { get: () => '#e5e7eb' });
    const panelShadowColor = () => 'transparent';
    const isWindowsHostRuntime = () => window.windowsExamOnly;
    const canShowFloatingPanel = () => true;
    const mountWindowsHostLogPanel = () => undefined;
    const getStudySettingValue = (_name, fallback) => fallback;
    const createConfigField = () => document.createElement('label');
    const createMetricChip = (label, value) => createElement('span', { text: label + value });
    const createTikuAdapterConfigSection = () => document.createElement('section');
    const createStudySettingsPanel = () => document.createElement('section');
    const applyQuestionTextWrapStyle = () => {};
    const formatQuestionTypeLabel = (type) => type;
    const createStatusBadge = () => document.createElement('span');
    const createErrorSummaryBlock = (error) => createElement('div', { text: error });
    const resolvePanelActivityState = () => ({ state: 'idle', label: '空闲', detail: 'detail', tone: 'idle', pulse: false });
    const describeSearchErrorNextStep = () => '下一步：重试。';
    const resolveWorkResultTone = () => 'success';
    const formatWorkResultStatus = () => '已完成';
    const setWorkResultsView = (type) => { state.workResults.type = type; renderWorkResultsPanel(); };
    const setWorkResults = (results) => { state.workResults.results = mergeIncomingWorkResults(results); renderWorkResultsPanel(); };
    const $message = { error: (message) => window.panelErrors.push(message) };
    window.panelErrors = [];
    ${declarations.map((node) => node.getText(parsed)).join('\n')}
    const tabAnswerPause = getTabAnswerPauseController();
    ${pauseSubscription.getText(parsed)}
    const methods = { ${methods.join(',\n')} };
    let current;
    const workers = {};
    window.panelHarness = {
      ...methods,
      attach(id, running = true, stopped = false, render = true, page = 'main') {
        current = workers[id] = { running, stopped, stops: 0, continues: 0 };
        const worker = current;
        const controls = {
          ownerDocument: page === 'main' ? document : document.querySelector('#child').contentDocument,
          isRunning: () => worker.running,
          isStopped: () => worker.stopped,
          stop() { worker.stopped = true; worker.stops += 1; },
          continuate() { worker.stopped = false; worker.continues += 1; }
        };
        if (render) methods.setRuntimeControls(controls);
        else state.workResults.runtimeControls = controls;
      },
      update(patch, render = true) { Object.assign(current, patch); if (render) methods.refresh(); },
      results() { setWorkResults([{ question: 'Question', requested: true, resolved: true, searchInfos: [] }]); },
      attachLateRetry() {
        let release;
        const events = [];
        window.lateRetryHarness = { events, release: () => release(), results: () => state.workResults.results };
        setWorkResults([{ question: 'Q', requested: true, resolved: true, finish: true,
          searchInfos: [{ results: [['Q', 'Old answer']] }] }]);
        methods.setRuntimeControls({ ownerDocument: document,
          isRunning: () => false, isStopped: () => false, stop() {}, continuate() {},
          canRetryQuestion: () => true,
          prepareReset() { events.push('cancel'); },
          clearAnswers() { events.push('clear'); },
          async retryQuestion(index, resetAnswer) {
            if (resetAnswer) {
              events.push('new-retry');
              return { question: 'Q', requested: true, resolved: true, finish: true,
                searchInfos: [{ results: [['Q', 'New answer']] }] };
            }
            events.push('old-retry');
            await new Promise((resolve) => { release = resolve; });
            events.push('old-settled');
            return undefined;
          }
        });
      },
      attachResettable(page = 'main') {
        const doc = page === 'main' ? document : document.querySelector('#child').contentDocument;
        const questions = doc.createElement('div');
        questions.id = 'questions';
        questions.innerHTML = '<input type="checkbox" checked><textarea>Old answer</textarea>';
        doc.body.append(questions);
        const events = [];
        let release;
        let releaseReset;
        window.resetHarness = {
          events, release: () => release?.(), results: () => state.workResults.results,
          failReset: false, busy: false, retrySnapshots: [],
          releaseReset: () => releaseReset?.()
        };
        setWorkResults([0, 1].map((index) => ({ question: 'Q' + index, requested: true, resolved: true,
          finish: true, manual: true, error: 'Old error', searching: true, retrying: false,
          searchInfos: [{ results: [['Q', 'Old answer']] }] })));
        methods.setRuntimeControls({ ownerDocument: doc,
          isRunning: () => window.resetHarness.busy,
          isStopped: () => false, stop() {}, continuate() {},
          canRetryQuestion: () => !window.resetHarness.busy,
          async prepareReset() {
            events.push('cancel');
            if (window.resetHarness.busy) await new Promise((resolve) => { releaseReset = resolve; });
            window.resetHarness.busy = false;
          },
          async clearAnswers() {
            events.push('clear');
            if (window.resetHarness.failReset) throw new Error('Reset failed');
            questions.querySelector('input').checked = false;
            questions.querySelector('textarea').value = '';
          },
          async retryQuestion(index) {
            events.push('retry' + index);
            window.resetHarness.retrySnapshots.push(JSON.parse(JSON.stringify(state.workResults.results)));
            if (index === 0) await new Promise((resolve) => { release = resolve; });
            return { question: 'Q' + index, requested: true, resolved: true, finish: true,
              searchInfos: [{ results: [['Q', 'New answer']] }] };
          }
        });
      },
      workers: () => JSON.parse(JSON.stringify(workers))
    };
    renderWorkResultsPanel();
  })();`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
  browser = await puppeteer.launch({
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking']
  });
});

after(async () => { await browser?.close(); });

async function openPanel(t, windowsExamOnly = false) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.setContent('<!doctype html><html><body><div id="panel"><div id="body"></div></div><iframe id="child"></iframe></body></html>');
  await page.evaluate((value) => { window.windowsExamOnly = value; }, windowsExamOnly);
  await page.addScriptTag({ content: runtime });
  return page;
}

async function pauseControl(page) {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('#panel button'))
      .filter((button) => button.textContent === '暂停答题' || button.textContent === '继续答题');
    return buttons.map((button) => ({
      text: button.textContent,
      disabled: button.disabled,
      visible: !!button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden'
    }));
  });
}

async function clickPauseControl(page) {
  await page.evaluate(() => Array.from(document.querySelectorAll('#panel button'))
    .find((button) => button.textContent === '暂停答题' || button.textContent === '继续答题')?.click());
}

for (const windowsExamOnly of [false, true]) {
  test(`pause control stays visible through the worker lifecycle (${windowsExamOnly ? 'Windows' : 'extension'} panel)`, async (t) => {
    const page = await openPanel(t, windowsExamOnly);
    assert.deepEqual(await pauseControl(page), [{ text: '暂停答题', disabled: false, visible: true }]);
    await page.evaluate(() => window.panelHarness.attach('worker', false));
    assert.deepEqual(await pauseControl(page), [{ text: '暂停答题', disabled: false, visible: true }]);
    await page.evaluate(() => window.panelHarness.update({ running: true }));
    assert.deepEqual(await pauseControl(page), [{ text: '暂停答题', disabled: false, visible: true }]);
    await clickPauseControl(page);
    assert.deepEqual(await pauseControl(page), [{ text: '继续答题', disabled: false, visible: true }]);
    await clickPauseControl(page);
    assert.deepEqual(await pauseControl(page), [{ text: '暂停答题', disabled: false, visible: true }]);
    await page.evaluate(() => window.panelHarness.results());
    await page.evaluate(() => Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '清空结果').click());
    assert.deepEqual(await pauseControl(page), [{ text: '暂停答题', disabled: false, visible: true }]);
    await page.evaluate(() => window.panelHarness.update({ running: false }));
    assert.deepEqual(await pauseControl(page), [{ text: '暂停答题', disabled: false, visible: true }]);
    await clickPauseControl(page);
    await page.evaluate(() => window.panelHarness.clearRuntimeControls());
    assert.deepEqual(await pauseControl(page), [{ text: '继续答题', disabled: false, visible: true }]);
    assert.deepEqual(await page.evaluate(() => window.panelHarness.workers()), {
      worker: { running: false, stopped: false, stops: 1, continues: 1 }
    });
  });
}

test('pause control reads the current worker and pause state at click time', async (t) => {
  const page = await openPanel(t);
  await page.evaluate(() => window.panelHarness.attach('old'));
  await page.evaluate(() => window.panelHarness.attach('new', true, true, false));
  await clickPauseControl(page);
  assert.deepEqual(await page.evaluate(() => window.panelHarness.workers()), {
    old: { running: true, stopped: false, stops: 0, continues: 0 },
    new: { running: true, stopped: false, stops: 0, continues: 1 }
  });
  await page.evaluate(() => window.panelHarness.update({ stopped: true }, false));
  await clickPauseControl(page);
  assert.equal((await page.evaluate(() => window.panelHarness.workers())).new.continues, 2);
  await page.evaluate(() => window.panelHarness.update({ running: false }, false));
  await clickPauseControl(page);
  assert.equal((await page.evaluate(() => window.panelHarness.workers())).new.stops, 0);
  assert.deepEqual(await pauseControl(page), [{ text: '继续答题', disabled: false, visible: true }]);
});

test('idle pause applies to the next worker throughout the current tab', async (t) => {
  const page = await openPanel(t);
  await clickPauseControl(page);
  assert.deepEqual(await pauseControl(page), [{ text: '继续答题', disabled: false, visible: true }]);
  await page.evaluate(() => window.panelHarness.attach('first', false));
  assert.deepEqual((await page.evaluate(() => window.panelHarness.workers())).first, {
    running: false, stopped: true, stops: 1, continues: 0
  });
  await page.evaluate(() => window.panelHarness.update({ running: true }));
  await clickPauseControl(page);
  assert.deepEqual((await page.evaluate(() => window.panelHarness.workers())).first, {
    running: true, stopped: false, stops: 1, continues: 1
  });
  await clickPauseControl(page);
  await page.evaluate(() => window.panelHarness.clearRuntimeControls());
  assert.deepEqual(await pauseControl(page), [{ text: '继续答题', disabled: false, visible: true }]);
  await page.evaluate(() => window.panelHarness.attach('samePage'));
  assert.equal((await page.evaluate(() => window.panelHarness.workers())).samePage.stopped, true);
  await page.evaluate(() => window.panelHarness.attach('nextPage', true, false, true, 'child'));
  assert.deepEqual(await pauseControl(page), [{ text: '继续答题', disabled: false, visible: true }]);
  assert.equal((await page.evaluate(() => window.panelHarness.workers())).nextPage.stops, 1);
});

test('navigating the task iframe preserves its tab pause intention', async (t) => {
  const page = await openPanel(t);
  await page.evaluate(() => window.panelHarness.attach('beforeNavigation', true, false, true, 'child'));
  await clickPauseControl(page);
  await page.evaluate(() => new Promise((resolve) => {
    const frame = document.querySelector('#child');
    frame.onload = resolve;
    frame.srcdoc = '<p>New task document</p>';
  }));
  await page.evaluate(() => window.panelHarness.attach('afterNavigation', true, false, true, 'child'));
  assert.deepEqual(await pauseControl(page), [{ text: '继续答题', disabled: false, visible: true }]);
  assert.equal((await page.evaluate(() => window.panelHarness.workers())).afterNavigation.stops, 1);
});

for (const owner of ['main', 'child']) {
  test(`clear results clears answers before retrying every question (${owner})`, async (t) => {
    const page = await openPanel(t);
    await page.evaluate((owner) => window.panelHarness.attachResettable(owner), owner);
    await page.evaluate(() => Array.from(document.querySelectorAll('#panel button'))
      .find((button) => button.textContent === '清空结果').click());
    const beforeRetry = await page.evaluate((owner) => {
      const doc = owner === 'main' ? document : document.querySelector('#child').contentDocument;
      return { events: window.resetHarness.events, checked: doc.querySelector('#questions input').checked,
        text: doc.querySelector('#questions textarea').value, snapshots: window.resetHarness.retrySnapshots };
    }, owner);
    assert.deepEqual(beforeRetry.events, ['cancel', 'clear', 'retry0']);
    assert.equal(beforeRetry.checked, false);
    assert.equal(beforeRetry.text, '');
    assert.deepEqual(beforeRetry.snapshots[0].map((item) => ({ requested: item.requested, resolved: item.resolved,
      finish: item.finish, manual: item.manual, searchInfos: item.searchInfos, error: item.error })),
    [0, 1].map(() => ({ requested: false, resolved: false, finish: false, manual: false, searchInfos: [], error: undefined })));
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('#panel button'))
        .find((button) => /清空结果|正在重新作答/.test(button.textContent)).click();
      window.resetHarness.release();
    });
    await page.waitForFunction(() => window.resetHarness.events.includes('retry1'));
    assert.deepEqual(await page.evaluate(() => ({ events: window.resetHarness.events,
      answers: window.resetHarness.results().map((item) => item.searchInfos[0]?.results[0][1]),
      manual: window.resetHarness.results().map((item) => item.manual) })),
    { events: ['cancel', 'clear', 'retry0', 'retry1'], answers: ['New answer', 'New answer'], manual: [false, false] });
    assert.deepEqual(await pauseControl(page), [{ text: '暂停答题', disabled: false, visible: true }]);
  });
}

test('clear results stays clickable during active work and cancels before clearing', async (t) => {
  const page = await openPanel(t);
  await page.evaluate(() => {
    window.panelHarness.attachResettable();
    window.resetHarness.busy = true;
    window.panelHarness.refresh();
  });
  assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll('#panel button'))
    .find((button) => button.textContent === '清空结果').disabled), false);
  await page.evaluate(() => Array.from(document.querySelectorAll('#panel button'))
    .find((button) => button.textContent === '清空结果').click());
  assert.deepEqual(await page.evaluate(() => window.resetHarness.events), ['cancel']);
  await page.evaluate(() => window.resetHarness.releaseReset());
  await page.waitForFunction(() => window.resetHarness.events.includes('retry0'));
  await page.evaluate(() => window.resetHarness.release());
  await page.waitForFunction(() => window.resetHarness.events.includes('retry1'));
});

test('clear results keeps old results on reset failure', async (t) => {
  const page = await openPanel(t);
  await page.evaluate(() => window.panelHarness.attachResettable());
  await page.evaluate(() => {
    window.resetHarness.busy = false;
    window.resetHarness.failReset = true;
    window.panelHarness.refresh();
    Array.from(document.querySelectorAll('#panel button')).find((button) => button.textContent === '清空结果').click();
  });
  assert.deepEqual(await page.evaluate(() => ({ events: window.resetHarness.events,
    finished: window.resetHarness.results().map((item) => item.finish), errors: window.panelErrors })),
  { events: ['cancel', 'clear'], finished: [true, true], errors: ['清空作答失败：Reset failed'] });
});

test('switching tasks while a cleared question retries cannot overwrite the new task', async (t) => {
  const page = await openPanel(t);
  await page.evaluate(() => window.panelHarness.attachResettable());
  await page.evaluate(() => Array.from(document.querySelectorAll('#panel button'))
    .find((button) => button.textContent === '清空结果').click());
  await page.evaluate(() => { window.panelHarness.attach('new', false); window.panelHarness.results(); });
  await page.evaluate(() => window.resetHarness.release());
  assert.deepEqual(await page.evaluate(() => window.resetHarness.results().map((item) => item.question)), ['Question']);
  assert.deepEqual(await page.evaluate(() => window.resetHarness.events), ['cancel', 'clear', 'retry0']);
});

test('a manual retry settling after clear finishes cannot restore the old answer', async (t) => {
  const page = await openPanel(t);
  await page.evaluate(() => window.panelHarness.attachLateRetry());
  await page.evaluate(() => Array.from(document.querySelectorAll('#panel button'))
    .find((button) => button.textContent === '重答本题').click());
  assert.deepEqual(await page.evaluate(() => window.lateRetryHarness.events), ['old-retry']);
  await page.evaluate(() => Array.from(document.querySelectorAll('#panel button'))
    .find((button) => button.textContent === '清空结果').click());
  await page.waitForFunction(() => window.lateRetryHarness.events.includes('new-retry')
    && Array.from(document.querySelectorAll('#panel button')).some((button) => button.textContent === '清空结果'));
  const answer = () => page.evaluate(() => window.lateRetryHarness.results()[0].searchInfos[0]?.results[0][1]);
  assert.equal(await answer(), 'New answer');
  await page.evaluate(async () => {
    window.lateRetryHarness.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.deepEqual(await page.evaluate(() => window.lateRetryHarness.events), ['old-retry', 'cancel', 'clear', 'new-retry', 'old-settled']);
  assert.equal(await answer(), 'New answer');
});

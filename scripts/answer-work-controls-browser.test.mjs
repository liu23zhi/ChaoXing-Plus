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
    'applyActionButtonStyle', 'applySectionCardStyle'
  ]);
  const declarations = parsed.statements.filter((node) => ts.isFunctionDeclaration(node)
    && (names.has(node.name?.text) || node.name?.text === 'syncWorkResultsControlDocument'));
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
    const state = {
      panels: { workResults: { root: document.querySelector('#panel'), body: document.querySelector('#body') } },
      workResults: { results: [], type: 'numbers', currentResultIndex: 0, runtimeControls: undefined,
        controlDocument: document },
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
    const createWorkResultsDetail = () => document.createElement('section');
    const resolveWorkResultTone = () => 'success';
    const formatWorkResultStatus = () => '已完成';
    const setWorkResultsView = (type) => { state.workResults.type = type; renderWorkResultsPanel(); };
    const setWorkResults = (results) => { state.workResults.results = results; renderWorkResultsPanel(); };
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
      results() { setWorkResults([{ question: 'Question', requested: true, resolved: true }]); },
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

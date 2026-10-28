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
  const source = await readFile('src/projects/cx.ts', 'utf8');
  const parsed = ts.createSourceFile('cx.ts', source, ts.ScriptTarget.Latest, true);
  const names = [
    'isWindowsHostRuntime', 'getWindowsRuntimeSetting', 'normalizeWindowsAnswerKey',
    'matchesWindowsAnswerKey', 'formatWindowsAnswerKey', 'isWindowsManualAnswerMode',
    'createWindowsManualAnswerGate', 'clearTopCenterNotice', 'showTopCenterNotice'
  ];
  const functions = names.map((name) => {
    const statement = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(statement, `Missing runtime function: ${name}`);
    return statement.getText(parsed);
  });
  const noticeId = parsed.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((declaration) => declaration.name.getText(parsed) === 'TOP_CENTER_NOTICE_ID'));
  assert.ok(noticeId, 'Missing notice element identifier');
  const compiled = ts.transpileModule([...functions, noticeId.getText(parsed)].join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 }
  }).outputText;
  runtime = `(() => {
    let topWindow = window.top;
    const DEFAULT_WORKER_THREAD_COUNT = 4;
    const settings = {};
    const runtimeStore = { get(key, fallback) { return Object.hasOwn(settings, key) ? settings[key] : fallback; } };
    ${compiled}
    window.__noticeTest = {
      id: TOP_CENTER_NOTICE_ID,
      configure(windows, panel) {
        if (windows) window.__CX_WIN_HOST__ = {};
        else delete window.__CX_WIN_HOST__;
        if (panel === undefined) delete settings['common.settings.windows-panel-enabled'];
        else settings['common.settings.windows-panel-enabled'] = panel;
        settings['common.settings.windows-answer-mode'] = 'manual';
        settings['common.settings.windows-answer-key'] = 'Ctrl+Alt+Shift+S';
        settings['common.settings.windows-answer-threads'] = 2;
      },
      show: showTopCenterNotice,
      clear: clearTopCenterNotice,
      gate: createWindowsManualAnswerGate
    };
  })();`;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server']
  });
});

after(async () => { await browser?.close(); });

async function pageFor(t) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent('<!doctype html><html><body><main>Notice regression</main></body></html>');
  await page.addScriptTag({ content: runtime });
  return page;
}

test('Windows no-panel suppresses notices and removes a notice created before the panel was disabled', async (t) => {
  const page = await pageFor(t);
  const state = await page.evaluate(() => {
    const api = window.__noticeTest;
    api.configure(true, true);
    api.show('visible first', { duration: 0 });
    const initiallyVisible = Boolean(document.getElementById(api.id));
    api.configure(true, false);
    api.show('must stay hidden', { duration: 0 });
    return { initiallyVisible, noticeCount: document.querySelectorAll('#' + api.id).length };
  });
  assert.deepEqual(state, { initiallyVisible: true, noticeCount: 0 });
});

test('Windows panel-enabled and default settings preserve notice content and explicit cleanup', async (t) => {
  const page = await pageFor(t);
  for (const panel of [true, undefined]) {
    const state = await page.evaluate((enabled) => {
      const api = window.__noticeTest;
      api.configure(true, enabled);
      api.show('visible notice', { duration: 0 });
      const element = document.getElementById(api.id);
      const visible = { text: element?.textContent, position: element?.style.position };
      api.clear();
      return { ...visible, remaining: Boolean(document.getElementById(api.id)) };
    }, panel);
    assert.deepEqual(state, { text: 'visible notice', position: 'fixed', remaining: false });
  }
});

test('extension notices ignore a stale Windows panel setting and keep timed cleanup', async (t) => {
  const page = await pageFor(t);
  const text = await page.evaluate(() => {
    const api = window.__noticeTest;
    api.configure(false, false);
    api.show('extension notice', { duration: 80 });
    return document.getElementById(api.id)?.textContent;
  });
  assert.equal(text, 'extension notice');
  await page.waitForFunction(() => !document.getElementById(window.__noticeTest.id));
});

test('manual no-panel answer gate grants permits without notices and close still clears notices and listeners', async (t) => {
  const page = await pageFor(t);
  const state = await page.evaluate(async () => {
    const api = window.__noticeTest;
    api.configure(true, false);
    const gate = api.gate([document]);
    const readyNotice = Boolean(document.getElementById(api.id));
    const permits = Promise.all([gate.wait(), gate.wait()]);
    const event = new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, altKey: true, shiftKey: true, cancelable: true });
    document.dispatchEvent(event);
    await permits;
    const triggeredNotice = Boolean(document.getElementById(api.id));
    api.clear();
    const stale = document.createElement('div');
    stale.id = api.id;
    document.body.append(stale);
    gate.close();
    const afterClose = new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, altKey: true, shiftKey: true, cancelable: true });
    document.dispatchEvent(afterClose);
    return { readyNotice, triggeredNotice, keyHandled: event.defaultPrevented, closedNotice: Boolean(document.getElementById(api.id)), closedKeyHandled: afterClose.defaultPrevented };
  });
  assert.deepEqual(state, { readyNotice: false, triggeredNotice: false, keyHandled: true, closedNotice: false, closedKeyHandled: false });
});

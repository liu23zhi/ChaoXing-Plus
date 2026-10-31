import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
let browser;
let server;
let fixtureUrl;
let runtime;

function extractRuntime(source) {
  const parsed = ts.createSourceFile('cx.ts', source, ts.ScriptTarget.Latest, true);
  const functionNames = new Set([
    'isChapterTestExpired',
    'readManualAnswerDecision',
    'publishManualAnswerDecision',
    'waitForManualAnswerDecision',
    'hasManualAnswerDeclined',
    'rememberManualAnswerDeclined',
    'confirmBeforeAutoAnswer'
  ]);
  const variableNames = new Set([
    'manualAnswerDeclinedKey',
    'manualAnswerDeclinedAttribute',
    'manualAnswerDecisionAttribute',
    'manualAnswerDecisionEvent',
    'manualAnswerDecisionWaitMs',
    'manualAnswerDeclinedInMemory',
    'manualAnswerDecisionPromise'
  ]);
  const foundFunctions = new Set();
  const foundVariables = new Set();
  const declarations = [];
  for (const node of parsed.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && functionNames.has(node.name.text)) {
      foundFunctions.add(node.name.text);
      declarations.push(node.getText(parsed));
    } else if (ts.isVariableStatement(node)) {
      const matching = node.declarationList.declarations.filter((declaration) =>
        ts.isIdentifier(declaration.name) && variableNames.has(declaration.name.text));
      if (matching.length > 0) {
        for (const declaration of matching) foundVariables.add(declaration.name.text);
        declarations.push(node.getText(parsed));
      }
    }
  }
  assert.deepEqual([...foundFunctions].sort(), [...functionNames].sort());
  assert.deepEqual([...foundVariables].sort(), [...variableNames].sort());
  return ts.transpileModule(`(() => {
    const topWindow = window.top;
    const isWindowsManualAnswerMode = () => false;
    const getWindowsRuntimeSetting = (name, fallback) => name === 'answer-countdown' ? 0 : fallback;
    const $modal = { confirm: (options) => topWindow.__manualAnswerHarness.open(options) };
    const $message = { warn: () => { topWindow.__manualAnswerHarness.warnings += 1; } };
    ${declarations.join('\n')}
    const calls = {};
    const api = {
      expired: () => isChapterTestExpired(document),
      calls,
      start(label) {
        const call = calls[label] = { events: [], settled: false, result: null };
        void confirmBeforeAutoAnswer({ emit: (event) => call.events.push(event) })
          .then((result) => { call.result = result; call.settled = true; });
      }
    };
    (window.__cxExpiryModules ||= []).push(api);
  })();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText;
}

before(async () => {
  runtime = extractRuntime(await readFile('src/projects/cx.ts', 'utf8'));
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><title>Chapter expiry fixture</title></head><body><h1>Chapter fixture</h1></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
  browser = await puppeteer.launch({
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking'],
    defaultViewport: { width: 1000, height: 800 }
  });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function openPage() {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.url().startsWith(fixtureUrl)) void request.continue();
    else void request.abort();
  });
  await page.goto(fixtureUrl);
  return { page, errors };
}

async function addFrame(parent, id) {
  await parent.evaluate(({ id, src }) => {
    const frame = document.createElement('iframe');
    frame.id = id;
    frame.src = src;
    document.body.appendChild(frame);
  }, { id, src: `${fixtureUrl}${id}` });
  const element = await parent.waitForSelector(`#${id}`);
  const frame = await element.contentFrame();
  await frame.waitForFunction((expected) => location.href === expected && document.readyState === 'complete', {}, `${fixtureUrl}${id}`);
  return frame;
}

function chapterFixture(statusMarkup, extraMarkup = '') {
  return `<div class="RightCon newTestCon" id="RightCon"><div class="radiusBG"><div class="CeYan">
    <div class="ceyan_name"><h3>1.1 Sample chapter</h3>${statusMarkup}</div>
    <form id="form1"><div class="singleQuesId"><div class="TiMu newTiMu"><div class="Zy_TItle">Question</div>
    <ul class="Zy_ulTop"><li>Option A</li><li>Option B</li></ul></div></div></form>
    ${extraMarkup}</div></div></div>`;
}

async function evaluateExpiry(frame, markup) {
  await frame.evaluate((markup) => { document.body.innerHTML = markup; }, markup);
  return frame.evaluate(() => window.__cxExpiryModules[0].expired());
}

test('Chromium recognises the chapter status block while ignoring deadlines and quoted question content', async () => {
  const { page, errors } = await openPage();
  try {
    await page.addScriptTag({ content: runtime });
    assert.equal(await evaluateExpiry(page, chapterFixture(
      '<p><span>题量: 6</span><span>截止时间: 2026-10-12 18:41:00</span><span class="orangeColor">（已截止，不能作答）</span></p>'
    )), true);
    assert.equal(await evaluateExpiry(page, chapterFixture(
      '<p><span>题量: 6</span><span>截止时间: 2026-12-12 18:41:00</span></p>'
    )), false);
    assert.equal(await evaluateExpiry(page, chapterFixture(
      '<p><span>截止时间: 2026-10-12 18:41:00</span><span class="orangeColor">已截止，但允许补交</span></p>'
    )), false);
    assert.equal(await evaluateExpiry(page, chapterFixture(
      '<p><span>截止时间: 2026-12-12 18:41:00</span></p>',
      '<div class="newTestTitle">已截止，不能作答</div><div class="TiMu"><span class="orangeColor">（已截止，不能作答）</span><ul><li>题面引用：已截止，不能作答</li></ul></div><script type="application/json">{"msg":"此作业已过期！","status":false}</script>'
    )), false);
    assert.equal(await evaluateExpiry(page, chapterFixture(
      '<p><span>截止时间: 2026-10-12 18:41:00</span></p><p><span class="orangeColor">（已截止，不能作答）</span></p>'
    )), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Chromium keeps expiry detection scoped to the actual document in nested chapter frames', async () => {
  const { page, errors } = await openPage();
  try {
    const middle = await addFrame(page, 'chapter-middle');
    const inner = await addFrame(middle, 'chapter-inner');
    for (const frame of [page, middle, inner]) await frame.addScriptTag({ content: runtime });
    await page.evaluate((markup) => document.body.insertAdjacentHTML('beforeend', markup), chapterFixture(
      '<p><span>截止时间: 2026-10-12 18:41:00</span><span class="orangeColor">（已截止，不能作答）</span></p>'
    ));
    await middle.evaluate((markup) => document.body.insertAdjacentHTML('beforeend', markup), chapterFixture(
      '<p><span>截止时间: 2026-12-12 18:41:00</span></p>'
    ));
    await inner.evaluate((markup) => document.body.insertAdjacentHTML('beforeend', markup), chapterFixture(
      '<p><span>截止时间：2026-10-12 18:41:00</span><span class="orangeColor">（ 已截止， 不能作答 ）</span></p>'
    ));
    assert.deepEqual(await Promise.all([page, middle, inner].map((frame) =>
      frame.evaluate(() => window.__cxExpiryModules[0].expired()))), [true, false, true]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Chromium shares a pending manual-answer decision across frame modules and never asks again after manual choice', async () => {
  const { page, errors } = await openPage();
  try {
    const middle = await addFrame(page, 'manual-middle');
    const inner = await addFrame(middle, 'manual-inner');
    await page.evaluate(() => {
      window.__manualAnswerHarness = {
        opened: 0,
        warnings: 0,
        open(options) {
          this.opened += 1;
          return new Promise((resolve) => {
            const dialog = document.createElement('section');
            dialog.setAttribute('role', 'dialog');
            const button = document.createElement('button');
            button.id = 'manual-answer-choice';
            button.textContent = options.cancelButtonText;
            button.onclick = () => { dialog.remove(); resolve(false); };
            dialog.appendChild(button);
            document.body.appendChild(dialog);
          });
        }
      };
    });
    for (const frame of [page, middle, inner]) {
      await frame.addScriptTag({ content: runtime });
      await frame.addScriptTag({ content: runtime });
    }
    for (const frame of [page, middle, inner]) {
      await frame.evaluate(() => {
        window.__cxExpiryModules[0].start('first');
        window.__cxExpiryModules[0].start('parallel');
        window.__cxExpiryModules[1].start('independent');
      });
    }
    assert.equal(await page.evaluate(() => window.__manualAnswerHarness.opened), 1);
    assert.equal(await page.$$eval('[role="dialog"]', (elements) => elements.length), 1);
    await page.click('#manual-answer-choice');
    for (const frame of [page, middle, inner]) {
      await frame.waitForFunction(() => window.__cxExpiryModules.every((module) =>
        Object.values(module.calls).every((call) => call.settled)));
      const calls = await frame.evaluate(() => window.__cxExpiryModules.flatMap((module) => Object.values(module.calls)));
      assert.equal(calls.length, 3);
      for (const call of calls) {
        assert.equal(call.result, false);
        assert.deepEqual(call.events, ['stop']);
      }
      await frame.evaluate(() => {
        window.__cxExpiryModules[0].start('again');
        window.__cxExpiryModules[1].start('again');
      });
      await frame.waitForFunction(() => window.__cxExpiryModules.every((module) => module.calls.again.settled));
    }
    assert.equal(await page.evaluate(() => window.__manualAnswerHarness.opened), 1);
    assert.equal(await page.$$eval('[role="dialog"]', (elements) => elements.length), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

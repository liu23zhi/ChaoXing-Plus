import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
const origin = 'https://mooc1.chaoxing.com';
const courseUrl = `${origin}/mycourse/studentstudy?courseId=course&clazzid=class&chapterId=chapter&mooc2=1`;
let browser;
let fixtureDirectory;

before(async () => {
  fixtureDirectory = await mkdtemp(resolveTestPath('.tmp-tests-cx-runtime-integration-'));
  await mkdir(resolve(fixtureDirectory, 'vendor'));
  await copyFile('dist/chaoxing-plus.js', resolve(fixtureDirectory, 'chaoxing-plus.js'));
  await copyFile('dist/extension-entry.js', resolve(fixtureDirectory, 'extension-entry.js'));
  await copyFile('dist/extension-tab-pause.js', resolve(fixtureDirectory, 'extension-tab-pause.js'));
  for (const name of ['sweetalert2.all.min.js', 'sweetalert2.min.css']) {
    await copyFile(resolve('dist/vendor', name), resolve(fixtureDirectory, 'vendor', name));
  }
  const productionManifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
  await writeFile(resolve(fixtureDirectory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Local complete runtime fixture', version: '1.0.0', permissions: ['storage'],
    background: productionManifest.background,
    host_permissions: ['*://*.chaoxing.com/*'],
    content_scripts: productionManifest.content_scripts,
    web_accessible_resources: productionManifest.web_accessible_resources
  }));
  browser = await puppeteer.launch({
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    headless: true, pipe: true, enableExtensions: [fixtureDirectory],
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking'],
    defaultViewport: { width: 1200, height: 1000 }
  });
});

after(async () => {
  await browser?.close();
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

function coursePage(withTask) {
  return `<!doctype html><html><head><title>Local course fixture</title></head><body>
    <input id="curCourseId" value="course"><input id="curClazzId" value="class"><input id="curChapterId" value="chapter">
    <div class="posCatalog_select posCatalog_active" id="chapter">
      <input class="jobUnfinishCount" value="1"><a onclick="getTeacherAjax('course','class','chapter')">Fixture chapter</a>
    </div><div id="prev_tab"><ul class="prev_ul"><li class="active" id="tab-1">Task tab</li></ul></div>
    ${withTask ? '<iframe id="iframe" src="/knowledge/cards?courseId=course&clazzid=class&chapterId=chapter" style="width:650px;height:600px"></iframe>' : ''}
  </body></html>`;
}

const cardsPage = `<!doctype html><html><head><title>Local cards fixture</title></head><body>
  <script>window.attachments=[{job:true,jobid:'job-A',isPassed:false,property:{_jobid:'job-A',name:'Local chapter test'}}];</script>
  <div class="ans-attach-ct"><iframe jobid="job-A" data='{"jobid":"job-A"}'
    src="/mooc-ans/api/work?courseId=course&clazzid=class&jobid=job-A" style="width:600px;height:500px"></iframe></div>
</body></html>`;

const workPage = `<!doctype html><html><head><title>Local chapter test</title></head><body>
  <div class="CeYan"><div class="ceyan_name"><h3>Local chapter test</h3></div>
  <form id="form1"><input id="jobid" name="jobid" value="job-A"><input name="courseId" value="course"><input name="clazzid" value="class">
    <div class="singleQuesId"><div class="TiMu"><input type="hidden" name="answertype1" value="0">
      <div class="Zy_TItle"><div class="clearfix">1. Fixture question</div></div><ul>
        <li><input type="radio" name="answer1" value="A"><label class="after">Alpha</label></li>
        <li><input type="radio" name="answer1" value="B"><label class="after">Beta</label></li>
      </ul></div></div>
  </form></div>
</body></html>`;

async function openPage(t, { withTask = false, existingPage } = {}) {
  const page = existingPage ?? await browser.newPage();
  t.after(() => page.close());
  page.setDefaultTimeout(12000);
  const errors = [];
  const startupErrors = [];
  const logs = [];
  const requests = [];
  let reportSearch;
  const searched = new Promise((resolve) => { reportSearch = resolve; });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    logs.push(message.text());
    if (message.text().includes('startup failed')) startupErrors.push(message.text());
  });
  t.after(() => {
    assert.deepEqual(startupErrors, [], 'whole-runtime startup must complete without errors');
    assert.deepEqual(errors, [], 'the complete bundle must not throw in the course fixture');
  });
  await page.evaluateOnNewDocument(() => {
    for (const [key, value] of Object.entries({
      'common.settings.tiku-adapter.baseurl': 'https://provider.chaoxing.com/',
      'common.settings.tiku-adapter.key': 'local-fixture-key',
      'common.settings.work-options': { period: 0, thread: 1, stopSecondWhenFinish: 0, upload: 'save',
        redundanceWordsText: '', answerSeparators: '#,|', answerMatchMode: 'includes', deepThinking: false },
      'cx.new.study.mode': 'manually',
      'cx.new.study.upload': 'save',
      'cx.new.study.enableAIFallbackAnswer': false,
      'cx.new.study.useAsyncTikuSearch': false,
      'common.settings.windows-answer-countdown': 0
    })) localStorage.setItem(key, JSON.stringify(value));
    window.__manualPrompts = 0;
    const seen = new WeakSet();
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        const popup = document.querySelector('.swal2-popup:has(.swal2-cancel)');
        if (popup && popup.querySelector('.swal2-cancel')?.textContent === '手动答题' && !seen.has(popup)) {
          seen.add(popup);
          window.__manualPrompts += 1;
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }, { once: true });
  });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'chrome-extension:' || url.protocol === 'data:' || url.protocol === 'about:') {
      void request.continue();
      return;
    }
    requests.push(`${request.method()} ${url.hostname}${url.pathname}`);
    if (url.hostname === 'provider.chaoxing.com') {
      if (request.method() !== 'OPTIONS') reportSearch();
      void request.respond({ status: 200, contentType: 'application/json', headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key'
      }, body: JSON.stringify({ question: 'Fixture question', type: 0, answer: { answerKeyText: 'A', answerText: 'Alpha' } }) });
      return;
    }
    if (url.pathname.includes('/resources/font/table.json')) {
      void request.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
      return;
    }
    if (url.pathname === '/knowledge/cards' || url.pathname === '/mooc-ans/api/work') {
      void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: url.pathname === '/knowledge/cards' ? cardsPage : workPage });
      return;
    }
    if (request.isNavigationRequest() && url.hostname.endsWith('.chaoxing.com')) {
      void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: coursePage(withTask) });
      return;
    }
    void request.abort();
  });
  await page.goto(courseUrl);
  // The first panel mount waits for the whole bundled runtime to boot in a cold Chromium profile;
  // on a shared CI runner that regularly needs more than the 12s default (observed 12s+ stalls).
  await page.waitForSelector('#panel-common-work-results', { timeout: 25000 });
  return { page, searched, requests, logs };
}

async function pauseButton(page) {
  const button = await page.evaluateHandle(() => Array.from(document.querySelectorAll('#panel-common-work-results button'))
    .filter((element) => ['暂停答题', '继续答题'].includes(element.textContent))
    .sort((left, right) => Number(right.getClientRects().length > 0) - Number(left.getClientRects().length > 0))[0]);
  assert.ok(button.asElement(), 'the real panel must contain a pause/continue button');
  return button.asElement();
}

async function expectButton(page, text) {
  await page.waitForFunction((expectedText) => Array.from(document.querySelectorAll('#panel-common-work-results button'))
    .some((element) => element.textContent === expectedText
      && !element.disabled
      && element.getClientRects().length > 0
      && getComputedStyle(element).display !== 'none'
      && getComputedStyle(element).visibility !== 'hidden'), undefined, text);
  const button = await pauseButton(page);
  const state = await button.evaluate((element) => ({ text: element.textContent, disabled: element.disabled,
    visible: element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' }));
  assert.deepEqual(state, { text, disabled: false, visible: true });
}

test('complete extension bundle keeps an available panel control and isolates pause by browser tab', { timeout: 60000 }, async (t) => {
  const { page } = await openPage(t);
  await expectButton(page, '暂停答题');
  await (await pauseButton(page)).evaluate((element) => element.click());
  await expectButton(page, '继续答题');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-chaoxing-plus-tab-pause-pending') !== 'true');
  await page.goto(`${courseUrl}&next-section=1`);
  await page.waitForSelector('#panel-common-work-results');
  await expectButton(page, '继续答题');
  const { page: separateTab } = await openPage(t);
  await expectButton(separateTab, '暂停答题');
  await (await pauseButton(separateTab)).evaluate((element) => element.click());
  await expectButton(separateTab, '继续答题');
  await (await pauseButton(page)).evaluate((element) => element.click());
  await expectButton(page, '暂停答题');
  await expectButton(separateTab, '继续答题');
});

test('complete course runtime resumes after one panel continue click following manual refusal', { timeout: 60000 }, async (t) => {
  const { page, searched, requests, logs } = await openPage(t, { withTask: true });
  await expectButton(page, '暂停答题');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.swal2-cancel'))
    .some((button) => button.textContent === '手动答题' && button.getClientRects().length > 0));
  await page.evaluate(() => Array.from(document.querySelectorAll('.swal2-cancel')).find((button) => button.textContent === '手动答题').click());
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#panel-common-work-results button'))
    .some((button) => button.textContent === '继续答题'));
  await expectButton(page, '继续答题');
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-chaoxing-plus-manual-answer-decision')), 'declined');
  assert.equal(await page.evaluate(() => window.__manualPrompts), 1);
  assert.equal(requests.some((request) => request.includes('provider.chaoxing.com')), false);
  const opened = new Promise((resolve) => page.once('popup', resolve));
  await page.evaluate(() => window.open('about:blank', '_blank'));
  const { page: newTab } = await openPage(t, { withTask: true, existingPage: await opened });
  await expectButton(newTab, '暂停答题');
  await newTab.waitForFunction(() => Array.from(document.querySelectorAll('.swal2-cancel'))
    .some((button) => button.textContent === '手动答题' && button.getClientRects().length > 0));
  assert.equal(await newTab.evaluate(() => window.__manualPrompts), 1, 'copied sessionStorage must not carry the old tab refusal');
  await (await pauseButton(page)).evaluate((element) => element.click());
  let timeout;
  try {
    await Promise.race([searched, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`No provider request after continue: ${requests.join(', ')}\n${logs.slice(-30).join('\n')}`)), 15000);
    })]);
  } finally { clearTimeout(timeout); }
  await expectButton(page, '暂停答题');
  assert.equal(await page.evaluate(() => window.__manualPrompts), 1);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-chaoxing-plus-manual-answer-declined')), false);
});

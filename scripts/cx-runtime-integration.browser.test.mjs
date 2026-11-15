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
const workUrl = `${origin}/mooc2/work/dowork?courseId=course&classId=class&workId=work&answerId=0`;
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
  // ⚠️ 关闭要彻底（本轮修复）。
  //
  // 症状：node:test 报「Test hook "before" generated asynchronous activity after
  // the test ended」——它是**文件级**失败，3 条业务断言其实全绿。
  //
  // 原因：本文件用 `pipe: true` 与 Chrome 通信，close() 之后管道读取流仍可能有
  // 一小段尾随活动（puppeteer 的 pipe transport 在 close 时不保证 drain 完毕），
  // node:test 把「hook 结束后仍有异步活动」当失败处理。
  //
  // 修法：close() 之后显式等进程退出，再兜底 kill，确保不留活动。
  // 不用 `browser.disconnect()`：那会让进程脱离管理，变成真正的孤儿 Chrome。
  if (browser) {
    const chromeProcess = browser.process();
    await browser.close().catch(() => {});
    if (chromeProcess && chromeProcess.exitCode === null && !chromeProcess.killed) {
      await new Promise((resolveDone) => {
        const timer = setTimeout(() => {
          try { chromeProcess.kill(); } catch { /* 已退出 */ }
          resolveDone();
        }, 2000);
        chromeProcess.once('exit', () => { clearTimeout(timer); resolveDone(); });
      });
    }
  }
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
        <li><input type="radio" name="answer1" value="A"><span class="num_option">A</span><label class="after">Alpha</label></li>
        <li><input type="radio" name="answer1" value="B"><span class="num_option">B</span><label class="after">Beta</label></li>
      </ul></div></div>
  </form></div>
</body></html>`;

async function openPage(t, { withTask = false, existingPage, pageKind = 'course' } = {}) {
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
    // 某个 script 初始化失败必须显式变红（本轮新增）。
    //
    // start() 现在按 script 隔离错误，一个失败不再中断后面的 script —— 面板会照常
    // 挂上。但「面板出来了」不等于「功能是好的」：CI run 43666425749 的 work 页上，
    // 失败点从 `#panel-common-work-results` 推后到 `.swal2-popup .swal2-cancel`，
    // 说明面板被救回来了、work 逻辑仍然坏。
    //
    // 放在 t.after 而不是 openPage 返回前：start() 是异步的，oncomplete 可能在
    // openPage 返回之后才跑完（实测放在返回前一次都没捕获到）。
    const scriptFailures = logs.filter((line) => /\] script .+ failed/.test(line));
    assert.deepEqual(scriptFailures, [], 'no script may fail to initialize; logs=' + JSON.stringify(logs.slice(-12)));
  });
  await page.evaluateOnNewDocument(() => {
    for (const [key, value] of Object.entries({
      'common.settings.tiku-adapter.baseurl': 'https://provider.chaoxing.com/',
      'common.settings.tiku-adapter.key': 'local-fixture-key',
      // searchDelaySeconds 才是 answerer 搜题前等待（秒）；0 = 不等待，加速夹具。
      'common.settings.work-options': { searchDelaySeconds: 0, thread: 1, stopSecondWhenFinish: 0, upload: 'save',
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
      // ⚠️ 预检（OPTIONS）与真实请求必须分开处理，且**都要 return**。
      //
      // 两个历史缺陷（CI run 43651620853 / 本地实测）：
      //
      // ① 原实现对这个域名 respond 后**没有 return**，控制流会继续落到下面的
      //    /knowledge/cards、/mooc2/work/dowork 等分支，对同一个 request 再次
      //    respond → puppeteer 抛 `Error: Request is already handled`。
      //    表现为文件级失败（"Test hook before generated asynchronous activity"），
      //    3 条业务断言其实全绿，极易被误读成功能坏了。
      //
      // ② OPTIONS 不能带 JSON body：预检只要头部，带 body 会让浏览器把响应
      //    当成实际响应体缓存起来，后续真实请求的解析随之错位。
      //
      // 设备头必须列进 Allow-Headers：它们是 141 §7 的 5 处请求入口统一注入的，
      // 缺了浏览器会直接拒绝实际请求（CORS 失败），reportSearch() 永不触发，
      // 用例表现为「点了确定但 15 秒内没发出搜题请求」——那正是 not ok 137/139。
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers':
          'Authorization, Content-Type, Idempotency-Key, X-Device-Id, X-Device-Instance'
      };
      if (request.method() === 'OPTIONS') {
        void request.respond({ status: 204, headers: corsHeaders }).catch(() => {});
        return;
      }
      reportSearch();
      void request.respond({
        status: 200, contentType: 'application/json', headers: corsHeaders,
        body: JSON.stringify({ question: 'Fixture question', type: 0, answer: { answerKeyText: 'A', answerText: 'Alpha' } })
      }).catch(() => {});
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
    if (url.pathname === '/mooc2/work/dowork') {
      void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: workPage });
      return;
    }
    if (request.isNavigationRequest() && url.hostname.endsWith('.chaoxing.com')) {
      void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: coursePage(withTask) });
      return;
    }
    void request.abort();
  });
  await page.goto(pageKind === 'work' ? workUrl : courseUrl);
  // The first panel mount waits for the whole bundled runtime to boot in a cold Chromium profile;
  // on a shared CI runner that regularly needs more than the 12s default (observed 12s+ stalls).
  // 冷 profile 下整个 bundle 要启动完才会挂面板；共享 runner 上 25s 仍会偶发超时（实测 26.2s）。
  // 超时属于基础设施抖动，不该让真实回归变红，给到 45s。
  await page.waitForSelector('#panel-common-work-results', { timeout: 45000 });
  return { page, searched, requests, logs };
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

test('work pages show the auto-answer countdown before sending a search request', { timeout: 60000 }, async (t) => {
  const { page, searched, requests } = await openPage(t, { pageKind: 'work' });

  await page.waitForSelector('.swal2-popup .swal2-cancel');
  const dialogText = await page.$eval('.swal2-html-container', (element) => element.textContent || '');
  assert.match(dialogText, /5 秒后开始自动答题/u);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(requests.some((request) => request.includes('provider.chaoxing.com')), false);

  await page.$eval('.swal2-confirm', (element) => element.click());
  await Promise.race([
    searched,
    new Promise((_, reject) => setTimeout(() => reject(new Error('work page did not search after confirmation')), 15000))
  ]);
  assert.equal(requests.some((request) => request.includes('provider.chaoxing.com')), true);
});

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

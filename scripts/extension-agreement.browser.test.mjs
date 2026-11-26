import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { createTestDirectory } from './test-helpers/temp-directory.mjs';

const access = 'local-integration-fixture';
const secondAccess = 'second-owned-fixture';
const deviceId = '7075530c-7398-40eb-b5b1-9f1ce331f762';
const credential = 'agd_' + 'a'.repeat(43);
const sha = value => createHash('sha256').update(value).digest('hex');
const body = version => ('测试专用，非正式发布 <img src="/danger"> ' + version + '\n').repeat(150);
const sha256Spki = certPath => {
  const pem = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-pubkey']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: pem });
  return createHash('sha256').update(der).digest('base64');
};
const waitUi = (page, text) => page.waitForFunction(value =>
  document.getElementById('cx-plus-agreement')?.shadowRoot.querySelector('.status').textContent.includes(value),
  { timeout: 12000 }, text);
const visibleReader = page => page.waitForFunction(() => {
  const host = document.getElementById('cx-plus-agreement');
  return !!host && !host.hidden && !host.shadowRoot.querySelector('.card').hidden;
});
const click = (page, cls) => page.click('pierce/.' + cls);
const bottom = page => page.evaluate(() => {
  const node = document.getElementById('cx-plus-agreement').shadowRoot.querySelector('.body');
  node.scrollTop = node.scrollHeight;
});
const enabled = page => page.waitForFunction(() =>
  document.getElementById('cx-plus-agreement')?.shadowRoot.querySelector('.accept').disabled === false);
const deniedButton = page => page.evaluate(() => document.getElementById('cx-plus-agreement').shadowRoot.querySelector('.accept').disabled);

test('built MV3: owned HTTPS agreement, consent lifecycle, mounted status, ordinary metadata and off switch', { timeout: 120000 }, async t => {
  const output = createTestDirectory('agreement-chrome');
  const profile = join(output, 'profile');
  const extensionPath = join(output, 'extension');
  cpSync(resolve('dist'), extensionPath, { recursive: true });
  const keyPath = join(output, 'tls.key'), certPath = join(output, 'tls.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:owned.chaoxing.com,IP:127.0.0.1',
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });

  const fixtureSpki = sha256Spki(certPath);
  let version = 'v1', signed = '', reads = 0, enrollments = 0, consents = 0;
  let searches = 0, broken = false, unavailable = false, healthHits = 0, holdLookup = false, agreementStatusHits = 0;
  const statusHits = [];
  const course = '<!doctype html><title>Owned course</title><input id="curCourseId" value="course">' +
    '<input id="curClazzId" value="class"><input id="curChapterId" value="chapter">' +
    '<div class="posCatalog_select posCatalog_active" id="chapter"><input class="jobUnfinishCount" value="1"></div>' +
    '<iframe id="iframe" src="/knowledge/cards?courseId=course&clazzid=class&chapterId=chapter" style="width:600px;height:400px"></iframe>';
  const card = '<!doctype html><title>Owned card</title>' +
    '<script>window.attachments=[{jobid:"owned-audio",job:true,isPassed:false,property:{_jobid:"owned-audio",name:"Owned passive attachment"}}]</script>' +
    '<div class="ans-attach-ct"><iframe jobid="owned-audio" src="/fixture/audio" style="width:400px;height:200px"></iframe></div>';
  const simpleWorkPage = '<!doctype html><title>Owned ordinary work fixture</title>' +
    '<main><form><div class="singleQuesId"><div class="TiMu"><input type="hidden" name="answertype1" value="0">' +
    '<div class="Zy_TItle"><div class="clearfix">Owned ordinary fixture question</div></div>' +
    '<div class="answerBg"><label class="answer_p"><input type="radio" name="answer1" value="A">A. First</label>' +
    '<label class="answer_p"><input type="radio" name="answer1" value="B">B. Second</label></div>' +
    '</div></div></form></main>';
  const service = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, async (req, res) => {
    const url = new URL(req.url, 'https://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      const routes = { '/mooc2/work/dowork': simpleWorkPage, '/mycourse/studentstudy': course, '/knowledge/cards': card,
        '/fixture/audio': '<!doctype html><title>Inert local audio</title><audio id="audio" preload="none"></audio>' };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(routes[path]
        ?? '<!doctype html><title>Owned local fixture</title><main>Owned local fixture</main>');
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Agreement-Device, X-Device-Id, X-Device-Instance, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (unavailable && path.startsWith('/api/agreements/')) return res.destroy();
    const reply = (data, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    const second = req.headers.host.startsWith('127.0.0.1:');
    const authorized = req.headers.authorization === 'Bearer ' + (second ? secondAccess : access);
    if (path.startsWith('/api/service-status/')) {
      statusHits.push({ second, authorized, hasAuthorization: Boolean(req.headers.authorization) });
      return reply({ schemaVersion: 1, status: 'healthy', retained: 0 });
    }
    if (path === '/api/search/health') {
      healthHits++;
      return authorized ? reply({ success: true, status: 'succeeded', taskId: 'owned-diagnostic',
        statusUrl: '/api/search/status?taskId=owned-diagnostic',
        deviceAccess: { allowed: true, reason: 'already-registered', limit: 2, used: 3 } }) : reply({}, 401);
    }
    if (path === '/api/search' && req.method === 'POST') {
      searches++;
      if (holdLookup) return; // Keep the original ordinary run and its controls mounted.
      // No admitted mutation or external answer: only a local count and an empty result.
      return reply({ question: 'Owned ordinary fixture question', type: 0, answer: {} });
    }
    if (path === '/api/agreements/devices' && req.method === 'POST') {
      enrollments++;
      return reply({ deviceId, deviceCredential: credential }, 201);
    }
    if (!path.startsWith('/api/agreements/') || req.headers['x-agreement-device'] !== credential
      || (req.headers.authorization && !authorized)) return reply({ code: 'proof_required' }, 401);
    const state = { version, content_hash: sha(body(version)), needsAcceptance: signed !== version };
    if (path === '/api/agreements/status') { agreementStatusHits++; return reply({ ...state, deviceId }); }
    if (path === '/api/agreements/current') {
      reads++;
      if (url.searchParams.get('version') !== version) return reply({ code: 'version_conflict' }, 409);
      return reply({ ...state, type: 'user_agreement', summary: '测试专用正文', body: broken ? body('broken') : body(version), publishedAt: '2026-11-01T00:00:00Z' });
    }
    if (path === '/api/agreements/consents' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const data = JSON.parse(raw);
      if (data.version !== version) return reply({ code: 'version_conflict' }, 409);
      assert.deepEqual(Object.keys(data), ['version']);
      consents++;
      signed = data.version;
      return reply({ accepted: true, version, deviceId, acceptedAt: '2026-11-01T00:00:00Z' });
    }
    return reply({ code: 'not_found' }, 404);
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  t.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const port = service.address().port;
  const base = 'https://localhost:' + port;
  writeFileSync(join(extensionPath, 'extension-agreement-config.js'), 'export const defaultBase = ' + JSON.stringify(base));
  const browser = await puppeteer.launch({
    headless: true, userDataDir: profile, executablePath: process.env.CX_BROWSER_EXECUTABLE,
    enableExtensions: [extensionPath],
    args: ['--no-sandbox', '--ignore-certificate-errors-spki-list=' + fixtureSpki, '--disable-background-networking', '--no-proxy-server',
      '--host-resolver-rules=MAP owned.chaoxing.com 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']
  });
  t.after(() => browser.close());
  const internalTarget = await browser.waitForTarget(target => target.type() === 'page' && target.url().endsWith('/extension-agreement.html'));
  const page = await internalTarget.page();
  await waitUi(page, '完整阅读并同意').catch(async error => {
    console.error('install fixture', { reads, enrollments, consents }, await page.evaluate(async () => ({
      text: document.getElementById('cx-plus-agreement')?.shadowRoot?.querySelector('.status')?.textContent,
      settings: Object.keys(await chrome.storage.local.get(null))
    })));
    throw error;
  });
  assert.equal(await deniedButton(page), true, 'internal page neither auto-signs nor starts unscrolled');
  assert.equal(consents, 0);
  assert.equal(enrollments, 1);
  assert.equal(await page.evaluate(() => document.getElementById('cx-plus-agreement').shadowRoot.querySelector('.body img')), null, 'rendered text, never remote HTML');
  await page.evaluate(({ base, access }) => chrome.storage.local.set({
    'common.settings.tiku-adapter.baseurl': base, 'common.settings.tiku-adapter.key': access,
    'common.settings.work-options': { searchDelaySeconds: 0, thread: 1, stopSecondWhenFinish: 0, upload: 'save',
      redundanceWordsText: '', answerSeparators: '#,|', answerMatchMode: 'includes', deepThinking: false },
    // This fixture is about the agreement gate; the separate deep-thinking browser test starts unprompted.
    deepThinkingEnabled: false, hasPromptedDeepThinking: true, 'cx.new.study.deepThinking': false,
    'cx.new.study.useAsyncTikuSearch': false, 'cx.new.study.enableAIFallbackAnswer': false,
    'cx.new.study.enableMedia': false, 'cx.new.study.mode': 'manually'
  }), { base, access });
  const setup = await browser.newPage();
  await setup.goto(new URL('popup.html', page.url()).href);
  await page.close(); // Ignore the automatic installation tab.
  const first = await browser.newPage(), second = await browser.newPage();
  const ownedPage = 'https://owned.chaoxing.com:' + port + '/';
  await first.goto(ownedPage); await second.goto(ownedPage);
  await visibleReader(first); await visibleReader(second);
  await waitUi(second, '完整阅读并同意');
  const workUrl = ownedPage + 'mooc2/work/dowork';
  async function protectedOrdinaryEntry(expectSearch, keepOpen = false) {
    const work = await browser.newPage();
    const errors = [];
    work.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    work.on('pageerror', error => errors.push(error.stack));
    try {
      await work.goto(workUrl);
      await work.waitForSelector('#panel-common-work-results', { timeout: 12000 });
      const leaked = await work.evaluate(() => ({
        stored: localStorage.getItem('common.settings.tiku-adapter.key'),
        attr: document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-tiku-adapter-key'),
        privilegedBootstrap: typeof globalThis.__CXPLUS_EXTENSION_BOOT__
      }));
      assert.deepEqual(leaked, { stored: null, attr: null, privilegedBootstrap: 'undefined' });
      if (!expectSearch) {
        await waitUi(work, unavailable ? '暂时无法确认' : signed && signed !== version && broken ? '摘要未通过校验'
          : signed && signed !== version ? '协议已更新' : '完整阅读并同意');
        assert.equal(await work.$('.swal2-confirm'), null);
      } else {
        await work.waitForSelector('.swal2-popup .swal2-confirm');
        await work.click('.swal2-popup .swal2-confirm');
        for (let n = 0; n < 80 && searches === 0; n++) await new Promise(resolve => setTimeout(resolve, 75));
      }
      assert.equal(await work.$('input[type=radio]:checked'), null);
    } catch (error) {
      console.error('owned ordinary fixture', { searches, expectSearch, errors }, await work.evaluate(() => ({
        marker: document.documentElement.dataset.cxPlusInjected,
        status: document.getElementById('cx-plus-agreement')?.shadowRoot.querySelector('.status').textContent
      })));
      throw error;
    } finally { if (!keepOpen) await work.close(); }
    return work;
  }
  await protectedOrdinaryEntry(false);
  assert.equal(searches, 0);
  await first.bringToFront(); await click(first, 'dismiss');
  assert.equal(searches, 0, 'dismiss is not consent');
  await click(first, 'reopen');
  await bottom(first);
  assert.equal(await deniedButton(first), true, 'bottom alone is insufficient');
  await enabled(first);
  await first.evaluate(() => document.getElementById('cx-plus-agreement').shadowRoot.querySelector('.accept').click());
  assert.equal(consents, 0, 'script-generated click ignored');
  await first.reload(); await waitUi(first, '完整阅读并同意');
  assert.equal(await deniedButton(first), true, 'refresh requires rereading');
  await bottom(first); await enabled(first);
  const workerTarget = await browser.waitForTarget(target => target.type() === 'service_worker'
    && target.url().endsWith('/extension-worker.js'));
  const worker = await workerTarget.worker();
  await worker.close(); // Reading evidence from the old MV3 worker is not replayable.
  await click(first, 'accept');
  await first.waitForFunction(() => document.getElementById('cx-plus-agreement').shadowRoot
    .querySelector('.timing').textContent.includes('阅读计时已失效'));
  assert.equal(await deniedButton(first), true);
  assert.equal(consents, 0);
  await bottom(first); await enabled(first); await click(first, 'accept');
  await waitUi(first, '已确认同意'); await waitUi(second, '已确认同意');
  assert.equal(await second.evaluate(() => document.getElementById('cx-plus-agreement').hidden), true);
  const outOfScope = await browser.newPage();
  await outOfScope.goto(ownedPage + 'mooc2/exam/preview'); // Owned empty route only; decline unsupported mode.
  await outOfScope.waitForSelector('#panel-common-work-results');
  assert.equal(await outOfScope.$('.swal2-confirm'), null);
  assert.equal(searches, 0);
  await outOfScope.close();
  holdLookup = true;
  const previousWorkPage = await protectedOrdinaryEntry(true, true);
  await previousWorkPage.$eval('input[type=radio]', input => { input.checked = true; });
  assert.notEqual(await previousWorkPage.$('input[type=radio]:checked'), null);
  assert.ok(searches > 0, 'the actual packaged, accepted ordinary runtime performed an owned fixture request');
  assert.equal(consents, 1);
  assert.equal(enrollments, 1);
  assert.equal(await setup.evaluate(async () => (await chrome.storage.local.get('agreement.install.v1'))['agreement.install.v1']), 'complete');

  const ownedCourse = await browser.newPage();
  const courseReports = [];
  ownedCourse.on('console', message => courseReports.push(message.text()));
  await ownedCourse.goto(ownedPage + 'mycourse/studentstudy?courseId=course&clazzid=class&chapterId=chapter&mooc2=1');
  for (let n = 0; n < 180 && !courseReports.some(line => line.includes('Owned passive attachment')); n++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(courseReports.some(line => line.includes('Owned passive attachment')),
    'the actual ordinary disabled-media scan names the valid MAIN attachment: ' + courseReports.slice(-12).join('; '));
  assert.equal(await ownedCourse.frames().find(frame => frame.url().includes('/fixture/audio')).$eval('audio', node => node.paused), true);
  await ownedCourse.close();
  const searchesBeforeVersion = searches;

  version = 'v2'; broken = true;
  await protectedOrdinaryEntry(false);
  assert.equal(searches, searchesBeforeVersion, 'invalid document blocks the actual runtime');
  await waitUi(first, '摘要未通过校验');
  assert.match(await first.evaluate(() => document.getElementById('cx-plus-agreement').shadowRoot.querySelector('.body').textContent), / v1/);
  broken = false;
  await first.bringToFront();
  await first.setOfflineMode(true);
  await waitUi(first, '当前离线');
  await first.setOfflineMode(false);
  await waitUi(first, '协议已更新'); await waitUi(second, '协议已更新');
  assert.equal(await deniedButton(first), true);
  const byText = async (tab, text) => {
    const handle = await tab.evaluateHandle(value => Array.from(document.querySelectorAll('#panel-common-work-results button'))
      .find(node => node.textContent === value && node.getClientRects().length > 0), text);
    assert.ok(handle.asElement(), 'visible control: ' + text);
    await handle.evaluate(element => element.click()); // Exercise the mounted panel handler independent of overlay geometry.
  };
  await previousWorkPage.bringToFront();
  await waitUi(previousWorkPage, '协议已更新');
  await click(previousWorkPage, 'dismiss');
  const beforeReset = agreementStatusHits;
  const clearedControls = await previousWorkPage.evaluate(() => {
    const button = Array.from(document.querySelectorAll('#panel-common-work-results button'))
      .find(node => node.textContent === '清空结果' && node.getClientRects().length > 0);
    if (!button || button.disabled) return false;
    button.click(); // Exercise the existing control; authority still comes only from the worker.
    return true;
  });
  assert.equal(clearedControls, true);
  for (let n = 0; n < 100 && agreementStatusHits === beforeReset; n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(agreementStatusHits > beforeReset, 'clearing consulted live service authority');

  assert.notEqual(await previousWorkPage.$('input[type=radio]:checked'), null, 'revocation preserves owned form input');
  assert.equal(searches, searchesBeforeVersion);
  await previousWorkPage.close();
  holdLookup = false;
  await first.bringToFront();
  unavailable = true;
  await first.setOfflineMode(true);
  await waitUi(first, '当前离线');
  await protectedOrdinaryEntry(false);
  assert.equal(searches, searchesBeforeVersion, 'unreachable authority cannot release a new ordinary lookup');
  assert.equal(consents, 1);
  unavailable = false;
  await first.bringToFront();
  await first.setOfflineMode(false);
  await first.waitForFunction(() => navigator.onLine);
  try {
    await waitUi(first, '协议已更新');
  } catch {
    // Per-tab DevTools network emulation need not deliver both events to a backgrounded window.
    // After the server backoff, exercise the real user-facing retry on its newly online tab.
    await click(first, 'retry');
    await waitUi(first, '协议已更新');
  }
  await second.close();
  await first.reload(); await waitUi(first, '协议已更新');
  assert.equal(await deniedButton(first), true);
  assert.ok(reads >= 3);
  // Restore from a lifecycle suspension without duplicate panels/listeners.
  await first.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  assert.equal(await first.$('#cx-plus-agreement'), null);
  await first.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await waitUi(first, '协议已更新');
  assert.equal((await first.$$('#cx-plus-agreement')).length, 1);

  const beforeStatus = statusHits.length;
  await first.bringToFront();
  await byText(first, '题库状态');
  for (let n = 0; n < 60 && statusHits.length < beforeStatus + 2; n++) await new Promise(resolve => setTimeout(resolve, 75));
  assert.deepEqual(statusHits.slice(beforeStatus), Array(2).fill({ second: false, authorized: true, hasAuthorization: true }));
  const settings = await browser.newPage();
  await settings.goto(new URL('extension-agreement.html', setup.url()).href);
  await waitUi(settings, '协议已更新');
  const beforeDiagnosis = healthHits;
  await click(settings, 'source-probe');
  const sourceMessage = (tab, text) => tab.waitForFunction(value => document.getElementById('cx-plus-agreement')
    ?.shadowRoot.querySelector('.source-status')?.textContent.includes(value), {}, text);
  await sourceMessage(settings, '已用 3/2 台');
  assert.equal(healthHits, beforeDiagnosis + 1);
  const beforeSwitch = statusHits.length;
  await settings.$eval('pierce/.source-base', (el, value) => { el.value = value; }, 'https://127.0.0.1:' + port);
  await settings.$eval('pierce/.source-key', (el, value) => { el.value = value; }, secondAccess);
  await click(settings, 'source-save');
  await sourceMessage(settings, '题库地址已确认');
  await first.bringToFront();
  await byText(first, '立即刷新'); // Do not reload the already-mounted consumer.
  for (let n = 0; n < 60 && statusHits.length < beforeSwitch + 2; n++) await new Promise(resolve => setTimeout(resolve, 75));
  assert.deepEqual(statusHits.slice(beforeSwitch), Array(2).fill({ second: true, authorized: true, hasAuthorization: true }));
  await settings.bringToFront();
  await click(settings, 'source-clear');
  await sourceMessage(settings, '已移除本地令牌');
  await click(settings, 'source-probe');
  await sourceMessage(settings, '请先配置访问令牌');
  assert.equal(healthHits, beforeDiagnosis + 1, 'revoked key does not create a new health request');
  const beforeClearRefresh = statusHits.length;
  await first.bringToFront();
  await byText(first, '立即刷新');
  await first.waitForFunction(() => document.body.textContent.includes('状态数据需要通过访问令牌读取'));
  assert.equal(statusHits.length, beforeClearRefresh);

  await setup.evaluate(() => chrome.storage.local.set({ 'common.settings.extension-enabled': false }));
  const off = await browser.newPage();
  await off.goto(ownedPage + 'fixture/off');
  await waitUi(off, '扩展已停用');
  assert.equal(await off.$('#panel-common-work-results'), null);
  assert.equal(await off.$('.swal2-container'), null);
});

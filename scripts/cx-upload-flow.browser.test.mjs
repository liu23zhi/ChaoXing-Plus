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
let origin;
let runtime;
let posts = 0;

const confirmation = `<div id="workpop" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.2)">
  <div class="popDiv wid440 Marking"><div class="popHead" id="workpopFocus">
    <a id="popCloseFocus" href="javascript:;" onclick="closeConfirmation()">close</a></div>
    <p id="popcontent">确认提交？</p><a id="popok" href="javascript:;">提交</a>
    <a id="popno" href="javascript:;" onclick="closeConfirmation()">取消</a></div></div>`;

before(async () => {
  const moduleCode = async (path, exportNames) => {
    const source = await readFile(path, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText;
    const names = Array.isArray(exportNames) ? exportNames : [exportNames];
    return `(() => { const exports = {}; ${compiled}; ${names.map((name) => `window.${name} = exports.${name};`).join('\n')} })();`;
  };
  runtime = await moduleCode('src/projects/cx-chapter-submission.ts', 'observeChapterSubmission');
  runtime += await moduleCode('src/projects/cx-chapter-dialog.ts', ['dismissChapterSubmissionDialog', 'hasChapterSubmissionConfirmation']);
  const source = await readFile('src/projects/cx.ts', 'utf8');
  const ast = ts.createSourceFile('cx.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set(['isExpiredChapterText', 'isExpiredChapterResponse', 'isChapterSubmissionFailure',
    'isExpiredChapterMessage', 'invokeChapterActionWithExpiryCapture']);
  const helpers = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
  assert.equal(helpers.length, names.size);
  const begin = source.indexOf('let chapterFinished = false;');
  const end = source.indexOf('\n    } finally {', begin);
  assert.ok(begin > 0 && end > begin);
  const harness = `(() => {
    const topWindow = window;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms >= 3000 ? 1 : ms));
    ${helpers.map((node) => node.getText(ast)).join('\n')}
    window.runActualChapterUpload = async (frameWindow, frame) => {
      const frameDocument = frameWindow.document;
      const upload = 'submit';
      const retryableResults = [], cacheableResults = [];
      const deepThinking = false, allowStaticExpiryFallback = true, chapterActionCorrelationId = '';
      let uploadInProgress = false;
      const waitForTikuAdapterBalanceRecovery = async () => {};
      const isWindowsAutoSubmitEnabled = () => true;
      const isChapterTestExpired = () => false;
      const getDeferredChapterContext = () => ({ scope: '["course","class","cur359531606"]', tabKey: 'tab-A' });
      const chapterTaskContext = getDeferredChapterContext();
      const chapterTaskJobId = frameDocument.querySelector('#jobid').value;
      const isDeferredChapterContextCurrent = () => true;
      const detectChapterRetakePrompt = () => false;
      const logDebug = () => {};
      const appsMethods = () => ({ addQuestionCacheFromWorkResult: () => window.cacheWrites++ });
      const $console = { info() {}, warn() {} }, $message = { info() {}, warn() {}, success() {} };
      // Only the worker's already-computed answer/upload readiness is substituted.
      const worker = { uploadHandler: async ({ callback }) => callback(100, true), emit() {} };
      ${source.slice(begin, end)}
    };
  })();`;
  runtime += ts.transpileModule(harness, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST') {
      posts++;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      const kind = url.searchParams.get('kind');
      setTimeout(() => response.end(JSON.stringify({ status: kind === 'success',
        msg: kind === 'expired' ? '此作业已过期！' : kind === 'parameter' ? '无效的参数：code-1!'
          : kind === 'success' ? '提交成功' : '暂时提交失败' })), 25);
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    const id = url.searchParams.get('id') || 'A';
    const body = url.pathname === '/'
      ? `<iframe id="A" src="/frame?id=A" width="600" height="300"></iframe><iframe id="B" src="/frame?id=B" width="600" height="300"></iframe>${confirmation}`
      : `<form><input id="jobid" name="jobid" value="job-${id}"><input id="knowledgeid" name="knowledgeid" value="${id === 'A' ? '359531606' : '359531607'}"></form>${confirmation}`;
    response.end(`<!doctype html><html><body>${body}</body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server'] });
});

after(async () => {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

async function scenario(kind, actionOwner = 'frame') {
  const page = await browser.newPage();
  const dialogs = [];
  page.on('dialog', (dialog) => { dialogs.push(dialog.dismiss().catch(() => {})); });
  const beforePosts = posts;
  try {
    await page.goto(origin);
    await page.addScriptTag({ content: runtime });
    const result = await page.evaluate(async (kind, actionOwner) => {
      window.cacheWrites = 0;
      const nativeSetTimeout = window.setTimeout;
      // Exercise deadline behavior locally without spending 30 seconds on an intentional zero-POST case.
      window.setTimeout = (callback, ms, ...args) => nativeSetTimeout(callback, ms >= 10000 ? 500 : ms, ...args);
      if (kind === 'no-confirmation') {
        const nativeNow = Date.now;
        const startedAt = nativeNow();
        Date.now = () => startedAt + (nativeNow() - startedAt) * 100;
      }
      const frame = document.querySelector('#A');
      const child = frame.contentWindow;
      const sibling = document.querySelector('#B').contentWindow;
      const actionWindow = actionOwner === 'parent' ? window : child;
      for (const owner of [window, child, sibling]) owner.closeConfirmation = () => {
        owner.cancelCalls = (owner.cancelCalls || 0) + 1;
        owner.document.querySelector('#workpop').style.display = 'none';
      };
      sibling.document.querySelector('#workpop').style.display = 'block';
      if (actionOwner === 'parent') {
        document.body.insertAdjacentHTML('afterbegin', '<form><input name="jobid" id="jobid" value="job-A"></form>');
      }
      actionWindow.submitCalls = 0;
      actionWindow.signatureReady = false;
      actionWindow.submittedBeforeReady = false;
      if (kind !== 'missing') {
        actionWindow.btnBlueSubmit = () => {
          if (kind === 'direct-submit') {
            actionWindow.submitCheckTimes();
            return;
          }
          if (kind === 'precheck-code-sync') {
            actionWindow.alert('无效的参数：code-1!');
            return false;
          }
          if (kind === 'precheck-code-async') {
            nativeSetTimeout(() => actionWindow.alert('无效的参数：code-1!'), 50);
            return;
          }
          if (kind === 'no-confirmation') return;
          const ready = () => {
            actionWindow.signatureReady = true;
            actionWindow.document.querySelector('#workpop').style.display = 'block';
          };
          if (kind === 'delayed-precheck') nativeSetTimeout(ready, 50);
          else ready();
        };
        actionWindow.submitCheckTimes = () => {
          actionWindow.submitCalls++;
          if (kind === 'no-post') return;
          if (kind === 'delayed-precheck' && !actionWindow.signatureReady) {
            actionWindow.submittedBeforeReady = true;
            actionWindow.alert('无效的参数：code-1!');
            return;
          }
          const body = new URLSearchParams({ jobid: 'job-A', knowledgeid: '359531606', courseid: 'course', clazzid: 'class' });
          const responseKind = ['delayed-precheck', 'no-confirmation', 'precheck-code-sync', 'precheck-code-async', 'direct-submit'].includes(kind) ? 'success' : kind;
          actionWindow.fetch('/mooc-ans/work/addStudentWorkNewWeb?kind=' + responseKind, { method: 'POST', body })
            .then((response) => response.json()).then((value) => { if (kind === 'expired' || kind === 'parameter') actionWindow.alert(value.msg); });
        };
      }
      let outcome;
      let error = '';
      try { outcome = await runActualChapterUpload(child, frame); } catch (caught) { error = caught.message; }
      await new Promise((resolve) => nativeSetTimeout(resolve, 15));
      return { outcome, error, cacheWrites: window.cacheWrites,
        submitCalls: actionWindow.submitCalls, submittedBeforeReady: actionWindow.submittedBeforeReady,
        confirmation: actionWindow.getComputedStyle(actionWindow.document.querySelector('#workpop')).display,
        siblingConfirmation: sibling.getComputedStyle(sibling.document.querySelector('#workpop')).display,
        cancellations: actionWindow.cancelCalls || 0 };
    }, kind, actionOwner);
    await Promise.all(dialogs);
    return { ...result, dialogs: dialogs.length, posts: posts - beforePosts };
  } finally { await page.close(); }
}

for (const actionOwner of ['frame', 'parent']) {
  test(`production upload callback confirms the ${actionOwner} POST before completing and caching`, async () => {
    const result = await scenario('success', actionOwner);
    assert.equal(result.error, '');
    assert.equal(result.outcome.finished, true);
    assert.equal(result.outcome.disposition, 'completed');
    assert.equal(result.cacheWrites, 1);
    assert.equal(result.posts, 1);
    assert.equal(result.siblingConfirmation, 'block');
  });
}

test('production upload callback cannot cache a no-POST action', async () => {
  const result = await scenario('no-post');
  assert.match(result.error, /timed out|超时|尚未确认/);
  assert.equal(result.cacheWrites, 0);
  assert.equal(result.posts, 0);
  assert.equal(result.outcome, undefined);
});

test('production upload callback rejects missing page functions without a request or cache', async () => {
  const result = await scenario('missing');
  assert.match(result.error, /提交入口尚未就绪/);
  assert.equal(result.cacheWrites, 0);
  assert.equal(result.posts, 0);
});

test('production upload expiry closes its confirmation and preserves the sibling task popup', async () => {
  const result = await scenario('expired');
  assert.equal(result.error, '');
  assert.equal(result.outcome.terminalExpired, true);
  assert.equal(result.outcome.disposition, 'terminal-expired');
  assert.equal(result.cacheWrites, 0);
  assert.equal(result.posts, 1);
  assert.equal(result.confirmation, 'none');
  assert.equal(result.siblingConfirmation, 'block');
  assert.equal(result.cancellations, 1);
  assert.equal(result.dialogs, 0);
});

test('production upload ordinary failure remains retryable without completing or caching', async () => {
  const result = await scenario('ordinary');
  assert.match(result.error, /提交失败/);
  assert.equal(result.cacheWrites, 0);
  assert.equal(result.posts, 1);
  assert.equal(result.confirmation, 'block');
});

for (const timing of ['sync', 'async']) {
  test(`production upload stops after a ${timing} code-1 precheck without native dialogs or a final POST`, async () => {
    const result = await scenario(`precheck-code-${timing}`);
    assert.match(result.error, /无效.{0,4}参数|code\s*[-：:]?\s*-?1|预检|确认/);
    assert.equal(result.submitCalls, 0);
    assert.equal(result.posts, 0);
    assert.equal(result.cacheWrites, 0);
    assert.equal(result.dialogs, 0);
    assert.equal(result.outcome, undefined);
    assert.equal(result.siblingConfirmation, 'block');
  });
}

test('production upload waits for the async precheck signature and visible confirmation before one final POST', async () => {
  const result = await scenario('delayed-precheck');
  assert.equal(result.error, '');
  assert.equal(result.outcome?.disposition, 'completed');
  assert.equal(result.submittedBeforeReady, false);
  assert.equal(result.submitCalls, 1);
  assert.equal(result.posts, 1);
  assert.equal(result.cacheWrites, 1);
  assert.equal(result.dialogs, 0);
});

test('production upload cannot confirm or cache a task without a visible confirmation layer', async () => {
  const result = await scenario('no-confirmation');
  assert.match(result.error, /确认|预检|timed out|超时/);
  assert.equal(result.submitCalls, 0);
  assert.equal(result.posts, 0);
  assert.equal(result.cacheWrites, 0);
  assert.equal(result.dialogs, 0);
  assert.equal(result.outcome, undefined);
});

test('production upload does not submit again after the opening action already completes a final POST', async () => {
  const result = await scenario('direct-submit');
  assert.equal(result.error, '');
  assert.equal(result.outcome?.disposition, 'completed');
  assert.equal(result.submitCalls, 1);
  assert.equal(result.posts, 1);
  assert.equal(result.cacheWrites, 1);
  assert.equal(result.dialogs, 0);
});

test('production final response code-1 is retryable without a native dialog or a cached result', async () => {
  const result = await scenario('parameter');
  assert.match(result.error, /code-1|参数校验|提交失败/);
  assert.equal(result.submitCalls, 1);
  assert.equal(result.posts, 1);
  assert.equal(result.cacheWrites, 0);
  assert.equal(result.dialogs, 0);
  assert.equal(result.outcome, undefined);
  assert.equal(result.siblingConfirmation, 'block');
});

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';

const puppeteer = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'))('puppeteer');
let browser;
let server;
let origin;
let runtime;
let posts = 0;

before(async () => {
  const compileModule = async (path) => ts.transpileModule(await readFile(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText.replace(/^export /gm, '');
  const submission = await compileModule('src/projects/cx-chapter-submission.ts');
  const dialogs = await compileModule('src/projects/cx-chapter-dialog.ts');
  const source = await readFile('src/projects/cx.ts', 'utf8');
  const ast = ts.createSourceFile('cx.ts', source, ts.ScriptTarget.Latest, true);
  const helperNames = new Set(['isExpiredChapterText', 'isExpiredChapterResponse', 'isChapterSubmissionFailure',
    'isExpiredChapterMessage', 'invokeChapterActionWithExpiryCapture', 'triggerSyntheticClick']);
  const topLevel = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && helperNames.has(node.name?.text));
  assert.equal(topLevel.length, helperNames.size);
  const names = new Set(['getWorkOrExamActionDocuments', 'isElementVisible', 'isWorkOrExamClickableElement',
    'isWorkOrExamConfirmRejectElement', 'describeWorkOrExamClickTarget', 'clickWorkOrExamElement',
    'clickWorkOrExamSubmitConfirmButton', 'clickWorkOrExamActionButton', 'submitWorkOrExamPage', 'saveWorkOrExamPage']);
  const nested = [];
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) nested.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(nested.length, names.size);
  runtime = ts.transpileModule(`(() => {
    const topWindow = window;
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms >= 3000 ? 1 : ms));
    const workOrExamClickableSelector = 'button,a,input[type="button"],input[type="submit"],[role="button"],[onclick]';
    const findWorkOrExamRuntimeWindow = () => ({ window, source: 'fixture' });
    const workExamCorrelationId = 'fixture';
    const logDebug = () => {};
    ${submission}
    ${dialogs}
    ${topLevel.map((node) => node.getText(ast).replace(/^export\s+/, '')).join('\n')}
    ${nested.map((node) => node.getText(ast)).join('\n')}
    window.submitActualWork = () => submitWorkOrExamPage('work');
    window.saveActualWork = () => saveWorkOrExamPage('work');
  })();`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST') {
      posts++;
      response.setHeader('Content-Type', 'application/json');
      setTimeout(() => response.end(JSON.stringify(url.searchParams.get('kind') === 'code1'
        ? { status: false, msg: '无效的参数：code-1!' } : { status: true, msg: '提交成功' })), 15);
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><body><form id="form1"><input id="jobid" name="jobid" value="fixture-job"></form>
      <div id="workpop" style="display:none"><div class="popDiv wid440 Marking">
      <div class="popHead" id="workpopFocus"><a id="popCloseFocus" href="javascript:;" onclick="closeWorkConfirmation()">关闭</a></div><p id="popcontent">确认提交？</p>
      <a href="javascript:;" id="popok" onclick="submitCheckTimes()">提交</a>
      <a href="javascript:;" id="popno" onclick="closeWorkConfirmation()">取消</a></div></div></body></html>`);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking'] });
});

after(async () => {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
});

async function scenario(kind) {
  const page = await browser.newPage();
  const dialogs = [];
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.goto(origin);
    await page.addScriptTag({ content: runtime });
    assert.deepEqual(pageErrors, [], 'the production submit fixture must initialize');
    const beforePosts = posts;
    const outcome = await page.evaluate(async (kind) => {
      const events = [];
      let prechecks = 0, submissions = 0, saves = 0, cancellations = 0;
      const originalAlert = alert;
      const originalConfirm = confirm;
      const originalFetch = fetch;
      window.closeWorkConfirmation = () => {
        cancellations++;
        document.querySelector('#workpop').style.display = 'none';
      };
      window.noSubmit = () => { saves++; };
      window.submitCheckTimes = () => {
        submissions++;
        events.push('submit');
        if (kind === 'async-code1' || kind === 'stale-confirmation') return;
        fetch('/mooc-ans/work/addStudentWorkNewWeb?kind=' + (kind === 'final-code1' ? 'code1' : 'success'), {
          method: 'POST', body: new URLSearchParams({ jobid: 'fixture-job' })
        }).then((response) => response.json()).then((value) => {
          if (!value.status) alert(value.msg);
        });
      };
      window.btnBlueSubmit = () => {
        prechecks++;
        events.push('precheck');
        if (kind === 'async-code1' || kind === 'stale-confirmation') {
          setTimeout(() => alert('无效的参数：code-1!'), 15);
        } else if (kind === 'direct') {
          document.querySelector('#workpop').remove();
          return fetch('/mooc-ans/work/addStudentWorkNewWeb?kind=success', { method: 'POST', body: 'jobid=fixture-job' })
            .then((response) => response.json()).then(() => {
              document.body.insertAdjacentHTML('beforeend', '<div class="testTit_status_complete"></div>');
            });
        } else {
          setTimeout(() => {
            events.push('ready');
            document.querySelector('#workpop').style.display = 'block';
          }, 35);
        }
      };
      if (kind === 'stale-confirmation') document.querySelector('#workpop').style.display = 'block';
      if (kind === 'unknown-confirmation') {
        document.querySelector('#workpop').style.display = 'block';
        document.querySelector('#popcontent').textContent = '其它任务提示';
      }
      if (kind === 'fallback-direct' || kind === 'fallback-initial-code1') {
        delete window.btnBlueSubmit;
        delete window.submitCheckTimes;
        document.querySelector('#workpop').remove();
        const submit = document.createElement('button');
        submit.id = 'submit-work';
        submit.textContent = '提交作业';
        submit.addEventListener('click', () => {
          submissions++;
          fetch('/mooc-ans/work/addStudentWorkNewWeb?kind=' + (kind === 'fallback-initial-code1' ? 'code1' : 'success'), {
            method: 'POST', body: new URLSearchParams({ jobid: 'fixture-job' })
          }).then((response) => response.json()).then((value) => {
            if (!value.status) alert(value.msg);
          });
        });
        document.body.appendChild(submit);
      }
      if (kind === 'fallback-confirm-code1') {
        delete window.submitCheckTimes;
        const confirm = document.querySelector('#popok');
        confirm.removeAttribute('onclick');
        confirm.addEventListener('click', () => {
          submissions++;
          fetch('/mooc-ans/work/addStudentWorkNewWeb?kind=code1', {
            method: 'POST', body: new URLSearchParams({ jobid: 'fixture-job' })
          }).then((response) => response.json()).then((value) => {
            if (!value.status) alert(value.msg);
          });
        });
      }
      let error = '';
      try {
        if (kind === 'save') await saveActualWork();
        else await submitActualWork();
      } catch (caught) { error = caught.message; }
      await new Promise((done) => setTimeout(done, 65));
      return { events, prechecks, submissions, saves, cancellations, error,
        restored: kind === 'save' || (alert === originalAlert && confirm === originalConfirm && fetch === originalFetch) };
    }, kind);
    assert.deepEqual(pageErrors, [], 'the production submit fixture must not raise page errors');
    return { ...outcome, dialogs, posts: posts - beforePosts };
  } finally { await page.close(); }
}

test('ordinary work async code-1 precheck cannot reach final submission or a native alert', async () => {
  const result = await scenario('async-code1');
  assert.match(result.error, /参数.*code-1/);
  assert.equal(result.prechecks, 1);
  assert.equal(result.submissions, 0);
  assert.deepEqual(result.dialogs, []);
  assert.equal(result.restored, true);
});

test('ordinary work waits for its actual confirmation before the final submit function', async () => {
  const result = await scenario('success');
  assert.equal(result.error, '');
  assert.deepEqual(result.events, ['precheck', 'ready', 'submit']);
  assert.equal(result.submissions, 1);
  assert.deepEqual(result.dialogs, []);
  assert.equal(result.restored, true);
});

test('a previous visible confirmation cannot bypass the next ordinary work precheck', async () => {
  const result = await scenario('stale-confirmation');
  assert.match(result.error, /参数.*code-1/);
  assert.equal(result.submissions, 0);
  assert.equal(result.cancellations, 1);
  assert.deepEqual(result.dialogs, []);
});

test('an unknown visible popup is preserved without submitting or force-cancelling it', async () => {
  const result = await scenario('unknown-confirmation');
  assert.notEqual(result.error, '');
  assert.equal(result.submissions, 0);
  assert.equal(result.cancellations, 0);
});

test('ordinary work direct submission does not invoke a leftover final submit function', async () => {
  const result = await scenario('direct');
  assert.equal(result.error, '');
  assert.equal(result.prechecks, 1);
  assert.equal(result.submissions, 0);
  assert.deepEqual(result.dialogs, []);
  assert.equal(result.restored, true);
});

test('ordinary work final code-1 is preserved as failure without a native alert', async () => {
  const result = await scenario('final-code1');
  assert.match(result.error, /参数.*code-1|提交失败/);
  assert.equal(result.submissions, 1);
  assert.deepEqual(result.dialogs, []);
  assert.equal(result.restored, true);
});

test('ordinary fallback never clicks its initial submit button a second time', async () => {
  const result = await scenario('fallback-direct');
  assert.equal(result.error, '');
  assert.equal(result.submissions, 1);
  assert.equal(result.posts, 1);
  assert.deepEqual(result.dialogs, []);
});

test('ordinary fallback initial submit captures code-1 with only one click and one POST', async () => {
  const result = await scenario('fallback-initial-code1');
  assert.match(result.error, /参数.*code-1|提交失败/);
  assert.equal(result.submissions, 1);
  assert.equal(result.posts, 1);
  assert.deepEqual(result.dialogs, []);
  assert.equal(result.restored, true);
});

test('ordinary fallback confirmation captures code-1 with only one click and one POST', async () => {
  const result = await scenario('fallback-confirm-code1');
  assert.match(result.error, /参数.*code-1|提交失败/);
  assert.equal(result.prechecks, 1);
  assert.equal(result.submissions, 1);
  assert.equal(result.posts, 1);
  assert.deepEqual(result.dialogs, []);
  assert.equal(result.restored, true);
});

test('ordinary save keeps its own single save action without submitting', async () => {
  const result = await scenario('save');
  assert.equal(result.error, '');
  assert.equal(result.saves, 1);
  assert.equal(result.prechecks, 0);
  assert.equal(result.submissions, 0);
});

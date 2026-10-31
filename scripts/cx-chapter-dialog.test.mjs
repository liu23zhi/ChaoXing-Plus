import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
let server;
let browser;
let origin;
let runtime;
let submissionRuntime;
let helperRuntime;
let submissions = 0;

const confirmation = `
  <form method="post" action="/mooc-ans/work/addStudentWorkNewWeb">
    <div id="workpop" style="position:fixed;inset:0;display:block;background:rgba(0,0,0,.3)">
      <div class="popDiv wid440 Marking" style="position:absolute;left:20px;top:20px;width:440px;background:white">
        <div id="workpopFocus" class="popHead"><h2>提示</h2>
          <button id="popCloseFocus" type="button" onclick="popClickFunc()">关闭</button>
        </div>
        <p id="popcontent">确认提交？</p>
        <button id="popok" onclick="window.__submitCalls += 1">提交</button>
        <button id="popno">取消</button>
      </div>
    </div>
  </form>`;

const anchorConfirmation = `
  <div id="workpop" style="position:fixed;inset:0;display:block;background:rgba(0,0,0,.3)">
    <div class="popDiv wid440 Marking" style="position:absolute;left:20px;top:20px;width:440px;background:white">
      <div id="workpopFocus" class="popHead"><h2>提示</h2>
        <a id="popCloseFocus" href="javascript:void(0)" onclick="popClickFunc()">关闭</a>
      </div>
      <p id="popcontent">确认提交？</p>
      <a id="popok" href="javascript:void(0)" onclick="window.__submitCalls += 1; fetch('/mooc-ans/work/addStudentWorkNewWeb', {method:'POST'})">提交</a>
      <a id="popno" href="javascript:void(0)" onclick="window.__cancelCalls += 1; popClickFunc()">取消</a>
    </div>
  </div>`;

before(async () => {
  const source = await readFile('src/projects/cx-chapter-dialog.ts', 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  runtime = `(() => { const exports = {}; ${compiled}; window.dismissChapterSubmissionDialog = exports.dismissChapterSubmissionDialog; })();`;
  const observerSource = await readFile('src/projects/cx-chapter-submission.ts', 'utf8');
  const observerCode = ts.transpileModule(observerSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  submissionRuntime = `(() => { const exports = {}; ${observerCode}; window.observeChapterSubmission = exports.observeChapterSubmission; })();`;
  const cxSource = await readFile('src/projects/cx.ts', 'utf8');
  const parsed = ts.createSourceFile('cx.ts', cxSource, ts.ScriptTarget.Latest, true);
  const helperNames = new Set([
    'isExpiredChapterText', 'isExpiredChapterResponse', 'isChapterSubmissionFailure',
    'isExpiredChapterMessage', 'invokeChapterActionWithExpiryCapture'
  ]);
  const declarations = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && helperNames.has(node.name?.text));
  assert.equal(declarations.length, helperNames.size);
  const helperCode = ts.transpileModule(declarations.map((node) => node.getText(parsed)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 }
  }).outputText;
  helperRuntime = `(() => {
    const topWindow = window;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    ${helperCode}
    window.invokeChapterActionWithExpiryCapture = invokeChapterActionWithExpiryCapture;
  })();`;
  server = createServer((request, response) => {
    if (request.method === 'POST') {
      submissions += 1;
      response.setHeader('Content-Type', 'application/json');
      const kind = new URL(request.url, 'http://localhost').searchParams.get('kind');
      const payload = kind === 'expired'
        ? { status: false, msg: '此作业已过期！' }
        : { status: false, msg: '提交失败，请稍后重试' };
      setTimeout(() => response.end(JSON.stringify(payload)), 40);
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><body>${request.url === '/' ? '<iframe src="/frame" id="child"></iframe>' : ''}</body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server']
  });
});

after(async () => {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function openPage() {
  const page = await browser.newPage();
  await page.goto(origin);
  await page.addScriptTag({ content: runtime });
  await page.addScriptTag({ content: submissionRuntime });
  await page.addScriptTag({ content: helperRuntime });
  await page.evaluate((confirmation) => {
    document.body.insertAdjacentHTML('beforeend', confirmation);
    window.__submitCalls = 0;
    window.__cancelCalls = 0;
    window.__closeCalls = 0;
    window.popClickFunc = () => {
      window.__closeCalls += 1;
      document.querySelector('#workpop').style.display = 'none';
    };
  }, confirmation);
  return page;
}

test('iframe-initiated cleanup uses the top document cancellation listener once and never submits', async () => {
  const beforeSubmissions = submissions;
  const page = await openPage();
  try {
    const result = await page.evaluate(() => {
      document.querySelector('#popno').addEventListener('click', () => {
        window.__cancelCalls += 1;
        document.querySelector('#workpop').style.display = 'none';
      });
      const child = document.querySelector('#child').contentWindow;
      dismissChapterSubmissionDialog([child, window, child]);
      return {
        cancelled: window.__cancelCalls,
        close: window.__closeCalls,
        submit: window.__submitCalls,
        visible: getComputedStyle(document.querySelector('#workpop')).display
      };
    });
    assert.deepEqual(result, { cancelled: 1, close: 0, submit: 0, visible: 'none' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(submissions, beforeSubmissions);
  } finally { await page.close(); }
});

test('cleanup invokes an owner-document inline cancel handler and keeps the shared dialog reusable', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(() => {
      document.querySelector('#popno').setAttribute('onclick', 'window.__cancelCalls += 1; popClickFunc()');
      dismissChapterSubmissionDialog([document.querySelector('#child').contentWindow]);
      const popup = document.querySelector('#workpop');
      const hidden = getComputedStyle(popup).display;
      popup.style.display = 'block';
      return {
        cancelled: window.__cancelCalls,
        close: window.__closeCalls,
        hidden,
        reused: getComputedStyle(popup.querySelector('.popDiv')).display !== 'none'
      };
    });
    assert.deepEqual(result, { cancelled: 1, close: 1, hidden: 'none', reused: true });
  } finally { await page.close(); }
});

test('cleanup selects the real close control when cancellation is disabled', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(() => {
      document.querySelector('#popno').disabled = true;
      dismissChapterSubmissionDialog([document.querySelector('#child').contentWindow]);
      return {
        close: window.__closeCalls,
        submit: window.__submitCalls,
        display: getComputedStyle(document.querySelector('#workpop')).display
      };
    });
    assert.deepEqual(result, { close: 1, submit: 0, display: 'none' });
  } finally { await page.close(); }
});

test('cleanup locally hides the matching overlay when page callbacks leave it visible without submitting its form', async () => {
  const beforeSubmissions = submissions;
  const page = await openPage();
  try {
    const result = await page.evaluate(() => {
      document.querySelector('#popno').addEventListener('click', () => { window.__cancelCalls += 1; });
      dismissChapterSubmissionDialog([window]);
      const popup = document.querySelector('#workpop');
      const display = popup.style.display;
      popup.style.display = 'block';
      return {
        cancelled: window.__cancelCalls,
        close: window.__closeCalls,
        submit: window.__submitCalls,
        display,
        reused: getComputedStyle(popup.querySelector('.popDiv')).display !== 'none'
      };
    });
    assert.deepEqual(result, { cancelled: 1, close: 0, submit: 0, display: 'none', reused: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(submissions, beforeSubmissions);
  } finally { await page.close(); }
});

test('cleanup removes a leftover overlay even when its cancellation callback only hides the dialog content', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(() => {
      document.querySelector('#popno').addEventListener('click', () => {
        document.querySelector('#workpop .popDiv').style.display = 'none';
      });
      dismissChapterSubmissionDialog([window]);
      return getComputedStyle(document.querySelector('#workpop')).display;
    });
    assert.equal(result, 'none');
  } finally { await page.close(); }
});

test('cleanup uses only an explicitly associated owner-window close callback when controls cannot be clicked', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(() => {
      document.querySelector('#popno').disabled = true;
      document.querySelector('#popCloseFocus').setAttribute('aria-disabled', 'true');
      dismissChapterSubmissionDialog([document.querySelector('#child').contentWindow]);
      return { close: window.__closeCalls, submit: window.__submitCalls, display: getComputedStyle(document.querySelector('#workpop')).display };
    });
    assert.deepEqual(result, { close: 1, submit: 0, display: 'none' });
  } finally { await page.close(); }
});

test('cleanup leaves unrelated dialogs, Swal and question text containing confirmation words untouched', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(() => {
      document.querySelector('#popcontent').textContent = '题目：如何显示“确认提交？”提示？';
      document.body.insertAdjacentHTML('beforeend', '<div class="swal2-container"><div class="swal2-popup">确认提交？</div></div><div role="dialog" id="other">确认删除？</div>');
      const before = document.body.innerHTML;
      dismissChapterSubmissionDialog([window]);
      return { unchanged: before === document.body.innerHTML, submit: window.__submitCalls, close: window.__closeCalls };
    });
    assert.deepEqual(result, { unchanged: true, submit: 0, close: 0 });
  } finally { await page.close(); }
});

test('cleanup ignores hidden confirmation templates and incomplete lookalikes', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(() => {
      const popup = document.querySelector('#workpop');
      popup.style.display = 'none';
      const hiddenBefore = popup.outerHTML;
      dismissChapterSubmissionDialog([window]);
      const hiddenUnchanged = popup.outerHTML === hiddenBefore;
      popup.style.display = 'block';
      popup.querySelector('.popDiv').classList.remove('Marking');
      const incompleteBefore = popup.outerHTML;
      dismissChapterSubmissionDialog([window]);
      return { hiddenUnchanged, incompleteUnchanged: incompleteBefore === popup.outerHTML, close: window.__closeCalls };
    });
    assert.deepEqual(result, { hiddenUnchanged: true, incompleteUnchanged: true, close: 0 });
  } finally { await page.close(); }
});

test('cleanup does not hide a different dialog synchronously shown by the cancellation callback', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(() => {
      document.querySelector('#popno').addEventListener('click', () => {
        document.querySelector('#popcontent').textContent = '另一个任务需要确认';
      });
      dismissChapterSubmissionDialog([window]);
      return { content: document.querySelector('#popcontent').textContent, display: getComputedStyle(document.querySelector('#workpop')).display };
    });
    assert.deepEqual(result, { content: '另一个任务需要确认', display: 'block' });
  } finally { await page.close(); }
});

test('cleanup targets an iframe-owned confirmation while preserving an unrelated top-level popup', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate((confirmation) => {
      document.querySelector('#popcontent').textContent = '确认删除？';
      const child = document.querySelector('#child').contentWindow;
      child.document.body.insertAdjacentHTML('beforeend', confirmation);
      child.__submitCalls = 0;
      child.__cancelCalls = 0;
      child.document.querySelector('#popno').addEventListener('click', () => {
        child.__cancelCalls += 1;
        child.document.querySelector('#workpop').style.display = 'none';
      });
      dismissChapterSubmissionDialog([child]);
      return {
        childCancelled: child.__cancelCalls,
        childHidden: child.getComputedStyle(child.document.querySelector('#workpop')).display,
        topDisplay: getComputedStyle(document.querySelector('#workpop')).display,
        topClose: window.__closeCalls
      };
    }, confirmation);
    assert.deepEqual(result, { childCancelled: 1, childHidden: 'none', topDisplay: 'block', topClose: 0 });
  } finally { await page.close(); }
});

test('cleanup tolerates an inaccessible frame and uses its accessible parent document', async () => {
  const page = await openPage();
  try {
    const otherOrigin = origin.replace('127.0.0.1', 'localhost');
    await page.evaluate((src) => new Promise((resolve) => {
      const iframe = document.createElement('iframe');
      iframe.id = 'cross';
      iframe.onload = resolve;
      iframe.src = src;
      document.body.appendChild(iframe);
    }), `${otherOrigin}/frame`);
    const result = await page.evaluate(() => {
      let restricted = false;
      const cross = document.querySelector('#cross').contentWindow;
      try { void cross.document; } catch { restricted = true; }
      dismissChapterSubmissionDialog([cross]);
      return { restricted, hidden: getComputedStyle(document.querySelector('#workpop')).display };
    });
    assert.deepEqual(result, { restricted: true, hidden: 'none' });
  } finally { await page.close(); }
});

test('native expiry termination closes the top-owned anchor confirmation and mask without clicking submit', async () => {
  const beforeSubmissions = submissions;
  const page = await openPage();
  let nativeDialogs = 0;
  page.on('dialog', async (dialog) => {
    nativeDialogs += 1;
    await dialog.dismiss();
  });
  try {
    const result = await page.evaluate(async (markup) => {
      document.querySelector('form').remove();
      document.body.insertAdjacentHTML('beforeend', markup);
      const child = document.querySelector('#child').contentWindow;
      const expired = await invokeChapterActionWithExpiryCapture(child, child.document, () => child.alert('此作业已过期！'));
      return {
        expired,
        cancelled: window.__cancelCalls,
        submitted: window.__submitCalls,
        anchor: document.querySelector('#popno').tagName,
        popup: getComputedStyle(document.querySelector('#workpop')).display
      };
    }, anchorConfirmation);
    assert.deepEqual(result, { expired: true, cancelled: 1, submitted: 0, anchor: 'A', popup: 'none' });
    assert.equal(nativeDialogs, 0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(submissions, beforeSubmissions);
  } finally { await page.close(); }
});

test('asynchronous expiry POST response closes its iframe-owned anchor confirmation and leaves an unrelated top popup visible', async () => {
  const beforeSubmissions = submissions;
  const page = await openPage();
  try {
    const result = await page.evaluate(async (markup) => {
      document.querySelector('#popcontent').textContent = '确认删除？';
      const child = document.querySelector('#child').contentWindow;
      child.document.body.insertAdjacentHTML('beforeend', markup);
      child.__submitCalls = 0;
      child.__cancelCalls = 0;
      child.popClickFunc = () => { child.document.querySelector('#workpop').style.display = 'none'; };
      let completed = false;
      const expired = await invokeChapterActionWithExpiryCapture(child, child.document, () => {
        const xhr = new child.XMLHttpRequest();
        xhr.open('POST', '/mooc-ans/work/addStudentWorkNewWeb?kind=expired');
        xhr.onload = () => { completed = true; };
        xhr.send();
      });
      return {
        expired,
        completed,
        cancelled: child.__cancelCalls,
        submitted: child.__submitCalls,
        childPopup: child.getComputedStyle(child.document.querySelector('#workpop')).display,
        topPopup: getComputedStyle(document.querySelector('#workpop')).display
      };
    }, anchorConfirmation);
    assert.deepEqual(result, { expired: true, completed: true, cancelled: 1, submitted: 0, childPopup: 'none', topPopup: 'block' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(submissions, beforeSubmissions + 1);
  } finally { await page.close(); }
});

test('ordinary POST failure remains retryable and keeps the confirmation available without an extra submission', async () => {
  const beforeSubmissions = submissions;
  const page = await openPage();
  try {
    const result = await page.evaluate(async () => {
      const child = document.querySelector('#child').contentWindow;
      let message = '';
      try {
        await invokeChapterActionWithExpiryCapture(child, child.document, () => {
          const xhr = new child.XMLHttpRequest();
          xhr.open('POST', '/mooc-ans/work/addStudentWorkNewWeb?kind=ordinary');
          xhr.send();
        });
      } catch (error) { message = error.message; }
      return {
        message,
        cancelled: window.__cancelCalls,
        submitted: window.__submitCalls,
        popup: getComputedStyle(document.querySelector('#workpop')).display
      };
    });
    assert.deepEqual(result, {
      message: '章节测试提交失败，将按正常次数重试。',
      cancelled: 0,
      submitted: 0,
      popup: 'block'
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(submissions, beforeSubmissions + 1);
  } finally { await page.close(); }
});

test('an unwrapped internal markup fragment is preserved because its owning confirmation overlay is not established', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate((markup) => {
      document.querySelector('form').remove();
      const template = document.createElement('template');
      template.innerHTML = markup;
      document.body.appendChild(template.content.querySelector('.popDiv'));
      const before = document.body.innerHTML;
      dismissChapterSubmissionDialog([window]);
      return {
        unchanged: before === document.body.innerHTML,
        cancelled: window.__cancelCalls,
        submitted: window.__submitCalls,
        visible: getComputedStyle(document.querySelector('.popDiv')).display !== 'none'
      };
    }, anchorConfirmation);
    assert.deepEqual(result, { unchanged: true, cancelled: 0, submitted: 0, visible: true });
  } finally { await page.close(); }
});

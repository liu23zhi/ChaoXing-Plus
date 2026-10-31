import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';

const puppeteer = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'))('puppeteer');
let browser, server, origin, runtime;
const popup = `<div id="workpop" style="display:none;position:fixed;inset:0">
  <div class="popDiv wid440 Marking"><div class="popHead" id="workpopFocus">
  <a id="popCloseFocus" href="javascript:;">关闭</a></div><p id="popcontent">确认提交？</p>
  <a id="popok" href="javascript:;">提交</a><a id="popno" href="javascript:;">取消</a></div></div>`;

before(async () => {
  const compile = async (path) => ts.transpileModule(await readFile(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText.replace(/^import[^\r\n]+[\r\n]/gm, '').replace(/^export /gm, '');
  runtime = `(() => { ${await compile('src/projects/cx-chapter-dialog.ts')}
    ${await compile('src/projects/cx-chapter-confirmation.ts')}
    window.createChapterConfirmationSession = createChapterConfirmationSession;
  })();`;
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><body>${popup}${request.url === '/'
      ? '<iframe id="A" src="/A"></iframe><iframe id="B" src="/B"></iframe>'
      : `<form><input id="jobid" name="jobid" value="${request.url === '/B' ? 'B' : 'A'}"></form>`}
      <span id="page-kind">${request.url}</span></body></html>`);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server'] });
});

after(async () => {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
});

async function inPage(action) {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    await page.addScriptTag({ content: runtime });
    return await action(page);
  } finally { await page.close(); }
}

test('a child precheck can bind its newly shown confirmation in an unscoped parent', async () => {
  const result = await inPage((page) => page.evaluate(() => {
    const child = document.querySelector('#A').contentWindow;
    const session = createChapterConfirmationSession(child, child, { jobId: 'A', isCurrent: () => true });
    try {
      const waiting = session.find();
      document.querySelector('#workpop').style.display = 'block';
      const found = session.find();
      return { waiting: !waiting, parent: found.ownerWindow === window,
        document: found.document === document, current: session.current()?.popup === found.popup };
    } finally { session.release(); }
  }));
  assert.deepEqual(result, { waiting: true, parent: true, document: true, current: true });
});

for (const text of ['确认提交？', '其它提示']) {
  test(`a pre-existing visible parent popup is preserved: ${text}`, async () => {
    const result = await inPage((page) => page.evaluate((text) => {
      const popup = document.querySelector('#workpop');
      popup.style.display = 'block';
      popup.querySelector('#popcontent').textContent = text;
      const child = document.querySelector('#A').contentWindow;
      let error = '';
      try { createChapterConfirmationSession(child, child, { jobId: 'A', isCurrent: () => true }); }
      catch (caught) { error = caught.message; }
      return { error, display: getComputedStyle(popup).display, text: popup.querySelector('#popcontent').textContent };
    }, text));
    assert.match(result.error, /确认|提示|弹窗/);
    assert.equal(result.display, 'block');
    assert.equal(result.text, text);
  });
}

test('a parent with another job ID cannot supply the current confirmation', async () => {
  const result = await inPage((page) => page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<form><input name="jobid" value="B"></form>');
    const child = document.querySelector('#A').contentWindow;
    const session = createChapterConfirmationSession(child, child, { jobId: 'A', isCurrent: () => true });
    try {
      document.querySelector('#workpop').style.display = 'block';
      return { found: Boolean(session.find()), display: getComputedStyle(document.querySelector('#workpop')).display };
    } finally { session.release(); }
  }));
  assert.deepEqual(result, { found: false, display: 'block' });
});

test('overlapping parent leases remain ambiguous after one attempt exits and the next round recovers', async () => {
  const result = await inPage((page) => page.evaluate(() => {
    const childA = document.querySelector('#A').contentWindow;
    const childB = document.querySelector('#B').contentWindow;
    const a = createChapterConfirmationSession(childA, childA, { jobId: 'A', isCurrent: () => true });
    const b = createChapterConfirmationSession(childB, childB, { jobId: 'B', isCurrent: () => true });
    const popup = document.querySelector('#workpop');
    const failure = (session) => { try { session.find(); return ''; } catch (error) { return error.message; } };
    try {
      popup.style.display = 'block';
      const firstA = failure(a), firstB = failure(b);
      b.release();
      const afterB = failure(a);
      a.release();
      popup.style.display = 'none';
      const next = createChapterConfirmationSession(childA, childA, { jobId: 'A', isCurrent: () => true });
      try {
        a.release();
        popup.style.display = 'block';
        return { firstA, firstB, afterB, recovered: next.find()?.ownerWindow === window };
      } finally { next.release(); }
    } finally { a.release(); b.release(); }
  }));
  for (const key of ['firstA', 'firstB', 'afterB']) assert.match(result[key], /归属|并发|冲突/);
  assert.equal(result.recovered, true);
});

test('a task switch invalidates an owned confirmation without touching the popup', async () => {
  const result = await inPage((page) => page.evaluate(() => {
    const child = document.querySelector('#A').contentWindow;
    let isCurrent = true;
    const session = createChapterConfirmationSession(child, child, { jobId: 'A', isCurrent: () => isCurrent });
    try {
      child.document.querySelector('#workpop').style.display = 'block';
      session.find();
      isCurrent = false;
      let error = '';
      try { session.find(); } catch (caught) { error = caught.message; }
      return { current: Boolean(session.current()), error,
        display: child.getComputedStyle(child.document.querySelector('#workpop')).display };
    } finally { session.release(); }
  }));
  assert.equal(result.current, false);
  assert.match(result.error, /任务|失效|切换/);
  assert.equal(result.display, 'block');
});

test('a reused WindowProxy with a new document invalidates the old binding', async () => {
  const result = await inPage(async (page) => {
    await page.evaluate(() => {
      const child = document.querySelector('#A').contentWindow;
      window.session = createChapterConfirmationSession(child, child, { jobId: 'A', isCurrent: () => true });
      child.document.querySelector('#workpop').style.display = 'block';
      window.session.find();
      child.location.href = '/replacement';
    });
    await page.waitForFunction(() => document.querySelector('#A').contentDocument.querySelector('#page-kind')?.textContent === '/replacement');
    return page.evaluate(() => {
      try {
        let error = '';
        try { window.session.find(); } catch (caught) { error = caught.message; }
        return { current: Boolean(window.session.current()), error };
      } finally { window.session.release(); }
    });
  });
  assert.equal(result.current, false);
  assert.match(result.error, /文档|失效|切换/);
});

test('a removed or replaced submit control cannot be rebound within the same attempt', async () => {
  const result = await inPage((page) => page.evaluate(() => {
    const child = document.querySelector('#A').contentWindow;
    const session = createChapterConfirmationSession(child, child, { jobId: 'A', isCurrent: () => true });
    try {
      child.document.querySelector('#workpop').style.display = 'block';
      session.find();
      const submit = child.document.querySelector('#popok');
      submit.replaceWith(submit.cloneNode(true));
      let error = '';
      try { session.find(); } catch (caught) { error = caught.message; }
      return { current: Boolean(session.current()), error };
    } finally { session.release(); }
  }));
  assert.equal(result.current, false);
  assert.match(result.error, /确认|失效/);
});

test('clear permits the next precheck after the current task old confirmation was dismissed', async () => {
  const result = await inPage((page) => page.evaluate(() => {
    const child = document.querySelector('#A').contentWindow;
    const session = createChapterConfirmationSession(child, child, { jobId: 'A', isCurrent: () => true });
    try {
      const popup = child.document.querySelector('#workpop');
      popup.style.display = 'block';
      session.find();
      popup.style.display = 'none';
      session.clear();
      const waiting = !session.find();
      popup.style.display = 'block';
      return { waiting, rebound: session.find()?.ownerWindow === child };
    } finally { session.release(); }
  }));
  assert.deepEqual(result, { waiting: true, rebound: true });
});

test('two documents with visible known confirmations cannot be resolved by source order', async () => {
  const result = await inPage((page) => page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<form><input name="jobid" value="A"></form>');
    const child = document.querySelector('#A').contentWindow;
    const session = createChapterConfirmationSession(child, child, { jobId: 'A', isCurrent: () => true });
    try {
      child.document.querySelector('#workpop').style.display = 'block';
      document.querySelector('#workpop').style.display = 'block';
      try { session.find(); return ''; } catch (error) { return error.message; }
    } finally { session.release(); }
  }));
  assert.match(result, /归属|冲突|多个/);
});

test('the same visible templates in one document cannot be selected by source order', async () => {
  const result = await inPage((page) => page.evaluate(() => {
    const child = document.querySelector('#A').contentWindow;
    const session = createChapterConfirmationSession(child, child, { jobId: 'A', isCurrent: () => true });
    try {
      const popup = child.document.querySelector('#workpop');
      popup.style.display = 'block';
      child.document.body.appendChild(popup.cloneNode(true));
      return Boolean(session.find());
    } finally { session.release(); }
  }));
  assert.equal(result, false);
});

test('an intermediate ancestor can own the confirmation and its lease is shared across runtime copies', async () => {
  const result = await inPage(async (page) => {
    await page.evaluate(() => {
      const middle = document.querySelector('#A').contentWindow;
      middle.document.body.insertAdjacentHTML('beforeend', '<iframe id="inner" src="/A"></iframe>');
    });
    await page.waitForFunction(() => document.querySelector('#A').contentDocument.querySelector('#inner')?.contentDocument?.querySelector('#jobid'));
    await page.addScriptTag({ content: runtime });
    return page.evaluate(() => {
      const middle = document.querySelector('#A').contentWindow;
      const child = middle.document.querySelector('#inner').contentWindow;
      const session = createChapterConfirmationSession(child, child, { jobId: 'A', isCurrent: () => true });
      try {
        middle.document.querySelector('#workpop').style.display = 'block';
        return { found: session.find()?.ownerWindow === middle,
          current: session.current()?.document === middle.document };
      } finally { session.release(); }
    });
  });
  assert.deepEqual(result, { found: true, current: true });
});

test('separate runtime closures share the parent lease rather than treating it as unoccupied', async () => {
  const result = await inPage(async (page) => {
    await page.evaluate(() => { window.firstFactory = createChapterConfirmationSession; });
    await page.addScriptTag({ content: runtime });
    return page.evaluate(() => {
      const childA = document.querySelector('#A').contentWindow;
      const childB = document.querySelector('#B').contentWindow;
      const a = window.firstFactory(childA, childA, { jobId: 'A', isCurrent: () => true });
      const b = createChapterConfirmationSession(childB, childB, { jobId: 'B', isCurrent: () => true });
      try {
        document.querySelector('#workpop').style.display = 'block';
        try { a.find(); return ''; } catch (error) { return error.message; }
      } finally { a.release(); b.release(); }
    });
  });
  assert.match(result, /归属|并发|冲突/);
});

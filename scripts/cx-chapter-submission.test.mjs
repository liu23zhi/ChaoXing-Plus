import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from '@typescript/typescript6';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
let server;
let browser;
let origin;
let runtime;
let helperRuntime;
const endpoint = '/mooc-ans/work/addStudentWorkNewWeb';

before(async () => {
  const source = await readFile('src/projects/cx-chapter-submission.ts', 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  runtime = `(() => { const exports = {}; ${compiled}; window.observeChapterSubmission = exports.observeChapterSubmission; })();`;
  const dialogSource = await readFile('src/projects/cx-chapter-dialog.ts', 'utf8');
  const dialogCompiled = ts.transpileModule(dialogSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  runtime += `\n(() => { const exports = {}; ${dialogCompiled}; window.dismissChapterSubmissionDialog = exports.dismissChapterSubmissionDialog; })();`;
  const cxSource = await readFile('src/projects/cx.ts', 'utf8');
  const parsedCx = ts.createSourceFile('cx.ts', cxSource, ts.ScriptTarget.Latest, true);
  const helperNames = new Set([
    'isExpiredChapterText', 'isExpiredChapterResponse', 'isChapterSubmissionFailure',
    'isExpiredChapterMessage', 'invokeChapterActionWithExpiryCapture'
  ]);
  const helperDeclarations = parsedCx.statements.filter((node) => ts.isFunctionDeclaration(node) && helperNames.has(node.name?.text));
  assert.equal(helperDeclarations.length, helperNames.size);
  const helperCode = ts.transpileModule(helperDeclarations.map((node) => node.getText(parsedCx)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 }
  }).outputText;
  helperRuntime = `(() => {
    const topWindow = window;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    ${helperCode}
    window.invokeChapterActionWithExpiryCapture = invokeChapterActionWithExpiryCapture;
  })();`;
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.searchParams.has('disconnect')) {
      request.socket.destroy();
      return;
    }
    if (url.pathname === '/' || url.pathname === '/frame') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html><body>${url.pathname === '/' ? '<iframe src="/frame" id="child"></iframe>' : ''}</body></html>`);
      return;
    }
    response.statusCode = Number(url.searchParams.get('http') || 200);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    const kind = url.searchParams.get('kind');
    const payload = kind === 'ordinary'
      ? { status: false, msg: '暂时提交失败，请稍后重试' }
      : kind === 'unknown' ? { msg: 'received' }
      : kind === 'success'
        ? { status: true, msg: '提交成功' }
        : kind === 'successExpired'
          ? { status: true, msg: '此作业已过期！' }
          : { status: false, msg: '此作业已过期！' };
    setTimeout(() => response.end(JSON.stringify(payload)), Number(url.searchParams.get('delay') || 40));
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
  await page.addScriptTag({ content: helperRuntime });
  return page;
}

test('overlapping observers restore the original hooks in either completion order', async () => {
  const page = await openPage();
  try {
    assert.equal(await page.evaluate(async () => {
      const original = [fetch, XMLHttpRequest.prototype.open, XMLHttpRequest.prototype.send, alert, confirm];
      const first = invokeChapterActionWithExpiryCapture(window, document, () => new Promise((resolve) => setTimeout(resolve, 20)));
      const second = invokeChapterActionWithExpiryCapture(window, document, () => new Promise((resolve) => setTimeout(resolve, 40)));
      await Promise.all([first, second]);
      return [fetch, XMLHttpRequest.prototype.open, XMLHttpRequest.prototype.send, alert, confirm].every((value, index) => value === original[index]);
    }), true);
  } finally { await page.close(); }
});

test('one job cannot inherit an expired response from another job through a shared top window', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async (endpoint) => {
      const child = document.querySelector('#child').contentWindow;
      return invokeChapterActionWithExpiryCapture(child, child.document, () => {
        fetch(endpoint + '?kind=success', { method: 'POST', body: 'jobid=A' });
        fetch(endpoint, { method: 'POST', body: 'jobid=B' });
      }, 0, { phase: 'submit', jobId: 'A' });
    }, endpoint);
    assert.equal(result, false);
  } finally { await page.close(); }
});

test('final submission requires positive completion evidence instead of treating no request as success', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async () => {
      try {
        await invokeChapterActionWithExpiryCapture(window, document, () => {}, 0, { phase: 'submit', timeoutMs: 30 });
        return 'completed';
      } catch { return 'retryable'; }
    });
    assert.equal(result, 'retryable');
  } finally { await page.close(); }
});

test('successful precheck return values cannot substitute for a successful POST response', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async (endpoint) => {
      try {
        await invokeChapterActionWithExpiryCapture(window, document, () => {
          fetch(endpoint + '?kind=unknown', { method: 'POST', body: 'jobid=A' });
          return { status: true };
        }, 0, { phase: 'submit', jobId: 'A' });
        return 'completed';
      } catch { return 'retryable'; }
    }, endpoint);
    assert.equal(result, 'retryable');
  } finally { await page.close(); }
});

test('submission opened before observation is still captured at send', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async (endpoint) => {
      const request = new XMLHttpRequest();
      request.open('POST', endpoint);
      return invokeChapterActionWithExpiryCapture(window, document, () => request.send('jobid=A'), 0, { phase: 'submit', jobId: 'A' });
    }, endpoint);
    assert.equal(result, true);
  } finally { await page.close(); }
});

test('final submission waits for an asynchronous precheck to dispatch the actual POST', async () => {
  const page = await openPage();
  try {
    assert.equal(await page.evaluate(async (endpoint) => {
      return invokeChapterActionWithExpiryCapture(window, document, () => {
        setTimeout(() => fetch(endpoint + '?kind=success', { method: 'POST', body: new URLSearchParams({ jobid: 'A' }) }), 35);
      }, 0, { phase: 'submit', jobId: 'A', timeoutMs: 500 });
    }, endpoint), false);
  } finally { await page.close(); }
});

test('reused job IDs in a shared parent are isolated by course, class and chapter identity', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async (endpoint) => {
      const child = document.querySelector('#child').contentWindow;
      const identity = { courseId: 'course', classId: 'class', chapterId: 'chapter-A', tabKey: 'tab-A', jobId: 'same-job', attemptId: 'attempt-1' };
      const seen = [];
      const observer = observeChapterSubmission([window, child], (value, metadata) => seen.push([JSON.parse(value).status, metadata.identity.attemptId]), { ownerWindow: child, identity });
      try {
        await Promise.all([
          fetch(endpoint + '?kind=success', { method: 'POST', body: new URLSearchParams({ jobid: 'same-job', courseid: 'course', clazzid: 'class', knowledgeid: 'chapter-A' }) }),
          fetch(endpoint, { method: 'POST', body: JSON.stringify({ jobid: 'same-job', courseid: 'course', _classId: 'class', knowledgeid: 'chapter-B' }) }),
          fetch(endpoint, { method: 'POST', body: 'jobid=same-job' })
        ]);
        await observer.wait();
        return seen;
      } finally { observer.restore(); }
    }, endpoint);
    assert.deepEqual(result, [[true, 'attempt-1']]);
  } finally { await page.close(); }
});

test('overlapping attempts for the same task retain ownership of their own fetch request', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async (endpoint) => {
      const identity = { courseId: 'course', classId: 'class', chapterId: 'chapter', tabKey: 'tab', jobId: 'same-job' };
      const first = invokeChapterActionWithExpiryCapture(window, document,
        () => { fetch(endpoint + '?delay=100', { method: 'POST', body: 'jobid=same-job&knowledgeid=chapter' }); },
        0, { phase: 'submit', identity: { ...identity, attemptId: 'first' }, timeoutMs: 500 });
      const second = invokeChapterActionWithExpiryCapture(window, document,
        () => { fetch(endpoint + '?kind=success', { method: 'POST', body: 'jobid=same-job&knowledgeid=chapter' }); },
        0, { phase: 'submit', identity: { ...identity, attemptId: 'second' }, timeoutMs: 500 });
      return Promise.all([first, second]);
    }, endpoint);
    assert.deepEqual(result, [true, false]);
  } finally { await page.close(); }
});

test('another job native expiry dialog cannot terminate the active job in the same window', async () => {
  const page = await openPage();
  let dialogs = 0;
  page.on('dialog', async (dialog) => { dialogs++; await dialog.dismiss(); });
  try {
    assert.equal(await page.evaluate(async (endpoint) => {
      return invokeChapterActionWithExpiryCapture(window, document, () => {
        const other = new XMLHttpRequest();
        other.open('POST', endpoint);
        other.onload = () => alert(JSON.parse(other.responseText).msg);
        other.send('jobid=B');
        fetch(endpoint + '?kind=success&delay=100', { method: 'POST', body: 'jobid=A' });
      }, 0, { phase: 'submit', jobId: 'A' });
    }, endpoint), false);
    assert.equal(dialogs, 1);
  } finally { await page.close(); }
});

for (const transport of ['fetch', 'xhr-onload']) {
  test(`owned ${transport} completion dialogs are suppressed with explicit task identity`, async () => {
    const page = await openPage();
    let dialogs = 0;
    page.on('dialog', async (dialog) => { dialogs++; await dialog.dismiss(); });
    try {
      assert.equal(await page.evaluate(async (endpoint, transport) => {
        return invokeChapterActionWithExpiryCapture(window, document, () => {
          if (transport === 'fetch') {
            fetch(endpoint, { method: 'POST', body: 'jobid=A' }).then((response) => response.json()).then((value) => alert(value.msg));
          } else {
            const request = new XMLHttpRequest();
            request.open('POST', endpoint);
            request.onload = () => alert(JSON.parse(request.responseText).msg);
            request.send('jobid=A');
          }
        }, 0, { phase: 'submit', jobId: 'A' });
      }, endpoint, transport), true);
      assert.equal(dialogs, 0);
    } finally { await page.close(); }
  });
}

test('timeout aborts only the owned XHR and suppresses its delayed expired page callback', async () => {
  const page = await openPage();
  let dialogs = 0;
  page.on('dialog', async (dialog) => { dialogs++; await dialog.dismiss(); });
  try {
    const result = await page.evaluate(async (endpoint) => {
      const original = [fetch, XMLHttpRequest.prototype.open, XMLHttpRequest.prototype.send, alert, confirm];
      let owned;
      const other = new XMLHttpRequest();
      const otherDone = new Promise((resolve) => { other.onload = () => resolve(other.status); });
      let failed = false;
      try {
        await invokeChapterActionWithExpiryCapture(window, document, () => {
          owned = new XMLHttpRequest();
          owned.open('POST', endpoint + '?delay=200');
          owned.onreadystatechange = () => { if (owned.readyState === 4 && owned.status) alert(JSON.parse(owned.responseText).msg); };
          owned.send('jobid=A');
          other.open('POST', endpoint + '?kind=success&delay=100');
          other.send('jobid=B');
        }, 0, { phase: 'submit', jobId: 'A', timeoutMs: 30 });
      } catch { failed = true; }
      const otherStatus = await otherDone;
      await new Promise((resolve) => setTimeout(resolve, 220));
      return { failed, ownedStatus: owned.status, otherStatus,
        restored: [fetch, XMLHttpRequest.prototype.open, XMLHttpRequest.prototype.send, alert, confirm].every((value, index) => value === original[index]) };
    }, endpoint);
    assert.deepEqual(result, { failed: true, ownedStatus: 0, otherStatus: 200, restored: true });
    assert.equal(dialogs, 0);
  } finally { await page.close(); }
});

test('timeout aborts an owned fetch while preserving another task request', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async (endpoint) => {
      let ownedResult;
      let otherResult;
      let failed = false;
      try {
        await invokeChapterActionWithExpiryCapture(window, document, () => {
          ownedResult = fetch(endpoint + '?delay=200', { method: 'POST', body: new FormData(document.createElement('form')) })
            .then(() => 'unexpected', (error) => error.name);
          otherResult = fetch(endpoint + '?kind=success&delay=100', { method: 'POST', body: 'jobid=B' }).then((response) => response.status);
        }, 0, { phase: 'submit', jobId: 'A', timeoutMs: 30 });
      } catch { failed = true; }
      return { failed, owned: await ownedResult, other: await otherResult };
    }, endpoint);
    assert.deepEqual(result, { failed: true, owned: 'AbortError', other: 200 });
  } finally { await page.close(); }
});

test('timeout also aborts a previously opened XHR when its sent body proves task ownership', async () => {
  const page = await openPage();
  let dialogs = 0;
  page.on('dialog', async (dialog) => { dialogs++; await dialog.dismiss(); });
  try {
    const result = await page.evaluate(async (endpoint) => {
      const request = new XMLHttpRequest();
      request.open('POST', endpoint + '?delay=150');
      request.onload = () => alert(JSON.parse(request.responseText).msg);
      let rejected = false;
      try {
        await invokeChapterActionWithExpiryCapture(window, document, () => request.send('jobid=A'), 0,
          { phase: 'submit', jobId: 'A', timeoutMs: 30 });
      } catch { rejected = true; }
      await new Promise((resolve) => setTimeout(resolve, 180));
      return { rejected, status: request.status };
    }, endpoint);
    assert.deepEqual(result, { rejected: true, status: 0 });
    assert.equal(dialogs, 0);
  } finally { await page.close(); }
});

test('submission observer waits for asynchronous XHR and inspects text before the page completion callback', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async (endpoint) => {
      const events = [];
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      const observer = observeChapterSubmission([window, window], (value) => events.push(['observed', JSON.parse(value).msg]));
      try {
        const request = new XMLHttpRequest();
        request.open('POST', `${endpoint}?token=not-a-real-token`);
        request.onreadystatechange = () => {
          if (request.readyState === 4) events.push(['page', JSON.parse(request.responseText).msg]);
        };
        request.send('answer=example');
        await observer.wait();
        return { events, active: XMLHttpRequest.prototype.open !== originalOpen };
      } finally {
        observer.restore();
        window.__restored = XMLHttpRequest.prototype.open === originalOpen && XMLHttpRequest.prototype.send === originalSend;
      }
    }, endpoint);
    assert.deepEqual(result.events, [['observed', '此作业已过期！'], ['page', '此作业已过期！']]);
    assert.equal(result.active, true);
    assert.equal(await page.evaluate(() => window.__restored), true);
  } finally { await page.close(); }
});

test('submission observer captures JSON XHR and fetch clone responses without consuming page bodies', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async (endpoint) => {
      const observed = [];
      const observer = observeChapterSubmission([window], (value) => observed.push(typeof value === 'string' ? JSON.parse(value) : value));
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('post', endpoint);
        xhr.responseType = 'json';
        xhr.send();
        const fetched = fetch(new Request(`${endpoint}/?query=1`, { method: 'POST' })).then((response) => response.json());
        await observer.wait();
        return { observed, xhr: xhr.response, fetched: await fetched };
      } finally { observer.restore(); }
    }, endpoint);
    assert.deepEqual(result.observed, [result.xhr, result.fetched]);
    assert.deepEqual(result.xhr, { status: false, msg: '此作业已过期！' });
  } finally { await page.close(); }
});

test('submission observer matches the complete endpoint and method while allowing case, trailing slash and query', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async (endpoint) => {
      const observed = [];
      const observer = observeChapterSubmission([window], (value) => observed.push(value));
      try {
        await Promise.all([
          fetch(endpoint, { method: 'GET' }),
          fetch(`/other${endpoint}`, { method: 'POST' }),
          fetch(`${endpoint}Suffix`, { method: 'POST' }),
          fetch(`/other?url=${endpoint}`, { method: 'POST' }),
          fetch(`${endpoint.toUpperCase()}/?query=1`, { method: 'POST' })
        ]);
        await observer.wait();
        return observed.length;
      } finally { observer.restore(); }
    }, endpoint);
    assert.equal(result, 1);
  } finally { await page.close(); }
});

test('submission observer supports separate parent and iframe realms and restores both', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async (endpoint) => {
      const child = document.querySelector('#child').contentWindow;
      const originalChildFetch = child.fetch;
      const originalTopFetch = window.fetch;
      const observed = [];
      const observer = observeChapterSubmission([window, child, child], (value) => observed.push(value));
      try {
        child.fetch(new child.URL(endpoint, location.href), { method: 'POST' });
        const xhr = new XMLHttpRequest();
        xhr.open('POST', endpoint);
        xhr.send();
        await observer.wait();
      } finally { observer.restore(); }
      return { count: observed.length, restored: child.fetch === originalChildFetch && window.fetch === originalTopFetch };
    }, endpoint);
    assert.deepEqual(result, { count: 2, restored: true });
  } finally { await page.close(); }
});

test('submission observer preserves fetch rejection and makes transport or HTTP errors retryable', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async (endpoint) => {
      const run = async (query) => {
        const observed = [];
        const observer = observeChapterSubmission([window], (value) => observed.push(value));
        let fetchRejected = false;
        let waitMessage;
        try {
          const request = fetch(`${endpoint}?${query}`, { method: 'POST' }).catch(() => { fetchRejected = true; });
          try { await observer.wait(); } catch (error) { waitMessage = error.message; }
          await request;
          return { observed: observed.length, fetchRejected, waitMessage };
        } finally { observer.restore(); }
      };
      return { network: await run('disconnect=1'), http: await run('http=503') };
    }, endpoint);
    assert.equal(result.network.fetchRejected, true);
    assert.equal(result.network.observed, 0);
    assert.equal(result.network.waitMessage, 'Chapter submission request failed.');
    assert.equal(result.http.fetchRejected, false);
    assert.equal(result.http.observed, 1);
    assert.equal(result.http.waitMessage, 'Chapter submission returned an HTTP error.');
  } finally { await page.close(); }
});

test('submission observer reports XHR transport errors and handles repeated open calls without waiting forever', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async (endpoint) => {
      const observer = observeChapterSubmission([window], () => {});
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${endpoint}?disconnect=1`);
        xhr.send();
        try { await observer.wait(); } catch (error) { return error.message; }
        return '';
      } finally { observer.restore(); }
    }, endpoint);
    assert.equal(result, 'Chapter submission request failed.');

    const interrupted = await page.evaluate(async (endpoint) => {
      const observer = observeChapterSubmission([window], () => {});
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', endpoint);
        xhr.send();
        xhr.open('GET', '/other');
        try { await observer.wait(); } catch (error) { return error.message; }
        return '';
      } finally { observer.restore(); }
    }, endpoint);
    assert.equal(interrupted, 'Chapter submission request was interrupted.');
  } finally { await page.close(); }
});

test('submission observer has a bounded response wait and tolerates inaccessible windows', async () => {
  const source = await readFile('src/projects/cx-chapter-submission.ts', 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const timeoutDelays = [];
  const context = vm.createContext({
    exports: {}, URL,
    setTimeout(callback, delay) {
      timeoutDelays.push(delay);
      return setTimeout(callback, delay > 1000 ? 10 : delay);
    },
    clearTimeout
  });
  vm.runInContext(compiled, context);
  const requestWindow = { location: { href: 'http://localhost/' }, fetch: () => new Promise(() => {}) };
  const inaccessible = {};
  Object.defineProperty(inaccessible, 'location', { get() { throw new Error('cross origin'); } });
  const originalFetch = requestWindow.fetch;
  const observer = context.exports.observeChapterSubmission([inaccessible, requestWindow], () => {});
  try {
    requestWindow.fetch(endpoint, { method: 'POST' });
    await assert.rejects(observer.wait(), /Chapter submission response timed out\./u);
    assert.equal(timeoutDelays.some((delay) => delay > 1000 && delay <= 30000), true);
  } finally { observer.restore(); }
  assert.equal(requestWindow.fetch, originalFetch);
});

test('submission observer does not overwrite newer wrappers when restoring', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(() => {
      const observer = observeChapterSubmission([window], () => {});
      const laterFetch = function () {};
      const laterOpen = function () {};
      fetch = laterFetch;
      XMLHttpRequest.prototype.open = laterOpen;
      observer.restore();
      observer.restore();
      return fetch === laterFetch && XMLHttpRequest.prototype.open === laterOpen;
    });
    assert.equal(result, true);
  } finally { await page.close(); }
});

test('chapter helper awaits an unreturned iframe XHR, suppresses its native expiry alert and restores handlers', async () => {
  const page = await openPage();
  let nativeDialogs = 0;
  page.on('dialog', async (dialog) => {
    nativeDialogs += 1;
    await dialog.dismiss();
  });
  try {
    const result = await page.evaluate(async (endpoint) => {
      const child = document.querySelector('#child').contentWindow;
      const originalChildAlert = child.alert;
      const originalTopAlert = window.alert;
      let completed = false;
      const expired = await invokeChapterActionWithExpiryCapture(child, child.document, () => {
        const xhr = new child.XMLHttpRequest();
        xhr.open('POST', endpoint);
        xhr.onreadystatechange = () => {
          if (xhr.readyState !== 4) return;
          completed = true;
          child.alert(JSON.parse(xhr.responseText).msg);
        };
        xhr.send();
      });
      return {
        expired,
        completed,
        restored: child.alert === originalChildAlert && window.alert === originalTopAlert
      };
    }, endpoint);
    assert.deepEqual(result, { expired: true, completed: true, restored: true });
    assert.equal(nativeDialogs, 0);
  } finally { await page.close(); }
});

test('chapter helper preserves ordinary asynchronous submission failures for normal retry', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async (endpoint) => {
      let completed = false;
      try {
        await invokeChapterActionWithExpiryCapture(window, document, () => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `${endpoint}?kind=ordinary`);
          xhr.responseType = 'json';
          xhr.onload = () => { completed = true; };
          xhr.send();
        });
        return { completed, error: '' };
      } catch (error) { return { completed, error: error.message }; }
    }, endpoint);
    assert.deepEqual(result, { completed: true, error: '章节测试提交失败，将按正常次数重试。' });
  } finally { await page.close(); }
});

test('chapter helper bounds a never-resolving action Promise and restores native handlers after timeout', async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async () => {
      const child = document.querySelector('#child').contentWindow;
      const originalAlert = child.alert;
      const originalConfirm = child.confirm;
      const originalFetch = child.fetch;
      const originalSetTimeout = window.setTimeout;
      const originalClearTimeout = window.clearTimeout;
      const requestedDelays = [];
      const clearedTimers = [];
      window.setTimeout = (callback, delay, ...args) => {
        requestedDelays.push(delay);
        return originalSetTimeout(callback, delay > 1000 && delay <= 30000 ? 20 : delay, ...args);
      };
      window.clearTimeout = (timer) => {
        clearedTimers.push(timer);
        return originalClearTimeout(timer);
      };
      let safetyTimer;
      try {
        const actual = invokeChapterActionWithExpiryCapture(child, child.document, () => new Promise(() => {}))
          .then(() => 'unexpected success', (error) => error.message);
        const safety = new Promise((resolve) => {
          safetyTimer = originalSetTimeout(() => resolve('unbounded action'), 2000);
        });
        const error = await Promise.race([actual, safety]);
        return {
          error,
          bounded: requestedDelays.some((delay) => delay > 1000 && delay <= 30000),
          timerCleared: clearedTimers.length > 0,
          restored: child.alert === originalAlert && child.confirm === originalConfirm && child.fetch === originalFetch
        };
      } finally {
        originalClearTimeout(safetyTimer);
        window.setTimeout = originalSetTimeout;
        window.clearTimeout = originalClearTimeout;
      }
    });
    assert.deepEqual(result, {
      error: '章节测试提交响应超时，将按正常次数重试。',
      bounded: true,
      timerCleared: true,
      restored: true
    });
  } finally { await page.close(); }
});

for (const kind of ['success', 'successExpired']) {
  test(`chapter helper does not abandon a status:true JSON response (${kind})`, async () => {
    const page = await openPage();
    try {
      const result = await page.evaluate(async ({ endpoint, kind }) => {
        let completed = false;
        const expired = await invokeChapterActionWithExpiryCapture(window, document, () => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `${endpoint}?kind=${kind}`);
          xhr.onload = () => { completed = true; };
          xhr.send();
        });
        return { expired, completed };
      }, { endpoint, kind });
      assert.deepEqual(result, { expired: false, completed: true });
    } finally { await page.close(); }
  });
}

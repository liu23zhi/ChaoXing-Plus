import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';

const puppeteer = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'))('puppeteer');
let browser;
let ownerServer;
let childServer;
let ownerUrl;
let childUrl;
let runtime;
const chapterAttribute = 'data-chaoxing-plus-deferred-chapters';
const courseAttribute = 'data-chaoxing-plus-deferred-courses';
const decisionAttribute = 'data-chaoxing-plus-manual-answer-decision';
const declinedAttribute = 'data-chaoxing-plus-manual-answer-declined';

before(async () => {
  const compiled = ts.transpileModule(await readFile('src/projects/cx-course-session.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
  }).outputText;
  runtime = `(() => { const exports = {}; ${compiled}; window.initializeCourseSession = exports.initializeCourseSession; })();`;
  const serve = async (html) => {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
  };
  ownerServer = await serve('<!doctype html><html><body><input id="curCourseId" value="course"><input id="curClazzId" value="class"></body></html>');
  childServer = await serve('<!doctype html><html><body>Course task frame</body></html>');
  ownerUrl = `http://127.0.0.1:${ownerServer.address().port}/`;
  childUrl = `http://127.0.0.1:${childServer.address().port}/`;
  browser = await puppeteer.launch({
    executablePath: process.env.CX_BROWSER_EXECUTABLE, headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking']
  });
});

after(async () => {
  await browser?.close();
  for (const server of [ownerServer, childServer]) if (server) await new Promise((resolve) => server.close(resolve));
});

async function install(frame, options = {}) {
  await frame.addScriptTag({ content: runtime });
  await frame.evaluate((options) => {
    window.prompts = 0;
    window.session = window.initializeCourseSession(window, {
      noDiskWrite: () => Boolean(window.memoryOnly),
      handshakeMs: options.handshakeMs || 300,
      confirm: () => { window.prompts++; return new Promise((resolve) => { window.resolveDecision = resolve; }); }
    });
  }, options);
}

async function openPage() {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(ownerUrl);
  return page;
}

async function addFrame(page, id, url = childUrl) {
  await page.evaluate(({ id, url }) => {
    const frame = document.createElement('iframe');
    frame.id = id;
    frame.src = url;
    document.body.appendChild(frame);
  }, { id, url });
  const element = await page.waitForSelector(`#${id}`);
  const frame = await element.contentFrame();
  await frame.waitForFunction((url) => location.href === url && document.readyState === 'complete', {}, url);
  return frame;
}

test('two cross-origin task frames share one pending decision and remember manual choice', async () => {
  const page = await openPage();
  try {
    await install(page);
    const first = await addFrame(page, 'first');
    const second = await addFrame(page, 'second');
    await install(first);
    await install(second);
    assert.equal(await first.evaluate(() => window.session.ready()), true);
    assert.equal(await second.evaluate(() => window.session.ready()), true);
    await Promise.all([first, second].map((frame) => frame.evaluate(() => {
      window.result = 'pending';
      window.session.requestManualDecision().then((accepted) => { window.result = accepted; });
    })));
    await page.waitForFunction(() => window.prompts === 1);
    // The owner has taken responsibility; passing the handshake bound must not open another modal.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 450)));
    assert.equal(await page.evaluate(() => window.prompts), 1);
    assert.equal(await first.evaluate(() => window.prompts), 0);
    assert.equal(await second.evaluate(() => window.prompts), 0);
    await page.evaluate(() => window.resolveDecision(false));
    await Promise.all([first, second].map((frame) => frame.waitForFunction(() => window.result === false)));
    assert.equal(await first.evaluate(() => window.session.requestManualDecision()), false);
    assert.equal(await second.evaluate(() => window.session.requestManualDecision()), false);
    assert.equal(await page.evaluate(() => window.prompts), 1);
  } finally { await page.close(); }
});

test('cross-origin accepted decision reaches both waiting callers without a second prompt', async () => {
  const page = await openPage();
  try {
    await install(page);
    const frame = await addFrame(page, 'child');
    await install(frame);
    await frame.evaluate(() => { window.session.requestManualDecision().then((value) => { window.result = value; }); });
    await page.waitForFunction(() => window.prompts === 1);
    await page.evaluate(() => window.resolveDecision(true));
    await frame.waitForFunction(() => window.result === true);
    assert.equal(await frame.evaluate(() => window.session.requestManualDecision()), true);
    assert.equal(await page.evaluate(() => window.prompts), 1);
  } finally { await page.close(); }
});

test('a remote owner handshake failure pauses without calling local confirm', async () => {
  const page = await openPage();
  try {
    const frame = await addFrame(page, 'child');
    await install(frame, { handshakeMs: 100 });
    assert.equal(await frame.evaluate(() => window.session.ready()), false);
    assert.equal(await frame.evaluate(() => window.session.requestManualDecision()), false);
    assert.equal(await frame.evaluate(() => window.prompts), 0);
  } finally { await page.close(); }
});

test('a delayed owner can accept a child before its bounded handshake expires', async () => {
  const page = await openPage();
  try {
    const frame = await addFrame(page, 'child');
    await install(frame, { handshakeMs: 1000 });
    await install(page);
    assert.equal(await frame.evaluate(() => window.session.ready()), true);
    assert.equal(await page.evaluate(() => window.prompts), 0);
  } finally { await page.close(); }
});

test('real page.reload restores terminal decisions, attempts, and the declined manual answer state', async () => {
  const page = await openPage();
  try {
    await install(page);
    await page.evaluate(({ chapterAttribute, courseAttribute, decisionAttribute, declinedAttribute }) => {
      const key = JSON.stringify(['course', 'class', 'chapter']);
      const courseKey = JSON.stringify(['course', 'class']);
      document.documentElement.setAttribute(chapterAttribute, JSON.stringify({
        [key]: { scope: key, phase: 'settled', inspectedTabs: ['tab'], tasks: {
          task: { tabKey: 'tab', jobId: 'expired', attempts: 2, missingVisits: 0, terminalExpired: true, state: 'abandoned' }
        } }
      }));
      document.documentElement.setAttribute(courseAttribute, JSON.stringify({
        [courseKey]: { scope: courseKey, phase: 'settled', chapterIds: ['chapter'], inspectedChapters: ['chapter'] }
      }));
      document.documentElement.setAttribute(decisionAttribute, 'declined');
      document.documentElement.setAttribute(declinedAttribute, 'true');
      window.session.persist();
    }, { chapterAttribute, courseAttribute, decisionAttribute, declinedAttribute });
    await page.reload({ waitUntil: 'load' });
    await install(page);
    const restored = await page.evaluate(({ chapterAttribute, courseAttribute, decisionAttribute, declinedAttribute }) => ({
      chapters: JSON.parse(document.documentElement.getAttribute(chapterAttribute)),
      course: JSON.parse(document.documentElement.getAttribute(courseAttribute)),
      decision: document.documentElement.getAttribute(decisionAttribute), declined: document.documentElement.hasAttribute(declinedAttribute)
    }), { chapterAttribute, courseAttribute, decisionAttribute, declinedAttribute });
    const task = Object.values(Object.values(restored.chapters)[0].tasks)[0];
    assert.deepEqual([task.attempts, task.state, task.terminalExpired], [2, 'abandoned', true]);
    assert.equal(Object.values(restored.course)[0].phase, 'settled');
    assert.equal(restored.decision, 'declined');
    assert.equal(restored.declined, true);
    assert.equal(await page.evaluate(() => window.session.requestManualDecision()), false);
    assert.equal(await page.evaluate(() => window.prompts), 0);
  } finally { await page.close(); }
});

test('no-disk-write never accesses storage and prevents automatic reload once a decision exists', async () => {
  const page = await openPage();
  try {
    await page.evaluate(() => {
      window.memoryOnly = true;
      window.storageAccesses = 0;
      Object.defineProperty(window, 'sessionStorage', { get() { window.storageAccesses++; throw new Error('must not access storage'); } });
    });
    await install(page);
    assert.equal(await page.evaluate(() => window.session.canReload()), true);
    await page.evaluate(() => { window.session.requestManualDecision(); });
    await page.waitForFunction(() => window.prompts === 1);
    assert.equal(await page.evaluate(() => window.session.canReload()), false);
    await page.evaluate(() => { window.resolveDecision(false); window.session.persist(); });
    assert.equal(await page.evaluate(() => window.storageAccesses), 0);
  } finally { await page.close(); }
});

test('storage SecurityError falls back to memory without resetting declined decisions', async () => {
  const page = await openPage();
  try {
    await page.evaluate(() => {
      Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('denied', 'SecurityError'); } });
    });
    await install(page);
    await page.evaluate(() => { window.session.requestManualDecision(); });
    await page.waitForFunction(() => window.prompts === 1);
    await page.evaluate(() => window.resolveDecision(false));
    await page.waitForFunction(() => document.documentElement.getAttribute('data-chaoxing-plus-manual-answer-decision') === 'declined');
    assert.equal(await page.evaluate(() => window.session.canReload()), false);
    assert.equal(await page.evaluate(() => window.session.requestManualDecision()), false);
    assert.equal(await page.evaluate(() => window.prompts), 1);
  } finally { await page.close(); }
});

test('course changes isolate manual decisions and restoring a previous course does not re-prompt', async () => {
  const page = await openPage();
  try {
    await install(page);
    await page.evaluate(() => { window.session.requestManualDecision(); });
    await page.waitForFunction(() => window.prompts === 1);
    await page.evaluate(() => window.resolveDecision(false));
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-chaoxing-plus-manual-answer-declined'));
    await page.evaluate(() => { document.querySelector('#curCourseId').value = 'course-2'; window.session.requestManualDecision(); });
    await page.waitForFunction(() => window.prompts === 2);
    await page.evaluate(() => window.resolveDecision(true));
    await page.waitForFunction(() => document.documentElement.getAttribute('data-chaoxing-plus-manual-answer-decision') === 'accepted');
    assert.equal(await page.evaluate(async () => {
      document.querySelector('#curCourseId').value = 'course';
      await window.session.ready();
      return window.session.requestManualDecision();
    }), false);
    assert.equal(await page.evaluate(() => window.prompts), 2);
  } finally { await page.close(); }
});

test('mismatched scopes, forged message origins, and non-owner responses cannot control a decision', async () => {
  const page = await openPage();
  try {
    await install(page);
    const frame = await addFrame(page, 'child');
    await install(frame);
    assert.equal(await frame.evaluate(() => window.session.requestManualDecision({ courseId: 'other', classId: 'class' })), false);
    await frame.evaluate(() => {
      window.parent.postMessage({ namespace: 'chaoxing-plus:course-session:v1', kind: 'decision', id: 'forged-scope', scope: { courseId: 'other', classId: 'class' } }, '*');
    });
    await page.evaluate((origin) => {
      window.dispatchEvent(new MessageEvent('message', { source: document.querySelector('#child').contentWindow,
        origin, data: { namespace: 'chaoxing-plus:course-session:v1', kind: 'decision', id: 'forged-origin', scope: { courseId: 'course', classId: 'class' } } }));
    }, 'https://unrelated.invalid');
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
    assert.equal(await page.evaluate(() => window.prompts), 0);
  } finally { await page.close(); }
});

test('duplicate module installations share one owner and malformed persistent records are ignored', async () => {
  const page = await openPage();
  try {
    await page.evaluate(() => {
      const key = 'chaoxing-plus:course-session:v1:' + JSON.stringify(['course', 'class']);
      sessionStorage.setItem(key, JSON.stringify({ version: 1, scope: { courseId: 'other', classId: 'class' },
        runId: 'old', chapters: {}, decision: 'declined' }));
    });
    await install(page);
    await page.addScriptTag({ content: runtime });
    const result = await page.evaluate(() => {
      const other = window.initializeCourseSession(window, { noDiskWrite: () => false, confirm: async () => { throw new Error('second owner'); } });
      window.session.requestManualDecision();
      other.requestManualDecision();
      return other === window.session;
    });
    assert.equal(result, true);
    await page.waitForFunction(() => window.prompts === 1);
    await page.evaluate(() => window.resolveDecision(false));
  } finally { await page.close(); }
});

test('owner course changes resolve the old remote caller without applying its late result to the new course', async () => {
  const page = await openPage();
  try {
    await install(page);
    const frame = await addFrame(page, 'child');
    await install(frame);
    await frame.evaluate(() => { window.session.requestManualDecision().then((value) => { window.result = value; }); });
    await page.waitForFunction(() => window.prompts === 1);
    await page.evaluate(async () => {
      const completeOldDecision = window.resolveDecision;
      document.querySelector('#curCourseId').value = 'new-course';
      await window.session.ready();
      completeOldDecision(true);
    });
    await frame.waitForFunction(() => window.result === false);
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-chaoxing-plus-manual-answer-decision')), null);
  } finally { await page.close(); }
});

test('MutationObserver flushes scoped task state and ignores extra fields before an actual reload', async () => {
  const page = await openPage();
  try {
    await install(page);
    await page.evaluate((chapterAttribute) => {
      const key = JSON.stringify(['course', 'class', 'chapter']);
      document.documentElement.setAttribute(chapterAttribute, JSON.stringify({
        [key]: { scope: key, phase: 'retry', inspectedTabs: ['tab'], extra: 'discard', tasks: {
          task: { tabKey: 'tab', jobId: 'expired', attempts: 1, missingVisits: 0, terminalExpired: false,
            state: 'deferred', pauseReason: 'saved', unrelatedSecret: 'discard' }
        } },
        [JSON.stringify(['another-course', 'class', 'chapter'])]: { unrelated: 'discard' }
      }));
    }, chapterAttribute);
    await page.reload({ waitUntil: 'load' });
    await install(page);
    const restored = await page.evaluate((chapterAttribute) => JSON.parse(document.documentElement.getAttribute(chapterAttribute)), chapterAttribute);
    assert.equal(Object.keys(restored).length, 1);
    const chapter = Object.values(restored)[0];
    assert.equal(chapter.extra, undefined);
    const task = Object.values(chapter.tasks)[0];
    assert.equal(task.attempts, 1);
    assert.equal(task.pauseReason, 'saved');
    assert.equal(task.unrelatedSecret, undefined);
  } finally { await page.close(); }
});

test('unknown course identity stays local and does not carry a manual choice into a newly identified course', async () => {
  const page = await openPage();
  try {
    await page.evaluate(() => { document.querySelector('#curCourseId').remove(); document.querySelector('#curClazzId').remove(); });
    await install(page);
    await page.evaluate(() => { window.session.requestManualDecision(); });
    await page.waitForFunction(() => window.prompts === 1);
    await page.evaluate(() => window.resolveDecision(false));
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-chaoxing-plus-manual-answer-declined'));
    assert.equal(await page.evaluate(() => sessionStorage.length), 0);
    assert.equal(await page.evaluate(() => window.session.canReload()), false);
    await page.evaluate(async () => {
      document.body.insertAdjacentHTML('beforeend', '<input id="curCourseId" value="known-course"><input id="curClazzId" value="class">');
      await window.session.ready();
      window.session.requestManualDecision();
    });
    await page.waitForFunction(() => window.prompts === 2);
    await page.evaluate(() => window.resolveDecision(true));
  } finally { await page.close(); }
});

test('an explicit remote continue clears the shared decline without showing another confirmation', async () => {
  const page = await openPage();
  try {
    await install(page);
    const frame = await addFrame(page, 'child');
    await install(frame);
    await frame.evaluate(() => { window.session.requestManualDecision().then((value) => { window.result = value; }); });
    await page.waitForFunction(() => window.prompts === 1);
    await page.evaluate(() => window.resolveDecision(false));
    await frame.waitForFunction(() => window.result === false);
    assert.equal(await frame.evaluate(() => window.session.resumeManualDecision({ courseId: 'another', classId: 'class' })), false);
    assert.equal(await frame.evaluate(() => window.session.requestManualDecision()), false);
    assert.equal(await frame.evaluate(() => window.session.resumeManualDecision()), true);
    assert.equal(await frame.evaluate(() => window.session.requestManualDecision()), true);
    assert.equal(await page.evaluate(() => window.prompts), 1);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-chaoxing-plus-manual-answer-declined')), false);
  } finally { await page.close(); }
});

test('explicit continue resolves an existing pending decision and ignores its later cancellation', async () => {
  const page = await openPage();
  try {
    await install(page);
    await page.evaluate(() => { window.session.requestManualDecision().then((value) => { window.result = value; }); });
    await page.waitForFunction(() => window.prompts === 1);
    assert.equal(await page.evaluate(() => window.session.resumeManualDecision()), true);
    await page.waitForFunction(() => window.result === true);
    await page.evaluate(() => window.resolveDecision(false));
    assert.equal(await page.evaluate(() => window.session.requestManualDecision()), true);
    assert.equal(await page.evaluate(() => window.prompts), 1);
  } finally { await page.close(); }
});

test('window.open copies storage but a fresh browser tab identity does not inherit manual or deferred state', async () => {
  const page = await openPage();
  let child;
  try {
    await page.evaluate(() => document.documentElement.setAttribute('data-chaoxing-plus-tab-identity', 'tab-parent'));
    await install(page);
    await page.evaluate(({ chapterAttribute, decisionAttribute, declinedAttribute }) => {
      const key = JSON.stringify(['course', 'class', 'chapter']);
      document.documentElement.setAttribute(chapterAttribute, JSON.stringify({
        [key]: { scope: key, phase: 'settled', inspectedTabs: ['tab'], tasks: {
          task: { tabKey: 'tab', jobId: 'expired', attempts: 2, missingVisits: 0, terminalExpired: true, state: 'abandoned' }
        } }
      }));
      document.documentElement.setAttribute(decisionAttribute, 'declined');
      document.documentElement.setAttribute(declinedAttribute, 'true');
      window.session.persist();
    }, { chapterAttribute, decisionAttribute, declinedAttribute });
    const target = new Promise((resolve) => page.once('popup', resolve));
    await page.evaluate((url) => { window.open(url, '_blank'); }, ownerUrl);
    child = await target;
    await child.waitForFunction(() => document.readyState === 'complete');
    assert.equal(await child.evaluate(() => sessionStorage.length > 0), true, 'Chromium must actually copy the opener sessionStorage');
    await child.evaluate(() => document.documentElement.setAttribute('data-chaoxing-plus-tab-identity', 'tab-child'));
    await install(child);
    const result = await child.evaluate(({ chapterAttribute, decisionAttribute, declinedAttribute }) => ({
      chapters: document.documentElement.getAttribute(chapterAttribute),
      decision: document.documentElement.getAttribute(decisionAttribute),
      declined: document.documentElement.hasAttribute(declinedAttribute)
    }), { chapterAttribute, decisionAttribute, declinedAttribute });
    assert.deepEqual(result, { chapters: null, decision: null, declined: false });
    const parentState = await page.evaluate(({ decisionAttribute, declinedAttribute }) => ({
      decision: document.documentElement.getAttribute(decisionAttribute), declined: document.documentElement.hasAttribute(declinedAttribute)
    }), { decisionAttribute, declinedAttribute });
    assert.deepEqual(parentState, { decision: 'declined', declined: true });
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => document.documentElement.setAttribute('data-chaoxing-plus-tab-identity', 'tab-parent'));
    await install(page);
    assert.equal(await page.evaluate((decisionAttribute) => document.documentElement.getAttribute(decisionAttribute), decisionAttribute), 'declined',
      'the same browser tab must retain its own state across a real reload');
  } finally { await child?.close(); await page.close(); }
});

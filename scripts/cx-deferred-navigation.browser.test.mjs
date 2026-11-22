import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';

const puppeteer = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'))('puppeteer');
let browser;
let server;
let origin;
let runtime;

before(async () => {
  const source = await readFile('src/projects/cx.ts', 'utf8');
  const parsed = ts.createSourceFile('cx.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set([
    'getDeferredChapterContext', 'saveDeferredChapterContext', 'isDeferredChapterContextCurrent',
    'switchDeferredChapterTab', 'getDeferredCourseContext', 'saveDeferredCourseContext',
    'switchDeferredCourseChapter', 'navigateStudyTarget', 'routeDeferredCourse'
  ]);
  const declarations = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
  assert.equal(declarations.length, names.size);
  const analyses = parsed.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => declaration.name.getText(parsed) === 'CXAnalyses');
  const switchSubTask = analyses?.initializer?.properties?.find((property) => property.name?.getText(parsed) === 'trySwitchToNextUnvisitedSubTask');
  assert.ok(switchSubTask, 'extract the actual sibling navigation method');
  const modules = await Promise.all(['cx-deferred-chapters', 'cx-deferred-course'].map(async (name) => {
    const compiled = ts.transpileModule(await readFile(`src/projects/${name}.ts`, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
    }).outputText;
    return compiled.replace(/^export /gm, '');
  }));
  runtime = ts.transpileModule(`(() => {
    const topWindow = window;
    const deferredChaptersAttribute = 'data-chaoxing-plus-deferred-chapters';
    const deferredCoursesAttribute = 'data-chaoxing-plus-deferred-courses';
    const events = [];
    const diagnostics = [];
    const logDebug = (level, label, detail) => diagnostics.push({ level, label, ...detail });
    const getSiblingSubTaskTabs = () => Array.from(document.querySelectorAll('#prev_tab .prev_ul li'));
    const triggerSyntheticClick = (element) => { if (window.syntheticClickFailed) return false; element.click(); return true; };
    const sleep = async (ms) => { window.onNavigationWait?.(ms); await new Promise((resolve) => setTimeout(resolve, 0)); };
    const showTopCenterNotice = () => {};
    const $console = { warn: (text) => events.push(text) };
    const $message = { warn: () => {}, success: () => {}, info: () => {} };
    const $modal = { alert: async () => {} };
    const CXAnalyses = {
      getCurrentChapterKey: () => document.querySelector('.posCatalog_active')?.id,
      getChapterStayState: () => window.navigationStay || ({ returnedToSameChapter: false, repeatCount: 0 }),
      getChapterSubTaskProgress: () => window.subTaskProgress || ({ attempts: 0 }),
      setChapterSubTaskProgress: (progress) => { window.subTaskProgress = progress; },
      isStuckInBreakingMode: async () => { window.onBreakingGuard?.(); return Boolean(window.breakingBlocked); },
      isFinishedAllChapters: () => false,
      ${switchSubTask.getText(parsed)},
      getChapterInfos: () => Array.from(document.querySelectorAll('.posCatalog_name')).map((element) => ({
        element, chapterId: element.parentElement.id, unFinishCount: 1
      }))
    };
    ${modules.join('\n')}
    ${declarations.map((node) => node.getText(parsed)).join('\n')}
    window.navigationTest = {
      context: getDeferredChapterContext,
      next: (context) => getNextUninspectedChapterTab(context.state, context.tabKeys, context.tabKey),
      navigate: navigateStudyTarget,
      switchSibling: () => CXAnalyses.trySwitchToNextUnvisitedSubTask(),
      route: routeDeferredCourse,
      inspect: (context) => { markChapterTabInspected(context.state, context.tabKey); saveDeferredChapterContext(context); },
      defer: (context) => { recordChapterDeferral(context.state, context.tabKey, 'expired'); saveDeferredChapterContext(context); },
      events, diagnostics
    };
  })();`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><body></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}/`;
  browser = await puppeteer.launch({
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking']
  });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function pageFixture() {
  const page = await browser.newPage();
  await page.goto(origin);
  await page.setContent(`<input id="curCourseId" value="course"><input id="curClazzId" value="class">
    <div id="chapter-1" class="posCatalog_select posCatalog_active"><a class="posCatalog_name" href="#">One</a></div>
    <div id="chapter-2" class="posCatalog_select"><a class="posCatalog_name" href="#">Two</a></div>
    <div id="prev_tab"><ul class="prev_ul"><li id="tab-1">First</li><li class="active" id="tab-2">Last</li></ul></div>`);
  await page.evaluate(() => {
    window.tabClicks = 0;
    window.chapterClicks = 0;
    for (const tab of document.querySelectorAll('.prev_ul li')) tab.addEventListener('click', () => {
      window.tabClicks++;
      if (window.blockNavigation) return;
      document.querySelector('.prev_ul .active')?.classList.remove('active');
      tab.classList.add('active');
    });
    for (const chapter of document.querySelectorAll('.posCatalog_name')) chapter.addEventListener('click', (event) => {
      event.preventDefault();
      window.chapterClicks++;
      if (window.blockNavigation) return;
      document.querySelector('.posCatalog_active')?.classList.remove('posCatalog_active');
      chapter.parentElement.classList.add('posCatalog_active');
    });
  });
  await page.addScriptTag({ content: runtime });
  return page;
}

test('Chromium final subtask leaves for the following chapter without clicking an earlier tab', async () => {
  const page = await pageFixture();
  try {
    const result = await page.evaluate(async () => {
      const api = window.navigationTest;
      const context = api.context();
      api.defer(context);
      api.inspect(context);
      const nextTab = api.next(context) ?? null;
      const result = await api.route(context, { mode: 'next' });
      return { nextTab, result, chapter: document.querySelector('.posCatalog_active').id,
        tabClicks: window.tabClicks, chapterClicks: window.chapterClicks };
    });
    assert.deepEqual(result, { nextTab: null, result: 'scan', chapter: 'chapter-2', tabClicks: 0, chapterClicks: 1 });
  } finally { await page.close(); }
});

test('Chromium uses stable tab identity after tab DOM reordering', async () => {
  const page = await pageFixture();
  try {
    const result = await page.evaluate(async () => {
      const api = window.navigationTest;
      const context = api.context();
      const first = document.querySelector('#tab-1');
      first.parentElement.appendChild(first);
      await api.navigate(context, { tabKey: 'tab-1' }, { mode: 'job' });
      return { active: document.querySelector('.prev_ul .active').id, clicks: window.tabClicks };
    });
    assert.deepEqual(result, { active: 'tab-1', clicks: 1 });
  } finally { await page.close(); }
});

test('Chromium blocks repeated failed chapter navigation and respects manually selected mode', async () => {
  const page = await pageFixture();
  try {
    const result = await page.evaluate(async () => {
      const api = window.navigationTest;
      window.blockNavigation = true;
      const context = api.context();
      await api.navigate(context, { chapterId: 'chapter-2' }, { mode: 'manually' });
      const manualClicks = window.chapterClicks;
      for (let round = 0; round < 5; round++) await api.navigate(context, { chapterId: 'chapter-2' }, { mode: 'job' });
      return { manualClicks, totalClicks: window.chapterClicks };
    });
    assert.deepEqual(result, { manualClicks: 0, totalClicks: 3 });
  } finally { await page.close(); }
});

test('Chromium cancels a queued chapter click after manual subtask selection', async () => {
  const page = await pageFixture();
  try {
    const result = await page.evaluate(async () => {
      const api = window.navigationTest;
      window.onNavigationWait = () => document.querySelector('#tab-1').click();
      const status = await api.navigate(api.context(), { chapterId: 'chapter-2' }, { mode: 'next' });
      return { status, chapterClicks: window.chapterClicks, activeTab: document.querySelector('.prev_ul .active').id };
    });
    assert.deepEqual(result, { status: 'stale', chapterClicks: 0, activeTab: 'tab-1' });
  } finally { await page.close(); }
});

test('Chromium navigation diagnostics correlate the source, target and confirmed arrival without course identity', async () => {
  const page = await pageFixture();
  try {
    const { status, diagnostics } = await page.evaluate(async () => {
      document.querySelector('#curCourseId').value = 'secret-course-value';
      document.querySelector('#curClazzId').value = 'secret-class-value';
      const api = window.navigationTest;
      const status = await api.navigate(api.context(), { chapterId: 'chapter-2' }, { mode: 'next' }, 5000, 'advance-forward-chapter');
      return { status, diagnostics: api.diagnostics };
    });
    assert.equal(status, 'navigated');
    const before = diagnostics.find((entry) => entry.phase === 'before-click');
    const after = diagnostics.find((entry) => entry.phase === 'after-click');
    assert.ok(before, 'record the source and requested target before clicking');
    assert.ok(after, 'record whether the requested target was reached');
    assert.ok(before.navigationId);
    assert.equal(after.navigationId, before.navigationId);
    for (const entry of [before, after]) {
      assert.equal(entry.sourceChapterId, 'chapter-1');
      assert.equal(entry.sourceTabKey, 'tab-2');
      assert.equal(entry.targetChapterId, 'chapter-2');
      assert.equal(entry.targetTabKey, null);
      assert.equal(entry.mode, 'next');
      assert.equal(entry.navigationReason, 'advance-forward-chapter');
      assert.equal(entry.attempt, 1);
    }
    assert.equal(before.reached, null);
    assert.equal(after.reached, true);
    assert.equal(after.reason, 'target-reached');
    assert.equal(after.clicked, true);
    const serialized = JSON.stringify(diagnostics);
    assert.doesNotMatch(serialized, /secret-course-value|secret-class-value|https?:\/\/|"scope"/);
  } finally { await page.close(); }
});

test('Chromium navigation diagnostics report cancellation without claiming a click or successful arrival', async () => {
  const page = await pageFixture();
  try {
    const result = await page.evaluate(async () => {
      const api = window.navigationTest;
      window.onNavigationWait = () => document.querySelector('#tab-1').click();
      const status = await api.navigate(api.context(), { chapterId: 'chapter-2' }, { mode: 'job' });
      return { status, diagnostics: api.diagnostics, chapterClicks: window.chapterClicks };
    });
    assert.equal(result.status, 'stale');
    assert.equal(result.chapterClicks, 0);
    const cancellation = result.diagnostics.at(-1);
    assert.equal(cancellation?.reason, 'context-changed-during-wait');
    assert.equal(cancellation.phase, 'after-wait');
    assert.equal(cancellation.clicked, false);
    assert.equal(cancellation.reached, null);
    assert.equal(result.diagnostics.some((entry) => entry.phase === 'after-click' || entry.reached === true), false);
  } finally { await page.close(); }
});

test('Chromium navigation diagnostics distinguish blocked clicks and the exhausted attempt guard', async () => {
  const page = await pageFixture();
  try {
    const diagnostics = await page.evaluate(async () => {
      const api = window.navigationTest;
      window.blockNavigation = true;
      const context = api.context();
      for (let round = 0; round < 4; round++) await api.navigate(context, { chapterId: 'chapter-2' }, { mode: 'job' });
      return api.diagnostics;
    });
    const outcomes = diagnostics.filter((entry) => entry.phase === 'after-click');
    assert.deepEqual(outcomes.map((entry) => [entry.attempt, entry.reason, entry.clicked, entry.reached]), [
      [1, 'target-not-reached', true, false], [2, 'target-not-reached', true, false], [3, 'target-not-reached', true, false]
    ]);
    assert.equal(diagnostics.at(-1)?.reason, 'retry-limit');
    assert.equal(diagnostics.at(-1).attempt, 3);
    assert.equal(diagnostics.at(-1).phase, 'guard');
    assert.equal(diagnostics.at(-1).clicked, false);
  } finally { await page.close(); }
});

test('Chromium navigation diagnostics explain manual, stale, breaking and repeated-stay guards', async () => {
  const page = await pageFixture();
  try {
    const result = await page.evaluate(async () => {
      const api = window.navigationTest;
      const source = api.context();
      await api.navigate(source, { chapterId: 'chapter-2' }, { mode: 'manually' });
      document.querySelector('#tab-1').click();
      await api.navigate(source, { chapterId: 'chapter-2' }, { mode: 'next' });
      window.breakingBlocked = true;
      await api.navigate(api.context(), { chapterId: 'chapter-2' }, { mode: 'job' });
      window.breakingBlocked = false;
      window.navigationStay = { returnedToSameChapter: true, repeatCount: 3 };
      await api.navigate(api.context(), { tabKey: 'tab-2' }, { mode: 'job' });
      return { diagnostics: api.diagnostics, chapterClicks: window.chapterClicks };
    });
    assert.equal(result.chapterClicks, 0);
    assert.deepEqual(result.diagnostics.map((entry) => entry.reason), ['manual-mode', 'stale-context', 'breaking-mode', 'repeated-stay']);
    assert.equal(result.diagnostics.every((entry) => entry.phase === 'guard' && entry.clicked === false && entry.reached === null), true);
  } finally { await page.close(); }
});

test('Chromium sibling diagnostics distinguish a triggered tab click from reaching the tab', async () => {
  const page = await pageFixture();
  try {
    const result = await page.evaluate(() => {
      const api = window.navigationTest;
      window.blockNavigation = true;
      api.switchSibling();
      window.blockNavigation = false;
      window.syntheticClickFailed = true;
      api.switchSibling();
      return { diagnostics: api.diagnostics, tabClicks: window.tabClicks };
    });
    assert.equal(result.tabClicks, 2);
    const outcomes = result.diagnostics.filter((entry) => entry.phase === 'after-click');
    assert.equal(outcomes.length, 2);
    assert.deepEqual(outcomes.map((entry) => [entry.sourceChapterId, entry.sourceTabKey, entry.targetChapterId, entry.targetTabKey, entry.clicked, entry.reached]), [
      ['chapter-1', 'tab-2', 'chapter-1', 'tab-1', true, false],
      ['chapter-1', 'tab-2', 'chapter-1', 'tab-1', true, true]
    ]);
    assert.equal(outcomes[1].clickMethod, 'native-fallback');
    for (const outcome of outcomes) {
      const before = result.diagnostics.find((entry) => entry.navigationId === outcome.navigationId && entry.phase === 'before-click');
      assert.ok(before);
    }
  } finally { await page.close(); }
});

test('Chromium navigation diagnostics stop after a context change during the asynchronous guard', async () => {
  const page = await pageFixture();
  try {
    const result = await page.evaluate(async () => {
      const api = window.navigationTest;
      window.onBreakingGuard = () => document.querySelector('#tab-1').click();
      const status = await api.navigate(api.context(), { chapterId: 'chapter-2' }, { mode: 'next' });
      return { status, diagnostics: api.diagnostics, chapterClicks: window.chapterClicks };
    });
    assert.equal(result.status, 'stale');
    assert.equal(result.chapterClicks, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].phase, 'guard');
    assert.equal(result.diagnostics[0].reason, 'context-changed-during-guard');
    assert.equal(result.diagnostics[0].clicked, false);
    assert.equal(result.diagnostics[0].reached, null);
  } finally { await page.close(); }
});

test('Chromium navigation diagnostics report a missing requested tab without claiming a triggered click', async () => {
  const page = await pageFixture();
  try {
    const result = await page.evaluate(async () => {
      const api = window.navigationTest;
      const status = await api.navigate(api.context(), { tabKey: 'missing-tab' }, { mode: 'job' });
      return { status, diagnostics: api.diagnostics, tabClicks: window.tabClicks };
    });
    assert.equal(result.status, 'paused');
    assert.equal(result.tabClicks, 0);
    const outcome = result.diagnostics.at(-1);
    assert.equal(outcome.phase, 'after-click');
    assert.equal(outcome.reason, 'click-not-triggered');
    assert.equal(outcome.targetChapterId, 'chapter-1');
    assert.equal(outcome.targetTabKey, 'missing-tab');
    assert.equal(outcome.clicked, false);
    assert.equal(outcome.reached, false);
  } finally { await page.close(); }
});

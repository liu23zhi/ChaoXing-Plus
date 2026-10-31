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
    const getSiblingSubTaskTabs = () => Array.from(document.querySelectorAll('#prev_tab .prev_ul li'));
    const triggerSyntheticClick = (element) => { element.click(); return true; };
    const sleep = async (ms) => { window.onNavigationWait?.(ms); await new Promise((resolve) => setTimeout(resolve, 0)); };
    const showTopCenterNotice = () => {};
    const $console = { warn: (text) => events.push(text) };
    const $message = { warn: () => {}, success: () => {}, info: () => {} };
    const $modal = { alert: async () => {} };
    const CXAnalyses = {
      getCurrentChapterKey: () => document.querySelector('.posCatalog_active')?.id,
      getChapterStayState: () => ({ returnedToSameChapter: false, repeatCount: 0 }),
      isStuckInBreakingMode: async () => Boolean(window.breakingBlocked),
      isFinishedAllChapters: () => false,
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
      route: routeDeferredCourse,
      inspect: (context) => { markChapterTabInspected(context.state, context.tabKey); saveDeferredChapterContext(context); },
      defer: (context) => { recordChapterDeferral(context.state, context.tabKey, 'expired'); saveDeferredChapterContext(context); },
      events
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

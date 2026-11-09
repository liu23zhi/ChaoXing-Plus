import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

// 面板分页签：把原本纵向堆叠的五个板块收进互斥页签，解决「要滚很远才能到设置区」。
//
// 断言的是**行为契约**，不是源码字样：
//   1. 互斥——同一时刻只有一个 tabpanel 可见、只有一个 tab 处于激活态；
//   2. 切换真的换内容——点「题库配置」后 overview 不可见、tiku 可见；
//   3. 首屏可操作——默认 overview 里必须有暂停/继续答题主操作；
//   4. Windows 端无 study/cache 页签（考试专用裁剪），扩展端有。
//
// 装配方式与 panel-visual.browser.mjs 一致：navigation 请求返回空考试页，
// 其余请求 abort，然后按分支注入 bundle。

const root = resolveTestPath('.');
const EXTENSION_BUNDLE = resolve(root, 'dist/chaoxing-plus.js');
const WINDOWS_BUNDLE = resolve(root, 'dist-windows/chaoxing-plus.windows.js');
const BOOTSTRAP = resolve(root, 'windows/share-file/windows-bootstrap.js');
const PANEL = '#panel-common-work-results';
const EXAM_URL = 'http://a.chaoxing.com/exam-ans/exam/list';

// 字段名必须与 SimplifyWorkResult 实体一致：question / requested / resolved / searchInfos。
// 早期版本这里写的是 title / options / answer（不存在），面板会渲染失败——见下面
// 「坏数据必须给出可恢复界面」那条用例，它是刻意保留的回归。
const FIXTURE_RESULTS = [
  {
    question: '面板页签回归题',
    type: 'single',
    requested: true,
    resolved: true,
    finish: true,
    searchInfos: [{ name: 'tikuAdapter', results: [['面板页签回归题', '选项 A', {}]] }]
  }
];

let browser;
let extensionBundle;
let windowsBundle;
let bootstrapSource;

test('panel tab contract', async (t) => {
  if (!existsSync(EXTENSION_BUNDLE) || !existsSync(WINDOWS_BUNDLE)) {
    return t.skip('dist 未构建（先 npm run build && npm run build:windows）');
  }
  extensionBundle = await readFile(EXTENSION_BUNDLE, 'utf8');
  windowsBundle = await readFile(WINDOWS_BUNDLE, 'utf8');
  bootstrapSource = await readFile(BOOTSTRAP, 'utf8');

  const puppeteer = (await import('puppeteer-core')).default;
  const executablePath = process.env.CX_BROWSER_EXECUTABLE;
  if (!executablePath) return t.skip('未设置 CX_BROWSER_EXECUTABLE');

  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    protocolTimeout: 30000,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking']
  });

  const openPanel = async (mode) => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.isNavigationRequest()) {
        void request.respond({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html><head><title>模拟考试页</title></head><body><main>模拟考试页面</main></body></html>'
        });
        return;
      }
      void request.abort();
    });
    await page.goto(EXAM_URL);
    await page.evaluate(() => { localStorage.clear(); });

    if (mode === 'windows') {
      // Windows 分支必须走 bootstrap：__CX_WIN_HOST__ 由它注入，
      // 只设置 __CX_WIN_INSTANCE__ 不会让 isWindowsHostRuntime() 变 true。
      await page.evaluate(({ bootstrap, config, results }) => {
        window.__CX_WIN_INSTANCE__ = 'panel-tabs';
        window.__CX_WIN_CONFIG_JSON__ = config;
        (0, eval)(bootstrap);
        localStorage.setItem('common.work-results.results', JSON.stringify(results));
      }, {
        bootstrap: bootstrapSource,
        config: {
          'common.settings.extension-enabled': true,
          'common.settings.windows-panel-enabled': true,
          'common.settings.windows-no-disk-write': false,
          'common.settings.windows-panel-collapsed': false
        },
        results: FIXTURE_RESULTS
      });
      await page.addScriptTag({ content: windowsBundle });
    } else {
      await page.evaluate((results) => {
        localStorage.setItem('common.work-results.results', JSON.stringify(results));
      }, FIXTURE_RESULTS);
      await page.addScriptTag({ content: extensionBundle });
    }

    await page.waitForSelector(PANEL, { timeout: 20000 });
    // 面板根先挂载、body 稍后才填充：必须等真正的页签出现，
    // 否则读到的是折叠壳阶段（tabCount=0），看起来像「页签没生效」。
    await page.waitForSelector(`${PANEL} [data-cx-panel-tab]`, { timeout: 20000 });
    return { page, context };
  };

  const readTabs = (page) => page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const tabs = Array.from(root.querySelectorAll('[data-cx-panel-tab]'));
    const panels = Array.from(root.querySelectorAll('[data-cx-panel-tab-panel]'));
    const visiblePanels = panels.filter((panel) => panel.getClientRects().length > 0);
    return {
      tabIds: tabs.map((tab) => tab.dataset.cxPanelTab),
      activeTabs: tabs.filter((tab) => tab.dataset.cxPanelTabActive === 'true').map((tab) => tab.dataset.cxPanelTab),
      visiblePanels: visiblePanels.map((panel) => panel.dataset.cxPanelTabPanel),
      overviewButtons: visiblePanels.length === 1
        ? Array.from(visiblePanels[0].querySelectorAll('button')).map((button) => button.textContent || '')
        : [],
      panelButtons: Array.from(root.querySelectorAll('button'))
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => button.textContent || '')
    };
  }, PANEL);

  try {
    // ---- 扩展端：互斥 + 切换 + 首屏可操作 ----
    const extension = await openPanel('extension');
    try {
      const initial = await readTabs(extension.page);

      assert.ok(initial.tabIds.length >= 3, `扩展端至少 3 个页签，实际 ${JSON.stringify(initial.tabIds)}`);
      assert.deepEqual(initial.activeTabs, ['overview'], `默认只应激活 overview，实际 ${JSON.stringify(initial.activeTabs)}`);
      assert.deepEqual(initial.visiblePanels, ['overview'], `同一时刻只能有一个页签可见，实际 ${JSON.stringify(initial.visiblePanels)}`);
      // 主操作常驻在页签之外（hero），不在任何一个 tabpanel 里 —— 这是既有红线：
      // answer-work-controls 要求暂停/继续在整个 worker 生命周期始终可见，与页签正交。
      assert.ok(
        initial.panelButtons.some((text) => /暂停答题|继续答题/u.test(text)),
        `面板必须有暂停/继续答题主操作，实际 ${JSON.stringify(initial.panelButtons)}`
      );
      assert.ok(initial.tabIds.includes('study'), `扩展端必须有 study 页签，实际 ${JSON.stringify(initial.tabIds)}`);

      // 切到题库配置
      await extension.page.click('[data-cx-panel-tab="tiku"]');
      await extension.page.waitForFunction((selector) => {
        const root = document.querySelector(selector);
        const panel = root?.querySelector('[data-cx-panel-tab-panel="tiku"]');
        return Boolean(panel && panel.getClientRects().length > 0);
      }, { timeout: 5000 }, PANEL);

      const afterSwitch = await readTabs(extension.page);
      assert.deepEqual(afterSwitch.visiblePanels, ['tiku'], `切页签后只应显示 tiku，实际 ${JSON.stringify(afterSwitch.visiblePanels)}`);
      assert.deepEqual(afterSwitch.activeTabs, ['tiku'], `激活态必须跟随，实际 ${JSON.stringify(afterSwitch.activeTabs)}`);

      // 切回结果页：主操作必须还在（不能因切页签丢入口）
      await extension.page.click('[data-cx-panel-tab="overview"]');
      await extension.page.waitForFunction((selector) => {
        const root = document.querySelector(selector);
        const panel = root?.querySelector('[data-cx-panel-tab-panel="overview"]');
        return Boolean(panel && panel.getClientRects().length > 0);
      }, { timeout: 5000 }, PANEL);
      const back = await readTabs(extension.page);
      assert.deepEqual(back.visiblePanels, ['overview']);
      assert.ok(
        back.panelButtons.some((text) => /暂停答题|继续答题/u.test(text)),
        '切回结果页后主操作必须仍可点'
      );
    } finally {
      await extension.context.close();
    }

    // ---- Windows 端：考试专用裁剪，无 study / cache ----
    const windows = await openPanel('windows');
    try {
      const winTabs = await readTabs(windows.page);
      assert.ok(winTabs.tabIds.includes('overview'), `Windows 端必须保留 overview，实际 ${JSON.stringify(winTabs.tabIds)}`);
      assert.equal(winTabs.tabIds.includes('study'), false, `Windows 端不得有 study 页签，实际 ${JSON.stringify(winTabs.tabIds)}`);
      assert.equal(winTabs.tabIds.includes('cache'), false, `Windows 端不得有 cache 页签，实际 ${JSON.stringify(winTabs.tabIds)}`);
      assert.deepEqual(winTabs.visiblePanels, ['overview'], `Windows 端默认应停在 overview，实际 ${JSON.stringify(winTabs.visiblePanels)}`);
    } finally {
      await windows.context.close();
    }
  } finally {
    // browser 由最后一个用例关闭：提前关闭会让后续用例拿不到实例。
  }
});

// 回归：坏数据不得让面板变成空白。
//
// 实测事故：localStorage 里残留旧格式的 work-results（例如字段名从 title/options
// 变成 question/searchInfos）时，createWorkResultsPanel 抛异常，而 replaceChildren
// 在异常后根本不执行 —— 面板 body 永远是空的，控制台也没有任何输出。
// 用户看到的是「面板一片空白」，且刷新无效（坏数据还在存储里）。
test('坏数据时面板给出可恢复的错误界面，而不是空白', async (t) => {
  if (!existsSync(EXTENSION_BUNDLE) || !existsSync(WINDOWS_BUNDLE)) {
    return t.skip('dist 未构建（先 npm run build && npm run build:windows）');
  }
  const executablePath = process.env.CX_BROWSER_EXECUTABLE;
  if (!executablePath || !browser) return t.skip('未设置 CX_BROWSER_EXECUTABLE');

  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.isNavigationRequest()) {
        void request.respond({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html><body><main>x</main></body></html>'
        });
        return;
      }
      void request.abort();
    });
    await page.goto(EXAM_URL);
    // 故意写入与当前实体结构不符的旧格式（这些字段名已不存在）。
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('common.work-results.results', JSON.stringify([
        { title: '旧格式题目', qid: 'legacy', options: ['A'], answer: 'A', status: 'success' }
      ]));
    });
    await page.addScriptTag({ content: extensionBundle });
    await page.waitForSelector(PANEL, { timeout: 20000 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));

    const state = await page.evaluate((selector) => {
      const panel = document.querySelector(selector);
      const body = panel.children[2];
      const failure = body?.querySelector('[data-cx-panel-render-failure]');
      return {
        bodyHtmlLength: body ? body.innerHTML.length : -1,
        hasFailureView: Boolean(failure),
        failureText: failure ? (failure.textContent || '').slice(0, 200) : '',
        // 坏数据应被清掉，否则下次渲染还是失败
        storedResults: localStorage.getItem('common.work-results.results')
      };
    }, PANEL);

    assert.ok(state.bodyHtmlLength > 0, '面板 body 不得为空（这正是修复前的事故表现）');
    assert.equal(state.hasFailureView, true, '必须渲染可恢复的错误界面');
    assert.match(state.failureText, /面板加载失败/u, `错误界面必须说明发生了什么，实际 ${state.failureText}`);
    assert.match(state.failureText, /清除/u, '错误界面必须给出恢复入口');
    assert.equal(state.storedResults, '[]', `坏数据必须被清掉，实际 ${state.storedResults}`);

    // 点「清除缓存并重试」应回到正常面板
    await page.click('[data-cx-panel-render-failure] button');
    await page.waitForSelector(`${PANEL} [data-cx-panel-tab]`, { timeout: 5000 });
  } finally {
    await context.close();
    await browser?.close();
  }
});

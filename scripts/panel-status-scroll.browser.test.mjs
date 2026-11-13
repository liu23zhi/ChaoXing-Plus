import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

// 判据 ①：五个页签都能点，**切走再切回滚动位置不变**。
//
// 为什么必须用真实 bundle + 真浏览器：
// 滚动位置保留靠的是 `createPanelTabPanel` 的 `display:none`（节点不销毁 → scrollTop 自然保留）。
// 在假 DOM 里 `scrollTop` 恒为 0，断言「切回来还是 0」恒真 —— 那是假钉子。
// 这里必须真的把列表滚起来、真的点页签、真的量 scrollTop。

const root = resolveTestPath('.');
const EXTENSION_BUNDLE = resolve(root, 'dist/chaoxing-plus.js');
const WINDOWS_BUNDLE = resolve(root, 'dist-windows/chaoxing-plus.windows.js');
const BOOTSTRAP = resolve(root, 'windows/share-file/windows-bootstrap.js');
const PANEL = '#panel-common-work-results';
const EXAM_URL = 'http://a.chaoxing.com/exam-ans/exam/list';

// 结果条数必须足够多，让 `[data-work-results-list]`（maxHeight 260px）真的可滚动。
const FIXTURE_RESULTS = Array.from({ length: 24 }, (_, index) => ({
  question: `滚动位置回归题 ${index + 1}`,
  type: 'single',
  requested: true,
  resolved: true,
  finish: true,
  searchInfos: [{ name: 'tikuAdapter', results: [[`滚动位置回归题 ${index + 1}`, '选项 A', {}]] }]
}));

let browser;

async function openPanel(mode) {
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
    const bootstrapSource = await readFile(BOOTSTRAP, 'utf8');
    const windowsBundle = await readFile(WINDOWS_BUNDLE, 'utf8');
    await page.evaluate(({ bootstrap, config, results }) => {
      window.__CX_WIN_INSTANCE__ = 'status-scroll';
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
    const extensionBundle = await readFile(EXTENSION_BUNDLE, 'utf8');
    await page.evaluate((results) => {
      localStorage.setItem('common.work-results.results', JSON.stringify(results));
    }, FIXTURE_RESULTS);
    await page.addScriptTag({ content: extensionBundle });
  }

  await page.waitForSelector(PANEL, { timeout: 20000 });
  await page.waitForSelector(`${PANEL} [data-cx-panel-tab]`, { timeout: 20000 });
  return { page, context };
}

test('五个页签都能点，切走再切回滚动位置不变', async (t) => {
  if (!existsSync(EXTENSION_BUNDLE) || !existsSync(WINDOWS_BUNDLE)) {
    return t.skip('dist 未构建（先 npm run build && npm run build:windows）');
  }
  const executablePath = process.env.CX_BROWSER_EXECUTABLE;
  if (!executablePath) return t.skip('未设置 CX_BROWSER_EXECUTABLE');

  const puppeteer = (await import('puppeteer-core')).default;
  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    protocolTimeout: 30000,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking']
  });

  try {
    const { page, context } = await openPanel('extension');
    try {
      // ---- 五个页签都必须点得动 ----
      const tabIds = await page.evaluate((selector) => Array.from(
        document.querySelector(selector).querySelectorAll('[data-cx-panel-tab]')
      ).map((node) => node.dataset.cxPanelTab), PANEL);
      assert.deepEqual(tabIds, ['overview', 'tiku', 'status', 'cache', 'study'],
        `真实 bundle 里必须有五个页签，实际 ${JSON.stringify(tabIds)}`);

      for (const id of tabIds) {
        await page.click(`[data-cx-panel-tab="${id}"]`);
        await page.waitForFunction(({ selector, tab }) => {
          const panel = document.querySelector(selector)?.querySelector(`[data-cx-panel-tab-panel="${tab}"]`);
          return Boolean(panel && panel.getClientRects().length > 0);
        }, { timeout: 5000 }, { selector: PANEL, tab: id });
        const visible = await page.evaluate((selector) => Array.from(
          document.querySelector(selector).querySelectorAll('[data-cx-panel-tab-panel]')
        ).filter((node) => node.getClientRects().length > 0).map((node) => node.dataset.cxPanelTabPanel), PANEL);
        assert.deepEqual(visible, [id], `点「${id}」后只应有它可见，实际 ${JSON.stringify(visible)}`);
      }

      // ---- 判据 ①：滚动位置保持 ----
      await page.click('[data-cx-panel-tab="overview"]');
      await page.waitForFunction((selector) => {
        const panel = document.querySelector(selector)?.querySelector('[data-cx-panel-tab-panel="overview"]');
        return Boolean(panel && panel.getClientRects().length > 0);
      }, { timeout: 5000 }, PANEL);

      // 先切到「题目列表」视图：数值视图下整个列表只有一行按钮，scrollHeight == clientHeight，
      // 根本滚不动（实测 scrollHeight=130 / clientHeight=130），断言「切回来还在原位」会恒真。
      // 题目列表视图渲染 24 个卡片，配合 applyScrollPaneStyle(list, 260) 才真的可滚。
      //
      // 注意目标容器是 `[data-work-results-list]` 而**不是**面板 root：
      // 切页签时 `pendingTabScrollReset` 会把 root / body 的 scrollTop 归零（设计如此，
      // 避免新页签停在半截），只有各 tab 内部容器的滚动位置才是「切回来不变」的对象。
      await page.evaluate((selector) => {
        const panel = document.querySelector(selector);
        const button = Array.from(panel.querySelectorAll('button'))
          .find((node) => node.textContent === '切换为题目列表');
        if (!button) throw new Error('找不到「切换为题目列表」按钮');
        button.click();
      }, PANEL);
      await page.waitForFunction((selector) => {
        const list = document.querySelector(selector).querySelector('[data-work-results-list="true"]');
        return Boolean(list && list.children.length >= 20);
      }, { timeout: 10000 }, PANEL);

      const scrolled = await page.evaluate((selector) => {
        const list = document.querySelector(selector).querySelector('[data-work-results-list="true"]');
        const maxScroll = list.scrollHeight - list.clientHeight;
        list.scrollTop = Math.min(120, maxScroll);
        return { maxScroll, afterScroll: list.scrollTop, items: list.children.length };
      }, PANEL);

      assert.ok(scrolled.items >= 20, `题目列表视图必须有足够条目，实际 ${scrolled.items}`);
      assert.ok(scrolled.maxScroll > 0, `列表必须可滚动，实际 maxScroll=${scrolled.maxScroll}`);
      assert.ok(scrolled.afterScroll > 0,
        `列表必须真的滚起来（maxScroll=${scrolled.maxScroll}），否则「切回来还在原位」是恒真断言`);

      // 切到 status（最远的一格），再切回 overview。
      await page.click('[data-cx-panel-tab="status"]');
      await page.waitForFunction((selector) => {
        const panel = document.querySelector(selector)?.querySelector('[data-cx-panel-tab-panel="status"]');
        return Boolean(panel && panel.getClientRects().length > 0);
      }, { timeout: 5000 }, PANEL);
      await page.click('[data-cx-panel-tab="overview"]');
      await page.waitForFunction((selector) => {
        const panel = document.querySelector(selector)?.querySelector('[data-cx-panel-tab-panel="overview"]');
        return Boolean(panel && panel.getClientRects().length > 0);
      }, { timeout: 5000 }, PANEL);

      const restored = await page.evaluate((selector) => {
        const list = document.querySelector(selector).querySelector('[data-work-results-list="true"]');
        return {
          scrollTop: list ? list.scrollTop : -1,
          maxScroll: list ? list.scrollHeight - list.clientHeight : -1,
          items: list ? list.children.length : -1
        };
      }, PANEL);

      assert.equal(restored.scrollTop, scrolled.afterScroll,
        `切走再切回应保留滚动位置（scrollTop 应为 ${scrolled.afterScroll}），实际 ${restored.scrollTop}`);
      // 交叉验证：切回来后列表仍可滚（证明不是内容变短导致 scrollTop 被夹到某个值）。
      assert.ok(restored.maxScroll > 0 && restored.items >= 20,
        `切回来后列表必须仍是同一个可滚动的长列表，实际 maxScroll=${restored.maxScroll} items=${restored.items}`);

      // ---- 状态页真的有内容（三区块）----
      await page.click('[data-cx-panel-tab="status"]');
      await page.waitForSelector(`${PANEL} [data-cx-status-panel]`, { timeout: 10000 });
      const statusPanel = await page.evaluate((selector) => {
        const panel = document.querySelector(selector).querySelector('[data-cx-panel-tab-panel="status"]');
        return {
          hasSummary: Boolean(panel.querySelector('[data-cx-status-summary]')),
          hasBand: Boolean(panel.querySelector('[data-cx-status-band]')),
          hasMinutes: Boolean(panel.querySelector('[data-cx-status-minutes]')),
          cellCount: panel.querySelectorAll('[data-cx-status-cell]').length,
          bandRows: panel.querySelector('[data-cx-status-band]')?.dataset.cxStatusBandRows ?? null
        };
      }, PANEL);

      assert.deepEqual(
        { hasSummary: statusPanel.hasSummary, hasBand: statusPanel.hasBand, hasMinutes: statusPanel.hasMinutes },
        { hasSummary: true, hasBand: true, hasMinutes: true },
        '状态页必须有三区块（当前状态 / 24 小时预览 / 最近每分钟）'
      );
      assert.equal(statusPanel.cellCount, 288, `色带必须是 288 格，实际 ${statusPanel.cellCount}`);
      assert.equal(statusPanel.bandRows, '1', '单行渐变色带');
    } finally {
      await context.close();
    }
  } finally {
    await browser?.close();
    browser = undefined;
  }
});

test('Windows 端保留状态页签，且状态页有内容', async (t) => {
  if (!existsSync(WINDOWS_BUNDLE)) return t.skip('dist-windows 未构建（先 npm run build:windows）');
  const executablePath = process.env.CX_BROWSER_EXECUTABLE;
  if (!executablePath) return t.skip('未设置 CX_BROWSER_EXECUTABLE');

  const puppeteer = (await import('puppeteer-core')).default;
  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    protocolTimeout: 30000,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking']
  });

  try {
    const { page, context } = await openPanel('windows');
    try {
      const tabIds = await page.evaluate((selector) => Array.from(
        document.querySelector(selector).querySelectorAll('[data-cx-panel-tab]')
      ).map((node) => node.dataset.cxPanelTab), PANEL);
      assert.deepEqual(tabIds, ['overview', 'tiku', 'status'],
        `Windows 端必须保留 status 并裁掉 cache/study，实际 ${JSON.stringify(tabIds)}`);

      await page.click('[data-cx-panel-tab="status"]');
      await page.waitForSelector(`${PANEL} [data-cx-status-panel]`, { timeout: 10000 });
      const cells = await page.evaluate((selector) => document.querySelector(selector)
        .querySelectorAll('[data-cx-status-cell]').length, PANEL);
      assert.equal(cells, 288, `Windows 端状态页也必须是 288 格，实际 ${cells}`);
    } finally {
      await context.close();
    }
  } finally {
    await browser?.close();
    browser = undefined;
  }
});

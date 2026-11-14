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

// STATUS_SERIES_BODY 是**后端 detailed 端点响应的同构 mock**（不是随手编的数字）。
//
// 结构来源（逐字段对照，不要凭印象改）：
//   internal/controller/service_status.go:17-26  `serviceStatusResponse`
//   internal/service/service_status.go:35-51     `StatusPoint`
//
// ⚠️ `minute` 是 **Unix 秒 / 60**（`StatusPoint.Minute` 的注释：「该点所属的分钟」），
// 前端 `buildServiceStatusBuckets` 会 ×60000 还原成毫秒。写成毫秒会让色带整体错位到 1970 年。
//
// ⚠️ 用**相对时间**（`Date.now()` 推），不写死绝对时刻 —— 写死会让这条用例在不同时区下
// 渲染出不同的小时数，重演 `status-panel-http.test.mjs` 那个「本地绿 CI 红」。
const STATUS_SERIES_BODY = (() => {
  const nowMinute = Math.floor(Date.now() / 60000);
  const points = [];
  // 铺 288 个点（= 24h × 12 点/小时，与 STATUS_BUCKET_COUNT 一致），让色带与分钟列表都有内容。
  for (let offset = 288; offset >= 1; offset -= 1) {
    points.push({
      minute: nowMinute - offset,
      totalRequests: 3,
      successRequests: 3,
      failedRequests: 0,
      upstreamFailures: 0,
      timeoutFailures: 0,
      authFailures: 0,
      quotaFailures: 0,
      avgLatencyMs: 80
    });
  }
  return {
    schemaVersion: 1,
    status: 'healthy',
    windowMinutes: 1440,
    points,
    summary: {
      status: 'healthy',
      successRate: 1,
      successRateAvailable: true,
      totalRequests: 864,
      successRequests: 864,
      failedRequests: 0,
      avgLatencyMs: 80,
      windowMinutes: 1440
    },
    capacity: 288,
    retained: points.length,
    restartedAt: new Date(Date.now() - 288 * 60000).toISOString()
  };
})();

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
    const url = request.url();
    if (process.env.CX_T214_DEBUG) console.log('[REQ]', request.resourceType(), url);
    // 状态端点必须喂数据，否则面板走 `empty` 分支（只渲染摘要），三区块永远不出现。
    //
    // 2026-11-14：t180 把默认 fetcher 从 fixture 改成真实 HTTP 后，测试环境没有
    // baseurl/key 就拿不到数据 —— 三区块代码本身没坏，是「没数据可画」。
    // 这里必须同时满足三件事（缺一件拦截器就收不到请求）：
    //   ① localStorage 里要有 key（否则 status-panel-http.ts:114 在发请求前就 return no-token）
    //   ② baseurl 必须与页面同协议（EXAM_URL 是 http；若页面实际 origin 是 https，
    //      请求会被混合内容策略拦掉，压根不进拦截器）
    //   ③ localStorage 的值必须 JSON 序列化（runtime/store.ts:117 写入走 JSON.stringify，
    //      裸字符串会让 JSON.parse 抛错后静默回退到 fallback）
    if (url.includes('/service-status')) {
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(STATUS_SERIES_BODY)
      });
      return;
    }
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
  // 页面真实 origin 必须从页面里读：EXAM_URL 写的是 http，但实测被重定向到 https。
  // 用 URL(EXAM_URL).origin 会得到 http，与页面 origin 不一致 ⇒ 状态请求被混合内容策略拦掉，
  // 拦截器收不到任何请求（实测 [REQ] 里只有 document 与 favicon）。
  const statusOrigin = await page.evaluate(() => location.origin);
  // 见拦截器注释 ①②③：baseurl 与页面同源、key 非空、两者都 JSON 序列化。
  await page.evaluate((origin) => {
    localStorage.setItem('common.settings.tiku-adapter.baseurl', JSON.stringify(origin));
    localStorage.setItem('common.settings.tiku-adapter.key', JSON.stringify('synthetic-status-key'));
  }, await page.evaluate(() => location.origin));

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
        'common.settings.windows-panel-collapsed': false,
        // ⚠️ Windows 端的 __CX_WIN_CONFIG_JSON__ 会**整体覆盖** localStorage 里的配置
        // （windows-bootstrap.js:1102-1103 用这份快照灌进 runtimeStore）。
        // baseurl/key 必须也写在这里，否则前面那两行 localStorage.setItem 会被冲掉，
        // 状态请求继续走 no-token ⇒ 三区块 0 格（实测：不写就是 288 格变 0 格）。
        'common.settings.tiku-adapter.baseurl': statusOrigin,
        'common.settings.tiku-adapter.key': 'synthetic-status-key'
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
      // ⚠️ 必须显式等三区块出现，不能断言时「刚好没到」。
      // 面板容器先挂载、状态数据是异步 fetch 来的 —— 只等面板会拿到 hasBand=false，
      // 表现为「3 次跑 1 次过、2 次失败」的竞态（实测确认）。
      await page.waitForSelector(`${PANEL} [data-cx-status-band]`, { timeout: 10000 });
      await page.waitForSelector(`${PANEL} [data-cx-status-minutes]`, { timeout: 10000 });
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
      // ⚠️ 必须显式等三区块出现，不能断言时「刚好没到」。
      // 面板容器先挂载、状态数据是异步 fetch 来的 —— 只等面板会拿到 hasBand=false，
      // 表现为「3 次跑 1 次过、2 次失败」的竞态（实测确认）。
      await page.waitForSelector(`${PANEL} [data-cx-status-band]`, { timeout: 10000 });
      await page.waitForSelector(`${PANEL} [data-cx-status-minutes]`, { timeout: 10000 });
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


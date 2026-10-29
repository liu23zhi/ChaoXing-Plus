import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// 使用真实构建产物验证 --panel-theme：pink（默认）/ blue / green 会切换面板
// 色板并在配置热更新后重新取色；未知主题回退 pink，不能静默保留任意色板。
const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
let browser;
let bootstrap;
let bundle;

before(async () => {
  bootstrap = await readFile('windows/bootstrap/windows-bootstrap.js', 'utf8');
  bundle = await readFile('dist-windows/chaoxing-plus.windows.js', 'utf8');
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    protocolTimeout: 20000,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server']
  });
});

after(async () => { await browser?.close(); });

const PANEL = '#panel-common-work-results';
const CONFIG = {
  'common.settings.extension-enabled': true,
  'common.settings.windows-panel-enabled': true,
  'common.settings.windows-panel-collapsed': false,
  'common.settings.windows-no-disk-write': true,
  'cx.new.study.enableAnswer': false,
  'cx.new.study.enableChapterTest': false,
  'cx.new.study.enableVisibleQuestionFallback': false
};

async function openPanelPage(t, theme) {
  const page = await browser.newPage();
  t.after(() => page.close());
  page.setDefaultTimeout(15000);
  await page.setViewport({ width: 1100, height: 850, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.isNavigationRequest()) {
      void request.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><head><title>模拟考试列表</title></head><body><main><h1>模拟考试列表</h1></main></body></html>'
      });
    } else {
      void request.abort();
    }
  });
  await page.goto('http://a.chaoxing.com/exam-ans/exam/list');
  await page.evaluate(({ bootstrapSource, config }) => {
    window.__CX_WIN_INSTANCE__ = 'theme-host';
    window.__CX_WIN_CONFIG_JSON__ = config;
    (0, eval)(bootstrapSource);
  }, { bootstrapSource: bootstrap, config: { ...CONFIG, 'common.settings.windows-panel-theme': theme } });
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector(`${PANEL}[data-chaoxing-plus-theme]`);
  return page;
}

async function panelThemeState(page) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const style = getComputedStyle(root);
    return { theme: root.getAttribute('data-chaoxing-plus-theme'), border: style.borderTopColor };
  }, PANEL);
}

test('真实构建包按 --panel-theme 应用蓝/绿主题并回退未知值', { timeout: 30000 }, async (t) => {
  const bluePage = await openPanelPage(t, 'blue');
  assert.deepEqual(await panelThemeState(bluePage), { theme: 'blue', border: 'rgba(37, 99, 235, 0.34)' });

  const greenPage = await openPanelPage(t, 'green');
  assert.deepEqual(await panelThemeState(greenPage), { theme: 'green', border: 'rgba(5, 150, 105, 0.34)' });

  const fallbackPage = await openPanelPage(t, 'light-purple');
  assert.deepEqual(await panelThemeState(fallbackPage), { theme: 'pink', border: 'rgba(219, 39, 119, 0.34)' });
});

test('运行中热更新 --panel-theme 会重新取色并保持默认回退', { timeout: 30000 }, async (t) => {
  const page = await openPanelPage(t, 'blue');
  assert.equal((await panelThemeState(page)).theme, 'blue');
  await page.evaluate(() => {
    window.__CX_WIN_ON_CONFIG__({
      kind: 'config',
      values: { 'common.settings.windows-panel-theme': 'green' }
    });
  });
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('data-chaoxing-plus-theme') === 'green',
    { timeout: 10000 }, PANEL);
  assert.deepEqual(await panelThemeState(page), { theme: 'green', border: 'rgba(5, 150, 105, 0.34)' });

  await page.evaluate(() => {
    window.__CX_WIN_ON_CONFIG__({
      kind: 'config',
      values: { 'common.settings.windows-panel-theme': 'not-a-theme' }
    });
  });
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('data-chaoxing-plus-theme') === 'pink',
    { timeout: 10000 }, PANEL);
  assert.deepEqual(await panelThemeState(page), { theme: 'pink', border: 'rgba(219, 39, 119, 0.34)' });
});

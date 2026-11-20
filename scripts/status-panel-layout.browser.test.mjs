import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';
import ts from '@typescript/typescript6';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const statusPanelPath = resolve(scriptsDir, '..', 'src', 'projects', 'status-panel.ts');

/**
 * 360px 面板里的状态页布局回归。
 *
 * 为什么必须真浏览器：`min-width:0`、`flex:1 1 0`、`grid-template-columns: minmax(0,1fr)`
 * 这类防溢出写法在 JSDOM 里全都没有布局引擎，量不出真实宽度 —— 用假 DOM 断言
 * 「没有横向溢出」是典型的假钉子（问「实现坏了这条会不会红」时会答不上来）。
 */
const PANEL_WIDTH = 360;

async function loadStatusPanelModule() {
  const source = await readFile(statusPanelPath, 'utf8');
  // 必须编译成 CommonJS：页面里用 `new Function('module','exports','require', ...)` 执行，
  // ESNext 输出的 `export {...}` 会在函数体里直接 SyntaxError。
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
  }).outputText;
}

const THEME = {
  surfaceStrong: '#ffffff',
  surface: '#fffafd',
  border: 'rgba(244, 114, 182, 0.24)',
  borderStrong: 'rgba(219, 39, 119, 0.34)',
  text: '#7a1039',
  muted: '#8a1a4d',
  subtle: '#7d2f52',
  primaryDeep: '#be185d',
  successFg: '#14663b',
  warningFg: '#7a4c00',
  dangerFg: '#a11818'
};

let browser;
let moduleSource;

test('搜题状态面板适配 360px 宽度并且不显示全站细节', async (t) => {
  const executablePath = process.env.CX_BROWSER_EXECUTABLE;
  if (!executablePath) return t.skip('未设置 CX_BROWSER_EXECUTABLE');

  const puppeteer = (await import('puppeteer-core')).default;
  moduleSource = await loadStatusPanelModule();
  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    protocolTimeout: 30000,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: PANEL_WIDTH, height: 900, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><html><body><div id="host"></div></body></html>');
    await page.evaluate(({ source, theme, width }) => {
      const module = { exports: {} };
      const require = () => { throw new Error('status-panel 不应有运行时依赖'); };
      new Function('module', 'exports', 'require', source)(module, module.exports, require);
      const host = document.getElementById('host');
      host.style.width = `${width - 28}px`;
      host.style.boxSizing = 'border-box';
      host.append(module.exports.createStatusPanelSection({
        theme,
        snapshot: module.exports.createFixtureServiceStatusSnapshot(Date.now()),
        now: Date.now(),
        onRequestRefresh: () => {}
      }));
    }, { source: moduleSource, theme: THEME, width: PANEL_WIDTH });

    const metrics = await page.evaluate(() => {
      const host = document.getElementById('host');
      const section = host.querySelector('[data-cx-status-panel]');
      const hostBox = host.getBoundingClientRect();
      return {
        section,
        hostWidth: hostBox.width,
        sectionWidth: section.scrollWidth,
        sectionClientWidth: section.clientWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        overflowCount: Array.from(section.querySelectorAll('*')).filter((node) => {
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.right > hostBox.right + 1;
        }).length,
        searchCardCount: section.querySelectorAll('[data-cx-status-search]').length,
        bandCount: section.querySelectorAll('[data-cx-status-band]').length,
        text: section.textContent
      };
    });

    assert.equal(metrics.overflowCount, 0, '搜题状态卡片不得横向溢出');
    assert.ok(metrics.sectionWidth <= metrics.sectionClientWidth + 1);
    assert.ok(metrics.docScrollWidth <= metrics.viewportWidth);
    assert.equal(metrics.searchCardCount, 1);
    assert.equal(metrics.bandCount, 1, '普通状态页展示搜题接口24小时色带，不展示全站时间曲线');
    assert.match(metrics.text, /搜题接口/);
    assert.doesNotMatch(metrics.text, /全站|当前窗口摘要|失败请求|最近每分钟/);
  } finally {
    await browser?.close();
    browser = undefined;
  }
});

test('搜题接口状态卡片的刷新按钮可用', async (t) => {
  const executablePath = process.env.CX_BROWSER_EXECUTABLE;
  if (!executablePath) return t.skip('未设置 CX_BROWSER_EXECUTABLE');

  const puppeteer = (await import('puppeteer-core')).default;
  if (!moduleSource) moduleSource = await loadStatusPanelModule();

  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    protocolTimeout: 30000,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking']
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.setViewport({ width: PANEL_WIDTH, height: 900, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><html><body><div id="host" style="width:332px"></div></body></html>');

    await page.evaluate(({ source, theme }) => {
      const module = { exports: {} };
      const require = () => { throw new Error('status-panel 不应有运行时依赖'); };
      new Function('module', 'exports', 'require', source)(module, module.exports, require);
      const api = module.exports;
      window.statusPanelApi = api;
      window.refreshCalls = 0;
      document.getElementById('host').append(api.createStatusPanelSection({
        theme,
        snapshot: api.createFixtureServiceStatusSnapshot(Date.now()),
        now: Date.now(),
        onRequestRefresh: () => { window.refreshCalls += 1; }
      }));
    }, { source: moduleSource, theme: THEME });
    const refresh = await page.$eval('[data-cx-status-search] button', (button) => {
      button.click();
      return { disabled: button.disabled, text: button.textContent };
    });
    assert.equal(refresh.disabled, false);
    assert.match(refresh.text, /立即刷新/);
    assert.equal(await page.evaluate(() => window.refreshCalls), 1);
  } finally {
    await browser?.close();
    browser = undefined;
  }
});

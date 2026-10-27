import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseHostArgs } from '../windows/host/options.mjs';
import { normalizeConfig } from '../windows/host/config.mjs';
import { RENDER_DIAGNOSTICS_EXPRESSION } from '../windows/host/diagnostics.mjs';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
const generatorPath = resolve('windows/parameter-generator.html');
let browser;

before(async () => {
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server']
  });
});

after(async () => {
  await browser?.close();
});

async function openGenerator() {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.goto(`file:///${generatorPath.replaceAll('\\', '/')}`);
  return page;
}

test('参数生成器离线加载并暴露当前宿主能力接口', async () => {
  const page = await openGenerator();
  assert.equal(await page.title(), '超星学习助手 Windows 参数生成器');
  assert.equal(await page.evaluate(() => Boolean(window.__CX_PARAMETER_GENERATOR__)), true);
  const launcherPath = await page.evaluate(() => window.__CX_PARAMETER_GENERATOR__.state().launcherPath);
  assert.equal(launcherPath.replaceAll('\\', '/'), `${resolve('windows', '..').replaceAll('\\', '/')}/start-windows.cmd`);
  assert.match(await page.$eval('#powershell', (node) => node.value), /& '.*start-windows\.cmd'/u);
  assert.match(await page.$eval('#cmd', (node) => node.value), /^".*start-windows\.cmd"/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value.includes('--scan-mode')), true);
  assert.equal(await page.$eval('#json', (node) => JSON.parse(node.value).settings['common.settings.windows-panel-enabled']), true);
  await page.close();
});

test('预设覆盖关键扫描、面板和普通运行参数', async () => {
  const page = await openGenerator();
  for (const preset of ['silent', 'friendly', 'lazy', 'manual', 'scan', 'path', 'all']) {
    await page.click(`[data-preset="${preset}"]`);
    const output = await page.$eval('#json', (node) => node.value);
    assert.ok(output, `${preset} should generate JSON`);
    const config = JSON.parse(output);
    assert.ok(normalizeConfig(config).settings && Object.hasOwn(config.settings, 'common.settings.windows-panel-enabled'));
    const args = await page.evaluate(() => window.__CX_PARAMETER_GENERATOR__.commandFor(window.__CX_PARAMETER_GENERATOR__.state()).args);
    assert.doesNotThrow(() => parseHostArgs(args));
  }
  await page.click('[data-preset="silent"]');
  assert.match(await page.$eval('#risks', (node) => node.textContent), /错误/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value.includes('--no-disk-write')), true);
  assert.equal(await page.$eval('#powershell', (node) => node.value.includes('Ctrl+Alt+Shift+S')), true);
  assert.equal(await page.$eval('#powershell', (node) => node.value.includes('--answer-threads')), true);
  await page.close();
});

test('生成器生成答题设置，但不导出内存执行、启动清理或自毁参数', async () => {
  const page = await openGenerator();
  assert.equal(await page.$('#answerMode') !== null, true);
  assert.equal(await page.$eval('#selfDestructKey', (node) => node.disabled), true);
  assert.equal(await page.$eval('#wipeOnStart', (node) => node.disabled), true);
  const output = await page.$eval('#powershell', (node) => node.value + document.querySelector('#cmd').value + document.querySelector('#json').value);
  assert.match(output, /--answer-mode/u);
  assert.doesNotMatch(output, /--(?:self-destruct|memory-exec|delete-suspend|wipe-owned-files)/iu);
  await page.click('[data-preset="startupClean"]');
  assert.match(await page.$eval('#status', (node) => node.textContent), /未发布/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  await page.close();
});

test('生成器实时阻止客户端路径和自动选择策略冲突，并处理 no-disk-write 冲突', async () => {
  const page = await openGenerator();
  await page.$eval('#clientPath', (node) => { node.value = 'D:\\Exam\\CXExam.exe'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.select('#selection', 'first');
  assert.match(await page.$eval('#status', (node) => node.textContent), /不能与|互斥/u);
  await page.click('#reset');
  assert.doesNotMatch(await page.$eval('#status', (node) => node.textContent), /无法生成/u);
  await page.click('#noDiskWrite');
  await page.click('#diagnose');
  assert.match(await page.$eval('#status', (node) => node.textContent), /no-disk-write/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  await page.close();
});

test('生成器阻止序号和首选策略冲突，并用 PowerShell 单引号保护美元符号', async () => {
  const page = await openGenerator();
  await page.$eval('#clientIndex', (node) => { node.value = '2'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.select('#selection', 'first');
  assert.match(await page.$eval('#status', (node) => node.textContent), /client-index/u);
  await page.$eval('#clientIndex', (node) => { node.value = ''; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.select('#selection', 'none');
  await page.$eval('#clientPath', (node) => { node.value = 'D:\\Exam\\$old\\Client.exe'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  const output = await page.$eval('#powershell', (node) => node.value);
  assert.match(output, /'D:\\Exam\\\$old\\Client\.exe'/u);
  await page.$eval('#clientPath', (node) => { node.value = "D:\\Exam\\O'Brien\\CXExam.exe"; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await page.$eval('#powershell', (node) => node.value), /'D:\\Exam\\O''Brien\\CXExam\.exe'/u);
  await page.close();
});

test('生成器不为包含 cmd 命令解释符的路径输出 cmd 命令', async () => {
  const page = await openGenerator();
  await page.select('#selection', 'none');
  await page.$eval('#clientPath', (node) => { node.value = 'D:\\Exam\\Client&Tools\\CXExam.exe'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$eval('#cmd', (node) => node.value), '');
  assert.match(await page.$eval('#status', (node) => node.textContent), /cmd 输出不可安全表示/u);
  assert.match(await page.$eval('#powershell', (node) => node.value), /Client&Tools/u);
  await page.close();
});

test('生成器对启动脚本路径使用 PowerShell 安全引用，并在 cmd 不安全时隐藏输出', async () => {
  const page = await openGenerator();
  await page.$eval('#launcherPath', (node) => { node.value = "C:\\Tools\\O'Brien&Co\\start-windows.cmd"; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await page.$eval('#powershell', (node) => node.value), /'C:\\Tools\\O''Brien&Co\\start-windows\.cmd'/u);
  assert.equal(await page.$eval('#cmd', (node) => node.value), '');
  assert.match(await page.$eval('#status', (node) => node.textContent), /cmd 输出不可安全表示/u);
  await page.close();
});

test('生成器不为以反斜杠结尾的目录输出有歧义的 cmd 引号', async () => {
  const page = await openGenerator();
  await page.select('#selection', 'none');
  await page.$eval('#dataDir', (node) => { node.value = 'D:\\'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$eval('#cmd', (node) => node.value), '');
  assert.match(await page.$eval('#status', (node) => node.textContent), /cmd 输出不可安全表示/u);
  assert.match(await page.$eval('#powershell', (node) => node.value), /'D:\\'/u);
  await page.close();
});

test('生成器严格校验答题线程并拒绝不安全的 cmd 内联 JSON 输出', async () => {
  const page = await openGenerator();
  await page.$eval('#answerThreads', (node) => { node.value = '5'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await page.$eval('#status', (node) => node.textContent), /1 到 4/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  await page.$eval('#answerThreads', (node) => { node.value = '4'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('#optionsJson', (node) => { node.value = '{"panelTop":24}'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$eval('#cmd', (node) => node.value), '');
  assert.match(await page.$eval('#status', (node) => node.textContent), /cmd 输出不可安全表示/u);
  const args = await page.evaluate(() => window.__CX_PARAMETER_GENERATOR__.commandFor(window.__CX_PARAMETER_GENERATOR__.state()).args);
  assert.doesNotThrow(() => parseHostArgs(args));
  await page.$eval('#optionsJson', (node) => { node.value = '{"settings":{"common.settings.windows-self-destruct-on-fullscreen-exit":true}}'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await page.$eval('#status', (node) => node.textContent), /未发布/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  await page.close();
});

test('关闭 Windows 面板时页面渲染诊断不采样面板 DOM', async () => {
  const page = await openGenerator();
  await page.setContent('<div id="panel-common-work-results" data-chaoxing-plus-theme="pink"></div>');
  const sample = await page.evaluate((expression) => {
    window.__CX_WIN_HOST__ = { getConfig: () => ({ 'common.settings.windows-panel-enabled': false }) };
    return JSON.parse(eval(expression));
  }, RENDER_DIAGNOSTICS_EXPRESSION);
  assert.equal(sample.panelDiagnosticsEnabled, false);
  assert.equal(sample.panelCount, 0);
  assert.equal(sample.topPanel, null);
  await page.close();
});

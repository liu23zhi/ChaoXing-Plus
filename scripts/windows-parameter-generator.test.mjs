import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
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

test('生成器覆盖数据保留、自毁快捷键冲突和未实现能力校验', async () => {
  const page = await openGenerator();
  const dispatch = (id, configure) => page.evaluate((selector, configureSource) => {
    const node = document.querySelector(selector);
    Function('node', configureSource)(node);
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, `#${id}`, configure);

  // 默认输出不携带任何未发布能力参数，且默认保留运行数据。
  assert.doesNotMatch(await page.$eval('#powershell', (node) => node.value), /--(?:no-)?retain-data|--delete-config/u);
  assert.equal(await page.$eval('#retainData', (node) => node.checked), true);

  // 删除外部配置必须同时指定 --config。
  await dispatch('deleteConfig', 'node.checked = true;');
  assert.match(await page.$eval('#status', (node) => node.textContent), /删除外部配置必须指定 --config/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  await dispatch('configPath', "node.value = 'C:\\\\Tools\\\\chaoxing-plus.json';");
  assert.doesNotMatch(await page.$eval('#status', (node) => node.textContent), /无法生成/u);
  assert.match(await page.$eval('#powershell', (node) => node.value), /--delete-config/u);

  await page.click('#reset');
  await dispatch('retainData', 'node.checked = false;');
  assert.match(await page.$eval('#powershell', (node) => node.value), /--no-retain-data/u);
  const retentionArgs = await page.evaluate(() => window.__CX_PARAMETER_GENERATOR__.commandFor(window.__CX_PARAMETER_GENERATOR__.state()).args);
  assert.doesNotThrow(() => parseHostArgs(retentionArgs));

  // 启动清理重试次数必须为 1-20，超出范围阻止导出。
  await page.click('#reset');
  await dispatch('wipeRetries', "node.value = '21';");
  assert.match(await page.$eval('#status', (node) => node.textContent), /1 到 20/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');

  // 答题快捷键不能与自毁快捷键相同，未实现的自毁能力不能导出命令。
  await page.click('#reset');
  await dispatch('selfDestructKey', "node.value = 'Ctrl+Shift+A';");
  await dispatch('answerKey', "node.value = 'Ctrl+Shift+A';");
  assert.match(await page.$eval('#status', (node) => node.textContent), /不能与自毁快捷键相同/u);
  assert.match(await page.$eval('#status', (node) => node.textContent), /当前宿主不可执行/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');

  // 第一阶段只允许普通执行模式，选择未实现模式时阻止生成。
  await page.click('#reset');
  await dispatch('executionMode', "node.value = 'memory';");
  assert.match(await page.$eval('#status', (node) => node.textContent), /--execution-mode normal/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');

  // 未实现能力标记为“当前宿主不可执行”，而不是静默忽略。
  assert.match(await page.$eval('.capability', (node) => node.textContent), /当前宿主不可执行/u);
  await page.close();
});

test('生成器内联 JSON 与宿主解析规则一致，并拦截非法序号与 -- 开头值', async () => {
  const page = await openGenerator();
  const setField = (id, source) => page.evaluate((selector, script) => {
    const node = document.querySelector(selector);
    Function('node', script)(node);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, `#${id}`, source);

  // 未被独立 CLI 参数覆盖的内联 JSON 字段必须按宿主规则校验，否则导出的命令会在宿主端直接失败。
  const blockedCases = [
    ['{"deleteConfig":true}', /deleteConfig|--config/u],
    ['{"configPath":"C:\\\\x.json"}', /配置文件路径/u],
    ['{"panelWidth":900}', /320 到 800/u],
    ['{"panelTop":20000}', /0 到 10000/u],
    ['{"answerRetry":-1}', /0 到 20/u]
  ];
  for (const [json, pattern] of blockedCases) {
    await setField('optionsJson', `node.value = ${JSON.stringify(json)};`);
    assert.match(await page.$eval('#status', (node) => node.textContent), pattern);
    assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  }
  await setField('optionsJson', "node.value = '{not json';");
  assert.match(await page.$eval('#status', (node) => node.textContent), /无法解析/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');

  // 会被独立 CLI 参数覆盖的 JSON 字段由宿主忽略，生成器不应误报。
  await setField('optionsJson', "node.value = '{\"answerThreads\":9}';");
  assert.notEqual(await page.$eval('#powershell', (node) => node.value), '');
  await page.click('#reset');

  await setField('clientIndex', "node.value = '0';");
  assert.match(await page.$eval('#status', (node) => node.textContent), /大于等于 1/u);
  await setField('clientIndex', "node.value = '2.5';");
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  await page.click('#reset');

  await setField('dataDir', "node.value = '--x';");
  assert.match(await page.$eval('#status', (node) => node.textContent), /不能以 -- 开头/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  await page.close();
});

test('生成器归一化快捷键别名、保持启动清理预设阻止状态并导出新增参数', async () => {
  const page = await openGenerator();
  const setField = (id, source) => page.evaluate((selector, script) => {
    const node = document.querySelector(selector);
    Function('node', script)(node);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, `#${id}`, source);

  await setField('selfDestructKey', "node.value = 'Ctrl+Shift+A';");
  await setField('answerKey', "node.value = 'Control+Shift+A';");
  assert.match(await page.$eval('#status', (node) => node.textContent), /不能与自毁快捷键相同/u);
  await page.click('#reset');

  await page.click('[data-preset="startupClean"]');
  assert.match(await page.$eval('#status', (node) => node.textContent), /未发布/u);
  await setField('quiet', 'node.checked = false;');
  assert.match(await page.$eval('#status', (node) => node.textContent), /未发布/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  await page.click('[data-preset="lazy"]');
  assert.notEqual(await page.$eval('#powershell', (node) => node.value), '');
  await page.click('#reset');

  await setField('noScanCache', 'node.checked = true;');
  await setField('panelTheme', "node.value = 'pink';");
  const info = await page.evaluate(() => {
    const generator = window.__CX_PARAMETER_GENERATOR__;
    return {
      args: generator.commandFor(generator.state()).args,
      powershell: document.getElementById('powershell').value,
      summary: document.getElementById('summary').textContent
    };
  });
  assert.equal(info.args.includes('--no-scan-cache'), true);
  assert.match(info.powershell, /--panel-theme 'pink'/u);
  assert.doesNotThrow(() => parseHostArgs(info.args));
  assert.match(info.summary, /运行数据/u);
  assert.match(info.summary, /启动清理\/自毁/u);
  await page.close();
});

test('参数生成器保持单文件离线特性且不写用户存储', async () => {
  const html = await readFile(new URL('../windows/parameter-generator.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+src=/iu);
  assert.doesNotMatch(html, /<link[^>]+href=/iu);
  assert.doesNotMatch(html, /https?:\/\//iu);
  assert.doesNotMatch(html, /localStorage|sessionStorage|indexedDB|XMLHttpRequest|WebSocket|sendBeacon/iu);
  assert.doesNotMatch(html, /from ['"]node:/u);
});

test('参数生成器包含方案要求的 8 个内容分组与 8 个预设', async () => {
  const page = await openGenerator();
  const groups = await page.$$eval('.section h2', (nodes) => nodes.map((node) => node.textContent.trim()));
  for (const group of ['客户端扫描', '配置与数据', '执行模式', '面板', '答题', '日志与诊断', '启动清理', '自毁']) {
    assert.equal(groups.includes(group), true, `缺少分组：${group}`);
  }
  assert.equal((await page.$$('[data-preset]')).length, 8);
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

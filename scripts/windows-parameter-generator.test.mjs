import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyHostOptionsToConfig, applyOptionsJsonToOptions, parseHostArgs } from '../windows/host/options.mjs';
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

test('生成器可切换原生单文件入口并直接导出 EXE 命令，预设保留宿主选择', async () => {
  const page = await openGenerator();
  assert.equal(await page.evaluate(() => window.__CX_PARAMETER_GENERATOR__.state().hostType), 'node');
  await page.select('#hostType', 'native');
  await page.$eval('#nativePath', (node) => { node.value = "C:\\学习助手 O'Brien\\chaoxing_plus.exe"; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('[data-preset="lazy"]');
  const output = await page.evaluate(() => {
    const generator = window.__CX_PARAMETER_GENERATOR__;
    const state = generator.state();
    return { state, command: generator.commandFor(state), errors: generator.validate(state).errors, json: JSON.parse(document.getElementById('json').value) };
  });
  assert.equal(output.state.hostType, 'native');
  assert.equal(output.state.dataDir, '.data');
  assert.deepEqual(output.errors, []);
  assert.doesNotMatch(output.command.powershell, /node\.exe|main\.mjs/u);
  assert.match(output.command.powershell, /\$cxStart\.FileName = 'C:\\学习助手 O''Brien\\chaoxing_plus\.exe'/u);
  assert.match(output.command.powershell, /\$cxStart\.WorkingDirectory = 'C:\\学习助手 O''Brien\\'/u);
  assert.match(output.command.cmd, /&& "C:\\学习助手 O'Brien\\chaoxing_plus\.exe"/u);
  assert.equal(output.json.retainData, undefined);
  assert.equal(output.json.deleteConfig, undefined);
  assert.equal(await page.$eval('#retainData', (node) => node.disabled), true);
  assert.equal(await page.$eval('#deleteConfig', (node) => node.disabled), true);
  await page.close();
});

test('原生模式拒绝数据清理、无效 EXE 路径、小数面板与未知 JSON 字段', async () => {
  const page = await openGenerator();
  await page.select('#hostType', 'native');
  for (const nativePath of ['chaoxing_plus.exe', 'C:chaoxing_plus.exe', '\\Tools\\chaoxing_plus.exe', 'C:\\Tools\\main.mjs']) {
    await page.$eval('#nativePath', (node, path) => { node.value = path; node.dispatchEvent(new Event('input', { bubbles: true })); }, nativePath);
    assert.equal(await page.$eval('#powershell', (node) => node.value), '', nativePath);
  }
  await page.$eval('#nativePath', (node) => { node.value = 'C:\\Tools\\chaoxing_plus.exe'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  for (const optionsJson of ['{"retainData":false}', '{"deleteConfig":true}', '{"unknown":true}', '{"panelTop":1.5}', '{"answerKey":"Ctrl+Ctrl+A"}', '{"settings":{"common.settings.windows-panel-enabled":"true"}}', '{"settings":{"common.settings.extension-enabled":"true"}}', '{"dpiAware":true,"settings":{"common.settings.windows-no-disk-write":true}}']) {
    await page.$eval('#optionsJson', (node, text) => { node.value = text; node.dispatchEvent(new Event('input', { bubbles: true })); }, optionsJson);
    assert.equal(await page.$eval('#powershell', (node) => node.value), '', optionsJson);
    assert.equal(await page.$eval('#json', (node) => node.value), '', optionsJson);
  }
  await page.$eval('#optionsJson', (node) => { node.value = ''; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('#panelTop', (node) => { node.value = '1.5'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  await page.close();
});

test('切换宿主不会静默丢弃已有清理请求或自定义数据目录', async () => {
  const page = await openGenerator();
  await page.evaluate(() => {
    document.getElementById('retainData').checked = false;
    document.getElementById('dataDir').value = 'D:\\自定义缓存';
  });
  await page.select('#hostType', 'native');
  await page.$eval('#nativePath', (node) => { node.value = 'C:\\Tools\\chaoxing_plus.exe'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$eval('#dataDir', (node) => node.value), 'D:\\自定义缓存');
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  assert.match(await page.$eval('#status', (node) => node.textContent), /原生宿主当前不可执行/u);
  await page.click('#reset');
  assert.equal(await page.$eval('#hostType', (node) => node.value), 'native');
  assert.equal(await page.$eval('#dataDir', (node) => node.value), '.data');
  assert.ok(await page.$eval('#powershell', (node) => node.value));
  await page.close();
});

test('原生预设命令和 JSON 均通过已编译入口只读解析', { skip: !process.env.CX_NATIVE_HOST_EXE }, async () => {
  const page = await openGenerator();
  try {
    await page.select('#hostType', 'native');
    await page.$eval('#nativePath', (node, path) => { node.value = path; node.dispatchEvent(new Event('input', { bubbles: true })); }, resolve(process.env.CX_NATIVE_HOST_EXE));
    for (const preset of ['silent', 'friendly', 'lazy', 'manual', 'scan', 'path', 'all']) {
      await page.click(`[data-preset="${preset}"]`);
      const output = await page.evaluate(() => {
        const generator = window.__CX_PARAMETER_GENERATOR__;
        return { ...generator.commandFor(generator.state()), json: document.getElementById('json').value };
      });
      assert.ok(output.json, preset);
      for (const args of [output.args, ['--options-json', output.json]]) {
        const result = spawnSync(process.env.CX_NATIVE_HOST_EXE, [...args, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${preset}\n${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /6\.2\.0/u);
      }
      assert.ok(output.cmd, preset);
      const cmdResult = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${output.cmd} --help"`], {
        encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 10000
      });
      assert.ifError(cmdResult.error);
      assert.equal(cmdResult.status, 0, `${preset}\n${cmdResult.stdout}\n${cmdResult.stderr}`);
    }
  } finally { await page.close(); }
});

test('原生 JSON 导出与 CLI 一致覆盖客户端选择族和诊断反向别名', { skip: !process.env.CX_NATIVE_HOST_EXE }, async () => {
  const page = await openGenerator();
  try {
    for (const scenario of [
      { inline: { clientPath: 'D:\\Example\\CXExam.exe' }, form: { selection: 'interactive' }, expected: 'selectClient' },
      { inline: { clientFirst: true }, form: { selection: 'interactive' }, expected: 'selectClient' },
      { inline: { clientIndex: 2 }, form: { selection: 'first' }, expected: 'clientFirst' },
      { inline: { selectClient: true }, form: { clientPath: 'D:\\Example\\CXExam.exe', selection: 'none' }, expected: 'clientPath' },
      { inline: { scanClients: true }, form: { clientPath: 'D:\\Example\\CXExam.exe', selection: 'none' }, expected: 'clientPath' },
      { inline: { noDiagnose: true }, form: { diagnose: true }, expected: 'diagnose' }
    ]) {
      const output = await page.evaluate(({ scenario, nativePath }) => {
        const generator = window.__CX_PARAMETER_GENERATOR__;
        const state = { ...generator.state(), hostType: 'native', nativePath, ...scenario.form, optionsJson: JSON.stringify(scenario.inline) };
        return { validation: generator.validate(state), command: generator.commandFor(state), config: generator.configFor(state) };
      }, { scenario, nativePath: resolve(process.env.CX_NATIVE_HOST_EXE) });
      assert.deepEqual(output.validation.errors, [], JSON.stringify(scenario));
      assert.ok(output.config[scenario.expected]);
      assert.equal(output.config.noDiagnose, undefined);
      for (const args of [output.command.args, ['--options-json', JSON.stringify(output.config)]]) {
        const result = spawnSync(process.env.CX_NATIVE_HOST_EXE, [...args, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${JSON.stringify(scenario)}\n${result.stdout}\n${result.stderr}`);
      }
    }
  } finally { await page.close(); }
});

test('原生生成器按实际 UTF-16 缓冲区限制校验表单和内联 JSON', async () => {
  const page = await openGenerator();
  try {
    const results = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      const base = { ...generator.state(), hostType: 'native', nativePath: 'C:\\Tools\\chaoxing_plus.exe' };
      return [
        ['expectedBrowser', 'x'.repeat(127), true], ['expectedBrowser', 'x'.repeat(128), false],
        ['dataDir', 'x'.repeat(1023), true], ['dataDir', 'x'.repeat(1024), false],
        ['configPath', 'x'.repeat(1024), false], ['clientPath', 'D:\\' + 'x'.repeat(1024) + '\\CXExam.exe', false],
        ['optionsJson', JSON.stringify({ expectedBrowser: 'x'.repeat(128) }), false],
        ['optionsJson', JSON.stringify({ dataDir: 'x'.repeat(1024) }), false],
        ['optionsJson', '@' + 'x'.repeat(1024), false],
        ['optionsJson', JSON.stringify({ settings: { 'common.settings.windows-panel-theme': 'x'.repeat(128) } }), false]
      ].map(([key, value, valid]) => ({ key, valid, errors: generator.validate({ ...base, [key]: value }).errors }));
    });
    for (const result of results) assert.equal(result.errors.length === 0, result.valid, JSON.stringify(result));
  } finally { await page.close(); }
});

test('原生 PowerShell 5.1/7 输出保留 JSON、中文、引号和工作目录且不启动客户端', { skip: process.platform !== 'win32' || !process.env.CX_NATIVE_HOST_EXE }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cx-generator-中文 O'Brien & (%CX_GENERATOR_SENTINEL%)! "));
  const nativePath = join(directory, 'chaoxing_plus.exe');
  const configName = "配置 O'Brien.json";
  const canary = '中文 "quoted" O\'Brien %CX_GENERATOR_SENTINEL% & | < > ^ ! ( ) $HOME $(throw "must stay text")\n尾反斜杠\\';
  const page = await openGenerator();
  try {
    await copyFile(resolve(process.env.CX_NATIVE_HOST_EXE), nativePath);
    await writeFile(join(directory, configName), JSON.stringify({ settings: { 'common.settings.generator-cwd': 'relative-config-read' } }), 'utf8');
    await page.select('#hostType', 'native');
    await page.evaluate((values) => {
      for (const [id, value] of Object.entries(values)) {
        const node = document.getElementById(id);
        node.value = value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, { nativePath, configPath: configName, optionsJson: JSON.stringify({ settings: { 'common.settings.generator-canary': canary } }), dataDir: "D:\\缓存 O'Brien\\" });
    const output = await page.$eval('#powershell', (node) => node.value);
    assert.ok(output, await page.$eval('#status', (node) => node.textContent));
    // This read-only entry returns before discovery, UAC, launch, CDP, audit or file output.
    const readOnlyCommand = output.replace('  $cxProcess = $null', "  $cxStart.Arguments += ' --print-effective-config'\n  $cxProcess = $null");
    assert.notEqual(readOnlyCommand, output);
    for (const shell of ['powershell.exe', 'pwsh.exe']) {
      await t.test(shell, (t) => {
        const script = `[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n${readOnlyCommand}\nexit $LASTEXITCODE`;
        const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
          encoding: 'utf8', windowsHide: true, timeout: 15000,
          env: { ...process.env, CX_GENERATOR_SENTINEL: 'THIS_MUST_NOT_REPLACE_THE_LITERAL' }
        });
        if (shell === 'pwsh.exe' && result.error?.code === 'ENOENT') return t.skip('PowerShell 7 is not installed');
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${shell}\n${result.stdout}\n${result.stderr}`);
        const settings = JSON.parse(result.stdout.trim());
        assert.equal(settings['common.settings.generator-canary'], canary);
        assert.equal(settings['common.settings.generator-cwd'], 'relative-config-read');
      });
    }
  } finally {
    await page.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('原生宿主切换在桌面与手机宽度保持表单和校验提示可见', async () => {
  const page = await openGenerator();
  try {
    await page.select('#hostType', 'native');
    for (const width of [1280, 390]) {
      await page.setViewport({ width, height: 900 });
      const layout = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        fieldVisible: !document.getElementById('nativeLauncherField').hidden,
        nodeHidden: document.getElementById('nodeLauncherField').hidden,
        error: document.getElementById('status').textContent,
        controls: ['hostType', 'nativePath', 'status'].map((id) => {
          const rect = document.getElementById(id).getBoundingClientRect();
          return { id, left: rect.left, right: rect.right, width: rect.width };
        })
      }));
      assert.ok(layout.scrollWidth <= layout.viewport, JSON.stringify(layout));
      assert.equal(layout.fieldVisible, true);
      assert.equal(layout.nodeHidden, true);
      assert.match(layout.error, /原生宿主 EXE.*绝对路径/u);
      for (const control of layout.controls) {
        assert.ok(control.left >= 0 && control.right <= width && control.width > 0, JSON.stringify(control));
      }
      if (process.env.CX_GENERATOR_SCREENSHOT_DIR) {
        await mkdir(process.env.CX_GENERATOR_SCREENSHOT_DIR, { recursive: true });
        await page.$eval('#hostType', (node) => node.scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: join(process.env.CX_GENERATOR_SCREENSHOT_DIR, `native-${width}.png`) });
      }
    }
  } finally { await page.close(); }
});

test('参数生成器离线加载并暴露当前宿主能力接口', async () => {
  const page = await openGenerator();
  assert.equal(await page.title(), '超星学习助手 Windows 参数生成器');
  assert.equal(await page.evaluate(() => Boolean(window.__CX_PARAMETER_GENERATOR__)), true);
  const launcherPath = await page.evaluate(() => window.__CX_PARAMETER_GENERATOR__.state().launcherPath);
  assert.equal(launcherPath.replaceAll('\\', '/'), `${resolve('windows', '..').replaceAll('\\', '/')}/windows/host/main.mjs`);
  assert.match(await page.$eval('#powershell', (node) => node.value), /ProcessStartInfo/u);
  assert.match(await page.$eval('#powershell', (node) => node.value), /UseShellExecute = \$false/u);
  assert.doesNotMatch(await page.$eval('#powershell', (node) => node.value), /start-windows\.cmd/u);
  assert.match(await page.$eval('#cmd', (node) => node.value), /^cd \/d .* && node\.exe /u);
  assert.equal(await page.$eval('#powershell', (node) => node.value.includes('--scan-mode')), true);
  assert.equal(await page.$eval('#json', (node) => JSON.parse(node.value).settings['common.settings.windows-panel-enabled']), true);
  await page.close();
});

test('生成的 PowerShell 文本在 Windows PowerShell 5.1 和 PowerShell 7 保留内联 JSON', { skip: process.platform !== 'win32' }, async (t) => {
  const page = await openGenerator();
  const optionsJson = JSON.stringify({
    expectedBrowser: '中 文 O\'Brien "quoted" %CXPLUS_GENERATOR_SENTINEL% & | < > ^ ! ( ) $HOME $(throw "must stay text")',
    settings: { 'common.settings.fixture': 'line1\nline2\\"quoted"\\' }
  }, null, 2);
  await page.evaluate((values) => {
    for (const [id, value] of Object.entries(values)) {
      const node = document.getElementById(id);
      node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, { optionsJson, selection: 'none', clientPath: "D:\\考试 O'Brien & (%CXPLUS_GENERATOR_SENTINEL%)!\\CXExam.exe", dataDir: "D:\\缓存 O'Brien\\" });
  const output = await page.evaluate(() => {
    const generator = window.__CX_PARAMETER_GENERATOR__;
    if (generator.validate(generator.state()).errors.length) throw new Error(document.getElementById('status').textContent);
    return generator.commandFor(generator.state());
  });
  await page.close();

  // Force the real host to stop at help, before discovery, launch, or any file output.
  const preload = "process.stdout.write('CXPLUS_ARGV:' + JSON.stringify(process.argv.slice(2)) + '\\n'); process.stdout.write('CXPLUS_CWD:' + JSON.stringify(process.cwd()) + '\\n'); process.argv.push('--help');";
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    await t.test(shell, (t) => {
      const script = `[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n${output.powershell}\nexit $LASTEXITCODE`;
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        encoding: 'utf8', windowsHide: true, timeout: 15000, input: '\r\n',
        env: { ...process.env, CXPLUS_GENERATOR_SENTINEL: 'THIS_MUST_NOT_REPLACE_THE_LITERAL', NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(preload).toString('base64')}` }
      });
      if (shell === 'pwsh.exe' && result.error?.code === 'ENOENT') return t.skip('PowerShell 7 is not installed');
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${shell}\n${result.stdout}\n${result.stderr}`);
      const argvLine = result.stdout.split(/\r?\n/u).find((line) => line.startsWith('CXPLUS_ARGV:'));
      assert.ok(argvLine, result.stdout);
      assert.deepEqual(JSON.parse(argvLine.slice('CXPLUS_ARGV:'.length)), output.args);
      const cwdLine = result.stdout.split(/\r?\n/u).find((line) => line.startsWith('CXPLUS_CWD:'));
      assert.ok(cwdLine, result.stdout);
      assert.equal(JSON.parse(cwdLine.slice('CXPLUS_CWD:'.length)), resolve('.'));
      assert.match(result.stdout, /--options-json/u);
    });
  }
});

test('生成的安全 cmd 文本直接启动 Node 并保留参数和项目工作目录', { skip: process.platform !== 'win32' }, async () => {
  const page = await openGenerator();
  await page.click('[data-preset="lazy"]');
  const output = await page.evaluate(() => window.__CX_PARAMETER_GENERATOR__.commandFor(window.__CX_PARAMETER_GENERATOR__.state()));
  await page.close();
  const preload = "process.stdout.write('CXPLUS_ARGV:' + JSON.stringify(process.argv.slice(2)) + '\\n'); process.stdout.write('CXPLUS_CWD:' + JSON.stringify(process.cwd()) + '\\n'); process.argv.push('--help');";
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${output.cmd}"`], {
    encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 15000, input: '\r\n',
    env: { ...process.env, NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(preload).toString('base64')}` }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const argvLine = result.stdout.split(/\r?\n/u).find((line) => line.startsWith('CXPLUS_ARGV:'));
  assert.ok(argvLine, result.stdout);
  assert.deepEqual(JSON.parse(argvLine.slice('CXPLUS_ARGV:'.length)), output.args);
  const cwdLine = result.stdout.split(/\r?\n/u).find((line) => line.startsWith('CXPLUS_CWD:'));
  assert.ok(cwdLine, result.stdout);
  assert.equal(JSON.parse(cwdLine.slice('CXPLUS_CWD:'.length)), resolve('.'));
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

const HOST_OPTION_FIELDS = [
  'clientPath', 'clientIndex', 'clientFirst', 'listClients', 'selectClient', 'scanMode', 'ui',
  'rescan', 'noScanCache', 'noDiskWrite', 'quiet', 'logFileEnabled', 'diagnose', 'noDiagnose',
  'reportPath', 'diagnosticsDir', 'dataDir', 'dataDirExplicit', 'retainData', 'deleteConfig',
  'stopClientOnExit', 'panelEnabled', 'panelCollapsed', 'panelTop', 'panelRight', 'panelWidth',
  'panelTheme', 'answerMode', 'answerKey', 'answerThreads', 'answerCountdown', 'answerRetry',
  'showAnswerDialog', 'autoSubmit', 'expectedBrowser', 'injectStrategy', 'injectRetries',
  'injectBlankFrames', 'captureConsole', 'debugEndpointTimeoutMs', 'targetPollIntervalMs', 'bundleTimeoutMs'
];

function relevantHostOptions(options) {
  return Object.fromEntries(HOST_OPTION_FIELDS.map((key) => [key, options[key]]));
}

test('所有可执行预设的 JSON 与生成命令具有相同的宿主启动行为', async () => {
  const page = await openGenerator();
  for (const preset of ['silent', 'friendly', 'lazy', 'manual', 'scan', 'path', 'all']) {
    await page.click(`[data-preset="${preset}"]`);
    const output = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      return { args: generator.commandFor(generator.state()).args, json: JSON.parse(document.querySelector('#json').value) };
    });
    const fromCommand = parseHostArgs(output.args);
    const fromJson = applyOptionsJsonToOptions(parseHostArgs([]), output.json);
    assert.deepEqual(relevantHostOptions(fromJson), relevantHostOptions(fromCommand), preset);
    if (preset === 'silent') {
      assert.equal(output.json.noDiskWrite, true);
      assert.equal(output.json.logFileEnabled, false);
      assert.equal(output.json.quiet, true);
      assert.equal(output.json.clientFirst, true);
    }
  }
  await page.close();
});

test('生成器导出 CEF 多路径注入参数并可由宿主重新解析', async () => {
  const page = await openGenerator();
  await page.select('#injectStrategy', 'script');
  await page.$eval('#injectRetries', (node) => { node.value = '4'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('#debugTimeout', (node) => { node.value = '45000'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('#targetPollInterval', (node) => { node.value = '1500'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('#bundleTimeout', (node) => { node.value = '90000'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#injectBlankFrames');
  await page.click('#captureConsole');
  const output = await page.evaluate(() => {
    const generator = window.__CX_PARAMETER_GENERATOR__;
    return { args: generator.commandFor(generator.state()).args, json: JSON.parse(document.querySelector('#json').value) };
  });
  const fromCommand = parseHostArgs(output.args);
  const fromJson = applyOptionsJsonToOptions(parseHostArgs([]), output.json);
  assert.equal(fromCommand.injectStrategy, 'script');
  assert.equal(fromCommand.injectRetries, 4);
  assert.equal(fromCommand.debugEndpointTimeoutMs, 45000);
  assert.equal(fromCommand.targetPollIntervalMs, 1500);
  assert.equal(fromCommand.bundleTimeoutMs, 90000);
  assert.equal(fromCommand.injectBlankFrames, false);
  assert.equal(fromCommand.captureConsole, false);
  assert.equal(fromJson.injectStrategy, 'script');
  assert.equal(fromJson.bundleTimeoutMs, 90000);
  await page.close();
});

test('生成器内联注入超时采用宿主下限，并允许独立 CLI 覆盖无效 JSON 值', async () => {
  const page = await openGenerator();
  for (const [key, field] of [['debugEndpointTimeoutMs', 'debugTimeout'], ['bundleTimeoutMs', 'bundleTimeout']]) {
    for (const timeout of [1, 999]) {
      await page.click('#reset');
      const source = { [key]: timeout };
      await page.$eval('#optionsJson', (node, value) => {
        node.value = JSON.stringify(value);
        node.dispatchEvent(new Event('input', { bubbles: true }));
      }, source);
      const blocked = await page.evaluate(() => {
        const generator = window.__CX_PARAMETER_GENERATOR__;
        const state = generator.state();
        return { errors: generator.validate(state).errors, args: generator.commandFor(state).args,
          outputs: ['powershell', 'cmd', 'json'].map((id) => document.getElementById(id).value) };
      });
      assert.throws(() => applyOptionsJsonToOptions(parseHostArgs(blocked.args), source), /1000/u);
      assert.ok(blocked.errors.some((error) => error.includes(key)), `${key}=${timeout} must be rejected`);
      assert.deepEqual(blocked.outputs, ['', '', '']);
    }

    await page.$eval('#optionsJson', (node, key) => {
      node.value = JSON.stringify({ [key]: 1000 });
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, key);
    const minimum = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      const state = generator.state();
      return { errors: generator.validate(state).errors, args: generator.commandFor(state).args,
        config: JSON.parse(document.getElementById('json').value) };
    });
    assert.deepEqual(minimum.errors, []);
    assert.equal(applyOptionsJsonToOptions(parseHostArgs(minimum.args), minimum.config)[key], 1000);

    await page.$eval('#optionsJson', (node, key) => {
      node.value = JSON.stringify({ [key]: 1 });
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, key);
    await page.$eval(`#${field}`, (node) => {
      node.value = '45000';
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const overridden = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      const state = generator.state();
      return { errors: generator.validate(state).errors, args: generator.commandFor(state).args,
        config: JSON.parse(document.getElementById('json').value) };
    });
    assert.deepEqual(overridden.errors, []);
    assert.equal(applyOptionsJsonToOptions(parseHostArgs(overridden.args), { [key]: 1 })[key], 45000);
    assert.equal(overridden.config[key], 45000);
  }
  await page.close();
});

test('导出 JSON 合并内联配置并由实际发出的表单参数覆盖，settings 保持深合并', async () => {
  const page = await openGenerator();
  const source = {
    panelTop: 24,
    answerMode: 'manual',
    quiet: true,
    settings: { 'common.settings.fixture': 'kept', 'common.settings.windows-panel-enabled': false }
  };
  await page.$eval('#optionsJson', (node, json) => { node.value = json; node.dispatchEvent(new Event('input', { bubbles: true })); }, JSON.stringify(source));
  await page.select('#ui', 'gui');
  const output = await page.evaluate(() => {
    const generator = window.__CX_PARAMETER_GENERATOR__;
    return { args: generator.commandFor(generator.state()).args, json: JSON.parse(document.querySelector('#json').value) };
  });
  const commandOptions = applyOptionsJsonToOptions(parseHostArgs(output.args), source);
  const jsonOptions = applyOptionsJsonToOptions(parseHostArgs([]), output.json);
  assert.deepEqual(relevantHostOptions(jsonOptions), relevantHostOptions(commandOptions));
  const expected = applyHostOptionsToConfig(normalizeConfig(output.json), commandOptions);
  const actual = applyHostOptionsToConfig(normalizeConfig(output.json), jsonOptions);
  assert.deepEqual(actual.settings, expected.settings);
  assert.equal(output.json.settings['common.settings.fixture'], 'kept');
  assert.equal(jsonOptions.panelTop, 24);
  assert.equal(jsonOptions.answerMode, 'auto');
  assert.equal(jsonOptions.ui, 'gui');
  await page.close();
});

test('@文件注入保留可运行命令但阻止不完整 JSON 导出', async () => {
  const page = await openGenerator();
  await page.$eval('#optionsJson', (node) => { node.value = '@C:\\Tools\\settings.json'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await page.$eval('#powershell', (node) => node.value), /--options-json/u);
  assert.equal(await page.$eval('#json', (node) => node.value), '');
  assert.match(await page.$eval('#status', (node) => node.textContent), /JSON.*(?:外部|文件)|(?:外部|文件).*JSON/u);
  await page.close();
});

test('生成器只导出第一阶段能力，启动清理设计预设不生成可运行输出', async () => {
  const page = await openGenerator();
  assert.equal(await page.$('#answerMode') !== null, true);
  assert.equal(await page.$eval('#selfDestructKey', (node) => node.disabled), true);
  for (const id of ['wipeOnStart', 'wipePolicy', 'wipeRetries', 'wipeDelay', 'wipeInterval', 'wipeRuntimeRetry']) {
    assert.equal(await page.$eval(`#${id}`, (node) => node.disabled), true, id);
  }
  const output = await page.$eval('#powershell', (node) => node.value + document.querySelector('#cmd').value + document.querySelector('#json').value);
  assert.match(output, /--answer-mode/u);
  assert.doesNotMatch(output, /--(?:wipe|self-destruct|memory-exec|delete-suspend)/iu);
  await page.click('[data-preset="startupClean"]');
  assert.match(await page.$eval('#status', (node) => node.textContent), /启动清理.*当前宿主不可执行/u);
  assert.match(await page.$eval('#summary', (node) => node.textContent), /启动清理.*设计.*retry/u);
  const blocked = await page.evaluate(() => {
    const generator = window.__CX_PARAMETER_GENERATOR__;
    return {
      outputs: ['powershell', 'cmd', 'json'].map((id) => document.getElementById(id).value),
      command: generator.commandFor(generator.state()),
      config: generator.configFor(generator.state()),
      capabilityBlocked: generator.capabilityBlocked()
    };
  });
  assert.deepEqual(blocked.outputs, ['', '', '']);
  assert.equal(blocked.command.powershell, '');
  assert.equal(blocked.command.cmd, '');
  assert.deepEqual(blocked.command.args, []);
  assert.equal(blocked.config, null);
  assert.equal(blocked.capabilityBlocked, true);
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
  assert.match(output, /D:\\Exam\\\$old\\Client\.exe/u);
  await page.$eval('#clientPath', (node) => { node.value = "D:\\Exam\\O'Brien\\CXExam.exe"; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await page.$eval('#powershell', (node) => node.value), /D:\\Exam\\O''Brien\\CXExam\.exe/u);
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

test('生成器对 Node 宿主路径使用 PowerShell 安全引用，并在 cmd 不安全时隐藏输出', async () => {
  const page = await openGenerator();
  await page.$eval('#launcherPath', (node) => { node.value = "C:\\Tools\\O'Brien&Co\\windows\\host\\main.mjs"; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await page.$eval('#powershell', (node) => node.value), /C:\\Tools\\O''Brien&Co\\windows\\host\\main\.mjs/u);
  assert.equal(await page.$eval('#cmd', (node) => node.value), '');
  assert.match(await page.$eval('#status', (node) => node.textContent), /cmd 输出不可安全表示/u);
  await page.close();
});

test('生成器拒绝相对、驱动器相对和仅根目录相对的 Node 宿主路径', async () => {
  const page = await openGenerator();
  for (const launcherPath of [
    'chaoxing_plus\\windows\\host\\main.mjs', '.\\windows\\host\\main.mjs',
    '..\\chaoxing_plus\\windows\\host\\main.mjs', 'C:chaoxing_plus\\windows\\host\\main.mjs',
    '\\chaoxing_plus\\windows\\host\\main.mjs', '/chaoxing_plus/windows/host/main.mjs',
    '\\\\server\\windows\\host\\main.mjs', '\\\\server\\\\windows\\host\\main.mjs'
  ]) {
    await page.$eval('#launcherPath', (node, value) => {
      node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, launcherPath);
    const result = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      const state = generator.state();
      return { errors: generator.validate(state).errors, command: generator.commandFor(state),
        outputs: ['powershell', 'cmd', 'json'].map((id) => document.getElementById(id).value) };
    });
    assert.ok(result.errors.some((error) => error.includes('绝对路径')), launcherPath);
    assert.deepEqual(result.outputs, ['', '', ''], launcherPath);
    assert.equal(result.command.powershell, '', launcherPath);
    assert.equal(result.command.cmd, '', launcherPath);
  }
  await page.close();
});

test('生成器接受驱动器绝对路径及正斜杠，并为完整 UNC 只生成 PowerShell', async () => {
  const page = await openGenerator();
  for (const launcherPath of [
    'C:\\Tools\\chaoxing_plus\\windows\\host\\main.mjs',
    'C:/学习助手/windows/host/main.mjs', 'Z:\\windows\\host\\main.mjs',
    '\\\\server\\share\\学习助手\\windows\\host\\main.mjs', '//server/share/windows/host/main.mjs'
  ]) {
    await page.$eval('#launcherPath', (node, value) => {
      node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, launcherPath);
    const result = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      const state = generator.state();
      return { errors: generator.validate(state).errors, command: generator.commandFor(state), powershell: document.getElementById('powershell').value };
    });
    assert.deepEqual(result.errors, [], launcherPath);
    assert.ok(result.powershell, launcherPath);
    if (/^[\\/]{2}/u.test(launcherPath)) {
      assert.equal(result.command.cmd, '', launcherPath);
      assert.match(result.command.cmdWarning, /UNC/u);
    } else {
      assert.ok(result.command.cmd, launcherPath);
    }
  }
  await page.close();
});

test('生成器不为以反斜杠结尾的目录输出有歧义的 cmd 引号', async () => {
  const page = await openGenerator();
  await page.select('#selection', 'none');
  await page.$eval('#dataDir', (node) => { node.value = 'D:\\'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$eval('#cmd', (node) => node.value), '');
  assert.match(await page.$eval('#status', (node) => node.textContent), /cmd 输出不可安全表示/u);
  assert.ok(await page.$eval('#powershell', (node) => node.value.includes('"D:' + '\\'.repeat(2) + '"')));
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

test('生成器覆盖数据保留、自毁快捷键冲突和启动清理范围校验', async () => {
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

  // 内存执行、删除挂起和自毁仍标记为当前宿主不可执行。
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
    ['{"answerRetry":-1}', /0 到 20/u],
    ['{"wipeRetries":21}', /当前宿主不可执行/u],
    ['{"wipeFailurePolicy":"stop"}', /当前宿主不可执行/u]
  ];
  for (const [json, pattern] of blockedCases) {
    await setField('optionsJson', `node.value = ${JSON.stringify(json)};`);
    assert.match(await page.$eval('#status', (node) => node.textContent), pattern);
    assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  }
  await setField('optionsJson', "node.value = '{not json';");
  assert.match(await page.$eval('#status', (node) => node.textContent), /无法解析/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');

  await setField('optionsJson', "node.value = '{\"wipeOwnedFilesOnStart\":true,\"wipeRetries\":7,\"wipeRetryDelayMs\":350,\"wipeRuntimeIntervalSec\":45}';");
  assert.match(await page.$eval('#status', (node) => node.textContent), /启动清理.*当前宿主不可执行/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  assert.equal(await page.$eval('#json', (node) => node.value), '');

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

test('生成器归一化快捷键别名，修改设计预设后仍不降级输出', async () => {
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
  assert.match(await page.$eval('#status', (node) => node.textContent), /启动清理.*当前宿主不可执行/u);
  await setField('quiet', 'node.checked = false;');
  assert.match(await page.$eval('#status', (node) => node.textContent), /启动清理.*当前宿主不可执行/u);
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
  assert.match(info.powershell, /--panel-theme "pink"/u);
  assert.doesNotThrow(() => parseHostArgs(info.args));
  assert.match(info.summary, /运行数据/u);
  assert.match(info.summary, /启动清理/u);
  await page.close();
});

test('生成器阻止全部表单清理请求和内联 JSON/shared settings 清理字段', async () => {
  const page = await openGenerator();
  const assertBlocked = async (label) => {
    const output = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      return {
        status: document.getElementById('status').textContent,
        outputs: ['powershell', 'cmd', 'json'].map((id) => document.getElementById(id).value),
        args: generator.commandFor(generator.state()).args,
        config: generator.configFor(generator.state())
      };
    });
    assert.match(output.status, /启动清理.*当前宿主不可执行/u, label);
    assert.deepEqual(output.outputs, ['', '', ''], label);
    assert.deepEqual(output.args, [], label);
    assert.equal(output.config, null, label);
  };
  for (const [id, value] of [
    ['wipeOnStart', true], ['wipePolicy', 'background'], ['wipeRetries', '6'],
    ['wipeDelay', '250'], ['wipeInterval', '45'], ['wipeRuntimeRetry', false]
  ]) {
    await page.click('#reset');
    await page.$eval(`#${id}`, (node, next) => {
      if (node.type === 'checkbox') node.checked = next;
      else node.value = next;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await assertBlocked(id);
  }
  for (const value of [
    { wipeOwnedFilesOnStart: true }, { wipeFailurePolicy: 'retry' }, { wipeRetries: 5 },
    { wipeRetryDelayMs: 200 }, { wipeRuntimeRetry: false }, { wipeRuntimeIntervalSec: 30 },
    { settings: { 'common.settings.windows-wipe-owned-files-on-start': true } },
    { settings: { 'common.settings.windows-wipe-runtime-retry': false } },
    { settings: { 'common.settings.windows-wipe-retries': 5 } }
  ]) {
    await page.click('#reset');
    await page.$eval('#optionsJson', (node, json) => {
      node.value = json;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, JSON.stringify(value));
    await assertBlocked(JSON.stringify(value));
  }
  await page.close();
});

test('生成器拒绝宿主范围以外的运行期清理间隔', async () => {
  const page = await openGenerator();
  for (const value of ['0', '86401']) {
    await page.$eval('#wipeInterval', (node, next) => {
      node.value = next;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    assert.match(await page.$eval('#status', (node) => node.textContent), /运行期重试间隔必须是 1 到 86400/u);
    assert.equal(await page.$eval('#powershell', (node) => node.value), '');
    assert.equal(await page.$eval('#json', (node) => node.value), '');
  }
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

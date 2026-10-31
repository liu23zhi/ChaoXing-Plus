import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join, resolve } from 'node:path';
import { applyHostOptionsToConfig, applyOptionsJsonToOptions, parseHostArgs } from '../windows/node-source/options.mjs';
import { normalizeConfig } from '../windows/node-source/config.mjs';
import { RENDER_DIAGNOSTICS_EXPRESSION } from '../windows/node-source/diagnostics.mjs';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
const generatorPath = resolve('windows/share-file/parameter-generator.html');
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

async function openGenerator(hostType = 'node', nativePath = 'C:\\Tools\\chaoxing_plus.exe') {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.goto(`file:///${generatorPath.replaceAll('\\', '/')}`);
  if (hostType) await page.select('#hostType', hostType);
  if (nativePath) {
    await page.$eval('#nativePath', (node, value) => {
      node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, nativePath);
  }
  return page;
}

test('生成器首次打开不预填原生 EXE 路径，填写后才生成命令', async () => {
  const page = await openGenerator(null, '');
  try {
    const empty = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      const state = generator.state();
      return {
        state, command: generator.commandFor(state), errors: generator.validate(state).errors,
        nodeHidden: document.getElementById('nodeLauncherField').hidden,
        nativeHidden: document.getElementById('nativeLauncherField').hidden,
        hideConsoleHidden: document.getElementById('hideConsoleField').hidden,
        outputs: ['powershell', 'cmd', 'json'].map((id) => document.getElementById(id).value)
      };
    });
    assert.equal(empty.state.hostType, 'native');
    assert.equal(empty.state.nativePath, '');
    assert.ok(empty.errors.some((error) => /请指定原生宿主 EXE/u.test(error)), JSON.stringify(empty.errors));
    assert.deepEqual(empty.command.args, []);
    assert.deepEqual(empty.outputs, ['', '', '']);
    assert.equal(empty.nodeHidden, true);
    assert.equal(empty.nativeHidden, false);
    assert.equal(empty.hideConsoleHidden, true);

    const selectedPath = 'D:\\学习助手\\chaoxing_plus.exe';
    await page.$eval('#nativePath', (node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, selectedPath);
    const filled = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      return { state: generator.state(), command: generator.commandFor(generator.state()) };
    });
    assert.equal(filled.state.nativePath, selectedPath);
    assert.match(filled.command.cmd, /chaoxing_plus\.exe/u);
    assert.match(filled.command.powershell, /chaoxing_plus\.exe/u);
    assert.doesNotMatch(filled.command.powershell, /node\.exe|main\.mjs|--hide-console/u);
  } finally { await page.close(); }
});
test('原生 EXE 路径支持文件选择器并在浏览器不暴露路径时给出提示', async () => {
  const page = await openGenerator(null, '');
  try {
    assert.equal(await page.$('#pickNativeExe') !== null, true);
    const fallback = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      const applied = generator.applyNativeFile({ name: 'chaoxing_plus.exe' });
      return { applied, path: document.getElementById('nativePath').value, hint: document.getElementById('nativePickHint').textContent,
        outputs: ['powershell', 'cmd', 'json'].map((id) => document.getElementById(id).value) };
    });
    assert.equal(fallback.applied, false);
    assert.equal(fallback.path, '');
    assert.match(fallback.hint, /未提供完整路径/u);
    assert.deepEqual(fallback.outputs, ['', '', '']);

    const withPath = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      const applied = generator.applyNativeFile({ name: 'chaoxing_plus.exe', path: 'E:\\Tools\\chaoxing_plus.exe' });
      return { applied, path: document.getElementById('nativePath').value, cmd: document.getElementById('cmd').value };
    });
    assert.equal(withPath.applied, true);
    assert.equal(withPath.path, 'E:\\Tools\\chaoxing_plus.exe');
    assert.match(withPath.cmd, /chaoxing_plus\.exe/u);
  } finally { await page.close(); }
});

test('nativePath 查询参数可预填 EXE 路径', async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const selected = 'D:\\便携工具\\chaoxing_plus.exe';
  await page.goto(`file:///${generatorPath.replaceAll('\\', '/')}?nativePath=${encodeURIComponent(selected)}`);
  try {
    assert.equal(await page.$eval('#nativePath', (node) => node.value), selected);
    assert.match(await page.$eval('#cmd', (node) => node.value), /chaoxing_plus\.exe/u);
  } finally { await page.close(); }
});

test('原生路径由用户填写，预设与重置保留，Node 兼容入口仍可切换', async () => {
  const page = await openGenerator(null, '');
  try {
    assert.equal(await page.$eval('#nativePath', (node) => node.value), '');
    assert.equal(await page.$eval('#powershell', (node) => node.value), '');
    const selectedPath = 'D:\\学习助手\\chaoxing_plus.exe';
    await page.$eval('#nativePath', (node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, selectedPath);
    await page.click('[data-preset="friendly"]');
    await page.click('#reset');
    assert.equal(await page.$eval('#hostType', (node) => node.value), 'native');
    assert.equal(await page.$eval('#nativePath', (node) => node.value), selectedPath);
    assert.match(await page.$eval('#cmd', (node) => node.value), /chaoxing_plus\.exe/u);
    await page.select('#hostType', 'node');
    assert.equal(await page.$eval('#hideConsoleField', (node) => node.hidden), false);
    assert.equal(await page.$eval('#dataDir', (node) => node.value), 'windows\\data');
    assert.match(await page.$eval('#hostType option[value="node"]', (node) => node.textContent), /已冻结/u);
    assert.match(await page.$eval('#cmd', (node) => node.value), /node\.exe/u);
  } finally { await page.close(); }
});
test('切换回原生时清除隐藏的 Node 控制台开关，不阻断原生命令', async () => {
  const page = await openGenerator('node');
  try {
    await page.click('[data-preset="silent"]');
    assert.equal(await page.$eval('#hideConsole', (node) => node.checked), true);
    await page.select('#hostType', 'native');
    assert.equal(await page.$eval('#hideConsoleField', (node) => node.hidden), true);
    assert.equal(await page.$eval('#hideConsole', (node) => node.checked), false);
    assert.ok(await page.$eval('#powershell', (node) => node.value));
    assert.doesNotMatch(await page.$eval('#powershell', (node) => node.value), /--hide-console/u);
  } finally { await page.close(); }
});

test('原生默认诊断目录跟随数据目录，手动指定诊断路径后保留输入', async () => {
  const page = await openGenerator(null);
  try {
    const enter = (selector, value) => page.$eval(selector, (node, text) => { node.value = text; node.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    await enter('#dataDir', 'D:\\测试数据');
    assert.equal(await page.$eval('#diagnosticsDir', (node) => node.value), 'D:\\测试数据\\chaoxing\\diagnostics');
    assert.doesNotMatch(await page.$eval('#powershell', (node) => node.value), /--diagnostics-dir/u);
    await enter('#diagnosticsDir', 'D:\\独立诊断');
    await enter('#dataDir', 'D:\\新的数据');
    assert.equal(await page.$eval('#diagnosticsDir', (node) => node.value), 'D:\\独立诊断');
    assert.match(await page.$eval('#powershell', (node) => node.value), /--diagnostics-dir/u);
    await page.select('#hostType', 'node');
    assert.equal(await page.$eval('#diagnosticsDir', (node) => node.value), 'D:\\独立诊断');
  } finally { await page.close(); }
});

test('原生未完成的注入方式禁用且不能绕过校验生成命令或 JSON', async () => {
  const page = await openGenerator(null);
  try {
    for (const mode of ['cdp-pipe', 'input']) {
      assert.equal(await page.$eval(`#injectMode option[value="${mode}"]`, (node) => node.disabled), true);
      const output = await page.evaluate((injectMode) => {
        const generator = window.__CX_PARAMETER_GENERATOR__;
        const state = { ...generator.state(), injectMode };
        return { errors: generator.validate(state).errors, command: generator.commandFor(state), config: generator.configFor(state) };
      }, mode);
      assert.match(output.errors.join(' '), /cdp-pipe.*input/u);
      assert.equal(output.command.powershell, '');
      assert.equal(output.command.cmd, '');
      assert.equal(output.config, null);
    }
    for (const injectMode of ['auto', 'cdp-pipe', 'input', 'dll-proxy']) {
      const loaded = await page.evaluate((injectMode) => window.__CX_PARAMETER_GENERATOR__.applyLoadedConfig({ injectMode }), injectMode);
      assert.deepEqual(loaded.applied, [], injectMode);
      assert.deepEqual(loaded.ignored, ['injectMode'], injectMode);
    }
  } finally { await page.close(); }
});

test('两种宿主均可选择启动时申请管理员权限，默认按需申请', async () => {
  const page = await openGenerator();
  try {
    assert.equal(await page.$eval('#elevateOnStart', (node) => node.checked), false);
    for (const hostType of ['node', 'native']) {
      const output = await page.evaluate((hostType) => {
        const generator = window.__CX_PARAMETER_GENERATOR__;
        const state = { ...generator.state(), hostType, nativePath: 'C:\\Tools\\chaoxing_plus.exe', elevateOnStart: true };
        return { errors: generator.validate(state).errors, args: generator.commandFor(state).args, config: generator.configFor(state) };
      }, hostType);
      assert.deepEqual(output.errors, [], hostType);
      assert.ok(output.args.includes('--elevate-on-start'), hostType);
      assert.equal(output.config.elevateOnStart, true);
      if (hostType === 'node') assert.equal(parseHostArgs(output.args).elevateOnStart, true);
    }
    const conflicts = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      return [
        { elevateOnStart: true, optionsJson: '{"noElevate":true}' },
        { elevateOnStart: false, optionsJson: '{"noElevate":true,"elevateOnStart":true}' },
        { elevateOnStart: false, optionsJson: '{"noElevate":"true"}' }
      ].map((change) => generator.validate({ ...generator.state(), ...change }).errors);
    });
    assert.match(conflicts[0].join(' '), /elevate-on-start.*no-elevate/u);
    assert.match(conflicts[1].join(' '), /elevate-on-start.*no-elevate/u);
    assert.match(conflicts[2].join(' '), /noElevate.*布尔值/u);
  } finally { await page.close(); }
});

test('两种宿主均可生成方向键规范名称和兼容别名', async () => {
  const page = await openGenerator();
  try {
    for (const hostType of ['node', 'native']) {
      await page.select('#hostType', hostType);
      for (const direction of ['Up', 'Down', 'Left', 'Right']) {
        for (const key of [direction, `Arrow${direction}`]) {
          const output = await page.evaluate((answerKey) => {
            const generator = window.__CX_PARAMETER_GENERATOR__;
            const state = { ...generator.state(), nativePath: 'C:\\Tools\\chaoxing_plus.exe', answerKey };
            return { errors: generator.validate(state).errors, command: generator.commandFor(state) };
          }, `Ctrl+${key}`);
          assert.deepEqual(output.errors, [], `${hostType}: ${key}`);
          assert.ok(output.command.args.includes(`Ctrl+${key}`), `${hostType}: ${key}`);
          if (hostType === 'node') assert.equal(parseHostArgs(output.command.args).answerKey, `Ctrl+${key}`);
        }
      }
    }
  } finally { await page.close(); }
});

test('两种宿主的内联 JSON 均遵守 CEF75 启动端口边界', async () => {
  const page = await openGenerator();
  try {
    for (const hostType of ['node', 'native']) {
      for (const port of [0, 1024, 9333, 65534, 1, 1023, 65535]) {
        const result = await page.evaluate(({ hostType, port }) => {
          const generator = window.__CX_PARAMETER_GENERATOR__;
          const state = { ...generator.state(), hostType, nativePath: 'C:\\Tools\\chaoxing_plus.exe', optionsJson: JSON.stringify({ port }) };
          return generator.validate(state);
        }, { hostType, port });
        if (port === 0 || (port >= 1024 && port <= 65534)) assert.deepEqual(result.errors, [], `${hostType}: ${port}`);
        else assert.ok(result.errors.some((error) => /1024.*65534/u.test(error)), `${hostType}: ${port}: ${result.errors}`);
      }
    }
  } finally { await page.close(); }
});

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
  assert.equal(await page.$eval('#retainData', (node) => node.disabled), false);
  assert.equal(await page.$eval('#deleteConfig', (node) => node.disabled), false);
  await page.close();
});

test('原生模式导出数据生命周期参数，并拒绝无效 EXE 路径、小数面板与未知 JSON 字段', async () => {
  const page = await openGenerator();
  await page.select('#hostType', 'native');
  for (const nativePath of ['chaoxing_plus.exe', 'C:chaoxing_plus.exe', '\\Tools\\chaoxing_plus.exe', 'C:\\Tools\\main.mjs']) {
    await page.$eval('#nativePath', (node, path) => { node.value = path; node.dispatchEvent(new Event('input', { bubbles: true })); }, nativePath);
    assert.equal(await page.$eval('#powershell', (node) => node.value), '', nativePath);
  }
  await page.$eval('#nativePath', (node) => { node.value = 'C:\\Tools\\chaoxing_plus.exe'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  for (const optionsJson of ['{"unknown":true}', '{"panelTop":1.5}', '{"answerKey":"Ctrl+Ctrl+A"}', '{"settings":{"common.settings.windows-panel-enabled":"true"}}', '{"settings":{"common.settings.extension-enabled":"true"}}', '{"dpiAware":true,"settings":{"common.settings.windows-no-disk-write":true}}']) {
    await page.$eval('#optionsJson', (node, text) => { node.value = text; node.dispatchEvent(new Event('input', { bubbles: true })); }, optionsJson);
    assert.equal(await page.$eval('#powershell', (node) => node.value), '', optionsJson);
    assert.equal(await page.$eval('#json', (node) => node.value), '', optionsJson);
  }

  // 原生宿主现已支持数据生命周期：retainData=false 可直接导出；deleteConfig 需要 --config。
  await page.$eval('#optionsJson', (node) => { node.value = '{"retainData":false}'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await page.$eval('#powershell', (node) => node.value), /--no-retain-data|retainData/u);
  await page.$eval('#optionsJson', (node) => { node.value = '{"deleteConfig":true}'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  await page.$eval('#configPath', (node) => { node.value = 'C:\\Tools\\chaoxing-plus.json'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('#optionsJson', (node) => { node.value = '{"deleteConfig":true}'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await page.$eval('#powershell', (node) => node.value), /--delete-config|deleteConfig/u);

  await page.$eval('#optionsJson', (node) => { node.value = ''; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('#panelTop', (node) => { node.value = '1.5'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  await page.close();
});

test('切换宿主保留已有清理请求与自定义数据目录', async () => {
  const page = await openGenerator();
  await page.evaluate(() => {
    document.getElementById('retainData').checked = false;
    document.getElementById('dataDir').value = 'D:\\自定义缓存';
  });
  await page.select('#hostType', 'native');
  await page.$eval('#nativePath', (node) => { node.value = 'C:\\Tools\\chaoxing_plus.exe'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$eval('#dataDir', (node) => node.value), 'D:\\自定义缓存');
  // 原生宿主现在也支持 --no-retain-data，因此切换后仍能导出而不是静默丢弃请求。
  assert.match(await page.$eval('#powershell', (node) => node.value), /--no-retain-data/u);
  assert.doesNotMatch(await page.$eval('#status', (node) => node.textContent), /当前不可执行/u);
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
      await page.select('#injectMode', 'cdp-port');
      const output = await page.evaluate(() => {
        const generator = window.__CX_PARAMETER_GENERATOR__;
        return { ...generator.commandFor(generator.state()), json: document.getElementById('json').value };
      });
      assert.ok(output.json, preset);
      if (preset === 'silent') assert.equal(output.args.includes('--hide-console'), false, '原生宿主不应生成 --hide-console');
      for (const args of [output.args, ['--options-json', output.json]]) {
        const result = spawnSync(process.env.CX_NATIVE_HOST_EXE, [...args, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${preset}\n${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /0\.1\.0/u);
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
    await page.$eval('#nativePath', (node) => { node.value = ''; node.dispatchEvent(new Event('input', { bubbles: true })); });
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
  assert.equal(launcherPath.replaceAll('\\', '/'), `${resolve('.').replaceAll('\\', '/')}/windows/node-source/main.mjs`);
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
      assert.equal(output.args.includes('--hide-console'), true, 'silent 预设应为 Node 宿主隐藏控制台');
      assert.equal('hideConsole' in output.json, false, '宿主 JSON schema 不接受 hideConsole，只能通过 CLI 传递');
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
  assert.equal(await page.$eval('#selfDestructKey', (node) => node.disabled), false);
  for (const id of ['wipeOnStart', 'wipePolicy', 'wipeRetries', 'wipeDelay', 'wipeInterval', 'wipeRuntimeRetry']) {
    assert.equal(await page.$eval(`#${id}`, (node) => node.disabled), false, id);
  }
  const output = await page.$eval('#powershell', (node) => node.value + document.querySelector('#cmd').value + document.querySelector('#json').value);
  assert.match(output, /--answer-mode/u);
  assert.doesNotMatch(output, /--(?:wipe|self-destruct|memory-exec|delete-suspend)/iu);
  await page.click('[data-preset="startupClean"]');
  assert.doesNotMatch(await page.$eval('#status', (node) => node.textContent), /无法生成/u);
  assert.match(await page.$eval('#powershell', (node) => node.value), /--wipe-owned-files-on-start/u);
  assert.match(await page.$eval('#summary', (node) => node.textContent), /启动清理.*retry/u);
  const blocked = await page.evaluate(() => {
    const generator = window.__CX_PARAMETER_GENERATOR__;
    return {
      outputs: ['powershell', 'cmd', 'json'].map((id) => document.getElementById(id).value),
      command: generator.commandFor(generator.state()),
      config: generator.configFor(generator.state()),
      capabilityBlocked: generator.capabilityBlocked()
    };
  });
  assert.ok(blocked.outputs.every((value) => value.length > 0));
  assert.match(blocked.command.powershell, /--wipe-owned-files-on-start/u);
  assert.ok(blocked.command.args.includes('--wipe-owned-files-on-start'));
  assert.notEqual(blocked.config, null);
  assert.equal(blocked.capabilityBlocked, false);
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
  await page.$eval('#launcherPath', (node) => { node.value = "C:\\Tools\\O'Brien&Co\\windows\\node-source\\main.mjs"; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await page.$eval('#powershell', (node) => node.value), /C:\\Tools\\O''Brien&Co\\windows\\node-source\\main\.mjs/u);
  assert.equal(await page.$eval('#cmd', (node) => node.value), '');
  assert.match(await page.$eval('#status', (node) => node.textContent), /cmd 输出不可安全表示/u);
  await page.close();
});

test('生成器拒绝相对、驱动器相对和仅根目录相对的 Node 宿主路径', async () => {
  const page = await openGenerator();
  for (const launcherPath of [
    'chaoxing_plus\\windows\\node-source\\main.mjs', '.\\windows\\node-source\\main.mjs',
    '..\\chaoxing_plus\\windows\\node-source\\main.mjs', 'C:chaoxing_plus\\windows\\node-source\\main.mjs',
    '\\chaoxing_plus\\windows\\node-source\\main.mjs', '/chaoxing_plus/windows/node-source/main.mjs',
    '\\\\server\\windows\\node-source\\main.mjs', '\\\\server\\\\windows\\node-source\\main.mjs'
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
    'C:\\Tools\\chaoxing_plus\\windows\\node-source\\main.mjs',
    'C:/学习助手/windows/node-source/main.mjs', 'Z:\\windows\\node-source\\main.mjs',
    '\\\\server\\share\\学习助手\\windows\\node-source\\main.mjs', '//server/share/windows/node-source/main.mjs'
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
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  await dispatch('answerKey', "node.value = 'F8';");
  assert.doesNotMatch(await page.$eval('#status', (node) => node.textContent), /无法生成/u);
  assert.match(await page.$eval('#powershell', (node) => node.value), /--self-destruct-key/u);

  // 内存执行需要零落盘：默认开启日志时阻止生成。
  await page.click('#reset');
  await dispatch('executionMode', "node.value = 'memory';");
  assert.match(await page.$eval('#status', (node) => node.textContent), /零落盘/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');

  // 关闭日志/诊断并清空报告后，内存执行生成普通可见启动的零落盘命令与 JSON。
  await dispatch('log', 'node.checked = false;');
  await dispatch('executionMode', "node.value = 'memory';");
  assert.doesNotMatch(await page.$eval('#status', (node) => node.textContent), /无法生成/u);
  assert.match(await page.$eval('#powershell', (node) => node.value), /--execution-mode "memory"/u);
  assert.match(await page.$eval('#powershell', (node) => node.value), /--no-disk-write/u);
  const memoryConfig = JSON.parse(await page.$eval('#json', (node) => node.value));
  assert.equal(memoryConfig.executionMode, 'memory');
  assert.equal(memoryConfig.noDiskWrite, true);

  // 删除挂起与自毁已可导出。
  await page.click('#reset');
  assert.match(await page.$eval('#exportCapabilityHint', (node) => node.textContent), /删除挂起|自毁/u);
  await dispatch('executionMode', "node.value = 'delete-suspend';");
  await dispatch('log', 'node.checked = false;');
  assert.match(await page.$eval('#powershell', (node) => node.value), /--execution-mode "delete-suspend"/u);
  await page.close();
});

test('生成器可加载 config 文件并回填表单、命令与 JSON', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-generator-load-'));
  const page = await openGenerator();
  try {
    const configPath = path.join(directory, 'chaoxing-plus.json');
    await writeFile(configPath, JSON.stringify({
      clientPath: 'D:\\Exam\\CXExam.exe',
      scanMode: 'common',
      executionMode: 'memory',
      logFileEnabled: false,
      diagnose: false,
      panelWidth: 520,
      answerKey: 'Ctrl+Alt+Shift+S',
      answerThreads: 1,
      showAnswerDialog: false,
      settings: {
        'common.settings.windows-panel-width': 600,
        'common.settings.windows-panel-theme': 'blue',
        'common.settings.windows-answer-key': 'Ctrl+Alt+Shift+S',
        'common.settings.windows-answer-threads': 1,
        'common.settings.windows-show-answer-dialog': false,
        'common.settings.windows-no-disk-write': true,
        'common.settings.windows-log-enabled': false,
        'common.settings.unknown-key': 'keep-out-of-form'
      }
    }, null, 2), 'utf8');
    const input = await page.$('#configFile');
    await input.uploadFile(configPath);
    await page.evaluate(() => document.querySelector('#configFile').dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForFunction(() => document.querySelector('#loadStatus').textContent.includes('已加载配置'), { timeout: 6000 });
    assert.equal(await page.$eval('#clientPath', (node) => node.value), 'D:\\Exam\\CXExam.exe');
    assert.equal(await page.$eval('#executionMode', (node) => node.value), 'memory');
    assert.equal(await page.$eval('#scanMode', (node) => node.value), 'common');
    assert.equal(await page.$eval('#panelWidth', (node) => node.value), '600');
    assert.equal(await page.$eval('#panelTheme', (node) => node.value), 'blue');
    assert.equal(await page.$eval('#answerKey', (node) => node.value), 'Ctrl+Alt+Shift+S');
    assert.equal(await page.$eval('#answerThreads', (node) => node.value), '1');
    assert.equal(await page.$eval('#showAnswerDialog', (node) => node.checked), false);
    assert.equal(await page.$eval('#noDiskWrite', (node) => node.checked), true);
    assert.equal(await page.$eval('#log', (node) => node.checked), false);
    assert.match(await page.$eval('#loadStatus', (node) => node.textContent), /忽略/u);
    const generated = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      const state = generator.state();
      return { args: generator.commandFor(state).args, config: generator.configFor(state) };
    });
    for (const expected of ['--client', 'D:\\Exam\\CXExam.exe', '--execution-mode', 'memory', '--no-disk-write', '--no-log']) {
      assert.equal(generated.args.includes(expected), true, `missing generated argument ${expected}`);
    }
    assert.equal(generated.config.executionMode, 'memory');
    assert.equal(generated.config.noDiskWrite, true);

    const badPath = path.join(directory, 'bad.json');
    await writeFile(badPath, '{not json', 'utf8');
    const badInput = await page.$('#configFile');
    await badInput.uploadFile(badPath);
    await page.evaluate(() => document.querySelector('#configFile').dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForFunction(() => document.querySelector('#loadStatus').textContent.includes('加载失败'), { timeout: 6000 });
  } finally {
    await page.close();
    await rm(directory, { recursive: true, force: true });
  }
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
    ['{"wipeRetries":21}', /1 到 20/u],
    ['{"wipeFailurePolicy":"stop"}', /retry|background|ignore|abort/u]
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
  assert.doesNotMatch(await page.$eval('#status', (node) => node.textContent), /无法生成/u);
  const inlineWipe = JSON.parse(await page.$eval('#json', (node) => node.value));
  assert.equal(inlineWipe.wipeOwnedFilesOnStart, true);

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
  await setField('selfDestructKey', "node.value = 'Ctrl+ArrowUp';");
  await setField('answerKey', "node.value = 'Ctrl+Up';");
  assert.match(await page.$eval('#status', (node) => node.textContent), /不能与自毁快捷键相同/u);
  await page.click('#reset');

  await page.click('[data-preset="startupClean"]');
  assert.match(await page.$eval('#powershell', (node) => node.value), /--wipe-owned-files-on-start/u);
  await setField('quiet', 'node.checked = false;');
  assert.match(await page.$eval('#powershell', (node) => node.value), /--wipe-owned-files-on-start/u);
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

  await setField('panelTheme', "node.value = 'blue';");
  assert.match(await page.$eval('#powershell', (node) => node.value), /--panel-theme "blue"/u);
  assert.equal(JSON.parse(await page.$eval('#json', (node) => node.value)).settings['common.settings.windows-panel-theme'], 'blue');
  await setField('panelTheme', "node.value = 'purple';");
  assert.match(await page.$eval('#status', (node) => node.textContent), /面板主题只支持/u);
  assert.equal(await page.$eval('#powershell', (node) => node.value), '');
  const builtInThemes = await page.$$eval('#panelThemeList option', (nodes) => nodes.map((node) => node.value));
  assert.deepEqual(builtInThemes, ['pink', 'blue', 'green']);
  await page.close();
});

test('生成器导出表单清理与自毁参数，并拒绝 shared settings 清理字段', async () => {
  const page = await openGenerator();
  const setField = (id, source) => page.evaluate((selector, script) => {
    const node = document.querySelector(selector);
    Function('node', script)(node);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, `#${id}`, source);
  await setField('wipeOnStart', 'node.checked = true;');
  await setField('wipePolicy', "node.value = 'background';");
  await setField('selfDestructKey', "node.value = 'Ctrl+Shift+E';");
  await setField('selfDestructOnFullscreenExit', 'node.checked = true;');
  const exported = await page.evaluate(() => {
    const generator = window.__CX_PARAMETER_GENERATOR__;
    return { args: generator.commandFor(generator.state()).args, config: generator.configFor(generator.state()) };
  });
  for (const flag of ['--wipe-owned-files-on-start', '--wipe-failure-policy', '--self-destruct-key', '--self-destruct-on-fullscreen-exit']) {
    assert.ok(exported.args.includes(flag), flag);
  }
  assert.equal(exported.config.wipeOwnedFilesOnStart, true);
  assert.deepEqual(exported.config.selfDestructKeys, ['Ctrl+Shift+E']);

  for (const value of [
    { settings: { 'common.settings.windows-wipe-owned-files-on-start': true } },
    { settings: { 'common.settings.windows-wipe-runtime-retry': false } },
    { settings: { 'common.settings.windows-self-destruct-key': 'F8' } }
  ]) {
    await page.click('#reset');
    await setField('optionsJson', `node.value = ${JSON.stringify(JSON.stringify(value))};`);
    assert.match(await page.$eval('#status', (node) => node.textContent), /shared settings|启动清理|自毁/u);
    assert.equal(await page.$eval('#powershell', (node) => node.value), '');
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
  const html = await readFile(new URL('../windows/share-file/parameter-generator.html', import.meta.url), 'utf8');
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

test('两种宿主可导出 --dpi-aware 与 Node 静默控制台，原生宿主拒绝无控制台参数', async () => {
  const page = await openGenerator();
  try {
    const defaults = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      return { dpiAware: generator.state().dpiAware, hideConsole: generator.state().hideConsole };
    });
    assert.equal(defaults.dpiAware, false);
    assert.equal(defaults.hideConsole, false);
    const outputs = await page.evaluate(() => {
      const generator = window.__CX_PARAMETER_GENERATOR__;
      function run(hostType, change) {
        const state = {
          ...generator.state(), hostType,
          launcherPath: 'C:\\Tools\\windows\\node-source\\main.mjs',
          nativePath: 'C:\\Tools\\chaoxing_plus.exe',
          ...change
        };
        return { errors: generator.validate(state).errors, args: generator.commandFor(state).args, config: generator.configFor(state) };
      }
      return {
        node: run('node', { dpiAware: true, hideConsole: true }),
        native: run('native', { dpiAware: true }),
        nativeHide: run('native', { hideConsole: true }),
        nativeNoDisk: run('native', { dpiAware: true, noDiskWrite: true })
      };
    });
    assert.deepEqual(outputs.node.errors, []);
    assert.ok(outputs.node.args.includes('--dpi-aware'));
    assert.ok(outputs.node.args.includes('--hide-console'));
    assert.equal(outputs.node.config.dpiAware, true);
    assert.equal(Object.prototype.hasOwnProperty.call(outputs.node.config, 'hideConsole'), false,
      'hide-console must stay CLI-only because the host JSON schema does not accept it');
    assert.deepEqual(outputs.native.errors, []);
    assert.ok(outputs.native.args.includes('--dpi-aware'));
    assert.equal(outputs.native.config.dpiAware, true);
    assert.match(outputs.nativeHide.errors.join(' '), /hide-console/u);
    assert.match(outputs.nativeNoDisk.errors.join(' '), /dpi-aware.*no-disk-write/u);
    assert.equal(parseHostArgs(outputs.node.args).dpiAware, true);
    assert.equal(parseHostArgs(outputs.node.args).hideConsole, true);
    const hints = await page.evaluate(() => document.body.textContent);
    assert.equal(hints.includes('原生诊断仅提供页面布局采样'), false, 'stale native diagnostics hint must be gone');
    assert.match(hints, /页面 PNG/u);
  } finally { await page.close(); }
});
test('注入方式只在原生宿主导出，auto 不输出该参数', async () => {
  const page = await openGenerator();
  try {
    await page.select('#hostType', 'native');
    await page.$eval('#nativePath', (node, p) => { node.value = p; node.dispatchEvent(new Event('input', { bubbles: true })); }, resolve('windows/native-build/bin/chaoxing_plus.exe'));
    const autoCli = await page.$eval('#powershell', (node) => node.value);
    assert.equal(autoCli.length > 0, true, '原生宿主应生成命令');
    assert.equal(autoCli.includes('--inject-mode'), false, 'auto 为默认值，不应输出');
    await page.select('#injectMode', 'cdp-port');
    const portCli = await page.$eval('#powershell', (node) => node.value);
    assert.equal(portCli.includes('--inject-mode'), true, '应导出 --inject-mode');
    assert.equal(portCli.includes('cdp-port'), true, '应导出值 cdp-port');
    assert.equal(JSON.parse(await page.$eval('#json', (node) => node.value)).injectMode, 'cdp-port', 'JSON 与 CLI 必须保留相同的显式注入方式');
    const loaded = await page.evaluate(() => window.__CX_PARAMETER_GENERATOR__.applyLoadedConfig({ injectMode: 'cdp-port' }));
    assert.ok(loaded.applied.includes('injectMode'));
    assert.equal(await page.$eval('#injectMode', (node) => node.value), 'cdp-port');
    await page.click('#reset');
    assert.equal(await page.$eval('#injectMode', (node) => node.value), 'auto', '重置恢复沿用宿主默认');
    await page.select('#injectMode', 'cdp-port');
    await page.select('#hostType', 'node');
    const nodeCli = await page.$eval('#powershell', (node) => node.value);
    assert.equal(nodeCli.includes('--inject-mode'), false, 'Node 宿主不输出该参数');
  } finally { await page.close(); }
});



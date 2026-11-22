import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from '@typescript/typescript6';
import { withMinimalDom } from './test-helpers/minimal-dom.mjs';

const source = await readFile(new URL('../src/projects/common.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('common.ts', source, ts.ScriptTarget.Latest, true);
const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node)
  && ['createElement', 'createTikuAdapterConfigSection'].includes(node.name?.text));
assert.equal(functions.length, 2);
const code = ts.transpileModule(functions.map(node => node.getText(parsed)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
}).outputText;

function createSection(document, probe) {
  const modals = [];
  const saved = {};
  const events = [];
  const deps = {
    document,
    getStoredTikuAdapterConfig: () => ({ baseurl: 'https://adapter.example', key: 'test-key' }),
    panelPinkTheme: new Proxy({}, { get: () => '#123456' }),
    applySectionCardStyle() {}, applySectionTitleStyle() {}, applyHintTextStyle() {},
    applyControlChrome() {}, applyActionButtonStyle() {},
    isWindowsHostRuntime: () => false,
    DEFAULT_TIKU_BASE_URL: 'https://adapter.example',
    resolveTikuAdapterBaseUrl: (raw, fallback) => String(raw ?? '').trim() || fallback,
    testTikuAdapterConfig: probe,
    TIKU_ADAPTER_BASEURL_KEY: 'baseurl', TIKU_ADAPTER_KEY_KEY: 'key',
    setRuntimeStoreValueFromPanel: (key, value) => { saved[key] = value; events.push(key); },
    mountServiceStatusHttpFetcher: () => events.push('mount'),
    $modal: { alert: async value => modals.push(value) },
  };
  const factory = new Function(...Object.keys(deps), `${code}\nreturn createTikuAdapterConfigSection();`);
  const root = factory(...Object.values(deps));
  return { root, modals, saved, events,
    saveButton: root.querySelectorAll('button').find(button => button.textContent === '保存'),
    testButton: root.querySelectorAll('button').find(button => button.textContent === '测试') };
}

test('题库配置测试结果直接展示在按钮下方，不弹窗', async () => {
  await withMinimalDom(async document => {
    for (const [state, message] of [
      ['ok', /访问令牌有效/], ['invalid-key', /访问令牌无效/],
      ['rate-limited', /校验过于频繁/], ['server-error', /无法连接服务器/],
      ['device-limit-exceeded', /设备数量已达上限/]
    ]) {
      const { root, modals, testButton } = createSection(document, async () => ({ state, httpStatus: state === 'invalid-key' ? 401 : undefined }));
      await testButton.onclick();
      const result = root.querySelector('[data-cx-tiku-test-result]');
      assert.ok(result, '测试结果需要有独立的行内区域');
      assert.equal(result.hidden, false);
      assert.match(result.textContent, message);
      assert.equal(result.getAttribute('role'), 'status');
      assert.deepEqual(modals, []);
      assert.equal(root.children.at(-1), result, '结果显示在配置操作区下方');
    }
  });
});

test('配置说明告知默认地址行为和令牌获取入口', async () => {
  await withMinimalDom(async document => {
    const { root } = createSection(document, async () => ({ state: 'ok' }));
    assert.match(root.textContentAll, /题库地址留空会恢复默认地址/);
    assert.match(root.textContentAll, /访问令牌.*创建或获取/);
  });
});

test('保存后测试异常仍保留已保存配置，并显示测试失败提示', async () => {
  await withMinimalDom(async document => {
    const section = createSection(document, async () => { throw new Error('probe unavailable'); });
    await section.saveButton.onclick();
    assert.deepEqual(section.saved, { baseurl: 'https://adapter.example', key: 'test-key' });
    assert.equal(section.modals[0].icon, 'warning');
    assert.match(section.modals[0].content, /题库配置已保存。.*测试未完成/s);
    assert.equal(section.root.querySelector('[data-cx-tiku-test-result]').textContent, '测试未完成，请稍后重试。');
    assert.equal(section.saveButton.disabled, false);
    assert.equal(section.testButton.disabled, false);
  });
});

test('已绑定本机可继续使用时，保存结果单独提醒绑定数量超过上限', async () => {
  await withMinimalDom(async document => {
    const section = createSection(document, async () => ({ state: 'ok', latencyMs: 12, deviceLimit: 1, deviceUsed: 2 }));
    await section.saveButton.onclick();
    const inline = section.root.querySelector('[data-cx-tiku-test-result]');
    assert.match(inline.textContent, /访问令牌有效/);
    assert.match(inline.textContent, /已绑定 2 台.*超过.*上限 1 台/);
    assert.match(inline.textContent, /本机可继续使用.*新设备/);
    assert.equal(section.modals[0].icon, 'warning');
    assert.ok(section.modals[0].content.includes(inline.textContent));
  });
});

test('保存非空配置后自动测试，并将同一结果显示在弹窗和配置区下方', async () => {
  await withMinimalDom(async document => {
    for (const state of ['ok', 'invalid-key', 'device-limit-exceeded', 'rate-limited', 'server-error']) {
      let calls = 0;
      const section = createSection(document, async config => {
        calls += 1;
        assert.deepEqual(section.saved, { baseurl: 'https://saved.example', key: 'saved-key' });
        assert.deepEqual(section.events, ['baseurl', 'key', 'mount']);
        assert.deepEqual(config, { baseurl: 'https://saved.example', key: 'saved-key', scriptIdentity: undefined });
        return { state, httpStatus: state === 'ok' ? 200 : 403, deviceLimit: 2, deviceUsed: 2 };
      });
      const [address, key] = section.root.querySelectorAll('input');
      address.value = ' https://saved.example ';
      key.value = ' saved-key ';
      await section.saveButton.onclick();
      assert.equal(calls, 1);
      assert.equal(section.modals.length, 1);
      assert.ok(section.modals[0].content.startsWith('题库配置已保存。'));
      const inline = section.root.querySelector('[data-cx-tiku-test-result]');
      assert.equal(inline.hidden, false);
      assert.ok(section.modals[0].content.includes(inline.textContent));
      assert.equal(section.modals[0].icon, state === 'ok' ? 'success' : 'warning');
      if (state === 'device-limit-exceeded') assert.match(inline.textContent, /已用 2 台.*上限 2 台/);
    }
  });
});

test('保存空地址时恢复默认地址并继续测试，空令牌时只保存不发请求', async () => {
  await withMinimalDom(async document => {
    for (const [values, expectedBaseurl, expectedCalls] of [
      [['', 'key'], 'https://adapter.example', 1],
      [['https://adapter.example', ''], 'https://adapter.example', 0],
      [[' ', ' '], 'https://adapter.example', 0]
    ]) {
      let calls = 0;
      const { root, saveButton, modals, saved } = createSection(document, async config => {
        calls += 1;
        assert.equal(config.baseurl, expectedBaseurl);
        return { state: 'ok' };
      });
      root.querySelectorAll('input').forEach((input, i) => { input.value = values[i]; });
      await saveButton.onclick();
      assert.deepEqual(saved, { baseurl: expectedBaseurl, key: values[1].trim() });
      assert.equal(calls, expectedCalls);
      if (values[1].trim()) {
        assert.match(modals[0].content, /连接测试结果/);
        if (!values[0].trim()) {
          assert.equal(root.querySelectorAll('input')[0].value, expectedBaseurl);
          assert.match(modals[0].content, /已恢复默认题库地址/);
        }
      } else {
        assert.equal(modals[0].icon, 'warning');
        assert.match(modals[0].content, /未填写访问令牌/);
        assert.match(modals[0].content, /adapter\/access-tokens/);
      }
    }
  });
});

test('测试时令牌为空仍显示行内缺失提示，并弹窗引导获取令牌', async () => {
  await withMinimalDom(async document => {
    let calls = 0;
    const { root, testButton, modals } = createSection(document, async () => { calls += 1; return { state: 'ok' }; });
    root.querySelectorAll('input')[1].value = '';
    await testButton.onclick();
    assert.equal(calls, 0, '令牌为空不得请求服务器');
    assert.match(root.querySelector('[data-cx-tiku-test-result]').textContent, /请先填写访问令牌/);
    assert.equal(modals.length, 1);
    assert.match(modals[0].content, /获取令牌/);
    assert.match(modals[0].content, /adapter\/access-tokens/);
  });
});

test('保存测试进行中防止重复测试，并且输入变化后不把旧结果写入配置区', async () => {
  await withMinimalDom(async document => {
    let release;
    let calls = 0;
    const section = createSection(document, () => {
      calls += 1;
      return new Promise(resolve => { release = resolve; });
    });
    const pending = section.saveButton.onclick();
    assert.equal(section.saveButton.disabled, true);
    assert.equal(section.testButton.disabled, true);
    await section.saveButton.onclick();
    await section.testButton.onclick();
    assert.equal(calls, 1);
    const address = section.root.querySelectorAll('input')[0];
    address.value = 'https://edited.example';
    address.oninput();
    release({ state: 'ok' });
    await pending;
    assert.equal(section.root.querySelector('[data-cx-tiku-test-result]').hidden, true);
    assert.equal(section.modals.length, 1, '弹窗仍报告已经保存的配置的测试结果');
    assert.match(section.modals[0].content, /访问令牌有效/);
    assert.equal(section.saveButton.disabled, false);
    assert.equal(section.testButton.disabled, false);
  });
});

test('题库配置修改后废弃旧测试结果，测试期间不重复发送请求', async () => {
  await withMinimalDom(async document => {
    let release;
    let calls = 0;
    const { root, testButton } = createSection(document, () => {
      calls += 1;
      return new Promise(resolve => { release = resolve; });
    });
    const pending = testButton.onclick();
    assert.equal(testButton.disabled, true);
    const duplicate = testButton.onclick();
    assert.equal(calls, 1);
    await duplicate;
    const address = root.querySelectorAll('input')[0];
    address.value = 'https://new-adapter.example';
    address.oninput();
    release({ state: 'ok' });
    await pending;
    assert.equal(root.querySelector('[data-cx-tiku-test-result]').hidden, true);
    assert.equal(testButton.disabled, false);
  });
});

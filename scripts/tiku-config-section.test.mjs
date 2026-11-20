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
  const deps = {
    document,
    getStoredTikuAdapterConfig: () => ({ baseurl: 'https://adapter.example', key: 'test-key' }),
    panelPinkTheme: new Proxy({}, { get: () => '#123456' }),
    applySectionCardStyle() {}, applySectionTitleStyle() {}, applyHintTextStyle() {},
    applyControlChrome() {}, applyActionButtonStyle() {},
    isWindowsHostRuntime: () => false,
    DEFAULT_TIKU_BASE_URL: 'https://adapter.example',
    testTikuAdapterConfig: probe,
    $modal: { alert: async value => modals.push(value) },
  };
  const factory = new Function(...Object.keys(deps), `${code}\nreturn createTikuAdapterConfigSection();`);
  const root = factory(...Object.values(deps));
  return { root, modals, testButton: root.querySelectorAll('button').find(button => button.textContent === '测试') };
}

test('题库配置的四种测试结果直接展示在按钮下方，不弹窗', async () => {
  await withMinimalDom(async document => {
    for (const [state, message] of [
      ['ok', /访问令牌有效/], ['invalid-key', /访问令牌无效/],
      ['rate-limited', /校验过于频繁/], ['server-error', /无法连接服务器/]
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

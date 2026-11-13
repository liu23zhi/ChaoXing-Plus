import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const commonPath = resolve(scriptsDir, '..', 'src', 'projects', 'common.ts');
const studyStatePath = resolve(scriptsDir, '..', 'src', 'projects', 'study-panel-state.ts');

function normalize(source) {
  return source.replace(/\r\n/g, '\n');
}

/**
 * 抽取式回归：只用 common.ts 里的**这一段**函数源码，在最小运行时下执行。
 *
 * 这正是 `allTabs` 必须写字面量的原因 —— 模块级常量不会跟着抽取过去，
 * 一旦它改成 `WORK_RESULTS_PANEL_TABS` 引用，这里就是 ReferenceError。
 */
function buildExtractedRuntime(source) {
  const parsed = ts.createSourceFile('common.ts', source, ts.ScriptTarget.Latest, true);
  const wanted = new Set([
    'createElement', 'createPanelTabBar', 'createPanelTabPanel', 'createWorkResultsPanel'
  ]);
  const declarations = parsed.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && wanted.has(node.name?.text)
  );
  assert.deepEqual(
    declarations.map((node) => node.name.text).sort(),
    [...wanted].sort(),
    '抽取的函数必须全部找到（否则下面的运行时会静默缺函数）'
  );
  return declarations;
}

function runExtractedPanel(declarations, { windowsExamOnly }) {
  const preamble = `
    const PANEL_TOUCH_TARGET_MIN_HEIGHT = '32px';
    const PANEL_SCROLL_STYLE_ID = 'chaoxing-plus-panel-scroll-style';
    const panelPinkTheme = new Proxy({}, { get: () => '#e5e7eb' });
    const panelShadowColor = () => 'transparent';
    const isWindowsHostRuntime = () => ${windowsExamOnly ? 'true' : 'false'};
    const getWorkResultStats = () => ({ totalQuestionCount: 0, requestedCount: 0, resolvedCount: 0 });
    const getStudySettingValue = (_name, fallback) => fallback;
    const createConfigField = () => document.createElement('label');
    const createMetricChip = (label, value) => createElement('span', { text: label + value });
    const createTikuAdapterConfigSection = () => document.createElement('section');
    const createStudySettingsPanel = () => document.createElement('section');
    const applySectionCardStyle = () => {};
    const applySectionTitleStyle = () => {};
    const applyHintTextStyle = () => {};
    const applyQuestionTextWrapStyle = () => {};
    const applyActionButtonStyle = () => {};
    const applyThinScrollbar = () => {};
    const applyScrollPaneStyle = () => {};
    const ensurePanelStyleSheet = () => {};
    const applyControlChrome = () => {};
    const formatQuestionTypeLabel = (type) => type;
    const formatWorkResultStatus = () => '已完成';
    const resolveWorkResultTone = () => 'success';
    const resolvePanelActivityState = () => ({ state: 'idle', label: '空闲', detail: '', tone: 'idle', pulse: false });
    const describeSearchErrorNextStep = () => '';
    const summarizeSearchInfoError = () => ({ title: '', details: [] });
    const syncWorkResultsControlDocument = () => {};
    const setWorkResultsView = () => {};
    const clearAndRetryWorkResults = () => {};
    const createPanelStatusStrip = () => createElement('div');
    const createWorkResultsDetail = () => createElement('div');
    const saveQuestionCaches = () => {};
    const createStatusPanelSection = () => createElement('div');
    const readCachedServiceStatusSnapshot = () => null;
    const refreshServiceStatusSnapshot = async () => null;
    const mountWindowsHostLogPanel = () => undefined;
    const answerCache = { clear() {} };
    const tabAnswerPause = { isPaused: () => false, setPaused() {} };
    const questionPositionSyncHandlers = {};
    const WORK_RESULTS_KEY = 'common.work-results.results';
    const runtimeStore = { set() {}, get() {} };
    const $message = { error() {} };
    const state = {
      workResultsPanelWidth: 360,
      workResults: { results: [], type: 'numbers', currentResultIndex: 0, ui: { activeTab: 'overview', collapsed: false } },
      apps: { localQuestionCaches: [] }
    };
    ${declarations.map((node) => node.getText()).join('\n')}
  `;

  // 在 Node 侧只做语法/类型擦除编译，然后在一个极简 DOM 上执行。
  //
  // 注意不要把脚本包进 IIFE 再靠「返回末尾表达式」取结果：tsc 会在最前面插入
  // `"use strict";`，`return "use strict"` 会因 ASI 提前结束语句，拿到的就是那个字符串。
  // 直接把整段当作函数体，末尾显式 `return createWorkResultsPanel();`。
  const compiled = ts.transpileModule(`${preamble}\nreturn createWorkResultsPanel();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText;

  const document = createMinimalDocument();
  const sandbox = { document, Date, Math, Number, String, Array, Object, JSON, Map, Set, Promise, Error, console };
  const factory = new Function(...Object.keys(sandbox), compiled);
  const root = factory(...Object.values(sandbox));
  assert.ok(root && Array.isArray(root.children), '抽取式运行时必须真的产出面板根节点');
  return { root, document };
}

/** 只实现状态页用到的 DOM 子集：createElement / append / dataset / style / setAttribute。 */
function createMinimalDocument() {
  const makeElement = (tagName) => {
    const element = {
      tagName: String(tagName).toUpperCase(),
      children: [],
      dataset: {},
      style: {},
      attributes: {},
      textContent: '',
      className: '',
      ownerDocument: undefined,
      get firstElementChild() { return this.children[0] ?? null; },
      get nextSibling() {
        const parent = this.parentNode;
        if (!parent) return null;
        return parent.children[parent.children.indexOf(this) + 1] ?? null;
      },
      parentNode: undefined,
      append(...nodes) {
        for (const node of nodes) {
          if (node === null || node === undefined) continue;
          node.parentNode = this;
          this.children.push(node);
        }
      },
      appendChild(node) { this.append(node); return node; },
      insertBefore(node, reference) {
        node.parentNode = this;
        const index = reference ? this.children.indexOf(reference) : -1;
        if (index < 0) this.children.push(node);
        else this.children.splice(index, 0, node);
        return node;
      },
      replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
      prepend(node) { this.children.unshift(node); node.parentNode = this; },
      removeChild(node) {
        const index = this.children.indexOf(node);
        if (index >= 0) this.children.splice(index, 1);
        return node;
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      querySelector() { return null; },
      querySelectorAll() { return []; }
    };
    element.ownerDocument = document;
    return element;
  };

  const document = {
    createElement: makeElement,
    getElementById: () => null,
    dispatchEvent: () => true
  };
  return document;
}

function collectTabs(root) {
  const bar = root.children.find((child) => child?.dataset?.cxPanelTabBar === 'true');
  assert.ok(bar, '必须渲染出页签栏');
  return {
    bar,
    tabIds: bar.children.map((button) => button.dataset.cxPanelTab),
    labels: bar.children.map((button) => button.textContent),
    activeIds: bar.children.filter((button) => button.dataset.cxPanelTabActive === 'true')
      .map((button) => button.dataset.cxPanelTab),
    panels: root.children
      .filter((child) => child?.dataset?.cxPanelTabPanel)
      .map((child) => ({ id: child.dataset.cxPanelTabPanel, display: child.style.display }))
  };
}

test('抽取式运行时下，五个页签都渲染出来（allTabs 必须是字面量，不能 import）', async () => {
  const source = normalize(await readFile(commonPath, 'utf8'));
  const declarations = buildExtractedRuntime(source);

  const { root } = runExtractedPanel(declarations, { windowsExamOnly: false });
  const tabs = collectTabs(root);

  assert.deepEqual(tabs.tabIds, ['overview', 'tiku', 'status', 'cache', 'study'],
    `扩展端必须有五个页签且顺序固定，实际 ${JSON.stringify(tabs.tabIds)}`);
  assert.deepEqual(tabs.labels, ['结果', '题库配置', '状态', '缓存', '学习设置'],
    `中文标签必须完整，实际 ${JSON.stringify(tabs.labels)}`);
  assert.deepEqual(tabs.activeIds, ['overview'], '默认只激活第一个页签');
});

test('Windows 端保留 status，裁掉 cache / study', async () => {
  const source = normalize(await readFile(commonPath, 'utf8'));
  const declarations = buildExtractedRuntime(source);

  const { root } = runExtractedPanel(declarations, { windowsExamOnly: true });
  const tabs = collectTabs(root);

  assert.deepEqual(tabs.tabIds, ['overview', 'tiku', 'status'],
    `Windows 端必须保留 status，实际 ${JSON.stringify(tabs.tabIds)}`);
  assert.equal(tabs.tabIds.includes('cache'), false);
  assert.equal(tabs.tabIds.includes('study'), false);
  assert.deepEqual(tabs.labels, ['结果', '题库配置', '状态']);
});

test('页签互斥：同一时刻只有一个 panel 可见，且切走后仍保留其余 panel（滚动位置靠它）', async () => {
  const source = normalize(await readFile(commonPath, 'utf8'));
  const declarations = buildExtractedRuntime(source);

  const { root } = runExtractedPanel(declarations, { windowsExamOnly: false });
  const tabs = collectTabs(root);

  assert.deepEqual(tabs.panels.map((panel) => panel.id), ['overview', 'tiku', 'status', 'cache', 'study'],
    '五个 tabpanel 都必须存在（用 display:none 而不是不渲染）');
  const visible = tabs.panels.filter((panel) => panel.display !== 'none');
  assert.deepEqual(visible.map((panel) => panel.id), ['overview'],
    `同一时刻只能有一个 tabpanel 可见，实际 ${JSON.stringify(visible.map((panel) => panel.id))}`);
  // 其余四个必须是 display:none —— 这正是「切回来滚动位置不变」的机制：
  // 节点从未被销毁，scrollTop 自然保留。
  for (const panel of tabs.panels.filter((item) => item.id !== 'overview')) {
    assert.equal(panel.display, 'none', `${panel.id} 必须用 display:none 保留在 DOM 里`);
  }
});

test('状态页签在两端都挂上了内容容器（不能是空页签）', async () => {
  const source = normalize(await readFile(commonPath, 'utf8'));
  const declarations = buildExtractedRuntime(source);

  for (const windowsExamOnly of [false, true]) {
    const { root } = runExtractedPanel(declarations, { windowsExamOnly });
    const statusPanel = collectTabs(root).panels.find((panel) => panel.id === 'status');
    assert.ok(statusPanel, `windowsExamOnly=${windowsExamOnly} 时必须有 status 页签`);
    const statusPanelNode = root.children.find((child) => child?.dataset?.cxPanelTabPanel === 'status');
    assert.equal(statusPanelNode.children.length > 0, true,
      `windowsExamOnly=${windowsExamOnly} 时状态页签必须有内容（空页签等于没做）`);
  }
});

test('study-panel-state 的类型与数组都加上了 status，且两者一致', async () => {
  const source = normalize(await readFile(studyStatePath, 'utf8'));

  assert.ok(source.includes("export type WorkResultsPanelTab = 'overview' | 'tiku' | 'status' | 'cache' | 'study';"),
    '联合类型必须含 status');
  assert.ok(source.includes("export const WORK_RESULTS_PANEL_TABS: WorkResultsPanelTab[] = ['overview', 'tiku', 'status', 'cache', 'study'];"),
    'WORK_RESULTS_PANEL_TABS 必须与类型同步');

  // 用真实模块验证 isWorkResultsPanelTab 认 status —— 类型与数组漏一处就会 false。
  const { loadCompiledTypeScriptModule } = await import('./test-helpers/load-compiled-typescript.mjs');
  const mod = await loadCompiledTypeScriptModule(studyStatePath, ['study-panel-state.js', 'projects/study-panel-state.js']);
  assert.equal(mod.isWorkResultsPanelTab('status'), true);
  for (const tab of ['overview', 'tiku', 'status', 'cache', 'study']) {
    assert.equal(mod.isWorkResultsPanelTab(tab), true, `${tab} 必须被识别为合法页签`);
  }
  assert.equal(mod.isWorkResultsPanelTab('nope'), false);
  assert.equal(mod.clampWorkResultsPanelTab('status', ['overview', 'tiku', 'status']), 'status');
});

test('common.ts 的 allTabs 是字面量，不是 import 的 WORK_RESULTS_PANEL_TABS（这条钉住那条注释的原因）', async () => {
  const source = normalize(await readFile(commonPath, 'utf8'));
  const start = source.indexOf('function createWorkResultsPanel()');
  assert.notEqual(start, -1);
  const end = source.indexOf('function renderWorkResultsPanel()', start);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);

  assert.ok(body.includes("const allTabs: WorkResultsPanelTab[] = ['overview', 'tiku', 'status', 'cache', 'study'];"),
    'allTabs 必须是完整字面量（含 status）');

  // 注释里提到常量名是**说明**，不是引用。要判断真实引用必须去掉注释再查，
  // 否则这条断言会被自己上下文里的解释文字误判成红。
  const codeOnly = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, removeComments: true }
  }).outputText;

  assert.equal(codeOnly.includes('const allTabs: WorkResultsPanelTab[] = WORK_RESULTS_PANEL_TABS'), false,
    'allTabs 不得改成引用模块级常量：抽取式回归会 ReferenceError');
  assert.equal(codeOnly.includes('const allTabs = WORK_RESULTS_PANEL_TABS'), false);
  // 代码里不得出现该常量的任何引用（含 tabLabels 之外的用途）。
  assert.equal(codeOnly.includes('WORK_RESULTS_PANEL_TABS'), false,
    'createWorkResultsPanel 的代码里不得引用 WORK_RESULTS_PANEL_TABS');
});

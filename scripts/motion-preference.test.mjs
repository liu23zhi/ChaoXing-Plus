import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestDirectory } from './test-helpers/temp-directory.mjs';

// 减少动效的三档开关（78-UI §6.3 / 45 §0.27.4，Q78-6）。
//
// 改造前的实证：PLUS 侧 `grep prefers-reduced-motion` 与 `grep animationMode`
// **都是 0 命中** —— 既没有「强制开」，也没有「强制关」，等于把动效完全交给宿主页面。
//
// 本文件的判据分两层，缺一层就会交付假钉子：
//
//   1. 行为层（resolveMotion / 控制器）：三档各自的有效值，尤其是
//      **「开」时系统 reduce 不影响** 与 **「跟随系统」时系统 reduce 生效**
//      这两条方向相反的用例必须同时存在。
//   2. 样式层（buildMotionCss 生成的 CSS）：用真的选择器匹配去判断
//      「某档在某个系统状态下动效是否被压平」，而不是 `css.includes('...')`。
//      字符串断言只能证明「写了这条规则」，不能证明「这条规则对该档生效」——
//      后者才是三档开关的全部价值。

const root = resolve(import.meta.dirname, '..');
const motionSourcePath = resolve(root, 'src', 'runtime', 'motion.ts');
const startSourcePath = resolve(root, 'src', 'runtime', 'start.ts');
const runtimeIndexPath = resolve(root, 'src', 'runtime', 'index.ts');

// ---- 加载 .ts 源码 ----
//
// 本仓 CI 有 node_modules（@typescript/typescript6），本机 worktree 没有。
// 两条路径都试，保证「CI 能跑」与「本机能跑」不需要两套测试。
let cachedModule = null;
async function loadMotionModule() {
  if (cachedModule) return cachedModule;
  const source = await readFile(motionSourcePath, 'utf8');
  let output;
  try {
    const { default: ts } = await import('@typescript/typescript6');
    output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    }).outputText;
  } catch {
    const { stripTypeScriptTypes } = await import('node:module');
    output = stripTypeScriptTypes(source, { mode: 'strip' });
  }
  const outDir = createTestDirectory('motion-preference');
  const outPath = resolve(outDir, 'motion.mjs');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, output, 'utf8');
  cachedModule = await import(pathToFileURL(outPath).href);
  return cachedModule;
}

// ---- 极简 CSS 规则匹配器 ----
//
// 只解析本模块会生成的两种选择器形态：
//   html[data-motion='off'] *
//   html:not([data-motion='on']) *
// （以及它们的 ::before / ::after 变体）。
// 目的不是通用 CSS 引擎，而是把「这条规则是否命中 data-motion=X 的 html」变成可执行判断。
const COMMENT = /\/\*[\s\S]*?\*\//gu;

function stripComments(text) {
  return text.replace(COMMENT, '').trim();
}

// 从 from 开始找与之配对的 }，返回 { closeIndex, inner }
function matchBlock(css, openIndex) {
  let depth = 0;
  let cursor = openIndex;
  while (cursor < css.length) {
    if (css[cursor] === '{') depth += 1;
    else if (css[cursor] === '}') {
      depth -= 1;
      if (depth === 0) {
        return { closeIndex: cursor, inner: css.slice(openIndex + 1, cursor) };
      }
    }
    cursor += 1;
  }
  return { closeIndex: css.length, inner: css.slice(openIndex + 1) };
}

function parseRules(css, media = null) {
  const rules = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open === -1) break;
    // ⚠️ 注释必须先剥掉再判 @media：本模块的 media 块前面就有一段注释，
    // 不剥会让 prelude 不以 '@media' 开头，整块规则被当成普通规则丢弃 ——
    // 那正是「六格表里 auto+reduce 判定错」的原因（第一次跑就是这个错）。
    const prelude = stripComments(css.slice(index, open));
    const block = matchBlock(css, open);

    if (prelude.startsWith('@media')) {
      // @media 里只允许出现普通规则，因此递归一层即可。
      for (const inner of parseRules(block.inner, prelude)) rules.push(inner);
    } else if (prelude) {
      rules.push({ selector: prelude, body: block.inner, media });
    }
    index = block.closeIndex + 1;
  }
  return rules;
}

// 判断某条规则里「以 html 开头的那一段」是否命中给定 mode 的 <html>。
function leadingHtmlMatches(selector, mode) {
  for (const part of selector.split(',')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith('html')) continue;
    // 取到第一个后代组合符之前的那一段
    const head = trimmed.split(/\s+/u)[0];
    const conditions = [...head.matchAll(/(:not\(\[[^\]]+\]\)|\[[^\]]+\])/gu)].map((m) => m[0]);
    let matched = true;
    for (const condition of conditions) {
      const negated = condition.startsWith(':not(');
      const attr = negated ? condition.slice(':not('.length, -1) : condition;
      const parsed = attr.match(/^\[data-motion='([^']+)'\]$/u);
      if (!parsed) continue;
      const equals = mode === parsed[1];
      if (negated ? equals : !equals) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * 给定 mode 与系统 reduce 状态，返回被置为 0ms 的声明集合。
 * 空集合 = 该档在该系统状态下动画正常播放。
 */
function stillDeclarations(css, mode, systemReduced) {
  const hits = [];
  for (const rule of parseRules(css)) {
    const inReducedMedia = typeof rule.media === 'string' && rule.media.includes('prefers-reduced-motion: reduce');
    if (inReducedMedia && !systemReduced) continue;
    if (!leadingHtmlMatches(rule.selector, mode)) continue;
    hits.push(rule.body);
  }
  return hits.join('\n');
}

function isStill(css, mode, systemReduced) {
  const body = stillDeclarations(css, mode, systemReduced);
  return /transition-duration:\s*0ms\s*!important/u.test(body);
}

// ---- 判据 ①：三档归一化 ----
test('motion mode normalization accepts exactly auto/on/off and defaults everything else to auto', async () => {
  const { normalizeMotionMode } = await loadMotionModule();
  for (const value of ['auto', 'on', 'off']) {
    assert.equal(normalizeMotionMode(value), value, value);
  }
  // 写字面量而不是引用 MOTION_MODES：常量漂移时这里必须红。
  for (const raw of [null, undefined, '', 'On', 'ON', ' off', 'auto ', 0, 1, true, {}, [], 'reduce', 'no-preference']) {
    assert.equal(normalizeMotionMode(raw), 'auto', `raw=${String(raw)}`);
  }
});

// ---- 判据 ①：三档各自的有效值（行为层）----
test('「开」时系统 reduce 不影响动画：resolveMotion(on, reduced=true) 仍是 on', async () => {
  const { resolveMotion } = await loadMotionModule();
  assert.equal(resolveMotion('on', false), 'on', '系统正常时自然开');
  // 这条是「显式覆盖」：三档必须与两档有区别，否则第三档是死 UI。
  assert.equal(resolveMotion('on', true), 'on', '用户显式选「开」时，系统 reduce 不得改写它');
});

test('「跟随系统」时系统 reduce 生效：resolveMotion(auto, reduced=true) 变 off', async () => {
  const { resolveMotion } = await loadMotionModule();
  assert.equal(resolveMotion('auto', false), 'on', '系统正常时跟随系统 = 有动画');
  assert.equal(resolveMotion('auto', true), 'off', '默认档必须尊重系统减少动效');
  // 未见过/坏值归一化后仍然是 auto，因此也跟随系统。
  assert.equal(resolveMotion(null, true), 'off');
  assert.equal(resolveMotion('garbage', true), 'off');
});

test('「关」永远关，与系统信号无关', async () => {
  const { resolveMotion } = await loadMotionModule();
  assert.equal(resolveMotion('off', false), 'off');
  assert.equal(resolveMotion('off', true), 'off');
});

// ---- 判据 ①+②：样式层真的按档生效 ----
test('样式层：三档 × 系统两态共六格的动效结果符合预期', async () => {
  const { buildMotionCss } = await loadMotionModule();
  const css = buildMotionCss();
  const table = [
    // [mode, systemReduced, expectStill]
    ['off', false, true],
    ['off', true, true],
    ['auto', false, false],
    ['auto', true, true],
    ['on', false, false],
    ['on', true, false]
  ];
  for (const [mode, systemReduced, expectStill] of table) {
    assert.equal(
      isStill(css, mode, systemReduced),
      expectStill,
      `mode=${mode} systemReduce=${systemReduced} 期望 ${expectStill ? '静止' : '有动画'}`
    );
  }
});

test('判据②：选「关」时所有过渡都是 0ms，且带 !important 压得过行内样式', async () => {
  const { buildMotionCss } = await loadMotionModule();
  const body = stillDeclarations(buildMotionCss(), 'off', false);
  assert.notEqual(body, '', '必须存在命中 html[data-motion=off] 的规则');
  for (const declaration of [
    'animation-duration: 0ms !important',
    'transition-duration: 0ms !important',
    'animation-delay: 0ms !important',
    'transition-delay: 0ms !important'
  ]) {
    assert.ok(body.includes(declaration), `缺少 ${declaration}`);
  }
  // 业务侧有两处行内 `element.style.transition = 'all 0.2s ease'`
  // （src/projects/common.ts:1533 / :1931）。行内声明优先级高于普通样式表规则，
  // 所以 !important 是「不改业务代码也能压住」的唯一手段。
  const common = await readFile(resolve(root, 'src', 'projects', 'common.ts'), 'utf8');
  assert.ok(
    /style\.transition\s*=\s*'all 0\.2s ease'/u.test(common),
    '前提变了：业务侧不再写行内 transition，本用例的 !important 理由需要重写'
  );
});

test('样式表覆盖元素本体与 ::before / ::after 伪元素', async () => {
  const { buildMotionCss } = await loadMotionModule();
  const css = buildMotionCss();
  for (const suffix of [' *', ' *::before', ' *::after']) {
    assert.ok(css.includes(suffix), `缺少选择器后缀 ${suffix}`);
  }
});

// ---- 控制器行为 ----
function createFakeRoot() {
  const attributes = new Map();
  return {
    attributes,
    setAttribute(name, value) {
      attributes.set(String(name), String(value));
    },
    getAttribute(name) {
      return attributes.has(String(name)) ? attributes.get(String(name)) : null;
    },
    removeAttribute(name) {
      attributes.delete(String(name));
    }
  };
}

function createMediaQuery({ matches = false } = {}) {
  const listeners = new Set();
  return {
    matches,
    addEventListener(type, listener) {
      assert.equal(type, 'change');
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'change');
      listeners.delete(listener);
    },
    listeners,
    set(next) {
      this.matches = Boolean(next);
      for (const listener of [...listeners]) listener();
    }
  };
}

test('控制器把「选择」写进 data-motion（不是有效值），并随系统信号重算有效值', async () => {
  const { createMotionController } = await loadMotionModule();
  const rootElement = createFakeRoot();
  const media = createMediaQuery({ matches: false });
  const stored = new Map();
  const controller = createMotionController({
    getStored: () => stored.get('mode') ?? null,
    setStored: (mode) => stored.set('mode', mode),
    createMediaQuery: () => media,
    root: rootElement,
    eventTarget: null
  });
  try {
    assert.equal(rootElement.getAttribute('data-motion'), 'auto', '默认档是跟随系统');
    assert.deepEqual(controller.getState(), { mode: 'auto', resolved: 'on' });

    // 跟随系统：系统开 reduce 后自动静止。
    media.set(true);
    assert.deepEqual(controller.getState(), { mode: 'auto', resolved: 'off' });

    // 选「开」：属性仍然是 'on'（CSS 需要看到这个选择），且系统 reduce 不再改写。
    controller.setMode('on');
    assert.equal(rootElement.getAttribute('data-motion'), 'on');
    assert.deepEqual(controller.getState(), { mode: 'on', resolved: 'on' });
    assert.equal(stored.get('mode'), 'on', '选择必须持久化');

    // 选「关」：无动效。
    controller.setMode('off');
    assert.equal(rootElement.getAttribute('data-motion'), 'off');
    assert.deepEqual(controller.getState(), { mode: 'off', resolved: 'off' });

    // 坏值退回 auto，而不是崩掉或停在某个显式档。
    controller.setMode('nonsense');
    assert.equal(rootElement.getAttribute('data-motion'), 'auto');
  } finally {
    controller.dispose();
  }
});

test('dispose 之后不再响应系统信号', async () => {
  const { createMotionController } = await loadMotionModule();
  const rootElement = createFakeRoot();
  const media = createMediaQuery({ matches: false });
  const controller = createMotionController({
    getStored: () => 'auto',
    setStored: () => {},
    createMediaQuery: () => media,
    root: rootElement,
    eventTarget: null
  });
  const seen = [];
  controller.subscribe((state) => seen.push(state.mode));
  media.set(true);
  assert.deepEqual(seen, ['auto']);
  controller.dispose();
  media.set(false);
  assert.deepEqual(seen, ['auto'], 'dispose 后不得再通知');
});

// ---- 接线层：不能只实现不调用 ----
test('start() 在渲染任何面板之前应用动效偏好（接线，不只是实现）', async () => {
  const source = await readFile(startSourcePath, 'utf8');
  const applyIndex = source.indexOf('applyMotionPreference()');
  assert.notEqual(applyIndex, -1, 'start.ts 必须调用 applyMotionPreference()');
  assert.ok(
    source.includes("from './motion.js'"),
    'start.ts 必须从 motion.js 引入，否则调用的是别的东西'
  );
  // 必须在第一个 createScriptInstance（也就是第一次面板渲染）之前生效，否则首屏会闪一下。
  const firstInstance = source.indexOf('createScriptInstance(');
  assert.notEqual(firstInstance, -1, 'start.ts 里找不到 createScriptInstance');
  assert.ok(applyIndex < firstInstance, '动效偏好必须早于第一次面板渲染');
  const runtimeIndex = await readFile(runtimeIndexPath, 'utf8');
  assert.ok(runtimeIndex.includes("export * from './motion.js';"), 'runtime/index.ts 必须导出 motion');
});

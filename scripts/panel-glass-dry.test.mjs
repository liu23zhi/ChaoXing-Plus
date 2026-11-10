import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// 面板「干玻璃」的结构契约（78-UI全面重构设计规范.md §6.2，用户裁决 Q78-2：
// 「在 CEF75 上全部关闭模糊」）。
//
// 这个文件只做**源码结构**断言，不启浏览器：它要守住的是「模糊默认不在场」
// 这条结构性红线，而那条红线的载体是 CSS 文本与选择器形态，不是运行时像素。
// 运行时行为（真实 computed style 为 none、开关置 true 才出现 blur）由
// scripts/panel-visual.browser.mjs 的 hasBackdropInAnyElement 与
// 本仓的浏览器探针覆盖。
//
// ⚠️ 判据为什么必须落在「属性缺失」而不是「属性为 false」：
// CEF 75 支持 backdrop-filter 语法，@supports 会通过，所以不能用特性检测切换；
// 只能靠显式运行时开关。若开关写成 `data-blur-enabled='false'` 才算关闭，
// 那么任何把它写成 'true'/'TRUE'/'1' 的变体都会意外开启模糊。
// 这里断言的是「唯一的开启条件是精确的 'true'」。

const root = resolve(import.meta.dirname, '..');
const glassPath = resolve(root, 'src/runtime/panel-glass.ts');
const commonPath = resolve(root, 'src/projects/common.ts');

/** §3.3.1 的两层原值（第 2、3 层），生成结果里必须逐字符出现。 */
const PANEL_GLASS_BACKGROUND_VALUE =
  'linear-gradient(135deg, rgba(255,255,255,.18), rgba(255,255,255,.06))';
const PANEL_GLASS_BORDER_VALUE = '1px solid rgba(255,255,255,.35)';

/**
 * 从 TS 源码里**执行** buildPanelGlassCss。
 *
 * 为什么不直接 grep 源码：只 grep 常量定义会把「常量还在但规则里没用了」这种
 * 真缺陷放过去（本文件第一版就漏过 `border` 那一层）。这里把函数体里的模板字符串
 * 抠出来，用给定的 rootId 展开，得到的就是运行时真正注入的 CSS 文本。
 */
function buildPanelGlassCssFromSource(source, rootId) {
  const start = source.indexOf('export function buildPanelGlassCss');
  assert.ok(start > 0, '缺少 buildPanelGlassCss');
  const body = source.slice(start);
  const returnIndex = body.indexOf('return `');
  assert.ok(returnIndex > 0, 'buildPanelGlassCss 必须 return 一个模板字符串');
  const literalStart = returnIndex + 'return `'.length;
  const literalEnd = body.indexOf('`;', literalStart);
  assert.ok(literalEnd > literalStart, '找不到模板字符串结尾');

  const scope = `#${rootId}`;
  const substitutions = {
    '${scope}': scope,
    '${PANEL_GLASS_CLASS}': 'cx-glass',
    '${PANEL_GLASS_BACKGROUND}': PANEL_GLASS_BACKGROUND_VALUE,
    '${PANEL_GLASS_BORDER}': PANEL_GLASS_BORDER_VALUE,
    '${PANEL_BLUR_ATTR}': 'data-blur-enabled',
  };
  let css = body.slice(literalStart, literalEnd);
  for (const [token, value] of Object.entries(substitutions)) {
    css = css.split(token).join(value);
  }
  assert.equal(/\$\{/u.test(css), false, `生成的 CSS 仍含未替换的模板占位：\n${css}`);
  return css;
}

/** 取出一个源文件里「语法位置的」backdrop-filter 出现（排除注释里的讨论）。 */
function syntaxBackdropLines(source) {
  return source.split(/\r?\n/u).filter((line) => {
    if (!/backdrop-filter/u.test(line)) return false;
    const trimmed = line.trim();
    // 文档注释（* 开头）与行注释都不是语法。
    if (trimmed.startsWith('*')) return false;
    if (trimmed.startsWith('//')) return false;
    return true;
  });
}

test('干玻璃只保留第 2、3 层：半透明渐变底 + 1px 高光描边', async () => {
  const source = await readFile(glassPath, 'utf8');

  // 第 2 层：渐变必须与 §3.3.1 的取值逐字符一致（不是「差不多」的另一种渐变）。
  assert.ok(
    source.includes('linear-gradient(135deg, rgba(255,255,255,.18), rgba(255,255,255,.06))'),
    '缺少第 2 层半透明渐变底（§3.3.1 的原值）'
  );
  // 第 3 层：1px 高光描边。
  assert.ok(
    source.includes('1px solid rgba(255,255,255,.35)'),
    '缺少第 3 层 1px 高光描边（§3.3.1 的原值）'
  );

  // ⚠️ 光有常量定义不算数 —— 必须真的被生成的样式表**使用**。
  // 这里曾经漏过：只断言常量字符串存在，把 `border: ${PANEL_GLASS_BORDER};` 从规则里
  // 删掉后测试照样全绿（常量还在，规则里没有了）。所以下面直接检查生成结果。
  const css = buildPanelGlassCssFromSource(source, 'probe-root');
  assert.ok(
    css.includes(`background: ${PANEL_GLASS_BACKGROUND_VALUE};`),
    `生成的样式表里缺少第 2 层 background，实际：\n${css}`
  );
  assert.ok(
    css.includes(`border: ${PANEL_GLASS_BORDER_VALUE};`),
    `生成的样式表里缺少第 3 层 border，实际：\n${css}`
  );
});

test('backdrop-filter 只出现 1 处语法位置，且在选择器内而非基础规则', async () => {
  const source = await readFile(glassPath, 'utf8');
  const lines = syntaxBackdropLines(source);

  // §3.3.3 性能约束：同时带 backdrop-filter 的元素 ≤ 3；本项目实际只允许 1。
  // 超过 1 处通常意味着在子元素上重复加了，CEF 75 会明显掉帧。
  assert.equal(lines.length, 1, `语法位置出现 ${lines.length} 处 backdrop-filter，必须恰好 1 处：\n${lines.join('\n')}`);

  const cssStart = source.indexOf('export function buildPanelGlassCss');
  assert.ok(cssStart > 0, '缺少 buildPanelGlassCss');
  const cssBody = source.slice(cssStart);

  // 唯一那处必须在 buildPanelGlassCss 里（即运行时生成的样式表内）。
  assert.ok(
    cssBody.includes('backdrop-filter'),
    'backdrop-filter 不在 buildPanelGlassCss 生成的样式表里'
  );

  // 且必须挂在 `html[data-blur-enabled='true']` 这条规则里 ——
  // 这是「默认关闭」的唯一载体。基础规则（#id .cx-glass）里不能有它。
  const blurRuleIndex = cssBody.indexOf("html[${PANEL_BLUR_ATTR}='true']");
  const backdropIndex = cssBody.indexOf('backdrop-filter');
  assert.ok(blurRuleIndex > 0, "缺少 html[data-blur-enabled='true'] 开关规则");
  assert.ok(
    backdropIndex > blurRuleIndex,
    'backdrop-filter 出现在开关规则之前（即落在了默认生效的基础规则里，等于默认开启模糊）'
  );

  // 基础规则块（第一个 `#... .cx-glass { ... }`）必须不含模糊属性。
  const baseRuleMatch = cssBody.match(/\$\{scope\} \.\$\{PANEL_GLASS_CLASS\} \{[\s\S]*?\}/u);
  assert.ok(baseRuleMatch, '未找到基础玻璃规则块');
  assert.equal(
    /backdrop/iu.test(baseRuleMatch[0]),
    false,
    `基础玻璃规则块内出现了模糊属性，等于默认开启：\n${baseRuleMatch[0]}`
  );
});

test('模糊开关不用 @supports 做切换条件（CEF75 会通过却没性能收益）', async () => {
  const source = await readFile(glassPath, 'utf8');
  const cssStart = source.indexOf('export function buildPanelGlassCss');
  const cssBody = source.slice(cssStart, source.indexOf('export function ensurePanelGlassStyle'));

  // @supports (backdrop-filter: ...) 在 CEF75 上返回 true，因此不能作为
  // 「是否启用模糊」的判据 —— 用户的裁决必须由显式运行时属性承载。
  assert.equal(
    /@supports/u.test(cssBody),
    false,
    '生成的样式表里出现了 @supports：CEF75 会让它通过，无法实现「默认关闭模糊」'
  );
});

test('模糊开关的默认态是「属性缺失」，且只认精确的小写 true', async () => {
  const source = await readFile(glassPath, 'utf8');

  // 关闭时移除属性而不是写 'false'：属性缺失是唯一被认可的关闭态。
  assert.ok(
    source.includes('rootElement.removeAttribute(PANEL_BLUR_ATTR)'),
    '关闭模糊必须 removeAttribute，而不是写入 false（写 false 会让变体值有意外开启的机会）'
  );
  // 读取侧必须严格比较 'true'，不能 `!== null` 之类的宽松判断。
  assert.ok(
    source.includes("getAttribute(PANEL_BLUR_ATTR) === 'true'"),
    "isPanelBlurEnabled 必须严格比较 'true'"
  );
  // 默认值：属性缺失 ⇒ false。
  assert.ok(
    source.includes('return false;'),
    'isPanelBlurEnabled 缺少默认 false 分支'
  );
});

test('玻璃层挂在根容器 id 作用域内，不污染宿主页面', async () => {
  const source = await readFile(glassPath, 'utf8');

  // §3.3.2 硬约束：所有选择器必须挂在唯一根容器 id 下，不能用全局元素选择器。
  assert.ok(
    source.includes('const scope = `#${rootId}`;'),
    '样式作用域必须由根容器 id 拼出'
  );
  assert.ok(
    source.includes('${scope} .${PANEL_GLASS_CLASS}'),
    '选择器必须形如 #<rootId> .cx-glass'
  );

  // 生成的选择器里不能出现裸元素/通配选择器（会污染宿主）。
  const cssStart = source.indexOf('export function buildPanelGlassCss');
  const cssBody = source.slice(cssStart, source.indexOf('export function ensurePanelGlassStyle'));
  // 只挑模板字符串内部（`...`）的选择器行，避免把函数签名 `buildPanelGlassCss(...) {` 当成选择器。
  const templateBody = cssBody.slice(cssBody.indexOf('return `'), cssBody.lastIndexOf('`;'));
  const selectorLines = templateBody.split(/\r?\n/u).filter((line) => line.trim().endsWith('{'));
  assert.ok(selectorLines.length >= 2, `模板里应至少两条规则，实际 ${selectorLines.length}`);
  for (const selector of selectorLines) {
    // `${scope}` 就是 `#${rootId}`，两种写法都算作用域正确。
    assert.match(selector, /#\$|^\s*\$\{scope\}|\$\{scope\}\s/u, `选择器缺少根 id 作用域：${selector.trim()}`);
  }
});

test('玻璃层是独立表面层，不覆盖根容器的主题 border/background', async () => {
  const commonSource = await readFile(commonPath, 'utf8');

  // 根容器的这三行是 pink-panel-ui.test.mjs:160-162 的主题判据，必须原样保留。
  assert.ok(
    commonSource.includes('panel.root.style.background = panelPinkTheme.shellGradient;'),
    '根容器背景必须仍来自主题（不能被玻璃渐变替换）'
  );
  assert.ok(
    commonSource.includes('panel.root.style.border = `1px solid ${panelPinkTheme.borderStrong}`;'),
    '根容器边框必须仍来自主题（否则 windows-panel-theme 的 borderTopColor 断言会红）'
  );
  assert.ok(
    commonSource.includes('panel.root.style.boxShadow = panelPinkTheme.shellShadow;'),
    '根容器阴影必须仍来自主题'
  );
  // 玻璃层是「额外加的」，不是「替换根的」。
  assert.ok(
    commonSource.includes('ensurePanelGlassLayer(panel.root);'),
    '未挂载玻璃表面层'
  );
});

test('玻璃层必须 appendChild，不得前插（否则 root.children 下标整体后移）', async () => {
  const source = await readFile(glassPath, 'utf8');

  // createPanelRoot 建立 `replaceChildren(lockWrapper, configsContainer, body)`，
  // 于是 body 恒为 root.children[2]；scripts/panel-tabs.browser.test.mjs:240
  // 依赖这个下标取 body 断言「坏数据时面板不得空白」。
  //
  // 实测事故：前插玻璃层后 body 被挤到 children[3]，该用例报
  // 「面板 body 不得为空（这正是修复前的事故表现）」—— 看起来像坏数据回归，
  // 实际是 DOM 下标被顶掉了。z-index:-1 已保证视觉层级，DOM 顺序无关，追加即可。
  assert.ok(
    source.includes('root.appendChild(layer)'),
    '玻璃层必须 appendChild 到根容器末尾'
  );
  assert.equal(
    /root\.insertBefore\(layer/u.test(source),
    false,
    '玻璃层不得前插：会把 body 从 root.children[2] 挤走，导致 panel-tabs 的坏数据用例误红'
  );

  // 再加一条反向钉子：确认那个依赖下标的测试确实还在（防止有人删测试来掩盖）。
  const tabsTest = await readFile(resolve(root, 'scripts/panel-tabs.browser.test.mjs'), 'utf8');
  assert.ok(
    tabsTest.includes('panel.children[2]'),
    'panel-tabs.browser.test.mjs 不再用 children[2] 取 body：若是有意改动，请同步更新本断言'
  );
});

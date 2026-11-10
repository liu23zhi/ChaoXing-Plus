/**
 * 面板的「干玻璃」表面层（78-UI全面重构设计规范.md §6.2，用户裁决 Q78-2）。
 *
 * ## 为什么叫「干玻璃」
 *
 * §3.3.1 原本的液态玻璃是三层：
 *
 *   第 1 层  backdrop-filter: blur(24px) saturate(180%)   ← 模糊宿主背景
 *   第 2 层  半透明渐变底 linear-gradient(135deg, rgba(255,255,255,.18), rgba(255,255,255,.06))
 *   第 3 层  1px 高光描边 border: 1px solid rgba(255,255,255,.35)
 *
 * 用户裁决「在 CEF75 上全部关闭模糊」⇒ **只保留第 2、3 层**，视觉上仍是玻璃质感
 * （半透明 + 高光边）但没有模糊，故称「干玻璃」。
 *
 * ## 为什么不能用 @supports 做开关
 *
 * CEF 75 **支持** `backdrop-filter` 语法，`@supports (backdrop-filter: blur(1px))`
 * 会通过；但软件渲染下会在面板周围产生模糊光晕。`src/runtime/panel.ts:77` 的注释
 * 记录了当初刻意禁用它的原因（「不透明底色 + 紧凑阴影：半透明 + 大半径阴影在
 * CEF75/软件渲染下会在面板周围形成模糊光晕」）。
 *
 * ⇒ 切换条件必须是**显式运行时开关** `data-blur-enabled`，
 *   **属性缺失 = 关闭**（不是 `='false'` 才关闭，而是根本没有这个属性就关闭）。
 *   这样「默认不模糊」是结构性保证：即使宿主的 `html` 被污染、即使属性拼错，
 *   结果都是不模糊 —— 失败方向永远安全。
 *
 * ## 为什么模糊只写一次
 *
 * `backdrop-filter` 是 GPU 密集操作（§3.3.3：同时带该属性的元素 ≤ 3 个）。
 * 本项目实际只需要 **1 个**（面板表面层）。超过 1 处通常意味着在子元素上重复加了，
 * CEF 75 会明显掉帧。本文件的 `backdrop-filter` 出现次数被静态测试钉死为 1。
 *
 * ## 为什么样式要挂在根容器 id 下
 *
 * 面板注入在**第三方宿主页面**（超星）里，宿主可能有自己的 `*` 选择器与 `!important`
 * 规则。只有 `#<rootId> .cx-glass` 这种「根 id 前缀」的写法才既不污染宿主，
 * 也不被宿主的同名类误命中。
 */

/** 玻璃表面层使用的类名（只挂在面板自建的元素上）。 */
export const PANEL_GLASS_CLASS = 'cx-glass';

/** 玻璃样式表的元素 id（与滚动条样式表分开：后者随主题重建，前者只随根 id 变化）。 */
export const PANEL_GLASS_STYLE_ID = 'chaoxing-plus-panel-glass-style';

/** 玻璃表面层的标记属性，供 DOM 测试定位（避免只靠类名）。 */
export const PANEL_GLASS_LAYER_ATTR = 'data-cx-glass-layer';

/**
 * 运行时模糊开关的属性名与取值。
 *
 * 默认**不写**这个属性：`html[data-blur-enabled='true']` 不匹配 ⇒ 无模糊。
 * 只有确认非 CEF75 环境时才调 `setPanelBlurEnabled(true)`。
 */
export const PANEL_BLUR_ATTR = 'data-blur-enabled';

/** 第 2 层：半透明渐变底（§3.3.1）。 */
export const PANEL_GLASS_BACKGROUND =
  'linear-gradient(135deg, rgba(255,255,255,.18), rgba(255,255,255,.06))';

/** 第 3 层：1px 高光描边（§3.3.1）。 */
export const PANEL_GLASS_BORDER = '1px solid rgba(255,255,255,.35)';

/**
 * 生成面板玻璃样式表文本。
 *
 * rootId 必须来自实际根容器的 `id`：每个脚本实例的面板 id 不同
 * （`panel-<namespace>`，见 src/runtime/script.ts:23），因此样式表要按 id 生成。
 *
 * ⚠️ 两条规则的顺序与「默认无模糊」的语义：
 *
 *   1. `#<rootId> .cx-glass` —— 第 2、3 层，**不写**任何模糊属性；
 *   2. `html[data-blur-enabled='true'] #<rootId> .cx-glass` —— 唯一一处模糊，
 *      只有宿主 `html` 显式带该属性时才匹配。
 *
 * 这里**不用** `@supports`（CEF75 会通过，见文件头）。
 */
export function buildPanelGlassCss(rootId: string): string {
  const scope = `#${rootId}`;
  return `${scope} .${PANEL_GLASS_CLASS} {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: -1;
  pointer-events: none;
  border-radius: inherit;
  background: ${PANEL_GLASS_BACKGROUND};
  border: ${PANEL_GLASS_BORDER};
}

html[${PANEL_BLUR_ATTR}='true'] ${scope} .${PANEL_GLASS_CLASS} {
  backdrop-filter: blur(24px) saturate(180%);
}`;
}

/**
 * 确保宿主文档里有一份与本面板根 id 匹配的玻璃样式表。
 *
 * 幂等：同一个 rootId 重复调用时，内容一致就不重写 DOM
 * （与 `ensurePanelStyleSheet` 的「先比对再赋值」写法一致，避免无谓的样式重算）。
 */
export function ensurePanelGlassStyle(ownerDocument: Document | undefined, rootId: string): void {
  try {
    const doc = ownerDocument ?? document;
    if (!rootId) {
      return;
    }
    let style = doc.getElementById(PANEL_GLASS_STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = doc.createElement('style');
      style.id = PANEL_GLASS_STYLE_ID;
      (doc.head || doc.documentElement).appendChild(style);
    }
    const nextText = buildPanelGlassCss(rootId);
    if (style.textContent !== nextText) {
      style.textContent = nextText;
    }
  } catch {
    // 插入失败只影响玻璃质感，不影响任何功能（面板仍按主题底色渲染）。
  }
}

/**
 * 在面板根容器里挂上玻璃表面层（幂等）。
 *
 * ## 为什么是「额外的层」而不是直接改根容器的 background / border
 *
 * 根容器的 `background` / `border` / `boxShadow` 已经被既有回归测试逐字符钉死：
 *
 *   - `scripts/pink-panel-ui.test.mjs:160-162` 断言源码里存在
 *     `panel.root.style.background = panelPinkTheme.shellGradient;` 等三行；
 *   - `scripts/windows-panel-theme.browser.mjs:77/80/83` 断言根容器的
 *     `borderTopColor` **精确等于**主题的 `borderStrong`
 *     （如蓝色 `rgba(37, 99, 235, 0.34)`）。
 *
 * 如果在根容器上套第 3 层的白色描边，`borderTopColor` 会变成
 * `rgba(255, 255, 255, 0.35)`，主题断言立刻红 —— 而那正是「主题是否生效」的判据，
 * 不能用视觉改造去换掉它。
 *
 * ⇒ 玻璃做成一层独立的、`pointer-events: none` 的绝对定位层，
 *   用 `z-index: -1` 落在根容器自身背景之上、正文内容之下：
 *   根容器是 `position: fixed` + 显式 `z-index`，本身构成层叠上下文，
 *   所以 `z-index: -1` 的子元素不会跑到宿主页面背后，只会沉到面板内容下面。
 */
export function ensurePanelGlassLayer(root: HTMLElement): void {
  try {
    if (!root || !root.id) {
      return;
    }
    ensurePanelGlassStyle(root.ownerDocument, root.id);
    if (root.querySelector(`:scope > [${PANEL_GLASS_LAYER_ATTR}='true']`)) {
      return;
    }
    const layer = root.ownerDocument.createElement('div');
    layer.className = PANEL_GLASS_CLASS;
    layer.setAttribute(PANEL_GLASS_LAYER_ATTR, 'true');
    // ⚠️ 必须 **追加**（appendChild），不能前插（insertBefore firstChild）。
    //
    // 根容器的子节点顺序是被既有测试按**下标**依赖的：
    // createPanelRoot 建立 `root.replaceChildren(lockWrapper, configsContainer, body)`
    // （src/runtime/panel.ts:94），所以 body 恒为 children[2]；而
    // scripts/panel-tabs.browser.test.mjs:240 正是用 `panel.children[2]` 取 body
    // 断言「坏数据时面板不得空白」。
    //
    // 实测：把玻璃层前插到 firstChild 后，body 被挤到 children[3]，
    // 该用例立刻红（AssertionError: 面板 body 不得为空）。
    // 视觉上 z-index:-1 已经保证玻璃在内容之下，DOM 顺序无关，所以追加即可。
    root.appendChild(layer);
  } catch {
    // 插入失败只影响玻璃质感，不影响功能。
  }
}

/**
 * 显式开启/关闭运行时模糊（默认关闭）。
 *
 * ⚠️ **CEF 75 / Windows 客户端绝不能调 `setPanelBlurEnabled(true)`**：
 * 软渲染下会产生模糊光晕（见文件头）。本仓当前没有任何调用点把它设为 true ——
 * 这正是「默认干玻璃」的落地点。
 *
 * 设为 false 时**移除属性**而不是写 `'false'`：属性缺失是唯一被认可的关闭态，
 * 这样「有人手写成 data-blur-enabled="TRUE"/"1"」之类的变体也不会意外开启。
 */
export function setPanelBlurEnabled(enabled: boolean, ownerDocument?: Document): boolean {
  try {
    const doc = ownerDocument ?? document;
    const rootElement = doc.documentElement;
    if (!rootElement) {
      return false;
    }
    if (enabled) {
      rootElement.setAttribute(PANEL_BLUR_ATTR, 'true');
    } else {
      rootElement.removeAttribute(PANEL_BLUR_ATTR);
    }
    return true;
  } catch {
    return false;
  }
}

/** 读取当前模糊是否开启（属性缺失 = 关闭）。 */
export function isPanelBlurEnabled(ownerDocument?: Document): boolean {
  try {
    const doc = ownerDocument ?? document;
    return doc.documentElement?.getAttribute(PANEL_BLUR_ATTR) === 'true';
  } catch {
    return false;
  }
}

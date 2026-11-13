/**
 * 减少动效的三档开关（78-UI全面重构设计规范.md §6.3 / 45 §0.27.4，Q78-6）。
 *
 * ## 三档而不是两档
 *
 * 改造前 PLUS 侧 `prefers-reduced-motion` **零命中**（`grep` 实证）：既没有「强制关」，
 * 也没有「强制开」，等于把动效完全交给宿主页面的媒体查询。用户裁决要求三档：
 *
 *   - `auto`   跟随系统（默认）→ 读 `prefers-reduced-motion: reduce`
 *   - `on`     强制开 → **系统 reduce 不改变它**
 *   - `off`    强制关 → 所有过渡 0ms
 *
 * ## ⚠️ 这里与 78 号 §6.3 的措辞有一处**有意的分歧**，别当成笔误
 *
 * 78 号原文写「系统级 `prefers-reduced-motion: reduce` 必须能覆盖应用内『开启』」，
 * 并给了一段 `@media reduce { html[data-motion='on'] * { ... } }`。
 *
 * 但那样实现会让三档**退化成两档**：`on` 与 `auto` 在系统 reduce 下都是静止，
 * 用户永远观察不到 `on` 与 `auto` 的差别 —— 第三档变成死 UI，等于改了个字符串。
 * 本模块采用的语义是：
 *
 *   | 选择 | 系统正常 | 系统 reduce |
 *   |------|----------|-------------|
 *   | off  | 0ms      | 0ms         |
 *   | auto | 正常动效 | 0ms（跟随系统） |
 *   | on   | 正常动效 | 正常动效（显式覆盖） |
 *
 * 医学动机（前庭功能障碍）由 `auto`（默认档）与 `off` 两档承接：默认行为永远尊重系统；
 * 只有用户**显式**选 `on` 才覆盖，那是用户的明示选择，而不是应用的默认越权。
 *
 * ## 为什么 `data-motion` 携带的是「选择」而不是「有效值」
 *
 * CSS 必须能区分「用户选了 on」与「用户选 auto 但系统没开 reduce」——
 * 这两者在系统正常时有效值都是 on，但系统 reduce 时有效值相反。
 * 所以属性写**选择**，有效值只在控制器里算（`resolveMotion`），
 * 需要落地成具体时长时才由 CSS 属性选择器决定。写有效值会让 CSS 无法表达上表第三行。
 *
 * ## 只挂一个属性，不撒 class
 *
 * 78 号 §6.3 明确要求「用 `<html data-motion>` 控制，不要多个 class 满天飞」。
 * 因此本模块只写 `documentElement` 上的一个属性，并注入一张只由属性选择器构成的样式表。
 */

/** 持久化键。与既有 `common.settings.*` 同族，因此会走 Windows 宿主的跨 frame 共享通道。 */
export const MOTION_STORAGE_KEY = 'common.settings.motion-mode';

/** 承载用户选择的属性名（写在 `<html>` 上）。 */
export const MOTION_ATTR = 'data-motion';

/** 动效样式表的元素 id。 */
export const MOTION_STYLE_ID = 'chaoxing-plus-motion-style';

/** 系统减少动效的媒体查询。 */
export const MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)';

export type MotionMode = 'auto' | 'on' | 'off';
export type ResolvedMotion = 'on' | 'off';

/** 三档的全集，按「跟随系统 / 开 / 关」的顺序 —— UI 也按这个顺序排。 */
export const MOTION_MODES: readonly MotionMode[] = ['auto', 'on', 'off'];

/** 归一化：只有精确的 `'on'` / `'off'` 是显式选择，其余一切（null/''/'on '/'ON'/数字）都退回 `auto`。 */
export function normalizeMotionMode(raw: unknown): MotionMode {
  return raw === 'on' || raw === 'off' ? raw : 'auto';
}

/**
 * 把「选择 + 系统信号」解析成有效值。
 *
 * 顺序不能换：
 *   1. `off` 永远 off（用户显式关掉，系统开不开都该关）；
 *   2. `on` 永远 on（显式覆盖，见文件头的分歧说明）；
 *   3. 其余（`auto` 与一切归一化后的兜底值）跟随系统。
 *
 * ⚠️ 变异判据：把第 3 步的 `systemReduced` 丢掉（改成 `return 'on'`）会让
 * 「跟随系统」用例红 —— 这正是「用户选择优先」的错实现。
 * 把第 2 步挪到第 1 步之后但不判 `off` 优先，则「关」用例红。
 */
export function resolveMotion(mode: unknown, systemReduced: boolean): ResolvedMotion {
  const normalized = normalizeMotionMode(mode);
  if (normalized === 'off') {
    return 'off';
  }
  if (normalized === 'on') {
    return 'on';
  }
  return systemReduced ? 'off' : 'on';
}

/**
 * 生成动效样式表文本。
 *
 * 两条规则，各自负责一档：
 *
 *   1. `html[data-motion='off'] *` —— 强制静止，**不受系统信号影响**，
 *      并且必须能压住业务侧写的**行内** `element.style.transition = 'all 0.2s ease'`
 *      （`src/projects/common.ts` 有两处这么写）。样式表里的 `!important`
 *      优先级高于行内声明，所以这两处不需要改业务代码。
 *   2. `@media (prefers-reduced-motion: reduce) { html:not([data-motion='on']) * }`
 *      —— 只有「非 on」才被系统信号压平。用 `:not()` 而不是另写一条「恢复」规则，
 *      是因为 `!important` 一旦生效就无法用更高优先级「恢复」回原时长
 *      （只能靠换一个不被匹配的选择器）。属性缺失也落在 `:not([data-motion='on'])` 里，
 *      所以「没装控制器」的宿主页面行为与改造前一致（跟随系统）。
 */
export function buildMotionCss(): string {
  const declarationList = (indent: string): string => [
    'animation-duration: 0ms !important',
    'animation-delay: 0ms !important',
    'animation-iteration-count: 1 !important',
    'transition-duration: 0ms !important',
    'transition-delay: 0ms !important',
    'scroll-behavior: auto !important'
  ].map((declaration) => `${indent}${declaration};`).join('\n');

  const pseudoList = (prefix: string, indent: string): string => [
    `${prefix} *`,
    `${prefix} *::before`,
    `${prefix} *::after`
  ].map((selector) => `${indent}${selector}`).join(',\n');

  return `/* 用户显式选择「关闭」：所有过渡 0ms，与系统信号无关。 */
${pseudoList(`html[${MOTION_ATTR}='off']`, '')} {
${declarationList('  ')}
}

/* 「跟随系统」与属性缺失（未装控制器）时尊重系统的减少动效。
   显式的 data-motion='on' 被 :not() 排除 —— 见 src/runtime/motion.ts 文件头的分歧说明。 */
@media ${MOTION_MEDIA_QUERY} {
${pseudoList(`html:not([${MOTION_ATTR}='on'])`, '  ')} {
${declarationList('    ')}
  }
}`;
}

/** 确保宿主文档里有一份动效样式表（幂等：内容一致就不碰 DOM）。 */
export function ensureMotionStyle(ownerDocument?: Document): boolean {
  try {
    const doc = ownerDocument ?? document;
    let style = doc.getElementById(MOTION_STYLE_ID) as HTMLStyleElement | null;
    const nextText = buildMotionCss();
    if (!style) {
      style = doc.createElement('style');
      style.id = MOTION_STYLE_ID;
      (doc.head || doc.documentElement).appendChild(style);
    }
    if (style.textContent !== nextText) {
      style.textContent = nextText;
    }
    return true;
  } catch {
    // 样式注入失败只影响动效，不影响任何功能。
    return false;
  }
}

interface MotionMediaQuery {
  matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
}

export interface MotionControllerOptions {
  /** 读持久化的选择（默认读 localStorage 的 JSON 值）。 */
  getStored?: () => unknown;
  /** 写持久化的选择（默认写 localStorage 的 JSON 值）。 */
  setStored?: (mode: MotionMode) => void;
  /** 建媒体查询（默认真实 matchMedia）。 */
  createMediaQuery?: (query: string) => MotionMediaQuery | null;
  /** 写属性的根元素（默认 documentElement）。 */
  root?: Element | null;
  /** 监听 storage 事件的目标（默认 window）。 */
  eventTarget?: EventTarget | null;
}

export interface MotionState {
  /** 用户选的那一档（原样写进 `data-motion`）。 */
  mode: MotionMode;
  /** 落到动画上的有效值。 */
  resolved: ResolvedMotion;
}

export interface MotionController {
  getState(): MotionState;
  setMode(raw: unknown): MotionState;
  subscribe(listener: (state: MotionState) => void): () => void;
  dispose(): void;
}

function readStoredMode(): unknown {
  try {
    const raw = window.localStorage.getItem(MOTION_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeStoredMode(mode: MotionMode): void {
  try {
    window.localStorage.setItem(MOTION_STORAGE_KEY, JSON.stringify(mode));
  } catch {
    // 不透明 origin（about:blank/srcdoc）无法持久化，属性仍然生效。
  }
}

/**
 * 建一个动效控制器：把三档写进 `<html data-motion>`、注入样式表，并在系统信号变化时重算。
 *
 * 它**不**读业务面板的配置项（那需要改 `src/projects/common.ts`，本轮另有成员在改），
 * 选择来自 `common.settings.motion-mode` 这个持久化键本身。
 */
export function createMotionController(options: MotionControllerOptions = {}): MotionController {
  const getStored = options.getStored ?? readStoredMode;
  const setStored = options.setStored ?? writeStoredMode;
  const root = options.root === undefined
    ? (typeof document === 'undefined' ? null : document.documentElement)
    : options.root;
  const eventTarget = options.eventTarget === undefined
    ? (typeof window === 'undefined' ? null : (window as unknown as EventTarget))
    : options.eventTarget;

  let mediaQuery: MotionMediaQuery | null = null;
  try {
    const factory = options.createMediaQuery
      ?? (typeof window === 'undefined'
        ? null
        // MediaQueryList 的 addEventListener 签名比这里需要的宽，用 unknown 中转而不是直接断言。
        : (query: string) => window.matchMedia(query) as unknown as MotionMediaQuery);
    mediaQuery = factory ? factory(MOTION_MEDIA_QUERY) : null;
  } catch {
    mediaQuery = null;
  }

  const subscribers = new Set<(state: MotionState) => void>();
  let state: MotionState = { mode: 'auto', resolved: 'on' };
  let disposed = false;

  const systemReduced = (): boolean => {
    try {
      return Boolean(mediaQuery && mediaQuery.matches);
    } catch {
      return false;
    }
  };

  const apply = (mode: MotionMode): MotionState => {
    state = { mode, resolved: resolveMotion(mode, systemReduced()) };
    if (root) {
      try {
        // 属性写**选择**，不是有效值：CSS 需要看到 'on' 才能把它从系统覆盖里排除。
        root.setAttribute(MOTION_ATTR, mode);
      } catch {
        // 属性写入失败不阻塞动效计算。
      }
    }
    if (!disposed) {
      for (const subscriber of [...subscribers]) {
        if (subscribers.has(subscriber)) {
          subscriber({ ...state });
        }
      }
    }
    return { ...state };
  };

  const onMediaChange = (): void => {
    apply(state.mode);
  };

  const onStorage = (event: Event): void => {
    if (disposed) {
      return;
    }
    const key = (event as StorageEvent).key;
    if (key !== MOTION_STORAGE_KEY && key !== null) {
      return;
    }
    let next: unknown = null;
    try {
      next = (event as StorageEvent).newValue ?? null;
      if (typeof next === 'string') {
        next = JSON.parse(next) as unknown;
      }
    } catch {
      next = null;
    }
    apply(normalizeMotionMode(next === null || next === undefined ? getStored() : next));
  };

  let readInitial: unknown = null;
  try {
    readInitial = getStored();
  } catch {
    readInitial = null;
  }
  apply(normalizeMotionMode(readInitial));

  const cleanup: Array<() => void> = [];
  try {
    if (mediaQuery?.addEventListener) {
      mediaQuery.addEventListener('change', onMediaChange);
      cleanup.push(() => mediaQuery?.removeEventListener?.('change', onMediaChange));
    } else if (mediaQuery?.addListener) {
      mediaQuery.addListener(onMediaChange);
      cleanup.push(() => mediaQuery?.removeListener?.(onMediaChange));
    }
  } catch {
    // 老内核缺少 addEventListener 时退化为不跟随变化（初始值仍然生效）。
  }
  try {
    if (eventTarget?.addEventListener) {
      eventTarget.addEventListener('storage', onStorage);
      cleanup.push(() => eventTarget.removeEventListener?.('storage', onStorage));
    }
  } catch {
    // ignore storage listener failures
  }

  return {
    getState() {
      return { ...state };
    },
    setMode(raw: unknown) {
      const next = normalizeMotionMode(raw);
      try {
        setStored(next);
      } catch {
        // 持久化失败仍然应用，避免「点了没反应」。
      }
      return apply(next);
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      subscribers.clear();
      for (const run of cleanup) {
        try {
          run();
        } catch {
          // ignore cleanup failures
        }
      }
      cleanup.length = 0;
    }
  };
}

let activeController: MotionController | null = null;

/**
 * 启动时装一次：注入样式表 + 应用持久化的选择。
 *
 * 幂等 —— `start()` 在同一个文档里可能被多个 frame 各调用一次，
 * 重复创建控制器会叠加 storage 监听。
 */
export function applyMotionPreference(options: MotionControllerOptions = {}): MotionState {
  try {
    ensureMotionStyle();
  } catch {
    // ignore style failures
  }
  if (activeController) {
    return activeController.getState();
  }
  activeController = createMotionController(options);
  return activeController.getState();
}

/** 当前控制器（测试与诊断用）。 */
export function getActiveMotionController(): MotionController | null {
  return activeController;
}

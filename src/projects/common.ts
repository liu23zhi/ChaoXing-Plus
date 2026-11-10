import type { AnswererWrapper, SearchInformation, SimplifyWorkResult, WorkUploadType, QuestionEvidence } from '../core/index.js';
import { DEFAULT_WORKER_THREAD_COUNT } from '../core/index.js';
import { Project, runtimeStore } from '../runtime/index.js';
import { $message, $modal } from '../runtime/message.js';
import { ensurePanelGlassLayer } from '../runtime/panel-glass.js';
import { mountWindowsHostLogPanel } from '../runtime/windows-host-log.js';
import type { ScriptPanel, ConfigDefinition } from '../runtime/types.js';
import { playbackRate, volume } from '../utils/configs.js';
import {
  createDefaultWorkResultsPanelUiState,
  toggleWorkResultsPanelCollapsed,
  formatEnabledStudyTaskCapabilitySummary,
  type WorkResultsPanelTab
} from './study-panel-state.js';
import { shouldShowFloatingPanel, isWindowsExamRelatedUrl } from './panel-visibility.js';
import {
  createHighPlaybackRateWarningState,
  warnOnHighPlaybackRate
} from './high-playback-rate-warning.js';
import {
  formatQuestionTypeLabel,
  formatWorkResultStatus,
  resolvePanelActivityState,
  describeSearchErrorNextStep,
  resolveWorkResultTone,
  summarizeSearchInfoError
} from './work-results-status.js';
import { shouldCacheSearchInfos } from './cx-retry-cache.js';
import { getTabAnswerPauseController } from './tab-answer-pause.js';
import {
  DEFAULT_TIKU_BASE_URL,
  TIKU_ADAPTER_BASEURL_KEY,
  TIKU_ADAPTER_KEY_KEY,
  createTikuAdapterAnswererWrapper,
  getTikuAdapterConfigProblem,
  isValidTikuAdapterBaseUrl,
  resolveTikuAdapterBaseUrl
} from './tiku-adapter-config.js';

export interface CommonWorkOptions {
  /**
   * @deprecated 历史遗留字段，**从未接线**。
   *
   * 它只被 `CustomOCSWorker`（死类，全仓无实例化）读取；真实答题路径
   * `OCSWorker` 内部既不读此值，也没有任何 `sleep`。保留是为了不破坏公开接口。
   *
   * **不要用它调答题节奏。** 答题节拍实际由 `searchDelaySeconds`
   * （搜题前等待，默认 3 秒）与网络往返共同决定。
   */
  period: number;
  /**
   * 搜题请求发出前的等待，单位**秒**。
   *
   * 与 `period` 分开是因为二者原本共用一个字段却按不同单位解释：搜题链路
   * （`cx.ts`）把它当秒并 `* 1000`，而 `CustomOCSWorker` 把同一个值当毫秒裸用。
   * 分开后两个旋钮各自单一单位，改一个不会误伤另一个。
   */
  searchDelaySeconds: number;
  thread: number;
  upload: WorkUploadType | 'submit';
  enableExamAutoSubmit: boolean;
  enableDebugLogPanel: boolean;
  enableLocalQuestionCache: boolean;
  answererWrappers: AnswererWrapper[];
  stopSecondWhenFinish: number;
  redundanceWordsText: string;
  answerSeparators: string;
  answerMatchMode: 'exact' | 'includes' | 'similar';
  enableRandomFallbackAnswer: boolean;
  enableAIFallbackAnswer: boolean;
  useAsyncTikuSearch: boolean;
  deepThinking: boolean;
  aiFallbackFailureAction: 'pause' | 'skip';
}

type WorkResultsRuntimeControls = {
  ownerDocument?: Document;
  isRunning: () => boolean;
  isStopped: () => boolean;
  stop: () => void;
  continuate: () => void;
  retryQuestion: (index: number, resetAnswer?: boolean) => Promise<SimplifyWorkResult | undefined>;
  canRetryQuestion?: (index: number) => boolean;
  clearAnswers?: () => void | Promise<void>;
  prepareReset?: () => void | Promise<void>;
  getQuestions?: () => SimplifyWorkResult[];
};

type WorkResultsView = 'numbers' | 'questions';
type QuestionPositionSyncHandlerType = 'cx';

type PanelPosition = {
  right: number;
  top: number;
};

type SearchCacheMode = 'normal' | 'deep';

interface QuestionCacheIdentity {
  type?: string;
  options?: string[] | string;
  questionEvidence?: QuestionEvidence;
}

interface NormalizedQuestionCacheIdentity {
  title: string;
  type: string;
  options: string[];
  questionEvidence?: QuestionEvidence;
}

interface QuestionCache {
  title: string;
  answer: string;
  from?: string;
  homepage?: string;
  ai?: boolean;
  mode?: SearchCacheMode;
  identity?: NormalizedQuestionCacheIdentity;
}

const WORK_RESULTS_PANEL_POSITION_KEY = 'common.work-results.panel-position';
const WINDOWS_PANEL_ENABLED_KEY = 'common.settings.windows-panel-enabled';
const WINDOWS_PANEL_COLLAPSED_KEY = 'common.settings.windows-panel-collapsed';
const WINDOWS_PANEL_TOP_KEY = 'common.settings.windows-panel-top';
const WINDOWS_PANEL_RIGHT_KEY = 'common.settings.windows-panel-right';
const WINDOWS_PANEL_WIDTH_KEY = 'common.settings.windows-panel-width';

const WORK_OPTIONS_KEY = 'common.settings.work-options';
const WORK_RESULTS_KEY = 'common.work-results.results';
const WORK_RESULTS_VIEW_KEY = 'common.work-results.type';
const QUESTION_CACHE_KEY = 'common.apps.question-caches';
const WINDOWS_NO_DISK_WRITE_KEY = 'common.settings.windows-no-disk-write';
const SHARED_STUDY_SETTINGS_PREFIX = 'cx.new.study.';

const SHARED_STORE_ATTRIBUTE_PREFIX = 'data-chaoxing-plus-shared-';
const lastSharedAttributeValues = new Map<string, string | null>();

// 滚动条样式节点 id（内部标识，不是用户可见标题）。
const PANEL_SCROLL_STYLE_ID = 'chaoxing-plus-panel-scroll-style';
// 小屏断点：面板在小屏下必须收窄，不能溢出视口。
const PANEL_NARROW_VIEWPORT_PX = 400;
const PANEL_MIN_VIEWPORT_MARGIN = 12;

function getSharedStoreAttributeName(key: string) {
  return `${SHARED_STORE_ATTRIBUTE_PREFIX}${key.replace(/[^a-z0-9_-]/gi, '-')}`;
}

function serializeSharedStoreValue(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function setRuntimeStoreValueFromPanel<T>(key: string, value: T) {
  const serialized = serializeSharedStoreValue(value);
  if (typeof serialized === 'string') {
    lastSharedAttributeValues.set(getSharedStoreAttributeName(key), serialized);
  }
  runtimeStore.set(key, value);
}

function shouldRefreshPanelForSharedValues(values: Record<string, unknown>) {
  let shouldRefreshPanel = false;

  for (const [key, value] of Object.entries(values)) {
    const serialized = serializeSharedStoreValue(value);
    if (typeof serialized !== 'string') {
      continue;
    }

    const attributeName = getSharedStoreAttributeName(key);
    if (lastSharedAttributeValues.get(attributeName) === serialized) {
      continue;
    }

    lastSharedAttributeValues.set(attributeName, serialized);
    shouldRefreshPanel = true;
  }

  return shouldRefreshPanel;
}

const WINDOWS_PANEL_THEME_KEY = 'common.settings.windows-panel-theme';
type PanelThemeName = 'pink' | 'blue' | 'green';

interface PanelPalette {
  primary: string;
  primaryDeep: string;
  primarySoft: string;
  primaryGradient: string;
  shellGradient: string;
  heroGradient: string;
  sectionGradient: string;
  surface: string;
  surfaceStrong: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  /**
   * 链接色：`primary` 在 green 主题下对白底只有 3.77:1，不能直接当文字色用。
   * 这里给每个主题一个达标的深色，仅供 anchor 文字使用。
   */
  link: string;
  /**
   * 三级文字：用于空状态、占位说明、辅助提示。必须同时在 surfaceStrong、
   * sectionGradient 底部与 primarySoft 上达到 WCAG AA 4.5:1，因此不再使用
   * `#94a3b8` 或半透明文字（实测分别只有 2.56:1 与 3.5:1）。
   */
  subtle: string;
  successFg: string;
  successBg: string;
  warningFg: string;
  warningBg: string;
  dangerFg: string;
  dangerBg: string;
  infoFg: string;
  infoBg: string;
  shadow: string;
  heroShadow: string;
  shellShadow: string;
  /** RGB 三元组（无 rgba 包裹），供面板内可复用的低透明度阴影使用。 */
  shadowRgb: string;
}

// Windows 面板内置浅色主题。--panel-theme 只接受下列名称，未知/空值回退 pink，
// 避免宿主收到任意长字符串后静默改变视觉。扩展端不设置该键，始终使用 pink。
const panelThemes: Record<PanelThemeName, PanelPalette> = {
  pink: {
    primary: '#db2777',
    primaryDeep: '#be185d',
    primarySoft: 'rgba(244, 114, 182, 0.14)',
    primaryGradient: 'linear-gradient(135deg, #be185d 0%, #db2777 100%)',
    // Windows / CEF75 与软件渲染环境下，半透明底色 + backdrop-filter + 大半径阴影会让悬浮窗周围
    // 出现模糊光晕；这里统一改成不透明底色 + 紧凑阴影，保证面板边缘与页面内容清晰。
    shellGradient: 'linear-gradient(145deg, #fff0f7 0%, #fffafd 48%, #ffecf4 100%)',
    heroGradient: 'radial-gradient(circle at 18% 0%, rgba(251, 207, 232, 0.82) 0%, transparent 32%), linear-gradient(135deg, #fff1f8 0%, #fff7fc 54%, #ffe4eb 100%)',
    sectionGradient: 'linear-gradient(180deg, #ffffff 0%, #fff1f8 100%)',
    surface: '#fffafd',
    surfaceStrong: '#ffffff',
    border: 'rgba(244, 114, 182, 0.24)',
    borderStrong: 'rgba(219, 39, 119, 0.34)',
    text: '#7a1039',
    muted: '#8a1a4d',
    link: '#be185d',
    subtle: '#7d2f52',
    successFg: '#14663b',
    successBg: 'rgba(34, 197, 94, 0.14)',
    warningFg: '#7a4c00',
    warningBg: 'rgba(250, 204, 21, 0.18)',
    dangerFg: '#a11818',
    dangerBg: 'rgba(239, 68, 68, 0.12)',
    infoFg: '#8a1a4d',
    infoBg: 'rgba(244, 114, 182, 0.16)',
    shadow: '0 8px 20px rgba(190, 24, 93, 0.10)',
    heroShadow: '0 8px 22px rgba(190, 24, 93, 0.14), inset 0 1px 0 rgba(255,255,255,0.72)',
    shellShadow: '0 10px 28px rgba(190, 24, 93, 0.16), 0 2px 8px rgba(190, 24, 93, 0.10)',
    shadowRgb: '190, 24, 93'
  },
  blue: {
    primary: '#2563eb',
    primaryDeep: '#1d4ed8',
    primarySoft: 'rgba(96, 165, 250, 0.14)',
    primaryGradient: 'linear-gradient(135deg, #1d4ed8 0%, #2563eb 100%)',
    shellGradient: 'linear-gradient(145deg, #f0f6ff 0%, #fbfdff 48%, #eaf2ff 100%)',
    heroGradient: 'radial-gradient(circle at 18% 0%, rgba(191, 219, 254, 0.82) 0%, transparent 32%), linear-gradient(135deg, #f2f7ff 0%, #f9fcff 54%, #e6efff 100%)',
    sectionGradient: 'linear-gradient(180deg, #ffffff 0%, #eff6ff 100%)',
    surface: '#f8fbff',
    surfaceStrong: '#ffffff',
    border: 'rgba(96, 165, 250, 0.26)',
    borderStrong: 'rgba(37, 99, 235, 0.34)',
    text: '#152e6b',
    muted: '#1a3fa0',
    link: '#1d4ed8',
    subtle: '#2b3f6b',
    successFg: '#14663b',
    successBg: 'rgba(34, 197, 94, 0.14)',
    warningFg: '#7a4c00',
    warningBg: 'rgba(250, 204, 21, 0.18)',
    dangerFg: '#a11818',
    dangerBg: 'rgba(239, 68, 68, 0.12)',
    infoFg: '#1a3fa0',
    infoBg: 'rgba(96, 165, 250, 0.16)',
    shadow: '0 8px 20px rgba(30, 64, 175, 0.10)',
    heroShadow: '0 8px 22px rgba(30, 64, 175, 0.14), inset 0 1px 0 rgba(255,255,255,0.72)',
    shellShadow: '0 10px 28px rgba(30, 64, 175, 0.16), 0 2px 8px rgba(30, 64, 175, 0.10)',
    shadowRgb: '30, 64, 175'
  },
  green: {
    primary: '#059669',
    primaryDeep: '#047857',
    primarySoft: 'rgba(52, 211, 153, 0.14)',
    primaryGradient: 'linear-gradient(135deg, #065f46 0%, #047857 100%)',
    shellGradient: 'linear-gradient(145deg, #ecfdf5 0%, #f9fffc 48%, #d1fae5 100%)',
    heroGradient: 'radial-gradient(circle at 18% 0%, rgba(167, 243, 208, 0.82) 0%, transparent 32%), linear-gradient(135deg, #effcf6 0%, #f8fffb 54%, #dcfce7 100%)',
    sectionGradient: 'linear-gradient(180deg, #ffffff 0%, #ecfdf5 100%)',
    surface: '#f7fffb',
    surfaceStrong: '#ffffff',
    border: 'rgba(52, 211, 153, 0.26)',
    borderStrong: 'rgba(5, 150, 105, 0.34)',
    text: '#04392b',
    muted: '#035743',
    link: '#035743',
    subtle: '#2b4a3f',
    successFg: '#12593a',
    successBg: 'rgba(34, 197, 94, 0.16)',
    warningFg: '#6d4300',
    warningBg: 'rgba(250, 204, 21, 0.18)',
    dangerFg: '#961616',
    dangerBg: 'rgba(239, 68, 68, 0.12)',
    infoFg: '#035743',
    infoBg: 'rgba(52, 211, 153, 0.16)',
    shadow: '0 8px 20px rgba(6, 78, 59, 0.10)',
    heroShadow: '0 8px 22px rgba(6, 78, 59, 0.14), inset 0 1px 0 rgba(255,255,255,0.72)',
    shellShadow: '0 10px 28px rgba(6, 78, 59, 0.16), 0 2px 8px rgba(6, 78, 59, 0.10)',
    shadowRgb: '6, 78, 59'
  }
};

function resolvePanelThemeName(): PanelThemeName {
  try {
    const raw = runtimeStore.get<unknown>(WINDOWS_PANEL_THEME_KEY, 'pink');
    const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return Object.prototype.hasOwnProperty.call(panelThemes, name) ? name as PanelThemeName : 'pink';
  } catch {
    return 'pink';
  }
}

function panelShadowColor(alpha: number): string {
  return `rgba(${panelPinkTheme.shadowRgb}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// 面板视觉 token：字号 / 字重 / 间距 / 触控目标集中定义，保证同类控件在面板各处一致。
// 只使用 Chrome 75 支持的属性（无 :has()、无 aspect-ratio、无容器查询）。
// ---------------------------------------------------------------------------

/** 触控目标最小高度：低于 32px 时小屏与触摸板容易点错。 */
const PANEL_TOUCH_TARGET_MIN_HEIGHT = '32px';

/**
 * 面板唯一的注入样式表：滚动条外观 + 进行中状态的脉冲提示。
 * 内容随主题变化重建；只用 Chrome 75 支持的选择器与属性，
 * 不引入外部 CSS/字体，也不使用 :has()、aspect-ratio、容器查询。
 */
function ensurePanelStyleSheet(ownerDocument: Document) {
  try {
    const doc = ownerDocument ?? document;
    let style = doc.getElementById(PANEL_SCROLL_STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = doc.createElement('style');
      style.id = PANEL_SCROLL_STYLE_ID;
      (doc.head || doc.documentElement).appendChild(style);
    }
    const thumb = panelPinkTheme.borderStrong;
    const nextText = `[data-cx-scroll-pane="true"] { scrollbar-width: thin; scrollbar-color: ${thumb} transparent; }
[data-cx-scroll-pane="true"]::-webkit-scrollbar { width: 8px; height: 8px; }
[data-cx-scroll-pane="true"]::-webkit-scrollbar-thumb { background: ${thumb}; border-radius: 8px; }
[data-cx-scroll-pane="true"]::-webkit-scrollbar-track { background: transparent; }
@keyframes cx-panel-status-pulse {
  0% { opacity: 1; }
  50% { opacity: 0.35; }
  100% { opacity: 1; }
}
[data-cx-panel-pulse="true"] { animation: cx-panel-status-pulse 1.6s ease-in-out infinite; }`;
    if (style.textContent !== nextText) {
      style.textContent = nextText;
    }
  } catch {
    // 插入失败只影响滚动条与脉冲外观，不影响任何功能。
  }
}

function applyThinScrollbar(element: HTMLElement) {
  element.dataset.cxScrollPane = 'true';
  element.style.scrollbarWidth = 'thin';
  ensurePanelStyleSheet(element.ownerDocument);
}

/** 长列表容器：最大高度 + 内部滚动，避免题目/答案/日志把面板撑爆。 */
function applyScrollPaneStyle(element: HTMLElement, maxHeight: number) {
  element.style.maxHeight = `${Math.max(120, Math.round(maxHeight))}px`;
  element.style.overflowY = 'auto';
  element.style.overflowX = 'hidden';
  element.style.overscrollBehavior = 'contain';
  element.style.paddingRight = '4px';
  applyThinScrollbar(element);
}

/** 分组/区块标题：字号、字重、行高三项同时区分，不只靠颜色。 */
function applySectionTitleStyle(element: HTMLElement, level: 'hero' | 'section' | 'group') {
  if (level === 'hero') {
    element.style.fontSize = '17px';
    element.style.fontWeight = '800';
    element.style.lineHeight = '1.35';
    element.style.letterSpacing = '0.01em';
  } else if (level === 'section') {
    element.style.fontSize = '15px';
    element.style.fontWeight = '800';
    element.style.lineHeight = '1.4';
  } else {
    element.style.fontSize = '13px';
    element.style.fontWeight = '700';
    element.style.lineHeight = '1.45';
    element.style.letterSpacing = '0.02em';
  }
  element.style.color = panelPinkTheme.text;
}

/** 说明性小字：使用三级文字色（subtle），三主题下均 ≥ 4.5:1。 */
function applyHintTextStyle(element: HTMLElement) {
  element.style.fontSize = '12px';
  element.style.lineHeight = '1.6';
  element.style.color = panelPinkTheme.subtle;
}

/** 输入框 / 下拉框 / 文本框的统一外观，保证同类控件在面板各处一致。 */
function applyControlChrome(element: HTMLElement) {
  element.style.minHeight = PANEL_TOUCH_TARGET_MIN_HEIGHT;
  element.style.padding = '8px 10px';
  element.style.borderRadius = '10px';
  element.style.border = `1px solid ${panelPinkTheme.border}`;
  element.style.background = panelPinkTheme.surfaceStrong;
  element.style.color = panelPinkTheme.text;
  element.style.fontSize = '13px';
  element.style.lineHeight = '1.5';
  element.style.boxSizing = 'border-box';
}

/**
 * 面板顶部页签栏。
 *
 * 为什么要有它：面板原本把「状态 / 结果 / 题库配置 / 缓存 / 学习设置」纵向堆在一个
 * grid 里，实测要滚很远才能到设置区。改成互斥页签后每个页签的内容都能一屏放下。
 *
 * 约定：
 * - 用 `role="tablist"` + `role="tab"` + `aria-selected`，键盘可达（button 本身可 Tab 聚焦）；
 * - 选中态用「底部 3px 实色下划线 + 加粗 + 主色文字」三重编码，不只靠颜色；
 * - 触控目标沿用 PANEL_TOUCH_TARGET_MIN_HEIGHT（≥32px），窄屏下横向可滚动而不换行挤压。
 */
function createPanelTabBar(
  tabs: Array<{ id: WorkResultsPanelTab; label: string }>,
  active: WorkResultsPanelTab,
  onSelect: (tab: WorkResultsPanelTab) => void
) {
  const bar = createElement('div');
  bar.dataset.cxPanelTabBar = 'true';
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', '面板分区');
  bar.style.display = 'flex';
  bar.style.gap = '4px';
  bar.style.flexWrap = 'nowrap';
  bar.style.overflowX = 'auto';
  bar.style.paddingBottom = '2px';
  // tab 栏横向滚动只需要细滚动条，不能套 applyThinScrollbar：
  // 它会打上 data-cx-scroll-pane，而视觉回归把该标记当作「长列表容器」，
  // 断言其必须有 maxHeight —— tab 栏本来就不该限高，套上去会误报。
  bar.style.scrollbarWidth = 'thin';
  ensurePanelStyleSheet(bar.ownerDocument);

  for (const tab of tabs) {
    const selected = tab.id === active;
    const button = createElement('button', { text: tab.label });
    button.type = 'button';
    button.dataset.cxPanelTab = tab.id;
    button.dataset.cxPanelTabActive = selected ? 'true' : 'false';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.style.flex = '0 0 auto';
    button.style.minHeight = PANEL_TOUCH_TARGET_MIN_HEIGHT;
    button.style.padding = '0 10px';
    button.style.border = 'none';
    button.style.borderRadius = '10px 10px 0 0';
    button.style.cursor = 'pointer';
    button.style.fontSize = '13px';
    button.style.fontWeight = selected ? '800' : '600';
    // 选中用 primaryDeep（不是 primary）：primary 在 green 主题下对白底只有 3.77:1，
    // 而 tab 选中态的背景是 surfaceStrong（近白），必须用达标的深色。
    button.style.color = selected ? panelPinkTheme.primaryDeep : panelPinkTheme.muted;
    button.style.background = selected ? panelPinkTheme.surfaceStrong : 'transparent';
    // 三重编码：选中不仅是变色，还有下划线与字重（色觉差异下仍可分辨）。
    button.style.borderBottom = selected
      ? `3px solid ${panelPinkTheme.primary}`
      : `3px solid transparent`;
    button.onclick = () => onSelect(tab.id);
    bar.append(button);
  }

  return bar;
}

/**
 * 一个页签的内容容器：只有 active 的那个显示，其余 display:none。
 *
 * 用 display 而不是不渲染，是为了保留各板块已有的滚动位置与表单焦点，
 * 切回来时不会跳回顶部（面板原本就有 replaceChildren 重建，这里再丢状态会更糟）。
 */
function createPanelTabPanel(tab: WorkResultsPanelTab, active: WorkResultsPanelTab) {
  const panel = createElement('div');
  panel.dataset.cxPanelTabPanel = tab;
  panel.setAttribute('role', 'tabpanel');
  if (tab !== active) {
    panel.style.display = 'none';
  }
  panel.style.display = tab === active ? 'grid' : 'none';
  panel.style.gap = '14px';
  return panel;
}

/**
 * 「当前在做什么」状态条：七个状态互斥，颜色 + 文字双重表达（不只靠颜色），
 * 进行中的状态带脉冲，切换时用户能立刻看到变化。
 */
function createPanelStatusStrip(input: { results: SimplifyWorkResult[]; paused: boolean; running: boolean }) {
  const snapshot = resolvePanelActivityState(input);
  // 状态条底色必须是纯白不透明：彩色半透明底会把正文对比度拉到 4.04:1（pink 实测），
  // 状态差异改由 4px 左边框色 + 圆点 + 文字共同表达（三重编码，不只靠颜色）。
  const accentByTone: Record<string, string> = {
    idle: panelPinkTheme.muted,
    active: panelPinkTheme.primary,
    paused: panelPinkTheme.warningFg,
    manual: panelPinkTheme.warningFg,
    success: panelPinkTheme.successFg,
    danger: panelPinkTheme.dangerFg
  };
  const accent = accentByTone[snapshot.tone] ?? accentByTone.idle;

  const strip = createElement('div');
  strip.dataset.cxPanelStatus = snapshot.state;
  strip.setAttribute('role', 'status');
  strip.setAttribute('aria-live', 'polite');
  strip.style.display = 'grid';
  strip.style.gap = '4px';
  strip.style.padding = '10px 12px';
  strip.style.borderRadius = '12px';
  strip.style.background = panelPinkTheme.surfaceStrong;
  strip.style.border = `1px solid ${panelPinkTheme.border}`;
  strip.style.borderLeft = `4px solid ${accent}`;

  const labelRow = createElement('div');
  labelRow.style.display = 'flex';
  labelRow.style.alignItems = 'center';
  labelRow.style.gap = '8px';

  const dot = createElement('span');
  dot.style.display = 'inline-block';
  dot.style.width = '8px';
  dot.style.height = '8px';
  dot.style.borderRadius = '999px';
  dot.style.background = accent;
  dot.style.flex = '0 0 auto';
  if (snapshot.pulse) {
    dot.dataset.cxPanelPulse = 'true';
  }

  const label = createElement('div', { text: snapshot.label });
  label.style.fontSize = '13px';
  label.style.fontWeight = '800';
  label.style.lineHeight = '1.4';
  // 白底上用状态专用深色，四态对比度均 ≥ 4.5:1（见 scripts/panel-ui-contrast.test.mjs）。
  label.style.color = snapshot.tone === 'danger' ? panelPinkTheme.dangerFg
    : snapshot.tone === 'success' ? panelPinkTheme.successFg
      : snapshot.tone === 'paused' || snapshot.tone === 'manual' ? panelPinkTheme.warningFg
        : panelPinkTheme.text;

  labelRow.append(dot, label);

  const detail = createElement('div', { text: snapshot.detail });
  detail.style.fontSize = '12px';
  detail.style.lineHeight = '1.6';
  detail.style.color = panelPinkTheme.text;

  strip.append(labelRow, detail);
  return strip;
}



// 保留既有调用点：所有 `panelPinkTheme.<prop>` 读取都解析为当前主题色板，
// 主题在配置热更新后由共享设置 observer 触发重渲染并重新取色。
const panelPinkTheme: PanelPalette = new Proxy({} as PanelPalette, {
  get(_target, property: string | symbol): unknown {
    if (typeof property !== 'string') {
      return undefined;
    }
    return panelThemes[resolvePanelThemeName()][property as keyof PanelPalette];
  }
});

const defaultWorkOptions: CommonWorkOptions = {
  // 历史遗留，从未接线：真实答题路径（OCSWorker）不读此值，详见接口注释。
  period: 3,
  // 搜题请求发出前的等待（秒），保持既有 3 秒节奏不变。
  searchDelaySeconds: 3,
  thread: DEFAULT_WORKER_THREAD_COUNT,
  upload: 'submit',
  enableExamAutoSubmit: false,
  enableDebugLogPanel: false,
  enableLocalQuestionCache: true,
  answererWrappers: [],
  stopSecondWhenFinish: 3,
  redundanceWordsText: '',
  answerSeparators: '#,|,;,；',
  answerMatchMode: 'includes',
  enableRandomFallbackAnswer: false,
  enableAIFallbackAnswer: true,
  useAsyncTikuSearch: true,
  deepThinking: false,
  aiFallbackFailureAction: 'pause'
};

const answerCache = new Map<string, SearchInformation[]>();
const highPlaybackRateWarningState = createHighPlaybackRateWarningState();

function canShowFloatingPanel() {
  try {
    // Windows 端只服务考试/答题场景：登录页、课程页、跳转页不创建面板，
    // 避免跨页面跳转时面板反复消失/出现。扩展端没有 __CX_WIN_HOST__，行为不变。
    if (isWindowsHostRuntime() && runtimeStore.get<boolean>(WINDOWS_PANEL_ENABLED_KEY, true) === false) {
      return false;
    }
    const forcePanelAllPages = (window as unknown as { __CX_WIN_PANEL_ALL_PAGES__?: unknown }).__CX_WIN_PANEL_ALL_PAGES__ === true;
  if (isWindowsHostRuntime() && !forcePanelAllPages && !isWindowsExamRelatedUrl(window.location.href)) {
      return false;
    }

    return shouldShowFloatingPanel({
      selfWindow: window.self,
      topWindow: window.top,
      parentWindow: window.parent
    });
  } catch {
    return true;
  }
}

function parseStoredValue<T>(raw: string | null, fallback: T): T {
  if (raw === null) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isWindowsHostRuntime() {
  try {
    return Boolean((window as unknown as { __CX_WIN_HOST__?: unknown }).__CX_WIN_HOST__);
  } catch {
    return false;
  }
}

// 宿主 --no-disk-write 通过共享设置下发：Windows 端关闭题库缓存的读写与本地持久化。
// 扩展端没有宿主注入，行为保持不变。
function isWindowsNoDiskWrite() {
  try {
    return isWindowsHostRuntime() && runtimeStore.get<boolean>(WINDOWS_NO_DISK_WRITE_KEY, false) === true;
  } catch {
    return false;
  }
}

function resolveInitialWorkResultsPanelUiState() {
  const ui = createDefaultWorkResultsPanelUiState();
  // Windows 端默认折叠面板；Chrome 扩展不注入 __CX_WIN_HOST__，保持原有默认展开行为。
  if (isWindowsHostRuntime()) {
    // bootstrap 提前挂载的折叠壳被点击时，业务加载后直接展开，避免用户点击被丢弃。
    const shellExpandRequested = Boolean(
      (window as unknown as { __CX_WIN_SHELL_EXPAND_REQUESTED__?: unknown }).__CX_WIN_SHELL_EXPAND_REQUESTED__
    );
    ui.collapsed = !shellExpandRequested;
    if (!shellExpandRequested) {
      ui.collapsed = runtimeStore.get(WINDOWS_PANEL_COLLAPSED_KEY, true);
    }
  }
  return ui;
}

function resolveInitialWindowsPanelPosition(): PanelPosition {
  const stored = runtimeStore.get(WORK_RESULTS_PANEL_POSITION_KEY, { right: 16, top: 16 } as PanelPosition);
  if (!isWindowsHostRuntime()) return stored;
  const readNumber = (key: string, fallback: number) => {
    const value = Number(runtimeStore.get(key, fallback));
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
  };
  return {
    right: readNumber(WINDOWS_PANEL_RIGHT_KEY, stored.right),
    top: readNumber(WINDOWS_PANEL_TOP_KEY, stored.top)
  };
}

function resolveInitialWindowsPanelWidth() {
  if (!isWindowsHostRuntime()) return 460;
  const width = Number(runtimeStore.get(WINDOWS_PANEL_WIDTH_KEY, 460));
  return Number.isFinite(width) ? Math.min(800, Math.max(320, width)) : 460;
}

const state = {
  panels: {
    workResults: undefined as ScriptPanel | undefined,
    apps: undefined as ScriptPanel | undefined
  },
  workResultsPanelPosition: resolveInitialWindowsPanelPosition(),
  workResultsPanelWidth: resolveInitialWindowsPanelWidth(),
  workResults: {
    results: runtimeStore.get(WORK_RESULTS_KEY, [] as SimplifyWorkResult[]),
    currentResultIndex: 0,
    type: runtimeStore.get(WORK_RESULTS_VIEW_KEY, 'numbers' as WorkResultsView),
    questionPositionSyncHandlerType: undefined as QuestionPositionSyncHandlerType | undefined,
    runtimeControls: undefined as WorkResultsRuntimeControls | undefined,
    resetOperation: undefined as object | undefined,
    resetGeneration: 0,
    controlDocument: document,
    ui: resolveInitialWorkResultsPanelUiState()
  },
  apps: {
    localQuestionCaches: isWindowsNoDiskWrite() ? [] : runtimeStore.get(QUESTION_CACHE_KEY, [] as QuestionCache[])
  }
};

const tabAnswerPause = getTabAnswerPauseController();
const unsubscribeTabAnswerPause = tabAnswerPause.subscribe(() => {
  syncWorkResultsControlDocument();
  const controls = state.workResults.runtimeControls;
  if (controls?.isRunning()) {
    if (tabAnswerPause.isPaused() && !controls.isStopped()) controls.stop();
    if (!tabAnswerPause.isPaused() && controls.isStopped()) controls.continuate();
  }
  renderWorkResultsPanel();
});
window.addEventListener('pagehide', unsubscribeTabAnswerPause, { once: true });

function applyQuestionCaches(value: unknown) {
  if (isWindowsNoDiskWrite()) {
    state.apps.localQuestionCaches = [];
    answerCache.clear();
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }

  state.apps.localQuestionCaches = value as QuestionCache[];
  answerCache.clear();
  renderAppsPanel();
  return true;
}

const questionPositionSyncHandlers: Record<QuestionPositionSyncHandlerType, (index: number) => void> = {
  cx(index) {
    const currentRoots = document.querySelectorAll<HTMLElement>('.singleQuesId');
    const el = (currentRoots.length > 0
      ? currentRoots
      : document.querySelectorAll<HTMLElement>('[id*="sigleQuestionDiv"], .questionLi'))?.item(index);
    if (el) {
      window.scrollTo({
        top: el.getBoundingClientRect().top + window.pageYOffset - 50,
        behavior: 'smooth'
      });
    }
  }
};

export function getStoredTikuAdapterConfig() {
  const baseurl = runtimeStore.get(TIKU_ADAPTER_BASEURL_KEY, DEFAULT_TIKU_BASE_URL);
  const key = runtimeStore.get(TIKU_ADAPTER_KEY_KEY, '');
  const scriptIdentity = runtimeStore.get('common.settings.tiku-adapter.script-identity', '');

  return {
    baseurl: typeof baseurl === 'string' ? baseurl : DEFAULT_TIKU_BASE_URL,
    key: typeof key === 'string' ? key : '',
    scriptIdentity: typeof scriptIdentity === 'string' ? scriptIdentity : ''
  };
}

function getWorkOptions(): CommonWorkOptions {
  const stored = runtimeStore.get(WORK_OPTIONS_KEY, defaultWorkOptions);
  const tikuConfig = getStoredTikuAdapterConfig();
  const useAsyncTikuSearch = getStudySettingValue('useAsyncTikuSearch', stored.useAsyncTikuSearch ?? true);
  const resolvedBaseurl = resolveTikuAdapterBaseUrl(tikuConfig.baseurl, DEFAULT_TIKU_BASE_URL);
  const dynamicProblem = getTikuAdapterConfigProblem({
    baseurl: resolvedBaseurl,
    key: tikuConfig.key
  });

  const dynamicWrapper = dynamicProblem
    ? undefined
    : createTikuAdapterAnswererWrapper({
        baseurl: resolvedBaseurl,
        key: tikuConfig.key,
        scriptIdentity: tikuConfig.scriptIdentity,
        asyncSearch: useAsyncTikuSearch
      });

  return {
    ...stored,
    thread: (() => {
      const configuredThreads = Number.parseInt(String(runtimeStore.get('common.settings.windows-answer-threads', stored.thread)), 10);
      return Number.isFinite(configuredThreads)
        ? Math.max(1, Math.min(4, configuredThreads))
        : stored.thread;
    })(),
    upload: getStudySettingValue('upload', 'submit'),
    enableExamAutoSubmit: getStudySettingValue('enableExamAutoSubmit', stored.enableExamAutoSubmit ?? false),
    enableDebugLogPanel: getStudySettingValue('enableDebugLogPanel', stored.enableDebugLogPanel ?? false),
    enableLocalQuestionCache: getStudySettingValue('enableLocalQuestionCache', stored.enableLocalQuestionCache ?? true),
    enableRandomFallbackAnswer: getStudySettingValue(
      'enableRandomFallbackAnswer',
      stored.enableRandomFallbackAnswer ?? false
    ),
    enableAIFallbackAnswer: getStudySettingValue('enableAIFallbackAnswer', true),
    useAsyncTikuSearch,
    deepThinking: getStudySettingValue('deepThinking', stored.deepThinking ?? false),
    aiFallbackFailureAction: getStudySettingValue('aiFallbackFailureAction', stored.aiFallbackFailureAction ?? 'pause'),
    answererWrappers: dynamicWrapper ? [dynamicWrapper] : []
  };
}

function hasUsableWorkResultAnswer(result: SimplifyWorkResult | undefined) {
  return Boolean(
    result?.searchInfos.some((info) =>
      info.results.some((entry) => String(entry[1] ?? '').trim().length > 0)
    )
  );
}

function shouldPreserveExistingWorkResult(existing: SimplifyWorkResult | undefined, incoming: SimplifyWorkResult) {
  return Boolean(
    existing?.finish &&
      hasUsableWorkResultAnswer(existing) &&
      !(incoming.finish && hasUsableWorkResultAnswer(incoming))
  );
}

function mergeIncomingWorkResults(results: SimplifyWorkResult[]) {
  return results.map((item, index) => {
    const existing = state.workResults.results[index];
    if (existing && shouldPreserveExistingWorkResult(existing, item)) {
      return {
        ...existing,
        type: item.type ?? existing.type,
        retrying: item.retrying ?? existing.retrying ?? false,
        manual: item.manual ?? existing.manual ?? false
      };
    }

    return {
      ...item,
      type: item.type ?? existing?.type,
      manual: item.manual ?? existing?.manual ?? false,
      retrying: item.retrying ?? existing?.retrying ?? false
    };
  });
}

function patchWorkResult(index: number, patch: Partial<SimplifyWorkResult>) {
  if (!state.workResults.results[index]) {
    return;
  }

  const next = state.workResults.results.slice();
  next[index] = {
    ...next[index],
    ...patch
  };
  setWorkResults(next);
}

function setWorkResults(results: SimplifyWorkResult[]) {
  state.workResults.results = mergeIncomingWorkResults(results);
  if (state.workResults.currentResultIndex >= state.workResults.results.length) {
    state.workResults.currentResultIndex = Math.max(state.workResults.results.length - 1, 0);
  }
  runtimeStore.set(WORK_RESULTS_KEY, state.workResults.results);
  renderWorkResultsPanel();
}

async function clearAndRetryWorkResults() {
  syncWorkResultsControlDocument();
  const controls = state.workResults.runtimeControls;
  if (state.workResults.resetOperation) return;
  if (!controls?.clearAnswers) {
    setWorkResults([]);
    return;
  }

  const operation = {};
  state.workResults.resetGeneration = (state.workResults.resetGeneration ?? 0) + 1;
  const isCurrent = () => {
    if (state.workResults.runtimeControls !== controls || state.workResults.resetOperation !== operation) return false;
    try {
      return !controls.ownerDocument || controls.ownerDocument.defaultView?.document === controls.ownerDocument;
    } catch { return false; }
  };
  state.workResults.resetOperation = operation;
  renderWorkResultsPanel();
  try {
    await controls.prepareReset?.();
    if (!isCurrent()) return;
    // Clear every page before publishing unanswered results or applying any new answer.
    await controls.clearAnswers();
    if (!isCurrent()) return;
    const questions = (controls.getQuestions?.() ?? state.workResults.results).map(({ question, type, searchIdentity }) => ({
      question, type, searchIdentity, searchInfos: [], requested: false, resolved: false,
      finish: false, manual: false, retrying: false, searching: false
    }));
    setWorkResults([]); // Bypass preservation of successful results from the previous run.
    setWorkResults(questions);
    for (let index = 0; index < questions.length && isCurrent(); index++) {
      try {
        const retried = await controls.retryQuestion(index, true);
        if (!isCurrent()) return;
        if (retried) patchWorkResult(index, { ...retried, manual: false, retrying: false });
        else patchWorkResult(index, { retrying: false });
      } catch (error) {
        if (!isCurrent()) return;
        patchWorkResult(index, { retrying: false, error: (error as Error).message || String(error) });
      }
    }
  } catch (error) {
    if (isCurrent()) $message.error('清空作答失败：' + ((error as Error).message || String(error)));
  } finally {
    if (state.workResults.resetOperation === operation) {
      state.workResults.resetOperation = undefined;
      renderWorkResultsPanel();
    }
  }
}

function saveWorkResultsPanelPosition(position: PanelPosition) {
  state.workResultsPanelPosition = position;
  runtimeStore.set(WORK_RESULTS_PANEL_POSITION_KEY, position);
}

function getDevicePixelRatio() {
  const ratio = window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

// 面板是 fixed 定位：位置必须落在设备像素网格上，否则在 125%/150% 缩放的 Windows 客户端里
// 会因亚像素定位导致文字/边框发虚（拖动后尤其明显）。
function snapToDevicePixel(value: number) {
  const ratio = getDevicePixelRatio();
  return Math.round(value * ratio) / ratio;
}

// 外宽也必须落在设备像素网格上：右侧位置对齐后，若宽度是小数设备像素，
// 左边缘仍会亚像素发虚（125%/150% 缩放下 490 CSS px = 612.5 设备像素）。
function snapPanelOuterWidth(element: HTMLElement) {
  const ratio = getDevicePixelRatio();
  const rect = element.getBoundingClientRect();
  if (!rect.width) {
    return;
  }
  const snappedWidth = Math.round(rect.width * ratio) / ratio;
  if (Math.abs(snappedWidth - rect.width) <= 0.01) {
    return;
  }
  element.style.boxSizing = 'border-box';
  element.style.width = `${snappedWidth}px`;
}

function clampPanelPosition(position: PanelPosition, width = 460) {
  const maxTop = Math.max(window.innerHeight - 120, 16);
  const maxRight = Math.max(window.innerWidth - 120, 16);
  return {
    top: snapToDevicePixel(Math.min(Math.max(position.top, 16), maxTop)),
    right: snapToDevicePixel(Math.min(Math.max(position.right, 16), maxRight + Math.max(width - 120, 0)))
  };
}

function bindPanelDrag(panel: ScriptPanel, kind: 'workResults' | 'apps') {
  if (kind !== 'workResults') {
    return;
  }

  const root = panel.root;
  const handle = panel.lockWrapper;
  handle.style.display = 'flex';
  handle.style.alignItems = 'center';
  handle.style.justifyContent = 'space-between';
  handle.style.margin = '-14px -14px 12px';
  handle.style.cursor = 'move';
  handle.style.userSelect = 'none';
  handle.style.touchAction = 'none';
  handle.style.padding = '14px 14px 12px';
  handle.style.borderBottom = `1px solid ${panelPinkTheme.border}`;
  handle.style.position = 'sticky';
  handle.style.top = '-14px';
  handle.style.zIndex = '3';
  handle.style.background = panelPinkTheme.surface;
  handle.style.boxShadow = `0 6px 16px ${panelShadowColor(0.08)}`;

  const rootWithHeaderState = root as HTMLElement & {
    __cxHeaderHandle?: HTMLElement;
    __cxHeaderHint?: HTMLDivElement;
  };

  const title = createElement('div', { text: '超星学习助手' });
  title.style.fontSize = '13px';
  title.style.fontWeight = '800';
  title.style.color = panelPinkTheme.text;
  title.style.letterSpacing = '0.02em';

  const hint = createElement('div', { text: '点击折叠 · 可拖动' });
  hint.style.fontSize = '12px';
  hint.style.color = panelPinkTheme.muted;

  rootWithHeaderState.__cxHeaderHandle = handle;
  rootWithHeaderState.__cxHeaderHint = hint;

  handle.setAttribute('role', 'button');
  handle.tabIndex = 0;
  handle.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleWorkResultsPanelVisibility();
    }
  };

  handle.replaceChildren(title, hint);
  syncWorkResultsPanelVisibility(panel);

  if ((root as any).__cxDragBound) {
    return;
  }
  (root as any).__cxDragBound = true;

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }

    const rect = root.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startTop = rect.top;
    const startRight = window.innerWidth - rect.right;
    let dragged = false;

    const onMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (!dragged && Math.hypot(deltaX, deltaY) < 6) {
        return;
      }

      dragged = true;
      const next = clampPanelPosition(
        {
          top: startTop + deltaY,
          right: startRight - deltaX
        },
        rect.width
      );
      saveWorkResultsPanelPosition(next);
      applyPanelVisual(root === state.panels.workResults?.root ? state.panels.workResults : undefined, 'workResults');
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!dragged) {
        toggleWorkResultsPanelVisibility();
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function getStudySettingValue<T>(key: string, fallback: T): T {
  return runtimeStore.get(`cx.new.study.${key}`, fallback);
}

function isMediaElement(value: unknown): value is HTMLMediaElement {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as HTMLMediaElement).play === 'function' &&
      typeof (value as HTMLMediaElement).pause === 'function'
  );
}

function collectStudyMediaElements() {
  const medias: HTMLMediaElement[] = [];
  const push = (media: HTMLMediaElement | null | undefined) => {
    if (media && medias.includes(media) === false) {
      medias.push(media);
    }
  };

  try {
    const currentMedia = (window.top ?? window) as Window & Record<string, unknown>;
    if (isMediaElement(currentMedia.currentMedia)) {
      push(currentMedia.currentMedia);
    }
  } catch {
    // ignore cross-origin access failures
  }

  const docs = new Set<Document>();
  docs.add(document);
  try {
    docs.add((window.top ?? window).document);
  } catch {
    // ignore cross-origin access failures
  }

  docs.forEach((doc) => {
    doc.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => push(media));
  });

  return medias;
}

function isSharedStudySettingKey(key: string) {
  return key.startsWith(SHARED_STUDY_SETTINGS_PREFIX);
}

function syncStudySettingCrossDomain(key: string, value: unknown) {
  setRuntimeStoreValueFromPanel(key, value);
}

function applyStudySettingRuntimeEffect(key: string, value: unknown) {
  if (!['playbackRate', 'volume', 'muteMedia'].includes(key)) {
    return;
  }

  const medias = collectStudyMediaElements();
  if (medias.length === 0) {
    return;
  }

  medias.forEach((media) => {
    if (key === 'playbackRate') {
      const rate = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(rate) && rate > 0) {
        media.playbackRate = rate;
      }
      return;
    }

    if (key === 'volume') {
      const volume = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(volume)) {
        media.volume = Math.min(1, Math.max(0, volume));
      }
      return;
    }

    if (key === 'muteMedia') {
      media.muted = Boolean(value);
    }
  });
}

function maybeWarnHighPlaybackRate(script: { cfg: Record<string, unknown>; namespace?: string }, value: unknown) {
  void warnOnHighPlaybackRate(highPlaybackRateWarningState, value, {
    confirm: (prompt) => $modal.confirm(prompt),
    restorePlaybackRate: (rate) => setStudySettingValueInternal(script, 'playbackRate', rate, { warn: false })
  });
}

function setStudySettingValueInternal(
  script: { cfg: Record<string, unknown>; namespace?: string },
  key: string,
  value: unknown,
  options: { warn?: boolean; render?: boolean } = {}
) {
  const setValue = (nextKey: string, nextValue: unknown) => {
    script.cfg[nextKey] = nextValue;
    const storageKey = `${script.namespace}.${nextKey}`;
    if (isSharedStudySettingKey(storageKey)) {
      syncStudySettingCrossDomain(storageKey, nextValue);
    } else {
      setRuntimeStoreValueFromPanel(storageKey, nextValue);
    }
    applyStudySettingRuntimeEffect(nextKey, nextValue);
  };

  if (key === 'volume') {
    const normalizedVolume = Math.min(1, Math.max(0, typeof value === 'number' ? value : Number(value)));
    setValue('volume', normalizedVolume);
    setValue('muteMedia', normalizedVolume <= 0);
    if (options.render !== false) {
      renderWorkResultsPanel();
    }
    return;
  }

  if (key === 'muteMedia') {
    const muted = Boolean(value);
    setValue('muteMedia', muted);
    if (muted) {
      setValue('volume', 0);
    }
    if (options.render !== false) {
      renderWorkResultsPanel();
    }
    return;
  }

  setValue(key, value);
  if (key === 'playbackRate' && options.warn !== false) {
    void maybeWarnHighPlaybackRate(script, value);
  }
  if (options.render !== false) {
    renderWorkResultsPanel();
  }
}

function setStudySettingValue(
  script: { cfg: Record<string, unknown>; namespace?: string },
  key: string,
  value: unknown,
  options: { render?: boolean } = {}
) {
  setStudySettingValueInternal(script, key, value, options);
}

function setWorkResultsView(type: WorkResultsView) {
  state.workResults.type = type;
  runtimeStore.set(WORK_RESULTS_VIEW_KEY, type);
  renderWorkResultsPanel();
}

function syncWorkResultsPanelVisibility(panel = state.panels.workResults) {
  if (!panel) {
    return;
  }

  const collapsed = state.workResults.ui.collapsed;
  panel.configsContainer.style.display = collapsed ? 'none' : '';
  panel.body.style.display = collapsed ? 'none' : '';

  const root = panel.root as HTMLElement & {
    __cxHeaderHandle?: HTMLElement;
    __cxHeaderHint?: HTMLDivElement;
  };

  if (root.__cxHeaderHandle) {
    root.__cxHeaderHandle.title = collapsed ? '点击展开面板内容' : '点击折叠面板内容';
    root.__cxHeaderHandle.setAttribute('aria-expanded', String(collapsed === false));
  }

  if (root.__cxHeaderHint) {
    root.__cxHeaderHint.textContent = collapsed ? '点击展开 · 可拖动' : '点击折叠 · 可拖动';
  }
}

function toggleWorkResultsPanelVisibility() {
  state.workResults.ui.collapsed = toggleWorkResultsPanelCollapsed(state.workResults.ui.collapsed);
  syncWorkResultsPanelVisibility();
}

function saveQuestionCaches() {
  if (isWindowsNoDiskWrite()) {
    return;
  }
  runtimeStore.set(QUESTION_CACHE_KEY, state.apps.localQuestionCaches);
}

function isLocalQuestionCacheEnabled() {
  if (isWindowsNoDiskWrite()) {
    return false;
  }
  return getStudySettingValue('enableLocalQuestionCache', true);
}

function questionCacheMode(cache: QuestionCache): SearchCacheMode {
  return cache.mode === 'deep' ? 'deep' : 'normal';
}

function normalizeCacheText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[！-～]/gu, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeQuestionCacheIdentity(
  title: string,
  identity: QuestionCacheIdentity | undefined
): NormalizedQuestionCacheIdentity | undefined {
  if (!identity || typeof identity !== 'object') {
    return undefined;
  }

  const rawOptions = Array.isArray(identity.options)
    ? identity.options
    : typeof identity.options === 'string'
      ? identity.options.split(/\r?\n/gu)
      : [];
  const normalizeImages = (images: unknown) => Array.isArray(images) ? images.map((image, index) => ({
    url: String(image?.url ?? '').trim(),
    alt: String(image?.alt ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim(),
    index: Number.isInteger(image?.index) && image.index >= 0 ? image.index : index
  })).filter((image) => image.url || image.alt) : [];
  const questionEvidence = {
    stemImages: normalizeImages(identity.questionEvidence?.stemImages),
    optionImages: normalizeImages(identity.questionEvidence?.optionImages)
  };
  return {
    title: normalizeCacheText(title),
    type: normalizeCacheText(identity.type).toLocaleLowerCase(),
    options: rawOptions.map((option) => normalizeCacheText(option)),
    ...(questionEvidence.stemImages.length > 0 || questionEvidence.optionImages.length > 0 ? { questionEvidence } : {})
  };
}

function questionCacheIdentityKey(
  title: string,
  identity: QuestionCacheIdentity | NormalizedQuestionCacheIdentity | undefined
): string | undefined {
  const normalized = normalizeQuestionCacheIdentity(title, identity);
  return normalized ? JSON.stringify([normalized.title, normalized.type, normalized.options, normalized.questionEvidence ?? null]) : undefined;
}

function answerCacheKey(
  title: string,
  mode: SearchCacheMode,
  identity?: QuestionCacheIdentity
): string {
  const identityKey = questionCacheIdentityKey(title, identity);
  return identityKey === undefined
    ? JSON.stringify([mode, title])
    : JSON.stringify([mode, 'identity', identityKey]);
}

function addQuestionCaches(...items: QuestionCache[]) {
  for (const item of items) {
    if (!item.title.trim() || !item.answer.trim()) {
      continue;
    }

    if (
      state.apps.localQuestionCaches.find((cache) =>
        cache.title === item.title &&
        cache.answer === item.answer &&
        questionCacheMode(cache) === questionCacheMode(item) &&
        questionCacheIdentityKey(cache.title, cache.identity) === questionCacheIdentityKey(item.title, item.identity)
      ) === undefined
    ) {
      state.apps.localQuestionCaches.unshift(item);
    }
  }

  state.apps.localQuestionCaches.splice(200);
  saveQuestionCaches();
  renderAppsPanel();
  renderWorkResultsPanel();
}

function questionCachesToSearchInfos(
  title: string,
  mode: SearchCacheMode = 'normal',
  identity?: QuestionCacheIdentity
): SearchInformation[] {
  const identityKey = questionCacheIdentityKey(title, identity);
  const matched = state.apps.localQuestionCaches.filter((cache) =>
    questionCacheMode(cache) === mode &&
    (identityKey === undefined
      ? cache.identity === undefined && cache.title.trim() === title.trim()
      : questionCacheIdentityKey(cache.title, cache.identity) === identityKey)
  );
  return matched.map((cache) => ({
    name: `【题库缓存】${cache.from || '本地缓存'}`,
    homepage: cache.homepage,
    results: [
      {
        question: cache.title,
        answer: cache.answer,
        extra_data: { ai: cache.ai, cache: true }
      }
    ]
  }));
}

function normalizeWorkResultsPayload(payload: unknown): SimplifyWorkResult[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.filter((item): item is SimplifyWorkResult => {
    return Boolean(item && typeof item === 'object' && 'searchInfos' in item && 'question' in item);
  });
}

function resultToQuestionCaches(
  results: SimplifyWorkResult[],
  mode: SearchCacheMode = 'normal',
  identity?: QuestionCacheIdentity
): QuestionCache[] {
  return results.flatMap((result) =>
    result.searchInfos.flatMap((info) =>
      info.results
        .filter((entry) => String(entry[1] ?? '').trim())
        .map((entry) => ({
          title: result.question || entry[0],
          answer: entry[1],
          from: info.name.replace(/【题库缓存】/g, '') || '未知题库',
          homepage: info.homepage || '',
          ai: Boolean((entry[2] as Record<string, unknown> | undefined)?.ai),
          ...(identity === undefined && result.searchIdentity === undefined
            ? {}
            : { identity: normalizeQuestionCacheIdentity(result.question || entry[0], identity ?? result.searchIdentity) }),
          ...(mode === 'deep' ? { mode } : {})
        }))
    )
  );
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    title?: string;
  } = {}
) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.title) element.title = options.title;
  return element;
}

function applyQuestionTextWrapStyle(element: HTMLElement) {
  element.style.whiteSpace = 'normal';
  element.style.overflowWrap = 'anywhere';
  element.style.wordBreak = 'break-word';
}

function createErrorSummaryBlock(errorText: string, extraDetails: string[] = []) {
  const summary = summarizeSearchInfoError(errorText);
  const container = createElement('div');
  container.style.display = 'grid';
  container.style.gap = '8px';
  container.style.padding = '10px 12px';
  container.style.borderRadius = '12px';
  container.style.background = panelPinkTheme.dangerBg;
  container.style.border = '1px solid rgba(248, 113, 113, 0.2)';

  const title = createElement('div', { text: `摘要：${summary.title}` });
  title.style.fontWeight = '700';
  title.style.color = panelPinkTheme.dangerFg;
  applyQuestionTextWrapStyle(title);
  container.append(title);

  // 只给错误码是不够的：必须直接告诉用户下一步该做什么。
  const nextStep = createElement('div', { text: describeSearchErrorNextStep(errorText) });
  nextStep.style.fontSize = '12px';
  nextStep.style.fontWeight = '700';
  nextStep.style.lineHeight = '1.6';
  nextStep.style.color = panelPinkTheme.dangerFg;
  applyQuestionTextWrapStyle(nextStep);
  container.append(nextStep);

  const details = Array.from(new Set([...summary.details, ...extraDetails]));
  for (const text of details) {
    const detail = createElement('div', { text });
    detail.style.fontSize = '12px';
    detail.style.color = panelPinkTheme.dangerFg;
    applyQuestionTextWrapStyle(detail);
    container.append(detail);
  }

  // 原文默认折叠：错误 JSON 可能很长，展开才看，并且限制最大高度内部滚动。
  const original = createElement('details');
  original.open = false;

  const originalTitle = createElement('summary', { text: '查看原始错误' });
  originalTitle.style.cursor = 'pointer';
  originalTitle.style.fontSize = '12px';
  originalTitle.style.fontWeight = '600';
  originalTitle.style.minHeight = PANEL_TOUCH_TARGET_MIN_HEIGHT;
  originalTitle.style.lineHeight = PANEL_TOUCH_TARGET_MIN_HEIGHT;
  originalTitle.style.color = panelPinkTheme.dangerFg;

  const originalText = createElement('pre', { text: errorText });
  originalText.style.margin = '4px 0 0';
  originalText.style.padding = '8px 10px';
  originalText.style.borderRadius = '10px';
  originalText.style.background = 'rgba(255,255,255,0.86)';
  originalText.style.color = panelPinkTheme.dangerFg;
  originalText.style.fontSize = '11px';
  originalText.style.lineHeight = '1.5';
  originalText.style.whiteSpace = 'pre-wrap';
  applyQuestionTextWrapStyle(originalText);
  applyScrollPaneStyle(originalText, 180);

  original.append(originalTitle, originalText);
  container.append(original);
  return container;
}

function applySectionCardStyle(
  element: HTMLElement,
  options: {
    padding?: string;
    background?: string;
    border?: string;
  } = {}
) {
  element.style.padding = options.padding ?? '14px';
  element.style.borderRadius = '16px';
  element.style.background = options.background ?? panelPinkTheme.surface;
  element.style.border = options.border ?? `1px solid ${panelPinkTheme.border}`;
  element.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.75)';
}

function applyActionButtonStyle(button: HTMLButtonElement, tone: 'default' | 'primary' | 'danger' = 'default') {
  // 触控目标 ≥ 32px：小屏与触摸板下 7px 内边距只有 ~28px 高，容易点错。
  button.style.minHeight = PANEL_TOUCH_TARGET_MIN_HEIGHT;
  button.style.padding = '7px 12px';
  button.style.borderRadius = '10px';
  button.style.cursor = 'pointer';
  button.style.fontSize = '12px';
  button.style.fontWeight = '600';
  button.style.lineHeight = '1.4';
  button.style.boxSizing = 'border-box';
  button.style.transition = 'all 0.2s ease';

  if (tone === 'primary') {
    // 主操作：实心渐变 + 更重的字重 + 更大内边距，视觉权重明显高于次要操作。
    button.style.minHeight = '36px';
    button.style.padding = '8px 16px';
    button.style.fontSize = '13px';
    button.style.fontWeight = '800';
    button.style.border = `1px solid ${panelPinkTheme.borderStrong}`;
    button.style.background = panelPinkTheme.primaryGradient;
    button.style.color = '#fff';
    button.style.boxShadow = `0 10px 24px ${panelShadowColor(0.24)}`;
    return;
  }

  if (tone === 'danger') {
    button.style.border = `1px solid ${panelPinkTheme.dangerFg}`;
    button.style.background = 'rgba(255,255,255,0.96)';
    button.style.color = panelPinkTheme.dangerFg;
    button.style.boxShadow = '0 6px 18px rgba(15, 23, 42, 0.06)';
    return;
  }

  // 次要操作：浅底描边，与主操作形成明确的权重差。
  button.style.border = `1px solid ${panelPinkTheme.border}`;
  button.style.background = panelPinkTheme.surfaceStrong;
  button.style.color = panelPinkTheme.text;
  button.style.boxShadow = `0 6px 18px ${panelShadowColor(0.08)}`;
}

function createMetricChip(label: string, value: string) {
  const chip = createElement('div');
  chip.style.display = 'grid';
  chip.style.gap = '4px';
  chip.style.minWidth = '112px';
  chip.style.padding = '10px 12px';
  chip.style.borderRadius = '14px';
  chip.style.background = panelPinkTheme.surfaceStrong;
  chip.style.border = `1px solid ${panelPinkTheme.border}`;
  chip.style.boxShadow = `0 8px 22px ${panelShadowColor(0.08)}`;

  const title = createElement('div', { text: label });
  title.style.fontSize = '11px';
  title.style.color = panelPinkTheme.muted;

  const number = createElement('div', { text: value });
  number.style.fontSize = '15px';
  number.style.fontWeight = '700';
  number.style.color = panelPinkTheme.text;

  chip.append(title, number);
  return chip;
}

function createStatusBadge(result: SimplifyWorkResult) {
  const tone = resolveWorkResultTone(result, false);
  const badge = createElement('div', { text: formatWorkResultStatus(result) });
  badge.style.display = 'inline-flex';
  badge.style.alignItems = 'center';
  badge.style.width = 'fit-content';
  badge.style.padding = '5px 10px';
  badge.style.borderRadius = '999px';
  badge.style.fontSize = '12px';
  badge.style.fontWeight = '700';
  badge.style.lineHeight = '1.4';

  // 状态色一律取自色板：三主题下前景/背景对比度均 ≥ 4.5:1（见 scripts/panel-ui-contrast.test.mjs）。
  if (tone === 'manual') {
    badge.style.background = panelPinkTheme.warningBg;
    badge.style.color = panelPinkTheme.warningFg;
    return badge;
  }

  if (tone === 'success') {
    badge.style.background = panelPinkTheme.successBg;
    badge.style.color = panelPinkTheme.successFg;
    return badge;
  }

  if (tone === 'danger') {
    badge.style.background = panelPinkTheme.dangerBg;
    badge.style.color = panelPinkTheme.dangerFg;
    return badge;
  }

  badge.style.background = panelPinkTheme.primarySoft;
  badge.style.color = panelPinkTheme.muted;
  return badge;
}

function getWorkResultStats() {
  const totalQuestionCount = state.workResults.results.length;
  const requestedCount = state.workResults.results.filter((result) => result.requested).length;
  const resolvedCount = state.workResults.results.filter((result) => result.resolved || result.finish).length;

  return {
    totalQuestionCount,
    requestedCount,
    resolvedCount
  };
}

function createWorkResultsDetail(result: SimplifyWorkResult | undefined) {
  const container = createElement('div');
  applySectionCardStyle(container, {
    padding: '14px',
    background: panelPinkTheme.surface,
    border: `1px solid ${panelPinkTheme.border}`
  });
  container.style.display = 'grid';
  container.style.gap = '10px';

  if (!result) {
    const empty = createElement('div', { text: '暂无搜索结果。' });
    empty.style.color = panelPinkTheme.muted;
    container.append(empty);
    return container;
  }

  const titleWrap = createElement('div');
  titleWrap.style.display = 'grid';
  titleWrap.style.gap = '8px';

  const title = createElement('div', { text: result.question || '未识别题目' });
  title.style.fontWeight = '700';
  title.style.lineHeight = '1.6';
  title.style.color = panelPinkTheme.text;
  applyQuestionTextWrapStyle(title);

  const metaRow = createElement('div');
  metaRow.style.display = 'flex';
  metaRow.style.alignItems = 'center';
  metaRow.style.justifyContent = 'space-between';
  metaRow.style.gap = '8px';
  metaRow.style.flexWrap = 'wrap';

  const typeMeta = createElement('div', {
    text: result.type ? `题型：${formatQuestionTypeLabel(result.type)}` : '题型：未识别'
  });
  typeMeta.style.fontSize = '12px';
  typeMeta.style.color = panelPinkTheme.muted;

  metaRow.append(typeMeta, createStatusBadge(result));
  titleWrap.append(title, metaRow);
  container.append(titleWrap);

  const runtimeControls = state.workResults.runtimeControls;
  const selectedIndex = state.workResults.currentResultIndex;
  const canRetry = Boolean(
    !state.workResults.resetOperation && runtimeControls?.retryQuestion && (runtimeControls.canRetryQuestion?.(selectedIndex) ?? true)
  );

  const detailActions = createElement('div');
  detailActions.style.display = 'flex';
  detailActions.style.gap = '8px';
  detailActions.style.flexWrap = 'wrap';

  const retryButton = createElement('button', { text: result.retrying ? '正在重答...' : '重答本题' });
  retryButton.disabled = !canRetry || Boolean(result.retrying);
  retryButton.onclick = async () => {
    if (!runtimeControls || !canRetry || result.retrying) {
      return;
    }

    const previousResult = { ...result };
    const retryGeneration = state.workResults.resetGeneration;
    const isCurrentRetry = () => state.workResults.runtimeControls === runtimeControls
      && state.workResults.resetGeneration === retryGeneration && !state.workResults.resetOperation;
    patchWorkResult(selectedIndex, { retrying: true, error: undefined, manual: false });
    try {
      const retried = await runtimeControls.retryQuestion(selectedIndex);
      if (!isCurrentRetry()) return;
      if (retried) {
        patchWorkResult(selectedIndex, {
          ...retried,
          retrying: false,
          manual: false
        });
      } else {
        patchWorkResult(selectedIndex, { ...previousResult, retrying: false });
      }
    } catch (err) {
      if (!isCurrentRetry()) return;
      patchWorkResult(selectedIndex, {
        retrying: false,
        error: (err as Error).message || String(err)
      });
    }
  };

  applyActionButtonStyle(retryButton, 'primary');
  detailActions.append(retryButton);
  container.append(detailActions);

  if (result.error) {
    container.append(createErrorSummaryBlock(result.error));
  }

  if (result.searchInfos.length === 0) {
    const empty = createElement('div', { text: '题库没有返回答案。' });
    empty.style.color = panelPinkTheme.subtle;
    empty.style.padding = '6px 0';
    container.append(empty);
    return container;
  }

  for (const info of result.searchInfos) {
    const block = createElement('div');
    applySectionCardStyle(block, {
      padding: '12px',
      background: panelPinkTheme.sectionGradient,
      border: `1px solid ${panelPinkTheme.border}`
    });
    block.style.display = 'grid';
    block.style.gap = '8px';

    const headerRow = createElement('div');
    headerRow.style.display = 'flex';
    headerRow.style.justifyContent = 'space-between';
    headerRow.style.alignItems = 'center';
    headerRow.style.gap = '8px';
    headerRow.style.flexWrap = 'wrap';

    const header = createElement('div', { text: info.name || '未知题库' });
    header.style.fontWeight = '700';
    header.style.color = panelPinkTheme.text;

    const sub = createElement('div', {
      text: info.error ? '错误' : `结果数：${info.results.length}`
    });
    sub.style.fontSize = '12px';
    sub.style.color = info.error ? panelPinkTheme.dangerFg : panelPinkTheme.muted;
    applyQuestionTextWrapStyle(sub);

    headerRow.append(header, sub);
    block.append(headerRow);

    if (info.error) {
      block.append(createErrorSummaryBlock(info.error));
    }

    if (info.homepage) {
      const link = document.createElement('a');
      link.href = info.homepage;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = info.homepage;
      link.style.display = 'block';
      link.style.fontSize = '12px';
      link.style.color = panelPinkTheme.link;
      link.style.wordBreak = 'break-all';
      block.append(link);
    }

    if (info.results.length) {
      const list = createElement('div');
      list.style.display = 'grid';
      list.style.gap = '8px';
      // 单个题库可能返回很多条答案：限制高度 + 内部滚动，避免把整个面板拉长。
      applyScrollPaneStyle(list, 240);

      for (const entry of info.results) {
        const item = createElement('div');
        item.style.background = panelPinkTheme.surfaceStrong;
        item.style.borderRadius = '12px';
        item.style.padding = '10px 12px';
        item.style.border = `1px solid ${panelPinkTheme.border}`;

        const answer = createElement('div', { text: entry[1] || '空答案' });
        answer.style.fontWeight = '700';
        answer.style.wordBreak = 'break-word';
        answer.style.color = panelPinkTheme.text;

        const question = createElement('div', { text: entry[0] || '' });
        applyHintTextStyle(question);
        question.style.marginTop = '6px';
        applyQuestionTextWrapStyle(question);

        item.append(answer, question);
        list.append(item);
      }

      block.append(list);
    }

    container.append(block);
  }

  return container;
}

function createConfigField(
  script: { cfg: Record<string, unknown>; namespace?: string },
  key: string,
  definition: ConfigDefinition
) {
  const wrap = createElement('div');
  wrap.style.display = 'grid';
  wrap.style.gap = '8px';

  const isPlaybackRateField = key === 'playbackRate';
  const isVolumeField = key === 'volume';
  const isCompactChoiceField = key === 'aiFallbackFailureAction' || key === 'upload';

  if (definition.label) {
    const label = createElement('label', { text: definition.label });
    label.style.fontSize = '12px';
    label.style.fontWeight = '700';
    label.style.color = panelPinkTheme.text;
    wrap.append(label);
  }

  const currentValue = script.cfg[key];
  const attrs = definition.attrs ?? {};
  const inputType = typeof attrs.type === 'string' ? attrs.type : definition.options ? 'select' : 'text';
  let control: HTMLElement;

  if (definition.options?.length) {
    const optionWrap = createElement('div');
    optionWrap.style.display = 'grid';
    optionWrap.style.gap = '8px';

    const optionGrid = createElement('div');
    optionGrid.style.display = 'grid';
    optionGrid.style.gap = '8px';

    if (isPlaybackRateField) {
      const selectedBadge = createElement('div', {
        text: `当前倍率：${String(currentValue ?? definition.defaultValue)}x`
      });
      selectedBadge.style.width = 'fit-content';
      selectedBadge.style.padding = '6px 10px';
      selectedBadge.style.borderRadius = '999px';
      selectedBadge.style.background = panelPinkTheme.primarySoft;
      selectedBadge.style.color = panelPinkTheme.primaryDeep;
      selectedBadge.style.fontSize = '12px';
      selectedBadge.style.fontWeight = '700';

      const wrapHint = createElement('div', { text: '倍率选项会根据可用宽度自动换行显示。' });
      applyHintTextStyle(wrapHint);
      wrapHint.style.lineHeight = '1.5';

      optionGrid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(72px, 1fr))';
      optionGrid.style.alignItems = 'stretch';

      optionWrap.append(selectedBadge, wrapHint);
    } else if (key === 'useAsyncTikuSearch') {
      optionGrid.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
    } else if (isCompactChoiceField) {
      optionGrid.style.gridTemplateColumns = '1fr';
    } else {
      optionGrid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(96px, 1fr))';
    }

    definition.options.forEach(([value, text]) => {
      const selected = String(currentValue ?? definition.defaultValue) === value;
      const option = createElement('button', { text });
      option.type = 'button';
      option.title = attrs.title ? String(attrs.title) : text;
      option.setAttribute('aria-pressed', String(selected));
      option.style.padding = '10px 12px';
      option.style.minHeight = '48px';
      option.style.borderRadius = '12px';
      option.style.border = selected ? `1px solid ${panelPinkTheme.borderStrong}` : `1px solid ${panelPinkTheme.border}`;
      option.style.background = selected
        ? panelPinkTheme.primarySoft
        : panelPinkTheme.surfaceStrong;
      option.style.color = selected ? panelPinkTheme.primaryDeep : panelPinkTheme.text;
      option.style.fontSize = '12px';
      option.style.fontWeight = selected ? '700' : '600';
      option.style.cursor = 'pointer';
      option.style.textAlign = 'center';
      option.style.whiteSpace = isPlaybackRateField ? 'nowrap' : 'normal';
      option.style.wordBreak = 'break-word';
      option.style.lineHeight = '1.5';
      option.style.alignContent = 'center';
      option.onclick = () => {
        setStudySettingValue(script, key, key === 'useAsyncTikuSearch' ? value === 'true' : value);
      };
      optionGrid.append(option);
    });

    optionWrap.append(optionGrid);
    control = optionWrap;
  } else if (inputType === 'checkbox') {
    const checked = Boolean(currentValue ?? definition.defaultValue);
    const toggle = createElement('button');
    toggle.type = 'button';
    toggle.title = attrs.title ? String(attrs.title) : definition.label ?? key;
    toggle.style.display = 'grid';
    toggle.style.gap = '6px';
    toggle.style.justifyItems = 'start';
    toggle.style.width = '100%';
    toggle.style.padding = '12px';
    toggle.style.minHeight = '72px';
    toggle.style.borderRadius = '14px';
    toggle.style.cursor = 'pointer';
    toggle.style.textAlign = 'left';
    toggle.style.transition = 'all 0.2s ease';
    toggle.style.border = checked ? `1px solid ${panelPinkTheme.borderStrong}` : `1px solid ${panelPinkTheme.border}`;
    toggle.style.background = checked ? panelPinkTheme.primarySoft : panelPinkTheme.surfaceStrong;
    toggle.style.boxShadow = checked ? `0 10px 24px ${panelShadowColor(0.12)}` : `0 6px 18px ${panelShadowColor(0.05)}`;

    const stateText = createElement('div', { text: checked ? '已开启' : '已关闭' });
    stateText.style.fontSize = '13px';
    stateText.style.fontWeight = '700';
    stateText.style.color = checked ? panelPinkTheme.primaryDeep : panelPinkTheme.muted;

    const stateDesc = createElement('div', {
      text: checked ? '点击关闭此项设置' : '点击开启此项设置'
    });
    stateDesc.style.fontSize = '12px';
    stateDesc.style.color = checked ? panelPinkTheme.muted : panelPinkTheme.subtle;
    stateDesc.style.lineHeight = '1.5';

    toggle.append(stateText, stateDesc);
    let confirmationPending = false;
    toggle.onclick = () => {
      if (key === 'deepThinking' && !checked) {
        if (confirmationPending) return;
        confirmationPending = true;
        void $modal.confirm({
          content: '开启深度思考后，AI 会进行多轮模型与联网搜索调用，等待时间会更长，费用也可能更高。确定开启吗？',
          confirmButtonText: '确认开启',
          cancelButtonText: '暂不开启'
        }).then((confirmed) => {
          if (confirmed) {
            setStudySettingValue(script, key, true);
          }
        }).finally(() => {
          confirmationPending = false;
        });
        return;
      }
      setStudySettingValue(script, key, !checked);
    };
    control = toggle;
  } else {
    const inputGroup = createElement('div');
    inputGroup.style.display = 'grid';
    inputGroup.style.gap = '10px';

    const inputWrap = createElement('div');
    inputWrap.style.display = 'flex';
    inputWrap.style.alignItems = 'center';
    inputWrap.style.gap = '8px';
    inputWrap.style.padding = '10px 12px';
    inputWrap.style.borderRadius = '12px';
    inputWrap.style.border = `1px solid ${panelPinkTheme.border}`;
    inputWrap.style.background = panelPinkTheme.surfaceStrong;
    inputWrap.style.boxShadow = `0 6px 18px ${panelShadowColor(0.05)}`;

    const input = document.createElement('input');
    input.type = isVolumeField ? 'number' : inputType === 'range' ? 'range' : 'text';
    input.style.flex = '1';
    input.style.minWidth = '0';
    // 输入控件本体也必须是 ≥ 32px 的触控目标：外层容器有 padding 不代表控件可点。
    input.style.minHeight = PANEL_TOUCH_TARGET_MIN_HEIGHT;
    input.style.border = 'none';
    input.style.outline = 'none';
    input.style.background = 'transparent';
    input.style.fontSize = '13px';
    input.style.fontWeight = '700';
    input.style.color = panelPinkTheme.text;

    if (isVolumeField) {
      input.min = '0';
      input.max = '100';
      input.step = '1';
      const rawVolume = Number(currentValue ?? definition.defaultValue ?? 0);
      input.value = String(Number.isFinite(rawVolume) ? Math.round(rawVolume * 100) : 0);
    } else {
      if (attrs.min !== undefined) input.min = String(attrs.min);
      if (attrs.max !== undefined) input.max = String(attrs.max);
      if (attrs.step !== undefined) input.step = String(attrs.step);
      input.value = String(currentValue ?? definition.defaultValue ?? '');
    }

    if (attrs.title) {
      input.title = String(attrs.title);
    }

    let syncVolumeUi: ((percent: number) => void) | undefined;
    input.oninput = () => {
      const value = isVolumeField
        ? Math.min(100, Math.max(0, Number(input.value || '0'))) / 100
        : input.type === 'range'
          ? Number(input.value)
          : input.value;
      setStudySettingValue(script, key, value, { render: false });
      if (isVolumeField) {
        syncVolumeUi?.(Math.round(Number(value) * 100));
      }
    };

    inputWrap.append(input);

    if (isVolumeField) {
      const suffix = createElement('div', { text: '%' });
      suffix.style.fontSize = '12px';
      suffix.style.fontWeight = '700';
      suffix.style.color = panelPinkTheme.muted;
      inputWrap.append(suffix);
    }

    inputGroup.append(inputWrap);

    if (isVolumeField) {
      const quickMeta = createElement('div');
      quickMeta.style.display = 'flex';
      quickMeta.style.alignItems = 'center';
      quickMeta.style.justifyContent = 'space-between';
      quickMeta.style.gap = '8px';
      quickMeta.style.flexWrap = 'wrap';

      const currentVolumeBadge = createElement('div', {
        text: `当前音量：${input.value || '0'}%`
      });
      currentVolumeBadge.style.width = 'fit-content';
      currentVolumeBadge.style.padding = '6px 10px';
      currentVolumeBadge.style.borderRadius = '999px';
      currentVolumeBadge.style.background = panelPinkTheme.primarySoft;
      currentVolumeBadge.style.color = panelPinkTheme.primaryDeep;
      currentVolumeBadge.style.fontSize = '12px';
      currentVolumeBadge.style.fontWeight = '700';

      const quickHint = createElement('div', { text: '可直接输入，也可使用下方快捷音量按钮。' });
      quickHint.style.fontSize = '12px';
      quickHint.style.color = panelPinkTheme.muted;
      quickHint.style.lineHeight = '1.5';

      quickMeta.append(currentVolumeBadge, quickHint);
      inputGroup.append(quickMeta);

      const quickRow = createElement('div');
      quickRow.style.display = 'flex';
      quickRow.style.flexWrap = 'wrap';
      quickRow.style.gap = '8px';

      const quickButtons: Array<{ button: HTMLButtonElement; percent: number }> = [];
      const applyQuickButtonStyle = (button: HTMLButtonElement, selected: boolean) => {
        button.style.border = selected ? `1px solid ${panelPinkTheme.borderStrong}` : `1px solid ${panelPinkTheme.border}`;
        button.style.background = selected
          ? panelPinkTheme.primarySoft
          : panelPinkTheme.surfaceStrong;
        button.style.color = selected ? panelPinkTheme.primaryDeep : panelPinkTheme.text;
        button.style.fontWeight = selected ? '700' : '600';
        button.style.boxShadow = selected ? `0 10px 22px ${panelShadowColor(0.12)}` : `0 6px 18px ${panelShadowColor(0.05)}`;
      };

      [0, 25, 50, 75, 100].forEach((percent) => {
        const selected = Number(input.value || '0') === percent;
        const quickButton = createElement('button', { text: `${percent}%` });
        quickButton.type = 'button';
        quickButton.style.padding = '8px 10px';
        quickButton.style.borderRadius = '10px';
        quickButton.style.fontSize = '12px';
        quickButton.style.cursor = 'pointer';
        applyQuickButtonStyle(quickButton, selected);
        quickButton.onclick = () => {
          setStudySettingValue(script, key, percent / 100);
        };
        quickButtons.push({ button: quickButton, percent });
        quickRow.append(quickButton);
      });

      syncVolumeUi = (percent) => {
        currentVolumeBadge.textContent = `当前音量：${percent}%`;
        quickButtons.forEach(({ button, percent: buttonPercent }) => {
          applyQuickButtonStyle(button, buttonPercent === percent);
        });
      };

      inputGroup.append(quickRow);
    }

    control = inputGroup;
  }

  if (attrs.title && !(control instanceof HTMLInputElement) && !(control instanceof HTMLSelectElement)) {
    control.title = String(attrs.title);
  }

  wrap.append(control);
  return wrap;
}

function createStudySettingsPanel() {
  const studyNamespace = 'cx.new.study';
  const studyConfigDefs: Record<string, ConfigDefinition> = {
    playbackRate: {
      ...playbackRate,
      label: '视频倍速',
      options: playbackRate.options,
      defaultValue: playbackRate.defaultValue
    },
    volume: {
      ...volume,
      label: '视频音量（%）',
      defaultValue: volume.defaultValue,
      attrs: { type: 'number', step: '1', min: '0', max: '100', title: '请输入 0 到 100 之间的音量百分比。' }
    },
    muteMedia: {
      label: '视频静音',
      attrs: { type: 'checkbox', title: '开启后会将视频和音频静音播放。' },
      defaultValue: true
    },
    videoQuizStrategy: {
      label: '视频内题目',
      options: [
        ['random', '随机答题'],
        ['ignore', '忽略']
      ],
      defaultValue: 'random'
    },
    mode: {
      label: '跳转模式',
      options: [
        ['next', '完成后跳转下一节'],
        ['job', '完成后跳转未完成任务点'],
        ['manually', '完成后暂停，等待手动跳转']
      ],
      defaultValue: 'next'
    },
    restudy: {
      label: '复习模式',
      attrs: { title: '已经完成的视频继续学习，并从当前章节往下开始学习', type: 'checkbox' },
      defaultValue: false
    },
    forceLearn: {
      label: '强制学习',
      attrs: {
        title: '当遇到非任务点媒体时，开启后也会尝试学习。',
        type: 'checkbox'
      },
      defaultValue: false
    },
    backToFirstWhenFinish: {
      label: '完成全部后重新学习',
      attrs: {
        type: 'checkbox',
        title: '学习到最后一章后，自动返回第一章重新开始。'
      },
      defaultValue: false
    },
    enableMedia: {
      label: '视频/音频自动播放',
      attrs: { type: 'checkbox', title: '开启后自动播放视频和音频任务点。' },
      defaultValue: true
    },
    enablePPT: {
      label: 'PPT/书籍自动完成',
      attrs: { type: 'checkbox', title: '开启后自动完成 PPT、书籍、文档类任务。' },
      defaultValue: true
    },
    enableChapterTest: {
      label: '章节测试自动答题',
      attrs: { type: 'checkbox', title: '开启后自动搜索并填写章节测试答案。' },
      defaultValue: true
    },
    enableRandomFallbackAnswer: {
      label: '无答案时随机作答',
      attrs: { type: 'checkbox', title: '题库和 AI 都没有返回可用答案时，允许对选择题随机作答。' },
      defaultValue: false
    },
    enableAIFallbackAnswer: {
      label: 'AI 兜底搜题',
      attrs: { type: 'checkbox', title: '普通题库失败后，允许调用 tikuAdapter AI fallback。' },
      defaultValue: true
    },
    useAsyncTikuSearch: {
      label: '搜题方式',
      attrs: { title: '异步通过任务接口轮询结果；同步使用旧版搜题接口。' },
      options: [
        ['true', '异步'],
        ['false', '同步']
      ],
      defaultValue: true
    },
    deepThinking: {
      label: '深度思考',
      attrs: { type: 'checkbox', title: '开启后 AI 搜题会更慢，且费用可能更高。默认关闭。' },
      defaultValue: false
    },
    aiFallbackFailureAction: {
      label: 'AI 兜底失败后行为',
      options: [
        ['pause', '停留当前页'],
        ['skip', '继续后续流程']
      ],
      defaultValue: 'pause'
    },
    enableExamAutoSubmit: {
      label: '考试自动交卷',
      attrs: { type: 'checkbox', title: '开启后，考试答题完成且完成率满足提交条件时才会自动交卷。默认关闭。' },
      defaultValue: false
    },
    enableDebugLogPanel: {
      label: '日志窗口',
      attrs: { type: 'checkbox', title: '开启后在页面右下角显示调试日志窗口。默认关闭。' },
      defaultValue: false
    },
    enableLocalQuestionCache: {
      label: '本地题库缓存',
      attrs: { type: 'checkbox', title: '开启后优先使用本地已缓存题目答案。默认开启。' },
      defaultValue: true
    },
    enableHyperlink: {
      label: '链接任务自动完成',
      attrs: { type: 'checkbox', title: '开启后自动完成链接型任务点。' },
      defaultValue: true
    },
    notifyWhenHasFaceRecognition: {
      label: '出现人脸识别时提醒我',
      attrs: { type: 'checkbox' },
      defaultValue: true
    }
  };

  const script = {
    namespace: studyNamespace,
    cfg: Object.fromEntries(
      Object.entries(studyConfigDefs).map(([key, definition]) => [key, getStudySettingValue(key, definition.defaultValue)])
    )
  };

  const container = createElement('div');
  applySectionCardStyle(container, {
    padding: '14px',
    background: panelPinkTheme.sectionGradient,
    border: `1px solid ${panelPinkTheme.border}`
  });
  container.style.display = 'grid';
  container.style.gap = '12px';

  // Windows 端只保留考试/答题相关设置；扩展端保持完整学习设置。
  const windowsExamOnly = isWindowsHostRuntime();

  const header = createElement('div');
  header.style.display = 'grid';
  header.style.gap = '6px';

  const title = createElement('div', { text: windowsExamOnly ? '考试设置' : '学习设置' });
  title.style.fontSize = '15px';
  title.style.fontWeight = '800';
  title.style.color = panelPinkTheme.text;

  const description = createElement('div', {
    text: windowsExamOnly
      ? '仅保留考试答题相关的设置。'
      : '这里的设置会直接作用于当前学习流程。'
  });
  description.style.fontSize = '12px';
  description.style.color = panelPinkTheme.muted;
  description.style.lineHeight = '1.7';

  header.append(title, description);
  container.append(header);

  const mediaKeys = ['playbackRate', 'volume', 'muteMedia', 'videoQuizStrategy'];
  const progressKeys = ['mode', 'restudy', 'forceLearn', 'backToFirstWhenFinish'];
  const taskKeys = [
    'enableMedia',
    'enablePPT',
    'enableChapterTest',
    'enableRandomFallbackAnswer',
    'enableHyperlink',
    'notifyWhenHasFaceRecognition'
  ];
  const aiSearchKeys = ['enableAIFallbackAnswer', 'useAsyncTikuSearch', 'deepThinking', 'aiFallbackFailureAction'];
  const examAndDebugKeys = ['enableExamAutoSubmit', 'enableDebugLogPanel'];
  const cacheKeys = ['enableLocalQuestionCache'];

  const createSettingsGroup = (
    groupTitle: string,
    groupDescription: string,
    keys: string[],
    summaryText = `${keys.length} 项`
  ) => {
    const section = createElement('div');
    section.style.display = 'grid';
    section.style.gap = '10px';
    section.style.padding = '12px';
    section.style.borderRadius = '16px';
    section.style.background = panelPinkTheme.sectionGradient;
    section.style.border = `1px solid ${panelPinkTheme.border}`;
    section.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.7)';

    const sectionHeader = createElement('div');
    sectionHeader.style.display = 'grid';
    sectionHeader.style.gap = '6px';
    sectionHeader.style.paddingBottom = '8px';
    sectionHeader.style.borderBottom = `1px solid ${panelPinkTheme.border}`;

    const titleRow = createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.alignItems = 'center';
    titleRow.style.justifyContent = 'space-between';
    titleRow.style.gap = '8px';
    titleRow.style.flexWrap = 'wrap';

    const sectionTitle = createElement('div', { text: groupTitle });
    applySectionTitleStyle(sectionTitle, 'group');

    const sectionPill = createElement('div', { text: summaryText });
    sectionPill.style.padding = '5px 9px';
    sectionPill.style.borderRadius = '999px';
    sectionPill.style.background = panelPinkTheme.primarySoft;
    sectionPill.style.color = panelPinkTheme.primaryDeep;
    sectionPill.style.fontSize = '11px';
    sectionPill.style.fontWeight = '700';

    const sectionDesc = createElement('div', { text: groupDescription });
    applyHintTextStyle(sectionDesc);

    titleRow.append(sectionTitle, sectionPill);
    sectionHeader.append(titleRow, sectionDesc);

    const sectionGrid = createElement('div');
    sectionGrid.style.display = 'grid';
    sectionGrid.style.gap = '10px';
    sectionGrid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(180px, 1fr))';

    for (const key of keys) {
      const definition = studyConfigDefs[key];
      if (!definition) continue;
      const field = createConfigField(script, key, definition);
      field.style.padding = '10px 12px';
      field.style.borderRadius = '14px';
      field.style.background = panelPinkTheme.surfaceStrong;
      field.style.border = `1px solid ${panelPinkTheme.border}`;
      field.style.boxShadow = `0 8px 20px ${panelShadowColor(0.05)}`;
      // 密集表单控件之间留足点击间距：同一网格里控件最小高度 32px、行距 10px。
      field.style.minHeight = PANEL_TOUCH_TARGET_MIN_HEIGHT;
      field.style.boxSizing = 'border-box';
      if (key === 'playbackRate' || key === 'volume' || key === 'mode') {
        field.style.gridColumn = '1 / -1';
      }
      sectionGrid.append(field);
    }

    section.append(sectionHeader, sectionGrid);
    return section;
  };

  if (windowsExamOnly) {
    container.append(
      createSettingsGroup('AI 搜题', '深度思考会增加等待时间，且费用可能更高；默认关闭。', aiSearchKeys),
      createSettingsGroup('考试与诊断', '控制考试自动交卷权限。', ['enableExamAutoSubmit']),
      createSettingsGroup('题库缓存', '控制是否优先使用本地缓存命中题目答案。', cacheKeys)
    );
    return container;
  }

  container.append(
    createSettingsGroup('媒体控制', '控制播放相关行为，修改后会尽量立即作用到当前媒体。', mediaKeys),
    createSettingsGroup('学习流程', '控制章节完成后的跳转与复习策略。', progressKeys),
    createSettingsGroup(
      '任务能力',
      '控制视频、文档、章节测试和提醒等自动化能力。',
      taskKeys,
      formatEnabledStudyTaskCapabilitySummary(script.cfg, taskKeys)
    ),
    createSettingsGroup('AI 搜题', '深度思考会增加等待时间，且费用可能更高；默认关闭。', aiSearchKeys),
    createSettingsGroup('考试与诊断', '控制考试自动交卷权限和页面日志窗口。', examAndDebugKeys)
    ,
    createSettingsGroup('题库缓存', '控制是否优先使用本地缓存命中题目答案。', cacheKeys)
  );
  return container;
}

function createTikuAdapterConfigSection() {
  const stored = getStoredTikuAdapterConfig();

  const container = createElement('div');
  applySectionCardStyle(container, {
    padding: '14px',
    background: panelPinkTheme.sectionGradient,
    border: `1px solid ${panelPinkTheme.border}`
  });
  container.style.display = 'grid';
  container.style.gap = '12px';

  const header = createElement('div');
  header.style.display = 'grid';
  header.style.gap = '6px';

  const title = createElement('div', { text: '题库配置' });
  applySectionTitleStyle(title, 'section');

  const description = createElement('div', {
    text: isWindowsHostRuntime()
      ? '用于考试答题的题库适配器配置。'
      : '这里的设置会直接作用于当前学习流程。'
  });
  applyHintTextStyle(description);

  header.append(title, description);

  const baseurlWrap = createElement('div');
  baseurlWrap.style.display = 'grid';
  baseurlWrap.style.gap = '8px';

  const baseurlLabel = createElement('label', { text: '题库地址' });
  baseurlLabel.style.fontSize = '12px';
  baseurlLabel.style.fontWeight = '700';
  baseurlLabel.style.color = panelPinkTheme.text;

  const baseurlRow = createElement('div');
  baseurlRow.style.display = 'flex';
  baseurlRow.style.gap = '8px';
  baseurlRow.style.flexWrap = 'wrap';

  const baseurlInput = document.createElement('input');
  baseurlInput.type = 'text';
  baseurlInput.value = stored.baseurl || DEFAULT_TIKU_BASE_URL;
  baseurlInput.placeholder = DEFAULT_TIKU_BASE_URL || 'https://your-tiku.example.com';
  baseurlInput.style.flex = '1';
  baseurlInput.style.minWidth = '180px';
  // 输入框统一外观：与设置区控件一致，触控目标 ≥ 32px。
  applyControlChrome(baseurlInput);

  const saveButton = createElement('button', { text: '保存' });
  applyActionButtonStyle(saveButton, 'primary');
  saveButton.onclick = async () => {
    setRuntimeStoreValueFromPanel(TIKU_ADAPTER_BASEURL_KEY, baseurlInput.value.trim());
    setRuntimeStoreValueFromPanel(TIKU_ADAPTER_KEY_KEY, keyInput.value.trim());
    await $modal.alert('题库配置已保存。');
  };

  const jumpButton = createElement('button', { text: '跳转' });
  applyActionButtonStyle(jumpButton, 'default');
  jumpButton.onclick = async () => {
    const normalized = resolveTikuAdapterBaseUrl(baseurlInput.value, DEFAULT_TIKU_BASE_URL);
    if (!isValidTikuAdapterBaseUrl(normalized)) {
      await $modal.alert('请先填写正确的题库 baseurl。');
      return;
    }

    window.open(normalized, '_blank', 'noopener,noreferrer');
  };

  baseurlRow.append(baseurlInput);
  baseurlWrap.append(baseurlLabel, baseurlRow);

  const keyWrap = createElement('div');
  keyWrap.style.display = 'grid';
  keyWrap.style.gap = '8px';

  const keyLabel = createElement('label', { text: '令牌' });
  keyLabel.style.fontSize = '12px';
  keyLabel.style.fontWeight = '700';
  keyLabel.style.color = panelPinkTheme.text;

  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.value = stored.key;
  keyInput.placeholder = '请输入访问令牌';
  applyControlChrome(keyInput);

  const actionsRow = createElement('div');
  actionsRow.style.display = 'flex';
  actionsRow.style.gap = '8px';
  actionsRow.style.flexWrap = 'wrap';
  actionsRow.append(saveButton, jumpButton);

  keyWrap.append(keyLabel, keyInput);
  container.append(header, baseurlWrap, keyWrap, actionsRow);
  return container;
}

function syncWorkResultsControlDocument(ownerDocument?: Document) {
  const currentDocument = state.workResults.controlDocument;
  let stale = false;
  try {
    stale = currentDocument.defaultView?.document !== currentDocument;
  } catch {
    stale = true;
  }
  if (stale || (ownerDocument && ownerDocument !== currentDocument)) {
    state.workResults.controlDocument = ownerDocument ?? document;
    state.workResults.runtimeControls = undefined;
  }
}

/**
 * 面板渲染失败时的兜底视图。
 *
 * 存在理由：面板是一块 fixed 浮层，渲染抛异常时用户只会看到「一片空白」，
 * 既没有错误信息也没有重试入口。这里给最小可恢复界面：说明发生了什么 +
 * 一个清空结果的按钮（坏数据通常来自旧格式的本地存储）。
 */

/**
 * 面板渲染失败时的兜底视图。
 *
 * 存在理由：面板是一块 fixed 浮层，渲染抛异常时用户只会看到「一片空白」，
 * 既没有错误信息也没有重试入口。这里给最小可恢复界面：说明发生了什么 +
 * 一个清空结果的按钮（坏数据通常来自旧格式的本地存储）。
 */
function createPanelRenderFailureView(error: unknown) {
  const container = createElement('div');
  container.dataset.cxPanelRenderFailure = 'true';
  container.style.display = 'grid';
  container.style.gap = '10px';
  container.style.padding = '14px';
  container.style.borderRadius = '14px';
  container.style.background = panelPinkTheme.surfaceStrong;
  container.style.border = `1px solid ${panelPinkTheme.dangerFg}`;

  const title = createElement('div', { text: '面板加载失败' });
  title.style.fontSize = '14px';
  title.style.fontWeight = '800';
  title.style.color = panelPinkTheme.dangerFg;

  const hint = createElement('div', {
    text: '本地缓存的答题结果格式与当前版本不符。清除后即可恢复正常，重新答题会重新积累结果。'
  });
  applyHintTextStyle(hint);

  const detail = createElement('div', {
    text: error instanceof Error ? error.message : String(error ?? '未知错误')
  });
  detail.style.fontSize = '12px';
  detail.style.color = panelPinkTheme.subtle;
  detail.style.wordBreak = 'break-word';

  const reset = createElement('button', { text: '清除缓存并重试' });
  reset.type = 'button';
  reset.style.minHeight = PANEL_TOUCH_TARGET_MIN_HEIGHT;
  applyActionButtonStyle(reset, 'primary');
  reset.onclick = () => {
    try {
      state.workResults.results = [];
      runtimeStore.set(WORK_RESULTS_KEY, []);
    } catch {
      // 存储不可写时仍然重渲染，至少让界面回到可用状态
    }
    renderWorkResultsPanel();
  };

  container.append(title, hint, detail, reset);
  return container;
}

function createWorkResultsPanel() {
  const container = createElement('div');
  container.style.display = 'grid';
  container.style.gap = '14px';

  // Windows 端只保留考试/答题相关功能；扩展端保持完整面板。
  const windowsExamOnly = isWindowsHostRuntime();

  const stats = getWorkResultStats();

  const hero = createElement('div');
  hero.style.padding = '16px';
  hero.style.borderRadius = '18px';
  hero.style.background = panelPinkTheme.heroGradient;
  hero.style.border = `1px solid ${panelPinkTheme.borderStrong}`;
  hero.style.boxShadow = panelPinkTheme.heroShadow;
  hero.style.display = 'grid';
  hero.style.gap = '12px';

  const heroTop = createElement('div');
  heroTop.style.display = 'flex';
  heroTop.style.justifyContent = 'space-between';
  heroTop.style.alignItems = 'flex-start';
  heroTop.style.gap = '12px';
  heroTop.style.flexWrap = 'wrap';

  const titleGroup = createElement('div');
  titleGroup.style.display = 'grid';
  titleGroup.style.gap = '6px';
  titleGroup.style.minWidth = '0';

  const heroTitle = createElement('div', { text: windowsExamOnly ? '考试答题助手' : '答题结果与学习控制' });
  applySectionTitleStyle(heroTitle, 'hero');
  applyQuestionTextWrapStyle(heroTitle);

  titleGroup.append(heroTitle);

  heroTop.append(titleGroup);

  const metricRow = createElement('div');
  metricRow.style.display = 'grid';
  metricRow.style.gridTemplateColumns = 'repeat(auto-fit, minmax(112px, 1fr))';
  metricRow.style.gap = '10px';
  metricRow.append(
    createMetricChip('已搜题', `${stats.requestedCount}/${stats.totalQuestionCount}`),
    createMetricChip('已答题', `${stats.resolvedCount}/${stats.totalQuestionCount}`),
    createMetricChip('缓存题目', String(state.apps.localQuestionCaches.length))
  );

  const studyScript = {
    namespace: 'cx.new.study',
    cfg: {
      enableAnswer: getStudySettingValue('enableAnswer', true),
      enableAIFallbackAnswer: getStudySettingValue('enableAIFallbackAnswer', true),
      useAsyncTikuSearch: getStudySettingValue('useAsyncTikuSearch', true),
      aiFallbackFailureAction: getStudySettingValue('aiFallbackFailureAction', 'pause'),
      enableExamAutoSubmit: getStudySettingValue('enableExamAutoSubmit', false),
      enableDebugLogPanel: getStudySettingValue('enableDebugLogPanel', false),
      enableLocalQuestionCache: getStudySettingValue('enableLocalQuestionCache', true),
      upload: getStudySettingValue('upload', 'submit')
    }
  };

  const answerToggleField = createConfigField(studyScript, 'enableAnswer', {
    label: '自动答题',
    attrs: {
      type: 'checkbox',
      title: '关闭后将跳过章节测试自动答题，并忽略视频内题目的自动作答。'
    },
    defaultValue: true
  });
  answerToggleField.style.maxWidth = 'none';

  const aiAnswerRow = createElement('div');
  aiAnswerRow.style.display = 'grid';
  aiAnswerRow.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
  aiAnswerRow.style.gap = '12px';
  aiAnswerRow.style.alignItems = 'start';

  const aiFallbackToggleField = createConfigField(studyScript, 'enableAIFallbackAnswer', {
    label: 'AI 兜底搜题',
    attrs: {
      type: 'checkbox',
      title: '普通题库失败后，允许调用 tikuAdapter AI fallback。'
    },
    defaultValue: true
  });
  aiFallbackToggleField.style.maxWidth = 'none';

  const aiFallbackFailureActionField = createConfigField(studyScript, 'aiFallbackFailureAction', {
    label: 'AI 兜底失败后行为',
    attrs: {
      title: '普通题库与 AI 兜底都失败后，决定停留当前页还是继续后续流程。'
    },
    options: [
      ['pause', '停留当前页'],
      ['skip', '继续后续流程']
    ],
    defaultValue: 'pause'
  });
  aiFallbackFailureActionField.style.maxWidth = 'none';

  const actionModeRow = createElement('div');
  actionModeRow.style.display = 'grid';
  actionModeRow.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
  actionModeRow.style.gap = '12px';
  actionModeRow.style.alignItems = 'start';

  const uploadModeField = createConfigField(studyScript, 'upload', {
    label: '完成后动作',
    attrs: {
      title: '选择课程任务答题完成后自动保存或自动提交。'
    },
    options: [
      ['submit', '自动提交'],
      ['save', '自动保存']
    ],
    defaultValue: 'submit'
  });
  uploadModeField.style.maxWidth = 'none';

  const examAndDebugRow = createElement('div');
  examAndDebugRow.style.display = 'grid';
  examAndDebugRow.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
  examAndDebugRow.style.gap = '12px';
  examAndDebugRow.style.alignItems = 'start';

  const examAutoSubmitToggleField = createConfigField(studyScript, 'enableExamAutoSubmit', {
    label: '考试自动交卷',
    attrs: {
      type: 'checkbox',
      title: '开启后，考试答题完成且完成率满足提交条件时才会自动交卷。默认关闭。'
    },
    defaultValue: false
  });
  examAutoSubmitToggleField.style.maxWidth = 'none';

  const debugLogPanelToggleField = createConfigField(studyScript, 'enableDebugLogPanel', {
    label: '日志窗口',
    attrs: {
      type: 'checkbox',
      title: '开启后在页面右下角显示调试日志窗口。默认关闭。'
    },
    defaultValue: false
  });
  debugLogPanelToggleField.style.maxWidth = 'none';

  const localQuestionCacheToggleField = createConfigField(studyScript, 'enableLocalQuestionCache', {
    label: '本地题库缓存',
    attrs: {
      type: 'checkbox',
      title: '开启后优先使用本地已缓存题目答案。默认开启。'
    },
    defaultValue: true
  });
  localQuestionCacheToggleField.style.maxWidth = 'none';

  aiAnswerRow.append(answerToggleField, aiFallbackToggleField);
  if (windowsExamOnly) {
    // “完成后动作（提交/保存）”属于课程任务流程，考试面板不需要。
    actionModeRow.append(aiFallbackFailureActionField);
    // “日志窗口”属于调试能力，考试面板不展示。
    examAndDebugRow.append(examAutoSubmitToggleField, localQuestionCacheToggleField);
  } else {
    actionModeRow.append(aiFallbackFailureActionField, uploadModeField);
    examAndDebugRow.append(examAutoSubmitToggleField, debugLogPanelToggleField, localQuestionCacheToggleField);
  }

  const heroActions = createElement('div');
  heroActions.style.display = 'flex';
  heroActions.style.gap = '8px';
  heroActions.style.flexWrap = 'wrap';
  heroActions.style.alignItems = 'center';

  syncWorkResultsControlDocument();
  const runtimeControls = state.workResults.runtimeControls;
  const isRunning = runtimeControls?.isRunning() ?? false;
  if (isRunning && tabAnswerPause.isPaused() && !runtimeControls!.isStopped()) runtimeControls!.stop();
  const isPaused = tabAnswerPause.isPaused() || (isRunning && runtimeControls!.isStopped());

  const pauseButton = createElement('button', { text: isPaused ? '继续答题' : '暂停答题' });
  pauseButton.title = isPaused ? '继续当前标签页的自动答题' : '暂停当前标签页的自动答题';
  pauseButton.onclick = () => {
    syncWorkResultsControlDocument();
    const controls = state.workResults.runtimeControls;
    const paused = tabAnswerPause.isPaused() || (controls?.isRunning() && controls.isStopped());
    tabAnswerPause.setPaused(!paused);
    if (controls?.isRunning()) {
      if (paused && controls.isStopped()) {
        controls.continuate();
      } else if (!paused && !controls.isStopped()) {
        controls.stop();
      }
    }
    if (paused) document.dispatchEvent(new CustomEvent('chaoxing-plus:answer-continuate', {
      detail: { hasWorker: controls?.isRunning() ?? false }
    }));
    renderWorkResultsPanel();
  };
  applyActionButtonStyle(pauseButton, 'primary');
  heroActions.append(pauseButton);

  const typeButton = createElement('button', {
    text: state.workResults.type === 'numbers' ? '切换为题目列表' : '切换为序号列表'
  });
  typeButton.onclick = () => {
    setWorkResultsView(state.workResults.type === 'numbers' ? 'questions' : 'numbers');
  };

  const clearButton = createElement('button', { text: state.workResults.resetOperation ? '正在重新作答...' : '清空结果' });
  clearButton.title = '取消当前轮次，清除页面全部作答痕迹，并重新作答';
  clearButton.onclick = clearAndRetryWorkResults;

  // 主操作（暂停/继续答题）用实心渐变；次要操作（切换视图、清空结果）用浅底描边，
  // 视觉权重明确分开，但入口一个都不少（只重排，不删功能）。
  applyActionButtonStyle(typeButton, 'default');
  applyActionButtonStyle(clearButton, 'danger');
  heroActions.append(typeButton, clearButton);

  const statusStrip = createPanelStatusStrip({
    results: state.workResults.results,
    paused: isPaused,
    running: isRunning
  });

  // hero 保持与既有结构一致（状态 + 答题设置 + 指标 + 主操作都在里面），
  // 因为既有回归按这条调用串断言「AI 兜底 / 考试开关都在面板 hero 里」。
  // 避免长滚动不靠搬走控件，而靠把设置区默认折叠（见下面 heroSettings）。
  hero.append(heroTop, aiAnswerRow, actionModeRow, examAndDebugRow, metricRow, heroActions);

  // 答题设置收进默认折叠的 details：这是本次「避免长滚动」的实际手段。
  // 控件仍在 hero 里（既有回归要求），但首屏只占一行摘要，主操作与状态条不会被挤下去。
  const heroSettings = createElement('details');
  heroSettings.dataset.cxPanelSettings = 'true';
  const heroSettingsSummary = createElement('summary', {
    text: windowsExamOnly ? '答题设置（AI 搜题 / 考试 / 缓存）' : '答题设置（自动答题 / AI 兜底 / 完成动作 / 缓存）'
  });
  heroSettingsSummary.style.cursor = 'pointer';
  heroSettingsSummary.style.minHeight = PANEL_TOUCH_TARGET_MIN_HEIGHT;
  heroSettingsSummary.style.lineHeight = PANEL_TOUCH_TARGET_MIN_HEIGHT;
  heroSettingsSummary.style.fontSize = '13px';
  heroSettingsSummary.style.fontWeight = '700';
  heroSettingsSummary.style.color = panelPinkTheme.text;
  heroSettingsSummary.style.padding = '0 2px';
  const heroSettingsBody = createElement('div');
  heroSettingsBody.style.display = 'grid';
  heroSettingsBody.style.gap = '12px';
  heroSettingsBody.style.paddingTop = '10px';
  heroSettings.append(heroSettingsSummary, heroSettingsBody);

  // 用 order 把「状态 → 主操作 → 指标 → 设置」排成固定顺序：
  // 用户先看到「现在在做什么」，再看按钮，最后才是设置。
  heroTop.style.order = '0';
  statusStrip.style.order = '1';
  heroActions.style.order = '2';
  metricRow.style.order = '3';
  heroSettings.style.order = '4';
  // 注意：aiAnswerRow / actionModeRow / examAndDebugRow 已经在上面 hero.append 里，
  // 这里再把它们移进 heroSettingsBody，最终只留在设置区（DOM 移动，不复制）。
  heroSettingsBody.append(aiAnswerRow, actionModeRow, examAndDebugRow);
  hero.insertBefore(heroSettings, metricRow);
  // 状态条紧跟标题下方。
  hero.insertBefore(statusStrip, heroTop.nextSibling);

  container.append(hero);

  const resultsSection = createElement('div');
  applySectionCardStyle(resultsSection, {
    padding: '14px',
    background: panelPinkTheme.sectionGradient,
    border: `1px solid ${panelPinkTheme.border}`
  });
  resultsSection.style.display = 'grid';
  resultsSection.style.gap = '12px';

  const resultsHeader = createElement('div');
  resultsHeader.style.display = 'flex';
  resultsHeader.style.alignItems = 'center';
  resultsHeader.style.justifyContent = 'space-between';
  resultsHeader.style.gap = '8px';
  resultsHeader.style.flexWrap = 'wrap';

  const resultsTitle = createElement('div', { text: '答题结果' });
  applySectionTitleStyle(resultsTitle, 'section');

  const summary = createElement('div', {
    text: `当前共 ${stats.totalQuestionCount} 题，已完成 ${stats.resolvedCount} 题。`
  });
  applyHintTextStyle(summary);

  resultsHeader.append(resultsTitle, summary);
  resultsSection.append(resultsHeader);

  if (state.workResults.results.length === 0) {
    const empty = createElement('div', { text: '暂无搜索结果。开始答题后，结果会实时显示在这里。' });
    // 三级文字色：三主题下 ≥ 4.5:1；旧值 #94a3b8 只有 2.56:1。
    empty.style.color = panelPinkTheme.subtle;
    empty.style.textAlign = 'center';
    empty.style.padding = '20px 12px';
    empty.style.borderRadius = '14px';
    empty.style.background = panelPinkTheme.surface;
    empty.style.border = `1px dashed ${panelPinkTheme.borderStrong}`;
    resultsSection.append(empty);
  } else {
    const list = createElement('div');
    list.dataset.workResultsList = 'true';
    list.style.display = 'grid';
    list.style.gap = '10px';
    // 长题目列表不撑爆面板：限制高度、内部滚动、滚动条收窄。
    applyScrollPaneStyle(list, 260);

    const selectResult = (index: number) => {
      state.workResults.currentResultIndex = index;
      renderWorkResultsPanel();
      const handlerType = state.workResults.questionPositionSyncHandlerType;
      if (handlerType) {
        questionPositionSyncHandlers[handlerType]?.(index);
      }
    };

    if (state.workResults.type === 'numbers') {
      const row = createElement('div');
      row.style.display = 'flex';
      row.style.flexWrap = 'wrap';
      row.style.gap = '8px';

      state.workResults.results.forEach((result, index) => {
        const button = createElement('button', { text: String(index + 1), title: formatWorkResultStatus(result) });
        const tone = resolveWorkResultTone(result, index === state.workResults.currentResultIndex);
        button.style.minWidth = '38px';
        button.style.height = '38px';
        button.style.borderRadius = '12px';
        button.style.border = `1px solid ${panelPinkTheme.border}`;
        button.style.cursor = 'pointer';
        button.style.fontWeight = '700';
        button.style.boxShadow = `0 6px 18px ${panelShadowColor(0.06)}`;

        if (tone === 'selected') {
          button.style.background = panelPinkTheme.primaryGradient;
          button.style.borderColor = panelPinkTheme.primary;
          button.style.color = '#fff';
        } else if (tone === 'manual') {
          button.style.background = panelPinkTheme.warningBg;
          button.style.borderColor = panelPinkTheme.warningFg;
          button.style.color = panelPinkTheme.warningFg;
        } else if (tone === 'success') {
          button.style.background = panelPinkTheme.successBg;
          button.style.borderColor = panelPinkTheme.successFg;
          button.style.color = panelPinkTheme.successFg;
        } else if (tone === 'danger') {
          button.style.background = panelPinkTheme.dangerBg;
          button.style.borderColor = panelPinkTheme.dangerFg;
          button.style.color = panelPinkTheme.dangerFg;
        } else {
          button.style.background = panelPinkTheme.surfaceStrong;
          button.style.color = panelPinkTheme.text;
        }

        button.onclick = () => selectResult(index);
        row.append(button);
      });

      list.append(row);
    } else {
      state.workResults.results.forEach((result, index) => {
        const item = createElement('button');
        const tone = resolveWorkResultTone(result, index === state.workResults.currentResultIndex);
        item.style.textAlign = 'left';
        item.style.padding = '12px';
        item.style.minHeight = PANEL_TOUCH_TARGET_MIN_HEIGHT;
        item.style.borderRadius = '14px';
        item.style.cursor = 'pointer';
        item.style.boxShadow = `0 8px 22px ${panelShadowColor(0.06)}`;
        item.style.borderLeft = index === state.workResults.currentResultIndex ? `4px solid ${panelPinkTheme.primary}` : '4px solid transparent';

        if (tone === 'selected') {
          item.style.border = `1px solid ${panelPinkTheme.borderStrong}`;
          item.style.background = panelPinkTheme.primarySoft;
        } else if (tone === 'manual') {
          item.style.border = `1px solid ${panelPinkTheme.warningFg}`;
          item.style.background = panelPinkTheme.warningBg;
        } else if (tone === 'success') {
          item.style.border = `1px solid ${panelPinkTheme.successFg}`;
          item.style.background = panelPinkTheme.successBg;
        } else if (tone === 'danger') {
          item.style.border = `1px solid ${panelPinkTheme.dangerFg}`;
          item.style.background = panelPinkTheme.dangerBg;
        } else {
          item.style.border = `1px solid ${panelPinkTheme.border}`;
          item.style.background = panelPinkTheme.surfaceStrong;
        }

        const title = createElement('div', { text: `${index + 1}. ${result.question || '未识别题目'}` });
        title.style.fontWeight = '700';
        title.style.wordBreak = 'break-word';
        title.style.color = panelPinkTheme.text;
        title.style.lineHeight = '1.6';

        const status = createElement('div', { text: formatWorkResultStatus(result) });
        status.style.fontSize = '12px';
        status.style.color = panelPinkTheme.muted;
        status.style.marginTop = '6px';

        item.append(title, status);
        item.onclick = () => selectResult(index);
        list.append(item);
      });
    }

    resultsSection.append(list, createWorkResultsDetail(state.workResults.results[state.workResults.currentResultIndex]));
  }

  container.append(resultsSection);
  container.append(createTikuAdapterConfigSection());

  const cacheSection = createElement('div');
  applySectionCardStyle(cacheSection, {
    padding: '14px',
    background: panelPinkTheme.sectionGradient,
    border: `1px solid ${panelPinkTheme.border}`
  });
  cacheSection.style.display = 'grid';
  cacheSection.style.gap = '12px';

  const cacheHeader = createElement('div');
  cacheHeader.style.display = 'flex';
  cacheHeader.style.alignItems = 'center';
  cacheHeader.style.justifyContent = 'space-between';
  cacheHeader.style.gap = '8px';
  cacheHeader.style.flexWrap = 'wrap';

  const cacheTitleWrap = createElement('div');
  cacheTitleWrap.style.display = 'grid';
  cacheTitleWrap.style.gap = '4px';

  const cacheTitle = createElement('div', { text: `题库缓存 · ${state.apps.localQuestionCaches.length}` });
  applySectionTitleStyle(cacheTitle, 'section');

  const cacheDesc = createElement('div', { text: '答题成功后会自动写入本地缓存，方便后续题目直接命中。' });
  applyHintTextStyle(cacheDesc);

  cacheTitleWrap.append(cacheTitle, cacheDesc);

  const clearCacheButton = createElement('button', { text: '清空缓存' });
  applyActionButtonStyle(clearCacheButton, 'default');
  clearCacheButton.onclick = () => {
    state.apps.localQuestionCaches = [];
    answerCache.clear();
    saveQuestionCaches();
    renderWorkResultsPanel();
  };

  cacheHeader.append(cacheTitleWrap, clearCacheButton);
  cacheSection.append(cacheHeader);

  if (state.apps.localQuestionCaches.length === 0) {
    const emptyCache = createElement('div', { text: '暂无题库缓存。答题成功后会自动写入这里。' });
    emptyCache.style.color = panelPinkTheme.subtle;
    emptyCache.style.textAlign = 'center';
    emptyCache.style.padding = '18px 12px';
    emptyCache.style.borderRadius = '14px';
    emptyCache.style.background = panelPinkTheme.surface;
    emptyCache.style.border = `1px dashed ${panelPinkTheme.borderStrong}`;
    cacheSection.append(emptyCache);
  } else {
    const cacheList = createElement('div');
    cacheList.style.display = 'grid';
    cacheList.style.gap = '8px';
    // 长缓存列表同样限制高度并内部滚动，不撑爆面板。
    applyScrollPaneStyle(cacheList, 220);

    state.apps.localQuestionCaches.slice(0, 20).forEach((cache) => {
      const item = createElement('div');
      item.style.border = `1px solid ${panelPinkTheme.border}`;
      item.style.borderRadius = '12px';
      item.style.padding = '10px 12px';
      item.style.background = panelPinkTheme.surfaceStrong;
      item.style.boxShadow = `0 6px 18px ${panelShadowColor(0.05)}`;

      const title = createElement('div', { text: cache.title || '未识别题目' });
      title.style.fontSize = '13px';
      title.style.fontWeight = '700';
      title.style.wordBreak = 'break-word';
      title.style.color = panelPinkTheme.text;
      title.style.lineHeight = '1.6';

      const answer = createElement('div', { text: `答案：${cache.answer || '空答案'}` });
      answer.style.fontSize = '12px';
      answer.style.marginTop = '6px';
      answer.style.wordBreak = 'break-word';
      answer.style.color = panelPinkTheme.text;

      item.append(title, answer);
      cacheList.append(item);
    });

    cacheSection.append(cacheList);
  }

  // ---- 页签组装 ----
  //
  // 面板原本把这五个板块纵向堆在一个 grid 里，实测要滚很远才能到设置区。
  // 现在按「你在做什么」分成互斥页签：查看结果、改答题设置、配题库、清缓存、改学习设置。
  //
  // 关键约束：
  // - overview 必须包含「状态条 + 主操作」，首屏就能暂停/继续/清空，不因切页签而失去操作入口；
  // - Windows 端是考试专用，没有 study 页签（学习设置在那端被裁掉）；
  // - 已保存的 activeTab 若落在当前端不存在的页签上，回落 overview，不渲染空白面板。

  // Windows 端是考试专用：cache（本地题库缓存）与 study（学习设置）两个页签都必须去掉，
  // 否则会渲染出空页签——对应的板块在那端根本没有被创建。
  // 顺序即页签顺序。这里用本地字面量而不是 import 的 WORK_RESULTS_PANEL_TABS：
  // 部分测试从 common.ts 抽取函数重新拼装最小运行时，模块级常量不会跟着过去，
  // 引用它会抛 ReferenceError，进而让整块面板渲染失败。
  const allTabs: WorkResultsPanelTab[] = ['overview', 'tiku', 'cache', 'study'];
  const availableTabs: WorkResultsPanelTab[] = windowsExamOnly
    ? allTabs.filter((tab) => tab !== 'study' && tab !== 'cache')
    : allTabs.slice();

  // 同 renderWorkResultsPanel：ui 状态内联容错，不引用本文件其它符号
  // （部分回归只抽取本函数重新编译，引用外部 helper 会 ReferenceError）。
  const panelState = (state as { workResults?: { ui?: { activeTab?: string } } }).workResults;
  const panelUi = panelState?.ui;
  const requestedTabName = String(panelUi?.activeTab ?? 'overview');
  const requestedTab = (availableTabs as string[]).includes(requestedTabName)
    ? (requestedTabName as WorkResultsPanelTab)
    : (availableTabs[0] ?? 'overview');
  const activeTab = requestedTab;
  if (panelUi) panelUi.activeTab = activeTab;

  const tabLabels: Record<WorkResultsPanelTab, string> = {
    overview: '结果',
    tiku: '题库配置',
    cache: '缓存',
    study: '学习设置'
  };

  // hero（状态条 + 暂停/继续 + 切换视图 + 清空结果 + 指标）**不进任何页签**，
  // 常驻在页签栏之上。
  //
  // 这条来自既有红线：`answer-work-controls-browser` 断言暂停/继续按钮在 worker
  // 全生命周期里始终 visible:true。把 hero 塞进 overview 页签后，切到别的页签它就
  // 不可见了——实测直接导致 12 条回归全红。主操作必须与页签正交。
  const resultsPanel = createPanelTabPanel('overview', activeTab);
  resultsPanel.append(resultsSection);

  const tikuPanel = createPanelTabPanel('tiku', activeTab);
  tikuPanel.append(createTikuAdapterConfigSection());

  container.append(
    hero,
    createPanelTabBar(
      availableTabs.map((id) => ({ id, label: tabLabels[id] })),
      activeTab,
      (tab) => {
        if (tab === state.workResults.ui.activeTab) return;
        state.workResults.ui.activeTab = tab;
        // 切页签等于换了一屏内容：沿用旧 scrollTop 会让新页签停在中间，
        // 所以先标记「这是一次切页签」，让 renderWorkResultsPanel 放弃恢复滚动位置。
        state.workResults.ui.pendingTabScrollReset = true;
        renderWorkResultsPanel();
      }
    ),
    resultsPanel,
    tikuPanel
  );

  // 缓存与学习设置只在扩展端存在（Windows 考试专用，这两块已被裁掉）。
  if (!windowsExamOnly) {
    const cachePanel = createPanelTabPanel('cache', activeTab);
    cachePanel.append(cacheSection);
    container.append(cachePanel);

    const studyPanel = createPanelTabPanel('study', activeTab);
    studyPanel.append(createStudySettingsPanel());
    container.append(studyPanel);
  }

  return container;
}

function renderWorkResultsPanel() {
  const panel = state.panels.workResults;
  if (!panel) return;
  // 切页签时放弃恢复滚动位置：新页签是一屏新内容，停在旧 scrollTop 会看到半截。
  //
  // ui 状态必须内联容错、不能用外部 helper：renderWorkResultsPanel 会被几个回归
  // 单独抽出来重编译（只取这一个函数的源码），引用任何本文件其它符号都会变成
  // ReferenceError，整个面板渲染失败。这里逐级判断，连 state.workResults 本身
  // 缺失也要能渲染（外部最小运行时的常见形态）。
  const workResultsState = (state as { workResults?: { ui?: { pendingTabScrollReset?: boolean } } }).workResults;
  const workResultsUi = workResultsState?.ui;
  const resetScroll = workResultsUi?.pendingTabScrollReset === true;
  if (workResultsUi) workResultsUi.pendingTabScrollReset = false;
  const rootScrollTop = resetScroll ? 0 : panel.root.scrollTop;
  const bodyScrollTop = resetScroll ? 0 : panel.body.scrollTop;
  const workResultsListScrollTop = panel.body.querySelector<HTMLElement>('[data-work-results-list="true"]')?.scrollTop ?? 0;
  const hostLogs = mountWindowsHostLogPanel(panel.root, isWindowsHostRuntime() && canShowFloatingPanel());
  const hostLogList = hostLogs?.querySelector<HTMLElement>('[data-windows-host-log-entries]');
  const hostLogScrollTop = hostLogList?.scrollTop ?? 0;

  // 渲染失败必须看得见，且不能让面板变成空白。
  //
  // 实测事故：localStorage 里残留旧格式的 work-results（字段名与当前实体不符）时，
  // createWorkResultsPanel 抛异常 → replaceChildren 完全不执行 → body 一直是空的，
  // 控制台也没有任何输出。用户看到的是「面板一片空白」，完全无法自诊断。
  // 现在：先渲染，失败就渲染一个可恢复的错误页，并在页面上给出「清空结果」入口。
  let rendered: HTMLElement | null = null;
  let renderError: unknown;
  try {
    rendered = createWorkResultsPanel();
  } catch (error) {
    renderError = error;
  }
  if (rendered) {
    panel.body.replaceChildren(rendered);
  } else {
    panel.body.replaceChildren(createPanelRenderFailureView(renderError));
    // 坏数据留在存储里会每次渲染都失败，直接清掉，让用户下次正常使用。
    try {
      state.workResults.results = [];
      runtimeStore.set(WORK_RESULTS_KEY, []);
    } catch {
      // 存储不可写时只保证界面可恢复
    }
  }
  if (hostLogs) panel.body.firstElementChild?.prepend(hostLogs);
  if (hostLogList) hostLogList.scrollTop = hostLogScrollTop;
  panel.root.scrollTop = rootScrollTop;
  panel.body.scrollTop = bodyScrollTop;

  const nextWorkResultsList = panel.body.querySelector<HTMLElement>('[data-work-results-list="true"]');
  if (nextWorkResultsList) {
    nextWorkResultsList.scrollTop = workResultsListScrollTop;
  }
}

function createAppsPanel() {
  const container = createElement('div');
  container.style.display = 'grid';
  container.style.gap = '10px';

  const header = createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'space-between';
  header.style.gap = '8px';
  header.style.flexWrap = 'wrap';

  const count = createElement('div', { text: `当前缓存：${state.apps.localQuestionCaches.length}` });
  count.style.fontSize = '12px';
  count.style.color = panelPinkTheme.muted;

  const clearButton = createElement('button', { text: '清空缓存' });
  clearButton.style.padding = '4px 8px';
  clearButton.style.border = `1px solid ${panelPinkTheme.border}`;
  clearButton.style.borderRadius = '6px';
  clearButton.style.background = panelPinkTheme.surfaceStrong;
  clearButton.style.color = panelPinkTheme.text;
  clearButton.style.cursor = 'pointer';
  clearButton.onclick = () => {
    state.apps.localQuestionCaches = [];
    answerCache.clear();
    saveQuestionCaches();
    renderAppsPanel();
  };

  header.append(count, clearButton);
  container.append(header);

  if (state.apps.localQuestionCaches.length === 0) {
    const empty = createElement('div', { text: '暂无题库缓存。答题成功后会自动写入这里。' });
    empty.style.color = panelPinkTheme.subtle;
    empty.style.textAlign = 'center';
    empty.style.padding = '12px 0';
    container.append(empty);
    return container;
  }

  const list = createElement('div');
  list.style.display = 'grid';
  list.style.gap = '8px';
  list.style.maxHeight = '320px';
  list.style.overflow = 'auto';

  state.apps.localQuestionCaches.slice(0, 100).forEach((cache) => {
    const item = createElement('div');
    item.style.border = `1px solid ${panelPinkTheme.border}`;
    item.style.borderRadius = '8px';
    item.style.padding = '10px';
    item.style.background = panelPinkTheme.surfaceStrong;
    item.style.boxShadow = `0 6px 18px ${panelShadowColor(0.05)}`;

    const title = createElement('div', { text: cache.title || '未识别题目' });
    title.style.fontSize = '13px';
    title.style.fontWeight = '600';
    title.style.wordBreak = 'break-word';
    title.style.color = panelPinkTheme.text;

    const answer = createElement('div', { text: `答案：${cache.answer || '空答案'}` });
    answer.style.fontSize = '12px';
    answer.style.marginTop = '6px';
    answer.style.wordBreak = 'break-word';
    answer.style.color = panelPinkTheme.text;

    item.append(title, answer);

    if (cache.homepage) {
      const link = document.createElement('a');
      link.href = cache.homepage;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = cache.homepage;
      link.style.display = 'block';
      link.style.fontSize = '12px';
      link.style.marginTop = '4px';
      link.style.color = panelPinkTheme.link;
      applyQuestionTextWrapStyle(link);
      item.append(link);
    }

    list.append(item);
  });

  container.append(list);
  return container;
}

function renderAppsPanel() {
  const panel = state.panels.apps;
  if (!panel) return;
  panel.body.replaceChildren(createAppsPanel());
}

/**
 * 小屏（< 400px 视口）下面板必须收窄，不能越过视口边缘：
 * 返回本次可用的外宽（含左右各一份安全边距）。
 */
function resolvePanelOuterWidth(kind: 'workResults' | 'apps') {
  const desired = kind === 'workResults' ? state.workResultsPanelWidth : 360;
  const viewport = window.innerWidth || 0;
  if (!Number.isFinite(viewport) || viewport <= 0) {
    return `${desired}px`;
  }
  if (viewport >= PANEL_NARROW_VIEWPORT_PX) {
    return `${desired}px`;
  }
  // 小屏：宽度压到视口内，同时保证仍有可用宽度（最低 240px，避免控件被挤爆）。
  const available = Math.max(240, viewport - PANEL_MIN_VIEWPORT_MARGIN * 2);
  return `${Math.min(desired, available)}px`;
}

function applyPanelVisual(panel: ScriptPanel | undefined, kind: 'workResults' | 'apps') {
  if (!panel) return;

  panel.root.style.position = 'fixed';
  if (kind === 'workResults') {
    const position = clampPanelPosition(state.workResultsPanelPosition, state.workResultsPanelWidth);
    panel.root.style.right = `${position.right}px`;
    panel.root.style.top = `${position.top}px`;
  } else {
    panel.root.style.right = '16px';
    panel.root.style.top = '108px';
  }
  panel.root.style.zIndex = kind === 'workResults' ? '2147483645' : '2147483644';
  panel.root.style.width = resolvePanelOuterWidth(kind);
  panel.root.style.boxSizing = 'border-box';
  panel.root.style.maxWidth = 'calc(100vw - 24px)';
  panel.root.style.maxHeight = kind === 'workResults' ? '76vh' : '50vh';
  panel.root.style.overflow = 'auto';
  panel.root.style.overscrollBehavior = 'contain';
  panel.root.style.scrollbarGutter = 'stable';
  panel.root.dataset.chaoxingPlusTheme = resolvePanelThemeName();
  panel.root.style.background = panelPinkTheme.shellGradient;
  // 不使用 backdrop-filter：它会把面板背后的页面内容整体模糊，在 CEF75 上体验尤差。
  panel.root.style.backdropFilter = 'none';
  panel.root.style.border = `1px solid ${panelPinkTheme.borderStrong}`;
  panel.root.style.boxShadow = panelPinkTheme.shellShadow;
  panel.root.style.borderRadius = kind === 'workResults' ? '24px' : '18px';
  panel.root.style.padding = kind === 'workResults' ? '14px' : '12px';
  // 干玻璃表面层（78-*.md §6.2，用户裁决 Q78-2）：只保留半透明底 + 高光描边，
  // 默认不含任何模糊。做成独立层而不是改 root 的 background/border —— 那三行与
  // root 的 borderTopColor 已被 pink-panel-ui.test.mjs:160-162 与
  // windows-panel-theme.browser.mjs:77/80/83 逐字符钉死为主题判据。
  ensurePanelGlassLayer(panel.root);
  panel.configsContainer.style.display = '';
  panel.body.style.display = '';
  bindPanelDrag(panel, kind);
  snapPanelOuterWidth(panel.root);
}

function highlightPanel(panel: ScriptPanel | undefined) {
  if (!panel) return;
  panel.root.style.outline = '2px solid #1677ff';
  panel.root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  window.setTimeout(() => {
    panel.root.style.outline = '';
  }, 1200);
}

window.addEventListener('storage', (event) => {
  if (event.key === WORK_RESULTS_KEY) {
    state.workResults.results = parseStoredValue(event.newValue, [] as SimplifyWorkResult[]);
    if (state.workResults.currentResultIndex >= state.workResults.results.length) {
      state.workResults.currentResultIndex = Math.max(state.workResults.results.length - 1, 0);
    }
    renderWorkResultsPanel();
    return;
  }

  if (event.key === WORK_RESULTS_VIEW_KEY) {
    state.workResults.type = parseStoredValue(event.newValue, 'numbers' as WorkResultsView);
    renderWorkResultsPanel();
    return;
  }

  if (event.key === QUESTION_CACHE_KEY) {
    if (applyQuestionCaches(parseStoredValue(event.newValue, [] as QuestionCache[]))) {
      renderWorkResultsPanel();
    }
  }
});

document.addEventListener('chaoxing-plus:shared-store-hydrate', (event) => {
  const detail = typeof event === 'object' && event && 'detail' in event
    ? (event as CustomEvent<Record<string, unknown>>).detail
    : undefined;
  const sharedQuestionCaches = detail?.[QUESTION_CACHE_KEY];
  let shouldRefreshWorkResultsPanel = !detail || shouldRefreshPanelForSharedValues(detail);

  if (applyQuestionCaches(sharedQuestionCaches)) {
    shouldRefreshWorkResultsPanel = true;
  }

  if (shouldRefreshWorkResultsPanel) {
    renderWorkResultsPanel();
  }
});

try {
  const sharedConfigObserver = new MutationObserver((mutations) => {
    let shouldRefreshPanel = false;

    for (const { attributeName, target } of mutations) {
      if (!attributeName?.startsWith(SHARED_STORE_ATTRIBUTE_PREFIX)) {
        continue;
      }

      const currentValue = target instanceof Element ? target.getAttribute(attributeName) : null;
      if (lastSharedAttributeValues.get(attributeName) === currentValue) {
        continue;
      }

      lastSharedAttributeValues.set(attributeName, currentValue);
      shouldRefreshPanel = true;
    }

    if (shouldRefreshPanel) {
      renderWorkResultsPanel();
    }
  });

  const root = document.documentElement;
  if (root) {
    sharedConfigObserver.observe(root, { attributes: true });
  }
} catch {
  // ignore shared config observer failures
}

export const CommonProject = Project.create({
  name: '通用',
  domains: [],
  scripts: {
    settings: {
      name: '⚙️ 全局设置',
      hideInPanel: true,
      matches: [['所有页面', /.*/]],
      namespace: 'common.settings',
      methods() {
        return {
          getWorkOptions,
          notificationBySetting(content: string) {
            console.info('[chaoxing-plus]', content);
          }
        };
      }
    },
    workResults: {
      name: '📄 答题结果',
      hideInPanel: () => !canShowFloatingPanel(),
      matches: [['所有页面', /.*/]],
      namespace: 'common.work-results',
      methods() {
        return {
          init(opts?: { questionPositionSyncHandlerType?: QuestionPositionSyncHandlerType }) {
            state.workResults.questionPositionSyncHandlerType = opts?.questionPositionSyncHandlerType;
            state.workResults.currentResultIndex = 0;
            setWorkResults([]);
          },
          setResults(results: SimplifyWorkResult[]) {
            setWorkResults(results);
          },
          appendResults(results: SimplifyWorkResult[]) {
            setWorkResults(state.workResults.results.concat(results));
          },
          setRuntimeControls(controls: WorkResultsRuntimeControls) {
            syncWorkResultsControlDocument(controls.ownerDocument ?? document);
            state.workResults.resetOperation = undefined;
            state.workResults.runtimeControls = controls;
            if (tabAnswerPause.isPaused()) controls.stop();
            renderWorkResultsPanel();
          },
          clearRuntimeControls() {
            state.workResults.resetOperation = undefined;
            state.workResults.runtimeControls = undefined;
            setWorkResults(
              state.workResults.results.map((item) => ({
                ...item,
                retrying: false
              }))
            );
          },
          patchResult(index: number, patch: Partial<SimplifyWorkResult>) {
            patchWorkResult(index, patch);
          },
          updateWorkStateByResults(results: { requested: boolean; resolved: boolean }[]) {
            const merged = state.workResults.results.map((item, index) => ({
              ...item,
              requested: results[index]?.requested ?? item.requested,
              resolved: results[index]?.resolved ?? item.resolved
            }));
            setWorkResults(merged);
          },
          getResults() {
            return state.workResults.results;
          },
          refresh() {
            renderWorkResultsPanel();
          },
          createWorkResultsPanel
        };
      },
      onrender({ panel }) {
        state.panels.workResults = panel;
        applyPanelVisual(panel, 'workResults');
        renderWorkResultsPanel();
      }
    },
    render: {
      name: '🖼️ 渲染',
      hideInPanel: true,
      matches: [['所有页面', /.*/]],
      namespace: 'common.render',
      methods() {
        return {
          pin(_script?: unknown) {
            highlightPanel(state.panels.workResults);
          },
          normal() {},
          minimize() {}
        };
      }
    },
    apps: {
      name: '🔎 拓展应用',
      hideInPanel: true,
      matches: [['所有页面', /.*/]],
      namespace: 'common.apps',
      methods() {
        return {
          searchAnswerInCaches<T>(
            title: string,
            provider: () => Promise<T>,
            mode: SearchCacheMode = 'normal',
            identity?: QuestionCacheIdentity
          ) {
            const cacheKey = answerCacheKey(title, mode, identity);
            if (!isLocalQuestionCacheEnabled()) {
              return provider().then((result) => {
                if (Array.isArray(result)) {
                  if (shouldCacheSearchInfos(result)) {
                    answerCache.set(cacheKey, result as SearchInformation[]);
                  }
                }
                return result;
              });
            }

            if (answerCache.has(cacheKey)) {
              const cachedResults = answerCache.get(cacheKey);
              if (cachedResults && shouldCacheSearchInfos(cachedResults)) {
                return Promise.resolve(cachedResults as T);
              }
              answerCache.delete(cacheKey);
            }

            const cacheResults = questionCachesToSearchInfos(title, mode, identity);
            if (cacheResults.length) {
              answerCache.set(cacheKey, cacheResults);
              return Promise.resolve(cacheResults as T);
            }

            return provider().then((result) => {
              if (Array.isArray(result)) {
                if (shouldCacheSearchInfos(result)) {
                  answerCache.set(cacheKey, result as SearchInformation[]);
                }
              }
              return result;
            });
          },
          addQuestionCacheFromWorkResult(
            result: unknown,
            mode: SearchCacheMode = 'normal',
            identity?: QuestionCacheIdentity
          ) {
            const normalized = normalizeWorkResultsPayload(result);
            if (normalized.length === 0) {
              return;
            }
            addQuestionCaches(...resultToQuestionCaches(normalized, mode, identity));
          },
          clearQuestionCaches() {
            state.apps.localQuestionCaches = [];
            answerCache.clear();
            saveQuestionCaches();
            renderAppsPanel();
            renderWorkResultsPanel();
          }
        };
      },
      onrender({ panel }) {
        state.panels.apps = panel;
        applyPanelVisual(panel, 'apps');
        renderAppsPanel();
      }
    }
  }
});


import type { AnswererWrapper, SearchInformation, SimplifyWorkResult, WorkUploadType } from '../core/index.js';
import { Project, runtimeStore } from '../runtime/index.js';
import { $modal } from '../runtime/message.js';
import type { ScriptPanel, ConfigDefinition } from '../runtime/types.js';
import { playbackRate, volume } from '../utils/configs.js';
import {
  createDefaultWorkResultsPanelUiState,
  toggleWorkResultsPanelCollapsed,
  formatEnabledStudyTaskCapabilitySummary
} from './study-panel-state.js';
import { shouldShowFloatingPanel } from './panel-visibility.js';
import {
  formatQuestionTypeLabel,
  formatWorkResultStatus,
  resolveWorkResultTone
} from './work-results-status.js';
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
  period: number;
  thread: number;
  upload: WorkUploadType | 'submit';
  answererWrappers: AnswererWrapper[];
  stopSecondWhenFinish: number;
  redundanceWordsText: string;
  answerSeparators: string;
  answerMatchMode: 'exact' | 'includes' | 'similar';
  enableRandomFallbackAnswer: boolean;
  enableAIFallbackAnswer: boolean;
  aiFallbackFailureAction: 'pause' | 'skip';
}

type WorkResultsRuntimeControls = {
  isRunning: () => boolean;
  isStopped: () => boolean;
  stop: () => void;
  continuate: () => void;
  retryQuestion: (index: number) => Promise<SimplifyWorkResult | undefined>;
  canRetryQuestion?: (index: number) => boolean;
};

type WorkResultsView = 'numbers' | 'questions';
type QuestionPositionSyncHandlerType = 'cx';

type PanelPosition = {
  right: number;
  top: number;
};

interface QuestionCache {
  title: string;
  answer: string;
  from?: string;
  homepage?: string;
  ai?: boolean;
}

const WORK_RESULTS_PANEL_POSITION_KEY = 'common.work-results.panel-position';

const WORK_OPTIONS_KEY = 'common.settings.work-options';
const WORK_RESULTS_KEY = 'common.work-results.results';
const WORK_RESULTS_VIEW_KEY = 'common.work-results.type';
const QUESTION_CACHE_KEY = 'common.apps.question-caches';
const SHARED_STUDY_SETTINGS_PREFIX = 'cx.new.study.';

const SHARED_STORE_ATTRIBUTE_PREFIX = 'data-chaoxing-plus-shared-';

const defaultWorkOptions: CommonWorkOptions = {
  period: 3,
  thread: 1,
  upload: 'submit',
  answererWrappers: [],
  stopSecondWhenFinish: 3,
  redundanceWordsText: '',
  answerSeparators: '#,|,;,；',
  answerMatchMode: 'includes',
  enableRandomFallbackAnswer: false,
  enableAIFallbackAnswer: false,
  aiFallbackFailureAction: 'pause'
};

const answerCache = new Map<string, SearchInformation[]>();
let hasWarnedHighPlaybackRateInCurrentPage = false;

function canShowFloatingPanel() {
  try {
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

const state = {
  panels: {
    workResults: undefined as ScriptPanel | undefined,
    apps: undefined as ScriptPanel | undefined
  },
  workResultsPanelPosition: runtimeStore.get(WORK_RESULTS_PANEL_POSITION_KEY, { right: 16, top: 16 } as PanelPosition),
  workResults: {
    results: runtimeStore.get(WORK_RESULTS_KEY, [] as SimplifyWorkResult[]),
    currentResultIndex: 0,
    type: runtimeStore.get(WORK_RESULTS_VIEW_KEY, 'numbers' as WorkResultsView),
    questionPositionSyncHandlerType: undefined as QuestionPositionSyncHandlerType | undefined,
    runtimeControls: undefined as WorkResultsRuntimeControls | undefined,
    ui: createDefaultWorkResultsPanelUiState()
  },
  apps: {
    localQuestionCaches: runtimeStore.get(QUESTION_CACHE_KEY, [] as QuestionCache[])
  }
};

const questionPositionSyncHandlers: Record<QuestionPositionSyncHandlerType, (index: number) => void> = {
  cx(index) {
    const el = document.querySelectorAll<HTMLElement>('[id*="sigleQuestionDiv"], .questionLi')?.item(index);
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

  return {
    baseurl: typeof baseurl === 'string' ? baseurl : DEFAULT_TIKU_BASE_URL,
    key: typeof key === 'string' ? key : ''
  };
}

function getWorkOptions(): CommonWorkOptions {
  const stored = runtimeStore.get(WORK_OPTIONS_KEY, defaultWorkOptions);
  const tikuConfig = getStoredTikuAdapterConfig();
  const resolvedBaseurl = resolveTikuAdapterBaseUrl(tikuConfig.baseurl, DEFAULT_TIKU_BASE_URL);
  const dynamicProblem = getTikuAdapterConfigProblem({
    baseurl: resolvedBaseurl,
    key: tikuConfig.key
  });

  const dynamicWrapper = dynamicProblem
    ? undefined
    : createTikuAdapterAnswererWrapper({
        baseurl: resolvedBaseurl,
        key: tikuConfig.key
      });

  return {
    ...stored,
    upload: getStudySettingValue('upload', 'submit'),
    enableRandomFallbackAnswer: getStudySettingValue(
      'enableRandomFallbackAnswer',
      stored.enableRandomFallbackAnswer ?? false
    ),
    enableAIFallbackAnswer: getStudySettingValue('enableAIFallbackAnswer', stored.enableAIFallbackAnswer ?? false),
    aiFallbackFailureAction: getStudySettingValue('aiFallbackFailureAction', stored.aiFallbackFailureAction ?? 'pause'),
    answererWrappers: dynamicWrapper ? [dynamicWrapper] : []
  };
}

function mergeIncomingWorkResults(results: SimplifyWorkResult[]) {
  return results.map((item, index) => ({
    ...item,
    type: item.type ?? state.workResults.results[index]?.type,
    manual: item.manual ?? state.workResults.results[index]?.manual ?? false,
    retrying: item.retrying ?? false
  }));
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

function saveWorkResultsPanelPosition(position: PanelPosition) {
  state.workResultsPanelPosition = position;
  runtimeStore.set(WORK_RESULTS_PANEL_POSITION_KEY, position);
}

function clampPanelPosition(position: PanelPosition, width = 460) {
  const maxTop = Math.max(window.innerHeight - 120, 16);
  const maxRight = Math.max(window.innerWidth - 120, 16);
  return {
    top: Math.min(Math.max(position.top, 16), maxTop),
    right: Math.min(Math.max(position.right, 16), maxRight + Math.max(width - 120, 0))
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
  handle.style.borderBottom = '1px solid rgba(15, 23, 42, 0.08)';
  handle.style.position = 'sticky';
  handle.style.top = '-14px';
  handle.style.zIndex = '3';
  handle.style.background = 'rgba(255,255,255,0.96)';
  handle.style.backdropFilter = 'blur(12px)';
  handle.style.boxShadow = '0 10px 24px rgba(15, 23, 42, 0.04)';

  const rootWithHeaderState = root as HTMLElement & {
    __cxHeaderHandle?: HTMLElement;
    __cxHeaderHint?: HTMLDivElement;
  };

  const title = createElement('div', { text: 'ChaoXing Plus Tools' });
  title.style.fontSize = '13px';
  title.style.fontWeight = '700';
  title.style.color = '#0f172a';
  title.style.letterSpacing = '0.02em';

  const hint = createElement('div', { text: '点击折叠 · 可拖动' });
  hint.style.fontSize = '12px';
  hint.style.color = '#64748b';

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
  runtimeStore.set(key, value);
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

async function maybeWarnHighPlaybackRate(script: { cfg: Record<string, unknown>; namespace?: string }, value: unknown) {
  const rate = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(rate) || rate < 2 || hasWarnedHighPlaybackRateInCurrentPage) {
    return;
  }

  hasWarnedHighPlaybackRateInCurrentPage = true;
  const confirmed = await $modal.confirm({
    content: '当前倍速已达到或超过 2 倍。超星存在较强风控，高倍速可能导致进度清空、回退或学习异常，请谨慎使用。',
    confirmButtonText: '继续使用',
    cancelButtonText: '降到 1 倍',
    defaultConfirmed: true
  });

  if (!confirmed) {
    setStudySettingValueInternal(script, 'playbackRate', 1, { warn: false });
  }
}

function setStudySettingValueInternal(
  script: { cfg: Record<string, unknown>; namespace?: string },
  key: string,
  value: unknown,
  options: { warn?: boolean } = {}
) {
  const setValue = (nextKey: string, nextValue: unknown) => {
    script.cfg[nextKey] = nextValue;
    const storageKey = `${script.namespace}.${nextKey}`;
    if (isSharedStudySettingKey(storageKey)) {
      syncStudySettingCrossDomain(storageKey, nextValue);
    } else {
      runtimeStore.set(storageKey, nextValue);
    }
    applyStudySettingRuntimeEffect(nextKey, nextValue);
  };

  if (key === 'volume') {
    const normalizedVolume = Math.min(1, Math.max(0, typeof value === 'number' ? value : Number(value)));
    setValue('volume', normalizedVolume);
    setValue('muteMedia', normalizedVolume <= 0);
    renderWorkResultsPanel();
    return;
  }

  if (key === 'muteMedia') {
    const muted = Boolean(value);
    setValue('muteMedia', muted);
    if (muted) {
      setValue('volume', 0);
    }
    renderWorkResultsPanel();
    return;
  }

  setValue(key, value);
  if (key === 'playbackRate' && options.warn !== false) {
    void maybeWarnHighPlaybackRate(script, value);
  }
  renderWorkResultsPanel();
}

function setStudySettingValue(script: { cfg: Record<string, unknown>; namespace?: string }, key: string, value: unknown) {
  setStudySettingValueInternal(script, key, value);
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
  runtimeStore.set(QUESTION_CACHE_KEY, state.apps.localQuestionCaches);
}

function addQuestionCaches(...items: QuestionCache[]) {
  for (const item of items) {
    if (!item.title.trim() || !item.answer.trim()) {
      continue;
    }

    if (
      state.apps.localQuestionCaches.find((cache) => cache.title === item.title && cache.answer === item.answer) === undefined
    ) {
      state.apps.localQuestionCaches.unshift(item);
    }
  }

  state.apps.localQuestionCaches.splice(200);
  saveQuestionCaches();
  renderAppsPanel();
  renderWorkResultsPanel();
}

function questionCachesToSearchInfos(title: string): SearchInformation[] {
  const matched = state.apps.localQuestionCaches.filter((cache) => cache.title.trim() === title.trim());
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

function resultToQuestionCaches(results: SimplifyWorkResult[]): QuestionCache[] {
  return results.flatMap((result) =>
    result.searchInfos.flatMap((info) =>
      info.results
        .filter((entry) => entry[1])
        .map((entry) => ({
          title: result.question || entry[0],
          answer: entry[1],
          from: info.name.replace(/【题库缓存】/g, '') || '未知题库',
          homepage: info.homepage || '',
          ai: Boolean((entry[2] as Record<string, unknown> | undefined)?.ai)
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
  element.style.background = options.background ?? 'rgba(248, 250, 252, 0.86)';
  element.style.border = options.border ?? '1px solid rgba(148, 163, 184, 0.18)';
  element.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.75)';
}

function applyActionButtonStyle(button: HTMLButtonElement, tone: 'default' | 'primary' | 'danger' = 'default') {
  button.style.padding = '7px 12px';
  button.style.borderRadius = '10px';
  button.style.cursor = 'pointer';
  button.style.fontSize = '12px';
  button.style.fontWeight = '600';
  button.style.transition = 'all 0.2s ease';

  if (tone === 'primary') {
    button.style.border = '1px solid rgba(37, 99, 235, 0.24)';
    button.style.background = 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)';
    button.style.color = '#fff';
    button.style.boxShadow = '0 8px 20px rgba(37, 99, 235, 0.22)';
    return;
  }

  if (tone === 'danger') {
    button.style.border = '1px solid rgba(239, 68, 68, 0.18)';
    button.style.background = 'rgba(255,255,255,0.96)';
    button.style.color = '#b91c1c';
    button.style.boxShadow = '0 6px 18px rgba(15, 23, 42, 0.06)';
    return;
  }

  button.style.border = '1px solid rgba(148, 163, 184, 0.22)';
  button.style.background = 'rgba(255,255,255,0.96)';
  button.style.color = '#1e293b';
  button.style.boxShadow = '0 6px 18px rgba(15, 23, 42, 0.06)';
}

function createMetricChip(label: string, value: string) {
  const chip = createElement('div');
  chip.style.display = 'grid';
  chip.style.gap = '4px';
  chip.style.minWidth = '112px';
  chip.style.padding = '10px 12px';
  chip.style.borderRadius = '14px';
  chip.style.background = 'rgba(255,255,255,0.82)';
  chip.style.border = '1px solid rgba(148, 163, 184, 0.18)';
  chip.style.boxShadow = '0 8px 22px rgba(15, 23, 42, 0.06)';

  const title = createElement('div', { text: label });
  title.style.fontSize = '11px';
  title.style.color = '#64748b';

  const number = createElement('div', { text: value });
  number.style.fontSize = '15px';
  number.style.fontWeight = '700';
  number.style.color = '#0f172a';

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

  if (tone === 'manual') {
    badge.style.background = 'rgba(250, 204, 21, 0.14)';
    badge.style.color = '#a16207';
    return badge;
  }

  if (tone === 'success') {
    badge.style.background = 'rgba(34, 197, 94, 0.12)';
    badge.style.color = '#15803d';
    return badge;
  }

  if (tone === 'danger') {
    badge.style.background = 'rgba(239, 68, 68, 0.12)';
    badge.style.color = '#b91c1c';
    return badge;
  }

  badge.style.background = 'rgba(148, 163, 184, 0.12)';
  badge.style.color = '#64748b';
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
    background: 'rgba(255,255,255,0.9)',
    border: '1px solid rgba(148, 163, 184, 0.18)'
  });
  container.style.display = 'grid';
  container.style.gap = '10px';

  if (!result) {
    const empty = createElement('div', { text: '暂无搜索结果。' });
    empty.style.color = '#64748b';
    container.append(empty);
    return container;
  }

  const titleWrap = createElement('div');
  titleWrap.style.display = 'grid';
  titleWrap.style.gap = '8px';

  const title = createElement('div', { text: result.question || '未识别题目' });
  title.style.fontWeight = '700';
  title.style.lineHeight = '1.6';
  title.style.color = '#0f172a';
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
  typeMeta.style.color = '#64748b';

  metaRow.append(typeMeta, createStatusBadge(result));
  titleWrap.append(title, metaRow);
  container.append(titleWrap);

  const runtimeControls = state.workResults.runtimeControls;
  const selectedIndex = state.workResults.currentResultIndex;
  const canRetry = Boolean(
    runtimeControls?.retryQuestion && (runtimeControls.canRetryQuestion?.(selectedIndex) ?? true)
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

    patchWorkResult(selectedIndex, { retrying: true, error: undefined, manual: false });
    try {
      const retried = await runtimeControls.retryQuestion(selectedIndex);
      if (retried) {
        patchWorkResult(selectedIndex, {
          ...retried,
          retrying: false,
          manual: false
        });
      } else {
        patchWorkResult(selectedIndex, { retrying: false });
      }
    } catch (err) {
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
    const error = createElement('div', { text: result.error });
    error.style.color = '#c0392b';
    error.style.padding = '10px 12px';
    error.style.borderRadius = '12px';
    error.style.background = 'rgba(254, 242, 242, 0.95)';
    error.style.border = '1px solid rgba(248, 113, 113, 0.2)';
    applyQuestionTextWrapStyle(error);
    container.append(error);
  }

  if (result.searchInfos.length === 0) {
    const empty = createElement('div', { text: '题库没有返回答案。' });
    empty.style.color = '#94a3b8';
    empty.style.padding = '6px 0';
    container.append(empty);
    return container;
  }

  for (const info of result.searchInfos) {
    const block = createElement('div');
    applySectionCardStyle(block, {
      padding: '12px',
      background: 'rgba(248, 250, 252, 0.92)',
      border: '1px solid rgba(226, 232, 240, 0.95)'
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
    header.style.color = '#0f172a';

    const sub = createElement('div', {
      text: info.error ? `错误：${info.error}` : `结果数：${info.results.length}`
    });
    sub.style.fontSize = '12px';
    sub.style.color = info.error ? '#c0392b' : '#64748b';
    applyQuestionTextWrapStyle(sub);

    headerRow.append(header, sub);
    block.append(headerRow);

    if (info.homepage) {
      const link = document.createElement('a');
      link.href = info.homepage;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = info.homepage;
      link.style.display = 'block';
      link.style.fontSize = '12px';
      link.style.color = '#2563eb';
      link.style.wordBreak = 'break-all';
      block.append(link);
    }

    if (info.results.length) {
      const list = createElement('div');
      list.style.display = 'grid';
      list.style.gap = '8px';

      for (const entry of info.results) {
        const item = createElement('div');
        item.style.background = 'rgba(255,255,255,0.96)';
        item.style.borderRadius = '12px';
        item.style.padding = '10px 12px';
        item.style.border = '1px solid rgba(226, 232, 240, 0.9)';

        const answer = createElement('div', { text: entry[1] || '空答案' });
        answer.style.fontWeight = '700';
        answer.style.wordBreak = 'break-word';
        answer.style.color = '#0f172a';

        const question = createElement('div', { text: entry[0] || '' });
        question.style.fontSize = '12px';
        question.style.color = '#64748b';
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

  if (definition.label) {
    const label = createElement('label', { text: definition.label });
    label.style.fontSize = '12px';
    label.style.fontWeight = '700';
    label.style.color = '#334155';
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
      selectedBadge.style.background = 'rgba(37, 99, 235, 0.10)';
      selectedBadge.style.color = '#1d4ed8';
      selectedBadge.style.fontSize = '12px';
      selectedBadge.style.fontWeight = '700';

      const wrapHint = createElement('div', { text: '倍率选项会根据可用宽度自动换行显示。' });
      wrapHint.style.fontSize = '12px';
      wrapHint.style.color = '#64748b';
      wrapHint.style.lineHeight = '1.5';

      optionGrid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(72px, 1fr))';
      optionGrid.style.alignItems = 'stretch';

      optionWrap.append(selectedBadge, wrapHint);
    } else {
      optionGrid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(96px, 1fr))';
    }

    definition.options.forEach(([value, text]) => {
      const selected = String(currentValue ?? definition.defaultValue) === value;
      const option = createElement('button', { text });
      option.type = 'button';
      option.title = attrs.title ? String(attrs.title) : text;
      option.style.padding = '10px 12px';
      option.style.minHeight = '48px';
      option.style.borderRadius = '12px';
      option.style.border = selected ? '1px solid rgba(37, 99, 235, 0.26)' : '1px solid rgba(226, 232, 240, 0.95)';
      option.style.background = selected
        ? 'linear-gradient(135deg, rgba(219, 234, 254, 0.95) 0%, rgba(239, 246, 255, 0.98) 100%)'
        : 'rgba(255,255,255,0.98)';
      option.style.color = selected ? '#1d4ed8' : '#334155';
      option.style.fontSize = '12px';
      option.style.fontWeight = selected ? '700' : '600';
      option.style.cursor = 'pointer';
      option.style.textAlign = 'center';
      option.style.whiteSpace = isPlaybackRateField ? 'nowrap' : 'normal';
      option.style.wordBreak = 'break-word';
      option.style.lineHeight = '1.5';
      option.style.alignContent = 'center';
      option.onclick = () => {
        setStudySettingValue(script, key, value);
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
    toggle.style.border = checked ? '1px solid rgba(34, 197, 94, 0.24)' : '1px solid rgba(226, 232, 240, 0.95)';
    toggle.style.background = checked
      ? 'linear-gradient(135deg, rgba(220, 252, 231, 0.9) 0%, rgba(240, 253, 244, 0.98) 100%)'
      : 'linear-gradient(135deg, rgba(248, 250, 252, 0.96) 0%, rgba(255,255,255,0.98) 100%)';
    toggle.style.boxShadow = checked ? '0 10px 24px rgba(34, 197, 94, 0.10)' : '0 6px 18px rgba(15, 23, 42, 0.04)';

    const stateText = createElement('div', { text: checked ? '已开启' : '已关闭' });
    stateText.style.fontSize = '13px';
    stateText.style.fontWeight = '700';
    stateText.style.color = checked ? '#15803d' : '#64748b';

    const stateDesc = createElement('div', {
      text: checked ? '点击关闭此项设置' : '点击开启此项设置'
    });
    stateDesc.style.fontSize = '12px';
    stateDesc.style.color = checked ? '#166534' : '#94a3b8';
    stateDesc.style.lineHeight = '1.5';

    toggle.append(stateText, stateDesc);
    toggle.onclick = () => {
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
    inputWrap.style.border = '1px solid rgba(226, 232, 240, 0.95)';
    inputWrap.style.background = 'rgba(255,255,255,0.98)';
    inputWrap.style.boxShadow = '0 6px 18px rgba(15, 23, 42, 0.04)';

    const input = document.createElement('input');
    input.type = isVolumeField ? 'number' : inputType === 'range' ? 'range' : 'text';
    input.style.flex = '1';
    input.style.minWidth = '0';
    input.style.border = 'none';
    input.style.outline = 'none';
    input.style.background = 'transparent';
    input.style.fontSize = '13px';
    input.style.fontWeight = '700';
    input.style.color = '#0f172a';

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

    input.oninput = () => {
      const value = isVolumeField
        ? Math.min(100, Math.max(0, Number(input.value || '0'))) / 100
        : input.type === 'range'
          ? Number(input.value)
          : input.value;
      setStudySettingValue(script, key, value);
    };

    inputWrap.append(input);

    if (isVolumeField) {
      const suffix = createElement('div', { text: '%' });
      suffix.style.fontSize = '12px';
      suffix.style.fontWeight = '700';
      suffix.style.color = '#64748b';
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
      currentVolumeBadge.style.background = 'rgba(37, 99, 235, 0.10)';
      currentVolumeBadge.style.color = '#1d4ed8';
      currentVolumeBadge.style.fontSize = '12px';
      currentVolumeBadge.style.fontWeight = '700';

      const quickHint = createElement('div', { text: '可直接输入，也可使用下方快捷音量按钮。' });
      quickHint.style.fontSize = '12px';
      quickHint.style.color = '#64748b';
      quickHint.style.lineHeight = '1.5';

      quickMeta.append(currentVolumeBadge, quickHint);
      inputGroup.append(quickMeta);

      const quickRow = createElement('div');
      quickRow.style.display = 'flex';
      quickRow.style.flexWrap = 'wrap';
      quickRow.style.gap = '8px';

      [0, 25, 50, 75, 100].forEach((percent) => {
        const selected = Number(input.value || '0') === percent;
        const quickButton = createElement('button', { text: `${percent}%` });
        quickButton.type = 'button';
        quickButton.style.padding = '8px 10px';
        quickButton.style.borderRadius = '10px';
        quickButton.style.border = selected ? '1px solid rgba(37, 99, 235, 0.26)' : '1px solid rgba(226, 232, 240, 0.95)';
        quickButton.style.background = selected
          ? 'linear-gradient(135deg, rgba(219, 234, 254, 0.95) 0%, rgba(239, 246, 255, 0.98) 100%)'
          : 'rgba(255,255,255,0.98)';
        quickButton.style.color = selected ? '#1d4ed8' : '#475569';
        quickButton.style.fontSize = '12px';
        quickButton.style.fontWeight = selected ? '700' : '600';
        quickButton.style.cursor = 'pointer';
        quickButton.style.boxShadow = selected ? '0 10px 22px rgba(59, 130, 246, 0.12)' : '0 6px 18px rgba(15, 23, 42, 0.04)';
        quickButton.onclick = () => {
          setStudySettingValue(script, key, percent / 100);
        };
        quickRow.append(quickButton);
      });

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
    background: 'rgba(248, 250, 252, 0.86)',
    border: '1px solid rgba(148, 163, 184, 0.18)'
  });
  container.style.display = 'grid';
  container.style.gap = '12px';

  const header = createElement('div');
  header.style.display = 'grid';
  header.style.gap = '6px';

  const title = createElement('div', { text: '学习设置' });
  title.style.fontSize = '15px';
  title.style.fontWeight = '800';
  title.style.color = '#0f172a';

  const description = createElement('div', {
    text: '这里的设置会直接作用于当前学习流程。'
  });
  description.style.fontSize = '12px';
  description.style.color = '#64748b';
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
    'enableAIFallbackAnswer',
    'aiFallbackFailureAction',
    'enableHyperlink',
    'notifyWhenHasFaceRecognition'
  ];

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
    section.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.76) 0%, rgba(248,250,252,0.78) 100%)';
    section.style.border = '1px solid rgba(226, 232, 240, 0.9)';
    section.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.7)';

    const sectionHeader = createElement('div');
    sectionHeader.style.display = 'grid';
    sectionHeader.style.gap = '6px';
    sectionHeader.style.paddingBottom = '8px';
    sectionHeader.style.borderBottom = '1px solid rgba(226, 232, 240, 0.9)';

    const titleRow = createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.alignItems = 'center';
    titleRow.style.justifyContent = 'space-between';
    titleRow.style.gap = '8px';
    titleRow.style.flexWrap = 'wrap';

    const sectionTitle = createElement('div', { text: groupTitle });
    sectionTitle.style.fontSize = '13px';
    sectionTitle.style.fontWeight = '800';
    sectionTitle.style.color = '#0f172a';

    const sectionPill = createElement('div', { text: summaryText });
    sectionPill.style.padding = '5px 9px';
    sectionPill.style.borderRadius = '999px';
    sectionPill.style.background = 'rgba(148, 163, 184, 0.12)';
    sectionPill.style.color = '#475569';
    sectionPill.style.fontSize = '11px';
    sectionPill.style.fontWeight = '700';

    const sectionDesc = createElement('div', { text: groupDescription });
    sectionDesc.style.fontSize = '12px';
    sectionDesc.style.color = '#64748b';
    sectionDesc.style.lineHeight = '1.6';

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
      field.style.background = 'rgba(255,255,255,0.96)';
      field.style.border = '1px solid rgba(226, 232, 240, 0.95)';
      field.style.boxShadow = '0 8px 20px rgba(15, 23, 42, 0.04)';
      if (key === 'playbackRate' || key === 'volume' || key === 'mode') {
        field.style.gridColumn = '1 / -1';
      }
      sectionGrid.append(field);
    }

    section.append(sectionHeader, sectionGrid);
    return section;
  };

  container.append(
    createSettingsGroup('媒体控制', '控制播放相关行为，修改后会尽量立即作用到当前媒体。', mediaKeys),
    createSettingsGroup('学习流程', '控制章节完成后的跳转与复习策略。', progressKeys),
    createSettingsGroup(
      '任务能力',
      '控制视频、文档、章节测试和提醒等自动化能力。',
      taskKeys,
      formatEnabledStudyTaskCapabilitySummary(script.cfg, taskKeys)
    )
  );
  return container;
}

function createTikuAdapterConfigSection() {
  const stored = getStoredTikuAdapterConfig();

  const container = createElement('div');
  applySectionCardStyle(container, {
    padding: '14px',
    background: 'rgba(248, 250, 252, 0.86)',
    border: '1px solid rgba(148, 163, 184, 0.18)'
  });
  container.style.display = 'grid';
  container.style.gap = '12px';

  const header = createElement('div');
  header.style.display = 'grid';
  header.style.gap = '6px';

  const title = createElement('div', { text: '题库配置' });
  title.style.fontSize = '15px';
  title.style.fontWeight = '800';
  title.style.color = '#0f172a';

  const description = createElement('div', {
    text: '这里的设置会直接作用于当前学习流程。'
  });
  description.style.fontSize = '12px';
  description.style.color = '#64748b';
  description.style.lineHeight = '1.7';

  header.append(title, description);

  const baseurlWrap = createElement('div');
  baseurlWrap.style.display = 'grid';
  baseurlWrap.style.gap = '8px';

  const baseurlLabel = createElement('label', { text: '题库地址' });
  baseurlLabel.style.fontSize = '12px';
  baseurlLabel.style.fontWeight = '700';
  baseurlLabel.style.color = '#334155';

  const baseurlRow = createElement('div');
  baseurlRow.style.display = 'flex';
  baseurlRow.style.gap = '8px';
  baseurlRow.style.flexWrap = 'wrap';

  const baseurlInput = document.createElement('input');
  baseurlInput.type = 'text';
  baseurlInput.value = stored.baseurl || DEFAULT_TIKU_BASE_URL;
  baseurlInput.placeholder = DEFAULT_TIKU_BASE_URL || 'https://your-tiku.example.com';
  baseurlInput.style.flex = '1';
  baseurlInput.style.minWidth = '220px';
  baseurlInput.style.padding = '10px 12px';
  baseurlInput.style.borderRadius = '12px';
  baseurlInput.style.border = '1px solid rgba(226, 232, 240, 0.95)';
  baseurlInput.style.background = 'rgba(255,255,255,0.98)';

  const saveButton = createElement('button', { text: '保存' });
  applyActionButtonStyle(saveButton, 'primary');
  saveButton.onclick = async () => {
    runtimeStore.set(TIKU_ADAPTER_BASEURL_KEY, baseurlInput.value.trim());
    runtimeStore.set(TIKU_ADAPTER_KEY_KEY, keyInput.value.trim());
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
  keyLabel.style.color = '#334155';

  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.value = stored.key;
  keyInput.placeholder = '请输入访问令牌';
  keyInput.style.padding = '10px 12px';
  keyInput.style.borderRadius = '12px';
  keyInput.style.border = '1px solid rgba(226, 232, 240, 0.95)';
  keyInput.style.background = 'rgba(255,255,255,0.98)';
  keyInput.oninput = () => {
    runtimeStore.set(TIKU_ADAPTER_KEY_KEY, keyInput.value);
  };

  const actionsRow = createElement('div');
  actionsRow.style.display = 'flex';
  actionsRow.style.gap = '8px';
  actionsRow.style.flexWrap = 'wrap';
  actionsRow.append(saveButton, jumpButton);

  keyWrap.append(keyLabel, keyInput);
  container.append(header, baseurlWrap, keyWrap, actionsRow);
  return container;
}

function createWorkResultsPanel() {
  const container = createElement('div');
  container.style.display = 'grid';
  container.style.gap = '14px';

  const stats = getWorkResultStats();

  const hero = createElement('div');
  hero.style.padding = '16px';
  hero.style.borderRadius = '18px';
  hero.style.background = 'linear-gradient(135deg, rgba(239, 246, 255, 0.98) 0%, rgba(248, 250, 252, 0.98) 58%, rgba(255, 255, 255, 0.98) 100%)';
  hero.style.border = '1px solid rgba(59, 130, 246, 0.12)';
  hero.style.boxShadow = '0 16px 40px rgba(59, 130, 246, 0.08)';
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

  const heroTitle = createElement('div', { text: '答题结果与学习控制' });
  heroTitle.style.fontSize = '17px';
  heroTitle.style.fontWeight = '800';
  heroTitle.style.color = '#0f172a';

  titleGroup.append(heroTitle);

  const badge = createElement('div', { text: state.workResults.results.length === 0 ? '空闲中' : '运行中' });
  badge.style.padding = '7px 12px';
  badge.style.borderRadius = '999px';
  badge.style.background = state.workResults.results.length === 0 ? 'rgba(148, 163, 184, 0.12)' : 'rgba(37, 99, 235, 0.12)';
  badge.style.color = state.workResults.results.length === 0 ? '#64748b' : '#1d4ed8';
  badge.style.fontSize = '12px';
  badge.style.fontWeight = '700';

  heroTop.append(titleGroup, badge);

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
  answerToggleField.style.maxWidth = '240px';

  const uploadModeField = createElement('label');
  uploadModeField.style.display = 'grid';
  uploadModeField.style.gap = '8px';
  uploadModeField.style.maxWidth = '240px';

  const uploadModeLabel = createElement('span', { text: '完成后动作' });
  uploadModeLabel.style.fontSize = '12px';
  uploadModeLabel.style.fontWeight = '700';
  uploadModeLabel.style.color = '#334155';

  const uploadModeSelect = document.createElement('select');
  uploadModeSelect.title = '选择课程任务答题完成后自动保存或自动提交。';
  uploadModeSelect.style.width = '100%';
  uploadModeSelect.style.padding = '10px 12px';
  uploadModeSelect.style.borderRadius = '12px';
  uploadModeSelect.style.border = '1px solid rgba(226, 232, 240, 0.95)';
  uploadModeSelect.style.background = 'rgba(255,255,255,0.98)';
  uploadModeSelect.style.fontSize = '13px';
  uploadModeSelect.style.fontWeight = '700';
  uploadModeSelect.style.color = '#0f172a';
  ['submit', 'save'].forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'submit' ? '自动提交' : '自动保存';
    uploadModeSelect.append(option);
  });
  uploadModeSelect.value = studyScript.cfg.upload === 'save' ? 'save' : 'submit';
  uploadModeSelect.oninput = () => {
    setStudySettingValue(studyScript, 'upload', uploadModeSelect.value === 'save' ? 'save' : 'submit');
  };
  uploadModeField.append(uploadModeLabel, uploadModeSelect);

  const heroActions = createElement('div');
  heroActions.style.display = 'flex';
  heroActions.style.gap = '8px';
  heroActions.style.flexWrap = 'wrap';

  const runtimeControls = state.workResults.runtimeControls;
  if (runtimeControls?.isRunning()) {
    const isPaused = runtimeControls.isStopped();
    const pauseButton = createElement('button', { text: isPaused ? '继续答题' : '暂停答题' });
    pauseButton.onclick = () => {
      if (isPaused) {
        runtimeControls.continuate();
      } else {
        runtimeControls.stop();
      }
      renderWorkResultsPanel();
    };
    applyActionButtonStyle(pauseButton, 'primary');
    heroActions.append(pauseButton);
  }

  const typeButton = createElement('button', {
    text: state.workResults.type === 'numbers' ? '切换为题目列表' : '切换为序号列表'
  });
  typeButton.onclick = () => {
    setWorkResultsView(state.workResults.type === 'numbers' ? 'questions' : 'numbers');
  };

  const clearButton = createElement('button', { text: '清空结果' });
  clearButton.onclick = () => {
    setWorkResults([]);
  };

  applyActionButtonStyle(typeButton, 'primary');
  applyActionButtonStyle(clearButton, 'danger');
  heroActions.append(typeButton, clearButton);

  hero.append(heroTop, answerToggleField, uploadModeField, metricRow, heroActions);
  container.append(hero);

  const resultsSection = createElement('div');
  applySectionCardStyle(resultsSection, {
    padding: '14px',
    background: 'rgba(248, 250, 252, 0.86)',
    border: '1px solid rgba(148, 163, 184, 0.18)'
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
  resultsTitle.style.fontSize = '14px';
  resultsTitle.style.fontWeight = '700';
  resultsTitle.style.color = '#0f172a';

  const summary = createElement('div', {
    text: `当前共 ${stats.totalQuestionCount} 题，已完成 ${stats.resolvedCount} 题。`
  });
  summary.style.fontSize = '12px';
  summary.style.color = '#64748b';

  resultsHeader.append(resultsTitle, summary);
  resultsSection.append(resultsHeader);

  if (state.workResults.results.length === 0) {
    const empty = createElement('div', { text: '暂无搜索结果。开始答题后，结果会实时显示在这里。' });
    empty.style.color = '#94a3b8';
    empty.style.textAlign = 'center';
    empty.style.padding = '20px 12px';
    empty.style.borderRadius = '14px';
    empty.style.background = 'rgba(255,255,255,0.85)';
    empty.style.border = '1px dashed rgba(148, 163, 184, 0.3)';
    resultsSection.append(empty);
  } else {
    const list = createElement('div');
    list.style.display = 'grid';
    list.style.gap = '10px';
    list.style.maxHeight = '260px';
    list.style.overflow = 'auto';
    list.style.paddingRight = '2px';

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
        button.style.border = '1px solid rgba(148, 163, 184, 0.2)';
        button.style.cursor = 'pointer';
        button.style.fontWeight = '700';
        button.style.boxShadow = '0 6px 18px rgba(15, 23, 42, 0.05)';

        if (tone === 'selected') {
          button.style.background = 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)';
          button.style.borderColor = '#2563eb';
          button.style.color = '#fff';
        } else if (tone === 'manual') {
          button.style.background = 'rgba(254, 249, 195, 0.96)';
          button.style.borderColor = '#facc15';
          button.style.color = '#854d0e';
        } else if (tone === 'success') {
          button.style.background = 'rgba(240, 253, 244, 0.96)';
          button.style.borderColor = '#4ade80';
          button.style.color = '#15803d';
        } else if (tone === 'danger') {
          button.style.background = 'rgba(254, 242, 242, 0.96)';
          button.style.borderColor = '#f87171';
          button.style.color = '#b91c1c';
        } else {
          button.style.background = 'rgba(255,255,255,0.96)';
          button.style.color = '#334155';
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
        item.style.borderRadius = '14px';
        item.style.cursor = 'pointer';
        item.style.boxShadow = '0 8px 22px rgba(15, 23, 42, 0.05)';
        item.style.borderLeft = index === state.workResults.currentResultIndex ? '4px solid #2563eb' : '4px solid transparent';

        if (tone === 'selected') {
          item.style.border = '1px solid rgba(37, 99, 235, 0.24)';
          item.style.background = 'rgba(239, 246, 255, 0.98)';
        } else if (tone === 'manual') {
          item.style.border = '1px solid rgba(250, 204, 21, 0.45)';
          item.style.background = 'rgba(254, 252, 232, 0.96)';
        } else if (tone === 'success') {
          item.style.border = '1px solid rgba(74, 222, 128, 0.45)';
          item.style.background = 'rgba(240, 253, 244, 0.96)';
        } else if (tone === 'danger') {
          item.style.border = '1px solid rgba(248, 113, 113, 0.4)';
          item.style.background = 'rgba(254, 242, 242, 0.96)';
        } else {
          item.style.border = '1px solid rgba(226, 232, 240, 0.95)';
          item.style.background = 'rgba(255,255,255,0.96)';
        }

        const title = createElement('div', { text: `${index + 1}. ${result.question || '未识别题目'}` });
        title.style.fontWeight = '700';
        title.style.wordBreak = 'break-word';
        title.style.color = '#0f172a';
        title.style.lineHeight = '1.6';

        const status = createElement('div', { text: formatWorkResultStatus(result) });
        status.style.fontSize = '12px';
        status.style.color = '#64748b';
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
    background: 'rgba(248, 250, 252, 0.86)',
    border: '1px solid rgba(148, 163, 184, 0.18)'
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
  cacheTitle.style.fontSize = '14px';
  cacheTitle.style.fontWeight = '700';
  cacheTitle.style.color = '#0f172a';

  const cacheDesc = createElement('div', { text: '答题成功后会自动写入本地缓存，方便后续题目直接命中。' });
  cacheDesc.style.fontSize = '12px';
  cacheDesc.style.color = '#64748b';

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
    emptyCache.style.color = '#94a3b8';
    emptyCache.style.textAlign = 'center';
    emptyCache.style.padding = '18px 12px';
    emptyCache.style.borderRadius = '14px';
    emptyCache.style.background = 'rgba(255,255,255,0.85)';
    emptyCache.style.border = '1px dashed rgba(148, 163, 184, 0.3)';
    cacheSection.append(emptyCache);
  } else {
    const cacheList = createElement('div');
    cacheList.style.display = 'grid';
    cacheList.style.gap = '8px';
    cacheList.style.maxHeight = '220px';
    cacheList.style.overflow = 'auto';
    cacheList.style.paddingRight = '2px';

    state.apps.localQuestionCaches.slice(0, 20).forEach((cache) => {
      const item = createElement('div');
      item.style.border = '1px solid rgba(226, 232, 240, 0.95)';
      item.style.borderRadius = '12px';
      item.style.padding = '10px 12px';
      item.style.background = 'rgba(255,255,255,0.96)';
      item.style.boxShadow = '0 6px 18px rgba(15, 23, 42, 0.04)';

      const title = createElement('div', { text: cache.title || '未识别题目' });
      title.style.fontWeight = '700';
      title.style.wordBreak = 'break-word';
      title.style.color = '#0f172a';
      title.style.lineHeight = '1.6';

      const answer = createElement('div', { text: cache.answer || '空答案' });
      answer.style.marginTop = '6px';
      answer.style.wordBreak = 'break-word';
      answer.style.color = '#334155';

      const meta = createElement('div', { text: `来源：${cache.from || '未知题库'}` });
      meta.style.fontSize = '12px';
      meta.style.color = '#64748b';
      meta.style.marginTop = '6px';
      applyQuestionTextWrapStyle(meta);

      item.append(title, answer, meta);
      cacheList.append(item);
    });

    cacheSection.append(cacheList);
  }

  container.append(cacheSection);
  container.append(createStudySettingsPanel());
  return container;
}

function renderWorkResultsPanel() {
  const panel = state.panels.workResults;
  if (!panel) return;
  panel.body.replaceChildren(createWorkResultsPanel());
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
  count.style.color = '#666';

  const clearButton = createElement('button', { text: '清空缓存' });
  clearButton.style.padding = '4px 8px';
  clearButton.style.border = '1px solid #d9d9d9';
  clearButton.style.borderRadius = '6px';
  clearButton.style.background = '#fff';
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
    empty.style.color = '#999';
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
    item.style.border = '1px solid #eee';
    item.style.borderRadius = '8px';
    item.style.padding = '10px';
    item.style.background = '#fafafa';

    const title = createElement('div', { text: cache.title || '未识别题目' });
    title.style.fontWeight = '600';
    title.style.wordBreak = 'break-word';

    const answer = createElement('div', { text: cache.answer || '空答案' });
    answer.style.marginTop = '6px';
    answer.style.wordBreak = 'break-word';

    const meta = createElement('div', { text: `来源：${cache.from || '未知题库'}` });
    meta.style.fontSize = '12px';
    meta.style.color = '#666';
    meta.style.marginTop = '6px';
    applyQuestionTextWrapStyle(meta);

    item.append(title, answer, meta);

    if (cache.homepage) {
      const link = document.createElement('a');
      link.href = cache.homepage;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = cache.homepage;
      link.style.display = 'block';
      link.style.fontSize = '12px';
      link.style.marginTop = '4px';
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

function applyPanelVisual(panel: ScriptPanel | undefined, kind: 'workResults' | 'apps') {
  if (!panel) return;

  panel.root.style.position = 'fixed';
  if (kind === 'workResults') {
    const position = clampPanelPosition(state.workResultsPanelPosition, 460);
    panel.root.style.right = `${position.right}px`;
    panel.root.style.top = `${position.top}px`;
  } else {
    panel.root.style.right = '16px';
    panel.root.style.top = '108px';
  }
  panel.root.style.zIndex = kind === 'workResults' ? '2147483647' : '2147483646';
  panel.root.style.width = kind === 'workResults' ? '460px' : '360px';
  panel.root.style.maxHeight = kind === 'workResults' ? '76vh' : '50vh';
  panel.root.style.overflow = 'auto';
  panel.root.style.overscrollBehavior = 'contain';
  panel.root.style.scrollbarGutter = 'stable';
  panel.root.style.background = 'rgba(255,255,255,0.98)';
  panel.root.style.backdropFilter = 'blur(14px)';
  panel.root.style.border = '1px solid rgba(148, 163, 184, 0.22)';
  panel.root.style.boxShadow =
    kind === 'workResults' ? '0 22px 60px rgba(15, 23, 42, 0.18)' : '0 8px 24px rgba(0,0,0,0.12)';
  panel.root.style.borderRadius = kind === 'workResults' ? '18px' : '12px';
  panel.root.style.padding = kind === 'workResults' ? '14px' : '12px';
  panel.configsContainer.style.display = '';
  panel.body.style.display = '';
  bindPanelDrag(panel, kind);
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
    state.apps.localQuestionCaches = parseStoredValue(event.newValue, [] as QuestionCache[]);
    renderAppsPanel();
    renderWorkResultsPanel();
  }
});

document.addEventListener('chaoxing-plus:shared-store-hydrate', () => {
  renderWorkResultsPanel();
});

try {
  const sharedConfigObserver = new MutationObserver((mutations) => {
    const shouldRefreshPanel = mutations.some(({ attributeName }) => {
      return Boolean(attributeName?.startsWith(SHARED_STORE_ATTRIBUTE_PREFIX));
    });

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
            state.workResults.runtimeControls = controls;
            renderWorkResultsPanel();
          },
          clearRuntimeControls() {
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
          searchAnswerInCaches<T>(title: string, provider: () => Promise<T>) {
            if (answerCache.has(title)) {
              return Promise.resolve(answerCache.get(title) as T);
            }

            const cacheResults = questionCachesToSearchInfos(title);
            if (cacheResults.length) {
              answerCache.set(title, cacheResults);
              return Promise.resolve(cacheResults as T);
            }

            return provider().then((result) => {
              if (Array.isArray(result)) {
                answerCache.set(title, result as SearchInformation[]);
              }
              return result;
            });
          },
          addQuestionCacheFromWorkResult(result: unknown) {
            const normalized = normalizeWorkResultsPayload(result);
            if (normalized.length === 0) {
              return;
            }
            addQuestionCaches(...resultToQuestionCaches(normalized));
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

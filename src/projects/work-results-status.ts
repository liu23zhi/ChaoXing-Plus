import type { SimplifyWorkResult } from '../core/index.js';
import type { QuestionTypes } from '../core/index.js';

export type WorkResultStatusSource = 'idle' | 'answered' | 'unresolved' | 'manual';
export type WorkResultTone = 'selected' | 'manual' | 'success' | 'danger' | 'idle';
export type SearchInfoErrorSummary = {
  title: string;
  details: string[];
};

const QUESTION_TYPE_LABELS: Record<Exclude<QuestionTypes, undefined>, string> = {
  single: '单选',
  multiple: '多选',
  judgement: '判断',
  completion: '填空'
};

function hasAnswerResults(result: SimplifyWorkResult) {
  return result.searchInfos.some((info) => info.results.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function summarizePlainError(raw: string) {
  const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '题库请求失败';
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

export function summarizeSearchInfoError(error: string | undefined): SearchInfoErrorSummary {
  const raw = String(error ?? '').trim();
  if (!raw) {
    return { title: '题库请求失败', details: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { title: summarizePlainError(raw), details: [] };
  }

  const root = asRecord(parsed);
  if (!root) {
    return { title: summarizePlainError(raw), details: [] };
  }

  const nestedError = asRecord(root.error);
  const request = asRecord(root.request);
  const code = firstText(root.errCode, root.code, root.statusCode, nestedError?.code);
  const title = firstText(
    root.message,
    root.msg,
    root.errorMessage,
    root.error_message,
    typeof root.error === 'string' ? root.error : undefined,
    nestedError?.message,
    root.detail
  ) || '题库请求失败';
  const detail = firstText(root.detail, root.description, nestedError?.detail);
  const method = firstText(request?.method);
  const path = firstText(request?.path);
  const requestLabel = [method, path].filter(Boolean).join(' ');

  return {
    title,
    details: [
      code ? `${/^\d{3}$/.test(code) ? '状态码' : '错误码'}：${code}` : '',
      requestLabel ? `请求：${requestLabel}` : '',
      detail && detail !== title ? `详情：${detail}` : ''
    ].filter(Boolean)
  };
}

export function formatQuestionTypeLabel(type: QuestionTypes | undefined): string {
  if (!type) {
    return '未识别';
  }

  return QUESTION_TYPE_LABELS[type] ?? type;
}

export function resolveWorkResultStatusSource(result: SimplifyWorkResult): WorkResultStatusSource {
  if (result.manual) {
    return 'manual';
  }

  if (result.error) {
    return 'unresolved';
  }

  if (hasAnswerResults(result)) {
    return 'answered';
  }

  if (result.requested && result.searchInfos.length === 0) {
    return 'unresolved';
  }

  return 'idle';
}

export function resolveWorkResultTone(result: SimplifyWorkResult, selected: boolean): WorkResultTone {
  if (selected) {
    return 'selected';
  }

  const source = resolveWorkResultStatusSource(result);
  if (source === 'manual') {
    return 'manual';
  }
  if (source === 'answered') {
    return 'success';
  }
  if (source === 'unresolved') {
    return 'danger';
  }
  return 'idle';
}

/**
 * 面板顶部的「当前在做什么」。七个状态互斥，按 STATE_PRIORITY 顺序判定，
 * 保证同一个结果集合永远只会落到一个状态上。
 */
export type PanelActivityState =
  | 'idle'
  | 'searching'
  | 'answering'
  | 'paused'
  | 'waiting-manual'
  | 'completed'
  | 'error';

export type PanelActivityTone = 'idle' | 'active' | 'paused' | 'manual' | 'success' | 'danger';

export interface PanelActivitySnapshot {
  state: PanelActivityState;
  label: string;
  detail: string;
  tone: PanelActivityTone;
  /** 进行中的状态用轻微脉冲提示，静止状态不闪。 */
  pulse: boolean;
}

const PANEL_ACTIVITY_COPY: Record<PanelActivityState, {
  label: string;
  detail: string;
  tone: PanelActivityTone;
  pulse: boolean;
}> = {
  idle: {
    label: '空闲',
    detail: '还没有开始答题。进入课程任务或考试页面后会自动运行。',
    tone: 'idle',
    pulse: false
  },
  searching: {
    label: '搜题中',
    detail: '正在向题库请求答案，题目较多时可能需要数十秒。',
    tone: 'active',
    pulse: true
  },
  answering: {
    label: '答题中',
    detail: '已拿到答案，正在把答案填进页面。',
    tone: 'active',
    pulse: true
  },
  paused: {
    label: '已暂停',
    detail: '点「继续答题」恢复；暂停只影响当前标签页。',
    tone: 'paused',
    pulse: false
  },
  'waiting-manual': {
    label: '等待人工确认',
    detail: '有关键题需要你手动作答，完成后点「继续答题」接着跑。',
    tone: 'manual',
    pulse: false
  },
  completed: {
    label: '已完成',
    detail: '本轮题目已全部完成，可以核对结果后再提交。',
    tone: 'success',
    pulse: false
  },
  error: {
    label: '出错',
    detail: '有题目搜题失败，点下方「重答本题」重试，错误摘要会说明下一步。',
    tone: 'danger',
    pulse: false
  }
};

export function resolvePanelActivityState(input: {
  results: SimplifyWorkResult[];
  paused?: boolean;
  running?: boolean;
}): PanelActivitySnapshot {
  const results = Array.isArray(input.results) ? input.results : [];
  const running = input.running === true;
  const paused = input.paused === true;
  const hasSearching = results.some((result) => result.searching || result.retrying);
  const hasManualPending = results.some((result) => result.manual && !result.finish);
  const hasError = results.some((result) => Boolean(result.error));
  const allFinished = results.length > 0 && results.every((result) => result.finish);

  let state: PanelActivityState;
  if (paused) {
    // 暂停优先：用户已经明确要求停下，此时不该再显示「搜题中」。
    state = 'paused';
  } else if (results.length === 0 && !running && !hasSearching) {
    state = 'idle';
  } else if (hasSearching) {
    state = 'searching';
  } else if (running) {
    state = 'answering';
  } else if (hasError) {
    state = 'error';
  } else if (hasManualPending) {
    state = 'waiting-manual';
  } else if (allFinished) {
    state = 'completed';
  } else {
    state = 'idle';
  }

  const copy = PANEL_ACTIVITY_COPY[state];
  return { state, label: copy.label, detail: copy.detail, tone: copy.tone, pulse: copy.pulse };
}

const TIKU_BALANCE_PATTERN = /INSUFFICIENT_BALANCE|余额不足/;
const TIKU_QUOTA_PATTERN = /ACCESS_TOKEN_QUOTA_EXCEEDED|Key 额度已用尽/;
const NO_ANSWER_PATTERN = /NO_ANSWER|未找到答案|未返回可用答案/;
const UNSAFE_PATTERN = /UNSAFE_TO_ANSWER|未能安全确认/;
const AI_DOWN_PATTERN = /AI_UNAVAILABLE|暂不可用/;
const INVALID_INPUT_PATTERN = /INVALID_INPUT|题目数据无效/;
const AUTH_PATTERN = /访问令牌|鉴权|unauthorized|forbidden|状态码：40[13]/i;
const NETWORK_PATTERN = /Failed to fetch|NetworkError|timeout|超时|网络|ECONN|ENOTFOUND/i;
const SERVER_PATTERN = /服务器内部错误|UPSTREAM_ERROR|状态码：5\d\d/;

/**
 * 错误提示必须说清下一步。返回一句可执行的动作，不重复错误本身。
 * 余额不足与 Key 额度用尽是两种处置方式，绝不合并成一句「失败」。
 */
export function describeSearchErrorNextStep(error: string | undefined): string {
  const summary = summarizeSearchInfoError(error);
  const haystack = [String(error ?? ''), summary.title, ...summary.details].join('\n');

  if (TIKU_BALANCE_PATTERN.test(haystack)) {
    return '下一步：给题库账号充值后点「重答本题」；这是账号余额问题，与 Key 额度无关。';
  }
  if (TIKU_QUOTA_PATTERN.test(haystack)) {
    return '下一步：调整该 Key 的额度或更换 Key 后重试；这是 Key 自身的额度限制，与账号余额无关。';
  }
  if (INVALID_INPUT_PATTERN.test(haystack)) {
    return '下一步：确认题干与选项能正常抓取；可将该题手动作答后继续。';
  }
  if (UNSAFE_PATTERN.test(haystack)) {
    return '下一步：这题需要你自己核对答案，请在页面上手动作答。';
  }
  if (NO_ANSWER_PATTERN.test(haystack)) {
    return '下一步：开启「AI 兜底搜题」再重答，或直接手动作答本题。';
  }
  if (AI_DOWN_PATTERN.test(haystack)) {
    return '下一步：稍后重试；若持续不可用，先在设置里关闭 AI 兜底改用普通题库。';
  }
  if (AUTH_PATTERN.test(haystack)) {
    return '下一步：到「题库配置」核对地址与令牌是否正确、是否过期，保存后再重答。';
  }
  if (NETWORK_PATTERN.test(haystack)) {
    return '下一步：检查网络与题库地址是否可访问，恢复后点「重答本题」。';
  }
  if (SERVER_PATTERN.test(haystack)) {
    return '下一步：题库服务暂时异常，稍等一会儿再点「重答本题」。';
  }
  return '下一步：点「重答本题」重试；连续失败请到「题库配置」检查地址与令牌。';
}

export function formatWorkResultStatus(result: SimplifyWorkResult): string {
  if (result.retrying) {
    return '正在重答...';
  }

  if (result.manual) {
    return '已人工答题';
  }

  if (result.searching) {
    return '搜题中';
  }

  if (!result.requested && !result.resolved) {
    return '等待搜索中';
  }

  if (result.error) {
    // 错误可能是整段 JSON：状态行只放可读摘要，原文在详情区折叠展示。
    // 旧实现直接把 JSON 塞进徽标，面板上会出现「失败：{"errCode":402,…」。
    return `失败：${summarizeSearchInfoError(result.error).title}`;
  }

  if (result.requested && result.searchInfos.length === 0) {
    return '未搜索到答案';
  }

  if (result.finish) {
    return '已完成';
  }

  if (!result.resolved) {
    return '等待答题中';
  }

  return '已搜索但未完成';
}

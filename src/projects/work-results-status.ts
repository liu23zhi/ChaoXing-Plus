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

export function formatWorkResultStatus(result: SimplifyWorkResult): string {
  if (result.retrying) {
    return '正在重答...';
  }

  if (result.manual) {
    return '已人工答题';
  }

  if (!result.requested && !result.resolved) {
    return '等待搜索中';
  }

  if (result.error) {
    return `失败：${result.error}`;
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

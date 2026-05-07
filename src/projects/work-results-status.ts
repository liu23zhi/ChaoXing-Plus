import type { SimplifyWorkResult } from '../core/index.js';

export type WorkResultStatusSource = 'idle' | 'answered' | 'unresolved' | 'manual';
export type WorkResultTone = 'selected' | 'manual' | 'success' | 'danger' | 'idle';

function hasAnswerResults(result: SimplifyWorkResult) {
  return result.searchInfos.some((info) => info.results.length > 0);
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

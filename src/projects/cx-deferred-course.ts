import type { ChapterDeferredState } from './cx-deferred-chapters';

export type CourseDeferredState = {
  scope: string;
  phase: 'scan' | 'retry' | 'settled';
  chapterIds: string[];
  inspectedChapters: string[];
  inspectedSnapshots?: Record<string, { signature: string; unFinishCount?: number }>;
};

export type CourseChapterMetadata = {
  id: string;
  unFinishCount: number;
  active?: boolean;
  normalSignature?: string;
};

export type CourseChapterDeferredProgress = Pick<ChapterDeferredState, 'phase' | 'tasks'>;

export type CourseDeferredAction =
  | { type: 'scan' | 'retry'; chapterId: string }
  | { type: 'blocked'; reason: 'directory-not-ready' | 'earlier-normal-work' }
  | { type: 'paused' }
  | { type: 'settled' };

function uniqueChapterIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];
}

export function createCourseDeferredState(scope: string): CourseDeferredState {
  return { scope, phase: 'scan', chapterIds: [], inspectedChapters: [] };
}

export function readCourseDeferredState(value: unknown, scope: string): CourseDeferredState {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return createCourseDeferredState(scope);
    }
  }
  const state = createCourseDeferredState(scope);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return state;
  const record = value as Record<string, unknown>;
  if (record.scope !== scope) return state;
  if (record.phase === 'retry' || record.phase === 'settled') state.phase = record.phase;
  state.chapterIds = uniqueChapterIds(record.chapterIds);
  state.inspectedChapters = uniqueChapterIds(record.inspectedChapters);
  if (record.inspectedSnapshots && typeof record.inspectedSnapshots === 'object' && !Array.isArray(record.inspectedSnapshots)) {
    state.inspectedSnapshots = {};
    for (const [id, raw] of Object.entries(record.inspectedSnapshots)) {
      if (!raw || typeof raw !== 'object' || typeof raw.signature !== 'string') continue;
      state.inspectedSnapshots[id] = { signature: raw.signature };
      if (typeof raw.unFinishCount === 'number' && Number.isFinite(raw.unFinishCount)) state.inspectedSnapshots[id].unFinishCount = raw.unFinishCount;
    }
  }
  return state;
}

export function markCourseChapterInspected(state: CourseDeferredState, chapterId: string, signature?: string, unFinishCount?: number): void {
  if (chapterId && !state.inspectedChapters.includes(chapterId)) state.inspectedChapters.push(chapterId);
  if (chapterId && signature !== undefined) {
    (state.inspectedSnapshots ||= {})[chapterId] = { signature };
    if (unFinishCount !== undefined) state.inspectedSnapshots[chapterId].unFinishCount = unFinishCount;
  }
}

export function chooseCourseDeferredAction(
  state: CourseDeferredState,
  currentChapterId: string,
  chapters: readonly CourseChapterMetadata[],
  chapterStates: Readonly<Record<string, CourseChapterDeferredProgress | undefined>> = {},
  mode: 'next' | 'job' | 'manually' = 'job'
): CourseDeferredAction {
  const seen = new Set<string>();
  const available = chapters.filter((chapter) => {
    if (!chapter.id || seen.has(chapter.id)) return false;
    seen.add(chapter.id);
    return true;
  });
  state.chapterIds = available.map((chapter) => chapter.id);
  if (!available.length) return { type: 'blocked', reason: 'directory-not-ready' };
  const invalidated = new Set<string>();
  for (const chapter of available) {
    const snapshot = state.inspectedSnapshots?.[chapter.id];
    if (snapshot && ((chapter.normalSignature !== undefined && chapter.normalSignature !== snapshot.signature)
      || (snapshot.unFinishCount !== undefined && Number(chapter.unFinishCount) > snapshot.unFinishCount))) {
      invalidated.add(chapter.id);
      state.inspectedChapters = state.inspectedChapters.filter((id) => id !== chapter.id);
      state.phase = 'scan';
    }
  }
  let currentIndex = available.findIndex((chapter) => chapter.id === currentChapterId);
  if (currentIndex === -1) currentIndex = available.findIndex((chapter) => chapter.active);
  const scanOrder = currentIndex === -1
    ? available
    : [...available.slice(currentIndex + 1), ...available.slice(0, currentIndex + 1)];
  const nextNormal = scanOrder.find((chapter) => {
    const progress = chapterStates[chapter.id];
    // A chapter enters retry/settled only after all of its ordinary tabs were inspected.
    const inspected = !invalidated.has(chapter.id) && (state.inspectedChapters.includes(chapter.id)
      || progress?.phase === 'retry' || progress?.phase === 'settled');
    return Number(chapter.unFinishCount) > 0 && !inspected;
  });
  if (nextNormal) {
    state.phase = 'scan';
    if (mode === 'next' && available.indexOf(nextNormal) <= currentIndex) {
      return { type: 'blocked', reason: 'earlier-normal-work' };
    }
    return { type: 'scan', chapterId: nextNormal.id };
  }
  const nextDeferred = available.find((chapter) => Object.values(chapterStates[chapter.id]?.tasks || {})
    .some((task) => task.state === 'deferred' && !task.terminalExpired && !task.pauseReason));
  if (nextDeferred) {
    state.phase = 'retry';
    return { type: 'retry', chapterId: nextDeferred.id };
  }
  if (available.some((chapter) => Object.values(chapterStates[chapter.id]?.tasks || {})
    .some((task) => task.state === 'deferred' && !task.terminalExpired))) return { type: 'paused' };
  state.phase = 'settled';
  return { type: 'settled' };
}

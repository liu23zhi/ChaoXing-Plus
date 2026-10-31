import type { ChapterDeferredState } from './cx-deferred-chapters';

export type CourseDeferredState = {
  scope: string;
  phase: 'scan' | 'retry' | 'settled';
  chapterIds: string[];
  inspectedChapters: string[];
};

export type CourseChapterMetadata = {
  id: string;
  unFinishCount: number;
  active?: boolean;
};

export type CourseChapterDeferredProgress = Pick<ChapterDeferredState, 'phase' | 'tasks'>;

export type CourseDeferredAction =
  | { type: 'scan' | 'retry'; chapterId: string }
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
  return state;
}

export function markCourseChapterInspected(state: CourseDeferredState, chapterId: string): void {
  if (chapterId && !state.inspectedChapters.includes(chapterId)) state.inspectedChapters.push(chapterId);
}

export function chooseCourseDeferredAction(
  state: CourseDeferredState,
  currentChapterId: string,
  chapters: readonly CourseChapterMetadata[],
  chapterStates: Readonly<Record<string, CourseChapterDeferredProgress | undefined>> = {}
): CourseDeferredAction {
  const seen = new Set<string>();
  const available = chapters.filter((chapter) => {
    if (!chapter.id || seen.has(chapter.id)) return false;
    seen.add(chapter.id);
    return true;
  });
  state.chapterIds = available.map((chapter) => chapter.id);
  let currentIndex = available.findIndex((chapter) => chapter.id === currentChapterId);
  if (currentIndex === -1) currentIndex = available.findIndex((chapter) => chapter.active);
  const scanOrder = currentIndex === -1
    ? available
    : [...available.slice(currentIndex + 1), ...available.slice(0, currentIndex + 1)];
  const nextNormal = scanOrder.find((chapter) => {
    const progress = chapterStates[chapter.id];
    // A chapter enters retry/settled only after all of its ordinary tabs were inspected.
    const inspected = state.inspectedChapters.includes(chapter.id)
      || progress?.phase === 'retry' || progress?.phase === 'settled';
    return Number(chapter.unFinishCount) > 0 && !inspected;
  });
  if (nextNormal) {
    state.phase = 'scan';
    return { type: 'scan', chapterId: nextNormal.id };
  }
  const nextDeferred = available.find((chapter) => Object.values(chapterStates[chapter.id]?.tasks || {})
    .some((task) => task.state === 'deferred' && !task.terminalExpired));
  if (nextDeferred) {
    state.phase = 'retry';
    return { type: 'retry', chapterId: nextDeferred.id };
  }
  state.phase = 'settled';
  return { type: 'settled' };
}
